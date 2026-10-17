/**
 * Inventory modes (inventory/stock-rules.ts): a made-to-order food listing has
 * no stock count; a physical listing keeps exact stock rules.
 */

import { describe, expect, it } from 'vitest';
import { hasStockToSell, hasStockToSellSql, sellableQty, trackedAvailableQty } from '../../src/modules/inventory/stock-rules';
import { stockState } from '../../src/modules/admin/admin-marketplace-views';
import { listingVisibility } from '../../src/modules/catalog/listing-visibility';

const tracked = (stockQty: number, reservedQty = 0) => ({ tracksStock: true, stockQty, reservedQty, maxQtyPerOrder: 10 });
const food = (stockQty = 0, reservedQty = 0) => ({ tracksStock: false, stockQty, reservedQty, maxQtyPerOrder: 4 });

describe('stock rules', () => {
  it('a tracked listing sells stock − reserved, and can run out', () => {
    expect(trackedAvailableQty(tracked(10, 3))).toBe(7);
    expect(trackedAvailableQty(tracked(2, 5))).toBe(0);
    expect(hasStockToSell(tracked(1, 0))).toBe(true);
    expect(hasStockToSell(tracked(3, 3))).toBe(false);
    expect(sellableQty(tracked(10, 3))).toBe(7);
  });

  it('a made-to-order item has NO stock count — never "out of stock", limited only per order', () => {
    expect(trackedAvailableQty(food())).toBeNull();
    expect(hasStockToSell(food())).toBe(true);
    expect(sellableQty(food())).toBe(4);
    // Legacy rows still carrying the fabricated 100000 behave the same.
    expect(sellableQty(food(100_000, 2))).toBe(4);
  });

  it('the SQL form is the same rule and refuses a non-identifier alias', () => {
    expect(hasStockToSellSql('sl').sql).toBe('(NOT sl.tracks_stock OR sl.stock_qty - sl.reserved_qty > 0)');
    expect(() => hasStockToSellSql('sl; DROP TABLE x')).toThrow();
  });
});

describe('admin stock state', () => {
  it('a made-to-order listing is MADE_TO_ORDER with 0 units — out of every stock total', () => {
    expect(stockState({ tracksStock: false, stockQty: 100_000, reservedQty: 0, lowStockThreshold: 5 })).toEqual({ availableQty: 0, state: 'MADE_TO_ORDER' });
    expect(stockState({ tracksStock: false, stockQty: 0, reservedQty: 0, lowStockThreshold: 5 }).state).toBe('MADE_TO_ORDER');
  });

  it('tracked listings keep IN_STOCK / LOW / OUT', () => {
    expect(stockState({ tracksStock: true, stockQty: 20, reservedQty: 2, lowStockThreshold: 5 })).toEqual({ availableQty: 18, state: 'IN_STOCK' });
    expect(stockState({ tracksStock: true, stockQty: 3, reservedQty: 0, lowStockThreshold: 5 }).state).toBe('LOW');
    expect(stockState({ tracksStock: true, stockQty: 0, reservedQty: 0, lowStockThreshold: 5 }).state).toBe('OUT');
  });
});

describe('seller/admin visibility', () => {
  const base = {
    store: { isActive: true, deletedAt: null, onboardingStatus: 'APPROVED' },
    product: { status: 'ACTIVE', deletedAt: null, approvalStatus: 'APPROVED' },
    variant: { status: 'ACTIVE', deletedAt: null },
  };

  it('a made-to-order item with stock 0 is VISIBLE (never OUT_OF_STOCK or low)', () => {
    const v = listingVisibility({ ...base, listing: { isAvailable: true, tracksStock: false, stockQty: 0, reservedQty: 0, lowStockThreshold: 5 } });
    expect(v).toMatchObject({ sellable: true, reason: 'VISIBLE', availableQty: 0, lowStock: false });
    // Switched off by the restaurant: off sale, as before.
    expect(listingVisibility({ ...base, listing: { isAvailable: false, tracksStock: false, stockQty: 0, reservedQty: 0, lowStockThreshold: 5 } }).reason).toBe('OFF_SALE');
  });

  it('a tracked item at 0 is still OUT_OF_STOCK', () => {
    expect(listingVisibility({ ...base, listing: { isAvailable: true, tracksStock: true, stockQty: 0, reservedQty: 0, lowStockThreshold: 5 } }).reason).toBe('OUT_OF_STOCK');
  });
});
