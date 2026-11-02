/**
 * One loading-skeleton style across the app (src/components/Skeleton.tsx):
 * the light-green bones and single pulse, no leftover grey skeletons or
 * spinners where a product / restaurant list loads. Source checks — the
 * screens need a device. Run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const SCREENS_WITH_SKELETONS = [
  "src/components/ProductCardSkeleton.tsx",
  "src/components/FoodRestaurantCard.tsx",
  "src/screens/home/sections/HomeSkeleton.tsx",
  "src/screens/catalog/CategoriesScreen.tsx",
  "src/screens/food/FoodScreen.tsx",
  "src/screens/food/RestaurantMenuScreen.tsx",
];

describe("Skeleton style", () => {
  it("the shared bone is the theme's light green", () => {
    assert.match(read("src/components/Skeleton.tsx"), /export const SKELETON_COLOR = colors\.primarySurface;/);
  });

  it("every placeholder is built from the shared bones — no private grey bone or shimmer left", () => {
    for (const file of SCREENS_WITH_SKELETONS) {
      const src = read(file);
      assert.match(src, /from "(\.\/Skeleton|@\/components\/Skeleton)"|from '@\/components\/Skeleton'/, file);
      assert.doesNotMatch(src, /#F3F4F6|#ECEEED|ShimmerSweep|function Bone\(/, file);
    }
  });

  it("no layout entrance animation around a skeleton (it once outlived its data)", () => {
    assert.doesNotMatch(read("src/components/ProductCardSkeleton.tsx"), /entering=/);
  });

  it("search results and the Categories landing load with skeletons, not a spinner", () => {
    assert.doesNotMatch(read("src/screens/catalog/SearchScreen.tsx"), /<Loading \/>/);
    assert.doesNotMatch(read("src/screens/catalog/CategoriesScreen.tsx"), /Loading categories…/);
    assert.match(read("src/screens/catalog/CategoriesScreen.tsx"), /<CategoryLandingSkeleton \/>/);
  });

  it("search results' placeholder keeps the results line's place above the grid", () => {
    const search = read("src/screens/catalog/SearchScreen.tsx");
    assert.match(search, /firstLoad \|\| \(items\.length === 0 && results\.isFetching\) \? \(\n\s*<SearchResultsSkeleton columns=\{columns\} \/>/);
    assert.match(search, /function SearchResultsSkeleton[\s\S]*?<View style=\{styles\.resultsHeader\}>/);
  });

  it("menu rows' placeholder reserves the ADD button's overhang, like the loaded rows", () => {
    assert.match(read("src/screens/food/RestaurantMenuScreen.tsx"), /<View style=\{\[styles\.action, styles\.stepperSize\]\} \/>/);
  });

  it("the Food list's placeholder is the restaurant card's own frame", () => {
    assert.match(read("src/screens/food/FoodScreen.tsx"), /<FoodRestaurantCardSkeleton progress=\{progress\} \/>/);
  });
});
