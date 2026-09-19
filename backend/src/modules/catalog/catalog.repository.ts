/**
 * Catalog data access.
 *
 * Listing and search resolve product IDS in SQL (where the partial in-stock
 * index lives and where `stock_qty - reserved_qty` can actually be compared),
 * then hydrate them with Prisma. Filtering in SQL and hydrating with the ORM
 * keeps pagination correct without hand-writing every join.
 */

import { Prisma, type Category } from "@prisma/client";
import { ProductStatus } from "../../shared";
import { prisma, type DbClient } from "../../infra/db/prisma";

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

export async function findAllCategories(
  client: DbClient = prisma,
): Promise<Category[]> {
  return client.category.findMany({
    where: { isActive: true, deletedAt: null },
    orderBy: [{ depth: "asc" }, { displayOrder: "asc" }, { name: "asc" }],
  });
}

export async function findCategoryById(
  id: string,
  client: DbClient = prisma,
): Promise<Category | null> {
  return client.category.findFirst({ where: { id, deletedAt: null } });
}

export async function findCategoryBySlug(
  slug: string,
  client: DbClient = prisma,
): Promise<Category | null> {
  return client.category.findFirst({ where: { slug, deletedAt: null } });
}

/** Live product counts per leaf category, for the sidebar. */
export async function countProductsByCategory(
  storeId: string,
  client: DbClient = prisma,
): Promise<Map<string, number>> {
  const rows = await client.$queryRaw<{ category_id: string; count: bigint }[]>`
    SELECT p.category_id, COUNT(DISTINCT p.id) AS count
    FROM products p
    JOIN product_variants v ON v.product_id = p.id
      AND v.status = 'ACTIVE' AND v.deleted_at IS NULL
    JOIN store_variants sv ON sv.variant_id = v.id AND sv.store_id = ${storeId}::uuid
    WHERE p.status = 'ACTIVE' AND p.deleted_at IS NULL
    GROUP BY p.category_id`;

  return new Map(rows.map((row) => [row.category_id, Number(row.count)]));
}

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything needed to render a product card or page in one round trip. */
export const PRODUCT_INCLUDE = (storeId: string) =>
  ({
    brand: true,
    category: true,
    images: { orderBy: { displayOrder: "asc" } },
    variants: {
      where: { status: ProductStatus.ACTIVE, deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { displayOrder: "asc" }],
      include: { storeVariants: { where: { storeId } } },
    },
  }) satisfies Prisma.ProductInclude;

export type HydratedProduct = Prisma.ProductGetPayload<{
  include: ReturnType<typeof PRODUCT_INCLUDE>;
}>;

export async function hydrateProducts(
  productIds: string[],
  storeId: string,
  client: DbClient = prisma,
): Promise<HydratedProduct[]> {
  if (productIds.length === 0) return [];

  const products = await client.product.findMany({
    where: { id: { in: productIds } },
    include: PRODUCT_INCLUDE(storeId),
  });

  // Preserve the ordering the SQL query decided (relevance, popularity, price).
  const order = new Map(productIds.map((id, index) => [id, index]));
  return products.sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

export async function findProductById(
  id: string,
  storeId: string,
  client: DbClient = prisma,
): Promise<HydratedProduct | null> {
  return client.product.findFirst({
    where: { id, deletedAt: null },
    include: PRODUCT_INCLUDE(storeId),
  });
}

export type ProductSort =
  | "RELEVANCE"
  | "PRICE_ASC"
  | "PRICE_DESC"
  | "NEWEST"
  | "POPULAR"
  | "DISCOUNT";

export interface ListProductIdsInput {
  storeId: string;
  /** Matches the category and everything beneath it, via the materialised path. */
  categoryPath?: string | null;
  brandId?: string | null;
  inStockOnly?: boolean;
  sort: ProductSort;
  limit: number;
  cursor?: { sortValue: number; id: string } | null;
}

export interface ProductIdRow {
  id: string;
  sortValue: number;
}

/**
 * Resolves an ordered page of product ids.
 *
 * Written as SQL because the in-stock predicate compares two columns
 * (`stock_qty - reserved_qty`), which Prisma cannot express, and because the
 * partial index `store_variants_in_stock` only helps if the query is shaped
 * this way.
 *
 * Keyset pagination on (sortValue, id): stable while the catalogue is being
 * edited, unlike OFFSET which silently repeats or skips rows.
 */
export async function listProductIds(
  input: ListProductIdsInput,
  client: DbClient = prisma,
): Promise<ProductIdRow[]> {
  const stockFilter = input.inStockOnly
    ? Prisma.sql`AND sv.is_available AND (sv.stock_qty - sv.reserved_qty) > 0`
    : Prisma.empty;

  const categoryFilter = input.categoryPath
    ? Prisma.sql`AND (c.path = ${input.categoryPath} OR c.path LIKE ${`${input.categoryPath}/%`})`
    : Prisma.empty;

  const brandFilter = input.brandId
    ? Prisma.sql`AND p.brand_id = ${input.brandId}::uuid`
    : Prisma.empty;

  // The value each sort orders by, exposed so the cursor can resume from it.
  const sortValue = {
    PRICE_ASC: Prisma.sql`MIN(sv.price_paise)`,
    PRICE_DESC: Prisma.sql`MIN(sv.price_paise)`,
    NEWEST: Prisma.sql`EXTRACT(EPOCH FROM p.created_at)`,
    POPULAR: Prisma.sql`p.popularity_score`,
    RELEVANCE: Prisma.sql`p.popularity_score`,
    DISCOUNT: Prisma.sql`MAX(sv.mrp_paise - sv.price_paise)`,
  }[input.sort];

  const ascending = input.sort === "PRICE_ASC";
  const direction = ascending ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  const cursorFilter = input.cursor
    ? ascending
      ? Prisma.sql`HAVING (${sortValue}, p.id) > (${input.cursor.sortValue}, ${input.cursor.id}::uuid)`
      : Prisma.sql`HAVING (${sortValue}, p.id) < (${input.cursor.sortValue}, ${input.cursor.id}::uuid)`
    : Prisma.empty;

  const rows = await client.$queryRaw<{ id: string; sort_value: number }[]>`
    SELECT p.id, ${sortValue} AS sort_value
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN product_variants v ON v.product_id = p.id
      AND v.status = 'ACTIVE' AND v.deleted_at IS NULL
    JOIN store_variants sv ON sv.variant_id = v.id AND sv.store_id = ${input.storeId}::uuid
    WHERE p.status = 'ACTIVE'
      AND p.deleted_at IS NULL
      AND c.is_active AND c.deleted_at IS NULL
      ${categoryFilter}
      ${brandFilter}
      ${stockFilter}
    GROUP BY p.id, p.popularity_score, p.created_at
    ${cursorFilter}
    ORDER BY sort_value ${direction}, p.id ${direction}
    LIMIT ${input.limit}`;

  return rows.map((row) => ({ id: row.id, sortValue: Number(row.sort_value) }));
}

/** Curated Home rails (PRD §9.4 `GET /home`). */
/** Curated Home rails (PRD §9.4 `GET /home`). */

/** Curated Home rails (PRD §9.4 `GET /home`). */
export async function listRailProductIds(
  storeId: string,
  rail:
    | "POPULAR"
    | "DAILY_ESSENTIALS"
    | "BEST_SELLERS"
    | "RECENTLY_ADDED"
    | "OFFERS",
  limit: number,
  client: DbClient = prisma,
): Promise<string[]> {
  /*
   * Each rail is independent.
   *
   * Products are NOT excluded because they appeared in another rail.
   * This is important for a small catalogue where the same product can
   * legitimately belong to multiple Home sections.
   */

  const filter = {
    POPULAR: Prisma.empty,

    DAILY_ESSENTIALS: Prisma.sql`
      AND p.is_daily_essential
    `,

    BEST_SELLERS: Prisma.empty,

    RECENTLY_ADDED: Prisma.empty,

    OFFERS: Prisma.sql`
      AND sv.mrp_paise > sv.price_paise
    `,
  }[rail];

  /*
   * Best Sellers are based on actual delivered order quantities.
   *
   * A product with zero delivered sales will NOT appear in Best Sellers.
   */
  const bestSellerJoin =
    rail === "BEST_SELLERS"
      ? Prisma.sql`
          JOIN orders o
            ON o.store_id = ${storeId}::uuid
           AND o.status = 'DELIVERED'

          JOIN order_items oi
            ON oi.order_id = o.id
           AND oi.variant_id = v.id
        `
      : Prisma.empty;

  const ordering = {
    // Deliberately random rather than ranked — with a catalogue this small,
    // a fixed "Popular" order looked the same as every other rail on every
    // visit. Randomizing what shows here (still gated to in-stock, active
    // products by the WHERE clause below) is what actually reads as
    // "different products" rather than a permanent top-10 list.
    POPULAR: Prisma.sql`
      RANDOM()
    `,

    DAILY_ESSENTIALS: Prisma.sql`
      p.popularity_score DESC
    `,

    BEST_SELLERS: Prisma.sql`
      SUM(oi.qty) DESC
    `,

    RECENTLY_ADDED: Prisma.sql`
      p.created_at DESC
    `,

    OFFERS: Prisma.sql`
      MAX(
        (sv.mrp_paise - sv.price_paise)::float
        / NULLIF(sv.mrp_paise, 0)
      ) DESC
    `,
  }[rail];

  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM products p

    JOIN product_variants v
      ON v.product_id = p.id
      AND v.status = 'ACTIVE'
      AND v.deleted_at IS NULL

    JOIN store_variants sv
      ON sv.variant_id = v.id
      AND sv.store_id = ${storeId}::uuid

    ${bestSellerJoin}

    WHERE p.status = 'ACTIVE'
      AND p.deleted_at IS NULL

      AND sv.is_available
      AND (sv.stock_qty - sv.reserved_qty) > 0

      ${filter}

    GROUP BY
      p.id,
      p.popularity_score,
      p.created_at

    ORDER BY
      ${ordering},
      p.id ASC

    LIMIT ${limit}
  `;

  return rows.map((row) => row.id);
}

/** "You may also like" — same category, in stock, excluding the current item. */
export async function listRelatedProductIds(
  storeId: string,
  categoryId: string,
  excludeProductId: string,
  limit: number,
  client: DbClient = prisma,
): Promise<string[]> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM products p
    JOIN product_variants v
      ON v.product_id = p.id
      AND v.status = 'ACTIVE'
      AND v.deleted_at IS NULL
    JOIN store_variants sv
      ON sv.variant_id = v.id
      AND sv.store_id = ${storeId}::uuid
    WHERE p.category_id = ${categoryId}::uuid
      AND p.id <> ${excludeProductId}::uuid
      AND p.status = 'ACTIVE'
      AND p.deleted_at IS NULL
      AND sv.is_available
      AND (sv.stock_qty - sv.reserved_qty) > 0
    GROUP BY p.id, p.popularity_score
    ORDER BY p.popularity_score DESC, p.id ASC
    LIMIT ${limit}`;

  return rows.map((row) => row.id);
}
