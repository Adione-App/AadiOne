/**
 * The approved full-cancellation refund policy (2026-09-30), as a pure
 * decision: when EVERY seller portion of a paid online order is cancelled or
 * rejected, whatever is still captured — delivery and platform fees included —
 * is refunded as one final order-level refund; never while any portion is
 * still active, never more than what remains captured, never twice.
 *
 * The end-to-end behaviour (real refunds, REFUNDED transition, earnings) is
 * covered in tests/integration/seller-settlement.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { OrderStatus, PaymentMethod, SellerOrderStatus } from '../../src/shared';
import { finalOrderRefundPaise, type FinalOrderRefundInput } from '../../src/modules/payments/payment.service';

const { CANCELLED, REJECTED, NEW, ACCEPTED, READY_FOR_PICKUP } = SellerOrderStatus;

// ₹137 captured: ₹102 of items + ₹30 delivery + ₹5 platform fee.
const base: FinalOrderRefundInput = {
  paymentMethod: PaymentMethod.ONLINE,
  orderStatus: OrderStatus.CANCELLED,
  sellerOrderStatuses: [CANCELLED],
  capturedPaise: 13_700,
  liveRefundedPaise: 10_200,
  hasLiveOrderLevelRefund: false,
};

describe('finalOrderRefundPaise', () => {
  it('single-seller order fully cancelled: refunds the fees still captured, so the total comes back', () => {
    const final = finalOrderRefundPaise(base);
    expect(final).toBe(3_500);
    expect(base.liveRefundedPaise + final).toBe(base.capturedPaise);
  });

  it('multi-seller, one portion cancelled and another still active: no final refund yet', () => {
    for (const active of [NEW, ACCEPTED, READY_FOR_PICKUP]) {
      expect(
        finalOrderRefundPaise({ ...base, orderStatus: OrderStatus.PARTIALLY_CANCELLED, sellerOrderStatuses: [CANCELLED, active] }),
      ).toBe(0);
    }
  });

  it('multi-seller, the last active portion cancelled or rejected: refunds everything still captured', () => {
    expect(
      finalOrderRefundPaise({ ...base, sellerOrderStatuses: [CANCELLED, REJECTED, CANCELLED], capturedPaise: 62_000, liveRefundedPaise: 61_500 }),
    ).toBe(500);
  });

  it('repeated attempt after the final refund is live: nothing more', () => {
    expect(finalOrderRefundPaise({ ...base, liveRefundedPaise: 13_700, hasLiveOrderLevelRefund: true })).toBe(0);
    // Even if the order-level flag were missed, nothing is left captured.
    expect(finalOrderRefundPaise({ ...base, liveRefundedPaise: 13_700 })).toBe(0);
  });

  it('already fully refunded: safe no-op', () => {
    expect(finalOrderRefundPaise({ ...base, orderStatus: OrderStatus.REFUNDED, liveRefundedPaise: 13_700 })).toBe(0);
  });

  it('never exceeds what remains captured', () => {
    expect(finalOrderRefundPaise({ ...base, liveRefundedPaise: 14_000 })).toBe(0);
    for (const live of [0, 1, 9_999, 13_699]) {
      const final = finalOrderRefundPaise({ ...base, liveRefundedPaise: live });
      expect(final).toBe(13_700 - live);
      expect(live + final).toBeLessThanOrEqual(base.capturedPaise);
    }
  });

  it('never for COD, an order without seller portions, or one already out for delivery', () => {
    expect(finalOrderRefundPaise({ ...base, paymentMethod: PaymentMethod.COD })).toBe(0);
    expect(finalOrderRefundPaise({ ...base, sellerOrderStatuses: [] })).toBe(0);
    for (const orderStatus of [OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED]) {
      expect(finalOrderRefundPaise({ ...base, orderStatus })).toBe(0);
    }
  });
});
