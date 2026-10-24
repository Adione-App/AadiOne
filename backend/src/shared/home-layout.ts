/**
 * Home page layout — the admin's configuration of the customer Home page and
 * of the category placements (Admin Panel → Home Page Builder and Category
 * Display). It is ONE document, saved as a draft, previewed and published as
 * a whole (content_documents, key "home_layout"); customers only ever receive
 * the published copy.
 *
 * Everything in it is data, never code: colours are named presets or
 * #RRGGBB, sizes and counts are clamped to safe limits, sections are a fixed
 * set of kinds the app knows how to draw, and categories are referenced by
 * their path ("grocery", "grocery/rice") — the same merged categories the
 * catalogue shows, never a second copy of them.
 *
 * `resolveHomeLayout` is the ONE place defaults and clamping live. The
 * server stores its output, the Admin Panel preview and the app run it
 * again, and it never throws: a malformed, partial or older document still
 * yields a complete, sane layout. Sections the document does not mention are
 * appended in their default position, so a section kind added later shows up
 * without anyone editing the layout first.
 */

import type { ProductSummaryDto } from './dto';

/* -------------------------------------------------------------------------- */
/* Colours                                                                     */
/* -------------------------------------------------------------------------- */

/** Named colours an admin can pick without knowing any colour codes. */
export const CONTENT_COLOR_PRESETS = {
  none: 'transparent',
  white: '#FFFFFF',
  cream: '#FFF9EE',
  peach: '#FFE7D1',
  apricot: '#FFD9B8',
  yellow: '#FFF3C4',
  mint: '#E3F5EA',
  green: '#F1F9F3',
  sky: '#E6F1FF',
  lavender: '#EFEAFE',
  rose: '#FDECEF',
  grey: '#F8FAF9',
} as const;

export type ContentColorPreset = keyof typeof CONTENT_COLOR_PRESETS;

export const CONTENT_COLOR_PRESET_LABELS: Record<ContentColorPreset, string> = {
  none: 'None (transparent)',
  white: 'White',
  cream: 'Cream',
  peach: 'Peach',
  apricot: 'Apricot',
  yellow: 'Soft yellow',
  mint: 'Mint',
  green: 'Light green',
  sky: 'Sky blue',
  lavender: 'Lavender',
  rose: 'Rose',
  grey: 'Light grey',
};

/** #RRGGBB — the only free-form colour format accepted. */
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** A preset name or #RRGGBB as a colour value; anything else is `fallback`. */
export function contentColor(value: string | null | undefined, fallback = 'transparent'): string {
  if (!value) return fallback;
  if (HEX_COLOR_PATTERN.test(value)) return value.toUpperCase();
  return (CONTENT_COLOR_PRESETS as Record<string, string>)[value] ?? fallback;
}

const isColor = (value: unknown): value is string =>
  typeof value === 'string' && (HEX_COLOR_PATTERN.test(value) || value in CONTENT_COLOR_PRESETS);

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export const HOME_SPACING = ['compact', 'normal', 'relaxed'] as const;
export type HomeSpacing = (typeof HOME_SPACING)[number];
/** Vertical space (dp) for each spacing preset — the app and the preview use these numbers. */
export const HOME_SPACING_DP: Record<HomeSpacing, number> = { compact: 8, normal: 16, relaxed: 24 };

export const HOME_BACKGROUND_TYPES = ['solid', 'gradient', 'image'] as const;
export type HomeBackgroundType = (typeof HOME_BACKGROUND_TYPES)[number];
export const HOME_GRADIENT_DIRECTIONS = ['vertical', 'horizontal', 'diagonal'] as const;
export type HomeGradientDirection = (typeof HOME_GRADIENT_DIRECTIONS)[number];

/** The background behind the header, search bar, promotional area and top cards. */
export interface HomeBackgroundConfig {
  type: HomeBackgroundType;
  /** Solid colour, or the gradient's first colour (also the header's colour): a preset or #RRGGBB. */
  color: string;
  /** The gradient's last colour. */
  colorTo: string;
  direction: HomeGradientDirection;
  /** type "image": an image the server stored (Admin Panel upload); otherwise ignored. */
  imageUrl: string | null;
  /** A tint drawn over an image background, so text stays readable. */
  overlayColor: string;
  /** 0 – 0.6. */
  overlayOpacity: number;
}

export const HOME_OVERLAY_OPACITY_MAX = 0.6;

export const HOME_CARD_HEIGHT_LIMITS = { min: 88, max: 200 } as const;
export const HOME_CARD_COUNT_LIMITS = { min: 1, max: 4 } as const;
export const HOME_CARD_RADII = ['sm', 'md', 'lg'] as const;
export type HomeCardRadius = (typeof HOME_CARD_RADII)[number];
export const HOME_CARD_GAPS = ['tight', 'normal', 'wide'] as const;
export type HomeCardGap = (typeof HOME_CARD_GAPS)[number];
export const HOME_CARD_GAP_DP: Record<HomeCardGap, number> = { tight: 6, normal: 10, wide: 14 };

export interface HomeHeroConfig {
  background: HomeBackgroundConfig;
  /** Space inside the hero, around the promotional area and the cards. */
  padding: HomeSpacing;
  /** The promotional area between the search bar and the cards: the "home_top" banners. Nothing shows while none is live. */
  promo: { visible: boolean };
  /**
   * The top cards: the "home_cards" banners (Admin Panel → Banners), side by
   * side in one row. Each card's own image, title, subtitle, background and
   * destination are set on the banner; these are the row's shared settings.
   */
  cards: {
    visible: boolean;
    /** At most this many cards in the row (1 – 4; 3 by default). */
    maxItems: number;
    /** Card height in dp (88 – 200). */
    height: number;
    radius: HomeCardRadius;
    gap: HomeCardGap;
  };
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The Home sections an admin can order, hide and style, in their default
 * order. The header, search bar, promotional area and top cards (the hero)
 * always come first; the brand footer always comes last.
 */
export const HOME_SECTION_KEYS = [
  'top_categories',
  'food_carousel',
  'featured_shelves',
  'explore_subcategories',
  'more_shelves',
  'more_categories',
  'top_picks',
  'offers_rail',
  'offers',
  'recently_added',
  'previous_orders',
  'bottom_banner',
] as const;

export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

export interface HomeSectionInfo {
  label: string;
  hint: string;
  /** The admin can replace its heading (and subtitle). */
  titleEditable: boolean;
  /** The admin can set how many items it shows. */
  countLimits: { min: number; max: number; default: number } | null;
  /** The category placement whose list it shows, if any. */
  categoryPlacement: CategoryPlacementKey | null;
  /** The banner placement whose banners it shows, if any. */
  bannerPlacement: string | null;
}

export const HOME_SECTION_INFO: Record<HomeSectionKey, HomeSectionInfo> = {
  top_categories: {
    label: 'Shop by category',
    hint: 'The main category grid near the top.',
    titleEditable: true,
    countLimits: null,
    categoryPlacement: 'home_top',
    bannerPlacement: null,
  },
  food_carousel: {
    label: 'Food carousel',
    hint: 'Swipeable cards from the "Home — food carousel" banners. With none live, the standard food banner shows.',
    titleEditable: true,
    countLimits: { min: 1, max: 10, default: 3 },
    categoryPlacement: null,
    bannerPlacement: 'home_food',
  },
  featured_shelves: {
    label: 'Featured category shelves',
    hint: 'Product shelves of the categories placed first in "Home page category order" (Banners page).',
    titleEditable: false,
    countLimits: null,
    categoryPlacement: null,
    bannerPlacement: null,
  },
  explore_subcategories: {
    label: 'Explore subcategories',
    hint: 'A grid of subcategories, with the "Home — explore more categories" banners above it.',
    titleEditable: true,
    countLimits: null,
    categoryPlacement: 'home_explore',
    bannerPlacement: 'home_explore',
  },
  more_shelves: {
    label: 'Other category shelves',
    hint: 'Product shelves of every other category.',
    titleEditable: false,
    countLimits: null,
    categoryPlacement: null,
    bannerPlacement: null,
  },
  more_categories: {
    label: 'More categories',
    hint: 'A grid of the categories not shown above.',
    titleEditable: true,
    countLimits: null,
    categoryPlacement: 'home_more',
    bannerPlacement: null,
  },
  top_picks: { label: 'Top picks', hint: 'Best-selling products.', titleEditable: true, countLimits: null, categoryPlacement: null, bannerPlacement: null },
  offers_rail: { label: 'Products on offer', hint: 'Discounted products.', titleEditable: true, countLimits: null, categoryPlacement: null, bannerPlacement: null },
  offers: { label: 'Offers and coupons', hint: 'Live coupons and offers.', titleEditable: false, countLimits: null, categoryPlacement: null, bannerPlacement: null },
  recently_added: {
    label: 'Latest products',
    hint: 'The newest products customers can buy right now, newest first — never best-sellers or random picks.',
    titleEditable: true,
    countLimits: { min: 4, max: 20, default: 10 },
    categoryPlacement: null,
    bannerPlacement: null,
  },
  previous_orders: {
    label: 'Previous orders',
    hint: 'A signed-in customer\'s earlier purchases.',
    titleEditable: true,
    countLimits: null,
    categoryPlacement: null,
    bannerPlacement: null,
  },
  bottom_banner: {
    label: 'Final banner',
    hint: 'The "Home — final banner (bottom)" banners.',
    titleEditable: false,
    countLimits: null,
    categoryPlacement: null,
    bannerPlacement: 'home_bottom',
  },
};

export const HOME_TEXT_LIMITS = { title: 60, subtitle: 120 } as const;

/* -------------------------------------------------------------------------- */
/* Repeatable sections — product shelves and category sections                 */
/* -------------------------------------------------------------------------- */

/**
 * Sections an admin ADDS (any number, each with its own id and settings), on
 * top of the built-in ones above that exist exactly once. An app that does
 * not know a kind skips it (resolveSections), so adding a kind never breaks
 * an older app — it just does not show that section.
 */
export const HOME_REPEATABLE_SECTION_KINDS = ['product_shelf', 'category_section'] as const;
export type HomeRepeatableSectionKind = (typeof HOME_REPEATABLE_SECTION_KINDS)[number];

/** The registry: every section type the layout accepts. Anything else is refused (admin) or skipped (app). */
export const HOME_SECTION_TYPES = [...HOME_SECTION_KEYS, ...HOME_REPEATABLE_SECTION_KINDS] as const;
export type HomeSectionType = (typeof HOME_SECTION_TYPES)[number];

export const isBuiltInSectionKey = (value: unknown): value is HomeSectionKey => HOME_SECTION_KEYS.includes(value as HomeSectionKey);
export const isRepeatableSectionKind = (value: unknown): value is HomeRepeatableSectionKind =>
  HOME_REPEATABLE_SECTION_KINDS.includes(value as HomeRepeatableSectionKind);

export const HOME_REPEATABLE_SECTION_INFO: Record<HomeRepeatableSectionKind, HomeSectionInfo> = {
  product_shelf: {
    label: 'Product shelf',
    hint: 'Products from the categories you choose — random (changes daily), latest, best-selling, or picked by hand — as a scrolling row or a grid.',
    titleEditable: true,
    countLimits: null,
    categoryPlacement: null,
    bannerPlacement: null,
  },
  category_section: {
    label: 'Category section',
    hint: 'A grid or row of categories and/or subcategories you choose (or picked automatically), with its own style.',
    titleEditable: true,
    countLimits: null,
    categoryPlacement: null,
    bannerPlacement: null,
  },
};

/** Label, hint and editable parts of any section type. */
export function homeSectionInfo(key: HomeSectionType): HomeSectionInfo {
  return isRepeatableSectionKind(key) ? HOME_REPEATABLE_SECTION_INFO[key] : HOME_SECTION_INFO[key];
}

/** At most this many added sections on one Home page. */
export const HOME_CUSTOM_SECTION_MAX = 30;
/**
 * A section's stable id: built-in sections use their key; an added section
 * gets a generated one ("shelf-k3v9q2"). Never an index or a title, so
 * reordering, renaming and duplicating keep every section's identity.
 */
export const HOME_SECTION_ID_PATTERN = /^[a-z][a-z0-9_-]{2,39}$/;
/** A product id (UUID). */
export const PRODUCT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a shelf's products come from. */
export const PRODUCT_SHELF_SOURCES = ['random', 'latest', 'bestselling', 'manual'] as const;
export type ProductShelfSource = (typeof PRODUCT_SHELF_SOURCES)[number];

export const PRODUCT_SHELF_SOURCE_INFO: Record<ProductShelfSource, { label: string; hint: string }> = {
  random: {
    label: 'Random',
    hint: 'A random mix from the chosen categories. It stays the same all day (no reshuffling on every visit) and changes the next day.',
  },
  latest: { label: 'Latest', hint: 'The newest products from the chosen categories, newest first.' },
  bestselling: {
    label: 'Best-selling',
    hint: 'Ranked by quantity actually delivered to customers (the same measure as "Top picks"); products without sales follow in a fixed order.',
  },
  manual: { label: 'Picked by hand', hint: 'The products you choose, in your order. Optionally topped up with the latest products from the chosen categories.' },
};

export const PRODUCT_SHELF_COUNT_LIMITS = { min: 1, max: 30 } as const;
export const PRODUCT_SHELF_COUNT_PRESETS = [4, 6, 8, 10, 15, 20] as const;
/** Categories one shelf may draw from. */
export const PRODUCT_SHELF_SCOPE_MAX = 10;
/** Products one shelf may list by hand. */
export const PRODUCT_SHELF_PICK_MAX = 40;

export const PRODUCT_SHELF_LAYOUTS = ['carousel', 'grid'] as const;
export type ProductShelfLayout = (typeof PRODUCT_SHELF_LAYOUTS)[number];
export const PRODUCT_SHELF_COLUMNS = [2, 3] as const;
export type ProductShelfColumns = (typeof PRODUCT_SHELF_COLUMNS)[number];
export const PRODUCT_SHELF_CARD_SIZES = ['compact', 'regular', 'large'] as const;
export type ProductShelfCardSize = (typeof PRODUCT_SHELF_CARD_SIZES)[number];
/** A carousel card's width (dp) per size — "regular" is the width Home has always used. */
export const PRODUCT_SHELF_CARD_WIDTH_DP: Record<ProductShelfCardSize, number> = { compact: 116, regular: 132, large: 152 };
export const PRODUCT_SHELF_GAPS = ['tight', 'normal', 'wide'] as const;
export type ProductShelfGap = (typeof PRODUCT_SHELF_GAPS)[number];
export const PRODUCT_SHELF_GAP_DP: Record<ProductShelfGap, number> = { tight: 6, normal: 8, wide: 12 };
/** A grid card never gets narrower than this; a 3-column grid on a narrow phone becomes 2 columns. */
export const PRODUCT_SHELF_MIN_GRID_CARD_DP = 104;

/**
 * Where a shelf's "View All" goes:
 *   none         no View All
 *   category     that category's listing — it must contain the whole shelf
 *   latest       the newest-products listing (latest shelves of the whole catalogue)
 *   bestselling  the "Top picks" listing (best-selling shelves of the whole catalogue)
 */
export const PRODUCT_SHELF_VIEW_ALL_TYPES = ['none', 'category', 'latest', 'bestselling'] as const;
export type ProductShelfViewAllType = (typeof PRODUCT_SHELF_VIEW_ALL_TYPES)[number];

export interface ProductShelfConfig {
  source: ProductShelfSource;
  /** Category paths the products come from ("grocery", "grocery/rice"); empty = the whole catalogue. */
  categoryPaths: string[];
  /** source "manual": the chosen product ids, in order. */
  productIds: string[];
  /** source "manual": fill the rest of `count` with the latest products from `categoryPaths`. */
  fillFromScope: boolean;
  /** At most this many products (fewer when fewer qualify; never padded). */
  count: number;
  layout: ProductShelfLayout;
  /** Grid only: products per row. */
  columns: ProductShelfColumns;
  /** Carousel only: card width. */
  cardSize: ProductShelfCardSize;
  gap: ProductShelfGap;
  viewAll: { type: ProductShelfViewAllType; /** type "category": its path. */ path: string | null };
}

export const DEFAULT_PRODUCT_SHELF: ProductShelfConfig = {
  source: 'latest',
  categoryPaths: [],
  productIds: [],
  fillFromScope: false,
  count: 10,
  layout: 'carousel',
  columns: 2,
  cardSize: 'regular',
  gap: 'normal',
  viewAll: { type: 'none', path: null },
};

/** A category section: a placement of its own (same settings as Category Management's), plus what "automatic" picks. */
export interface HomeCategorySectionConfig extends CategoryPlacementConfig {
  /** Automatic mode: top categories, subcategories (taking turns between parents) or both. */
  level: 'top' | 'sub' | 'any';
  /** The tiles' text colour (a category's own colour wins); null = the standard dark text. */
  textColor: 'dark' | 'light' | null;
}

export const DEFAULT_CATEGORY_SECTION: HomeCategorySectionConfig = {
  mode: 'manual',
  paths: [],
  maxItems: 8,
  columns: 4,
  rows: null,
  layout: 'grid',
  showViewAll: false,
  tileShape: 'rounded',
  imageFit: 'contain',
  tileBackground: 'green',
  level: 'top',
  textColor: null,
};

/**
 * Why a shelf's View All cannot be used, or null when it can. The SAME rule
 * refuses publishing (server), explains itself in the builder and hides the
 * button in the app, so customers are never sent to an unrelated listing.
 */
export function productShelfViewAllProblem(shelf: ProductShelfConfig): string | null {
  const { viewAll, categoryPaths, source } = shelf;
  if (viewAll.type === 'none') return null;
  if (viewAll.type === 'category') {
    const path = viewAll.path;
    if (!path || !CATEGORY_PATH_PATTERN.test(path)) return 'Choose the category "View All" opens.';
    if (categoryPaths.length === 0) return '"View All" can open a category only when the shelf takes its products from categories.';
    const inside = categoryPaths.every((scope) => scope === path || scope.startsWith(`${path}/`));
    return inside ? null : '"View All" must open the shelf\'s own category (or the main category that contains all of its categories).';
  }
  const wanted = viewAll.type === 'latest' ? 'latest' : 'bestselling';
  if (source !== wanted || categoryPaths.length > 0) {
    return `"View All — ${viewAll.type === 'latest' ? 'latest products' : 'best-selling products'}" fits only a ${wanted === 'latest' ? 'Latest' : 'Best-selling'} shelf of the whole catalogue (no categories chosen).`;
  }
  return null;
}

/** The View All destinations that fit a shelf, best first — what the builder offers. */
export function productShelfViewAllOptions(shelf: ProductShelfConfig): ProductShelfConfig['viewAll'][] {
  const options: ProductShelfConfig['viewAll'][] = [];
  const paths = shelf.categoryPaths;
  if (paths.length > 0) {
    // The shelf's own category, or the main category containing all of them.
    const tops = new Set(paths.map((path) => path.split('/')[0]!));
    if (paths.length === 1) options.push({ type: 'category', path: paths[0]! });
    if (tops.size === 1) {
      const top = [...tops][0]!;
      if (!options.some((option) => option.path === top)) options.push({ type: 'category', path: top });
    }
  } else if (shelf.source === 'latest') options.push({ type: 'latest', path: null });
  else if (shelf.source === 'bestselling') options.push({ type: 'bestselling', path: null });
  return options;
}

export interface HomeSectionConfig {
  /** Stable identity: the key for a built-in section, a generated id for an added one. */
  id: string;
  /** The section's type (HOME_SECTION_TYPES). */
  key: HomeSectionType;
  visible: boolean;
  /** Replaces the section's own heading (titleEditable sections only); null = the default heading. */
  title: string | null;
  subtitle: string | null;
  /** Behind the whole section: a preset or #RRGGBB ("none" = the page's own background). */
  background: string;
  /** Space above and below the section. */
  spacing: HomeSpacing;
  /** How many items it shows (sections with countLimits only); null = its default. */
  maxItems: number | null;
  /** product_shelf only: its products and presentation; null for every other type. */
  shelf: ProductShelfConfig | null;
  /** category_section only: its categories and presentation; null for every other type. */
  categories: HomeCategorySectionConfig | null;
}

/* -------------------------------------------------------------------------- */
/* Category placements and category display                                    */
/* -------------------------------------------------------------------------- */

/** Every place categories are listed, each configured on its own. */
export const CATEGORY_PLACEMENT_KEYS = ['home_top', 'home_explore', 'home_more', 'categories_page'] as const;
export type CategoryPlacementKey = (typeof CATEGORY_PLACEMENT_KEYS)[number];

export interface CategoryPlacementInfo {
  label: string;
  hint: string;
  /** Which categories it lists: top-level ones or subcategories. */
  level: 'top' | 'sub' | 'any';
  defaults: Omit<CategoryPlacementConfig, 'paths'>;
}

export const CATEGORY_TILE_SHAPES = ['rounded', 'circle', 'square'] as const;
export type CategoryTileShape = (typeof CATEGORY_TILE_SHAPES)[number];
export const CATEGORY_COLUMN_LIMITS = { min: 3, max: 6 } as const;
export const CATEGORY_COUNT_LIMITS = { min: 1, max: 60 } as const;
export const CATEGORY_ROW_LIMITS = { min: 1, max: 10 } as const;

export interface CategoryPlacementConfig {
  /** auto = every live category in the catalogue's order; manual = only `paths`, in that order. */
  mode: 'auto' | 'manual';
  /** Category paths for manual mode ("grocery", "grocery/rice"). Paths no longer live are skipped. */
  paths: string[];
  /** At most this many categories (1 – 60). */
  maxItems: number;
  /** Tiles per row (3 – 6); null = as many as fit the screen. */
  columns: number | null;
  /** Visible rows; null = no limit (only maxItems). */
  rows: number | null;
  layout: 'grid' | 'row';
  showViewAll: boolean;
  tileShape: CategoryTileShape;
  imageFit: 'cover' | 'contain';
  /** Behind each tile's image: a preset or #RRGGBB. */
  tileBackground: string;
}

export const CATEGORY_PLACEMENT_INFO: Record<CategoryPlacementKey, CategoryPlacementInfo> = {
  home_top: {
    label: 'Home — shop by category',
    hint: 'The main category grid near the top of Home.',
    level: 'top',
    defaults: { mode: 'auto', maxItems: 8, columns: 4, rows: null, layout: 'grid', showViewAll: true, tileShape: 'rounded', imageFit: 'contain', tileBackground: 'green' },
  },
  home_explore: {
    label: 'Home — explore subcategories',
    hint: 'Subcategories from across the catalogue, taking turns between their parents.',
    level: 'sub',
    defaults: { mode: 'auto', maxItems: 10, columns: 5, rows: null, layout: 'grid', showViewAll: true, tileShape: 'rounded', imageFit: 'contain', tileBackground: 'green' },
  },
  home_more: {
    label: 'Home — more categories',
    hint: 'Categories and subcategories not already shown higher up.',
    level: 'any',
    defaults: { mode: 'auto', maxItems: 12, columns: 4, rows: null, layout: 'grid', showViewAll: true, tileShape: 'rounded', imageFit: 'contain', tileBackground: 'green' },
  },
  categories_page: {
    label: 'Categories page — main categories',
    hint: 'The main grid of the Categories tab.',
    level: 'top',
    defaults: { mode: 'auto', maxItems: 60, columns: null, rows: null, layout: 'grid', showViewAll: false, tileShape: 'rounded', imageFit: 'contain', tileBackground: 'green' },
  },
};

export const CATEGORY_NAME_MAX = 60;

/** How one category is presented everywhere it is listed — its data stays the sellers' own. */
export interface CategoryStyleConfig {
  /** "grocery" or "grocery/rice". */
  path: string;
  /** Shown instead of the category's name; null = its own name. */
  displayName: string | null;
  displayNameHi: string | null;
  /** Behind the tile's image: a preset or #RRGGBB; null = the placement's colour. */
  tileBackground: string | null;
  /** The tile's text colour. */
  textColor: 'dark' | 'light' | null;
  /** Hidden from every Home and Categories-page placement (the category itself stays live in search and listings). */
  hidden: boolean;
}

export const CATEGORY_STYLE_MAX = 500;

/** A category's path: lowercase slugs, at most one "/" (top or subcategory). */
export const CATEGORY_PATH_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export interface HomeLayoutContent {
  schema: 1;
  hero: HomeHeroConfig;
  /** Every section, in Home order. */
  sections: HomeSectionConfig[];
  categoryPlacements: Record<CategoryPlacementKey, CategoryPlacementConfig>;
  categoryStyles: CategoryStyleConfig[];
}

/** GET /content/home-layout — the published layout (or the defaults when nothing is published yet). */
export interface HomeLayoutDto {
  /** 0 = nothing published yet (the defaults). */
  revision: number;
  publishedAt: string | null;
  layout: HomeLayoutContent;
}

/** One published (or archived) revision, as the Admin Panel lists it. */
export interface HomeLayoutRevisionDto {
  id: string;
  revision: number;
  publishedAt: string | null;
  publishedBy: string | null;
}

/** GET /admin/content/home-layout — everything the builder needs. */
export interface AdminHomeLayoutDto {
  published: (HomeLayoutRevisionDto & { layout: HomeLayoutContent }) | null;
  /** The unpublished draft; null = none (editing starts from the published layout). */
  draft: {
    /** The published revision this draft started from (0 = the defaults). */
    basedOnRevision: number;
    updatedAt: string;
    updatedBy: string | null;
    layout: HomeLayoutContent;
  } | null;
  /** Earlier published revisions, newest first (restorable into the draft). */
  history: HomeLayoutRevisionDto[];
}

export const DEFAULT_HOME_SECTION: Omit<HomeSectionConfig, 'key' | 'id'> = {
  visible: true,
  title: null,
  subtitle: null,
  background: 'none',
  spacing: 'normal',
  maxItems: null,
  shelf: null,
  categories: null,
};

/** The layout before an admin publishes anything: today's Home, with the warm top background. */
export const DEFAULT_HOME_LAYOUT: HomeLayoutContent = {
  schema: 1,
  hero: {
    background: {
      type: 'gradient',
      color: '#FFF4D6',
      colorTo: '#FFE3CC',
      direction: 'vertical',
      imageUrl: null,
      overlayColor: '#FFFFFF',
      overlayOpacity: 0,
    },
    padding: 'normal',
    promo: { visible: true },
    cards: { visible: true, maxItems: 3, height: 128, radius: 'lg', gap: 'normal' },
  },
  sections: HOME_SECTION_KEYS.map((key) => ({ id: key, key, ...DEFAULT_HOME_SECTION })),
  categoryPlacements: Object.fromEntries(
    CATEGORY_PLACEMENT_KEYS.map((key) => [key, { ...CATEGORY_PLACEMENT_INFO[key].defaults, paths: [] }]),
  ) as unknown as Record<CategoryPlacementKey, CategoryPlacementConfig>,
  categoryStyles: [],
};

/* -------------------------------------------------------------------------- */
/* resolveHomeLayout — defaults, clamping, never throws                         */
/* -------------------------------------------------------------------------- */

type Loose = Record<string, unknown>;
const obj = (value: unknown): Loose => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {});
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const color = (value: unknown, fallback: string) => (isColor(value) ? value : fallback);
const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const optionalInt = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null;
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

function resolveBackground(raw: unknown): HomeBackgroundConfig {
  const value = obj(raw);
  const base = DEFAULT_HOME_LAYOUT.hero.background;
  const imageUrl = typeof value['imageUrl'] === 'string' && /^https?:\/\//.test(value['imageUrl']) ? value['imageUrl'].slice(0, 500) : null;
  const type = pick(value['type'], HOME_BACKGROUND_TYPES, base.type);
  return {
    // An image background without an image falls back to a gradient.
    type: type === 'image' && !imageUrl ? 'gradient' : type,
    color: color(value['color'], base.color),
    colorTo: color(value['colorTo'], base.colorTo),
    direction: pick(value['direction'], HOME_GRADIENT_DIRECTIONS, base.direction),
    imageUrl,
    overlayColor: color(value['overlayColor'], base.overlayColor),
    overlayOpacity:
      typeof value['overlayOpacity'] === 'number' && Number.isFinite(value['overlayOpacity'])
        ? Math.round(Math.min(HOME_OVERLAY_OPACITY_MAX, Math.max(0, value['overlayOpacity'])) * 100) / 100
        : base.overlayOpacity,
  };
}

function resolveHero(raw: unknown): HomeHeroConfig {
  const value = obj(raw);
  const base = DEFAULT_HOME_LAYOUT.hero;
  const cards = obj(value['cards']);
  return {
    background: resolveBackground(value['background']),
    padding: pick(value['padding'], HOME_SPACING, base.padding),
    promo: { visible: bool(obj(value['promo'])['visible'], base.promo.visible) },
    cards: {
      visible: bool(cards['visible'], base.cards.visible),
      maxItems: clampInt(cards['maxItems'], HOME_CARD_COUNT_LIMITS.min, HOME_CARD_COUNT_LIMITS.max, base.cards.maxItems),
      height: clampInt(cards['height'], HOME_CARD_HEIGHT_LIMITS.min, HOME_CARD_HEIGHT_LIMITS.max, base.cards.height),
      radius: pick(cards['radius'], HOME_CARD_RADII, base.cards.radius),
      gap: pick(cards['gap'], HOME_CARD_GAPS, base.cards.gap),
    },
  };
}

/** A list of distinct strings matching `pattern`, at most `max` (anything else is dropped). */
function stringList(raw: unknown, pattern: RegExp, max: number, normalise: (value: string) => string = (value) => value): string[] {
  const list: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'string' || !pattern.test(entry)) continue;
    const value = normalise(entry);
    if (!list.includes(value)) list.push(value);
    if (list.length >= max) break;
  }
  return list;
}

function resolveShelf(raw: unknown): ProductShelfConfig {
  const value = obj(raw);
  const base = DEFAULT_PRODUCT_SHELF;
  const viewAll = obj(value['viewAll']);
  const viewAllType = pick(viewAll['type'], PRODUCT_SHELF_VIEW_ALL_TYPES, base.viewAll.type);
  const viewAllPath = typeof viewAll['path'] === 'string' && CATEGORY_PATH_PATTERN.test(viewAll['path']) ? viewAll['path'] : null;
  return {
    source: pick(value['source'], PRODUCT_SHELF_SOURCES, base.source),
    categoryPaths: stringList(value['categoryPaths'], CATEGORY_PATH_PATTERN, PRODUCT_SHELF_SCOPE_MAX),
    productIds: stringList(value['productIds'], PRODUCT_ID_PATTERN, PRODUCT_SHELF_PICK_MAX, (id) => id.toLowerCase()),
    fillFromScope: bool(value['fillFromScope'], base.fillFromScope),
    count: clampInt(value['count'], PRODUCT_SHELF_COUNT_LIMITS.min, PRODUCT_SHELF_COUNT_LIMITS.max, base.count),
    layout: pick(value['layout'], PRODUCT_SHELF_LAYOUTS, base.layout),
    columns: value['columns'] === 3 ? 3 : 2,
    cardSize: pick(value['cardSize'], PRODUCT_SHELF_CARD_SIZES, base.cardSize),
    gap: pick(value['gap'], PRODUCT_SHELF_GAPS, base.gap),
    viewAll: viewAllType === 'category' ? { type: 'category', path: viewAllPath } : { type: viewAllType, path: null },
  };
}

function resolveCategorySection(raw: unknown): HomeCategorySectionConfig {
  const value = obj(raw);
  const base = DEFAULT_CATEGORY_SECTION;
  return {
    mode: pick(value['mode'], ['auto', 'manual'] as const, base.mode),
    paths: stringList(value['paths'], CATEGORY_PATH_PATTERN, CATEGORY_COUNT_LIMITS.max),
    maxItems: clampInt(value['maxItems'], CATEGORY_COUNT_LIMITS.min, CATEGORY_COUNT_LIMITS.max, base.maxItems),
    columns: value['columns'] === null ? null : optionalInt(value['columns'], CATEGORY_COLUMN_LIMITS.min, CATEGORY_COLUMN_LIMITS.max) ?? base.columns,
    rows: optionalInt(value['rows'], CATEGORY_ROW_LIMITS.min, CATEGORY_ROW_LIMITS.max),
    layout: pick(value['layout'], ['grid', 'row'] as const, base.layout),
    showViewAll: bool(value['showViewAll'], base.showViewAll),
    tileShape: pick(value['tileShape'], CATEGORY_TILE_SHAPES, base.tileShape),
    imageFit: pick(value['imageFit'], ['cover', 'contain'] as const, base.imageFit),
    tileBackground: color(value['tileBackground'], base.tileBackground),
    level: pick(value['level'], ['top', 'sub', 'any'] as const, base.level),
    textColor: value['textColor'] === 'dark' || value['textColor'] === 'light' ? value['textColor'] : null,
  };
}

function resolveSection(raw: Loose, key: HomeSectionType, id: string): HomeSectionConfig {
  const info = homeSectionInfo(key);
  return {
    id,
    key,
    visible: bool(raw['visible'], DEFAULT_HOME_SECTION.visible),
    title: info.titleEditable ? text(raw['title'], HOME_TEXT_LIMITS.title) : null,
    subtitle: info.titleEditable ? text(raw['subtitle'], HOME_TEXT_LIMITS.subtitle) : null,
    background: color(raw['background'], DEFAULT_HOME_SECTION.background),
    spacing: pick(raw['spacing'], HOME_SPACING, DEFAULT_HOME_SECTION.spacing),
    maxItems: info.countLimits ? optionalInt(raw['maxItems'], info.countLimits.min, info.countLimits.max) : null,
    shelf: key === 'product_shelf' ? resolveShelf(raw['shelf']) : null,
    categories: key === 'category_section' ? resolveCategorySection(raw['categories']) : null,
  };
}

/**
 * Listed sections first, in their order: built-in ones once each (id = key),
 * added ones with a valid id not used before (at most HOME_CUSTOM_SECTION_MAX);
 * an unknown type or a broken entry is skipped. Then any missing built-in
 * section at its default position.
 */
function resolveSections(raw: unknown): HomeSectionConfig[] {
  const listed: HomeSectionConfig[] = [];
  const seen = new Set<string>();
  let added = 0;
  for (const entry of Array.isArray(raw) ? raw : []) {
    const value = obj(entry);
    const key = value['key'];
    if (isBuiltInSectionKey(key)) {
      if (seen.has(key)) continue;
      seen.add(key);
      listed.push(resolveSection(value, key, key));
    } else if (isRepeatableSectionKind(key)) {
      const id = value['id'];
      if (typeof id !== 'string' || !HOME_SECTION_ID_PATTERN.test(id) || isBuiltInSectionKey(id) || seen.has(id)) continue;
      if (added >= HOME_CUSTOM_SECTION_MAX) continue;
      seen.add(id);
      added += 1;
      listed.push(resolveSection(value, key, id));
    }
  }
  // A missing section goes right after the nearest section before it in the default order.
  for (const [index, key] of HOME_SECTION_KEYS.entries()) {
    if (seen.has(key)) continue;
    const before = HOME_SECTION_KEYS.slice(0, index).reverse().find((candidate) => seen.has(candidate));
    const at = before ? listed.findIndex((section) => section.id === before) + 1 : 0;
    listed.splice(at, 0, { id: key, key, ...DEFAULT_HOME_SECTION });
    seen.add(key);
  }
  return listed;
}

function resolvePlacement(raw: unknown, key: CategoryPlacementKey): CategoryPlacementConfig {
  const value = obj(raw);
  const base = CATEGORY_PLACEMENT_INFO[key].defaults;
  const paths: string[] = [];
  for (const path of Array.isArray(value['paths']) ? value['paths'] : []) {
    if (typeof path === 'string' && CATEGORY_PATH_PATTERN.test(path) && !paths.includes(path) && paths.length < CATEGORY_COUNT_LIMITS.max) {
      paths.push(path);
    }
  }
  return {
    mode: pick(value['mode'], ['auto', 'manual'] as const, base.mode),
    paths,
    maxItems: clampInt(value['maxItems'], CATEGORY_COUNT_LIMITS.min, CATEGORY_COUNT_LIMITS.max, base.maxItems),
    columns: value['columns'] === null ? null : optionalInt(value['columns'], CATEGORY_COLUMN_LIMITS.min, CATEGORY_COLUMN_LIMITS.max) ?? base.columns,
    rows: optionalInt(value['rows'], CATEGORY_ROW_LIMITS.min, CATEGORY_ROW_LIMITS.max),
    layout: pick(value['layout'], ['grid', 'row'] as const, base.layout),
    showViewAll: bool(value['showViewAll'], base.showViewAll),
    tileShape: pick(value['tileShape'], CATEGORY_TILE_SHAPES, base.tileShape),
    imageFit: pick(value['imageFit'], ['cover', 'contain'] as const, base.imageFit),
    tileBackground: color(value['tileBackground'], base.tileBackground),
  };
}

function resolveStyles(raw: unknown): CategoryStyleConfig[] {
  const styles: CategoryStyleConfig[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const value = obj(entry);
    const path = value['path'];
    if (typeof path !== 'string' || !CATEGORY_PATH_PATTERN.test(path) || seen.has(path)) continue;
    seen.add(path);
    const style: CategoryStyleConfig = {
      path,
      displayName: text(value['displayName'], CATEGORY_NAME_MAX),
      displayNameHi: text(value['displayNameHi'], CATEGORY_NAME_MAX),
      tileBackground: isColor(value['tileBackground']) ? value['tileBackground'] : null,
      textColor: value['textColor'] === 'dark' || value['textColor'] === 'light' ? value['textColor'] : null,
      hidden: bool(value['hidden'], false),
    };
    // A style that changes nothing is not kept.
    if (style.displayName || style.displayNameHi || style.tileBackground || style.textColor || style.hidden) styles.push(style);
    if (styles.length >= CATEGORY_STYLE_MAX) break;
  }
  return styles;
}

/** Any stored or received layout → a complete one within every limit. Never throws. */
export function resolveHomeLayout(raw: unknown): HomeLayoutContent {
  const value = obj(raw);
  const placements = obj(value['categoryPlacements']);
  return {
    schema: 1,
    hero: resolveHero(value['hero']),
    sections: resolveSections(value['sections']),
    categoryPlacements: Object.fromEntries(
      CATEGORY_PLACEMENT_KEYS.map((key) => [key, resolvePlacement(placements[key], key)]),
    ) as unknown as Record<CategoryPlacementKey, CategoryPlacementConfig>,
    categoryStyles: resolveStyles(value['categoryStyles']),
  };
}

/**
 * GET /admin/content/category-options — the marketplace's live categories,
 * merged by path exactly as customers see them (each path once, represented
 * by its earliest row), for the category pickers and Category Display.
 */
export interface AdminCategoryOptionDto {
  /** The representative row — what category images and banner targets use. */
  id: string;
  path: string;
  parentPath: string | null;
  depth: number;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  /** Live sellers that have this category. */
  sellerCount: number;
  /** Live, approved products under it (for a top category, including its subcategories). */
  productCount: number;
}

/**
 * GET /content/home-shelves — the products of every product shelf of the
 * PUBLISHED layout, resolved live (current prices, stock and sellers; never
 * stored in the layout). Keyed by section id; a shelf with nothing to show
 * right now is an empty list, and the app leaves it out.
 */
export interface HomeShelvesDto {
  /** The published revision these shelves belong to (0 = the defaults). */
  revision: number;
  shelves: Record<string, ProductSummaryDto[]>;
}

/** GET /admin/content/product-options — one product in the builder's product picker. */
export interface AdminProductOptionDto {
  id: string;
  name: string;
  imageUrl: string | null;
  /** "grocery/rice" and how it reads: "Grocery › Rice". */
  categoryPath: string;
  categoryLabel: string;
  brandName: string | null;
  /** Lowest price / its MRP among the live listings; null when none is listed right now. */
  pricePaise: number | null;
  mrpPaise: number | null;
  variantCount: number;
  sellerCount: number;
  /** Customers can buy it right now (approved, listed by a live seller, in stock). */
  available: boolean;
}

export interface AdminProductOptionsPage {
  items: AdminProductOptionDto[];
  /** Pass back as `cursor` for the next page; null = no more. */
  nextCursor: string | null;
}

/** The visible categories of a placement: `maxItems`, further limited to `rows` × columns when both are set. */
export function categoryPlacementLimit(config: CategoryPlacementConfig, columns: number): number {
  return config.rows !== null ? Math.min(config.maxItems, config.rows * Math.max(1, columns)) : config.maxItems;
}

/** "grocery" for a top category, "grocery/rice" for a subcategory — how layouts reference categories. */
export function categoryPath(category: { slug: string }, parent?: { slug: string } | null): string {
  return parent ? `${parent.slug}/${category.slug}` : category.slug;
}
