/**
 * Unpaid / payment-expired orders and their seller orders.
 *
 * A seller order becomes the seller's only once its parent is placed (COD at
 * creation, ONLINE once paid). When an online order's payment fails or its
 * hold expires, the parent goes PAYMENT_FAILED and every seller portion is
 * closed as CANCELLED (the existing terminal state, as for an order cancelled
 * before payment) — never left NEW, never shown to or actionable by the seller.
 *
 * DB-backed end-to-end coverage: tests/integration/seller-settlement.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  ActorType,
  OrderStatus,
  SellerOrderStatus,
  canActorTransitionSellerOrder,
  canTransitionSellerOrder,
} from '../../src/shared';
import { isOrderVisibleToSeller, sellerVisibleOrderWhere } from '../../src/modules/orders/order-visibility';

const placedAt = new Date('2026-09-30T10:00:00Z');

describe('isOrderVisibleToSeller', () => {
  it('hides orders that were never placed: awaiting payment, payment failed/expired, cancelled before payment', () => {
    expect(isOrderVisibleToSeller({ status: OrderStatus.PENDING_PAYMENT, placedAt: null })).toBe(false);
    expect(isOrderVisibleToSeller({ status: OrderStatus.PAYMENT_FAILED, placedAt: null })).toBe(false);
    expect(isOrderVisibleToSeller({ status: OrderStatus.CANCELLED, placedAt: null })).toBe(false);
  });

  it('shows every placed order, including ones cancelled or refunded after placement', () => {
    for (const status of [
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.PROCESSING,
      OrderStatus.PARTIALLY_CANCELLED,
      OrderStatus.READY_FOR_PICKUP,
      OrderStatus.PICKED_UP,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED,
      OrderStatus.REFUNDED,
    ]) {
      expect(isOrderVisibleToSeller({ status, placedAt })).toBe(true);
    }
    expect(isOrderVisibleToSeller({ status: OrderStatus.CANCELLED, placedAt })).toBe(true);
  });

  it('the Prisma filter expresses the same rule', () => {
    expect(sellerVisibleOrderWhere).toEqual({
      status: { notIn: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_FAILED] },
      NOT: { status: OrderStatus.CANCELLED, placedAt: null },
    });
  });
});

describe('seller-order state machine facts the expiry fix relies on (unchanged)', () => {
  it('CANCELLED is a legal, terminal outcome for a NEW seller order', () => {
    expect(canTransitionSellerOrder(SellerOrderStatus.NEW, SellerOrderStatus.CANCELLED)).toBe(true);
    for (const next of Object.values(SellerOrderStatus)) {
      expect(canTransitionSellerOrder(SellerOrderStatus.CANCELLED, next)).toBe(false);
    }
  });

  it('REJECTED stays the seller’s own refusal — not a system outcome for an unpaid order', () => {
    expect(canActorTransitionSellerOrder(SellerOrderStatus.NEW, SellerOrderStatus.REJECTED, ActorType.SELLER)).toBe(true);
    expect(canActorTransitionSellerOrder(SellerOrderStatus.NEW, SellerOrderStatus.REJECTED, ActorType.SYSTEM)).toBe(false);
  });
});
