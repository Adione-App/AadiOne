/**
 * Refund after delivery — what comes back from the seller, what Aadione
 * gives up (src/modules/refunds/refund-accounting.ts). Final approved policy:
 * commission on a refunded item is REVERSED; the seller gives back exactly its
 * net settlement for the refunded part; the Aadione-funded coupon is never
 * charged to the seller.
 */

import { describe, expect, it } from 'vitest';
import { NO_PRIOR, customerPaidForLine, reverseLine, sellerNetForLine, type LineMoney, type PriorReversals } from '../../src/modules/refunds/refund-accounting';

const add = (prior: PriorReversals, r: ReturnType<typeof reverseLine>): PriorReversals => ({
  refundedPaise: prior.refundedPaise + r.refundedPaise,
  sellerNetPaise: prior.sellerNetPaise + r.sellerNetPaise,
  commissionPaise: prior.commissionPaise + r.commissionPaise,
  couponPaise: prior.couponPaise + r.couponPaise,
});

describe('the approved examples', () => {
  it('₹600 item, ₹60 commission: customer gets ₹600, seller gives back ₹540, ₹60 commission reversed', () => {
    const line: LineMoney = { lineTotalPaise: 60000, commissionPaise: 6000, couponDiscountPaise: 0 };
    expect(sellerNetForLine(line)).toBe(54000);
    expect(reverseLine(line, NO_PRIOR, 60000)).toEqual({ refundedPaise: 60000, sellerNetPaise: 54000, commissionPaise: 6000, couponPaise: 0 });
  });

  it('₹600 item, ₹60 commission, ₹30 Aadione coupon: customer paid and gets ₹570, seller gives back ₹540 — the coupon is never charged to the seller', () => {
    const line: LineMoney = { lineTotalPaise: 60000, commissionPaise: 6000, couponDiscountPaise: 3000 };
    expect(customerPaidForLine(line)).toBe(57000);
    expect(reverseLine(line, NO_PRIOR, 57000)).toEqual({ refundedPaise: 57000, sellerNetPaise: 54000, commissionPaise: 6000, couponPaise: 3000 });
    // Everyone back to zero: Aadione refunded 570, recovered 540, gave up 60 commission, no longer bears the 30 coupon.
    expect(57000 - 54000).toBe(6000 - 3000);
  });
});

describe('partial and repeated refunds on one line', () => {
  const line: LineMoney = { lineTotalPaise: 120000, commissionPaise: 12000, couponDiscountPaise: 0 }; // 2 × ₹600

  it('one unit of two, then the other: ₹540 each, ₹1,080 in total — exactly the line, never more', () => {
    const first = reverseLine(line, NO_PRIOR, 60000);
    expect(first).toEqual({ refundedPaise: 60000, sellerNetPaise: 54000, commissionPaise: 6000, couponPaise: 0 });
    const second = reverseLine(line, add(NO_PRIOR, first), 60000);
    expect(second).toEqual({ refundedPaise: 60000, sellerNetPaise: 54000, commissionPaise: 6000, couponPaise: 0 });
    // Anything more is nothing: commission is never reversed twice.
    const third = reverseLine(line, add(add(NO_PRIOR, first), second), 1);
    expect(third).toEqual({ refundedPaise: 0, sellerNetPaise: 0, commissionPaise: 0, couponPaise: 0 });
  });

  it('awkward amounts round down per step and still sum exactly to the line on the last refund', () => {
    const odd: LineMoney = { lineTotalPaise: 99999, commissionPaise: 10000, couponDiscountPaise: 3333 }; // paid 96666, net 89999
    let prior = NO_PRIOR;
    const steps = [1, 33333, 17, 40000, 23315]; // sums to 96666
    for (const step of steps) {
      const r = reverseLine(odd, prior, step);
      expect(r.sellerNetPaise).toBeGreaterThanOrEqual(0);
      prior = add(prior, r);
      expect(prior.sellerNetPaise).toBeLessThanOrEqual(89999);
      expect(prior.commissionPaise).toBeLessThanOrEqual(10000);
      expect(prior.couponPaise).toBeLessThanOrEqual(3333);
    }
    expect(prior).toEqual({ refundedPaise: 96666, sellerNetPaise: 89999, commissionPaise: 10000, couponPaise: 3333 });
  });

  it('a refund above what is still unrefunded is capped; never negative', () => {
    expect(reverseLine(line, NO_PRIOR, 999999)).toEqual({ refundedPaise: 120000, sellerNetPaise: 108000, commissionPaise: 12000, couponPaise: 0 });
    expect(reverseLine(line, NO_PRIOR, -5)).toEqual({ refundedPaise: 0, sellerNetPaise: 0, commissionPaise: 0, couponPaise: 0 });
  });

  it('earlier deductions recorded generously are never "given back" (no negative step)', () => {
    const prior: PriorReversals = { refundedPaise: 30000, sellerNetPaise: 30000, commissionPaise: 3000, couponPaise: 0 };
    expect(reverseLine(line, prior, 1000).sellerNetPaise).toBe(0);
  });

  it('an item the coupon paid for in full: nothing refundable, nothing recovered', () => {
    expect(reverseLine({ lineTotalPaise: 5000, commissionPaise: 500, couponDiscountPaise: 5000 }, NO_PRIOR, 5000)).toEqual({
      refundedPaise: 0,
      sellerNetPaise: 0,
      commissionPaise: 0,
      couponPaise: 0,
    });
  });
});
