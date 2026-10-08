/**
 * The single sale definition (shared PLACED_ORDER_STATUSES /
 * COMPLETED_SALE_STATUSES, backend sales-metrics.ts). DB-free.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  COMPLETED_SALE_STATUSES,
  OrderStatus,
  PLACED_ORDER_STATUSES,
} from '../../src/shared';
import { completedSaleWhere, placedOrderWhere } from '../../src/modules/orders/sales-metrics';

const NEVER_A_SALE = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAYMENT_FAILED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
];

describe('sale definition', () => {
  it('never counts a cancelled, failed, refunded or unpaid order', () => {
    for (const status of NEVER_A_SALE) {
      expect(PLACED_ORDER_STATUSES).not.toContain(status);
      expect(COMPLETED_SALE_STATUSES).not.toContain(status);
    }
  });

  it('counts every placed order that still stands, and only delivered ones as revenue', () => {
    expect(PLACED_ORDER_STATUSES).toEqual(
      expect.arrayContaining([
        OrderStatus.PAYMENT_CONFIRMED,
        OrderStatus.PROCESSING,
        OrderStatus.PARTIALLY_CANCELLED,
        OrderStatus.READY_FOR_PICKUP,
        OrderStatus.PICKED_UP,
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.DELIVERED,
      ]),
    );
    expect(COMPLETED_SALE_STATUSES).toEqual([OrderStatus.DELIVERED]);
    for (const status of COMPLETED_SALE_STATUSES) expect(PLACED_ORDER_STATUSES).toContain(status);
  });

  it('classifies every order status the state machine can reach', () => {
    const reachable = new Set<OrderStatus>([OrderStatus.PENDING_PAYMENT]);
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) for (const t of targets) reachable.add(t);
    for (const status of reachable) {
      expect(PLACED_ORDER_STATUSES.includes(status) || (NEVER_A_SALE as readonly OrderStatus[]).includes(status)).toBe(true);
    }
  });

  it('requires the money to be collected for revenue', () => {
    expect(placedOrderWhere).toEqual({ status: { in: [...PLACED_ORDER_STATUSES] } });
    expect(completedSaleWhere).toEqual({
      status: { in: [...COMPLETED_SALE_STATUSES] },
      paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
    });
  });
});
