/**
 * Parent-order roll-up from seller orders (`derivedParentOrderStatus`) —
 * including the READY_FOR_PICKUP gap: cancelling the LAST active portion of a
 * ready order must end the parent CANCELLED (from where the existing refund
 * path takes it to REFUNDED), not leave it waiting for a pickup of nothing.
 *
 * The end-to-end behaviour (real cancellations, refunds, REFUNDED) is covered
 * in tests/integration/seller-settlement.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  ActorType,
  OrderStatus,
  SellerOrderStatus,
  canActorTransition,
  canActorTransitionSellerOrder,
  canTransition,
} from '../../src/shared';
import { derivedParentOrderStatus } from '../../src/modules/orders/order-state.service';

const { NEW, ACCEPTED, PREPARING, READY_FOR_PICKUP, CANCELLED, REJECTED } = SellerOrderStatus;

describe('derivedParentOrderStatus', () => {
  it('PROCESSING + final seller portion cancelled -> CANCELLED (then REFUNDED is a legal SYSTEM step)', () => {
    expect(derivedParentOrderStatus(OrderStatus.PROCESSING, [CANCELLED])).toBe(OrderStatus.CANCELLED);
    expect(derivedParentOrderStatus(OrderStatus.PARTIALLY_CANCELLED, [REJECTED, CANCELLED])).toBe(OrderStatus.CANCELLED);
    expect(canActorTransition(OrderStatus.CANCELLED, OrderStatus.REFUNDED, ActorType.SYSTEM)).toBe(true);
  });

  it('READY_FOR_PICKUP + final seller portion cancelled -> CANCELLED, so a full refund can reach REFUNDED', () => {
    expect(derivedParentOrderStatus(OrderStatus.READY_FOR_PICKUP, [CANCELLED])).toBe(OrderStatus.CANCELLED);
    expect(derivedParentOrderStatus(OrderStatus.READY_FOR_PICKUP, [CANCELLED, REJECTED, CANCELLED])).toBe(OrderStatus.CANCELLED);
    // Why it matters: REFUNDED is unreachable from READY_FOR_PICKUP itself.
    expect(canTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.REFUNDED)).toBe(false);
    expect(canTransition(OrderStatus.CANCELLED, OrderStatus.REFUNDED)).toBe(true);
  });

  it('a portion still active -> the parent is NOT cancelled (so it can never become REFUNDED)', () => {
    // Ready parent, one ready portion left: stays READY_FOR_PICKUP.
    expect(derivedParentOrderStatus(OrderStatus.READY_FOR_PICKUP, [CANCELLED, READY_FOR_PICKUP])).toBeNull();
    // Earlier phases keep their existing roll-up.
    expect(derivedParentOrderStatus(OrderStatus.PROCESSING, [CANCELLED, ACCEPTED])).toBe(OrderStatus.PARTIALLY_CANCELLED);
    expect(derivedParentOrderStatus(OrderStatus.PARTIALLY_CANCELLED, [CANCELLED, PREPARING])).toBeNull();
    expect(derivedParentOrderStatus(OrderStatus.PARTIALLY_CANCELLED, [CANCELLED, READY_FOR_PICKUP])).toBe(OrderStatus.READY_FOR_PICKUP);
    expect(derivedParentOrderStatus(OrderStatus.PROCESSING, [READY_FOR_PICKUP, READY_FOR_PICKUP])).toBe(OrderStatus.READY_FOR_PICKUP);
    expect(derivedParentOrderStatus(OrderStatus.PROCESSING, [NEW, ACCEPTED])).toBeNull();
  });

  it('already cancelled / refunded (or unchanged) -> idempotent no-op', () => {
    expect(derivedParentOrderStatus(OrderStatus.CANCELLED, [CANCELLED])).toBeNull();
    expect(derivedParentOrderStatus(OrderStatus.REFUNDED, [CANCELLED, CANCELLED])).toBeNull();
    expect(derivedParentOrderStatus(OrderStatus.READY_FOR_PICKUP, [READY_FOR_PICKUP])).toBeNull();
  });

  it('a ready parent never moves backwards, whatever its seller orders say', () => {
    expect(derivedParentOrderStatus(OrderStatus.READY_FOR_PICKUP, [NEW])).toBeNull();
    expect(derivedParentOrderStatus(OrderStatus.READY_FOR_PICKUP, [CANCELLED, PREPARING])).toBeNull();
  });

  it('delivery-leg and terminal parents are never recomputed', () => {
    for (const status of [OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.PAYMENT_FAILED, OrderStatus.PENDING_PAYMENT]) {
      expect(derivedParentOrderStatus(status, [CANCELLED])).toBeNull();
      expect(derivedParentOrderStatus(status, [READY_FOR_PICKUP])).toBeNull();
    }
  });

  it('state-machine authorization is unchanged', () => {
    // Nobody can cancel a ready parent directly — only the SYSTEM roll-up does.
    for (const actor of [ActorType.ADMIN, ActorType.CUSTOMER, ActorType.SELLER, ActorType.SYSTEM]) {
      expect(canActorTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.CANCELLED, actor)).toBe(false);
    }
    // Cancelling a READY seller portion stays ADMIN-only.
    expect(canActorTransitionSellerOrder(READY_FOR_PICKUP, CANCELLED, ActorType.ADMIN)).toBe(true);
    expect(canActorTransitionSellerOrder(READY_FOR_PICKUP, CANCELLED, ActorType.SELLER)).toBe(false);
    expect(canActorTransitionSellerOrder(READY_FOR_PICKUP, CANCELLED, ActorType.CUSTOMER)).toBe(false);
    // The payment placement step is still SYSTEM/webhook-only.
    expect(canActorTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING, ActorType.ADMIN)).toBe(false);
    expect(canActorTransition(OrderStatus.CANCELLED, OrderStatus.REFUNDED, ActorType.ADMIN)).toBe(false);
  });
});
