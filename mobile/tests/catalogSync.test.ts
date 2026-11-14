/**
 * Categories / Home sections removed, hidden or re-ordered in the Admin Panel
 * (or by a seller) must leave the running app — lib/catalogSync.ts.
 *
 * Root cause: Home never unmounts and the Categories tab stays mounted, and
 * their queries (published layout, Home feed, category tree) were fetched on
 * mount only — a deleted "Tea & Coffee" stayed until the OS killed the app.
 * Now they are asked again on the realtime `catalog.changed`, on socket
 * reconnect, on app resume and when the screen is shown again; and what the
 * app draws is always the server's latest answer (a category the feed no
 * longer has is never a tile, whatever the layout chose).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_HOME_LAYOUT, resolveHomeLayout } from "../src/shared/home-layout.ts";
import type { CategoryDto, HomeFeedDto, HomeLayoutContent } from "../src/shared/index.ts";
import type { HomeSection } from "../src/screens/home/homeEngine.ts";
import { applyHomeLayout, arrangeCategoriesPage } from "../src/screens/home/homeLayout.ts";
import { CATALOG_FOCUS_MIN_AGE_MS, CATALOG_QUERY_ROOTS, CATALOG_SYNC_THROTTLE_MS, createCatalogRevalidator } from "../src/lib/catalogSync.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* The revalidator ----------------------------------------------------------- */

function harness() {
  let clock = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  const calls: string[] = [];
  const revalidate = createCatalogRevalidator((key) => calls.push(key.join("/")), {
    now: () => clock,
    setTimer: (run, ms) => timers.push({ at: clock + ms, run }),
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0)) if (timer.at <= clock) timer.run();
      else timers.push(timer);
  };
  return { revalidate, calls, advance, timers };
}

describe("catalog revalidation (realtime event / reconnect / app resume)", () => {
  it("asks again for the Home layout, Home feed, shelves, category tree and category listings", () => {
    const h = harness();
    h.revalidate();
    assert.deepEqual(h.calls, ["content/home-layout", "home", "content/home-shelves", "categories", "category-listing"]);
  });

  it("several signals at once refetch once now and once at the end of the window — never lost, never a burst", () => {
    const h = harness();
    h.revalidate();
    h.revalidate();
    h.revalidate();
    assert.equal(h.calls.length, CATALOG_QUERY_ROOTS.length);
    assert.equal(h.timers.length, 1);
    h.advance(CATALOG_SYNC_THROTTLE_MS);
    assert.equal(h.calls.length, CATALOG_QUERY_ROOTS.length * 2);
    // Quiet afterwards: the next signal runs at once again.
    h.advance(CATALOG_SYNC_THROTTLE_MS);
    h.revalidate();
    assert.equal(h.calls.length, CATALOG_QUERY_ROOTS.length * 3);
  });

  it("every root is a prefix of the real query key (so every version / page size is covered)", () => {
    const queries = read("src/lib/queries.ts");
    const layout = read("src/lib/homeLayoutQuery.ts");
    assert.match(queries, /home: \["home"\] as const,/);
    assert.match(queries, /categories: \["categories", CATALOG_CACHE_VERSION\] as const,/);
    assert.match(queries, /\["category-listing", CATALOG_CACHE_VERSION, categoryId, pageSize\]/);
    assert.match(layout, /homeLayoutQueryKey = \["content", "home-layout"\] as const;/);
    assert.match(layout, /homeShelvesQueryKey = \["content", "home-shelves"\] as const;/);
  });
});

describe("wiring", () => {
  it("the socket event, a reconnect and app resume all revalidate; Home and Categories refresh when shown again", () => {
    const socket = read("src/lib/socket.ts");
    assert.match(socket, /socket\.on\('catalog\.changed', \(\) => catalogListener\?\.\(\)\);/);
    assert.match(socket, /socket\.io\.on\('reconnect', \(\) => \{[^}]*catalogListener\?\.\(\);/);
    const app = read("App.tsx");
    assert.match(app, /onCatalogChanged\(revalidateCatalog\);/);
    assert.match(app, /if \(next !== "active"\) return;[\s\S]*revalidateCatalog\(\);[\s\S]*subscription\.remove\(\)/);
    const home = read("src/screens/home/HomeScreen.tsx");
    assert.match(home, /useRefreshOnFocus\(feed, \{ minAgeMs: CATALOG_FOCUS_MIN_AGE_MS \}\);/);
    assert.match(home, /useRefreshOnFocus\(homeLayoutQuery, \{ minAgeMs: CATALOG_FOCUS_MIN_AGE_MS \}\);/);
    const categories = read("src/screens/catalog/CategoriesScreen.tsx");
    assert.match(categories, /useRefreshOnFocus\(categories, \{ minAgeMs: CATALOG_FOCUS_MIN_AGE_MS \}\);/);
    assert.match(categories, /useRefreshOnFocus\(homeLayoutQuery, \{ minAgeMs: CATALOG_FOCUS_MIN_AGE_MS \}\);/);
    // Not a poll: only on focus, and only when older than a minute.
    assert.equal(CATALOG_FOCUS_MIN_AGE_MS, 60_000);
    assert.doesNotMatch(home + categories, /useRefreshOnFocus\((feed|homeLayoutQuery|categories), \{[^}]*intervalMs/);
  });

  it("the backend announces committed category / layout / Home-category changes", () => {
    const backend = (rel: string) => read(path.join("..", "backend", rel));
    assert.match(backend("src/realtime/socket.ts"), /io\?\.emit\('catalog\.changed', \{\}\);/);
    assert.match(backend("src/modules/catalog/catalog.service.ts"), /categoryCache = null;\n\s*emitCatalogChanged\(\);/);
    assert.match(backend("src/modules/content/home-layout.service.ts"), /emitCatalogChanged\(\);\n\s*return getAdminHomeLayout\(\);/);
    assert.match(backend("src/modules/content/home-categories.service.ts"), /await configService\.invalidate\(null\);[\s\S]*emitCatalogChanged\(\);/);
  });
});

/* What the refreshed answer draws ------------------------------------------ */

let ids = 0;
const cat = (name: string, slug: string, children: CategoryDto[] = []): CategoryDto => {
  const row: CategoryDto = { id: `k${++ids}`, parentId: null, name, nameHi: null, slug, imageUrl: null, depth: children.length ? 0 : 1, displayOrder: ids, children };
  for (const child of children) child.parentId = row.id;
  return row;
};

function catalogue(withTea: boolean) {
  const drinks = cat("Drinks", "drinks");
  const tea = cat("Tea & Coffee", "tea-coffee");
  const grocery = cat("Grocery", "grocery", withTea ? [drinks, tea] : [drinks]);
  const teaTop = cat("Tea & Coffee", "tea-coffee-store");
  const fashion = cat("Fashion", "fashion");
  const tops = withTea ? [grocery, teaTop, fashion] : [grocery, fashion];
  const feed = { banners: [], categories: tops, featuredCategoryIds: [], rails: [], categoryRails: [] } as unknown as HomeFeedDto;
  const sections: HomeSection[] = [
    { kind: "categoryGrid", key: "grid:top", title: "Top Categories", categories: tops, columns: 4, viewAll: { type: "allCategories" } },
    { kind: "categoryGrid", key: "grid:explore", title: "Explore", categories: grocery.children ?? [], columns: 4, viewAll: { type: "allCategories" } },
    { kind: "footer", key: "footer" },
  ];
  return { feed, sections, tops };
}

const layoutWith = (change: (layout: HomeLayoutContent) => void = () => undefined) => {
  const layout = structuredClone(resolveHomeLayout(DEFAULT_HOME_LAYOUT));
  change(layout);
  return resolveHomeLayout(layout);
};

const tilesOf = (feed: HomeFeedDto, sections: HomeSection[], layout: HomeLayoutContent, key: string) => {
  const grid = applyHomeLayout({ sections, feed, layout }).sections.find((section) => section.key === key);
  return grid && grid.kind === "categoryGrid" ? grid.tiles.map((tile) => tile.label) : [];
};

describe("a deleted Tea & Coffee leaves Home and View All Categories once the app has the new answer", () => {
  it("automatic placements: the tile is there before and gone after (top category and subcategory)", () => {
    const before = catalogue(true);
    const after = catalogue(false);
    const layout = layoutWith();
    assert.ok(tilesOf(before.feed, before.sections, layout, "grid:top").includes("Tea & Coffee"));
    assert.ok(tilesOf(before.feed, before.sections, layout, "grid:explore").includes("Tea & Coffee"));
    assert.ok(!tilesOf(after.feed, after.sections, layout, "grid:top").includes("Tea & Coffee"));
    assert.ok(!tilesOf(after.feed, after.sections, layout, "grid:explore").includes("Tea & Coffee"));
    assert.ok(!arrangeCategoriesPage(after.tops, layout).categories.some((c) => c.name === "Tea & Coffee"));
  });

  it("a layout that hand-picked it never brings it back (no gap, no stale tile)", () => {
    const layout = layoutWith((l) => {
      l.categoryPlacements.home_top = { ...l.categoryPlacements.home_top, mode: "manual", paths: ["tea-coffee-store", "grocery/tea-coffee", "fashion", "grocery"] };
      l.categoryPlacements.categories_page = { ...l.categoryPlacements.categories_page, mode: "manual", paths: ["tea-coffee-store", "grocery", "fashion"] };
    });
    const before = catalogue(true);
    assert.deepEqual(tilesOf(before.feed, before.sections, layout, "grid:top"), ["Tea & Coffee", "Tea & Coffee", "Fashion", "Grocery"]);
    const after = catalogue(false);
    assert.deepEqual(tilesOf(after.feed, after.sections, layout, "grid:top"), ["Fashion", "Grocery"]);
    assert.deepEqual(arrangeCategoriesPage(after.tops, layout).categories.map((c) => c.name), ["Grocery", "Fashion"]);
    // …and its subcategory is gone from the Categories page tree too.
    assert.deepEqual(arrangeCategoriesPage(after.tops, layout).categories[0]!.children?.map((c) => c.name), ["Drinks"]);
  });

  it("hidden by the admin (Category Management): gone from every grid while still in the catalogue; unhidden: back", () => {
    const { feed, sections, tops } = catalogue(true);
    const hidden = layoutWith((l) => {
      l.categoryStyles = [{ path: "grocery/tea-coffee", displayName: null, displayNameHi: null, tileBackground: null, textColor: null, hidden: true }];
    });
    assert.ok(!tilesOf(feed, sections, hidden, "grid:explore").includes("Tea & Coffee"));
    assert.deepEqual(arrangeCategoriesPage(tops, hidden).categories[0]!.children?.map((c) => c.name), ["Drinks"]);
    const shown = layoutWith();
    assert.ok(tilesOf(feed, sections, shown, "grid:explore").includes("Tea & Coffee"));
  });

  it("a new category appears and the admin's order is followed", () => {
    const { feed, sections } = catalogue(false);
    const added = { ...feed, categories: [...feed.categories, cat("Ice Cream", "ice-cream")] } as HomeFeedDto;
    const addedSections = sections.map((s) => (s.kind === "categoryGrid" && s.key === "grid:top" ? { ...s, categories: added.categories } : s));
    assert.deepEqual(tilesOf(added, addedSections, layoutWith(), "grid:top"), ["Grocery", "Fashion", "Ice Cream"]);
    const ordered = layoutWith((l) => {
      l.categoryPlacements.home_top = { ...l.categoryPlacements.home_top, mode: "manual", paths: ["ice-cream", "fashion", "grocery"] };
    });
    assert.deepEqual(tilesOf(added, addedSections, ordered, "grid:top"), ["Ice Cream", "Fashion", "Grocery"]);
  });
});

/* Every Admin Panel way of removing Tea & Coffee ----------------------------- */

/**
 * The admin has no "delete category" (categories are the sellers' own —
 * Marketplace Catalogue is read-only). The ways the Admin Panel takes a
 * category off the customer app, each checked on Home (tiles, its shelf and
 * shelf banners) and on View All Categories (tiles and subcategory pane):
 *   A. Category Management → the category's "Shown" switch off (style hidden), published;
 *   B. Category Management → taken out of a hand-picked placement, published;
 *   C. Banners & Cards → Home page main categories → hidden (server: no tile, no shelf);
 *   D. Home Page Builder → the Top Categories section hidden;
 *   E. the seller switches it off / deletes it (the server leaves it out).
 */
describe("every admin path that removes Tea & Coffee", () => {
  const shelf = (id: string, title: string): HomeSection => ({ kind: "shelf", key: `category:${id}`, title, subtitle: null, products: [], viewAll: null });
  const shelfBanner = (id: string): HomeSection =>
    ({ kind: "banners", key: `banners:category:${id}`, slides: [] }) as unknown as HomeSection;

  function home(opts: { teaHiddenByServer?: boolean; teaGone?: boolean } = {}) {
    const grocery = cat("Grocery", "grocery", [cat("Drinks", "drinks")]);
    const tea = cat("Tea & Coffee", "tea-coffee", [cat("Green Tea", "green-tea")]);
    const fashion = cat("Fashion", "fashion");
    const shown = opts.teaGone || opts.teaHiddenByServer ? [grocery, fashion] : [grocery, tea, fashion];
    const feed = {
      banners: [],
      categories: shown,
      hiddenCategories: opts.teaHiddenByServer ? [tea] : [],
      featuredCategoryIds: shown.map((c) => c.id),
      rails: [],
      categoryRails: shown.map((c) => ({ categoryId: c.id, title: c.name, products: [] })),
    } as unknown as HomeFeedDto;
    const sections: HomeSection[] = [
      { kind: "categoryGrid", key: "grid:top", title: "Top Categories", categories: shown, columns: 4, viewAll: { type: "allCategories" } },
      ...shown.flatMap((c) => [shelfBanner(c.id), shelf(c.id, c.name)]),
      { kind: "footer", key: "footer" },
    ];
    return { feed, sections, tea, tops: shown };
  }

  const keysOf = (feed: HomeFeedDto, sections: HomeSection[], layout: HomeLayoutContent) =>
    applyHomeLayout({ sections, feed, layout }).sections.map((s) => s.key);
  const teaOnHome = (h: ReturnType<typeof home>, layout: HomeLayoutContent) => {
    const laid = applyHomeLayout({ sections: h.sections, feed: h.feed, layout }).sections;
    const tiles = laid.flatMap((s) => (s.kind === "categoryGrid" ? s.tiles.map((t) => t.label) : []));
    return {
      tile: tiles.includes("Tea & Coffee"),
      shelf: laid.some((s) => s.key === `category:${h.tea.id}`),
      shelfBanner: laid.some((s) => s.key === `banners:category:${h.tea.id}`),
    };
  };
  const hiddenStyle = (path: string) => ({ path, displayName: null, displayNameHi: null, tileBackground: null, textColor: null, hidden: true });

  it("before: tile, shelf and View All entry are there", () => {
    const h = home();
    const layout = layoutWith();
    assert.deepEqual(teaOnHome(h, layout), { tile: true, shelf: true, shelfBanner: true });
    assert.ok(arrangeCategoriesPage(h.tops, layout).categories.some((c) => c.name === "Tea & Coffee"));
  });

  it("A. hidden in Category Management: no tile, no shelf, no shelf banner, not on View All (subcategories too); shown again: back", () => {
    const h = home();
    const hidden = layoutWith((l) => void (l.categoryStyles = [hiddenStyle("tea-coffee")]));
    assert.deepEqual(teaOnHome(h, hidden), { tile: false, shelf: false, shelfBanner: false });
    assert.ok(!arrangeCategoriesPage(h.tops, hidden).categories.some((c) => c.name === "Tea & Coffee"));
    // Other categories keep their shelves.
    assert.ok(keysOf(h.feed, h.sections, hidden).includes(`category:${h.tops[0]!.id}`));
    assert.deepEqual(teaOnHome(h, layoutWith()), { tile: true, shelf: true, shelfBanner: true });
  });

  it("A'. a hidden SUBCATEGORY leaves the grids and its parent's View All pane; the parent stays", () => {
    const h = home();
    const hidden = layoutWith((l) => void (l.categoryStyles = [hiddenStyle("tea-coffee/green-tea")]));
    const page = arrangeCategoriesPage(h.tops, hidden).categories.find((c) => c.name === "Tea & Coffee")!;
    assert.deepEqual(page.children, []);
    assert.equal(teaOnHome(h, hidden).shelf, true);
  });

  it("B. taken out of the hand-picked Top Categories / Categories page lists: not a tile there (its shelf follows C)", () => {
    const h = home();
    const picked = layoutWith((l) => {
      l.categoryPlacements.home_top = { ...l.categoryPlacements.home_top, mode: "manual", paths: ["grocery", "fashion"] };
      l.categoryPlacements.categories_page = { ...l.categoryPlacements.categories_page, mode: "manual", paths: ["grocery", "fashion"] };
    });
    assert.equal(teaOnHome(h, picked).tile, false);
    assert.deepEqual(arrangeCategoriesPage(h.tops, picked).categories.map((c) => c.name), ["Grocery", "Fashion"]);
  });

  it("C. hidden in Home page main categories (server answer): no tile and no shelf on Home; still on View All (by design: Home only)", () => {
    const h = home({ teaHiddenByServer: true });
    assert.deepEqual(teaOnHome(h, layoutWith()), { tile: false, shelf: false, shelfBanner: false });
  });

  it("D. Top Categories section hidden in the Home Page Builder: no category grid at all", () => {
    const h = home();
    const noGrid = layoutWith((l) => {
      for (const section of l.sections) if (section.key === "top_categories") section.visible = false;
    });
    assert.ok(!keysOf(h.feed, h.sections, noGrid).includes("grid:top"));
  });

  it("E. switched off / deleted by the seller (absent from the server's answer): gone everywhere", () => {
    const h = home({ teaGone: true });
    assert.deepEqual(teaOnHome(h, layoutWith()), { tile: false, shelf: false, shelfBanner: false });
    assert.ok(!arrangeCategoriesPage(h.tops, layoutWith()).categories.some((c) => c.name === "Tea & Coffee"));
  });
});
