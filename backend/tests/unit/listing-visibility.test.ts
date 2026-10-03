/**
 * listingVisibility — the seller-panel answer to "can a customer buy this
 * now?", built on cart/orderability.ts. DB-free.
 */

import { describe, expect, it } from 'vitest';
import { isAdminRestricted, listingVisibility, type ListingVisibilityInput } from '../../src/modules/catalog/listing-visibility';

const base: ListingVisibilityInput = {
  store: { isActive: true, deletedAt: null, onboardingStatus: 'APPROVED' },
  product: { status: 'ACTIVE', deletedAt: null, approvalStatus: 'APPROVED' },
  variant: { status: 'ACTIVE', deletedAt: null },
  listing: { isAvailable: true, stockQty: 20, reservedQty: 2, lowStockThreshold: 5 },
};
const withs = (patch: Partial<{ [K in keyof ListingVisibilityInput]: Partial<NonNullable<ListingVisibilityInput[K]>> | null }>) =>
  listingVisibility({
    store: { ...base.store, ...(patch.store ?? {}) },
    product: { ...base.product, ...(patch.product ?? {}) },
    variant: patch.variant === null ? null : { ...base.variant!, ...(patch.variant ?? {}) },
    listing: patch.listing === null ? null : { ...base.listing!, ...(patch.listing ?? {}) },
  });

describe('listingVisibility', () => {
  it('is VISIBLE when every layer allows it, with available = stock − reserved', () => {
    expect(withs({})).toEqual({ sellable: true, reason: 'VISIBLE', availableQty: 18, lowStock: false });
  });

  it('store restrictions come first and are admin-owned', () => {
    expect(withs({ store: { isActive: false } }).reason).toBe('STORE_DEACTIVATED');
    expect(withs({ store: { onboardingStatus: 'PENDING' } }).reason).toBe('STORE_NOT_APPROVED');
    expect(isAdminRestricted('STORE_DEACTIVATED')).toBe(true);
  });

  it('an admin-disabled (ARCHIVED) product is not sellable whatever the seller switches say', () => {
    const v = withs({ product: { status: 'ARCHIVED' }, listing: { isAvailable: true } });
    expect(v).toMatchObject({ sellable: false, reason: 'DISABLED_BY_ADMIN' });
    expect(isAdminRestricted(v.reason)).toBe(true);
  });

  it('maps the approval workflow', () => {
    expect(withs({ product: { approvalStatus: 'PENDING' } }).reason).toBe('PENDING_APPROVAL');
    expect(withs({ product: { approvalStatus: 'REJECTED' } }).reason).toBe('REJECTED');
  });

  it('seller switches: hidden product, off-sale listing, not listed', () => {
    expect(withs({ product: { status: 'INACTIVE' } }).reason).toBe('HIDDEN_BY_SELLER');
    expect(withs({ listing: { isAvailable: false } }).reason).toBe('OFF_SALE');
    expect(withs({ listing: null }).reason).toBe('NOT_LISTED');
    expect(isAdminRestricted('HIDDEN_BY_SELLER')).toBe(false);
  });

  it('out of stock counts reserved units, and low stock is flagged before it', () => {
    expect(withs({ listing: { stockQty: 3, reservedQty: 3 } })).toMatchObject({ sellable: false, reason: 'OUT_OF_STOCK', availableQty: 0 });
    expect(withs({ listing: { stockQty: 6, reservedQty: 1 } })).toMatchObject({ sellable: true, lowStock: true, availableQty: 5 });
  });
});
