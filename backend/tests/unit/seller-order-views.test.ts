/**
 * Seller-panel order views (seller-order-views.ts) and the stock-history
 * "before" figure (seller-listing.service availableBefore). DB-free.
 */

import { describe, expect, it } from 'vitest';
import { OrderStatus, SellerOrderStatus, StockLedgerReason } from '../../src/shared';
import {
  HANDED_OVER_ORDER_STATUSES,
  handoverOf,
  stageFilter,
  zonedDayRange,
  zonedToday,
} from '../../src/modules/orders/seller-order-views';
import { availableBefore } from '../../src/modules/catalog/seller-listing.service';

describe('handoverOf', () => {
  it('is null until the seller marks the order ready', () => {
    for (const status of [SellerOrderStatus.NEW, SellerOrderStatus.ACCEPTED, SellerOrderStatus.PREPARING, SellerOrderStatus.CANCELLED, SellerOrderStatus.REJECTED]) {
      expect(handoverOf(status, OrderStatus.DELIVERED)).toBeNull();
    }
  });

  it('follows the parent delivery leg once ready', () => {
    const ready = SellerOrderStatus.READY_FOR_PICKUP;
    expect(handoverOf(ready, OrderStatus.PROCESSING)).toBe('AWAITING_PICKUP');
    expect(handoverOf(ready, OrderStatus.READY_FOR_PICKUP)).toBe('AWAITING_PICKUP');
    expect(handoverOf(ready, OrderStatus.PARTIALLY_CANCELLED)).toBe('AWAITING_PICKUP');
    expect(handoverOf(ready, OrderStatus.PICKED_UP)).toBe('PICKED_UP');
    expect(handoverOf(ready, OrderStatus.OUT_FOR_DELIVERY)).toBe('OUT_FOR_DELIVERY');
    expect(handoverOf(ready, OrderStatus.DELIVERED)).toBe('DELIVERED');
  });
});

describe('stageFilter', () => {
  it('splits READY_FOR_PICKUP into waiting (READY) and handed over (COMPLETED)', () => {
    expect(stageFilter('READY')).toEqual({ status: SellerOrderStatus.READY_FOR_PICKUP, orderStatus: { notIn: [...HANDED_OVER_ORDER_STATUSES] } });
    expect(stageFilter('COMPLETED')).toEqual({ status: SellerOrderStatus.READY_FOR_PICKUP, orderStatus: { in: [...HANDED_OVER_ORDER_STATUSES] } });
  });

  it('groups rejected and cancelled orders', () => {
    expect(stageFilter('CANCELLED')).toEqual({
      status: { in: [SellerOrderStatus.REJECTED, SellerOrderStatus.CANCELLED] },
      orderStatus: null,
    });
  });
});

describe('zonedDayRange / zonedToday', () => {
  it('maps an Indian calendar day to its UTC instants', () => {
    const { start, end } = zonedDayRange('2026-10-01', 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T18:30:00.000Z');
  });

  it('rolls over months and years', () => {
    expect(zonedDayRange('2026-12-31', 'Asia/Kolkata').end.toISOString()).toBe('2026-12-31T18:30:00.000Z');
    expect(zonedDayRange('2026-02-28', 'UTC').end.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('reads today in the seller timezone, not UTC', () => {
    // 20:00 UTC on 30 Sep is already 1 Oct in India.
    expect(zonedToday('Asia/Kolkata', new Date('2026-09-30T20:00:00Z'))).toBe('2026-10-01');
    expect(zonedToday('UTC', new Date('2026-09-30T20:00:00Z'))).toBe('2026-09-30');
  });
});

describe('availableBefore', () => {
  it('undoes the delta for movements that change available stock', () => {
    expect(availableBefore(StockLedgerReason.MANUAL_ADJUST, 5, 17)).toBe(12);
    expect(availableBefore(StockLedgerReason.MANUAL_ADJUST, -3, 9)).toBe(12);
    expect(availableBefore(StockLedgerReason.ORDER_RESERVE, -2, 8)).toBe(10);
    expect(availableBefore(StockLedgerReason.ORDER_RELEASE, 2, 10)).toBe(8);
    expect(availableBefore(StockLedgerReason.ORDER_CANCEL_RESTOCK, 2, 12)).toBe(10);
  });

  it('keeps available unchanged for a sale (stock and reservation drop together)', () => {
    expect(availableBefore(StockLedgerReason.ORDER_COMMIT, -2, 8)).toBe(8);
  });
});
