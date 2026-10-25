/**
 * Home card sizes (src/screens/home/cardLayout.ts) — run with `npm run test:unit`.
 *
 * Regression: production's three top cards are 1024 × 1536 images shown
 * "whole" in 128 dp boxes — each got white bands either side.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HOME_CARD_HEIGHT_LIMITS } from "@shared";
import { CATEGORY_TILE_GAP, categoryTileSize, featureCardSize } from "../src/screens/home/cardLayout.ts";

const portrait = { fit: "contain" as const, aspectRatio: 1024 / 1536 };

describe("featureCardSize", () => {
  it("whole-image cards take their image's shape: no empty bands", () => {
    const { width, height } = featureCardSize({ screenWidth: 360, side: 16, gap: 10, configuredHeight: 128, cards: [portrait, portrait, portrait] });
    assert.equal(width, 102);
    // At this height a 2:3 image is exactly 102 wide — it fills the card.
    assert.equal(height, Math.round(102 / (1024 / 1536)));
    assert.ok(Math.abs(height * (1024 / 1536) - width) <= 1);
  });

  it("never wider than the screen, for any count and phone width", () => {
    for (const screenWidth of [320, 360, 393, 412, 480]) {
      for (const count of [1, 2, 3, 4]) {
        const { width } = featureCardSize({ screenWidth, side: 16, gap: 14, configuredHeight: 128, cards: Array.from({ length: count }, () => portrait) });
        assert.ok(width * count + 14 * (count - 1) <= screenWidth - 32, `${count} at ${screenWidth}`);
      }
    }
  });

  it("stays within the card height limits", () => {
    const tall = featureCardSize({ screenWidth: 480, side: 16, gap: 10, configuredHeight: 128, cards: [{ fit: "contain", aspectRatio: 0.2 }] });
    assert.equal(tall.height, HOME_CARD_HEIGHT_LIMITS.max);
    const flat = featureCardSize({ screenWidth: 360, side: 16, gap: 10, configuredHeight: 128, cards: [{ fit: "contain", aspectRatio: 8 }, { fit: "contain", aspectRatio: 8 }] });
    assert.equal(flat.height, HOME_CARD_HEIGHT_LIMITS.min);
  });

  it("mixed shapes: the tallest, so no whole image is cut", () => {
    const { width, height } = featureCardSize({ screenWidth: 360, side: 16, gap: 10, configuredHeight: 128, cards: [portrait, { fit: "contain", aspectRatio: 1 }, portrait] });
    assert.equal(height, Math.round(width / (1024 / 1536)));
    assert.ok(height <= HOME_CARD_HEIGHT_LIMITS.max);
  });

  it("a 'fill the card' card (or an unknown image size) keeps the height set in the Home Page Builder", () => {
    assert.equal(featureCardSize({ screenWidth: 360, side: 16, gap: 10, configuredHeight: 140, cards: [portrait, { fit: "cover", aspectRatio: 1.5 }] }).height, 140);
    assert.equal(featureCardSize({ screenWidth: 360, side: 16, gap: 10, configuredHeight: 140, cards: [{ fit: "contain", aspectRatio: null }] }).height, 140);
  });
});

describe("categoryTileSize", () => {
  it("fills the cell less one constant gap, the image keeping its designed share", () => {
    // 4 per row: a 360 dp phone (cell 88) and a 412 dp phone (cell 101).
    const small = categoryTileSize({ cell: 88, designBox: 88, designImage: 72, imageFit: "contain" });
    const large = categoryTileSize({ cell: 101, designBox: 88, designImage: 72, imageFit: "contain" });
    assert.equal(small.box, 88 - CATEGORY_TILE_GAP);
    assert.equal(large.box, 101 - CATEGORY_TILE_GAP);
    assert.ok(Math.abs(small.image / small.box - 72 / 88) < 0.02);
    assert.ok(Math.abs(large.image / large.box - 72 / 88) < 0.02);
    assert.ok(large.image <= large.box && small.image <= small.box);
  });

  it("'fill the tile' fills the whole box; tiny cells stay usable", () => {
    assert.deepEqual(categoryTileSize({ cell: 90, designBox: 88, designImage: 72, imageFit: "cover" }), { box: 84, image: 84 });
    assert.ok(categoryTileSize({ cell: 40, designBox: 62, designImage: 50, imageFit: "contain" }).box >= 48);
  });
});
