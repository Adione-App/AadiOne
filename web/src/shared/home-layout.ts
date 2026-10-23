/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

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
  recently_added: { label: 'Recently added', hint: 'Newest products.', titleEditable: true, countLimits: null, categoryPlacement: null, bannerPlacement: null },
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

export interface HomeSectionConfig {
  key: HomeSectionKey;
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
    defaults: { mode: 'auto', maxItems: 8, columns: 4, rows: null, layout: 'grid', showViewAll: true, tileShape: 'rounded', imageFit: 'cover', tileBackground: 'green' },
  },
  home_explore: {
    label: 'Home — explore subcategories',
    hint: 'Subcategories from across the catalogue, taking turns between their parents.',
    level: 'sub',
    defaults: { mode: 'auto', maxItems: 10, columns: 5, rows: null, layout: 'grid', showViewAll: true, tileShape: 'rounded', imageFit: 'cover', tileBackground: 'green' },
  },
  home_more: {
    label: 'Home — more categories',
    hint: 'Categories and subcategories not already shown higher up.',
    level: 'any',
    defaults: { mode: 'auto', maxItems: 12, columns: 4, rows: null, layout: 'grid', showViewAll: true, tileShape: 'rounded', imageFit: 'cover', tileBackground: 'green' },
  },
  categories_page: {
    label: 'Categories page — main categories',
    hint: 'The main grid of the Categories tab.',
    level: 'top',
    defaults: { mode: 'auto', maxItems: 60, columns: null, rows: null, layout: 'grid', showViewAll: false, tileShape: 'rounded', imageFit: 'cover', tileBackground: 'green' },
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

export const DEFAULT_HOME_SECTION: Omit<HomeSectionConfig, 'key'> = {
  visible: true,
  title: null,
  subtitle: null,
  background: 'none',
  spacing: 'normal',
  maxItems: null,
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
  sections: HOME_SECTION_KEYS.map((key) => ({ key, ...DEFAULT_HOME_SECTION })),
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

function resolveSection(raw: Loose, key: HomeSectionKey): HomeSectionConfig {
  const info = HOME_SECTION_INFO[key];
  return {
    key,
    visible: bool(raw['visible'], DEFAULT_HOME_SECTION.visible),
    title: info.titleEditable ? text(raw['title'], HOME_TEXT_LIMITS.title) : null,
    subtitle: info.titleEditable ? text(raw['subtitle'], HOME_TEXT_LIMITS.subtitle) : null,
    background: color(raw['background'], DEFAULT_HOME_SECTION.background),
    spacing: pick(raw['spacing'], HOME_SPACING, DEFAULT_HOME_SECTION.spacing),
    maxItems: info.countLimits ? optionalInt(raw['maxItems'], info.countLimits.min, info.countLimits.max) : null,
  };
}

/** Listed sections first (known kinds, each once), then any missing ones at their default position. */
function resolveSections(raw: unknown): HomeSectionConfig[] {
  const listed: HomeSectionConfig[] = [];
  const seen = new Set<HomeSectionKey>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const value = obj(entry);
    const key = value['key'];
    if (!HOME_SECTION_KEYS.includes(key as HomeSectionKey) || seen.has(key as HomeSectionKey)) continue;
    seen.add(key as HomeSectionKey);
    listed.push(resolveSection(value, key as HomeSectionKey));
  }
  // A missing section goes right after the nearest section before it in the default order.
  for (const [index, key] of HOME_SECTION_KEYS.entries()) {
    if (seen.has(key)) continue;
    const before = HOME_SECTION_KEYS.slice(0, index).reverse().find((candidate) => seen.has(candidate));
    const at = before ? listed.findIndex((section) => section.key === before) + 1 : 0;
    listed.splice(at, 0, { key, ...DEFAULT_HOME_SECTION });
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

/** The visible categories of a placement: `maxItems`, further limited to `rows` × columns when both are set. */
export function categoryPlacementLimit(config: CategoryPlacementConfig, columns: number): number {
  return config.rows !== null ? Math.min(config.maxItems, config.rows * Math.max(1, columns)) : config.maxItems;
}

/** "grocery" for a top category, "grocery/rice" for a subcategory — how layouts reference categories. */
export function categoryPath(category: { slug: string }, parent?: { slug: string } | null): string {
  return parent ? `${parent.slug}/${category.slug}` : category.slug;
}
