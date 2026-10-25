/**
 * Checkout payment buttons under the admin's global switches
 * (src/lib/paymentOptions.ts) — run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PAYMENT_UNAVAILABLE_MESSAGES } from "@shared";
import { checkoutPaymentState } from "../src/lib/paymentOptions.ts";

const quote = (over: { onlinePaymentEnabled?: boolean; codEnabled?: boolean; codAllowed?: boolean; codBlockedReason?: string | null } = {}) => ({
  codAllowed: true,
  codBlockedReason: null,
  onlinePaymentEnabled: true,
  codEnabled: true,
  ...over,
});

describe("checkoutPaymentState", () => {
  it("A — both on: both buttons place an order, nothing to explain", () => {
    assert.deepEqual(checkoutPaymentState(quote()), {
      online: { available: true, message: null },
      cod: { available: true, message: null },
      banner: null,
    });
  });

  it("B — online off: online faded with the message pointing to COD; COD works", () => {
    const state = checkoutPaymentState(quote({ onlinePaymentEnabled: false }));
    assert.deepEqual(state.online, { available: false, message: PAYMENT_UNAVAILABLE_MESSAGES.ONLINE });
    assert.deepEqual(state.cod, { available: true, message: null });
    assert.equal(state.banner, null);
  });

  it("C — COD off: COD faded with the message pointing to online; online works", () => {
    // The server also reports codAllowed false with the same reason (older apps fade it too).
    const state = checkoutPaymentState(quote({ codEnabled: false, codAllowed: false, codBlockedReason: PAYMENT_UNAVAILABLE_MESSAGES.COD }));
    assert.deepEqual(state.cod, { available: false, message: PAYMENT_UNAVAILABLE_MESSAGES.COD });
    assert.deepEqual(state.online, { available: true, message: null });
    assert.equal(state.banner, null);
  });

  it("D — both off: neither places an order; both explain; the banner says payments are unavailable", () => {
    const state = checkoutPaymentState(quote({ onlinePaymentEnabled: false, codEnabled: false, codAllowed: false }));
    assert.equal(state.online.available, false);
    assert.equal(state.cod.available, false);
    assert.equal(state.online.message, PAYMENT_UNAVAILABLE_MESSAGES.ALL);
    assert.equal(state.cod.message, PAYMENT_UNAVAILABLE_MESSAGES.ALL);
    assert.equal(state.banner, PAYMENT_UNAVAILABLE_MESSAGES.ALL);
  });

  it("COD not allowed for this order (its own rules) is explained with the server's reason", () => {
    const state = checkoutPaymentState(quote({ codAllowed: false, codBlockedReason: "COD is available up to ₹3,000." }));
    assert.deepEqual(state.cod, { available: false, message: "COD is available up to ₹3,000." });
    assert.equal(state.online.available, true);
  });

  it("online off while COD cannot take this order: says why, never sends the customer to COD", () => {
    const state = checkoutPaymentState(quote({ onlinePaymentEnabled: false, codAllowed: false, codBlockedReason: "COD is available up to ₹3,000." }));
    assert.equal(state.online.message, "Online payment is currently unavailable. COD is available up to ₹3,000.");
    assert.equal(state.banner, state.online.message);
  });

  it("no quote yet (loading or failed): nothing can be placed, nothing is advertised", () => {
    assert.deepEqual(checkoutPaymentState(null), {
      online: { available: false, message: null },
      cod: { available: false, message: null },
      banner: null,
    });
  });

  it("an older server (no switch fields) keeps today's behaviour", () => {
    const state = checkoutPaymentState({ codAllowed: true, codBlockedReason: null });
    assert.equal(state.online.available, true);
    assert.equal(state.cod.available, true);
  });
});
