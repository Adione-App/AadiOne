/**
 * Refunds on the order screen (src/lib/refunds.ts) — run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { refundFormItems, refundFormProblem, refundTone, showRefundsCard } from "../src/lib/refunds.ts";

type Data = Parameters<typeof showRefundsCard>[0];
const data = (refunds: number, eligible: boolean, reason: string | null) =>
  ({
    refunds: Array.from({ length: refunds }, (_, i) => ({ id: String(i) })),
    request: { eligible, reason, windowEndsAt: null, refundableItemIds: [], photoRequiredCategories: [] },
  }) as unknown as Data;

describe("refunds card", () => {
  it("shows only with a refund, or when a request can (or could) be made", () => {
    assert.equal(showRefundsCard(undefined), false);
    assert.equal(showRefundsCard(data(0, false, null)), false);
    assert.equal(showRefundsCard(data(1, false, null)), true);
    assert.equal(showRefundsCard(data(0, true, null)), true);
    assert.equal(showRefundsCard(data(0, false, "Refund requests can be made within 7 days of delivery.")), true);
  });

  it("green when refunded, red only when not approved, amber otherwise", () => {
    assert.notEqual(refundTone("SUCCESS").fg, refundTone("PROCESSING").fg);
    assert.notEqual(refundTone("REJECTED").fg, refundTone("PROCESSING").fg);
    assert.equal(refundTone("PARTIAL_FAILURE").fg, refundTone("PROCESSING").fg);
  });
});

describe("request form", () => {
  const base = { category: "MISSING_ITEM" as const, description: "One packet was missing.", quantities: { a: 1 }, photoCount: 0 };
  const photoRequired = ["DAMAGED_ITEM", "WRONG_ITEM", "QUALITY_ISSUE"];

  it("is ready with a category, an item, a few words — and a photo where one is required", () => {
    assert.equal(refundFormProblem(base, photoRequired), null);
    assert.match(refundFormProblem({ ...base, category: null }, photoRequired) ?? "", /what went wrong/);
    assert.match(refundFormProblem({ ...base, quantities: { a: 0 } }, photoRequired) ?? "", /item/);
    assert.match(refundFormProblem({ ...base, description: "bad" }, photoRequired) ?? "", /more/);
    assert.match(refundFormProblem({ ...base, category: "DAMAGED_ITEM" }, photoRequired) ?? "", /photo/);
    assert.equal(refundFormProblem({ ...base, category: "DAMAGED_ITEM", photoCount: 1 }, photoRequired), null);
  });

  it("sends chosen quantities only — never a price", () => {
    const items = refundFormItems({ ...base, quantities: { a: 2, b: 0, c: 1 } });
    assert.deepEqual(items, [
      { orderItemId: "a", qty: 2 },
      { orderItemId: "c", qty: 1 },
    ]);
    for (const item of items) assert.deepEqual(Object.keys(item).sort(), ["orderItemId", "qty"]);
  });
});
