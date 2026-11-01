/**
 * "Pay Online" → Cashfree checkout: the session taken from the order response
 * (src/lib/payments.ts) and the development timing summary
 * (src/lib/paymentTiming.ts). Run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PAYMENT_INTENT_KEY, sessionFromOrderResponse } from "../src/lib/payments.ts";
import { percentiles, summarizeLaunch } from "../src/lib/paymentTiming.ts";

type Payment = Parameters<typeof sessionFromOrderResponse>[0];
const payment = (overrides: Record<string, unknown> = {}) =>
  ({
    paymentId: "p1",
    provider: "cashfree",
    providerOrderId: "cf_order_1",
    publicKey: "",
    amountPaise: 58500,
    currency: "INR",
    prefill: { name: null, email: null, contact: "9999999999" },
    cashfree: { paymentSessionId: "session_abc", orderId: "cf_order_1", environment: "SANDBOX" },
    ...overrides,
  }) as unknown as Payment;

describe("the session that came with the order", () => {
  it("is used when it is a complete Cashfree checkout for its own Cashfree order", () => {
    assert.equal(sessionFromOrderResponse(payment())?.cashfree?.paymentSessionId, "session_abc");
    assert.deepEqual(PAYMENT_INTENT_KEY("order-1"), ["payment-intent", "order-1"]);
  });

  it("is ignored — the payment screen then asks /payments/create — when missing or inconsistent", () => {
    assert.equal(sessionFromOrderResponse(undefined), null); // older server
    assert.equal(sessionFromOrderResponse(null), null); // could not be opened with the order
    assert.equal(sessionFromOrderResponse(payment({ cashfree: undefined })), null); // not a Cashfree checkout
    assert.equal(
      sessionFromOrderResponse(payment({ cashfree: { paymentSessionId: "", orderId: "cf_order_1", environment: "SANDBOX" } })),
      null,
    );
    assert.equal(
      sessionFromOrderResponse(payment({ cashfree: { paymentSessionId: "s", orderId: "cf_other", environment: "SANDBOX" } })),
      null,
    );
    assert.equal(sessionFromOrderResponse(payment({ amountPaise: 0 })), null);
  });
});

describe("launch timing summary", () => {
  it("splits tap → checkout into the recorded stages and totals them", () => {
    const summary = summarizeLaunch({ tap: 1000, orderRequest: 1005, orderResponse: 1805, sessionReady: 1806, sdkReady: 1900, checkoutInvoked: 1910 });
    assert.deepEqual(summary.steps, {
      "tap→orderRequest": 5,
      "orderRequest→orderResponse": 800,
      "orderResponse→sessionReady": 1,
      "sessionReady→sdkReady": 94,
      "sdkReady→checkoutInvoked": 10,
    });
    assert.equal(summary.totalMs, 910);
  });

  it("an older server's extra request shows up as its own stage; an unfinished launch has no total", () => {
    const summary = summarizeLaunch({ tap: 0, orderRequest: 1, orderResponse: 900, sessionRequest: 1200, sessionReady: 2000, checkoutInvoked: 2050 });
    assert.equal(summary.steps["orderResponse→sessionRequest"], 300);
    assert.equal(summary.steps["sessionRequest→sessionReady"], 800);
    assert.equal(summarizeLaunch({ tap: 0, orderRequest: 1 }).totalMs, null);
  });

  it("median and p95 by nearest rank", () => {
    assert.deepEqual(percentiles([]), { n: 0, median: null, p95: null });
    assert.deepEqual(percentiles([5]), { n: 1, median: 5, p95: 5 });
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    assert.deepEqual(percentiles(values), { n: 20, median: 1000, p95: 1900 });
  });
});
