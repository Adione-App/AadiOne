/**
 * Unit tests for commission math (#1). Pure function only — no database.
 *
 * The property under test: summing PER-ITEM floored commission can never
 * equal what a single top-level "floor(sum * rate)" computation would give
 * for the same rate, once you have more than one item — which is exactly
 * why `SellerOrder.commissionPaise` must be built by SUMMING
 * `OrderItem.commissionPaise`, never by re-deriving it from
 * `SellerOrder.itemsSubtotalPaise` after the fact (see order.service.ts's
 * `placeOrder`, which does the former).
 */

import { describe, expect, it } from 'vitest';
import { commissionPaiseFor } from '../../src/modules/commission/commission.service';

describe('commissionPaiseFor', () => {
  it('floors down, never rounding in the seller’s favour or the platform’s', () => {
    // 5% of ₹100.01 (10001 paise) is 500.05 paise — must floor to 500, not 501.
    expect(commissionPaiseFor(10001, 500)).toBe(500);
  });

  it('is zero for a zero rate or a zero subtotal', () => {
    expect(commissionPaiseFor(10000, 0)).toBe(0);
    expect(commissionPaiseFor(0, 500)).toBe(0);
  });

  it('handles a 100% rate exactly (10000 bp)', () => {
    expect(commissionPaiseFor(12345, 10_000)).toBe(12345);
  });

  it('proves summing per-item floors is NOT the same as flooring the combined subtotal', () => {
    // Same 200-paise subtotal, at 3.33% (333 bp) — split one way vs another.
    const rateBp = 333;

    // Recomputing from the combined subtotal (what SellerOrder.commissionPaise
    // must NEVER do):
    const fromCombinedSubtotal = commissionPaiseFor(200, rateBp);
    expect(fromCombinedSubtotal).toBe(6); // floor(200 * 0.0333) = floor(6.66)

    // Summing the ACTUAL per-item values (what order.service.ts's `placeOrder`
    // does, and what SellerOrder.commissionPaise must equal):
    const sumOfActualItems =
      commissionPaiseFor(50, rateBp) + commissionPaiseFor(150, rateBp);
    expect(sumOfActualItems).toBe(5); // floor(1.665) + floor(4.995) = 1 + 4

    // They genuinely disagree — this is exactly why OrderItem is the source
    // of truth and SellerOrder.commissionPaise is a SUM, never a
    // recomputation from itemsSubtotalPaise.
    expect(sumOfActualItems).not.toBe(fromCombinedSubtotal);
  });

  it('never produces a negative commission for a non-negative input', () => {
    expect(commissionPaiseFor(0, 0)).toBeGreaterThanOrEqual(0);
    expect(commissionPaiseFor(1, 1)).toBeGreaterThanOrEqual(0);
  });
});
