/**
 * Applies the admin's published Home layout (Admin Panel → Home Page Builder
 * and Category Management; GET /content/home-layout) to the sections the
 * engine built (homeEngine.ts `buildHomeSections`, unchanged).
 *
 * The engine decides WHAT exists — which shelves, which banners, which
 * categories have products. This decides how it is ARRANGED:
 *
 *   - the "home_top" banners move up into the hero (the promotional area
 *     under the search bar), or are left out when the admin hides it;
 *   - every other engine section belongs to one admin section kind
 *     (HOME_SECTION_KEYS); kinds come out in the admin's order, hidden kinds
 *     are skipped, each carries its background, spacing and heading;
 *   - category grids are refilled from their placement (automatic or chosen
 *     categories, count, rows, columns, tile style), with hidden categories
 *     left out and display names applied — each placement on its own;
 *   - the food banners become a carousel of at most N cards, or the standard
 *     food banner when none is live;
 *   - an engine section this file does not know is kept (before the footer),
 *     so a newer engine never loses content; the footer stays last;
 *   - a banner set to open the Food section (actionType FOOD — newer than the
 *     engine's own mapping) opens it, wherever on Home it shows.
 *
 * Pure and dependency-free (types only), so it is unit tested with Node's
 * own test runner (tests/homeLayout.test.ts). The layout it receives has
 * already been through the shared `resolveHomeLayout` (complete, clamped).
 */

import type {
  BannerDto,
  CategoryDto,
  CategoryPlacementConfig,
  CategoryPlacementKey,
  CategoryStyleConfig,
  HomeFeedDto,
  HomeLayoutContent,
  HomeSectionConfig,
  HomeSectionKey,
} from "@shared";
import type { HomeAction, HomeSection, PromoSlide } from "./homeEngine";

/** A category tile as drawn: the category, its shown name and its own colours. */
export interface CategoryTile {
  category: CategoryDto;
  label: string;
  /** A preset or #RRGGBB; null = the placement's colour. */
  tileBackground: string | null;
  textColor: "dark" | "light" | null;
}

export interface CategoryGridDisplay {
  /** Tiles per row; null = as many as fit. */
  columns: number | null;
  layout: "grid" | "row";
  tileShape: CategoryPlacementConfig["tileShape"];
  imageFit: CategoryPlacementConfig["imageFit"];
  tileBackground: string;
}

export type LaidOutSection =
  | (Exclude<HomeSection, { kind: "categoryGrid" }> & { frame: SectionFrame })
  | {
      kind: "categoryGrid";
      key: string;
      title: string;
      subtitle: string | null;
      tiles: CategoryTile[];
      display: CategoryGridDisplay;
      viewAll: HomeAction | null;
      frame: SectionFrame;
    }
  | {
      kind: "foodCarousel";
      key: "food-carousel";
      title: string | null;
      subtitle: string | null;
      slides: PromoSlide[];
      frame: SectionFrame;
    }
  /** No live food carousel card: the standard food banner (the app's own). */
  | { kind: "foodFallback"; key: "food-fallback"; frame: SectionFrame }
  /**
   * Latest products: the newest buyable products, newest first, straight
   * from the server's newest-first listing (GET /products/rail/RECENTLY_ADDED)
   * — not the engine's de-duplicated preview, which skips products other
   * sections already show. The screen fetches and draws it.
   */
  | { kind: "latest"; key: "latest-products"; title: string; subtitle: string | null; maxItems: number; frame: SectionFrame };

/** Where a section sits on the page: its background and the space around it. */
export interface SectionFrame {
  /** The admin section kind it belongs to; null = not configurable (footer, unknown). */
  group: HomeSectionKey | null;
  /** A preset or #RRGGBB ("none" = the page's background). */
  background: string;
  spacing: HomeSectionConfig["spacing"];
}

export interface HomeLayoutResult {
  /** The promotional area's slides ("home_top" banners); empty = no promotional area. */
  promo: PromoSlide[];
  sections: LaidOutSection[];
}

/** The engine's own priority shelves (homeEngine.ts) — they count as featured. */
const PRIORITY_TITLES = ["grocery", "vegetables & fruits"];

const NEUTRAL_FRAME: SectionFrame = { group: null, background: "none", spacing: "normal" };

/** Latest products: default heading and count (HOME_SECTION_INFO.recently_added). */
export const LATEST_DEFAULT_TITLE = "Latest Products";
export const LATEST_DEFAULT_COUNT = 10;

/** The default number of food carousel cards (HOME_SECTION_INFO.food_carousel). */
export const FOOD_CAROUSEL_DEFAULT_CARDS = 3;

/** Tiles per row used to turn "rows" into a count when the placement fits columns automatically. */
const AUTO_COLUMNS_FOR_ROWS = 4;

/** "grocery" / "grocery/rice". */
const pathOf = (category: CategoryDto, parent?: CategoryDto | null) =>
  parent ? `${parent.slug}/${category.slug}` : category.slug;

function limitOf(config: CategoryPlacementConfig): number {
  const columns = config.columns ?? AUTO_COLUMNS_FOR_ROWS;
  return config.rows !== null ? Math.min(config.maxItems, config.rows * columns) : config.maxItems;
}

/** Which admin section kind an engine section belongs to. */
function groupOf(section: HomeSection, featured: (categoryId: string) => boolean): HomeSectionKey | "promo" | "footer" | null {
  const key = section.key;
  if (key === "banners:top") return "promo";
  if (key === "footer") return "footer";
  if (key === "grid:top") return "top_categories";
  if (key === "banners:food" || section.kind === "food") return "food_carousel";
  if (key === "banners:explore" || key === "grid:explore") return "explore_subcategories";
  if (key === "grid:more") return "more_categories";
  if (key === "rail:TOP_PICKS" || key === "rail:BEST_SELLERS") return "top_picks";
  if (key === "rail:OFFERS") return "offers_rail";
  if (key === "offers") return "offers";
  if (key === "rail:RECENTLY_ADDED") return "recently_added";
  if (key === "previous-orders") return "previous_orders";
  if (key === "banners:bottom") return "bottom_banner";
  const shelf = key.match(/^(?:banners:)?category:(.+)$/);
  if (shelf) return featured(shelf[1]!) ? "featured_shelves" : "more_shelves";
  return null;
}

interface CategoryIndex {
  /** Top categories in Home order, then every subcategory: path → category and parent. */
  byPath: Map<string, { category: CategoryDto; parent: CategoryDto | null }>;
  tops: CategoryDto[];
  styles: Map<string, CategoryStyleConfig>;
  language: "en" | "hi";
}

function indexCategories(feed: HomeFeedDto, styles: readonly CategoryStyleConfig[], language: "en" | "hi"): CategoryIndex {
  const byPath = new Map<string, { category: CategoryDto; parent: CategoryDto | null }>();
  for (const top of feed.categories) {
    byPath.set(pathOf(top), { category: top, parent: null });
    for (const child of top.children ?? []) byPath.set(pathOf(child, top), { category: child, parent: top });
  }
  return { byPath, tops: feed.categories, styles: new Map(styles.map((style) => [style.path, style])), language };
}

function tileOf(index: CategoryIndex, category: CategoryDto, parent: CategoryDto | null): CategoryTile | null {
  const style = index.styles.get(pathOf(category, parent));
  // A hidden parent hides its subcategories too.
  if (style?.hidden || (parent && index.styles.get(pathOf(parent))?.hidden)) return null;
  const own = index.language === "hi" ? style?.displayNameHi ?? category.nameHi ?? style?.displayName : style?.displayName;
  return { category, label: own || category.name, tileBackground: style?.tileBackground ?? null, textColor: style?.textColor ?? null };
}

/** Subcategories taking turns between their parents (as the engine's own explore grid). */
function spreadChildren(index: CategoryIndex, limit: number, skip: Set<string>): CategoryTile[] {
  const lists = index.tops.map((top) => (top.children ?? []).map((child) => ({ child, top })));
  const picked: CategoryTile[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let any = false;
    for (const list of lists) {
      const entry = list[round];
      if (!entry) continue;
      any = true;
      if (skip.has(entry.child.id)) continue;
      const tile = tileOf(index, entry.child, entry.top);
      if (tile) {
        picked.push(tile);
        skip.add(entry.child.id);
      }
      if (picked.length === limit) break;
    }
    if (!any) break;
  }
  return picked;
}

/** A placement's tiles: chosen paths in order, or automatic; `exclude` = already shown higher up. */
function placementTiles(key: CategoryPlacementKey, config: CategoryPlacementConfig, index: CategoryIndex, exclude: Set<string>): CategoryTile[] {
  const limit = limitOf(config);
  const take = (candidates: { category: CategoryDto; parent: CategoryDto | null }[]) => {
    const tiles: CategoryTile[] = [];
    for (const { category, parent } of candidates) {
      if (tiles.length >= limit) break;
      if (exclude.has(category.id)) continue;
      const tile = tileOf(index, category, parent);
      if (!tile) continue;
      tiles.push(tile);
      exclude.add(category.id);
    }
    return tiles;
  };

  if (config.mode === "manual") {
    return take(config.paths.map((path) => index.byPath.get(path)).filter((entry): entry is { category: CategoryDto; parent: CategoryDto | null } => Boolean(entry)));
  }
  if (key === "home_explore") return spreadChildren(index, limit, exclude);
  if (key === "home_more") {
    return take([
      ...index.tops.map((top) => ({ category: top, parent: null })),
      ...index.tops.flatMap((top) => (top.children ?? []).map((child) => ({ category: child, parent: top }))),
    ]);
  }
  return take(index.tops.map((top) => ({ category: top, parent: null })));
}

/** Every banner Home received, by id (the engine's slide keys end in the banner id). */
function homeBanners(feed: HomeFeedDto): Map<string, BannerDto> {
  const all = [
    ...feed.banners,
    ...Object.values(feed.sectionBanners ?? {}).flatMap((list) => list ?? []),
    ...(feed.categoryBanners ?? []).flatMap((entry) => entry.banners),
  ];
  return new Map(all.map((banner) => [banner.id, banner]));
}

/** A "Food section" banner opens Food (the engine predates that action and would leave it inert). */
function withFoodActions(slides: PromoSlide[], banners: Map<string, BannerDto>): PromoSlide[] {
  return slides.map((slide) => {
    const banner = banners.get(slide.key.slice(slide.key.lastIndexOf(":") + 1));
    return banner?.actionType === "FOOD" ? { ...slide, action: { type: "food" } } : slide;
  });
}

const GRID_PLACEMENT: Partial<Record<string, CategoryPlacementKey>> = {
  "grid:top": "home_top",
  "grid:explore": "home_explore",
  "grid:more": "home_more",
};

export interface ApplyHomeLayoutInput {
  /** buildHomeSections(…) output. */
  sections: readonly HomeSection[];
  feed: HomeFeedDto;
  layout: HomeLayoutContent;
  language?: "en" | "hi";
}

export function applyHomeLayout({ sections, feed, layout, language = "en" }: ApplyHomeLayoutInput): HomeLayoutResult {
  const featuredIds = new Set(
    (feed.featuredCategoryIds ?? []).length > 0 ? feed.featuredCategoryIds! : feed.categoryRails.map((rail) => rail.categoryId),
  );
  const railTitle = new Map(feed.categoryRails.map((rail) => [rail.categoryId, rail.title.trim().toLowerCase()]));
  const featured = (categoryId: string) => featuredIds.has(categoryId) || PRIORITY_TITLES.includes(railTitle.get(categoryId) ?? "");

  const banners = homeBanners(feed);
  const byGroup = new Map<HomeSectionKey, HomeSection[]>();
  const unknown: HomeSection[] = [];
  let promo: PromoSlide[] = [];
  let footer: HomeSection | null = null;

  for (const section of sections) {
    const group = groupOf(section, featured);
    const fixed = section.kind === "banners" ? { ...section, slides: withFoodActions(section.slides, banners) } : section;
    if (group === "promo") {
      if (fixed.kind === "banners") promo = fixed.slides;
    } else if (group === "footer") footer = fixed;
    else if (group === null) unknown.push(fixed);
    else byGroup.set(group, [...(byGroup.get(group) ?? []), fixed]);
  }

  const index = indexCategories(feed, layout.categoryStyles, language);
  const shownCategories = new Set<string>();
  const out: LaidOutSection[] = [];

  // Category grids are filled in placement order (top, explore, more) so a
  // category shows in only one of them, whatever order the sections have.
  const gridTiles = new Map<CategoryPlacementKey, CategoryTile[]>();
  for (const key of ["home_top", "home_explore", "home_more"] as const) {
    gridTiles.set(key, placementTiles(key, layout.categoryPlacements[key], index, shownCategories));
  }

  for (const sectionConfig of layout.sections) {
    if (!sectionConfig.visible) continue;
    const frame: SectionFrame = { group: sectionConfig.key, background: sectionConfig.background, spacing: sectionConfig.spacing };
    const members = byGroup.get(sectionConfig.key) ?? [];

    if (sectionConfig.key === "recently_added") {
      out.push({
        kind: "latest",
        key: "latest-products",
        title: sectionConfig.title ?? LATEST_DEFAULT_TITLE,
        subtitle: sectionConfig.subtitle,
        maxItems: sectionConfig.maxItems ?? LATEST_DEFAULT_COUNT,
        frame,
      });
      continue;
    }

    if (sectionConfig.key === "food_carousel") {
      const slides = members.flatMap((member) => (member.kind === "banners" ? member.slides : []));
      const cards = slides.slice(0, sectionConfig.maxItems ?? FOOD_CAROUSEL_DEFAULT_CARDS);
      out.push(
        cards.length > 0
          ? { kind: "foodCarousel", key: "food-carousel", title: sectionConfig.title, subtitle: sectionConfig.subtitle, slides: cards, frame }
          : { kind: "foodFallback", key: "food-fallback", frame },
      );
      continue;
    }

    for (const member of members) {
      if (member.kind === "categoryGrid") {
        const placementKey = GRID_PLACEMENT[member.key];
        if (!placementKey) continue;
        const placement = layout.categoryPlacements[placementKey];
        const tiles = gridTiles.get(placementKey) ?? [];
        if (tiles.length === 0) continue;
        out.push({
          kind: "categoryGrid",
          key: member.key,
          title: sectionConfig.title ?? member.title,
          subtitle: sectionConfig.subtitle,
          tiles,
          display: {
            columns: placement.columns,
            layout: placement.layout,
            tileShape: placement.tileShape,
            imageFit: placement.imageFit,
            tileBackground: placement.tileBackground,
          },
          viewAll: placement.showViewAll ? member.viewAll ?? { type: "allCategories" } : null,
          frame,
        });
      } else if (member.kind === "shelf" && sectionConfig.title) {
        // Only sections with an editable heading carry a title (resolveHomeLayout nulls the rest).
        out.push({ ...member, title: sectionConfig.title, subtitle: sectionConfig.subtitle ?? member.subtitle, frame });
      } else {
        out.push({ ...member, frame } as LaidOutSection);
      }
    }
  }

  for (const section of unknown) out.push({ ...section, frame: NEUTRAL_FRAME } as LaidOutSection);
  if (footer) out.push({ ...footer, frame: NEUTRAL_FRAME } as LaidOutSection);

  return { promo: layout.hero.promo.visible ? promo : [], sections: out };
}

/* -------------------------------------------------------------------------- */
/* The Categories page (placement "categories_page")                           */
/* -------------------------------------------------------------------------- */

export interface ArrangedCategoriesPage {
  /** Top categories to list (with their visible subcategories), display names applied. */
  categories: CategoryDto[];
  /** Tiles per row; null = as many as fit (the screen's own rule). */
  columns: number | null;
}

/**
 * The Categories page's main categories by its own placement — independent
 * of Home's: hidden categories (and a hidden category's subcategories) left
 * out, display names applied, chosen categories in their order or every
 * category in catalogue order, at most `maxItems` (and `rows` × columns).
 */
export function arrangeCategoriesPage(categories: readonly CategoryDto[], layout: HomeLayoutContent, language: "en" | "hi" = "en"): ArrangedCategoriesPage {
  const placement = layout.categoryPlacements.categories_page;
  const index = indexCategories({ categories: [...categories] } as HomeFeedDto, layout.categoryStyles, language);
  const named = (tile: CategoryTile) => ({ ...tile.category, name: tile.label });

  const withChildren = (top: CategoryDto): CategoryDto | null => {
    const tile = tileOf(index, top, null);
    if (!tile) return null;
    const children = (top.children ?? [])
      .map((child) => tileOf(index, child, top))
      .filter((child): child is CategoryTile => Boolean(child))
      .map(named);
    return { ...named(tile), children };
  };

  const ordered =
    placement.mode === "manual"
      ? placement.paths
          .map((path) => index.byPath.get(path))
          .filter((entry): entry is { category: CategoryDto; parent: CategoryDto | null } => Boolean(entry) && entry!.parent === null)
          .map((entry) => entry.category)
      : [...categories];

  const result: CategoryDto[] = [];
  const limit = limitOf(placement);
  for (const top of ordered) {
    if (result.length >= limit) break;
    const arranged = withChildren(top);
    if (arranged) result.push(arranged);
  }
  return { categories: result, columns: placement.columns };
}
