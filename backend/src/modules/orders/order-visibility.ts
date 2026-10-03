/**
 * Which parent orders a SELLER may see and act on.
 *
 * A seller order becomes the seller's business only once its parent order is
 * placed: a COD order at creation, an ONLINE order only when its payment is
 * confirmed — exactly when the seller is notified (order.service's
 * `placeOrder`; order-state.service's PAYMENT_CONFIRMED side effects). An
 * online order still awaiting payment, one whose payment failed or expired,
 * or one cancelled before it was ever paid was never the seller's to fulfil:
 * it is hidden from the seller panel and can never be acted on.
 *
 * Admin views are unaffected — admins see every order.
 */

import type { Prisma } from '@prisma/client';
import { OrderStatus } from '../../shared';

export function isOrderVisibleToSeller(order: { status: OrderStatus; placedAt: Date | null }): boolean {
  if (order.status === OrderStatus.PENDING_PAYMENT || order.status === OrderStatus.PAYMENT_FAILED) return false;
  // Cancelled before it was ever placed (customer cancelled while unpaid).
  if (order.status === OrderStatus.CANCELLED && order.placedAt === null) return false;
  return true;
}

/** `isOrderVisibleToSeller` as a Prisma filter on the parent order. */
export const sellerVisibleOrderWhere: Prisma.OrderWhereInput = {
  status: { notIn: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_FAILED] },
  NOT: { status: OrderStatus.CANCELLED, placedAt: null },
};
