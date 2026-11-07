/**
 * Three fixes — run with `npm run test:unit`:
 *
 *   1. one product-card skeleton everywhere product cards load (Home shelves,
 *      Latest, Home Page Builder shelves, related products, pagination);
 *   2. the product page's sticky footer: price + MRP on one row, the weight
 *      alone under them;
 *   3. the variant sheet closes the moment Add is accepted locally (the cart
 *      actions are optimistic; a refusal rolls the line back and says why),
 *      never adds twice.
 *
 * The rules are pure functions; the screens need a device, so their wiring
 * is checked on the source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_HOME_LAYOUT, addHomeSection, createHomeSection, resolveHomeLayout, type HomeFeedDto, type ProductSummaryDto } from "@shared";
import type { HomeSection } from "../src/screens/home/homeEngine.ts";
import { applyHomeLayout } from "../src/screens/home/homeLayout.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* -------------------------------------------------------------------------- */
/* 1. Loading                                                                 */
/* -------------------------------------------------------------------------- */

describe("1. one product-card skeleton", () => {
  const feed = { banners: [], categories: [], featuredCategoryIds: [], rails: [], categoryRails: [] } as unknown as HomeFeedDto;
  const engine: HomeSection[] = [{ kind: "footer", key: "footer" } as HomeSection];
  const layout = resolveHomeLayout(
    addHomeSection(resolveHomeLayout(DEFAULT_HOME_LAYOUT), createHomeSection("product_shelf", "fresh", { title: "Fresh picks", shelf: { layout: "grid", columns: 3 } }), 0),
  );
  const product = (id: string) =>
    ({ id, name: id, defaultVariant: { id: `v-${id}`, inStock: true, pricePaise: 5000 } }) as unknown as ProductSummaryDto;

  it("a Home Page Builder shelf shows its skeleton (title + layout) while its products load", () => {
    const sections = applyHomeLayout({ sections: engine, feed, layout, shelves: null, shelvesLoading: true }).sections;
    const loading = sections.find((section) => section.key === "shelf:fresh");
    assert.equal(loading?.kind, "productShelfLoading");
    if (loading?.kind !== "productShelfLoading") return;
    assert.equal(loading.title, "Fresh picks");
    assert.equal(loading.display.layout, "grid");
    assert.equal(loading.display.columns, 3);
  });

  it("then the real shelf in the same place; a failed / older server still shows nothing (no stuck skeleton)", () => {
    const loaded = applyHomeLayout({ sections: engine, feed, layout, shelves: { fresh: [product("a")] }, shelvesLoading: false }).sections;
    assert.equal(loaded.find((section) => section.key === "shelf:fresh")?.kind, "productShelf");
    const failed = applyHomeLayout({ sections: engine, feed, layout, shelves: null, shelvesLoading: false }).sections;
    assert.equal(failed.find((section) => section.key === "shelf:fresh"), undefined);
  });

  it("Home renders that loading section with the shared shelf skeleton; Latest Products too", () => {
    const home = read("src/screens/home/HomeScreen.tsx");
    assert.match(home, /case "productShelfLoading":[\s\S]*?<ShelfLoading title=\{item\.title\} subtitle=\{item\.subtitle\} display=\{item\.display\} \/>/);
    assert.match(home, /shelvesLoading: homeShelvesLoading/);
    const latest = read("src/screens/home/sections/LatestProducts.tsx");
    assert.match(latest, /if \(query\.isPending\) return <ShelfLoading title=\{title\} subtitle=\{subtitle\} \/>;\n\s*if \(!section\) return null;/);
  });

  it("the shelf skeleton is made of the real card's skeleton, at the shelf's card width / columns, one row only", () => {
    const shelf = read("src/screens/home/sections/HomeSkeleton.tsx");
    assert.match(shelf, /<ProductCardSkeleton progress=\{progress\} \/>/);
    assert.match(shelf, /productGridColumns\(display\.columns, screenWidth - PANEL_PADDING \* 2, gap\)/);
    assert.match(shelf, /const cards = grid \? grid\.columns : count;/);
    assert.match(shelf, /<SectionHeader title=\{title\} subtitle=\{subtitle\} \/>/);
  });

  it("every product grid loads with ProductGridSkeleton (Categories, subcategories, View All, Search, Store, related)", () => {
    for (const file of [
      "src/screens/catalog/CategoriesScreen.tsx",
      "src/screens/catalog/RailProductsScreen.tsx",
      "src/screens/catalog/SearchScreen.tsx",
      "src/screens/catalog/StoreScreen.tsx",
      "src/screens/catalog/ProductDetailScreen.tsx",
    ]) {
      assert.match(read(file), /<ProductGridSkeleton/, file);
    }
    const detail = read("src/screens/catalog/ProductDetailScreen.tsx");
    assert.match(detail, /\{related\.isPending && \([\s\S]*?You may also like[\s\S]*?<ProductGridSkeleton columns=\{relatedColumns\} count=\{relatedColumns\}/);
  });

  it("a next page shows one skeleton row under the loaded cards — no spinner, no full-page placeholder", () => {
    const card = read("src/components/ProductCardSkeleton.tsx");
    assert.match(card, /export function ProductPageSkeleton\(\{ columns \}: \{ columns: number \}\) \{\n\s*return <ProductGridSkeleton columns=\{columns\} count=\{columns\}/);
    const categories = read("src/screens/catalog/CategoriesScreen.tsx");
    assert.match(categories, /if \(listing\.isFetchingNextPage\) \{\n\s*return <ProductPageSkeleton columns=\{columns\} \/>;/);
    assert.equal((categories.match(/<ListingFooter listing=\{\w+\} columns=\{\w+\} \/>/g) ?? []).length, 2);
    assert.doesNotMatch(categories, /ActivityIndicator/);
    const store = read("src/screens/catalog/StoreScreen.tsx");
    assert.match(store, /products\.isFetchingNextPage \? <ProductPageSkeleton columns=\{columns\} \/> : undefined/);
    assert.doesNotMatch(store, /ActivityIndicator/);
    // The loaded cards stay: the footer is the list's footer, the data is untouched.
    assert.match(categories, /ListFooterComponent=\{items\.length > 0 \? <ListingFooter/);
  });

  it("the card skeleton is sized by its content, never flex: 1 (it collapsed outside a scrolling list)", () => {
    const card = read("src/components/ProductCardSkeleton.tsx");
    const style = card.slice(card.indexOf("  card: {"), card.indexOf("},", card.indexOf("  card: {")));
    assert.match(style, /width: "100%",/);
    assert.doesNotMatch(style, /flex: 1/);
    // Each card is a fixed share of its row, so rows never overlap.
    assert.match(card, /<View key=\{index\} style=\{\[styles\.cell, \{ width: `\$\{100 \/ columns\}%` \}\]\}>/);
  });

  it("the screens whose skeleton sits directly in the screen (not in a list) all use that shared grid", () => {
    // View All (Top Picks, Offers for You, Popular, …), Search, Store, the subcategory pane.
    assert.match(read("src/screens/catalog/RailProductsScreen.tsx"), /rail\.isLoading \? \(\n\s*<ProductGridSkeleton columns=\{columns\} \/>/);
    assert.match(read("src/screens/catalog/SearchScreen.tsx"), /<ProductGridSkeleton columns=\{columns\} style=\{styles\.resultsGridSkeleton\} \/>/);
    assert.match(read("src/screens/catalog/StoreScreen.tsx"), /products\.isLoading \? \(\n\s*<ProductGridSkeleton columns=\{columns\} \/>/);
    assert.match(read("src/screens/catalog/CategoriesScreen.tsx"), /\) : \(\n\s*<ProductsPlaceholder columns=\{productGridColumns\} \/>\n\s*\);/);
  });

  it("search keeps the last results while a newer term loads; superseded requests are cancelled", () => {
    const queries = read("src/lib/queries.ts");
    assert.match(queries, /queryFn: \(\{ signal \}\) =>\n\s*api\.get<CursorPage<ProductSummaryDto>>\(\n\s*`\/products\/search\?q=\$\{encodeURIComponent\(term\)\}&limit=30`,\n\s*\{ signal \},/);
    assert.match(queries, /placeholderData: keepPreviousData,/);
    const search = read("src/screens/catalog/SearchScreen.tsx");
    assert.match(search, /setTimeout\(\(\) => setDebouncedTerm\(text\), SEARCH_DEBOUNCE_MS\)/);
    // The skeleton only when there is nothing to show yet (first load, or nothing kept).
    assert.match(search, /\) : firstLoad \|\| \(items\.length === 0 && results\.isFetching\) \? \(/);
  });

  it("the card skeleton still mirrors ProductCard's boxes (no new design, no shimmer)", () => {
    const card = read("src/components/ProductCardSkeleton.tsx");
    assert.match(card, /import \{ IMAGE_BOX_ASPECT, IMAGE_BOX_MAX_HEIGHT \} from "\.\/ProductCard";/);
    assert.doesNotMatch(card, /Shimmer|entering=/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Product page footer                                                     */
/* -------------------------------------------------------------------------- */

describe("2. product page sticky footer", () => {
  const detail = read("src/screens/catalog/ProductDetailScreen.tsx");
  const block = detail.slice(detail.indexOf("<View style={styles.footerPriceBlock}>"), detail.indexOf("{/* RIGHT"));

  it("row 1: selling price, MRP and discount; row 2: the weight alone, directly under them", () => {
    const row1 = block.slice(block.indexOf("<View style={styles.footerPriceLine}>"), block.indexOf("{/* Row 2"));
    assert.match(row1, /formatPaise\(variant\.pricePaise\)/);
    assert.match(row1, /formatPaise\(variant\.mrpPaise\)/);
    assert.match(row1, /variant\.discountPercent\}% OFF/);
    assert.doesNotMatch(row1, /variantName/);
    const row2 = block.slice(block.indexOf("{/* Row 2"));
    assert.match(row2, /^\{\/\* Row 2[^\n]*\n\s*<AppText variant="caption" color=\{colors\.textSecondary\} numberOfLines=\{1\} style=\{styles\.footerUnit\}>\n\s*\{needsChoice && !chosen \? `Select a \$\{optionWord\}` : variant\.variantName\}/);
    // Only ONE price line now: the weight is never in a row beside anything.
    assert.equal((block.match(/styles\.footerPriceLine/g) ?? []).length, 1);
  });

  it("long prices / units never push the Add button: the price never shrinks, the rest truncates", () => {
    assert.match(detail, /footerPriceBlock: \{ flex: 1, minWidth: 0, justifyContent: "center" \}/);
    assert.match(detail, /footerPriceLine: \{ flexDirection: "row", alignItems: "baseline", gap: spacing\.xs \}/);
    assert.match(detail, /footerPrice: \{ flexShrink: 0 \}/);
    assert.match(detail, /footerMrp: \{ textDecorationLine: "line-through", flexShrink: 1 \}/);
    assert.match(detail, /footerActionBox: \{ width: 150 \}/);
  });

  it("content clears the footer and the Android navigation bar", () => {
    assert.match(detail, /paddingBottom: 140 \+ 76 \+ insets\.bottom,/);
    assert.match(detail, /style=\{\[styles\.footer, \{ paddingBottom: insets\.bottom \+ spacing\.base \}\]\}/);
  });

  it("price, MRP, discount and weight values are unchanged (display only)", () => {
    assert.match(block, /fromPrice \? `From \$\{formatPaise\(variant\.pricePaise\)\}` : formatPaise\(variant\.pricePaise\)/);
    assert.match(block, /variant\.mrpPaise > variant\.pricePaise &&/);
    assert.match(block, /variant\.discountPercent > 0 &&/);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Variant sheet                                                           */
/* -------------------------------------------------------------------------- */

describe("3. the variant sheet closes the moment Add is accepted", () => {
  const sheet = read("src/components/VariantSheet.tsx");
  const add = sheet.slice(sheet.indexOf("label={`Add to cart · "), sheet.indexOf("disabled={busy}", sheet.indexOf("label={`Add to cart · ")));

  it("closes right after the optimistic local add — never waits for the server", () => {
    assert.match(
      add,
      /if \(addAndFly\(cart\.add, flyToCart, chosen\.id, snapshotFromProduct\(source, chosen\), flightImage\)\) \{\n\s*addedFor\.current = openedAt;\n\s*onClose\(\);\n\s*\}/,
    );
    assert.doesNotMatch(sheet, /Adding…|confirmedCart|sheetAdd|setTimeout\(\(\) => setPendingAdd/);
  });

  it("a tap refused on the device (login, limit) keeps the sheet open", () => {
    // onClose only inside the `!== false` branch.
    assert.equal((add.match(/onClose\(\)/g) ?? []).length, 1);
  });

  it("rapid taps: one Add per opening, and none while this size is still saving", () => {
    assert.match(add, /if \(busy \|\| addedFor\.current === openedAt\) return;/);
    assert.match(sheet, /const openedAt = useVariantSheet\(\(state\) => state\.openedAt\);\n\s*const addedFor = useRef<number \| null>\(null\);/);
  });

  it("the add itself is the shared optimistic one: the line is local before `add` returns", () => {
    const actions = read("src/lib/useCartActions.ts");
    // add(): limit check, snapshot, pending qty (synchronous store write), then the request.
    assert.match(
      actions,
      /if \(!allowQty\(variantId, qtyForImpl\(variantId\) \+ 1, snapshot\)\) return false;\n\s*if \(snapshot\)\n\s*usePendingCartStore\.getState\(\)\.setSnapshot\(variantId, snapshot\);\n\s*setPendingQty|if \(!allowQty\(variantId, qtyForImpl\(variantId\) \+ 1, snapshot\)\) return false;\n\s*if \(snapshot\)\n\s*usePendingCartStore\.getState\(\)\.setSnapshot\(variantId, snapshot\);\n\s*setPending\(variantId, qtyForImpl\(variantId\) \+ 1\);\n\s*void dispatch\(variantId\);\n\s*return true;/,
    );
  });

  it("a refusal rolls the optimistic line back and says why (popup or the screen's cart notice)", () => {
    const actions = read("src/lib/useCartActions.ts");
    assert.match(actions, /if \(failed && usePendingCartStore\.getState\(\)\.pendingQty\[variantId\] === targetQty\) \{[\s\S]*?clearPending\(variantId\);/);
    for (const code of ["QTY_LIMIT_EXCEEDED", "PRICE_CHANGED", "SELLER_CLOSED"]) assert.match(actions, new RegExp(`ErrorCode\\.${code}`));
    assert.match(actions, /showCartNotice\(err\.message\);/);
    assert.match(actions, /setError\(\n\s*err instanceof ApiRequestError\n\s*\? err\.message\n\s*: "Could not update your cart\.",\n\s*\);/);
    // The popup lives above every screen; every screen with product cards shows the cart notice.
    assert.match(read("App.tsx"), /<CartNoticeToast \/>/);
    for (const file of [
      "src/screens/home/HomeScreen.tsx",
      "src/screens/catalog/CategoriesScreen.tsx",
      "src/screens/catalog/RailProductsScreen.tsx",
      "src/screens/catalog/SearchScreen.tsx",
      "src/screens/catalog/StoreScreen.tsx",
      "src/screens/catalog/ProductDetailScreen.tsx",
      "src/screens/wishlist/WishlistScreen.tsx",
    ]) {
      assert.match(read(file), /cart\.error|useCartError\(\)/, file);
    }
  });

  it("the add sends the chosen size's own listing, variant and the price the customer saw", () => {
    const actions = read("src/lib/useCartActions.ts");
    assert.match(actions, /sellerListingId: sellerListingId!,\n\s*qty: targetQty,[\s\S]*?variantId,\n\s*expectedPricePaise: firstAddSnapshot\?\.unitPricePaise,/);
    assert.match(add, /snapshotFromProduct\(source, chosen\)/);
  });

  it("one sheet for every product card (mounted once), its state reset per product", () => {
    assert.match(read("App.tsx"), /<VariantSheetHost \/>/);
    assert.match(sheet, /<SheetContent\n\s*key=\{current\.product\.id\}/);
  });
});
