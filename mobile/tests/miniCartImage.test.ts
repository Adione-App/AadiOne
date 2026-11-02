/**
 * The Mini Cart thumbnail follows the cart when it changes without an add
 * flight (src/lib/miniCartImage.ts) — run with `npm run test:unit`. Plus
 * source checks on components/MiniCartBar.tsx (the component needs a device).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { miniCartSyncRequest, slotReadyOnRequest, type ShownSlot } from "../src/lib/miniCartImage.ts";

const resolve = (url: string | null) => (url ? `https://cdn.test/${url}` : null);
const EMPTY: ShownSlot = { variantId: null, imageUrl: null, failed: false };
const line = (variantId: string, imageUrl: string | null = `${variantId}.webp`) => ({ variantId, imageUrl });

describe("Mini Cart image follows the cart", () => {
  it("cart arrives after the Mini Cart mounted (launch / login / restore): the latest product", () => {
    assert.deepEqual(miniCartSyncRequest(EMPTY, [line("a"), line("b")], resolve), { imageUrl: "b.webp", variantId: "b", sameProduct: false });
  });

  it("empty cart (logged out / cleared): nothing to show", () => {
    assert.equal(miniCartSyncRequest(EMPTY, [], resolve), null);
  });

  it("already showing the latest product's image: nothing to do (no repeated request)", () => {
    assert.equal(miniCartSyncRequest({ variantId: "b", imageUrl: "b.webp", failed: false }, [line("a"), line("b")], resolve), null);
  });

  it("the shown product had no image yet and the cart now has one: that image", () => {
    assert.deepEqual(miniCartSyncRequest({ variantId: "b", imageUrl: null, failed: false }, [line("b")], resolve), {
      imageUrl: "b.webp",
      variantId: "b",
      sameProduct: true,
    });
  });

  it("the shown image failed: a different url for it is tried once; the same failed url is never retried", () => {
    assert.equal(miniCartSyncRequest({ variantId: "b", imageUrl: "old.webp", failed: false }, [line("b")], resolve), null);
    assert.deepEqual(miniCartSyncRequest({ variantId: "b", imageUrl: "old.webp", failed: true }, [line("b")], resolve)?.imageUrl, "b.webp");
    assert.equal(miniCartSyncRequest({ variantId: "b", imageUrl: "b.webp", failed: true }, [line("b")], resolve), null);
  });

  it("a product without any image: nothing requested (the placeholder stays)", () => {
    assert.equal(miniCartSyncRequest({ variantId: "b", imageUrl: null, failed: false }, [line("b", null)], resolve), null);
  });

  it("the shown product was removed: left to the remove handoff", () => {
    assert.equal(miniCartSyncRequest({ variantId: "x", imageUrl: "x.webp", failed: false }, [line("a")], resolve), null);
  });
});

describe("Hidden slot readiness (two-layer swap)", () => {
  it("a product without an image is ready at once (the placeholder needs no load)", () => {
    assert.equal(slotReadyOnRequest(null, null), true);
    assert.equal(slotReadyOnRequest(null, "https://cdn.test/a.webp"), true);
  });

  it("the hidden slot already painted this exact image (A -> B -> A, same burger again): ready at once", () => {
    assert.equal(slotReadyOnRequest("https://cdn.test/a.webp", "https://cdn.test/a.webp"), true);
  });

  it("a different, loading or failed image waits for that slot's own onLoad", () => {
    assert.equal(slotReadyOnRequest("https://cdn.test/b.webp", "https://cdn.test/a.webp"), false);
    assert.equal(slotReadyOnRequest("https://cdn.test/b.webp", null), false);
  });
});

describe("MiniCartBar wiring", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(path.join(ROOT, "src/components/MiniCartBar.tsx"), "utf8").replace(/\r\n/g, "\n");

  it("syncs with the cart whenever nothing else is pending, and never pre-empts an add flight", () => {
    assert.match(src, /miniCartSyncRequest\(slots\[frontIndexRef\.current\], items, resolveImageUrl\)/);
    assert.match(src, /if \(pendingTokenRef\.current !== null\) return;\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(useFlyToCartStore\.getState\(\)\.latestAddFlightId !== prevLatestAddFlightIdRef\.current\) return;/);
  });

  it("a failed image shows the placeholder, never a bare white layer; both layers keep their white background", () => {
    assert.equal(src.match(/onError=\{\(\) => \{\n\s*paintedUriRef\.current\[[01]\] = null;\n\s*markFailed\(slots\[[01]\]\.token\);/g)?.length, 2);
    assert.match(src, /slotAUri && !slots\[0\]\.failed \?/);
    assert.match(src, /slotBUri && !slots\[1\]\.failed \?/);
    assert.match(src, /imageLayer: \{[\s\S]*?backgroundColor: colors\.surface,/);
  });

  it("each slot records what it painted, and a request reads it — never waits for an onLoad that cannot come", () => {
    assert.match(src, /onLoad=\{\(\) => \{\n\s*paintedUriRef\.current\[0\] = slotAUri;\n\s*markReady\(slots\[0\]\.token\);/);
    assert.match(src, /onLoad=\{\(\) => \{\n\s*paintedUriRef\.current\[1\] = slotBUri;\n\s*markReady\(slots\[1\]\.token\);/);
    assert.match(src, /pendingReadyRef\.current = slotReadyOnRequest\(uri, paintedUriRef\.current\[backIndex\]\);/);
  });
});

describe("Food menu rows fly into the Mini Cart like grocery cards", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const menu = readFileSync(path.join(ROOT, "src/screens/food/RestaurantMenuScreen.tsx"), "utf8").replace(/\r\n/g, "\n");

  it("every accepted ADD and + starts its own flight with the row's image; a refused one does not", () => {
    assert.match(menu, /if \(onAdd\(item\.variantId, snapshotOf\(item\)\)\) flyToCart\(flightImage, item\.variantId\);/);
    assert.match(menu, /if \(onIncrement\(item\.variantId\)\) flyToCart\(flightImage, item\.variantId\);/);
    assert.match(menu, /const flightImage = image && image !== failed \? image : null;/);
  });
});
