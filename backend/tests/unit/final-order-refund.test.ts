/**
 * The approved full-cancellation refund policy (2026-09-30), as a pure
 * decision: when EVERY seller portion of a paid online order is cancelled or
 * rejected, the delivery and platform fees are refunded — each as its own
 * typed component; never while any portion is still active, never more than
 * what remains captured, never twice.
 *
 * CHANGED 2026-11-01 (refund management, Phase 2): this used to refund
 * "everything still captured". When a seller-portion refund had FAILED, that
 * swept the seller's money into a refund labelled as the fees (the mislabel).
 * The fee refund is now exactly the order's fees; a failed portion is retried
 * as itself. The end-to-end behaviour is covered in
 * tests/integration/refund-groups.test.ts and seller-settlement.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { OrderStatus, PaymentMethod, SellerOrderStatus } from '../../src/shared';
import { feeRefundComponents, type FeeRefundInput } from '../../src/modules/payments/payment.service';

const { CANCELLED, REJECTED, NEW, ACCEPTED, READY_FOR_PICKUP } = SellerOrderStatus;

// ₹137 captured: ₹102 of items + ₹30 delivery + ₹5 platform fee; the ₹102
// seller portion already refunded.
const base: FeeRefundInput = {
  paymentMethod: PaymentMethod.ONLINE,
  orderStatus: OrderStatus.CANCELLED,
  sellerOrderStatuses: [CANCELLED],
  capturedPaise: 13_700,
  liveRefundedPaise: 10_200,
  deliveryFeePaise: 3_000,
  platformFeePaise: 500,
  liveDeliveryFeeRefundedPaise: 0,
  livePlatformFeeRefundedPaise: 0,
  feesCoveredByOtherRefund: false,
};

const total = (input: FeeRefundInput) => feeRefundComponents(input).reduce((s, c) => s + c.amountPaise, 0);

describe('feeRefundComponents', () => {
  it('single-seller order fully cancelled: the delivery and platform fees, each typed, so the total comes back', () => {
    expect(feeRefundComponents(base)).toEqual([
      { type: 'DELIVERY_FEE', amountPaise: 3_000 },
      { type: 'PLATFORM_FEE', amountPaise: 500 },
    ]);
    expect(base.liveRefundedPaise + total(base)).toBe(base.capturedPaise);
  });

  it('THE MISLABEL FIX: a seller portion whose refund FAILED is never swept into the fee refund', () => {
    // The ₹102 portion refund failed (not live): ₹137 is still captured, but
    // the fee refund is still just ₹35 — the ₹102 is retried as itself.
    expect(feeRefundComponents({ ...base, liveRefundedPaise: 0 })).toEqual([
      { type: 'DELIVERY_FEE', amountPaise: 3_000 },
      { type: 'PLATFORM_FEE', amountPaise: 500 },
    ]);
  });

  it('multi-seller, one portion cancelled and another still active: no fee refund yet', () => {
    for (const active of [NEW, ACCEPTED, READY_FOR_PICKUP]) {
      expect(feeRefundComponents({ ...base, orderStatus: OrderStatus.PARTIALLY_CANCELLED, sellerOrderStatuses: [CANCELLED, active] })).toEqual([]);
    }
  });

  it('multi-seller, the last active portion cancelled or rejected: the fees', () => {
    expect(total({ ...base, sellerOrderStatuses: [CANCELLED, REJECTED, CANCELLED], capturedPaise: 62_000, liveRefundedPaise: 58_500 })).toBe(3_500);
  });

  it('a repeated attempt after the fee refunds are live: nothing more; one fee live -> only the other', () => {
    expect(
      feeRefundComponents({ ...base, liveRefundedPaise: 13_700, liveDeliveryFeeRefundedPaise: 3_000, livePlatformFeeRefundedPaise: 500 }),
    ).toEqual([]);
    expect(feeRefundComponents({ ...base, liveRefundedPaise: 13_200, liveDeliveryFeeRefundedPaise: 3_000 })).toEqual([
      { type: 'PLATFORM_FEE', amountPaise: 500 },
    ]);
  });

  it('a live whole-order or pre-split fee refund already covers the fees: nothing', () => {
    expect(feeRefundComponents({ ...base, feesCoveredByOtherRefund: true })).toEqual([]);
  });

  it('already fully refunded: safe no-op', () => {
    expect(feeRefundComponents({ ...base, orderStatus: OrderStatus.REFUNDED, liveRefundedPaise: 13_700 })).toEqual([]);
  });

  it('never exceeds what remains captured (delivery first)', () => {
    expect(feeRefundComponents({ ...base, liveRefundedPaise: 14_000 })).toEqual([]);
    expect(feeRefundComponents({ ...base, liveRefundedPaise: 11_700 })).toEqual([{ type: 'DELIVERY_FEE', amountPaise: 2_000 }]);
    for (const live of [10_200, 11_000, 13_000, 13_699]) {
      expect(live + total({ ...base, liveRefundedPaise: live })).toBeLessThanOrEqual(base.capturedPaise);
    }
  });

  it('free delivery and no platform fee: no component at all (never a zero-amount refund)', () => {
    expect(feeRefundComponents({ ...base, deliveryFeePaise: 0, platformFeePaise: 0 })).toEqual([]);
    expect(feeRefundComponents({ ...base, deliveryFeePaise: 0 })).toEqual([{ type: 'PLATFORM_FEE', amountPaise: 500 }]);
  });

  it('never for COD, an order without seller portions, or one already out for delivery', () => {
    expect(feeRefundComponents({ ...base, paymentMethod: PaymentMethod.COD })).toEqual([]);
    expect(feeRefundComponents({ ...base, sellerOrderStatuses: [] })).toEqual([]);
    for (const orderStatus of [OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED]) {
      expect(feeRefundComponents({ ...base, orderStatus })).toEqual([]);
    }
  });
});
