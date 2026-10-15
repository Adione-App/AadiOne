/**
 * Aadione-funded coupon allocation and per-seller platform figures — pure.
 */

import { describe, expect, it } from 'vitest';
import { allocateProportionally, customerPaidPaise } from '../../src/modules/orders/coupon-allocation';
import { sellerPortionFigures } from '../../src/modules/orders/order-financials.service';
import { SellerOrderStatus } from '../../src/shared';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('allocateProportionally', () => {
  it('the worked example: ₹50 over ₹600 + ₹400 is ₹30 + ₹20', () => {
    expect(allocateProportionally(5000, [60000, 40000])).toEqual([3000, 2000]);
  });

  it('largest remainder: the leftover paise go to the largest remainders, ties to the earlier line', () => {
    expect(allocateProportionally(100, [10000, 10000, 10000])).toEqual([34, 33, 33]);
    expect(allocateProportionally(2, [1, 1, 1])).toEqual([1, 1, 0]);
    // 7 * 5/9 = 3.89, 7 * 3/9 = 2.33, 7 * 1/9 = 0.78 -> floors 3,2,0 (5), leftover 2 -> largest remainders: .89, .78
    expect(allocateProportionally(7, [5, 3, 1])).toEqual([4, 2, 1]);
  });

  it('no coupon allocates nothing; a coupon equal to the base covers every line exactly', () => {
    expect(allocateProportionally(0, [60000, 40000])).toEqual([0, 0]);
    expect(allocateProportionally(100000, [60000, 40000])).toEqual([60000, 40000]);
    expect(allocateProportionally(0, [])).toEqual([]);
  });

  it('refuses money that cannot be allocated', () => {
    expect(() => allocateProportionally(100001, [60000, 40000])).toThrow(/exceeds/);
    expect(() => allocateProportionally(10, [0, 0])).toThrow();
    expect(() => allocateProportionally(1.5, [1])).toThrow();
    expect(() => allocateProportionally(10, [-1, 20])).toThrow();
  });

  it('always sums exactly, never exceeds a line, never goes below the floor — over many random orders', () => {
    let seed = 42;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % max;
    };
    for (let run = 0; run < 2000; run += 1) {
      const lines = Array.from({ length: 1 + rand(8) }, () => 1 + rand(500000));
      const base = sum(lines);
      const coupon = rand(base + 1);
      const shares = allocateProportionally(coupon, lines);
      expect(sum(shares)).toBe(coupon);
      shares.forEach((share, i) => {
        expect(share).toBeGreaterThanOrEqual(Math.floor((coupon * lines[i]!) / base));
        expect(share).toBeLessThanOrEqual(lines[i]!);
      });
    }
  });

  it('is exact for amounts far beyond Number precision of the intermediate product', () => {
    const shares = allocateProportionally(999_999_999, [1_000_000_000, 3, 1_000_000_000]);
    expect(sum(shares)).toBe(999_999_999);
    expect(shares[1]).toBeLessThanOrEqual(3);
  });
});

describe('seller portion figures (the worked example)', () => {
  const A = { subtotalPaise: 60000, couponDiscountPaise: 3000, commissionPaise: 6000 };
  const B = { subtotalPaise: 40000, couponDiscountPaise: 2000, commissionPaise: 4000 };

  it('commission and payout ignore the coupon; net contribution subtracts it', () => {
    const a = sellerPortionFigures({ ...A, status: SellerOrderStatus.ACCEPTED });
    const b = sellerPortionFigures({ ...B, status: SellerOrderStatus.ACCEPTED });
    expect(a).toMatchObject({
      sellerPayablePaise: 54000,
      effectiveCommissionPaise: 6000,
      effectiveCouponExpensePaise: 3000,
      netCommissionContributionPaise: 3000,
      customerPaidPaise: 57000,
    });
    expect(b).toMatchObject({
      sellerPayablePaise: 36000,
      effectiveCommissionPaise: 4000,
      effectiveCouponExpensePaise: 2000,
      netCommissionContributionPaise: 2000,
      customerPaidPaise: 38000,
    });
  });

  it('a cancelled portion pays nothing, earns nothing, costs nothing — reversed exactly once', () => {
    for (const status of [SellerOrderStatus.CANCELLED, SellerOrderStatus.REJECTED]) {
      expect(sellerPortionFigures({ ...A, status })).toMatchObject({
        active: false,
        sellerPayablePaise: 0,
        effectiveCommissionPaise: 0,
        effectiveCouponExpensePaise: 0,
        netCommissionContributionPaise: 0,
        reversedCommissionPaise: 6000,
        reversedCouponExpensePaise: 3000,
      });
    }
  });

  it('a coupon larger than the commission is a negative net contribution, never a seller deduction', () => {
    const f = sellerPortionFigures({ subtotalPaise: 10000, couponDiscountPaise: 3000, commissionPaise: 1000, status: SellerOrderStatus.NEW });
    expect(f.netCommissionContributionPaise).toBe(-2000);
    expect(f.sellerPayablePaise).toBe(9000);
  });

  it('customer-paid amount never goes negative', () => {
    expect(customerPaidPaise(5000, 5000)).toBe(0);
    expect(customerPaidPaise(5000, 0)).toBe(5000);
  });
});
