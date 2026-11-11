/**
 * Financial Overview date filters (modules/finance/finance-period.ts) and the
 * pure money formulas (figures / buildTrend in finance-overview.service.ts).
 */

import { describe, expect, it } from 'vitest';
import { addDays, localDate, resolvePeriod, weekStart, PeriodError } from '../../src/modules/finance/finance-period';
import { buildTrend, figures, zeroMeasures } from '../../src/modules/finance/finance-overview.service';

const IST = 'Asia/Kolkata';
// 00:15 IST on Monday 2 Nov 2026 is still Sunday 1 Nov in UTC.
const NOW = new Date('2026-11-01T18:45:00.000Z');
const r = (preset: Parameters<typeof resolvePeriod>[0], custom = {}) => resolvePeriod(preset, custom, NOW, IST);
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('resolvePeriod (Indian time)', () => {
  it('"today" is the Indian calendar day, not the UTC one', () => {
    expect(localDate(NOW, IST)).toBe('2026-11-02');
    expect(r('TODAY')).toMatchObject({ fromDate: '2026-11-02', toDate: '2026-11-02' });
    expect(iso(r('TODAY').from)).toBe('2026-11-01T18:30:00.000Z');
    expect(iso(r('TODAY').to)).toBe('2026-11-02T18:30:00.000Z'); // exclusive
  });

  it('each preset covers exactly its days', () => {
    expect(r('YESTERDAY')).toMatchObject({ fromDate: '2026-11-01', toDate: '2026-11-01' });
    expect(r('LAST_7_DAYS')).toMatchObject({ fromDate: '2026-10-27', toDate: '2026-11-02' });
    expect(r('THIS_WEEK')).toMatchObject({ fromDate: '2026-11-02', toDate: '2026-11-02' }); // a Monday
    expect(r('THIS_MONTH')).toMatchObject({ fromDate: '2026-11-01', toDate: '2026-11-02' });
    expect(r('LAST_MONTH')).toMatchObject({ fromDate: '2026-10-01', toDate: '2026-10-31' });
    expect(r('THIS_YEAR')).toMatchObject({ fromDate: '2026-01-01', toDate: '2026-11-02' });
    expect(r('LIFETIME')).toMatchObject({ fromDate: null, toDate: null, from: null, to: null });
    expect(iso(r('LAST_MONTH').from)).toBe('2026-09-30T18:30:00.000Z');
    expect(iso(r('LAST_MONTH').to)).toBe('2026-10-31T18:30:00.000Z');
  });

  it('last month across a year boundary and in a leap February', () => {
    expect(resolvePeriod('LAST_MONTH', {}, new Date('2027-01-10T06:00:00Z'), IST)).toMatchObject({ fromDate: '2026-12-01', toDate: '2026-12-31' });
    expect(resolvePeriod('LAST_MONTH', {}, new Date('2028-03-05T06:00:00Z'), IST)).toMatchObject({ fromDate: '2028-02-01', toDate: '2028-02-29' });
    expect(resolvePeriod('THIS_WEEK', {}, new Date('2026-11-08T06:00:00Z'), IST)).toMatchObject({ fromDate: '2026-11-02', toDate: '2026-11-08' }); // Sunday
  });

  it('custom ranges are inclusive, validated and bounded', () => {
    expect(r('CUSTOM', { from: '2024-03-01', to: '2024-03-31' })).toMatchObject({ fromDate: '2024-03-01', toDate: '2024-03-31' });
    expect(iso(r('CUSTOM', { from: '2024-03-01', to: '2024-03-31' }).to)).toBe('2024-03-31T18:30:00.000Z');
    expect(() => r('CUSTOM', {})).toThrow(PeriodError);
    expect(() => r('CUSTOM', { from: '2024-03-10', to: '2024-03-01' })).toThrow(/on or before/);
    expect(() => r('CUSTOM', { from: '2023-02-29', to: '2023-03-01' })).toThrow(/real calendar dates/);
    expect(() => r('CUSTOM', { from: '2000-01-01', to: '2026-01-01' })).toThrow(/at most/);
  });

  it('weeks start on Monday; day arithmetic crosses months', () => {
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('figures', () => {
  it('Aadione earnings = delivery + platform fees + commission; seller money never overlaps; everything reconciles', () => {
    // Two orders: ₹1,000 products (₹50 coupon), ₹30 delivery, ₹5 platform, 10% commission;
    // ₹300 refunded after delivery of which ₹270 taken back from the seller, ₹30 commission reversed.
    const m = {
      ...zeroMeasures(),
      orders: 2,
      sellerPrice: 100000,
      coupon: 5000,
      delivery: 3000,
      platform: 500,
      commission: 10000,
      collected: 100000 - 5000 + 3000 + 500,
      productRefunded: 30000,
      deducted: 27000,
      commissionReversed: 3000,
    };
    const f = figures(m);
    expect(f.aadioneGrossPaise).toBe(3000 + 500 + 10000);
    expect(f.sellerPayablePaise).toBe(90000);
    expect(f.sellerNetPaise).toBe(63000);
    expect(f.aadioneNetPaise).toBe(3000 + 500 + 7000);
    expect(f.netRevenuePaise).toBe(98500 - 30000);
    expect(f.netCouponCostPaise).toBe(5000);
    expect(f.refundCostBeyondReversalsPaise).toBe(0);
    expect(f.reconciliationGapPaise).toBe(0);
    expect(f.sellerNetPaise + f.aadioneNetAfterCouponsPaise).toBe(f.netRevenuePaise);
  });

  it('rounding left by a partial refund is shown as Aadione’s cost, keeping the books exact', () => {
    const f = figures({ ...zeroMeasures(), sellerPrice: 999, commission: 100, collected: 999, productRefunded: 333, deducted: 299, commissionReversed: 33 });
    expect(f.refundCostBeyondReversalsPaise).toBe(1);
    expect(f.reconciliationGapPaise).toBe(0);
  });

  it('a recorded total that does not match its parts shows up as a reconciliation gap', () => {
    expect(figures({ ...zeroMeasures(), sellerPrice: 1000, collected: 1010 }).reconciliationGapPaise).toBe(10);
  });
});

describe('buildTrend', () => {
  it('buckets days into Monday weeks and calendar months; buckets add up to the whole', () => {
    const day = (d: string, collected: number) => ({ day: d, measures: { ...zeroMeasures(), orders: 1, collected, sellerPrice: collected } });
    const t = buildTrend([day('2026-10-31', 100), day('2026-11-01', 200), day('2026-11-02', 400)]);
    expect(t.daily.map((p) => p.start)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(t.weekly.map((p) => [p.start, p.grossRevenuePaise])).toEqual([['2026-10-26', 300], ['2026-11-02', 400]]);
    expect(t.monthly.map((p) => [p.start, p.grossRevenuePaise])).toEqual([['2026-10-01', 100], ['2026-11-01', 600]]);
  });
});
