/**
 * Catalog data access — the customer marketplace, across every seller.
 *
 * Listing and search resolve product IDS in SQL (where the partial in-stock
 * index lives and where `stock_qty - reserved_qty` can actually be compared),
 * then hydrate them with Prisma. Filtering in SQL and hydrating with the ORM
 * keeps pagination correct without hand-writing every join.
 *
 * WHO IS IN THE MARKETPLACE: a listing counts when its seller is live (not
 * deleted, switched on by admin, onboarding APPROVED — the orderability gate)
 * and is not a restaurant (restaurants have their own menu surface,
 * /restaurants). There is no special store: Aadione is one of these sellers.
 *
 * CATEGORIES are owned by sellers. Two sellers' "Grocery › Rice" are separate
 * rows with the same materialised path ("grocery/rice"), so filtering by path
 * naturally merges them for the customer. A product is visible only while its
 * own category and that category's top category are both switched on.
 */

import { Prisma, type Category } from "@prisma/client";
import { ProductStatus } from "../../shared";
import { prisma, type DbClient } from "../../infra/db/prisma";

/** SQL predicate on `sellers s`: a live, non-restaurant marketplace seller. */
export const MARKETPLACE_SELLER_SQL = Prisma.sql`s.deleted_at IS NULL AND s.is_active AND s.onboarding_status = 'APPROVED' AND s.seller_type <> 'RESTAURANT'`;

/** The same rule for Prisma `where` clauses on a listing's seller. */
export const MARKETPLACE_SELLER_WHERE = {
  deletedAt: null,
  isActive: true,
  onboardingStatus: "APPROVED",
  sellerType: { not: "RESTAURANT" },
} as const satisfies Prisma.SellerWhereInput;

/**
 * Joins for a product row `p` (+ category `c`) that keep only live variants
 * listed by marketplace sellers under switched-on categories. `sl`/`s` are
 * the listing and its seller.
 */
const LISTED_JOINS = Prisma.sql`
    JOIN categories c ON c.id = p.category_id AND c.is_active AND c.deleted_at IS NULL
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id) AND top.is_active AND top.deleted_at IS NULL
    JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE' AND v.deleted_at IS NULL
    JOIN seller_listings sl ON sl.variant_id = v.id
    JOIN sellers s ON s.id = sl.seller_id AND ${MARKETPLACE_SELLER_SQL}`;

const PUBLIC_PRODUCT_SQL = Prisma.sql`p.status = 'ACTIVE' AND p.deleted_at IS NULL AND p.approval_status = 'APPROVED'`;

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

/** Live categories owned by marketplace sellers — the raw material of the customer tree. */
export async function findMarketplaceCategories(client: DbClient = prisma): Promise<Category[]> {
  return client.category.findMany({
    where: { isActive: true, deletedAt: null, seller: MARKETPLACE_SELLER_WHERE },
    orderBy: [{ depth: "asc" }, { displayOrder: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Customer-visible products per exact category path (one count per distinct
 * product). The tree merges paths across sellers and sums descendants.
 */
export async function countProductsByPath(
  client: DbClient = prisma,
): Promise<Map<string, number>> {
  const rows = await client.$queryRaw<{ path: string; count: bigint }[]>`
    SELECT c.path, COUNT(DISTINCT p.id) AS count
    FROM products p
    ${LISTED_JOINS}
    WHERE ${PUBLIC_PRODUCT_SQL}
    GROUP BY c.path`;

  return new Map(rows.map((row) => [row.path, Number(row.count)]));
}

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything needed to render a product card or page in one round trip —
 * with the offers of every marketplace seller that lists each variant.
 */
export const PRODUCT_INCLUDE = {
  brand: true,
  category: true,
  images: { orderBy: { displayOrder: "asc" } },
  variants: {
    where: { status: ProductStatus.ACTIVE, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { displayOrder: "asc" }],
    include: {
      sellerListings: {
        where: { seller: MARKETPLACE_SELLER_WHERE },
        include: { seller: { select: { id: true, name: true, allowCod: true } } },
      },
    },
  },
} satisfies Prisma.ProductInclude;

export type HydratedProduct = Prisma.ProductGetPayload<{
  include: typeof PRODUCT_INCLUDE;
}>;

export async function hydrateProducts(
  productIds: string[],
  client: DbClient = prisma,
): Promise<HydratedProduct[]> {
  if (productIds.length === 0) return [];

  const products = await client.product.findMany({
    where: { id: { in: productIds } },
    include: PRODUCT_INCLUDE,
  });

  // Preserve the ordering the SQL query decided (relevance, popularity, price).
  const order = new Map(productIds.map((id, index) => [id, index]));
  return products.sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

export async function findProductById(
  id: string,
  client: DbClient = prisma,
): Promise<HydratedProduct | null> {
  // Only an APPROVED product is public — the same gate orderability uses
  // (cart/orderability.ts), so nothing is shown that can't be bought.
  return client.product.findFirst({
    where: { id, deletedAt: null, approvalStatus: 'APPROVED' },
    include: PRODUCT_INCLUDE,
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
  /** Matches the category and everything beneath it, via the materialised path — across sellers. */
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
 * Resolves an ordered page of product ids across every marketplace seller.
 *
 * Written as SQL because the in-stock predicate compares two columns
 * (`stock_qty - reserved_qty`), which Prisma cannot express, and because the
 * partial index `seller_listings_in_stock` only helps if the query is shaped
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
    ? Prisma.sql`AND sl.is_available AND (sl.stock_qty - sl.reserved_qty) > 0`
    : Prisma.empty;

  const categoryFilter = input.categoryPath
    ? Prisma.sql`AND (c.path = ${input.categoryPath} OR c.path LIKE ${`${input.categoryPath}/%`})`
    : Prisma.empty;

  const brandFilter = input.brandId
    ? Prisma.sql`AND p.brand_id = ${input.brandId}::uuid`
    : Prisma.empty;

  // The value each sort orders by, exposed so the cursor can resume from it.
  const sortValue = {
    PRICE_ASC: Prisma.sql`MIN(sl.price_paise)`,
    PRICE_DESC: Prisma.sql`MIN(sl.price_paise)`,
    NEWEST: Prisma.sql`EXTRACT(EPOCH FROM p.created_at)`,
    POPULAR: Prisma.sql`p.popularity_score`,
    RELEVANCE: Prisma.sql`p.popularity_score`,
    DISCOUNT: Prisma.sql`MAX(sl.mrp_paise - sl.price_paise)`,
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
    ${LISTED_JOINS}
    WHERE ${PUBLIC_PRODUCT_SQL}
      ${categoryFilter}
      ${brandFilter}
      ${stockFilter}
    GROUP BY p.id, p.popularity_score, p.created_at
    ${cursorFilter}
    ORDER BY sort_value ${direction}, p.id ${direction}
    LIMIT ${input.limit}`;

  return rows.map((row) => ({ id: row.id, sortValue: Number(row.sort_value) }));
}

/** Curated Home rails (PRD §9.4 `GET /home`), across every marketplace seller. */
export async function listRailProductIds(
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
      AND sl.mrp_paise > sl.price_paise
    `,
  }[rail];

  /*
   * Best Sellers are based on actual delivered order quantities of the
   * listing's own seller orders under any DELIVERED parent order.
   *
   * A product with zero delivered sales will NOT appear in Best Sellers.
   */
  const bestSellerJoin =
    rail === "BEST_SELLERS"
      ? Prisma.sql`
          JOIN order_items oi
            ON oi.variant_id = v.id

          JOIN seller_orders so
            ON so.id = oi.seller_order_id
           AND so.seller_id = sl.seller_id

          JOIN orders o
            ON o.id = so.order_id
           AND o.status = 'DELIVERED'
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
        (sl.mrp_paise - sl.price_paise)::float
        / NULLIF(sl.mrp_paise, 0)
      ) DESC
    `,
  }[rail];

  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM products p
    ${LISTED_JOINS}

    ${bestSellerJoin}

    WHERE ${PUBLIC_PRODUCT_SQL}

      AND sl.is_available
      AND (sl.stock_qty - sl.reserved_qty) > 0

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

/** "You may also like" — same category path (any seller), in stock, excluding the current item. */
export async function listRelatedProductIds(
  categoryPath: string,
  excludeProductId: string,
  limit: number,
  client: DbClient = prisma,
): Promise<string[]> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM products p
    ${LISTED_JOINS}
    WHERE c.path = ${categoryPath}
      AND p.id <> ${excludeProductId}::uuid
      AND ${PUBLIC_PRODUCT_SQL}
      AND sl.is_available
      AND (sl.stock_qty - sl.reserved_qty) > 0
    GROUP BY p.id, p.popularity_score
    ORDER BY p.popularity_score DESC, p.id ASC
    LIMIT ${limit}`;

  return rows.map((row) => row.id);
}
