/**
 * Home section engine — turns whatever the backend returns into the ordered
 * list of sections Home renders. Pure functions, no React, no I/O.
 *
 * NOTHING ABOUT THE CATALOGUE IS WRITTEN HERE. Sections are decided by KIND
 * (banner slot, category grid, category shelf, discovery rail) — never by a
 * category, product, seller or banner name:
 *
 *   - which top categories come first is the admin's HOME_CATEGORY_ORDER
 *     (the server sends `categories` in that order and names the featured
 *     ones in `featuredCategoryIds`); every other category follows by itself;
 *   - every banner is an admin banner from the feed (HOME_BANNER_PLACEMENTS),
 *     and an empty placement shows nothing;
 *   - a category added tomorrow gets a tile and a shelf because the server
 *     returns it, and something switched off disappears because it stops.
 *
 * The page, top to bottom (any section without data is simply absent):
 *
 *   main banner · top categories
 *   food banner · restaurants · featured category shelves (each with the
 *     banners placed above it)
 *   explore banner · explore subcategories · remaining category shelves ·
 *     more categories · stores near you
 *   top picks · offers (products, then coupons) · recently added ·
 *     previous orders · final banner · footer
 *
 * DUPLICATES: a category shelf always shows its own products (category
 * correctness first). The discovery rails after them prefer products the page
 * has not shown yet, and only fall back to repeats when fewer than
 * MIN_FRESH new ones are left — so a small catalogue never hides valid
 * inventory behind an empty rail. Previous orders are the customer's own
 * history and are never filtered against the rest of the page.
 */

import { BANNER_RAIL_TARGETS, resolveBannerLayout } from "@shared";
import type {
  BannerDto,
  CategoryDto,
  ResolvedBannerLayout,
  HomeFeedDto,
  OfferDto,
  ProductSummaryDto,
  RestaurantSummaryDto,
  StoreSummaryDto,
} from "@shared";

export type RailKey = HomeFeedDto["rails"][number]["key"];

/** Where a section's "View All" / a banner's tap goes. */
export type HomeAction =
  | { type: "rail"; railKey: RailKey; title: string }
  | { type: "category"; categoryId: string }
  | { type: "allCategories" }
  | { type: "product"; productId: string }
  | { type: "food" }
  | { type: "orders" }
  | { type: "coupon"; code: string }
  /** Store / restaurant / web link banners — opened by lib/bannerAction.ts. */
  | { type: "banner"; banner: BannerDto }
  | { type: "none" };

/** One admin banner, ready to draw. */
export interface PromoSlide {
  key: string;
  title: string | null;
  subtitle: string | null;
  imageUrl: string;
  /** Frame width / height: the admin's frame shape, else the uploaded image's own. */
  aspectRatio: number | null;
  /** The banner's presentation (fit, image position, fixed height…) from the Admin Panel. */
  layout: ResolvedBannerLayout;
  action: HomeAction;
}

export type HomeSection =
  | { kind: "banners"; key: string; slides: PromoSlide[] }
  | {
      kind: "categoryGrid";
      key: string;
      title: string;
      categories: CategoryDto[];
      columns: 4 | 5;
      viewAll: HomeAction | null;
    }
  | { kind: "food"; key: "food" }
  | { kind: "stores"; key: "stores" }
  | { kind: "offers"; key: "offers" }
  | {
      kind: "shelf";
      key: string;
      title: string;
      subtitle: string | null;
      products: ProductSummaryDto[];
      viewAll: HomeAction | null;
    }
  | { kind: "footer"; key: "footer" };

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** Products per shelf on Home — "View All" has the rest. */
export const MAX_SHELF = 10;
/** A discovery rail shows only new products while at least this many are left. */
export const MIN_FRESH = 4;
/** Top categories in the first grid (two rows of four); the rest go to "More categories". */
export const TOP_CATEGORY_TILES = 8;
/** Subcategories in "Explore subcategories" (two rows of five). */
export const EXPLORE_SUBCATEGORY_TILES = 10;
/** Tiles in the "More categories" grid before "View All". */
export const MORE_CATEGORY_TILES = 12;

/* -------------------------------------------------------------------------- */
/* Product selection                                                           */
/* -------------------------------------------------------------------------- */

/** Only things a customer can add right now belong on Home. */
function isBuyable(product: ProductSummaryDto): boolean {
  return product.defaultVariant !== null && product.defaultVariant.inStock;
}

/** A category shelf: its own buyable products, whatever else the page shows. */
function pickCategoryShelf(products: readonly ProductSummaryDto[], shown: Set<string>): ProductSummaryDto[] {
  const picked = products.filter(isBuyable).slice(0, MAX_SHELF);
  for (const product of picked) shown.add(product.id);
  return picked;
}

/**
 * A discovery rail: products the page has not shown yet, in the rail's own
 * order. When fewer than MIN_FRESH are new, the rail's already-shown products
 * fill in after them rather than leaving it near-empty.
 */
export function pickPreferFresh(products: readonly ProductSummaryDto[], shown: Set<string>): ProductSummaryDto[] {
  const buyable = products.filter(isBuyable);
  const fresh = buyable.filter((product) => !shown.has(product.id));
  const chosen = fresh.length >= MIN_FRESH ? fresh : [...fresh, ...buyable.filter((product) => shown.has(product.id))];
  const picked = chosen.slice(0, MAX_SHELF);
  for (const product of picked) shown.add(product.id);
  return picked;
}

/* -------------------------------------------------------------------------- */
/* Category grids                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Up to `limit` subcategories, taking turns across their parents (first
 * subcategory of every parent, then the second of every parent, …) so the
 * grid spans as many different categories as possible. Order follows the
 * server's category order; nothing is shuffled.
 */
export function spreadSubcategories(categories: readonly CategoryDto[], limit: number): CategoryDto[] {
  const lists = categories.map((category) => category.children ?? []);
  const picked: CategoryDto[] = [];
  const seen = new Set<string>();
  for (let round = 0; picked.length < limit; round += 1) {
    let tookAny = false;
    for (const list of lists) {
      const child = list[round];
      if (!child) continue;
      tookAny = true;
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      picked.push(child);
      if (picked.length === limit) break;
    }
    if (!tookAny) break;
  }
  return picked;
}

/* -------------------------------------------------------------------------- */
/* Banners                                                                     */
/* -------------------------------------------------------------------------- */

function bannerAction(banner: BannerDto, whenNone: HomeAction): HomeAction {
  const value = banner.actionValue;
  switch (banner.actionType) {
    case "CATEGORY":
      return value ? { type: "category", categoryId: value } : whenNone;
    case "PRODUCT":
      return value ? { type: "product", productId: value } : whenNone;
    case "COUPON":
      return value ? { type: "coupon", code: value } : whenNone;

    case "RAIL": {
      const rail = BANNER_RAIL_TARGETS.find((entry) => entry.key === value);
      return rail ? { type: "rail", railKey: rail.key as RailKey, title: rail.label } : whenNone;
    }

    case "STORE":
    case "RESTAURANT":
    case "URL":
      return value ? { type: "banner", banner } : whenNone;

    default:
      return whenNone;
  }
}

/** Admin banners as slides. `whenNone` is where an image-only banner goes (usually nowhere). */
export function bannerSlides(
  banners: readonly BannerDto[] | undefined,
  keyPrefix: string,
  whenNone: HomeAction = { type: "none" },
): PromoSlide[] {
  return (banners ?? []).map((banner) => {
    const layout = resolveBannerLayout(banner.layout);
    return {
      key: `${keyPrefix}:${banner.id}`,
      title: banner.title,
      subtitle: banner.subtitle,
      imageUrl: banner.imageUrl,
      aspectRatio:
        layout.aspectRatio ??
        (banner.imageWidth > 0 && banner.imageHeight > 0
          ? banner.imageWidth / banner.imageHeight
          : null),
      layout,
      action: bannerAction(banner, whenNone),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Section layout                                                              */
/* -------------------------------------------------------------------------- */

export interface HomeLayoutInput {
  feed: HomeFeedDto;
  hasFood: boolean;
  hasStores: boolean;
  hasOffers: boolean;
  /** The customer's previously ordered products (already eligible); null/empty = none. */
  previousOrders: readonly ProductSummaryDto[] | null;
}

export function buildHomeSections(input: HomeLayoutInput): HomeSection[] {
  const { feed } = input;
  const sections: HomeSection[] = [];
  const shown = new Set<string>();

  const banners = (key: string, slides: PromoSlide[]) => {
    if (slides.length > 0) sections.push({ kind: "banners", key, slides });
  };

  /* A — main banner, top categories ---------------------------------------- */

  banners("banners:top", bannerSlides(feed.banners, "top"));

  const topCategories = feed.categories.slice(0, TOP_CATEGORY_TILES);
  if (topCategories.length > 0) {
    sections.push({
      kind: "categoryGrid",
      key: "grid:top",
      title: "Top Categories",
      categories: topCategories,
      columns: 4,
      viewAll: { type: "allCategories" },
    });
  }

  /* B — food, featured category shelves ------------------------------------- */

  banners(
    "banners:food",
    bannerSlides(feed.sectionBanners?.home_food, "food", input.hasFood ? { type: "food" } : { type: "none" }),
  );
  if (input.hasFood) sections.push({ kind: "food", key: "food" });

  const bannersAbove = new Map((feed.categoryBanners ?? []).map((entry) => [entry.categoryId, entry.banners]));
  const categoryShelf = (rail: HomeFeedDto["categoryRails"][number]) => {
    banners(`banners:category:${rail.categoryId}`, bannerSlides(bannersAbove.get(rail.categoryId), `category:${rail.categoryId}`));
    const products = pickCategoryShelf(rail.products, shown);
    if (products.length > 0) {
      sections.push({
        kind: "shelf",
        key: `category:${rail.categoryId}`,
        title: rail.title,
        subtitle: null,
        products,
        viewAll: { type: "category", categoryId: rail.categoryId },
      });
    }
  };

  // No admin order (or an older server): every category shelf is a main one.
  const featuredIds = feed.featuredCategoryIds ?? [];
  const featured = new Set(featuredIds.length > 0 ? featuredIds : feed.categoryRails.map((rail) => rail.categoryId));
  for (const rail of feed.categoryRails) if (featured.has(rail.categoryId)) categoryShelf(rail);

  /* C — category discovery --------------------------------------------------- */

  banners("banners:explore", bannerSlides(feed.sectionBanners?.home_explore, "explore"));

  const explore = spreadSubcategories(feed.categories, EXPLORE_SUBCATEGORY_TILES);
  if (explore.length > 0) {
    sections.push({
      kind: "categoryGrid",
      key: "grid:explore",
      title: "Explore Subcategories",
      categories: explore,
      columns: 5,
      viewAll: { type: "allCategories" },
    });
  }

  for (const rail of feed.categoryRails) if (!featured.has(rail.categoryId)) categoryShelf(rail);

  // Everything not already a tile above: top categories past the first grid,
  // then the subcategories "Explore" did not show.
  const onGrid = new Set([...topCategories, ...explore].map((category) => category.id));
  const more = [
    ...feed.categories.slice(TOP_CATEGORY_TILES),
    ...feed.categories.flatMap((category) => category.children ?? []),
  ]
    .filter((category) => !onGrid.has(category.id))
    .slice(0, MORE_CATEGORY_TILES);
  if (more.length > 0) {
    sections.push({
      kind: "categoryGrid",
      key: "grid:more",
      title: "More Categories",
      categories: more,
      columns: 4,
      viewAll: { type: "allCategories" },
    });
  }

  if (input.hasStores) sections.push({ kind: "stores", key: "stores" });

  /* D — product discovery ---------------------------------------------------- */

  const railByKey = new Map(feed.rails.map((rail) => [rail.key, rail]));
  const discoveryRail = (rail: HomeFeedDto["rails"][number] | undefined) => {
    if (!rail) return;
    const products = pickPreferFresh(rail.products, shown);
    if (products.length === 0) return;
    sections.push({
      kind: "shelf",
      key: `rail:${rail.key}`,
      title: rail.title,
      subtitle: null,
      products,
      viewAll: { type: "rail", railKey: rail.key, title: rail.title },
    });
  };

  // Top Picks; a server without it still has real Best Sellers.
  discoveryRail(railByKey.get("TOP_PICKS") ?? railByKey.get("BEST_SELLERS"));
  discoveryRail(railByKey.get("OFFERS"));
  if (input.hasOffers) sections.push({ kind: "offers", key: "offers" });
  discoveryRail(railByKey.get("RECENTLY_ADDED"));

  const previous = (input.previousOrders ?? []).filter(isBuyable).slice(0, MAX_SHELF);
  if (previous.length > 0) {
    sections.push({
      kind: "shelf",
      key: "previous-orders",
      title: "Previous Orders",
      subtitle: "Order again",
      products: previous,
      viewAll: { type: "orders" },
    });
  }

  banners("banners:bottom", bannerSlides(feed.sectionBanners?.home_bottom, "bottom"));

  sections.push({ kind: "footer", key: "footer" });
  return sections;
}

/* -------------------------------------------------------------------------- */
/* Small presentation helpers shared by Home, Food and store screens           */
/* -------------------------------------------------------------------------- */

/** "RESTAURANT" → "Restaurants" — works for any seller type the backend adds. */
export function pluralTypeLabel(type: string): string {
  const word = type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
  return word.endsWith("s") ? word : `${word}s`;
}

/** "CAFE" → "Cafe". */
export function typeLabel(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}

/** The cuisines across restaurants, most common first, for one summary line. */
export function topCuisines(restaurants: readonly RestaurantSummaryDto[], count = 4): string[] {
  const tally = new Map<string, number>();
  for (const restaurant of restaurants) {
    for (const cuisine of restaurant.cuisine) {
      const name = cuisine.trim();
      if (name) tally.set(name, (tally.get(name) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([name]) => name);
}

export function offerHeadline(offer: OfferDto, formatPaise: (paise: number) => string): string {
  switch (offer.type) {
    case "PERCENT":
      return `${offer.discountValue}% OFF`;
    case "FLAT":
      return `${formatPaise(offer.discountValue)} OFF`;
    default:
      return "FREE DELIVERY";
  }
}

export function storeSubtitle(store: StoreSummaryDto): string {
  return store.categoryNames.length > 0 ? store.categoryNames.join(" · ") : typeLabel(store.sellerType);
}
