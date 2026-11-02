/**
 * Category product listings load EVERY page (src/lib/listingPages.ts, the
 * Categories screen's wiring) — run with `npm run test:unit`. The screens
 * need a device, so their wiring is checked from source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { uniqueListingItems } from "../src/lib/listingPages.ts";

const page = (...ids: string[]) => ({ items: ids.map((id) => ({ id })) });
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("Listing pages, flattened", () => {
  it("every page's products, in page order", () => {
    assert.deepEqual(ids(uniqueListingItems([page("a", "b"), page("c", "d"), page("e")])), ["a", "b", "c", "d", "e"]);
  });

  it("a product that reached two pages (its sort value changed mid-scroll) appears once, where it first did", () => {
    assert.deepEqual(ids(uniqueListingItems([page("a", "b"), page("b", "c")])), ["a", "b", "c"]);
  });

  it("nothing loaded yet / empty pages: an empty list", () => {
    assert.deepEqual(uniqueListingItems(undefined), []);
    assert.deepEqual(uniqueListingItems([page(), page()]), []);
  });

  it("no arbitrary cap: a long listing keeps every product", () => {
    const pages = Array.from({ length: 10 }, (_, p) => page(...Array.from({ length: 30 }, (_, i) => `p${p}-${i}`)));
    assert.equal(uniqueListingItems(pages).length, 300);
  });
});

describe("Categories screen wiring", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
  const screen = read("src/screens/catalog/CategoriesScreen.tsx");
  const queries = read("src/lib/queries.ts");

  it("the subcategory / leaf pane is the paginated listing, not a single first page", () => {
    assert.doesNotMatch(screen, /useProducts\(/);
    assert.doesNotMatch(queries, /export function useProducts\(/);
    assert.match(screen, /useCategoryListing\(activeCategoryId \?\? '', \{\n\s*pageSize: CATEGORY_PAGE_SIZE,/);
    assert.match(screen, /uniqueListingItems\(products\.data\.pages\)/);
  });

  it("both product grids load the next page near the end and show a spinner / retry while doing so", () => {
    assert.equal(screen.match(/onEndReached=\{\(\) => loadNextPage\((products|listing)\)\}/g)?.length, 2);
    assert.equal(screen.match(/<ListingFooter listing=\{(products|listing)\} \/>/g)?.length, 2);
    assert.match(screen, /if \(!listing\.hasNextPage \|\| listing\.isFetchingNextPage \|\| listing\.isFetchNextPageError\) return;/);
  });

  it("the sidebar prefetch warms the same paginated entry the pane reads — never re-requests pages already loaded", () => {
    assert.match(screen, /prefetchCategoryListing\(queryClient, child\.id\)/);
    assert.match(queries, /const options = categoryListingOptions\(categoryId, CATEGORY_PAGE_SIZE\);\n\s*if \(queryClient\.getQueryData\(options\.queryKey\) !== undefined\) return;\n\s*void queryClient\.prefetchInfiniteQuery\(options\);/);
  });

  it("a different category gets its own list (own pages, own cursor, scrolled to its top)", () => {
    assert.match(queries, /\["category-listing", CATALOG_CACHE_VERSION, categoryId, pageSize\]/);
    assert.match(screen, /key=\{`grid-\$\{productGridColumns\}-\$\{activeCategoryId\}`\}/);
    assert.match(screen, /key=\{`main-\$\{columns\}-\$\{category\.id\}`\}/);
  });

  it("the store-availability refresh no longer names the removed products query, and still refreshes the listings", () => {
    const refresh = read("src/lib/storeAvailability.ts");
    assert.doesNotMatch(refresh, /\["products"\]/);
    assert.match(refresh, /\["category-listing"\]/);
  });

  it("the server cursor drives paging until it reports no more", () => {
    assert.match(queries, /last\.hasMore && last\.nextCursor \? last\.nextCursor : undefined/);
    assert.match(queries, /if \(pageParam\) query\.set\("cursor", pageParam\);/);
  });
});
