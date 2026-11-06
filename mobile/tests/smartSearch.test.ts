/**
 * Smart Search in the app — run with `npm run test:unit`. The ranking rules
 * themselves are tested in the backend (tests/unit/smart-search.test.ts,
 * tests/integration/smart-search.test.ts); this checks that the app's own
 * on-device searches use them, and that the Food screen asks the server.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { suggestSearchTerms } from "../src/lib/searchSuggestions";
import { buildCategoryTree, searchCategories } from "../src/screens/catalog/categorySections";
import { smartSearch } from "../src/shared/search-match";
import type { CategoryDto } from "../src/shared";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

function category(id: string, name: string, parentId: string | null, nameHi: string | null = null): CategoryDto {
  return { id, name, nameHi, parentId, slug: id, path: id, imageUrl: null, displayOrder: 0, productCount: 1 } as unknown as CategoryDto;
}

describe("search suggestions", () => {
  it("suggests the Hinglish, Hindi and English names from the shared dictionary", () => {
    const labels = suggestSearchTerms("alo").map((s) => s.label);
    assert.deepEqual(labels.slice(0, 3), ["Aloo", "आलू", "Potato"]);
  });

  it("matches spelling variants and Hindi prefixes", () => {
    assert.ok(suggestSearchTerms("aalu").some((s) => s.term === "आलू"));
    assert.ok(suggestSearchTerms("के").some((s) => s.term === "banana"));
    assert.deepEqual(suggestSearchTerms("   "), []);
  });
});

describe("category search", () => {
  const tree = buildCategoryTree([
    category("veg", "Vegetables & Fruits", null),
    category("fruits", "Fruits", "veg", "फल"),
    category("greens", "Vegetables", "veg", "सब्ज़ियाँ"),
    category("grocery", "Grocery", null),
    category("atta", "Atta, Rice & Dal", "grocery"),
  ]);

  it("finds categories by Hinglish, Hindi, synonyms and typos", () => {
    assert.equal(searchCategories(tree, "sabji")[0]?.category.id, "greens");
    assert.equal(searchCategories(tree, "phal")[0]?.category.id, "fruits");
    assert.equal(searchCategories(tree, "chawal")[0]?.category.id, "atta");
    assert.equal(searchCategories(tree, "vegitables")[0]?.category.id, "greens");
    assert.deepEqual(searchCategories(tree, "xyzzy"), []);
    assert.deepEqual(searchCategories(tree, ""), []);
  });
});

describe("in-app lists use the shared engine", () => {
  it("ranks the exact item first", () => {
    const items = [{ name: "Banana Chips" }, { name: "Banana (केला)" }];
    const found = smartSearch(items, "kela", (item) => [{ text: item.name, source: "NAME" }]);
    assert.equal(found[0]?.name, "Banana (केला)");
  });

  it("the Food screen searches dishes on the server, debounced, without blanking the list", () => {
    const screen = read("src/screens/food/FoodScreen.tsx");
    assert.match(screen, /useRestaurantSearch\(debouncedSearch/);
    assert.match(screen, /smartSearch\(restaurants, term/);
    assert.match(screen, /!remote\.isPlaceholderData/);
    const queries = read("src/lib/queries.ts");
    assert.match(queries, /\/restaurants\/search\?q=\$\{encodeURIComponent\(term\)\}/);
    assert.match(queries, /queryKey: \["restaurant-search", term, filter\]/);
  });
});
