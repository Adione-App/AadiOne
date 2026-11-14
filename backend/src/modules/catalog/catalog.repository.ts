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
import { hasStockToSellSql } from "../inventory/stock-rules";
import { matchProductIds } from "../../infra/search";

/** Most products one picker search narrows to (far above any real result list). */
const SEARCH_MATCH_CAP = 500;

/** SQL predicate on a `sellers` row aliased `alias`: a live marketplace seller — not a food seller (restaurant/cafe). */
function marketplaceSellerSql(alias: string): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`invalid SQL alias ${alias}`);
  return Prisma.raw(
    `${alias}.deleted_at IS NULL AND ${alias}.is_active AND ${alias}.onboarding_status = 'APPROVED' AND ${alias}.seller_type NOT IN ('RESTAURANT', 'CAFE')`,
  );
}

/** SQL predicate on `sellers s`: a live marketplace seller — not a food seller (restaurant/cafe). */
export const MARKETPLACE_SELLER_SQL = marketplaceSellerSql('s');

/** The same rule for Prisma `where` clauses on a listing's seller. */
export const MARKETPLACE_SELLER_WHERE = {
  deletedAt: null,
  isActive: true,
  onboardingStatus: "APPROVED",
  sellerType: { notIn: ["RESTAURANT", "CAFE"] },
} as const satisfies Prisma.SellerWhereInput;

/**
 * Joins for a product row `p` (+ category `c`) that keep only live variants
 * listed by marketplace sellers under switched-on categories. `sl`/`s` are
 * the listing and its seller.
 */
const LISTED_JOINS = Prisma.sql`
    JOIN categories c ON c.id = p.category_id AND c.is_active AND c.deleted_at IS NULL
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id) AND top.is_active AND top.deleted_at IS NULL
    JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE' AND v.deleted_at IS NULL AND v.approval_status = 'APPROVED'
    JOIN seller_listings sl ON sl.variant_id = v.id
    JOIN sellers s ON s.id = sl.seller_id AND ${MARKETPLACE_SELLER_SQL}`;

const PUBLIC_PRODUCT_SQL = Prisma.sql`p.status = 'ACTIVE' AND p.deleted_at IS NULL AND p.approval_status = 'APPROVED'`;

/**
 * Home and recommendations only: keep listings of these sellers — the ones
 * taking orders right now (store-availability.ts acceptingSellerIds).
 * Null/undefined: every live seller — category pages, search and store pages
 * keep showing closed stores' products (browsable, not addable). An empty
 * list matches nothing (no store open), never everything.
 */
function onlySellersSql(sellerIds: readonly string[] | null | undefined): Prisma.Sql {
  if (sellerIds === null || sellerIds === undefined) return Prisma.empty;
  if (sellerIds.length === 0) return Prisma.sql`AND FALSE`;
  return Prisma.sql`AND sl.seller_id IN (${Prisma.join(sellerIds.map((id) => Prisma.sql`${id}::uuid`))})`;
}

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
    // Live and approved: a variant added later stays out until its review
    // passes (it is DRAFT meanwhile too — approval is checked explicitly so a
    // half-reviewed row can never reach a customer).
    where: { status: ProductStatus.ACTIVE, deletedAt: null, approvalStatus: "APPROVED" },
    // The default first, then the seller's order; creation time and id break
    // ties, so "the next size" is the same on every request and every screen.
    orderBy: [{ isDefault: "desc" }, { displayOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
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

/**
 * PRODUCT_INCLUDE limited to ONE seller's offers — a seller's store page must
 * show (and add to cart) that seller's own price, not the cheapest offer of
 * whoever else lists the same product.
 */
function sellerScopedInclude(sellerId: string): typeof PRODUCT_INCLUDE {
  return {
    ...PRODUCT_INCLUDE,
    variants: {
      ...PRODUCT_INCLUDE.variants,
      include: {
        sellerListings: {
          ...PRODUCT_INCLUDE.variants.include.sellerListings,
          where: { sellerId, seller: MARKETPLACE_SELLER_WHERE },
        },
      },
    },
  } as unknown as typeof PRODUCT_INCLUDE;
}

export async function hydrateProducts(
  productIds: string[],
  client: DbClient = prisma,
  options: { sellerId?: string | null } = {},
): Promise<HydratedProduct[]> {
  if (productIds.length === 0) return [];

  const products = await client.product.findMany({
    where: { id: { in: productIds } },
    include: options.sellerId ? sellerScopedInclude(options.sellerId) : PRODUCT_INCLUDE,
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
  /** Only this seller's listings (a store page). */
  sellerId?: string | null;
  /** Only these products — still subject to every visibility rule above. */
  productIds?: readonly string[] | null;
  /** Only listings of these sellers (see onlySellersSql); combined with the stock filter on the same listing. */
  onlySellerIds?: readonly string[] | null;
  inStockOnly?: boolean;
  sort: ProductSort;
  limit: number;
  /**
   * Ranking only (never a filter): the sellers taking orders now, so the stock
   * group follows the offer the card shows (shownOfferInStockSql).
   */
  openSellerIds?: readonly string[] | null;
  /** Keyset cursor: the last row of the previous page. `stockRank` absent (an older cursor) = the in-stock group. */
  cursor?: { sortValue: number; id: string; stockRank?: number | null } | null;
}

export interface ProductIdRow {
  id: string;
  sortValue: number;
  /** 1 = sellable stock now (in-stock group, listed first), 0 = out of stock (listed last). */
  stockRank: number;
}

/**
 * SQL predicate on a listing `sl` of variant `v`: it has sellable stock (on
 * sale, stock − reserved > 0 — `hasStockToSellSql`, never raw stock) AND it
 * can be the offer a customer is shown for that variant.
 *
 * The card shows ONE offer per variant (catalog.service `bestOffer`): a store
 * taking orders now first, then in stock, then the cheapest. So a variant
 * reads "Out of Stock" when every OPEN store's listing of it is out of stock —
 * even if a closed store still has units; only when no store listing it is
 * open does a closed store's stock count (the card then says "Store closed",
 * not "Out of Stock"). This predicate is exactly that rule, so sorting and
 * the label can never disagree.
 *
 *   openSellerIds  the sellers taking orders now (store-availability.ts
 *                  acceptingSellerIds). null/undefined: availability not
 *                  considered — any listing with stock counts.
 *   sellerId       a store page: only that seller's listings are offers.
 *
 * Delivery eligibility plays no part here: it is decided for the whole
 * platform (an eligible place is served by every live seller —
 * seller.service evaluateLocation), so it never changes which offer is shown.
 */
export function shownOfferInStockSql(openSellerIds: readonly string[] | null | undefined, sellerId: string | null = null): Prisma.Sql {
  const sellable = Prisma.sql`sl.is_available AND ${hasStockToSellSql('sl')}`;
  if (openSellerIds === null || openSellerIds === undefined) return Prisma.sql`(${sellable})`;
  const open = Prisma.sql`${[...openSellerIds]}::uuid[]`;
  return Prisma.sql`(${sellable} AND (
    sl.seller_id = ANY(${open})
    OR NOT EXISTS (
      SELECT 1 FROM seller_listings osl
      JOIN sellers os ON os.id = osl.seller_id AND ${marketplaceSellerSql('os')}
      WHERE osl.variant_id = v.id AND osl.seller_id = ANY(${open})
        ${sellerId ? Prisma.sql`AND osl.seller_id = ${sellerId}::uuid` : Prisma.empty}
    )
  ))`;
}

/**
 * The stock group of a product row `p` over its visible listings `sl`: 1 when
 * any variant's shown offer has stock to sell (shownOfferInStockSql), else 0 —
 * exactly when every card of it reads "Out of Stock". Low stock is still 1.
 */
const stockRankSql = (openSellerIds: readonly string[] | null | undefined, sellerId: string | null) =>
  Prisma.sql`MAX(CASE WHEN ${shownOfferInStockSql(openSellerIds, sellerId)} THEN 1 ELSE 0 END)`;

/**
 * Resolves an ordered page of product ids across every marketplace seller.
 *
 * Written as SQL because the in-stock predicate compares two columns
 * (`stock_qty - reserved_qty`), which Prisma cannot express, and because the
 * partial index `seller_listings_in_stock` only helps if the query is shaped
 * this way.
 *
 * Stock priority first: every product with stock to sell comes before every
 * out-of-stock one, whatever the chosen sort (stockRankSql); the chosen
 * sort orders each group, then the id (deterministic — no reshuffling between
 * refreshes). A product that sells out moves to the end of its category on
 * the next request, and back among the in-stock ones once restocked — it is
 * computed live from the listings, so nothing has to be re-saved.
 *
 * Keyset pagination on (stockRank, sortValue, id): stable while the catalogue
 * is being edited, unlike OFFSET which silently repeats or skips rows — and
 * the group is part of the key, so a page boundary between the in-stock and
 * the out-of-stock products never skips or repeats one.
 */
export async function listProductIds(
  input: ListProductIdsInput,
  client: DbClient = prisma,
): Promise<ProductIdRow[]> {
  const stockFilter = input.inStockOnly
    ? Prisma.sql`AND sl.is_available AND ${hasStockToSellSql('sl')}`
    : Prisma.empty;

  const categoryFilter = input.categoryPath
    ? Prisma.sql`AND (c.path = ${input.categoryPath} OR c.path LIKE ${`${input.categoryPath}/%`})`
    : Prisma.empty;

  const brandFilter = input.brandId
    ? Prisma.sql`AND p.brand_id = ${input.brandId}::uuid`
    : Prisma.empty;

  const sellerFilter = input.sellerId
    ? Prisma.sql`AND sl.seller_id = ${input.sellerId}::uuid`
    : Prisma.empty;

  const productFilter = input.productIds
    ? input.productIds.length > 0
      ? Prisma.sql`AND p.id IN (${Prisma.join(input.productIds.map((id) => Prisma.sql`${id}::uuid`))})`
      : Prisma.sql`AND FALSE`
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

  const STOCK_RANK_SQL = stockRankSql(input.openSellerIds, input.sellerId ?? null);
  // After the cursor: a later stock group (in stock → out of stock), or the
  // same group further along the chosen sort.
  const cursorRank = input.cursor ? (input.cursor.stockRank === 0 ? 0 : 1) : 1;
  const cursorFilter = input.cursor
    ? ascending
      ? Prisma.sql`HAVING (${STOCK_RANK_SQL} < ${cursorRank}
          OR (${STOCK_RANK_SQL} = ${cursorRank} AND (${sortValue}, p.id) > (${input.cursor.sortValue}, ${input.cursor.id}::uuid)))`
      : Prisma.sql`HAVING (${STOCK_RANK_SQL} < ${cursorRank}
          OR (${STOCK_RANK_SQL} = ${cursorRank} AND (${sortValue}, p.id) < (${input.cursor.sortValue}, ${input.cursor.id}::uuid)))`
    : Prisma.empty;

  const rows = await client.$queryRaw<{ id: string; sort_value: number; stock_rank: number }[]>`
    SELECT p.id, ${sortValue} AS sort_value, ${STOCK_RANK_SQL} AS stock_rank
    FROM products p
    ${LISTED_JOINS}
    WHERE ${PUBLIC_PRODUCT_SQL}
      ${categoryFilter}
      ${brandFilter}
      ${sellerFilter}
      ${productFilter}
      ${onlySellersSql(input.onlySellerIds)}
      ${stockFilter}
    GROUP BY p.id, p.popularity_score, p.created_at
    ${cursorFilter}
    ORDER BY stock_rank DESC, sort_value ${direction}, p.id ${direction}
    LIMIT ${input.limit}`;

  return rows.map((row) => ({ id: row.id, sortValue: Number(row.sort_value), stockRank: Number(row.stock_rank) }));
}

/**
 * In-stock products under one top-level category path, each with its own
 * category path — what the Home shelf of that category balances across its
 * subcategories. Ranked like the category listing's "popular" sort, then
 * newest first, then by id, so the result never changes between requests
 * unless the catalogue does.
 */
export async function listCategoryShelfCandidates(
  topPath: string,
  limit: number,
  onlySellerIds: readonly string[] | null = null,
  client: DbClient = prisma,
): Promise<{ id: string; path: string }[]> {
  return client.$queryRaw<{ id: string; path: string }[]>`
    SELECT p.id, c.path
    FROM products p
    ${LISTED_JOINS}
    WHERE ${PUBLIC_PRODUCT_SQL}
      AND (c.path = ${topPath} OR c.path LIKE ${`${topPath}/%`})
      AND sl.is_available
      AND ${hasStockToSellSql('sl')}
      ${onlySellersSql(onlySellerIds)}
    GROUP BY p.id, c.path, p.popularity_score, p.created_at
    ORDER BY p.popularity_score DESC, p.created_at DESC, p.id DESC
    LIMIT ${limit}`;
}

/**
 * The products a customer has ordered, most recently ordered first. Orders
 * that never went through (awaiting or failed payment) do not count. These
 * are only candidates: callers re-check visibility and stock before showing
 * any of them.
 */
export async function listOrderedProductIds(
  userId: string,
  limit: number,
  client: DbClient = prisma,
): Promise<string[]> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT v.product_id AS id
    FROM orders o
    JOIN seller_orders so ON so.order_id = o.id
    JOIN order_items oi ON oi.seller_order_id = so.id
    JOIN product_variants v ON v.id = oi.variant_id
    WHERE o.user_id = ${userId}::uuid
      AND o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')
    GROUP BY v.product_id
    ORDER BY MAX(o.created_at) DESC, v.product_id ASC
    LIMIT ${limit}`;
  return rows.map((row) => row.id);
}

/** Curated Home rails (PRD §9.4 `GET /home`), across every marketplace seller. */
export async function listRailProductIds(
  rail:
    | "POPULAR"
    | "DAILY_ESSENTIALS"
    | "BEST_SELLERS"
    | "RECENTLY_ADDED"
    | "OFFERS"
    | "TOP_PICKS",
  limit: number,
  onlySellerIds: readonly string[] | null = null,
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

    TOP_PICKS: Prisma.empty,
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

  /*
   * Top Picks: every in-stock product, ranked by real delivered quantity
   * (the same signal as Best Sellers, but products without sales still take
   * part), then by a stable order — never random, never "for you".
   */
  const topPicksJoin =
    rail === "TOP_PICKS"
      ? Prisma.sql`
          LEFT JOIN (
            SELECT oi.variant_id, so.seller_id, SUM(oi.qty) AS qty
            FROM order_items oi
            JOIN seller_orders so ON so.id = oi.seller_order_id
            JOIN orders o ON o.id = so.order_id AND o.status = 'DELIVERED'
            GROUP BY oi.variant_id, so.seller_id
          ) sold
            ON sold.variant_id = v.id
           AND sold.seller_id = sl.seller_id
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

    TOP_PICKS: Prisma.sql`
      COALESCE(SUM(sold.qty), 0) DESC,
      p.popularity_score DESC,
      p.created_at ASC
    `,
  }[rail];

  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM products p
    ${LISTED_JOINS}

    ${bestSellerJoin}
    ${topPicksJoin}

    WHERE ${PUBLIC_PRODUCT_SQL}

      AND sl.is_available
      AND ${hasStockToSellSql('sl')}
      ${onlySellersSql(onlySellerIds)}

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

/* -------------------------------------------------------------------------- */
/* Home Page Builder — configured product shelves and the product picker     */
/* -------------------------------------------------------------------------- */

export interface ShelfProductQuery {
  source: "random" | "latest" | "bestselling" | "manual";
  /** Category paths (each includes its subcategories); empty = every category. Not applied to a manual shelf's own picks. */
  categoryPaths: readonly string[];
  /** manual: exactly these products, in this order (those not buyable right now are skipped). */
  productIds?: readonly string[];
  /** Never returned (a manual shelf's picks, when topping it up). */
  excludeIds?: readonly string[];
  /** random: today's seed — the same seed gives the same order. */
  seed?: string;
  /** Only listings of these sellers (see onlySellersSql). */
  onlySellerIds?: readonly string[] | null;
  limit: number;
}

const uuidList = (ids: readonly string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

/**
 * One configured Home shelf's products, ids in display order. The same
 * customer-visibility rules as every listing (LISTED_JOINS: live marketplace
 * seller and switched-on categories; approved, active product; a listing that
 * is available with stock to sell). GROUP BY p.id: a product is listed once
 * however many sellers, variants or chosen categories match it.
 *
 *   random       md5(id || seed): a fixed order for a given seed (the shelf
 *                id + the day), so the shelf does not reshuffle on every
 *                visit; a product joining or leaving the scope changes it
 *   latest       newest first (RECENTLY_ADDED's order)
 *   bestselling  delivered quantity, then a stable order (TOP_PICKS' order)
 *   manual       the chosen order
 */
export async function listShelfProductIds(query: ShelfProductQuery, client: DbClient = prisma): Promise<string[]> {
  if (query.limit <= 0) return [];
  const picks = query.productIds ?? [];
  if (query.source === "manual" && picks.length === 0) return [];

  const scope =
    query.source !== "manual" && query.categoryPaths.length > 0
      ? Prisma.sql`AND (${Prisma.join(
          query.categoryPaths.map((path) => Prisma.sql`(c.path = ${path} OR c.path LIKE ${`${path}/%`})`),
          " OR ",
        )})`
      : Prisma.empty;
  const only = query.source === "manual" ? Prisma.sql`AND p.id IN (${uuidList(picks)})` : Prisma.empty;
  const exclude = query.excludeIds && query.excludeIds.length > 0 ? Prisma.sql`AND p.id NOT IN (${uuidList(query.excludeIds)})` : Prisma.empty;
  const soldJoin =
    query.source === "bestselling"
      ? Prisma.sql`
          LEFT JOIN (
            SELECT oi.variant_id, so.seller_id, SUM(oi.qty) AS qty
            FROM order_items oi
            JOIN seller_orders so ON so.id = oi.seller_order_id
            JOIN orders o ON o.id = so.order_id AND o.status = 'DELIVERED'
            GROUP BY oi.variant_id, so.seller_id
          ) sold ON sold.variant_id = v.id AND sold.seller_id = sl.seller_id`
      : Prisma.empty;
  const ordering = {
    random: Prisma.sql`md5(p.id::text || ${query.seed ?? ""})`,
    latest: Prisma.sql`p.created_at DESC`,
    bestselling: Prisma.sql`COALESCE(SUM(sold.qty), 0) DESC, p.popularity_score DESC, p.created_at ASC`,
    manual: Prisma.sql`array_position(${[...picks]}::uuid[], p.id)`,
  }[query.source];

  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM products p
    ${LISTED_JOINS}
    ${soldJoin}
    WHERE ${PUBLIC_PRODUCT_SQL}
      AND sl.is_available
      AND ${hasStockToSellSql("sl")}
      ${onlySellersSql(query.onlySellerIds)}
      ${scope}
      ${only}
      ${exclude}
    GROUP BY p.id, p.popularity_score, p.created_at
    ORDER BY ${ordering}, p.id ASC
    LIMIT ${query.limit}`;
  return rows.map((row) => row.id);
}

export interface ProductOptionRow {
  id: string;
  name: string;
  image_url: string | null;
  category_path: string;
  category_name: string;
  parent_name: string | null;
  brand_name: string | null;
  price_paise: number | null;
  mrp_paise: number | null;
  variant_count: number;
  seller_count: number;
  available: boolean;
}

/**
 * The builder's product picker: published (active, approved) products under
 * live marketplace categories — restaurants' menus are not part of Home
 * shelves — with their lowest live price, how many variants and sellers they
 * have, and whether customers can buy them right now. Name order, keyset
 * paginated on (name, id).
 */
export async function listProductOptions(
  input: {
    search?: string;
    categoryPath?: string;
    sellerId?: string;
    ids?: readonly string[];
    after?: { name: string; id: string };
    limit: number;
  },
  client: DbClient = prisma,
): Promise<ProductOptionRow[]> {
  // Smart Search (infra/search): English / Hindi / Hinglish names, synonyms
  // and typos. It narrows the set; the picker keeps its own name order and
  // keyset pagination.
  const term = input.search?.trim();
  const matched = term ? [...(await matchProductIds(term, Prisma.sql`p.deleted_at IS NULL`, SEARCH_MATCH_CAP, client)).keys()] : null;
  const search = matched ? (matched.length > 0 ? Prisma.sql`AND p.id IN (${uuidList(matched)})` : Prisma.sql`AND FALSE`) : Prisma.empty;
  const category = input.categoryPath
    ? Prisma.sql`AND (c.path = ${input.categoryPath} OR c.path LIKE ${`${input.categoryPath}/%`})`
    : Prisma.empty;
  const seller = input.sellerId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM product_variants fv JOIN seller_listings fl ON fl.variant_id = fv.id
        WHERE fv.product_id = p.id AND fv.deleted_at IS NULL AND fl.seller_id = ${input.sellerId}::uuid)`
    : Prisma.empty;
  const ids = input.ids ? (input.ids.length > 0 ? Prisma.sql`AND p.id IN (${uuidList(input.ids)})` : Prisma.sql`AND FALSE`) : Prisma.empty;
  const after = input.after ? Prisma.sql`AND (p.name, p.id) > (${input.after.name}, ${input.after.id}::uuid)` : Prisma.empty;

  return client.$queryRaw<ProductOptionRow[]>`
    SELECT p.id, p.name,
      (SELECT COALESCE(pi.card_url, pi.thumb_url, pi.url) FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.display_order, pi.created_at LIMIT 1) AS image_url,
      c.path AS category_path, c.name AS category_name, parent.name AS parent_name, b.name AS brand_name,
      agg.price_paise, agg.mrp_paise,
      COALESCE(agg.seller_count, 0)::int AS seller_count,
      COALESCE(agg.available, FALSE) AS available,
      (SELECT count(*) FROM product_variants cv WHERE cv.product_id = p.id AND cv.status = 'ACTIVE' AND cv.deleted_at IS NULL)::int AS variant_count
    FROM products p
    JOIN categories c ON c.id = p.category_id AND c.is_active AND c.deleted_at IS NULL
    JOIN sellers s ON s.id = c.seller_id AND ${MARKETPLACE_SELLER_SQL}
    LEFT JOIN categories parent ON parent.id = c.parent_id
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN LATERAL (
      SELECT MIN(sl.price_paise)::int AS price_paise,
        (array_agg(sl.mrp_paise ORDER BY sl.price_paise))[1]::int AS mrp_paise,
        count(DISTINCT sl.seller_id)::int AS seller_count,
        bool_or(sl.is_available AND ${hasStockToSellSql("sl")}) AS available
      FROM product_variants v
      JOIN seller_listings sl ON sl.variant_id = v.id
      JOIN sellers ls ON ls.id = sl.seller_id AND ls.deleted_at IS NULL AND ls.is_active AND ls.onboarding_status = 'APPROVED'
      WHERE v.product_id = p.id AND v.status = 'ACTIVE' AND v.deleted_at IS NULL
    ) agg ON TRUE
    WHERE ${PUBLIC_PRODUCT_SQL}
      ${search}
      ${category}
      ${seller}
      ${ids}
      ${after}
    ORDER BY p.name, p.id
    LIMIT ${input.limit}`;
}

/** Of `ids`, the products that still exist as published (active, approved, not deleted) products. */
export async function findPublishedProductIds(ids: readonly string[], client: DbClient = prisma): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM products p WHERE p.id IN (${uuidList(ids)}) AND ${PUBLIC_PRODUCT_SQL}`;
  return new Set(rows.map((row) => row.id));
}

/* -------------------------------------------------------------------------- */
/* Store directory — what each marketplace seller shows a customer           */
/* -------------------------------------------------------------------------- */

export interface SellerCatalogueStats {
  productCount: number;
  /** Top categories with visible products, in the seller's own order. */
  categoryNames: string[];
  previewImageUrls: string[];
}

/**
 * Per marketplace seller: how many customer-visible products it lists, under
 * which of its top categories, and a few real product images — the same
 * visibility joins as every other customer listing, so a seller whose whole
 * catalogue is hidden simply has no entry.
 */
export async function sellerCatalogueStats(
  sellerIds?: readonly string[],
  client: DbClient = prisma,
): Promise<Map<string, SellerCatalogueStats>> {
  const scope =
    sellerIds && sellerIds.length > 0
      ? Prisma.sql`AND s.id = ANY(${[...sellerIds]}::uuid[])`
      : Prisma.empty;

  const [categoryRows, imageRows] = await Promise.all([
    client.$queryRaw<{ seller_id: string; name: string; count: bigint }[]>`
      SELECT s.id AS seller_id, top.name, COUNT(DISTINCT p.id) AS count
      FROM products p
      ${LISTED_JOINS}
      WHERE ${PUBLIC_PRODUCT_SQL} ${scope}
      GROUP BY s.id, top.id, top.name, top.display_order
      ORDER BY top.display_order ASC, top.name ASC`,
    client.$queryRaw<{ seller_id: string; url: string }[]>`
      WITH seller_products AS (
        SELECT DISTINCT s.id AS seller_id, p.id AS product_id, p.popularity_score
        FROM products p
        ${LISTED_JOINS}
        WHERE ${PUBLIC_PRODUCT_SQL} ${scope}
          AND sl.is_available AND ${hasStockToSellSql('sl')}
      )
      SELECT seller_id, url FROM (
        SELECT sp.seller_id, COALESCE(pi.thumb_url, pi.url) AS url,
               ROW_NUMBER() OVER (PARTITION BY sp.seller_id ORDER BY sp.popularity_score DESC, sp.product_id) AS rn
        FROM seller_products sp
        JOIN LATERAL (
          SELECT url, thumb_url FROM product_images
          WHERE product_id = sp.product_id
          ORDER BY display_order ASC
          LIMIT 1
        ) pi ON TRUE
      ) ranked
      WHERE rn <= 3`,
  ]);

  // A product sits in exactly one top category, so the per-category counts
  // of one seller add up to its distinct product count.
  const stats = new Map<string, SellerCatalogueStats>();
  for (const row of categoryRows) {
    const entry = stats.get(row.seller_id) ?? { productCount: 0, categoryNames: [], previewImageUrls: [] };
    entry.productCount += Number(row.count);
    if (!entry.categoryNames.includes(row.name)) entry.categoryNames.push(row.name);
    stats.set(row.seller_id, entry);
  }
  for (const row of imageRows) stats.get(row.seller_id)?.previewImageUrls.push(row.url);
  return stats;
}

/** "You may also like" — same category path (any seller), in stock, excluding the current item. */
export async function listRelatedProductIds(
  categoryPath: string,
  excludeProductId: string,
  limit: number,
  onlySellerIds: readonly string[] | null = null,
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
      AND ${hasStockToSellSql('sl')}
      ${onlySellersSql(onlySellerIds)}
    GROUP BY p.id, p.popularity_score
    ORDER BY p.popularity_score DESC, p.id ASC
    LIMIT ${limit}`;

  return rows.map((row) => row.id);
}
