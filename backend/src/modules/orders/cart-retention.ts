/**
 * An unpaid ONLINE order is a checkout in progress, not an order: its lines
 * STAY in the customer's cart until the payment is confirmed.
 *
 *   created         placeOrder leaves the cart as it is and marks the order
 *                   (its creation history row: `metadata.cartRetained`);
 *   paid            the confirmed payment takes exactly the ordered
 *                   quantities out of the cart (consumePaidOrderLines) — a
 *                   line the customer added or raised meanwhile keeps the rest;
 *   not paid        cancelled / expired / failed: nothing to give back — the
 *                   lines never left (unpaid-order-guard restoreUnpaidOrderLines
 *                   skips these orders).
 *
 * Orders placed before this existed took their lines out at creation: they
 * carry no mark, keep the old behaviour (lines restored when they end
 * unpaid), and are never consumed a second time.
 */

import { Prisma } from '@prisma/client';
import { moduleLogger } from '../../common/logger';
import { prisma, type DbClient } from '../../infra/db/prisma';

const log = moduleLogger('cart-retention');

/** The creation history row's metadata for an order whose lines stay in the cart. */
export const CART_RETAINED_METADATA = { cartRetained: true } as const;

function isRetainedMetadata(metadata: Prisma.JsonValue | null | undefined): boolean {
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)['cartRetained'] === true
  );
}

/** True when the order kept its lines in the cart (placed by this version, ONLINE). */
export async function orderRetainsCart(orderId: string, client: DbClient = prisma): Promise<boolean> {
  const created = await client.orderStatusHistory.findFirst({
    where: { orderId, fromStatus: null },
    orderBy: { createdAt: 'asc' },
    select: { metadata: true },
  });
  return isRetainedMetadata(created?.metadata);
}

/** The ids of the given orders that kept their lines in the cart. */
export async function ordersRetainingCart(orderIds: readonly string[], client: DbClient = prisma): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await client.orderStatusHistory.findMany({
    where: { orderId: { in: [...orderIds] }, fromStatus: null },
    select: { orderId: true, metadata: true },
  });
  return new Set(rows.filter((row) => isRetainedMetadata(row.metadata)).map((row) => row.orderId));
}

/**
 * The payment was confirmed: the paid lines leave the cart — each by the
 * quantity ordered (a line raised after checkout keeps the difference; one
 * at or below it is removed). The coupon the order used is cleared from the
 * cart. Nothing left: the cart is converted, as after a cash order.
 *
 * Called once, by the transition that confirmed the payment, after it
 * committed. Best effort: the order is paid and placed either way — a
 * failure here only leaves items in the cart (logged).
 */
export async function consumePaidOrderLines(orderId: string): Promise<void> {
  try {
    if (!(await orderRetainsCart(orderId))) return;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        userId: true,
        couponCode: true,
        sellerOrders: { select: { sellerId: true, items: { select: { variantId: true, qty: true } } } },
      },
    });
    if (!order) return;

    const ordered = new Map<string, number>();
    for (const sellerOrder of order.sellerOrders) {
      for (const item of sellerOrder.items) {
        if (!item.variantId) continue;
        const key = `${sellerOrder.sellerId}|${item.variantId}`;
        ordered.set(key, (ordered.get(key) ?? 0) + item.qty);
      }
    }

    await prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({ where: { userId: order.userId, status: 'ACTIVE' }, select: { id: true, couponCode: true } });
      if (!cart) return;
      // The customer's own cart edits wait for this (and this for them).
      await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cart.id}::uuid FOR UPDATE`;
      const lines = await tx.cartItem.findMany({
        where: { cartId: cart.id },
        select: { id: true, qty: true, sellerListing: { select: { sellerId: true, variantId: true } } },
      });
      for (const line of lines) {
        const paid = ordered.get(`${line.sellerListing.sellerId}|${line.sellerListing.variantId}`);
        if (!paid) continue;
        if (line.qty <= paid) await tx.cartItem.delete({ where: { id: line.id } });
        else await tx.cartItem.update({ where: { id: line.id }, data: { qty: line.qty - paid } });
      }
      if (order.couponCode && cart.couponCode && cart.couponCode.toUpperCase() === order.couponCode.toUpperCase()) {
        await tx.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
      }
      const left = await tx.cartItem.count({ where: { cartId: cart.id } });
      if (left === 0) await tx.cart.updateMany({ where: { id: cart.id, status: 'ACTIVE' }, data: { status: 'CONVERTED', couponCode: null } });
    });
  } catch (error) {
    log.error({ err: error, orderId }, 'paid order: its lines were not taken out of the cart');
  }
}
