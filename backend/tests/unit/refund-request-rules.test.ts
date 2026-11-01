/**
 * Refund requests — the server's valuation of the chosen items and the split
 * of an approved amount (src/modules/refunds/refund-request-rules.ts).
 */

import { describe, expect, it } from 'vitest';
import { allocateApproved, linePaidPaise, perSellerOrder, sniffImageType, valueOfQty } from '../../src/modules/refunds/refund-request-rules';

describe('valueOfQty — what the customer paid for part of a line', () => {
  const line = { qty: 3, lineTotalPaise: 99999, couponDiscountPaise: 3333 };
  it('the whole line is exactly what was paid (net of the Aadione coupon share)', () => {
    expect(linePaidPaise(line)).toBe(96666);
    expect(valueOfQty(line, 3)).toBe(96666);
  });
  it('part of a line is proportional, rounded down; never above the line', () => {
    expect(valueOfQty(line, 1)).toBe(32222);
    expect(valueOfQty(line, 2)).toBe(64444);
    expect(valueOfQty(line, 9)).toBe(96666);
    expect(valueOfQty(line, 0)).toBe(0);
  });
});

describe('allocateApproved — an approval below the request', () => {
  it('spreads exactly (largest remainder), never above any line', () => {
    const lines = [
      { id: 'a', amountPaise: 60000 },
      { id: 'b', amountPaise: 40000 },
      { id: 'c', amountPaise: 1 },
    ];
    const out = allocateApproved(lines, 33333);
    expect(out.reduce((s, l) => s + l.approvedPaise, 0)).toBe(33333);
    for (const l of out) expect(l.approvedPaise).toBeLessThanOrEqual(l.amountPaise);
    expect(allocateApproved(lines, 100001).map((l) => l.approvedPaise)).toEqual([60000, 40000, 1]);
    expect(allocateApproved(lines, 0).map((l) => l.approvedPaise)).toEqual([0, 0, 0]);
  });
  it('sums per seller portion', () => {
    const out = perSellerOrder([
      { sellerOrderId: 'x', approvedPaise: 100 },
      { sellerOrderId: 'y', approvedPaise: 50 },
      { sellerOrderId: 'x', approvedPaise: 25 },
      { sellerOrderId: 'z', approvedPaise: 0 },
    ]);
    expect([...out.entries()]).toEqual([
      ['x', 125],
      ['y', 50],
    ]);
  });
});

describe('sniffImageType — the bytes, not the claim', () => {
  it('JPEG, PNG and WebP by their signatures; anything else refused', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});
