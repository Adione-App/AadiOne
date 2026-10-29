/**
 * The out-of-area sentence (src/lib/deliveryArea.ts) — run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatKm, outOfAreaDetail } from "../src/lib/deliveryArea.ts";

describe("distance shown to the customer", () => {
  it("one decimal, rounded up, whole numbers without a decimal", () => {
    assert.equal(formatKm(14.23), "14.3");
    assert.equal(formatKm(12), "12");
    assert.equal(formatKm(12.01), "12.1");
    assert.equal(formatKm(10.5), "10.5");
  });
});

describe("out-of-area detail", () => {
  it("names the distance and the radius when distance is the reason", () => {
    assert.equal(
      outOfAreaDetail({ serviceable: false, distanceKm: 14.23, maxRadiusKm: 12 }),
      "The nearest store is about 14.3 km away — stores deliver up to 12 km (straight line).",
    );
  });

  it("says nothing about distance when the point is inside the radius (refused for another reason)", () => {
    assert.equal(outOfAreaDetail({ serviceable: false, distanceKm: 3.2, maxRadiusKm: 12 }), null);
    // Exactly on the boundary is inside.
    assert.equal(outOfAreaDetail({ serviceable: false, distanceKm: 12, maxRadiusKm: 12 }), null);
  });

  it("is silent when serviceable or when there is no answer yet", () => {
    assert.equal(outOfAreaDetail({ serviceable: true, distanceKm: 20, maxRadiusKm: 12 }), null);
    assert.equal(outOfAreaDetail(null), null);
    assert.equal(outOfAreaDetail(undefined), null);
    assert.equal(outOfAreaDetail({ serviceable: false, distanceKm: Number.NaN, maxRadiusKm: 12 }), null);
    assert.equal(outOfAreaDetail({ serviceable: false, distanceKm: 20, maxRadiusKm: 0 }), null);
  });
});
