/**
 * Home's "orders in progress" carousel — the pure parts, unit-tested
 * (tests/activeOrders.test.ts). WHICH orders are active is the server's
 * answer (GET /orders/active: placed — paid online or COD — and not ended);
 * this only decides what the carousel shows next.
 */

import type { OrderSummaryDto } from "@shared";
import { isCustomerActiveOrder } from "@shared/order-state-machine";

/** How long each order stays in view before the carousel moves on. */
export const ACTIVE_ORDER_ROTATE_MS = 2500;

/** The next card, wrapping; a single card never moves. */
export function nextCarouselIndex(index: number, count: number): number {
  if (count <= 1) return 0;
  return (index + 1) % count;
}

/**
 * Where the carousel stands after the list changed (a refresh, a new order, a
 * delivered one gone): on the SAME order when it is still there — a refresh
 * never jumps back to the first card — else the same position, clamped.
 */
export function indexAfterRefresh(previousIds: readonly string[], previousIndex: number, nextIds: readonly string[]): number {
  if (nextIds.length === 0) return 0;
  const shownId = previousIds[previousIndex];
  const stillThere = shownId ? nextIds.indexOf(shownId) : -1;
  if (stillThere >= 0) return stillThere;
  return Math.min(Math.max(previousIndex, 0), nextIds.length - 1);
}

/**
 * An older server has no /orders/active: the same rule from the order list —
 * never an online order still awaiting payment.
 */
export function activeOrdersFromList(items: readonly OrderSummaryDto[]): OrderSummaryDto[] {
  return items.filter(
    (order) =>
      isCustomerActiveOrder(order.status) &&
      (order.paymentMethod === "COD" || order.paymentStatus === "PAID" || order.paymentStatus === "PARTIALLY_REFUNDED"),
  );
}
