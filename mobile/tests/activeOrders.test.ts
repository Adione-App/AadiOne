/**
 * Home's orders-in-progress carousel logic (src/lib/activeOrders.ts) — run
 * with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ACTIVE_ORDER_ROTATE_MS, activeOrdersFromList, indexAfterRefresh, nextCarouselIndex } from "../src/lib/activeOrders.ts";

type Summary = Parameters<typeof activeOrdersFromList>[0][number];
const order = (id: string, status: string, paymentMethod: string, paymentStatus: string) =>
  ({ id, status, paymentMethod, paymentStatus }) as unknown as Summary;

describe("rotation", () => {
  it("moves every ~2.5 s, wraps at the end, never moves a single card", () => {
    assert.ok(ACTIVE_ORDER_ROTATE_MS >= 2000 && ACTIVE_ORDER_ROTATE_MS <= 3000);
    assert.equal(nextCarouselIndex(0, 3), 1);
    assert.equal(nextCarouselIndex(2, 3), 0);
    assert.equal(nextCarouselIndex(0, 1), 0);
    assert.equal(nextCarouselIndex(0, 0), 0);
  });
});

describe("after a refresh", () => {
  it("stays on the same order even when a new one arrives in front of it", () => {
    assert.equal(indexAfterRefresh(["a", "b", "c"], 1, ["new", "a", "b", "c"]), 2);
    assert.equal(indexAfterRefresh(["a", "b"], 0, ["a", "b"]), 0);
  });

  it("an order that ended disappears: the same position, clamped", () => {
    assert.equal(indexAfterRefresh(["a", "b", "c"], 2, ["a", "b"]), 1);
    assert.equal(indexAfterRefresh(["a", "b", "c"], 1, ["a", "c"]), 1);
    assert.equal(indexAfterRefresh(["a"], 0, []), 0);
  });
});

describe("older server fallback", () => {
  it("only placed orders on their way — never an online order awaiting payment, nor ended ones", () => {
    const kept = activeOrdersFromList([
      order("pending-online", "PENDING_PAYMENT", "ONLINE", "PENDING"),
      order("paid-online", "PROCESSING", "ONLINE", "PAID"),
      order("cod", "OUT_FOR_DELIVERY", "COD", "PENDING"),
      order("delivered", "DELIVERED", "COD", "PAID"),
      order("cancelled", "CANCELLED", "ONLINE", "REFUNDED"),
      order("failed", "PAYMENT_FAILED", "ONLINE", "FAILED"),
    ]);
    assert.deepEqual(
      kept.map((o) => o.id),
      ["paid-online", "cod"],
    );
  });
});
