/**
 * Home section engine — turns whatever the backend returns into the ordered
 * list of sections Home renders. Pure functions, no React, no I/O.
 *
 * NOTHING ABOUT THE CATALOGUE IS WRITTEN HERE. Section order is decided by
 * section KIND (curated rail, category shelf, stores, food, offers) — never by
 * a category, product or seller name. A category added tomorrow gets a shelf
 * because it is in `feed.categoryRails` / `feed.categories`, a store appears
 * because `/stores` returned it, and something disabled disappears because
 * the backend stopped returning it.
 *
 * ONE DISCOVERY FEED, NO PRODUCT TWICE: shelves are filled top to bottom and
 * a product id is shown at most ONCE on the whole page (`pickUnique`). A shelf
 * shows only the products no earlier shelf showed — however few that leaves —
 * and is hidden when it has nothing new. There is no fallback that reuses an
 * already-shown product to fill a shelf.
 */

import type {
  CategoryDto,
  HomeFeedDto,
  OfferDto,
  ProductSummaryDto,
  RestaurantSummaryDto,
  StoreSummaryDto,
} from "@shared";

export type RailKey = HomeFeedDto["rails"][number]["key"];

/** Where a section's "View All" / a banner's CTA goes. */
export type HomeAction =
  | { type: "rail"; railKey: RailKey; title: string }
  | { type: "category"; categoryId: string }
  | { type: "product"; productId: string }
  | { type: "food" }
  | { type: "coupon"; code: string }
  | { type: "none" };

export type HomeSection =
  | { kind: "banners"; key: "banners" }
  | { kind: "categories"; key: "categories" }
  | { kind: "food"; key: "food" }
  | { kind: "stores"; key: "stores" }
  | { kind: "offers"; key: "offers" }
  | {
      kind: "shelf";
      key: string;
      title: string;
      products: ProductSummaryDto[];
      viewAll: HomeAction;
      /** Set for a lazily loaded category shelf — its section fetches this category. */
      lazyCategoryId: string | null;
      /** True while a lazy shelf's products have not arrived yet (render a skeleton). */
      loading: boolean;
    }
  | { kind: "footer"; key: "footer" };

/* -------------------------------------------------------------------------- */
/* Unique product selection                                                    */
/* -------------------------------------------------------------------------- */

/** Products per shelf on Home — "View All" has the rest. */
export const MAX_SHELF = 12;

/** Only things a customer can add right now belong on Home. */
function isBuyable(product: ProductSummaryDto): boolean {
  return product.defaultVariant !== null && product.defaultVariant.inStock;
}

/**
 * The shelf's buyable products that are not on the page yet (capped at
 * MAX_SHELF), recorded in `shown` so no later shelf can show them again.
 * Empty = nothing new: the caller hides the shelf.
 */
function pickUnique(products: readonly ProductSummaryDto[], shown: Set<string>): ProductSummaryDto[] {
  const picked: ProductSummaryDto[] = [];
  for (const product of products) {
    if (!isBuyable(product) || shown.has(product.id)) continue;
    shown.add(product.id);
    picked.push(product);
    if (picked.length === MAX_SHELF) break;
  }
  return picked;
}
/* -------------------------------------------------------------------------- */
/* Section layout                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every subcategory, in the server's category order, as a lazily loaded
 * shelf. Top-level categories already have a shelf each (`categoryRails`).
 */
export function lazyShelfCategories(feed: HomeFeedDto): CategoryDto[] {
  return feed.categories.flatMap((category) => category.children ?? []);
}

export interface HomeLayoutInput {
  feed: HomeFeedDto;
  hasFood: boolean;
  hasStores: boolean;
  hasOffers: boolean;
  /** How many lazy shelves are on the page so far (grows as the customer scrolls). */
  lazyCount: number;
  /** categoryId → its loaded products; absent = not loaded yet. */
  lazyProducts: ReadonlyMap<string, ProductSummaryDto[]>;
}

type Slot =
  | { slot: "fixed"; section: HomeSection }
  | { slot: "rail"; rail: HomeFeedDto["rails"][number] }
  | { slot: "categoryRail"; rail: HomeFeedDto["categoryRails"][number] }
  | { slot: "lazy"; category: CategoryDto };

/**
 * The page, top to bottom:
 *
 *   banners · categories · deals · daily essentials · food · first category
 *   shelves · stores · best sellers · offers & coupons · remaining category
 *   shelves (new arrivals woven in) · popular · subcategory shelves (lazy,
 *   incremental) · footer
 *
 * Any section whose data is empty is simply not in the list.
 */
export function buildHomeSections(input: HomeLayoutInput): HomeSection[] {
  const { feed } = input;
  const railByKey = new Map(feed.rails.map((rail) => [rail.key, rail]));
  const rail = (key: RailKey): Slot[] => {
    const found = railByKey.get(key);
    return found ? [{ slot: "rail", rail: found }] : [];
  };
  const fixed = (section: HomeSection, when = true): Slot[] =>
    when ? [{ slot: "fixed", section }] : [];

  const categoryRails: Slot[] = feed.categoryRails.map((entry) => ({ slot: "categoryRail", rail: entry }));
  const firstCategories = categoryRails.slice(0, 2);
  const laterCategories = categoryRails.slice(2);
  const lazyAll = lazyShelfCategories(feed);
  const lazy: Slot[] = lazyAll
    .slice(0, input.lazyCount)
    .map((category) => ({ slot: "lazy", category }));

  const slots: Slot[] = [
    ...fixed({ kind: "banners", key: "banners" }),
    ...fixed({ kind: "categories", key: "categories" }, feed.categories.length > 0),
    ...rail("OFFERS"),
    ...rail("DAILY_ESSENTIALS"),
    ...fixed({ kind: "food", key: "food" }, input.hasFood),
    ...firstCategories,
    ...fixed({ kind: "stores", key: "stores" }, input.hasStores),
    ...rail("BEST_SELLERS"),
    ...fixed({ kind: "offers", key: "offers" }, input.hasOffers),
    // New arrivals sit after the first of the remaining category shelves so
    // the page alternates "what's new" with "browse a category".
    ...laterCategories.slice(0, 1),
    ...rail("RECENTLY_ADDED"),
    ...laterCategories.slice(1),
    ...rail("POPULAR"),
    ...lazy,
    ...fixed({ kind: "footer", key: "footer" }, input.lazyCount >= lazyAll.length),
  ];

  // Every product id already on the page, in render order.
  const shown = new Set<string>();
  const sections: HomeSection[] = [];

  for (const slot of slots) {
    switch (slot.slot) {
      case "fixed":
        sections.push(slot.section);
        break;

      case "rail": {
        const products = pickUnique(slot.rail.products, shown);
        if (products.length > 0) {
          sections.push({
            kind: "shelf",
            key: `rail:${slot.rail.key}`,
            title: slot.rail.title,
            products,
            viewAll: { type: "rail", railKey: slot.rail.key, title: slot.rail.title },
            lazyCategoryId: null,
            loading: false,
          });
        }
        break;
      }

      case "categoryRail": {
        const products = pickUnique(slot.rail.products, shown);
        if (products.length > 0) {
          sections.push({
            kind: "shelf",
            key: `category:${slot.rail.categoryId}`,
            title: slot.rail.title,
            products,
            viewAll: { type: "category", categoryId: slot.rail.categoryId },
            lazyCategoryId: null,
            loading: false,
          });
        }
        break;
      }

      case "lazy": {
        const loaded = input.lazyProducts.get(slot.category.id);
        const base = {
          kind: "shelf" as const,
          key: `sub:${slot.category.id}`,
          title: slot.category.name,
          viewAll: { type: "category" as const, categoryId: slot.category.id },
          lazyCategoryId: slot.category.id,
        };
        if (!loaded) {
          sections.push({ ...base, products: [], loading: true });
          break;
        }
        const products = pickUnique(loaded, shown);
        if (products.length > 0) sections.push({ ...base, products, loading: false });
        break;
      }
    }
  }

  return sections;
}

/* -------------------------------------------------------------------------- */
/* Banner slides                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a composed slide draws beside its copy. Deliberately NEVER a
 * catalogue product photo: every product may appear only once on Home (as a
 * ProductCard), so a banner showing one would repeat it. Banners also never
 * claim products in the shelf selection above.
 */
export type SlideVisual =
  /** The category's own image when the seller set one, else its keyword icon. */
  | { kind: "category"; name: string; imageUrl: string | null }
  /** A discount graphic for the deals slide. */
  | { kind: "deals" }
  /** A food graphic for the restaurants & cafes slide. */
  | { kind: "food" };

export interface PromoSlide {
  key: string;
  title: string;
  subtitle: string | null;
  /** Short highlight pill, e.g. "Up to 40% off". */
  badge: string | null;
  /** Non-product graphic for a composed slide; null for backend artwork. */
  visual: SlideVisual | null;
  /** A full designed banner image from the backend (drawn edge to edge). */
  artworkUrl: string | null;
  /** A full designed banner bundled with the app (`require(...)`), drawn edge to edge. */
  artworkAsset: number | null;
  /** Width / height of the designed artwork, so the slide shows all of it, uncropped. */
  artworkAspectRatio: number | null;
  ctaLabel: string;
  action: HomeAction;
}

/** The designed Home banners bundled with the app (1983 × 793 px each). */
const HOME_BANNER_ASPECT_RATIO = 1983 / 793;
const HOME_BANNERS: ReadonlyArray<{ key: string; title: string; asset: number; categoryKeywords: readonly string[] }> = [
  {
    key: "daily-essentials",
    title: "Daily essentials",
    asset: require("../../../assets/home-banner-daily-essentials.png") as number,
    categoryKeywords: ["essential", "grocery", "kirana", "staple"],
  },
  {
    key: "electronics",
    title: "Electronics",
    asset: require("../../../assets/home-banner-electronics.png") as number,
    categoryKeywords: ["electronic", "gadget", "appliance"],
  },
  {
    key: "vegetables-fruits",
    title: "Vegetables & fruits",
    asset: require("../../../assets/home-banner-vegetables-fruits.png") as number,
    categoryKeywords: ["vegetable", "fruit", "veggie"],
  },
];

/** A banner opens the first top category whose name matches it; with none, it only shows. */
function bannerCategoryAction(categories: HomeFeedDto["categories"], keywords: readonly string[]): HomeAction {
  const match = categories.find((category) => keywords.some((word) => category.name.toLowerCase().includes(word)));
  return match ? { type: "category", categoryId: match.id } : { type: "none" };
}

function bannerAction(banner: HomeFeedDto["banners"][number]): HomeAction {
  const value = banner.actionValue;
  if (!value) return { type: "none" };
  switch (banner.actionType) {
    case "CATEGORY":
      return { type: "category", categoryId: value };
    case "PRODUCT":
      return { type: "product", productId: value };
    case "COUPON":
      return { type: "coupon", code: value };
    default:
      return { type: "none" };
  }
}

/**
 * The carousel's slides. Banners configured on the backend (`feed.banners`)
 * win — that is where admin-managed banners belong. Until any exist, the
 * three designed banners bundled with the app are shown.
 */
export function buildPromoSlides(feed: HomeFeedDto): PromoSlide[] {
  if (feed.banners.length > 0) {
    return feed.banners.map((banner) => ({
      key: `banner:${banner.id}`,
      title: banner.title ?? "",
      subtitle: banner.subtitle,
      badge: null,
      visual: null,
      artworkUrl: banner.imageUrl,
      artworkAsset: null,
      // Admin banners carry their size, so the carousel shows them whole, uncropped.
      artworkAspectRatio: banner.imageWidth > 0 && banner.imageHeight > 0 ? banner.imageWidth / banner.imageHeight : null,
      ctaLabel: "Shop Now",
      action: bannerAction(banner),
    }));
  }

  return HOME_BANNERS.map((banner) => ({
    key: `home-banner:${banner.key}`,
    title: banner.title,
    subtitle: null,
    badge: null,
    visual: null,
    artworkUrl: null,
    artworkAsset: banner.asset,
    artworkAspectRatio: HOME_BANNER_ASPECT_RATIO,
    ctaLabel: "Shop Now",
    action: bannerCategoryAction(feed.categories, banner.categoryKeywords),
  }));
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
