/**
 * The customer app's smart variant display and direct add
 * (src/lib/cardVariant.ts) — which size a product card shows and what its +
 * does — and the variant sheet's opening path, run with `npm run test:unit`.
 * The rules are pure; the wiring (every list uses the one rule, the sheet
 * opens from the card's own data without requests) is checked on the source,
 * since the screens need a device. The server side:
 * backend tests/integration/customer-variant-display.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProductSummaryDto, VariantDto } from "@shared";
import { cardVariantsOf, isPurchasable, pageVariantsOf, purchasableVariantsOf, storeClosedHint } from "../src/lib/cardVariant.ts";
import { ownHoldsFromCart, withOwnHold } from "../src/lib/ownHolds.ts";
import { initialSelection, selectedVariant, variantOptions } from "../src/lib/variantSelection.ts";

/* Fixtures ------------------------------------------------------------------ */

const size = (name: string, pricePaise: number, extra: Partial<VariantDto> = {}): VariantDto =>
  ({
    id: `v-${name}`,
    sku: `SKU-${name}`,
    variantName: name,
    optionValues: {},
    isDefault: false,
    sellerListingId: `L-${name}`,
    sellerId: "S1",
    sellerName: "Store",
    mrpPaise: pricePaise + 500,
    pricePaise,
    discountPercent: 5,
    inStock: true,
    availableQty: 10,
    maxQtyPerOrder: 10,
    sellerAcceptingOrders: true,
    sellerClosedReason: null,
    sellerClosedMessage: null,
    ...extra,
  }) as VariantDto;

const soldOut = { inStock: false, availableQty: 0 } as const;

/**
 * A product as the server sends it: `variants` = the customer-visible ones
 * (hidden, deleted, pending and rejected ones are never sent), default first;
 * `defaultVariant` = the server's own pick.
 */
function productOf(variants: VariantDto[], serverPick?: VariantDto): ProductSummaryDto {
  const pick =
    serverPick ??
    variants.find((variant) => variant.isDefault && isPurchasable(variant)) ??
    variants.find(isPurchasable) ??
    variants.find((variant) => variant.isDefault) ??
    variants[0] ??
    null;
  return { id: "P1", name: "Orange", thumbUrl: null, defaultVariant: pick, variantCount: variants.length, variants, optionGroups: [] } as unknown as ProductSummaryDto;
}

/* Rules --------------------------------------------------------------------- */

describe("card size — display", () => {
  it("Orange: 500g (default) out of stock, 1kg available → the card shows 1kg at ₹65", () => {
    const card = cardVariantsOf(productOf([size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)]));
    assert.equal(card.shown?.variantName, "1kg");
    assert.equal(card.shown?.pricePaise, 6500);
  });

  it("the default is shown whenever it can be bought", () => {
    const card = cardVariantsOf(productOf([size("500g", 3400, { isDefault: true }), size("1kg", 6500)]));
    assert.equal(card.shown?.variantName, "500g");
  });

  it("the default hidden (never sent) → the next visible size", () => {
    // A hidden 500g is left out by the server: only 1kg arrives.
    const card = cardVariantsOf(productOf([size("1kg", 6500)]));
    assert.equal(card.shown?.variantName, "1kg");
  });

  it("the next size is the first buyable one in the server's order, not the cheapest", () => {
    const card = cardVariantsOf(productOf([size("500g", 3400, { isDefault: true, ...soldOut }), size("2kg", 12000), size("1kg", 6500)]));
    assert.equal(card.shown?.variantName, "2kg");
  });

  it("a size from a store not taking orders is not buyable", () => {
    const card = cardVariantsOf(productOf([size("500g", 3400, { isDefault: true, sellerAcceptingOrders: false }), size("1kg", 6500)]));
    assert.equal(card.shown?.variantName, "1kg");
    assert.equal(card.addMode, "direct");
  });

  it("weight and price always come from the same variant", () => {
    for (const variants of [
      [size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)],
      [size("500g", 3400, { isDefault: true }), size("1kg", 6500)],
      [size("1kg", 6500, { isDefault: true }), size("500g", 3400, soldOut)],
    ]) {
      const card = cardVariantsOf(productOf(variants));
      const original = variants.find((variant) => variant.id === card.shown?.id)!;
      assert.equal(card.shown?.variantName, original.variantName);
      assert.equal(card.shown?.pricePaise, original.pricePaise);
      assert.equal(card.shown?.sellerListingId, original.sellerListingId);
    }
  });

  it("all unavailable → the server's pick, marked unavailable, and no add", () => {
    const product = productOf([size("1kg", 12000, { isDefault: true, ...soldOut }), size("2kg", 23000, soldOut)]);
    const card = cardVariantsOf(product);
    assert.equal(card.shown?.variantName, "1kg");
    assert.equal(card.shown?.inStock, false);
    assert.equal(card.addMode, "none");
    assert.equal(card.direct, null);
  });

  it("all unavailable because the store closed → the card can say Store closed", () => {
    const closed = { sellerAcceptingOrders: false, sellerClosedMessage: "Opens at 8 AM" } as const;
    const card = cardVariantsOf(productOf([size("1kg", 12000, { isDefault: true, ...closed }), size("2kg", 23000, closed)]));
    assert.equal(card.addMode, "none");
    assert.equal(card.shown?.sellerAcceptingOrders, false);
  });

  it("the seller's default is never changed on the data the card was given", () => {
    const variants = [size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)];
    cardVariantsOf(productOf(variants));
    assert.equal(variants[0]!.isDefault, true);
    assert.equal(variants[1]!.isDefault, false);
  });
});

describe("card + — direct add or sheet", () => {
  it("two buyable sizes → the sheet", () => {
    const card = cardVariantsOf(productOf([size("500g", 3400, { isDefault: true }), size("1kg", 6500)]));
    assert.equal(card.addMode, "sheet");
    assert.equal(card.direct, null);
  });

  it("500g available + 1kg hidden → 500g added directly", () => {
    const card = cardVariantsOf(productOf([size("500g", 3400, { isDefault: true })]));
    assert.equal(card.addMode, "direct");
    assert.equal(card.direct?.id, "v-500g");
    assert.equal(card.direct?.sellerListingId, "L-500g");
    assert.equal(card.direct?.pricePaise, 3400);
  });

  it("500g out of stock + 1kg available → 1kg added directly, with its own listing and price", () => {
    const card = cardVariantsOf(productOf([size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)]));
    assert.equal(card.addMode, "direct");
    assert.equal(card.direct?.id, "v-1kg");
    assert.equal(card.direct?.sellerListingId, "L-1kg");
    assert.equal(card.direct?.pricePaise, 6500);
  });

  it("500g hidden + 1kg out of stock → no add", () => {
    const card = cardVariantsOf(productOf([size("1kg", 6500, { isDefault: true, ...soldOut })]));
    assert.equal(card.addMode, "none");
  });

  it("a single-size product adds directly, as before", () => {
    const card = cardVariantsOf(productOf([size("1 pc", 2000, { isDefault: true })]));
    assert.equal(card.addMode, "direct");
    assert.equal(card.direct?.id, "v-1 pc");
  });

  it("an older server (no variant list) keeps the sheet for several sizes and direct add for one", () => {
    const one = size("500g", 3400, { isDefault: true });
    const legacy = (variantCount: number) =>
      ({ id: "P1", name: "Orange", defaultVariant: one, variantCount }) as unknown as ProductSummaryDto;
    assert.equal(cardVariantsOf(legacy(2)).addMode, "sheet");
    assert.equal(cardVariantsOf(legacy(1)).addMode, "direct");
    assert.equal(cardVariantsOf({ ...legacy(2), defaultVariant: { ...one, ...soldOut } }).addMode, "none");
  });
});

describe("the customer's own held units", () => {
  it("their own checkout holds the last 500g: it stays buyable for them (and the sheet opens)", () => {
    const product = productOf([size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)]);
    const holds = ownHoldsFromCart([{ sellerListingId: "L-500g", availableQty: 1, inStock: true, heldForYouQty: 1 }]);
    const card = cardVariantsOf(product, (variant) => withOwnHold(variant, holds));
    assert.equal(card.shown?.variantName, "500g");
    assert.equal(card.addMode, "sheet");
  });

  it("nobody else's view changes", () => {
    const product = productOf([size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)]);
    assert.equal(cardVariantsOf(product).shown?.variantName, "1kg");
  });
});

describe("the variant sheet lists only what can be bought", () => {
  it("sold-out and closed-store sizes are not offered; one left is preselected", () => {
    const product = productOf([
      size("500g", 3400, { isDefault: true, ...soldOut }),
      size("1kg", 6500),
      size("2kg", 12000, { sellerAcceptingOrders: false }),
    ]);
    const variants = purchasableVariantsOf(product);
    assert.deepEqual(variants.map((variant) => variant.variantName), ["1kg"]);
    const options = variantOptions({ optionGroups: [], variants });
    assert.equal(selectedVariant(options, variants, initialSelection(options, variants))?.id, "v-1kg");
  });

  it("two buyable sizes: nothing preselected, each chip carries its own price", () => {
    const product = productOf([size("500g", 3400, { isDefault: true }), size("1kg", 6500)]);
    const variants = purchasableVariantsOf(product);
    const options = variantOptions({ optionGroups: [], variants });
    assert.deepEqual(initialSelection(options, variants), {});
    assert.deepEqual(options.groups[0]!.choices.map((choice) => choice.key), ["v-500g", "v-1kg"]);
  });
});

/* Wiring -------------------------------------------------------------------- */

describe("wiring", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  const sources = (dir: string): string[] =>
    readdirSync(path.join(ROOT, dir)).flatMap((name) => {
      const rel = path.join(dir, name);
      if (statSync(path.join(ROOT, rel)).isDirectory()) return sources(rel);
      return /\.tsx?$/.test(name) ? [rel] : [];
    });

  it("Home, categories, search, View All, stores and wishlist all render the one ProductCard (one rule)", () => {
    const screens = sources("src").filter((rel) => /<ProductCard\b(?!Skeleton)/.test(read(rel))).map((rel) => rel.replace(/\\/g, "/"));
    for (const expected of [
      "src/screens/home/sections/ProductShelf.tsx",
      "src/screens/catalog/CategoriesScreen.tsx",
      "src/screens/catalog/SearchScreen.tsx",
      "src/screens/catalog/RailProductsScreen.tsx",
      "src/screens/catalog/StoreScreen.tsx",
      "src/screens/wishlist/WishlistScreen.tsx",
    ]) {
      assert.ok(screens.includes(expected), expected);
    }
    const card = read("src/components/ProductCard.tsx");
    assert.match(card, /cardVariantsOf\(product, withOwnHold\)/);
    // No card anywhere decides from the default variant alone any more.
    assert.doesNotMatch(card, /const catalogueVariant = product\.defaultVariant/);
  });

  it("Home's 'only buyable products' uses the same rule", () => {
    for (const rel of ["src/screens/home/homeEngine.ts", "src/screens/home/homeLayout.ts", "src/screens/home/sections/LatestProducts.tsx"]) {
      const text = read(rel);
      assert.match(text, /purchasableVariantsOf\(product\)\.length > 0/, rel);
      assert.doesNotMatch(text, /product\.defaultVariant\.inStock/, rel);
    }
  });

  it("+ adds the exact buyable variant directly, or opens the sheet — never the default blindly", () => {
    const card = read("src/components/ProductCard.tsx");
    assert.match(card, /if \(addMode === "sheet"\) \{\n\s*openOptions\(\);/);
    assert.match(card, /addAndFly\(onAdd, flyToCart, direct\.id, snapshotFromProduct\(product, direct\), imageUrl\)/);
    assert.doesNotMatch(card, /onAdd\(variant\.id/);
  });

  it("a first add sends the variant and the price the customer saw; refusals refresh the lists", () => {
    const actions = read("src/lib/useCartActions.ts");
    assert.match(actions, /variantId,\n\s*expectedPricePaise: firstAddSnapshot\?\.unitPricePaise,/);
    assert.match(actions, /err\.code === ErrorCode\.PRICE_CHANGED \|\| err\.code === ErrorCode\.PRODUCT_UNAVAILABLE/);
    assert.match(actions, /revalidateProductAvailability\(\);/);
    const queries = read("src/lib/queries.ts");
    assert.match(queries, /\.\.\.\(input\.variantId \? \{ variantId: input\.variantId \} : \{\}\)/);
  });

  it("the sheet opens without waiting: no native Modal, no product request, no cart refetch", () => {
    const sheet = read("src/components/VariantSheet.tsx");
    assert.doesNotMatch(sheet, /<Modal\b|onShow=/);
    assert.match(sheet, /useProduct\(product\.id, \{ enabled: !cardHasVariants \}\)/);
    assert.match(sheet, /useCartActions\(\{ refetchCart: false \}\)/);
    assert.match(read("src/lib/queries.ts"), /refetchOnMount: options\.refetchOnMount === false \? false : "always"/);
    // A 180–250 ms slide with the backdrop fading on the same value.
    const open = Number(sheet.match(/const OPEN_MS = (\d+);/)?.[1]);
    const close = Number(sheet.match(/const CLOSE_MS = (\d+);/)?.[1]);
    assert.ok(open >= 180 && open <= 250, `OPEN_MS ${open}`);
    assert.ok(close >= 180 && close <= 250, `CLOSE_MS ${close}`);
    assert.match(sheet, /styles\.backdrop, \{ opacity: progress \}/);
    // Back closes it on Android.
    assert.match(sheet, /BackHandler\.addEventListener\("hardwareBackPress"/);
  });
});

/* Product page ------------------------------------------------------------- */

describe("product page — the same rule", () => {
  it("500g available, 1kg sold out → single: no selector, 500g is the product", () => {
    const page = pageVariantsOf(productOf([size("500g", 3400, { isDefault: true }), size("1kg", 6500, soldOut)]));
    assert.equal(page.mode, "single");
    assert.equal(page.single?.variantName, "500g");
    assert.equal(page.single?.pricePaise, 3400);
    assert.deepEqual(page.purchasable.map((variant) => variant.variantName), ["500g"]);
  });

  it("500g available, 1kg hidden (never sent) → single", () => {
    assert.equal(pageVariantsOf(productOf([size("500g", 3400, { isDefault: true })])).mode, "single");
  });

  it("default sold out, 1kg available → single on 1kg", () => {
    const page = pageVariantsOf(productOf([size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)]));
    assert.equal(page.mode, "single");
    assert.equal(page.single?.variantName, "1kg");
  });

  it("two available → choose, offering only those two", () => {
    const page = pageVariantsOf(productOf([size("500g", 3400, { isDefault: true }), size("1kg", 6500), size("2kg", 12000, soldOut)]));
    assert.equal(page.mode, "choose");
    assert.equal(page.single, null);
    assert.deepEqual(page.purchasable.map((variant) => variant.variantName), ["500g", "1kg"]);
  });

  it("none available → none: no selector, nothing to add", () => {
    const page = pageVariantsOf(productOf([size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500, soldOut)]));
    assert.equal(page.mode, "none");
    assert.equal(page.purchasable.length, 0);
  });

  it("changes as availability changes: hide → single, restore → choose, restock → choose", () => {
    const both = [size("500g", 3400, { isDefault: true }), size("1kg", 6500)];
    assert.equal(pageVariantsOf(productOf(both)).mode, "choose");
    assert.equal(pageVariantsOf(productOf([both[0]!])).mode, "single"); // 1kg hidden: not sent
    assert.equal(pageVariantsOf(productOf(both)).mode, "choose"); // restored
    const soldOutDefault = [size("500g", 3400, { isDefault: true, ...soldOut }), size("1kg", 6500)];
    assert.equal(pageVariantsOf(productOf(soldOutDefault)).mode, "single");
    assert.equal(pageVariantsOf(productOf([size("500g", 3400, { isDefault: true }), size("1kg", 6500)])).mode, "choose"); // restocked
  });

  it("a single-size product is unaffected", () => {
    const page = pageVariantsOf(productOf([size("1 pc", 2000, { isDefault: true })]));
    assert.equal(page.mode, "single");
    assert.equal(page.single?.id, "v-1 pc");
  });
});

describe("store closed — said without naming the store", () => {
  const closed = (message: string) => size("1kg", 6500, { isDefault: true, sellerAcceptingOrders: false, sellerName: "Aadione Grocery", sellerClosedMessage: message });

  it("keeps only when it opens again", () => {
    assert.equal(storeClosedHint([closed("Aadione Grocery is closed right now. Opens at 8:00 AM.")]), "Opens at 8:00 AM.");
  });

  it("nothing more to say → empty, never the name", () => {
    assert.equal(storeClosedHint([closed("Aadione Grocery is not taking orders right now.")]), "");
  });

  it("not the reason (something can be bought, or simply sold out) → null", () => {
    assert.equal(storeClosedHint([closed("Aadione Grocery is closed right now."), size("500g", 3400)]), null);
    assert.equal(storeClosedHint([size("500g", 3400, soldOut)]), null);
  });
});

describe("product page and sheet wiring — no seller identity, no SKU", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  const page = read("src/screens/catalog/ProductDetailScreen.tsx");
  const sheet = read("src/components/VariantSheet.tsx");

  it("the selector appears only for a real choice, and lists only buyable sizes", () => {
    assert.match(page, /const needsChoice = sizes\.mode === "choose";/);
    assert.match(page, /\{needsChoice && \(/);
    assert.match(page, /\{purchasable\.map\(\(item\) => \{/);
    assert.doesNotMatch(page, /detail\.variants\.map/);
    assert.doesNotMatch(page, /detail\.variants\.length > 1/);
  });

  it("one buyable size: Add adds exactly it, through the shared cart flow with the cart flight", () => {
    assert.match(page, /: purchasable\[0\];/);
    assert.match(page, /addAndFly\(cart\.add, flyToCart, chosen\.id, snapshotFromProduct\(detail, chosen\), flightImageUrl\);/);
  });

  it("re-reads the product on every visit (availability follows changes)", () => {
    assert.match(page, /useProduct\(productId, \{ refetchOnMount: "always" \}\)/);
  });

  it("no seller identity on the product page or in the sheet", () => {
    for (const [name, text] of [["page", page], ["sheet", sheet]] as const) {
      assert.doesNotMatch(text, /Sold by/, name);
      assert.doesNotMatch(text, /sellerName/, name);
      assert.doesNotMatch(text, /sellerClosedMessage/, name);
    }
  });

  it("no SKU on the product page or in the sheet", () => {
    for (const [name, text] of [["page", page], ["sheet", sheet]] as const) {
      assert.doesNotMatch(text, /\.sku\b|SKU \{/, name);
    }
    // The stock hint stays.
    assert.match(sheet, /Only \{chosen\.availableQty\} left/);
  });

  it("the cart still keeps the listing's seller (internal data untouched)", () => {
    const actions = read("src/lib/useCartActions.ts");
    assert.match(actions, /sellerId: variant\.sellerId,\n\s*sellerName: variant\.sellerName,/);
  });
});
