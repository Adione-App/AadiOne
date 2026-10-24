/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Home Page Builder — editing operations and publish checks on a
 * HomeLayoutContent (home-layout.ts), shared so the Admin Panel edits a
 * layout exactly the way the server checks it.
 *
 *   add / duplicate / remove / move   pure: each returns a NEW layout
 *   homeLayoutProblems                what stops a layout from being
 *                                     published (the server refuses it with
 *                                     these messages; the builder shows them
 *                                     next to the section)
 *   homeLayoutReferences              every category path and product id a
 *                                     layout names — what the server checks
 *                                     is still live before publishing
 *
 * Sections are identified by their stable `id`, never by position or title.
 */

import {
  CATEGORY_PLACEMENT_INFO,
  DEFAULT_CATEGORY_SECTION,
  DEFAULT_HOME_SECTION,
  DEFAULT_PRODUCT_SHELF,
  HOME_CUSTOM_SECTION_MAX,
  HOME_SECTION_ID_PATTERN,
  PRODUCT_SHELF_COUNT_LIMITS,
  PRODUCT_SHELF_SOURCE_INFO,
  homeSectionInfo,
  isRepeatableSectionKind,
  productShelfViewAllOptions,
  productShelfViewAllProblem,
  type HomeCategorySectionConfig,
  type HomeLayoutContent,
  type HomeRepeatableSectionKind,
  type HomeSectionConfig,
  type ProductShelfConfig,
} from './home-layout';

const ID_PREFIX: Record<HomeRepeatableSectionKind, string> = { product_shelf: 'shelf', category_section: 'cats' };

const randomSuffix = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0');

/** A fresh id for an added section that no section of `layout` uses. */
export function newHomeSectionId(kind: HomeRepeatableSectionKind, layout: HomeLayoutContent, random: () => string = randomSuffix): string {
  const used = new Set(layout.sections.map((section) => section.id));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = `${ID_PREFIX[kind]}-${random().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || attempt}`;
    if (HOME_SECTION_ID_PATTERN.test(id) && !used.has(id)) return id;
  }
  // Practically unreachable; still unique.
  let n = layout.sections.length;
  while (used.has(`${ID_PREFIX[kind]}-${n}`)) n += 1;
  return `${ID_PREFIX[kind]}-${n}`;
}

export const countAddedSections = (layout: HomeLayoutContent) => layout.sections.filter((section) => isRepeatableSectionKind(section.key)).length;

/** A new added section with sensible defaults (a shelf of the latest products, a category grid to fill in). */
export function createHomeSection(
  kind: HomeRepeatableSectionKind,
  id: string,
  init: { title?: string | null; shelf?: Partial<ProductShelfConfig>; categories?: Partial<HomeCategorySectionConfig> } = {},
): HomeSectionConfig {
  const shelf = kind === 'product_shelf' ? { ...structuredCopy(DEFAULT_PRODUCT_SHELF), ...structuredCopy(init.shelf ?? {}) } : null;
  if (shelf && init.shelf?.viewAll === undefined) shelf.viewAll = productShelfViewAllOptions(shelf)[0] ?? { type: 'none', path: null };
  return {
    ...DEFAULT_HOME_SECTION,
    id,
    key: kind,
    title: init.title ?? null,
    shelf,
    categories: kind === 'category_section' ? { ...structuredCopy(DEFAULT_CATEGORY_SECTION), ...structuredCopy(init.categories ?? {}) } : null,
  };
}

/** `layout` with a new section inserted at `at` (default: the end). Null when the page already has the most added sections allowed. */
export function addHomeSection(layout: HomeLayoutContent, section: HomeSectionConfig, at = layout.sections.length): HomeLayoutContent | null {
  if (countAddedSections(layout) >= HOME_CUSTOM_SECTION_MAX) return null;
  const sections = [...layout.sections];
  sections.splice(Math.max(0, Math.min(at, sections.length)), 0, section);
  return { ...layout, sections };
}

/**
 * Added sections duplicate as they are. A built-in section whose content is
 * a category list or a product ranking duplicates into an added section with
 * the same settings (e.g. "Latest products" → a Latest product shelf), which
 * can then be changed on its own. The rest exist once by nature.
 */
export function canDuplicateHomeSection(section: HomeSectionConfig): boolean {
  if (isRepeatableSectionKind(section.key)) return true;
  return ['top_categories', 'explore_subcategories', 'more_categories', 'recently_added', 'top_picks'].includes(section.key);
}

/** `layout` with a copy of section `sectionId` (id `newId`) right after it; null when it cannot be duplicated. */
export function duplicateHomeSection(layout: HomeLayoutContent, sectionId: string, newId: string): HomeLayoutContent | null {
  const index = layout.sections.findIndex((section) => section.id === sectionId);
  const source = layout.sections[index];
  if (!source || !canDuplicateHomeSection(source) || layout.sections.some((section) => section.id === newId)) return null;
  const title = `${homeSectionTitle(source)} (copy)`.slice(0, 60);
  const style = { visible: source.visible, subtitle: source.subtitle, background: source.background, spacing: source.spacing };
  let copy: HomeSectionConfig;
  if (isRepeatableSectionKind(source.key)) {
    copy = { ...structuredCopy(source), id: newId, title };
  } else if (source.key === 'recently_added' || source.key === 'top_picks') {
    const latest = source.key === 'recently_added';
    copy = {
      ...createHomeSection('product_shelf', newId, {
        title,
        shelf: {
          source: latest ? 'latest' : 'bestselling',
          count: Math.min(PRODUCT_SHELF_COUNT_LIMITS.max, source.maxItems ?? 10),
          viewAll: { type: latest ? 'latest' : 'bestselling', path: null },
        },
      }),
      ...style,
    };
  } else {
    const placementKey = homeSectionInfo(source.key).categoryPlacement!;
    copy = {
      ...createHomeSection('category_section', newId, {
        title,
        categories: { ...structuredCopy(layout.categoryPlacements[placementKey]), level: CATEGORY_PLACEMENT_INFO[placementKey].level, textColor: null },
      }),
      ...style,
    };
  }
  return addHomeSection(layout, copy, index + 1);
}

/**
 * Removes an added section from Home (its categories and products are not
 * touched — they only stop being shown here). A built-in section always
 * exists once, so "removing" it hides it.
 */
export function removeHomeSection(layout: HomeLayoutContent, sectionId: string): HomeLayoutContent {
  const section = layout.sections.find((entry) => entry.id === sectionId);
  if (!section) return layout;
  if (!isRepeatableSectionKind(section.key)) {
    return { ...layout, sections: layout.sections.map((entry) => (entry.id === sectionId ? { ...entry, visible: false } : entry)) };
  }
  return { ...layout, sections: layout.sections.filter((entry) => entry.id !== sectionId) };
}

/** Moves the section at `from` to `to` (drag and drop, or ↑ / ↓). */
export function moveHomeSection(layout: HomeLayoutContent, from: number, to: number): HomeLayoutContent {
  if (from === to || from < 0 || from >= layout.sections.length || to < 0 || to >= layout.sections.length) return layout;
  const sections = [...layout.sections];
  const [section] = sections.splice(from, 1);
  sections.splice(to, 0, section!);
  return { ...layout, sections };
}

/** The heading a section is known by: its own title, else a description of what it shows. */
export function homeSectionTitle(section: HomeSectionConfig, categoryName: (path: string) => string | undefined = () => undefined): string {
  if (section.title) return section.title;
  if (section.key === 'product_shelf' && section.shelf) {
    const shelf = section.shelf;
    const names = shelf.categoryPaths.map((path) => categoryName(path) ?? path);
    if (shelf.source === 'latest') return names.length ? `Latest in ${names.join(' & ')}` : 'Latest products';
    if (shelf.source === 'bestselling') return names.length ? `Best-selling ${names.join(' & ')}` : 'Best-selling products';
    if (names.length) return names.join(' & ');
    return shelf.source === 'manual' ? 'Picked for you' : 'Products for you';
  }
  return homeSectionInfo(section.key).label;
}

export interface HomeLayoutProblem {
  /** The section it concerns; null = the page as a whole. */
  sectionId: string | null;
  field: string;
  message: string;
}

/**
 * Everything that stops this layout from being published, in page order —
 * the checks that need no database (live categories and products are
 * checked by the server on top of these).
 */
export function homeLayoutProblems(layout: HomeLayoutContent): HomeLayoutProblem[] {
  const problems: HomeLayoutProblem[] = [];
  const titles = new Map<string, string>();
  for (const section of layout.sections) {
    if (!isRepeatableSectionKind(section.key)) continue;
    const name = section.title ?? homeSectionInfo(section.key).label;
    const add = (field: string, message: string) => problems.push({ sectionId: section.id, field: `sections.${section.id}.${field}`, message: `${name}: ${message}` });

    if (section.key === 'product_shelf' && section.shelf) {
      const shelf = section.shelf;
      if (!section.title) add('title', 'give the shelf a heading, so customers know what it is.');
      if (shelf.source === 'manual' && shelf.productIds.length === 0 && !shelf.fillFromScope) {
        add('shelf.productIds', 'choose at least one product (or let it be topped up from its categories).');
      }
      const viewAll = productShelfViewAllProblem(shelf);
      if (viewAll) add('shelf.viewAll', viewAll);
    }
    if (section.key === 'category_section' && section.categories) {
      if (section.categories.mode === 'manual' && section.categories.paths.length === 0) {
        add('categories.paths', 'choose at least one category (or switch it to automatic).');
      }
    }
    // Two added sections must be told apart by their heading.
    if (section.title && section.visible) {
      const key = section.title.trim().toLowerCase();
      const other = titles.get(key);
      if (other) add('title', `another section (${other}) has the same heading — give each its own.`);
      else titles.set(key, section.title);
    }
  }
  return problems;
}

/** Every category path and product id the layout's added sections name. */
export function homeLayoutReferences(layout: HomeLayoutContent): { categoryPaths: Set<string>; productIds: Set<string> } {
  const categoryPaths = new Set<string>();
  const productIds = new Set<string>();
  for (const section of layout.sections) {
    if (section.shelf) {
      section.shelf.categoryPaths.forEach((path) => categoryPaths.add(path));
      if (section.shelf.viewAll.type === 'category' && section.shelf.viewAll.path) categoryPaths.add(section.shelf.viewAll.path);
      if (section.shelf.source === 'manual') section.shelf.productIds.forEach((id) => productIds.add(id));
    }
    if (section.categories?.mode === 'manual') section.categories.paths.forEach((path) => categoryPaths.add(path));
  }
  return { categoryPaths, productIds };
}

/** Label for a shelf source (builder lists and summaries). */
export const productShelfSourceLabel = (shelf: ProductShelfConfig) => PRODUCT_SHELF_SOURCE_INFO[shelf.source].label;

/** A deep copy of plain JSON data (layouts are plain JSON). */
function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
