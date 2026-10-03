/**
 * Unit tests for the pure "which seller orders still need cancelling" filter
 * behind admin's whole-order force-cancel (#2). Pure function only — does
 * not touch the database, even though the module it lives in also exports
 * DB-backed functions.
 */

import { describe, expect, it } from 'vitest';
import { SellerOrderStatus } from '../../src/shared';
import { selectSellerOrdersToCancel } from '../../src/modules/admin/admin-order.service';

function so(id: string, status: SellerOrderStatus) {
  return { id, status };
}

describe('selectSellerOrdersToCancel', () => {
  it('selects every seller order still in an active state', () => {
    const result = selectSellerOrdersToCancel([
      so('a', SellerOrderStatus.NEW),
      so('b', SellerOrderStatus.ACCEPTED),
      so('c', SellerOrderStatus.PREPARING),
      so('d', SellerOrderStatus.READY_FOR_PICKUP),
    ]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('excludes seller orders already REJECTED or CANCELLED', () => {
    const result = selectSellerOrdersToCancel([
      so('a', SellerOrderStatus.NEW),
      so('b', SellerOrderStatus.REJECTED),
      so('c', SellerOrderStatus.CANCELLED),
    ]);
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('returns an empty list when every seller order is already terminal', () => {
    // This is what makes retrying a whole-order cancellation safe: a second
    // call sees nothing left "active" and does nothing, rather than
    // re-attempting a transition that has already happened (#2).
    const result = selectSellerOrdersToCancel([
      so('a', SellerOrderStatus.CANCELLED),
      so('b', SellerOrderStatus.REJECTED),
    ]);
    expect(result).toHaveLength(0);
  });

  it('returns an empty list for an order with no seller orders at all', () => {
    expect(selectSellerOrdersToCancel([])).toHaveLength(0);
  });
});
