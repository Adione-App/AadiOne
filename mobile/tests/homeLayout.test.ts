/**
 * The admin's Home layout applied to the engine's sections
 * (src/screens/home/homeLayout.ts) — run with `npm run test:unit`
 * (Node's built-in test runner; no React Native needed).
 *
 * The sections below are shaped exactly like homeEngine.ts's
 * `buildHomeSections` output (same keys and kinds), built by hand because
 * the engine itself imports runtime app modules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOME_LAYOUT, resolveHomeLayout } from "../src/shared/home-layout.ts";
import type { CategoryDto, HomeFeedDto, HomeLayoutContent } from "../src/shared/index.ts";
import type { HomeSection, PromoSlide } from "../src/screens/home/homeEngine.ts";
import {
  FOOD_CAROUSEL_DEFAULT_CARDS,
  LATEST_DEFAULT_COUNT,
  LATEST_DEFAULT_TITLE,
  applyHomeLayout,
  arrangeCategoriesPage,
  type LaidOutSection,
} from "../src/screens/home/homeLayout.ts";

/* Fixtures ------------------------------------------------------------------ */

let ids = 0;
const category = (name: string, slug: string, children: CategoryDto[] = [], nameHi: string | null = null): CategoryDto => ({
  id: `c${++ids}`,
  parentId: null,
  name,
  nameHi,
  slug,
  imageUrl: null,
  depth: children.length ? 0 : 1,
  displayOrder: ids,
  children,
});

const rice = category("Rice", "rice", [], "चावल");
const atta = category("Atta", "atta");
const chips = category("Chips", "chips");
const soap = category("Soap", "soap");
const grocery = category("Grocery", "grocery", [rice, atta], "किराना");
const snacks = category("Snacks", "snacks", [chips]);
const care = category("Personal Care", "personal-care", [soap]);
const tops = [grocery, snacks, care];
for (const top of tops) for (const child of top.children ?? []) child.parentId = top.id;

const slide = (id: string): PromoSlide => ({
  key: id,
  title: id,
  subtitle: null,
  imageUrl: `https://cdn.example/${id}.webp`,
  aspectRatio: 2,
  layout: { variant: "banner", aspectRatio: null, height: null, width: "content", fit: "cover", alignX: "center", alignY: "center", radius: "lg", background: "none", textTone: "dark" },
  action: { type: "none" },
});

const shelf = (key: string, title: string): HomeSection => ({ kind: "shelf", key, title, subtitle: null, products: [], viewAll: null });

const feed: HomeFeedDto = {
  banners: [],
  categories: tops,
  featuredCategoryIds: [snacks.id],
  rails: [],
  categoryRails: [
    { categoryId: grocery.id, title: "Grocery", products: [] },
    { categoryId: snacks.id, title: "Snacks", products: [] },
    { categoryId: care.id, title: "Personal Care", products: [] },
  ],
} as unknown as HomeFeedDto;

/** Engine output for the fixture feed (same order and keys as buildHomeSections). */
function engineSections(foodSlides = 0): HomeSection[] {
  return [
    { kind: "banners", key: "banners:top", slides: [slide("top1"), slide("top2")] },
    { kind: "categoryGrid", key: "grid:top", title: "Top Categories", categories: tops, columns: 4, viewAll: { type: "allCategories" } },
    ...(foodSlides ? [{ kind: "banners", key: "banners:food", slides: Array.from({ length: foodSlides }, (_, i) => slide(`food${i}`)) } as HomeSection] : []),
    shelf(`category:${grocery.id}`, "Grocery"), // priority title → featured
    shelf(`category:${snacks.id}`, "Snacks"), // featuredCategoryIds → featured
    { kind: "categoryGrid", key: "grid:explore", title: "Explore Subcategories", categories: [rice, chips, soap], columns: 5, viewAll: { type: "allCategories" } },
    shelf(`category:${care.id}`, "Personal Care"), // other shelf
    { kind: "categoryGrid", key: "grid:more", title: "More Categories", categories: [atta], columns: 4, viewAll: { type: "allCategories" } },
    shelf("rail:TOP_PICKS", "Top Picks"),
    shelf("rail:OFFERS", "Offers"),
    { kind: "offers", key: "offers" },
    shelf("rail:RECENTLY_ADDED", "Recently Added"),
    shelf("previous-orders", "Previous Orders"),
    { kind: "banners", key: "banners:bottom", slides: [slide("bottom")] },
    { kind: "footer", key: "footer" },
  ];
}

const defaults = () => resolveHomeLayout(DEFAULT_HOME_LAYOUT);
const edit = (change: (layout: HomeLayoutContent) => void) => {
  const layout = structuredClone(defaults());
  change(layout);
  return resolveHomeLayout(layout);
};
const keys = (sections: LaidOutSection[]) => sections.map((section) => section.key);
const grid = (sections: LaidOutSection[], key: string) => {
  const found = sections.find((section) => section.key === key);
  assert.ok(found && found.kind === "categoryGrid", `no grid ${key}`);
  return found;
};

/* Tests ---------------------------------------------------------------------- */

describe("applyHomeLayout — the default layout", () => {
  it("keeps the engine's order, moves the top banners into the promotional area and keeps the footer last", () => {
    const result = applyHomeLayout({ sections: engineSections(), feed, layout: defaults() });
    assert.deepEqual(result.promo.map((s) => s.key), ["top1", "top2"]);
    assert.deepEqual(keys(result.sections), [
      "grid:top",
      "food-fallback", // no food banner live → the standard food banner, where it always was
      `category:${grocery.id}`,
      `category:${snacks.id}`,
      "grid:explore",
      `category:${care.id}`,
      // ("grid:more" is left out: every category is already on a grid above — see the next test.)
      "rail:TOP_PICKS",
      "rail:OFFERS",
      "offers",
      "latest-products", // newest-first list, fetched by the screen (not the engine's de-duplicated rail)
      "previous-orders",
      "banners:bottom",
      "footer",
    ]);
    assert.equal(result.sections.at(-1)!.frame.group, null);
  });

  it("shows every live category exactly once across the Home grids, top categories first", () => {
    const { sections } = applyHomeLayout({ sections: engineSections(), feed, layout: defaults() });
    assert.deepEqual(grid(sections, "grid:top").tiles.map((t) => t.label), ["Grocery", "Snacks", "Personal Care"]);
    assert.deepEqual(grid(sections, "grid:explore").tiles.map((t) => t.label), ["Rice", "Chips", "Soap", "Atta"]);
    // Everything is already shown above, so "More categories" has nothing left and is left out.
    assert.equal(sections.some((s) => s.key === "grid:more"), false);
  });
});

describe("applyHomeLayout — the admin's choices", () => {
  it("orders and hides whole sections; a section's heading, background and spacing travel with it", () => {
    const layout = edit((l) => {
      const picks = l.sections.find((s) => s.key === "top_picks")!;
      picks.title = "Bestsellers";
      picks.background = "peach";
      picks.spacing = "relaxed";
      l.sections = [picks, ...l.sections.filter((s) => s.key !== "top_picks")];
      l.sections.find((s) => s.key === "offers")!.visible = false;
      l.sections.find((s) => s.key === "featured_shelves")!.visible = false;
    });
    const { sections } = applyHomeLayout({ sections: engineSections(), feed, layout });
    assert.equal(sections[0]!.key, "rail:TOP_PICKS");
    assert.equal(sections[0]!.kind === "shelf" && sections[0]!.title, "Bestsellers");
    assert.deepEqual(sections[0]!.frame, { group: "top_picks", background: "peach", spacing: "relaxed" });
    assert.equal(keys(sections).includes("offers"), false);
    // Featured shelves (Grocery by priority, Snacks by featuredCategoryIds) are hidden; the other shelf stays.
    assert.equal(keys(sections).includes(`category:${grocery.id}`), false);
    assert.equal(keys(sections).includes(`category:${snacks.id}`), false);
    assert.equal(keys(sections).includes(`category:${care.id}`), true);
  });

  it("the promotional area can be hidden", () => {
    const result = applyHomeLayout({ sections: engineSections(), feed, layout: edit((l) => void (l.hero.promo.visible = false)) });
    assert.deepEqual(result.promo, []);
  });

  it("the food carousel shows three cards by default and the admin's number otherwise", () => {
    const food = (layout: HomeLayoutContent) => {
      const section = applyHomeLayout({ sections: engineSections(6), feed, layout }).sections.find((s) => s.kind === "foodCarousel");
      assert.ok(section && section.kind === "foodCarousel");
      return section;
    };
    assert.equal(FOOD_CAROUSEL_DEFAULT_CARDS, 3);
    assert.equal(food(defaults()).slides.length, 3);
    assert.equal(food(edit((l) => void (l.sections.find((s) => s.key === "food_carousel")!.maxItems = 5))).slides.length, 5);
    assert.equal(food(edit((l) => void (l.sections.find((s) => s.key === "food_carousel")!.title = "Hungry?"))).title, "Hungry?");
  });

  it("chosen categories in their order and count; Home and the Categories page never affect each other", () => {
    const layout = edit((l) => {
      l.categoryPlacements.home_top = { ...l.categoryPlacements.home_top, mode: "manual", paths: ["personal-care", "grocery"], maxItems: 1, columns: 3 };
      l.categoryPlacements.categories_page = { ...l.categoryPlacements.categories_page, mode: "manual", paths: ["snacks", "grocery", "personal-care"], maxItems: 2, columns: 5 };
    });
    const top = grid(applyHomeLayout({ sections: engineSections(), feed, layout }).sections, "grid:top");
    assert.deepEqual(top.tiles.map((t) => t.label), ["Personal Care"]);
    assert.equal(top.display.columns, 3);
    const page = arrangeCategoriesPage(tops, layout);
    assert.deepEqual(page.categories.map((c) => c.name), ["Snacks", "Grocery"]);
    assert.equal(page.columns, 5);
  });

  it("rows limit a grid together with its columns", () => {
    const layout = edit((l) => void (l.categoryPlacements.home_explore = { ...l.categoryPlacements.home_explore, columns: 3, rows: 1 }));
    assert.equal(grid(applyHomeLayout({ sections: engineSections(), feed, layout }).sections, "grid:explore").tiles.length, 3);
  });

  it("a hidden category leaves every placement; a hidden parent takes its subcategories with it", () => {
    const layout = edit((l) => {
      l.categoryStyles = [
        { path: "snacks", displayName: null, displayNameHi: null, tileBackground: null, textColor: null, hidden: true },
        { path: "grocery/atta", displayName: null, displayNameHi: null, tileBackground: null, textColor: null, hidden: true },
      ];
    });
    const { sections } = applyHomeLayout({ sections: engineSections(), feed, layout });
    assert.deepEqual(grid(sections, "grid:top").tiles.map((t) => t.label), ["Grocery", "Personal Care"]);
    assert.deepEqual(grid(sections, "grid:explore").tiles.map((t) => t.label), ["Rice", "Soap"]);
    const page = arrangeCategoriesPage(tops, layout);
    assert.deepEqual(page.categories.map((c) => c.name), ["Grocery", "Personal Care"]);
    assert.deepEqual(page.categories[0]!.children!.map((c) => c.name), ["Rice"]);
  });

  it("display names in English and Hindi, and per-category colours", () => {
    const layout = edit((l) => {
      l.categoryStyles = [{ path: "grocery", displayName: "Kirana", displayNameHi: "किराना स्टोर", tileBackground: "yellow", textColor: "dark", hidden: false }];
    });
    const en = grid(applyHomeLayout({ sections: engineSections(), feed, layout }).sections, "grid:top").tiles[0]!;
    assert.deepEqual([en.label, en.tileBackground, en.textColor], ["Kirana", "yellow", "dark"]);
    const hi = grid(applyHomeLayout({ sections: engineSections(), feed, layout, language: "hi" }).sections, "grid:explore").tiles[0]!;
    assert.equal(hi.label, "चावल"); // no display name for rice → its own Hindi name
    assert.equal(grid(applyHomeLayout({ sections: engineSections(), feed, layout, language: "hi" }).sections, "grid:top").tiles[0]!.label, "किराना स्टोर");
    assert.equal(arrangeCategoriesPage(tops, layout).categories[0]!.name, "Kirana");
  });

  it("an engine section this layout does not know is kept, before the footer", () => {
    const sections = engineSections();
    sections.splice(3, 0, { kind: "stores", key: "stores" });
    const result = applyHomeLayout({ sections, feed, layout: defaults() });
    assert.deepEqual(keys(result.sections).slice(-2), ["stores", "footer"]);
  });

  it("a malformed layout from the server still yields a complete Home (resolveHomeLayout first)", () => {
    const result = applyHomeLayout({ sections: engineSections(), feed, layout: resolveHomeLayout({ sections: "nope", hero: 7 }) });
    assert.equal(result.sections.length, applyHomeLayout({ sections: engineSections(), feed, layout: defaults() }).sections.length);
  });
});

describe("applyHomeLayout — latest products and the Food section destination", () => {
  it("the latest-products section is always there (unless hidden), with the admin's heading and count", () => {
    const latest = (layout: HomeLayoutContent) => applyHomeLayout({ sections: engineSections(), feed, layout }).sections.find((s) => s.kind === "latest");
    const byDefault = latest(defaults());
    assert.ok(byDefault && byDefault.kind === "latest");
    assert.deepEqual([byDefault.title, byDefault.maxItems], [LATEST_DEFAULT_TITLE, LATEST_DEFAULT_COUNT]);
    const set = latest(edit((l) => {
      const section = l.sections.find((x) => x.key === "recently_added")!;
      section.title = "New in";
      section.maxItems = 6;
    }));
    assert.ok(set && set.kind === "latest");
    assert.deepEqual([set.title, set.maxItems], ["New in", 6]);
    assert.equal(latest(edit((l) => void (l.sections.find((x) => x.key === "recently_added")!.visible = false))), undefined);
    // It replaces the engine's de-duplicated rail — never both.
    assert.equal(keys(applyHomeLayout({ sections: engineSections(), feed, layout: defaults() }).sections).includes("rail:RECENTLY_ADDED"), false);
  });

  it("a banner set to open the Food section opens Food, wherever on Home it shows; others keep their action", () => {
    const banner = (id: string, actionType: string) => ({ id, imageUrl: "x", imageWidth: 2, imageHeight: 1, title: id, subtitle: null, actionType, actionValue: null }) as never;
    const withBanners = { ...feed, banners: [banner("top1", "FOOD"), banner("top2", "NONE")], sectionBanners: { home_bottom: [banner("bottom", "FOOD")] } } as HomeFeedDto;
    const result = applyHomeLayout({ sections: engineSections(), feed: withBanners, layout: defaults() });
    assert.deepEqual(result.promo.map((s) => s.action.type), ["food", "none"]);
    const bottom = result.sections.find((s) => s.key === "banners:bottom");
    assert.ok(bottom && bottom.kind === "banners");
    assert.equal(bottom.slides[0]!.action.type, "food");
  });
});
