/**
 * Home Page Builder's ADDED sections on the app's Home
 * (src/screens/home/homeLayout.ts) — product shelves drawn from
 * GET /content/home-shelves and category sections — run with
 * `npm run test:unit` (Node's test runner; no React Native).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HOME_LAYOUT,
  PRODUCT_SHELF_MIN_GRID_CARD_DP,
  addHomeSection,
  createHomeSection,
  moveHomeSection,
  resolveHomeLayout,
  type CategoryDto,
  type HomeFeedDto,
  type HomeLayoutContent,
  type ProductShelfConfig,
  type ProductSummaryDto,
} from "@shared";
import type { HomeSection } from "../src/screens/home/homeEngine.ts";
import { applyHomeLayout, productGridColumns, type LaidOutSection } from "../src/screens/home/homeLayout.ts";

/* Fixtures ------------------------------------------------------------------ */

let ids = 0;
const category = (name: string, slug: string, children: CategoryDto[] = []): CategoryDto => ({
  id: `c${++ids}`,
  parentId: null,
  name,
  nameHi: null,
  slug,
  imageUrl: null,
  depth: children.length ? 0 : 1,
  displayOrder: ids,
  children,
});
const vegetables = category("Vegetables", "vegetables");
const fruits = category("Fruits", "fruits");
const rice = category("Rice", "rice");
const fresh = category("Vegetables & Fruits", "vegetables-fruits", [vegetables, fruits]);
const grocery = category("Grocery", "grocery", [rice]);
for (const top of [fresh, grocery]) for (const child of top.children ?? []) child.parentId = top.id;

const feed = { banners: [], categories: [grocery, fresh], featuredCategoryIds: [], rails: [], categoryRails: [] } as unknown as HomeFeedDto;
const engine: HomeSection[] = [{ kind: "footer", key: "footer" } as HomeSection];

const product = (id: string, inStock = true): ProductSummaryDto =>
  ({ id, name: `Product ${id}`, defaultVariant: { id: `v-${id}`, inStock, pricePaise: 5000 } }) as unknown as ProductSummaryDto;

function withShelf(id: string, title: string | null, shelf: Partial<ProductShelfConfig>, layout: HomeLayoutContent = resolveHomeLayout(DEFAULT_HOME_LAYOUT)): HomeLayoutContent {
  const section = createHomeSection("product_shelf", id, { title, shelf });
  return resolveHomeLayout(addHomeSection(layout, section, 0));
}

const run = (layout: HomeLayoutContent, shelves: Record<string, ProductSummaryDto[]> | null) => applyHomeLayout({ sections: engine, feed, layout, shelves }).sections;
const find = (sections: LaidOutSection[], key: string) => sections.find((section) => section.key === key);

/* Tests ---------------------------------------------------------------------- */

describe("product shelves", () => {
  it("draws each shelf where the admin put it, with its own products, count and layout", () => {
    let layout = withShelf("shelf-grocery", "Grocery", { source: "random", categoryPaths: ["grocery"], count: 2 });
    layout = withShelf("shelf-veg", "Vegetables", { source: "latest", categoryPaths: ["vegetables-fruits/vegetables"], layout: "grid", columns: 3, cardSize: "large", gap: "wide" }, layout);
    // The admin moves Grocery below Vegetables.
    layout = resolveHomeLayout(moveHomeSection(layout, 1, 0));
    const sections = run(layout, { "shelf-grocery": [product("a"), product("b"), product("c")], "shelf-veg": [product("t")] });
    const shelves = sections.filter((section) => section.kind === "productShelf");
    assert.deepEqual(shelves.map((section) => section.key), ["shelf:shelf-grocery", "shelf:shelf-veg"]);
    const [groceryShelf, vegShelf] = shelves as Extract<LaidOutSection, { kind: "productShelf" }>[];
    assert.deepEqual(groceryShelf!.products.map((p) => p.id), ["a", "b"]);
    assert.deepEqual(groceryShelf!.display, { layout: "carousel", columns: 2, cardWidth: 132, gap: 8 });
    assert.deepEqual(vegShelf!.display, { layout: "grid", columns: 3, cardWidth: 152, gap: 12 });
  });

  it("leaves out a shelf with nothing buyable, one still loading, or after a failed request — the rest of Home stays", () => {
    const layout = withShelf("shelf-a", "Picks", { source: "manual" });
    assert.equal(find(run(layout, { "shelf-a": [product("x", false)] }), "shelf:shelf-a"), undefined);
    assert.equal(find(run(layout, {}), "shelf:shelf-a"), undefined);
    const failed = run(layout, null);
    assert.equal(find(failed, "shelf:shelf-a"), undefined);
    assert.ok(find(failed, "footer"), "the footer (and the rest of Home) is still there");
  });

  it("never shows a product twice in a shelf", () => {
    const layout = withShelf("shelf-a", "Picks", { count: 10 });
    const shelf = find(run(layout, { "shelf-a": [product("a"), product("a"), product("b")] }), "shelf:shelf-a") as Extract<LaidOutSection, { kind: "productShelf" }>;
    assert.deepEqual(shelf.products.map((p) => p.id), ["a", "b"]);
  });

  it("hidden shelves are not drawn", () => {
    const layout = structuredClone(withShelf("shelf-a", "Picks", {}));
    layout.sections.find((section) => section.id === "shelf-a")!.visible = false;
    assert.equal(find(run(resolveHomeLayout(layout), { "shelf-a": [product("a")] }), "shelf:shelf-a"), undefined);
  });

  it("View All opens the shelf's own category, the latest or top-picks listing — or is hidden when it does not fit", () => {
    const viewAll = (shelf: Partial<ProductShelfConfig>) => {
      const laid = find(run(withShelf("shelf-a", "Shelf", shelf), { "shelf-a": [product("a")] }), "shelf:shelf-a") as Extract<LaidOutSection, { kind: "productShelf" }>;
      return laid.viewAll;
    };
    assert.deepEqual(viewAll({ categoryPaths: ["vegetables-fruits/fruits"], viewAll: { type: "category", path: "vegetables-fruits/fruits" } }), { type: "category", categoryId: fruits.id });
    // A subcategory shelf can open its main category — never a sibling.
    assert.deepEqual(viewAll({ categoryPaths: ["vegetables-fruits/fruits"], viewAll: { type: "category", path: "vegetables-fruits" } }), { type: "category", categoryId: fresh.id });
    assert.equal(viewAll({ categoryPaths: ["vegetables-fruits/fruits"], viewAll: { type: "category", path: "vegetables-fruits/vegetables" } }), null);
    assert.deepEqual(viewAll({ source: "latest", viewAll: { type: "latest", path: null } }), { type: "rail", railKey: "RECENTLY_ADDED", title: "Shelf" });
    assert.deepEqual(viewAll({ source: "bestselling", viewAll: { type: "bestselling", path: null } }), { type: "rail", railKey: "TOP_PICKS", title: "Shelf" });
    assert.equal(viewAll({ source: "random", viewAll: { type: "latest", path: null } }), null);
    // A category that is no longer in the catalogue: no button rather than a wrong one.
    assert.equal(viewAll({ categoryPaths: ["kitchen"], viewAll: { type: "category", path: "kitchen" } }), null);
  });

  it("a shelf without a heading is named after what it shows", () => {
    const laid = find(run(withShelf("shelf-a", null, { source: "latest", categoryPaths: ["grocery"] }), { "shelf-a": [product("a")] }), "shelf:shelf-a") as Extract<LaidOutSection, { kind: "productShelf" }>;
    assert.equal(laid.title, "Latest in Grocery");
  });

  it("an older app's layout (no added sections) and a newer server's unknown section type both leave Home intact", () => {
    const layout = resolveHomeLayout({ ...DEFAULT_HOME_LAYOUT, sections: [...DEFAULT_HOME_LAYOUT.sections, { id: "video-1", key: "video_block" }] });
    const sections = run(layout, {});
    assert.ok(!sections.some((section) => (section.key as string).includes("video")));
    assert.equal(sections.at(-1)!.key, "footer");
  });
});

describe("category sections", () => {
  it("chosen categories and subcategories in order, independent of the built-in grids", () => {
    const layout = resolveHomeLayout(
      addHomeSection(resolveHomeLayout(DEFAULT_HOME_LAYOUT), createHomeSection("category_section", "cats-fresh", { title: "Fresh picks", categories: { paths: ["vegetables-fruits/fruits", "grocery", "vegetables-fruits/vegetables"], columns: 5, textColor: "light" } }), 0),
    );
    const grid = find(run(layout, null), "categories:cats-fresh");
    assert.ok(grid && grid.kind === "categoryGrid");
    assert.deepEqual(grid.tiles.map((tile) => tile.category.id), [fruits.id, grocery.id, vegetables.id]);
    assert.equal(grid.display.columns, 5);
    assert.equal(grid.display.textColor, "light");
  });

  it("does not take categories away from the built-in grids (each list is on its own)", () => {
    const engineWithGrid: HomeSection[] = [
      { kind: "categoryGrid", key: "grid:top", title: "Top Categories", categories: [grocery, fresh], columns: 4, viewAll: { type: "allCategories" } } as HomeSection,
      ...engine,
    ];
    const layout = resolveHomeLayout(
      addHomeSection(resolveHomeLayout(DEFAULT_HOME_LAYOUT), createHomeSection("category_section", "cats-g", { categories: { paths: ["grocery"] } }), 0),
    );
    const sections = applyHomeLayout({ sections: engineWithGrid, feed, layout, shelves: null }).sections;
    const top = find(sections, "grid:top");
    assert.ok(top && top.kind === "categoryGrid");
    assert.deepEqual(top.tiles.map((tile) => tile.category.id), [grocery.id, fresh.id]);
  });

  it("automatic: subcategories taking turns between main categories", () => {
    const layout = resolveHomeLayout(addHomeSection(resolveHomeLayout(DEFAULT_HOME_LAYOUT), createHomeSection("category_section", "cats-sub", { categories: { mode: "auto", level: "sub", maxItems: 3 } }), 0));
    const grid = find(run(layout, null), "categories:cats-sub");
    assert.ok(grid && grid.kind === "categoryGrid");
    assert.deepEqual(grid.tiles.map((tile) => tile.category.name), ["Rice", "Vegetables", "Fruits"]);
  });

  it("a section with no live categories is left out", () => {
    const layout = resolveHomeLayout(addHomeSection(resolveHomeLayout(DEFAULT_HOME_LAYOUT), createHomeSection("category_section", "cats-none", { categories: { paths: ["kitchen"] } }), 0));
    assert.equal(find(run(layout, null), "categories:cats-none"), undefined);
  });
});

describe("productGridColumns — no overflow, no squeezed cards", () => {
  it("keeps 3 per row where it fits and falls back to 2 on a narrow phone", () => {
    assert.deepEqual(productGridColumns(3, 390 - 24, 8), { columns: 3, cardWidth: 116 });
    const narrow = productGridColumns(3, 320 - 24, 8);
    assert.equal(narrow.columns, 2);
    assert.ok(narrow.cardWidth >= PRODUCT_SHELF_MIN_GRID_CARD_DP);
    // Never wider than the space: columns × width + gaps ≤ inner width.
    for (const width of [280, 320, 360, 412, 600]) {
      for (const requested of [2, 3]) {
        const { columns, cardWidth } = productGridColumns(requested, width - 24, 12);
        assert.ok(columns * cardWidth + (columns - 1) * 12 <= width - 24, `${requested} at ${width}`);
      }
    }
  });
});
