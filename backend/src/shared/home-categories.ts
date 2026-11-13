/**
 * Home page main categories — which TOP-LEVEL categories the customer Home
 * page shows, in what order, and which of them get their product shelf among
 * the featured shopping sections (Admin Panel → Banners & Cards → Home page
 * main categories; config HOME_MAIN_CATEGORIES).
 *
 * Categories stay the sellers' own, merged by path ("grocery"); this only
 * decides how Home PRESENTS them. Hiding one never touches the category, its
 * products, sellers, stock, search or the Categories tab — it only stops the
 * category's tile and shelf from appearing on Home.
 *
 * Subcategories are not configured here: Home's subcategory sections
 * (Explore subcategories, category sections, product shelves) keep their own
 * settings in the Home Page Builder, untouched by this list.
 *
 * Discovery: a main category the saved list does not mention (created after
 * the last save) is "new" — it goes after every arranged one, visible or
 * hidden by the admin's `newCategoriesVisible` rule, until the admin saves
 * the list again. A saved entry whose category is gone right now is kept,
 * so the category comes back with its settings.
 *
 * `arrangeMainCategories` is the ONE place these rules live: the server
 * (GET /home, the admin list) and the Admin Panel preview run the same code.
 */

/** HOME_MAIN_CATEGORIES — the admin's arrangement; `{}` until it is first saved. */
export interface HomeMainCategoriesConfig {
  /** Every main category the admin arranged, by path, in Home order (hidden ones keep their place). */
  order: string[];
  /** Paths (from `order`) Home does not show. */
  hidden: string[];
  /** Paths (from `order`, never hidden) whose shelves sit among the featured shopping sections. */
  featured: string[];
  /** A main category created after the last save: shown on Home right away (true) or hidden until reviewed (false). */
  newCategoriesVisible: boolean;
}

/** At most this many main categories in the saved list. */
export const HOME_MAIN_CATEGORY_MAX = 200;
/** At most this many featured main categories (the old "shown first" list's limit). */
export const HOME_FEATURED_CATEGORY_MAX = 50;
/** A main category's path: one lowercase slug, no "/". */
export const MAIN_CATEGORY_PATH_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Why `value` is not a valid HOME_MAIN_CATEGORIES, or null when it is. The
 * server refuses anything else (both the dedicated endpoint and the generic
 * configuration write).
 */
export function homeMainCategoriesProblem(value: unknown): string | null {
  if (!isObject(value)) return 'must be an object with order, hidden, featured and newCategoriesVisible';
  const allowed = new Set(['order', 'hidden', 'featured', 'newCategoriesVisible']);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) return `unknown field "${extra}"`;
  if (typeof value['newCategoriesVisible'] !== 'boolean') return 'newCategoriesVisible must be true or false';

  const lists: Record<'order' | 'hidden' | 'featured', string[]> = { order: [], hidden: [], featured: [] };
  for (const name of ['order', 'hidden', 'featured'] as const) {
    const list = value[name];
    if (!Array.isArray(list)) return `${name} must be a list of category paths`;
    for (const path of list) {
      if (typeof path !== 'string' || !MAIN_CATEGORY_PATH_PATTERN.test(path)) {
        return `each ${name} entry must be a main category path such as "grocery"`;
      }
    }
    if (new Set(list).size !== list.length) return `a category can be listed in ${name} only once`;
    lists[name] = list as string[];
  }
  if (lists.order.length > HOME_MAIN_CATEGORY_MAX) return `can arrange at most ${HOME_MAIN_CATEGORY_MAX} main categories`;
  if (lists.featured.length > HOME_FEATURED_CATEGORY_MAX) return `can feature at most ${HOME_FEATURED_CATEGORY_MAX} main categories`;
  const ordered = new Set(lists.order);
  if (lists.hidden.some((path) => !ordered.has(path))) return 'every hidden category must also be in order';
  if (lists.featured.some((path) => !ordered.has(path))) return 'every featured category must also be in order';
  const hidden = new Set(lists.hidden);
  if (lists.featured.some((path) => hidden.has(path))) return 'a hidden category cannot be featured';
  return null;
}

/** The saved arrangement, or null when it has never been saved (or is unreadable). Never throws. */
export function readHomeMainCategories(raw: unknown): HomeMainCategoriesConfig | null {
  if (homeMainCategoriesProblem(raw) !== null) return null;
  const value = raw as unknown as HomeMainCategoriesConfig;
  return { order: [...value.order], hidden: [...value.hidden], featured: [...value.featured], newCategoriesVisible: value.newCategoriesVisible };
}

export interface ArrangedMainCategory<T> {
  item: T;
  path: string;
  /** Shown on Home. */
  visible: boolean;
  /** Its shelf sits among the featured shopping sections (always visible). */
  featured: boolean;
  /** Not in the saved list yet (created after the last save): follows `newCategoriesVisible`. */
  isNew: boolean;
}

/**
 * Live main categories in Home order with their visibility.
 *
 *   - saved: the saved order first (paths with no live category skipped, so
 *     a stale entry never leaves a gap), then every new category in the
 *     catalogue's own order, shown or hidden by `newCategoriesVisible`;
 *   - never saved: the earlier "Home page category order" list
 *     (HOME_CATEGORY_ORDER, `legacyOrder`) first — those are featured — then
 *     every other category; all visible (today's Home, unchanged).
 *
 * `items` must be in the catalogue's own order; each path appears once.
 */
export function arrangeMainCategories<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  config: HomeMainCategoriesConfig | null,
  legacyOrder: readonly string[] | null | undefined = [],
): ArrangedMainCategory<T>[] {
  const byPath = new Map(items.map((item) => [pathOf(item), item]));
  const out: ArrangedMainCategory<T>[] = [];
  const seen = new Set<string>();

  if (!config) {
    for (const path of legacyOrder ?? []) {
      const item = byPath.get(path);
      if (!item || seen.has(path)) continue;
      seen.add(path);
      out.push({ item, path, visible: true, featured: true, isNew: false });
    }
    for (const item of items) {
      const path = pathOf(item);
      if (!seen.has(path)) out.push({ item, path, visible: true, featured: false, isNew: false });
    }
    return out;
  }

  const hidden = new Set(config.hidden);
  const featured = new Set(config.featured);
  for (const path of config.order) {
    const item = byPath.get(path);
    if (!item || seen.has(path)) continue;
    seen.add(path);
    const visible = !hidden.has(path);
    out.push({ item, path, visible, featured: visible && featured.has(path), isNew: false });
  }
  for (const item of items) {
    const path = pathOf(item);
    if (seen.has(path)) continue;
    out.push({ item, path, visible: config.newCategoriesVisible, featured: false, isNew: true });
  }
  return out;
}

/** One main category in the admin's list (GET /admin/content/home-categories), in Home order. */
export interface AdminHomeMainCategoryDto {
  /** The representative row (what images and banner targets use). */
  id: string;
  path: string;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  /** Live sellers that have this category. */
  sellerCount: number;
  /** Live, approved products under it (including its subcategories). Home shows a category only once it has products in stock. */
  productCount: number;
  visible: boolean;
  featured: boolean;
  /** Not in the saved list yet (created after the last save). */
  isNew: boolean;
}

/** GET /admin/content/home-categories. */
export interface AdminHomeMainCategoriesDto {
  /** Every live main category (with or without products), in Home order. */
  categories: AdminHomeMainCategoryDto[];
  /**
   * Saved entries with no live category right now (a seller removed or
   * paused it). Kept, in their saved order, so the category comes back with
   * its settings; saving keeps them unless the admin forgets them.
   */
  unavailable: { path: string; visible: boolean; featured: boolean }[];
  newCategoriesVisible: boolean;
  /** When the list was last saved here; null = never (Home follows the earlier order list, if any). Send it back as `basedOnUpdatedAt`. */
  updatedAt: string | null;
  updatedBy: string | null;
}

/** PUT /admin/content/home-categories. */
export interface SaveHomeMainCategoriesInput extends HomeMainCategoriesConfig {
  /** The `updatedAt` the admin's screen loaded; a newer save meanwhile is refused (CONTENT_CHANGED). */
  basedOnUpdatedAt: string | null;
}
