/**
 * One shared post-add step for every Add / + (src/lib/addToCartFlow.ts) —
 * product cards, the variant sheet, the product page and food menus all
 * drop the product's image into the Mini Cart the same way, which is also
 * what makes it the Mini Cart's latest thumbnail. Run with `npm run test:unit`.
 * The animation and the Mini Cart need a device; their wiring is checked on
 * the source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addAndFly, incrementAndFly } from "../src/lib/addToCartFlow.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** A fake cart + flight log, in call order. */
function harness(accept: (variantId: string) => boolean | void = () => true) {
  const log: string[] = [];
  const add = (variantId: string, snapshot: { name: string }) => {
    log.push(`add ${variantId} ${snapshot.name}`);
    return accept(variantId);
  };
  const increment = (variantId: string) => {
    log.push(`increment ${variantId}`);
    return accept(variantId);
  };
  const fly = (imageUrl: string | null, variantId: string) => log.push(`fly ${variantId} ${imageUrl}`);
  return { log, add, increment, fly };
}

describe("the shared add step", () => {
  it("adds (optimistic local line) first, then drops that product's image into the Mini Cart — once", () => {
    const h = harness();
    assert.equal(addAndFly(h.add, h.fly, "v-500g", { name: "Atta" }, "https://img/atta.webp"), true);
    assert.deepEqual(h.log, ["add v-500g Atta", "fly v-500g https://img/atta.webp"]);
  });

  it("a tap refused on the device (login, limit) starts no flight and changes no thumbnail", () => {
    const h = harness(() => false);
    assert.equal(addAndFly(h.add, h.fly, "v-500g", { name: "Atta" }, "https://img/atta.webp"), false);
    assert.equal(incrementAndFly(h.increment, h.fly, "v-500g", "https://img/atta.webp"), false);
    assert.deepEqual(h.log, ["add v-500g Atta", "increment v-500g"]);
  });

  it("an add whose signature returns nothing counts as accepted (older callers)", () => {
    const h = harness(() => undefined);
    assert.equal(addAndFly(h.add, h.fly, "v-1", { name: "Milk" }, null), true);
    assert.deepEqual(h.log, ["add v-1 Milk", "fly v-1 null"]);
  });

  it("A normally, then B from the sheet, then another size of B: each flight names its own size, newest last", () => {
    const h = harness();
    addAndFly(h.add, h.fly, "a-1", { name: "A" }, "https://img/a.webp");
    addAndFly(h.add, h.fly, "b-500g", { name: "B" }, "https://img/b.webp");
    addAndFly(h.add, h.fly, "b-1kg", { name: "B" }, "https://img/b.webp");
    assert.deepEqual(
      h.log.filter((line) => line.startsWith("fly")),
      ["fly a-1 https://img/a.webp", "fly b-500g https://img/b.webp", "fly b-1kg https://img/b.webp"],
    );
  });
});

describe("every Add / + uses it", () => {
  it("product cards, the product page and food menus", () => {
    const card = read("src/components/ProductCard.tsx");
    assert.match(card, /addAndFly\(onAdd, flyToCart, direct\.id, snapshotFromProduct\(product, direct\), imageUrl\);/);
    assert.match(card, /incrementAndFly\(onIncrement, flyToCart, target, imageUrl\);/);
    const page = read("src/screens/catalog/ProductDetailScreen.tsx");
    assert.match(page, /addAndFly\(cart\.add, flyToCart, chosen\.id, snapshotFromProduct\(detail, chosen\), flightImageUrl\);/);
    assert.match(page, /incrementAndFly\(cart\.increment, flyToCart, chosen\.id, flightImageUrl\);/);
    const menu = read("src/screens/food/RestaurantMenuScreen.tsx");
    assert.match(menu, /addAndFly\(onAdd, flyToCart, item\.variantId, snapshotOf\(item\), flightImage\);/);
    assert.match(menu, /incrementAndFly\(onIncrement, flyToCart, item\.variantId, flightImage\);/);
    // No caller starts a flight on its own any more.
    for (const src of [card, page, menu]) assert.doesNotMatch(src, /\) flyToCart\(/);
  });

  const sheet = read("src/components/VariantSheet.tsx");

  it("the variant sheet: the same step, with the PRODUCT's own image (the card's), then it closes", () => {
    assert.match(sheet, /const flightImage = resolveImageUrl\(product\.thumbUrl\);/);
    assert.match(
      sheet,
      /if \(addAndFly\(cart\.add, flyToCart, chosen\.id, snapshotFromProduct\(source, chosen\), flightImage\)\) \{\n\s*addedFor\.current = openedAt;\n\s*onClose\(\);/,
    );
    assert.match(sheet, /onIncrement=\{\(\) => incrementAndFly\(cart\.increment, flyToCart, chosen\.id, flightImage\)\}/);
    // The card's + on a several-size product only opens the sheet — the sheet's Add is the one flight.
    assert.match(read("src/components/ProductCard.tsx"), /if \(addMode === "sheet"\) \{\n\s*openOptions\(\);\n\s*return;\n\s*\}/);
  });

  it("rapid taps in the sheet: one Add (one flight) per opening", () => {
    assert.match(sheet, /if \(busy \|\| addedFor\.current === openedAt\) return;/);
  });

  it("the drop paints above the closing sheet (mounted after it, higher elevation on Android)", () => {
    const app = read("App.tsx");
    assert.ok(app.indexOf("<VariantSheetHost />") < app.indexOf("<FlyToCartOverlay />"), "overlay after the sheet");
    const fly = read("src/lib/flyToCart.tsx");
    assert.match(fly, /<View pointerEvents="none" collapsable=\{false\} style=\{\[StyleSheet\.absoluteFill, styles\.overlay\]\}>/);
    assert.match(fly, /overlay: \{\n\s*zIndex: 100,\n\s*elevation: 100,\n\s*\}/);
    assert.match(sheet, /elevation: 16,/);
  });

  it("the Mini Cart's latest thumbnail follows the newest flight; an older landing never overwrites it", () => {
    const fly = read("src/lib/flyToCart.tsx");
    assert.match(fly, /useFlyToCartStore\.setState\(\{\n\s*latestAddFlightId: flightId,\n\s*latestAddImageUrl: imageUrl,\n\s*latestAddVariantId: variantId,\n\s*\}\);/);
    const bar = read("src/components/MiniCartBar.tsx");
    assert.match(bar, /requestDisplay\(store\.latestAddImageUrl, store\.latestAddVariantId,/);
  });

  it("a failed add never stays the Mini Cart's product: its line is rolled back and the bar shows the last remaining line", () => {
    const actions = read("src/lib/useCartActions.ts");
    assert.match(actions, /if \(failed && usePendingCartStore\.getState\(\)\.pendingQty\[variantId\] === targetQty\) \{[\s\S]*?clearPending\(variantId\);/);
    const bar = read("src/components/MiniCartBar.tsx");
    assert.match(bar, /if \(items\.some\(\(item\) => item\.variantId === frontSlot\.variantId\)\) return;[\s\S]*?const fallback = items\[items\.length - 1\] \?\? null;/);
  });
});
