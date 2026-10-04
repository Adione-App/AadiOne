/**
 * Catalog service — categories, products, variants, search, Home feed.
 *
 * Everything commercial on a product (price, discount, stock, COD, quantity
 * limit) is resolved HERE from `seller_listings` at read time. Nothing is
 * cached into the product row and nothing is trusted from a client, so a price
 * change in the seller/admin panel is visible on the very next request.
 *
 * MARKETPLACE: every live, non-restaurant seller's catalogue — Aadione is one
 * of them, with no special store behind the app. Categories belong to
 * sellers; rows with the same materialised path ("grocery/rice") are merged
 * into one customer category, represented by the earliest such row's id, so
 * filtering by that id returns every seller's products under the path. Each
 * variant shows its best offer (in stock first, then cheapest) with that
 * offer's seller (`VariantDto.sellerId/sellerName`).
 */

import type { Category } from "@prisma/client";
import {
  CodPolicy,
  ErrorCode,
  ProductStatus,
  type CategoryDto,
  type CursorPage,
  type HomeFeedDto,
  type ProductDetailDto,
  type ProductSummaryDto,
  type VariantDto,
} from "../../shared";
import { discountPercent } from "../../shared/money";
import { resolveItemCodPolicy } from "../../shared/cod";
import { AppError } from "../../common/errors";
import { prisma } from "../../infra/db/prisma";
import {
  search as searchProvider,
  configureSearchThresholds,
} from "../../infra/search";
import * as configService from "../configuration/configuration.service";
import { ConfigKey, optionGroupsOf, optionValuesOf } from "../../shared";
import * as repository from "./catalog.repository";
import { MARKETPLACE_SELLER_WHERE, type HydratedProduct, type ProductSort } from "./catalog.repository";

/* -------------------------------------------------------------------------- */
/* Category tree                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The category tree is tiny (tens of rows), read on nearly every request, and
 * changes rarely — so it is loaded once and kept for a short TTL rather than
 * re-queried per product to resolve a COD chain.
 */
interface CategoryCache {
  byId: Map<string, Category>;
  loadedAt: number;
}

const CATEGORY_CACHE_TTL_MS = 60_000;
let categoryCache: CategoryCache | null = null;
/**
 * Shared by every caller that arrives while a refresh is already in flight.
 * Without this, a cold cache under concurrent load — e.g. Home's
 * `Promise.all` mapping every product in a rail through `toSummaryDto`,
 * each independently resolving its COD chain — has every one of those
 * callers see the cache as empty at the same instant and fire its own
 * `findAllCategories()` query, all at once, for what should be one read.
 */
let categoryCacheLoad: Promise<Map<string, Category>> | null = null;

async function getCategoryMap(): Promise<Map<string, Category>> {
  if (
    categoryCache &&
    Date.now() - categoryCache.loadedAt < CATEGORY_CACHE_TTL_MS
  ) {
    return categoryCache.byId;
  }

  if (categoryCacheLoad) return categoryCacheLoad;

  categoryCacheLoad = (async () => {
    const categories = await repository.findAllCategories();
    const byId = new Map(categories.map((category) => [category.id, category]));
    categoryCache = { byId, loadedAt: Date.now() };
    return byId;
  })();

  try {
    return await categoryCacheLoad;
  } finally {
    categoryCacheLoad = null;
  }
}

export function invalidateCategoryCache(): void {
  categoryCache = null;
}

/** Leaf category first, then each ancestor up to the root. */
async function codChainForCategory(categoryId: string): Promise<CodPolicy[]> {
  const byId = await getCategoryMap();
  const chain: CodPolicy[] = [];
  let current = byId.get(categoryId);
  let guard = 0;

  // The guard bounds the walk: a data error that made the tree cyclic must not
  // hang a request.
  while (current && guard < 10) {
    chain.push(current.allowCod);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return chain;
}

async function categoryPathFor(
  categoryId: string,
): Promise<CategoryDto["id"][]> {
  const byId = await getCategoryMap();
  const path: string[] = [];
  let current = byId.get(categoryId);
  let guard = 0;
  while (current && guard < 10) {
    path.unshift(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return path;
}

function toCategoryDto(category: Category, productCount?: number): CategoryDto {
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    nameHi: category.nameHi,
    slug: category.slug,
    imageUrl: category.imageUrl,
    depth: category.depth,
    displayOrder: category.displayOrder,
    ...(productCount !== undefined ? { productCount } : {}),
  };
}

interface CategoryGroup {
  path: string;
  parentPath: string | null;
  /** The earliest row with this path — its id stands for the whole group. */
  rep: Category;
  imageUrl: string | null;
  productCount: number;
}

/**
 * Sellers' own categories merged by materialised path, with customer-visible
 * product counts (a group counts everything beneath it). Groups without a
 * single visible product are left out — a customer never opens an empty
 * category.
 */
async function marketplaceCategoryGroups(): Promise<Map<string, CategoryGroup>> {
  const [categories, exactCounts] = await Promise.all([
    repository.findMarketplaceCategories(),
    repository.countProductsByPath(),
  ]);

  const groups = new Map<string, CategoryGroup>();
  for (const category of categories) {
    const existing = groups.get(category.path);
    if (existing) {
      existing.imageUrl ??= category.imageUrl;
      continue;
    }
    const cut = category.path.lastIndexOf("/");
    groups.set(category.path, {
      path: category.path,
      parentPath: cut === -1 ? null : category.path.slice(0, cut),
      rep: category,
      imageUrl: category.imageUrl,
      productCount: 0,
    });
  }

  for (const group of groups.values()) {
    let total = 0;
    for (const [path, count] of exactCounts) {
      if (path === group.path || path.startsWith(`${group.path}/`)) total += count;
    }
    group.productCount = total;
  }
  for (const [path, group] of groups) if (group.productCount === 0) groups.delete(path);
  return groups;
}

function groupDto(group: CategoryGroup, groups: Map<string, CategoryGroup>, withCounts: boolean): CategoryDto {
  return {
    ...toCategoryDto(group.rep, withCounts ? group.productCount : undefined),
    parentId: group.parentPath ? groups.get(group.parentPath)?.rep.id ?? null : null,
    imageUrl: group.imageUrl,
  };
}

/** Task 4.1 — top-level categories, optionally nested — merged across sellers. */
export async function listCategories(options: {
  parentId?: string | null;
  includeChildren?: boolean;
  withCounts?: boolean;
}): Promise<CategoryDto[]> {
  const groups = await marketplaceCategoryGroups();
  const withCounts = options.withCounts ?? false;

  // A parent given by id: any row of that path (another seller's id for the
  // same category works too) selects the merged group.
  let parentPath: string | null = null;
  if (options.parentId) {
    const parent = await repository.findCategoryById(options.parentId);
    if (!parent) return [];
    parentPath = parent.path;
  }

  const all = [...groups.values()];
  const level = all.filter((group) => group.parentPath === parentPath);

  return level.map((group) => {
    const dto = groupDto(group, groups, withCounts);
    if (options.includeChildren) {
      dto.children = all
        .filter((child) => child.parentPath === group.path)
        .map((child) => groupDto(child, groups, withCounts));
    }
    return dto;
  });
}

export async function listSubcategories(
  parentId: string,
): Promise<CategoryDto[]> {
  const parent = await repository.findCategoryById(parentId);
  if (!parent)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Category not found." });
  return listCategories({ parentId, withCounts: true });
}

/* -------------------------------------------------------------------------- */
/* Product mapping                                                            */
/* -------------------------------------------------------------------------- */

interface MappingContext {
  defaultCodPolicy: CodPolicy;
  defaultMaxQty: number;
}

async function mappingContext(): Promise<MappingContext> {
  const config = await configService.getMany([
    ConfigKey.DEFAULT_COD_POLICY,
    ConfigKey.DEFAULT_MAX_QTY_PER_ORDER,
  ]);
  return {
    defaultCodPolicy: config.DEFAULT_COD_POLICY,
    defaultMaxQty: config.DEFAULT_MAX_QTY_PER_ORDER,
  };
}

type Offer = HydratedProduct["variants"][number]["sellerListings"][number];

/** In stock first, then the lowest price, then the oldest listing (stable). */
function bestOffer(offers: Offer[]): Offer | undefined {
  const inStock = (offer: Offer) => offer.isAvailable && offer.stockQty - offer.reservedQty > 0;
  return [...offers].sort(
    (a, b) =>
      Number(inStock(b)) - Number(inStock(a)) ||
      a.pricePaise - b.pricePaise ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
}

function toVariantDto(
  variant: HydratedProduct["variants"][number],
  categoryChain: CodPolicy[],
  productAllowCod: CodPolicy,
  context: MappingContext,
): VariantDto | null {
  const offer = bestOffer(variant.sellerListings);
  // No marketplace seller lists this variant at all — it is not a sellable
  // thing, so it is omitted rather than shown as unavailable.
  if (!offer) return null;

  const availableQty = Math.max(0, offer.stockQty - offer.reservedQty);

  const allowCod =
    resolveItemCodPolicy(
      {
        sellerListing: offer.allowCod,
        productVariant: variant.allowCod,
        product: productAllowCod,
        categoryChain,
        seller: offer.seller.allowCod,
      },
      context.defaultCodPolicy,
    ) === CodPolicy.ALLOW;

  return {
    id: variant.id,
    sku: variant.sku,
    variantName: variant.variantName,
    optionValues: optionValuesOf(variant.optionValues),
    unit: variant.unit,
    unitValue: variant.unitValue,
    imageUrl: variant.imageUrl,
    isDefault: variant.isDefault,
    sellerListingId: offer.id,
    sellerId: offer.seller.id,
    sellerName: offer.seller.name,
    mrpPaise: offer.mrpPaise,
    pricePaise: offer.pricePaise,
    discountPercent: discountPercent(offer.mrpPaise, offer.pricePaise),
    inStock: offer.isAvailable && availableQty > 0,
    availableQty,
    maxQtyPerOrder: offer.maxQtyPerOrder || context.defaultMaxQty,
    allowCod,
  };
}

async function toSummaryDto(
  product: HydratedProduct,
  context: MappingContext,
): Promise<ProductSummaryDto> {
  const chain = await codChainForCategory(product.categoryId);
  const variants = product.variants
    .map((variant) => toVariantDto(variant, chain, product.allowCod, context))
    .filter((variant): variant is VariantDto => variant !== null);

  const primaryImage = product.images[0] ?? null;

  const sellerIds = new Set(
    product.variants.flatMap((variant) =>
      variant.sellerListings.map((listing) => listing.sellerId),
    ),
  );

  return {
    id: product.id,
    name: product.name,
    nameHi: product.nameHi,
    slug: product.slug,
    brandName: product.brand?.name ?? null,
    categoryId: product.categoryId,
    imageUrl: primaryImage?.url ?? null,
    thumbUrl: primaryImage?.thumbUrl ?? primaryImage?.url ?? null,
    // The card shows the default variant; in-stock variants win over
    // out-of-stock ones so a card never advertises an unavailable size when a
    // available one exists.
    defaultVariant:
      variants.find((variant) => variant.isDefault && variant.inStock) ??
      variants.find((variant) => variant.inStock) ??
      variants[0] ??
      null,
    variantCount: variants.length,
    sellerCount: sellerIds.size,
    status: product.status,
    approvalStatus: product.approvalStatus,
  };
}

async function toDetailDto(
  product: HydratedProduct,
  context: MappingContext,
): Promise<ProductDetailDto> {
  const summary = await toSummaryDto(product, context);
  const chain = await codChainForCategory(product.categoryId);
  const byId = await getCategoryMap();
  const pathIds = await categoryPathFor(product.categoryId);

  return {
    ...summary,
    optionGroups: optionGroupsOf(product.optionGroups),
    description: product.description,
    descriptionHi: product.descriptionHi,
    images: product.images.map((image) => ({
      id: image.id,
      url: image.url,
      thumbUrl: image.thumbUrl,
      cardUrl: image.cardUrl,
      altText: image.altText,
      displayOrder: image.displayOrder,
    })),
    variants: product.variants
      .map((variant) => toVariantDto(variant, chain, product.allowCod, context))
      .filter((variant): variant is VariantDto => variant !== null),
    attributes: (product.attributes ?? {}) as ProductDetailDto["attributes"],
    categoryPath: pathIds
      .map((id) => byId.get(id))
      .filter((category): category is Category => category !== undefined)
      .map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
      })),
  };
}

export async function mapProducts(
  products: HydratedProduct[],
): Promise<ProductSummaryDto[]> {
  const context = await mappingContext();
  return Promise.all(products.map((product) => toSummaryDto(product, context)));
}

/* -------------------------------------------------------------------------- */
/* Task 4.2 — listing and detail                                              */
/* -------------------------------------------------------------------------- */

function encodeCursor(sortValue: number, id: string): string {
  return Buffer.from(`${sortValue}|${id}`).toString("base64url");
}

function decodeCursor(
  cursor: string | null,
): { sortValue: number; id: string } | null {
  if (!cursor) return null;
  try {
    const [sortValue, id] = Buffer.from(cursor, "base64url")
      .toString("utf8")
      .split("|");
    if (!id || sortValue === undefined) return null;
    return { sortValue: Number(sortValue), id };
  } catch {
    // A malformed cursor returns the first page rather than a 500 — the app
    // may have kept one across a version upgrade.
    return null;
  }
}

export interface ListProductsInput {
  categoryId?: string | undefined;
  subcategoryId?: string | undefined;
  brandId?: string | undefined;
  inStock?: boolean | undefined;
  sort?: ProductSort | undefined;
  cursor?: string | null;
  limit: number;
}

export async function listProducts(
  input: ListProductsInput,
): Promise<CursorPage<ProductSummaryDto>> {
  // The narrower of the two wins: a subcategory inside a category.
  const targetCategoryId = input.subcategoryId ?? input.categoryId;
  let categoryPath: string | null = null;
  if (targetCategoryId) {
    const category = await repository.findCategoryById(targetCategoryId);
    if (!category) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: "Category not found.",
      });
    }
    categoryPath = category.path;
  }

  const rows = await repository.listProductIds({
    categoryPath,
    brandId: input.brandId ?? null,
    inStockOnly: input.inStock ?? false,
    sort: input.sort ?? "POPULAR",
    // One extra row tells us whether another page exists without a COUNT.
    limit: input.limit + 1,
    cursor: decodeCursor(input.cursor ?? null),
  });

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;

  const products = await repository.hydrateProducts(page.map((row) => row.id));
  const items = await mapProducts(products);
  const last = page[page.length - 1];

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.sortValue, last.id) : null,
  };
}

export async function getProductDetail(
  productId: string,
): Promise<ProductDetailDto> {
  const product = await repository.findProductById(productId);

  if (!product || product.status !== ProductStatus.ACTIVE || !(await isOnSaleSomewhere(product))) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Product not found." });
  }

  return toDetailDto(product, await mappingContext());
}

/**
 * A product is public while some marketplace seller lists one of its live
 * variants and its category and that category's top category are switched on
 * (the same gates as the listing queries).
 */
async function isOnSaleSomewhere(product: HydratedProduct): Promise<boolean> {
  if (!product.variants.some((variant) => variant.sellerListings.length > 0)) return false;
  const byId = await getCategoryMap();
  const category = byId.get(product.categoryId);
  if (!category) return false;
  return category.parentId === null || byId.has(category.parentId);
}

/** "You may also like" on the out-of-stock screen. */
export async function getRelatedProducts(
  productId: string,
  limit = 6,
): Promise<ProductSummaryDto[]> {
  const product = await repository.findProductById(productId);
  if (!product) return [];

  const ids = await repository.listRelatedProductIds(product.category.path, productId, limit);
  return mapProducts(await repository.hydrateProducts(ids));
}

/* -------------------------------------------------------------------------- */
/* Task 4.3 — search                                                          */
/* -------------------------------------------------------------------------- */

export async function searchProducts(input: {
  term: string;
  limit: number;
  cursor?: string | null;
  inStock?: boolean;
}): Promise<CursorPage<ProductSummaryDto>> {
  await configureSearchThresholds();

  const cursor = decodeCursor(input.cursor ?? null);

  const hits = await searchProvider.search({
    term: input.term,
    limit: input.limit + 1,
    afterRank: cursor?.sortValue ?? null,
    inStockOnly: input.inStock ?? false,
  });

  const hasMore = hits.length > input.limit;
  const page = hasMore ? hits.slice(0, input.limit) : hits;

  const products = await repository.hydrateProducts(page.map((hit) => hit.productId));
  const items = await mapProducts(products);
  const last = page[page.length - 1];

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last ? encodeCursor(last.rank, last.productId) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Back-in-stock ("Notify me")                                                */
/* -------------------------------------------------------------------------- */

/**
 * Registers interest in an out-of-stock variant.
 *
 * Idempotent: tapping "Notify me" twice must not queue two messages. The
 * partial unique index `back_in_stock_one_open_per_user_listing` enforces one
 * OPEN subscription per (user, listing), while allowing a fresh one after the
 * customer has already been notified once.
 */
export async function subscribeBackInStock(
  userId: string,
  variantId: string,
): Promise<void> {
  // The cheapest marketplace listing of this variant — normally its one seller.
  const offer = await prisma.sellerListing.findFirst({
    where: { variantId, seller: MARKETPLACE_SELLER_WHERE },
    orderBy: [{ pricePaise: "asc" }, { createdAt: "asc" }],
    select: { id: true, sellerId: true, stockQty: true, reservedQty: true, isAvailable: true },
  });

  if (!offer) {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: "This item is not sold here.",
    });
  }

  // Already back — say so rather than promising a notification that would fire
  // immediately and look broken.
  if (offer.isAvailable && offer.stockQty - offer.reservedQty > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "Good news — this item is already back in stock.",
    });
  }

  const existing = await prisma.backInStockSubscription.findFirst({
    where: { userId, sellerListingId: offer.id, notifiedAt: null },
    select: { id: true },
  });
  if (existing) return;

  await prisma.backInStockSubscription.create({
    data: { userId, sellerListingId: offer.id, sellerId: offer.sellerId },
  });
}

/* -------------------------------------------------------------------------- */
/* Home feed                                                                  */
/* -------------------------------------------------------------------------- */

// Order here decides dedup fill-priority (see the loop below), not just
// display order — meaningful, ranked rails (curated by real signals: offer
// depth, actual sales) get first pick of matching products. POPULAR is
// randomized (see listRailProductIds) and placed last on purpose: it has no
// ranking of its own to protect, so it should fill in from whatever the
// other rails left over rather than randomly claiming products ahead of them.
const RAILS = [
  { key: "DAILY_ESSENTIALS", title: "Daily Essentials" },
  { key: "OFFERS", title: "Offers for You" },
  { key: "BEST_SELLERS", title: "Best Sellers" },
  { key: "RECENTLY_ADDED", title: "Recently Added" },
  { key: "POPULAR", title: "Popular Products" },
] as const;

/** How many candidates each rail considers before deduplication trims it down. */
const RAIL_CANDIDATE_LIMIT = 40;
/** A rail with fewer fresh products than this backfills with repeats rather than looking sparse. */
const MIN_RAIL_SIZE = 4;
const RAIL_DISPLAY_SIZE = 10;
/** How many products a category's Home shelf shows before "See All". */
const CATEGORY_RAIL_SIZE = 10;

/**
 * One call fills the whole Home screen.
 *
 * The screen needs five collections plus categories; on rural 3G one 250 ms
 * round trip beats six. This is a read-only composition over existing
 * services, not a new domain.
 */
export async function getHomeFeed(): Promise<HomeFeedDto> {
  const context = await mappingContext();

  const categories = await listCategories({
    parentId: null,
    includeChildren: true,
  });

  /*
   * Each rail is ranked independently (popularity, recency, discount, …).
   * With a catalogue this small, the same handful of products used to
   * dominate every ranking and Home read as "the same products again and
   * again" (rails previously allowed unlimited overlap by design). Rails
   * are now filled in order, each one skipping whatever an earlier rail
   * already used — except when that would leave it with almost nothing to
   * show, in which case a repeat is still better than a near-empty shelf.
   */
  const usedProductIds = new Set<string>();
  const rails: HomeFeedDto["rails"] = [];

  for (const rail of RAILS) {
    const candidateIds = await repository.listRailProductIds(rail.key, RAIL_CANDIDATE_LIMIT);

    const freshIds = candidateIds
      .filter((id) => !usedProductIds.has(id))
      .slice(0, RAIL_DISPLAY_SIZE);

    const ids =
      freshIds.length >= MIN_RAIL_SIZE
        ? freshIds
        : candidateIds.slice(0, RAIL_DISPLAY_SIZE);

    for (const id of ids) usedProductIds.add(id);

    const products = await repository.hydrateProducts(ids);

    rails.push({
      key: rail.key,
      title: rail.title,
      products: await Promise.all(
        products.map((product) => toSummaryDto(product, context)),
      ),
    });
  }

  /*
   * One shelf per top-level category, so a category the shopper just added
   * (or any category too small to win a spot in the popularity/recency
   * rails above) still gets real visibility on Home. `categoryPath` already
   * matches every product beneath it, not just direct children.
   */
  const topLevelCategories = [...(await marketplaceCategoryGroups()).values()].filter(
    (group) => group.parentPath === null,
  );

  const categoryRails: HomeFeedDto["categoryRails"] = [];

  for (const category of topLevelCategories) {
    const rows = await repository.listProductIds({
      categoryPath: category.path,
      inStockOnly: true,
      sort: "POPULAR",
      limit: CATEGORY_RAIL_SIZE,
    });

    if (rows.length === 0) continue;

    const products = await repository.hydrateProducts(rows.map((row) => row.id));

    categoryRails.push({
      categoryId: category.rep.id,
      title: category.rep.name,
      products: await Promise.all(
        products.map((product) => toSummaryDto(product, context)),
      ),
    });
  }

  return {
    banners: [],
    categories,
    rails: rails.filter((rail) => rail.products.length > 0),
    categoryRails,
  };
}

/**
 * The full contents of one Home rail — what "See All" opens.
 *
 * Reuses the exact same ranking as the Home feed's preview of this rail, just
 * without the 10-item cap, so the two never disagree about order.
 */
export async function listRailProducts(
  key: (typeof RAILS)[number]["key"],
  limit: number,
): Promise<{ title: string; products: HomeFeedDto["rails"][number]["products"] }> {
  const context = await mappingContext();
  const rail = RAILS.find((entry) => entry.key === key)!;

  const ids = await repository.listRailProductIds(key, limit);
  const products = await repository.hydrateProducts(ids);

  return {
    title: rail.title,
    products: await Promise.all(products.map((product) => toSummaryDto(product, context))),
  };
}
