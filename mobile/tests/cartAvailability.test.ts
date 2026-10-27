/**
 * What the Cart shows and sends for partially available carts
 * (src/lib/cartAvailability.ts) — run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isCheckingLine,
  isOrderableLine,
  orderedLines,
  partialOrderNotice,
  unavailableLabel,
} from "../src/lib/cartAvailability.ts";

type Reason = "STORE_CLOSED" | "PRODUCT_UNAVAILABLE" | "OUT_OF_STOCK" | null;
const line = (sellerListingId: string, available: boolean | undefined, unavailableReason: Reason = null) => ({
  sellerListingId,
  unitPricePaise: 20000,
  available: available as boolean,
  unavailableReason,
});

describe("line states", () => {
  it("orderable, unavailable with a reason, or still being checked", () => {
    assert.equal(isOrderableLine(line("a", true)), true);
    // An older server sends no flag: orderable, as before.
    assert.equal(isOrderableLine(line("a", undefined)), true);
    assert.equal(isOrderableLine(line("a", false, "STORE_CLOSED")), false);
    // Restored from the phone, not yet answered by the server: never orderable.
    assert.equal(isOrderableLine(line("a", false, null)), false);
    assert.equal(isCheckingLine(line("a", false, null)), true);
    assert.equal(isCheckingLine(line("a", false, "OUT_OF_STOCK")), false);
  });

  it("labels each unavailable reason", () => {
    assert.equal(unavailableLabel(line("a", true)), null);
    assert.equal(unavailableLabel(line("a", false, "STORE_CLOSED")), "STORE CLOSED — UNAVAILABLE RIGHT NOW");
    assert.equal(unavailableLabel(line("a", false, "OUT_OF_STOCK")), "OUT OF STOCK — UNAVAILABLE RIGHT NOW");
    assert.equal(unavailableLabel(line("a", false, "PRODUCT_UNAVAILABLE")), "UNAVAILABLE RIGHT NOW");
    assert.equal(unavailableLabel(line("a", false, null)), "Checking availability…");
  });
});

describe("partial order", () => {
  it("orders exactly the orderable lines, never an unavailable or unchecked one", () => {
    const sent = orderedLines([
      line("open-a", true),
      line("closed", false, "STORE_CLOSED"),
      line("open-b", undefined),
      line("checking", false, null),
      { ...line("no-listing", true), sellerListingId: null },
    ]);
    assert.deepEqual(
      sent.map((entry) => entry.sellerListingId),
      ["open-a", "open-b"],
    );
  });

  it("explains a mixed cart, and stays quiet when all or none can be ordered", () => {
    assert.equal(
      partialOrderNotice([line("a", true), line("b", true), line("c", false, "STORE_CLOSED")]),
      "1 item can't be ordered right now and will stay in your cart. Your order will include the other 2 items — the bill below is for those only.",
    );
    assert.equal(partialOrderNotice([line("a", true)]), null);
    assert.equal(partialOrderNotice([line("c", false, "STORE_CLOSED")]), null);
    // Lines still being checked are not announced as unavailable.
    assert.equal(partialOrderNotice([line("a", true), line("b", false, null)]), null);
  });
});
