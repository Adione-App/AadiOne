/**
 * The last check before a payment for an unpaid ONLINE order is STARTED.
 *
 * The order was placed while its stores were open (placeOrder checks that
 * under a lock). If one of them has closed — or ordering was paused app-wide —
 * before the customer started paying, no money must be asked for it: the
 * unpaid order is cancelled (its reserved stock released) and its lines go
 * back into the cart, where the closed store's lines show as unavailable and
 * the rest can be ordered again.
 *
 * Only before the FIRST attempt: once a payment row exists that is not
 * FAILED, money may already be on its way (a UPI app open, a gateway
 * session), so the order is never cancelled from here — it completes as
 * placed, and a store that cannot fulfil it rejects it through the existing
 * reject + refund flow. Nothing here ever assumes an error refunds anything.
 */

import { ActorType, ErrorCode, OrderStatus, PaymentStatus } from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import * as cartService from '../cart/cart.service';
import { orderingState, statusOf, storeStatuses } from '../sellers/store-availability';
import { orderRetainsCart } from './cart-retention';
import { transitionOrder } from './order-state.service';

const log = moduleLogger('unpaid-order-guard');

export async function assertUnpaidOrderStillOrderable(order: { id: string; userId: string }): Promise<void> {
  const attempts = await prisma.payment.count({
    where: { orderId: order.id, status: { not: PaymentStatus.FAILED } },
  });
  if (attempts > 0) return;

  const [ordering, sellerOrders] = await Promise.all([
    orderingState(),
    prisma.sellerOrder.findMany({
      where: { orderId: order.id },
      include: {
        seller: { include: { hours: { orderBy: { dayOfWeek: 'asc' } } } },
        items: { select: { variantId: true, qty: true } },
      },
    }),
  ]);
  const statuses = await storeStatuses(sellerOrders.map((sellerOrder) => sellerOrder.seller));
  const closed = sellerOrders.filter((sellerOrder) => !statusOf(statuses, sellerOrder.sellerId).acceptingOrders);
  if (ordering.enabled && closed.length === 0) return;

  const reason =
    closed.length > 0
      ? (statusOf(statuses, closed[0]!.sellerId).message ?? `${closed[0]!.seller.name} is not taking orders right now.`)
      : (ordering.message ?? 'Ordering is paused right now.');

  // Cancelled first: if that is refused (it was paid meanwhile), nothing is
  // put back and the refusal is what the customer sees. Lines go back only
  // when THIS call cancelled it — a concurrent call that finds it already
  // cancelled must not put them back a second time.
  const cancelled = await transitionOrder({
    orderId: order.id,
    toStatus: OrderStatus.CANCELLED,
    actorType: ActorType.SYSTEM,
    reason: `Cancelled before payment: ${reason}`,
  });

  if (cancelled.changed) await restoreUnpaidOrderLines(order.id);

  throw new AppError(closed.length > 0 ? ErrorCode.SELLER_CLOSED : ErrorCode.ORDERING_PAUSED, {
    message: `${reason} Your order was cancelled before any payment, and its items are back in your cart.`,
    internalMessage: `unpaid order ${order.id} cancelled at payment start: ${closed.length > 0 ? `${closed.length} store(s) closed` : 'ordering paused'}`,
  });
}

/**
 * An unpaid online order that ended WITHOUT payment — cancelled before any
 * payment (above), cancelled by the customer, or its payment window expired
 * (jobs releaseExpiredReservations) — gives its lines back to the customer's
 * cart — when ordering took them out (orders placed before cart-retention.ts).
 * An order placed since never took them: its lines are still in the cart, and
 * nothing is added a second time. Call it only from the call that actually moved the order (its
 * transition reported `changed`), so the lines come back once.
 *
 * Best effort: the order's state is already final and nothing was paid;
 * only the convenience of getting the items back can fail (logged).
 */
export async function restoreUnpaidOrderLines(orderId: string): Promise<void> {
  try {
    if (await orderRetainsCart(orderId)) return;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        userId: true,
        paymentStatus: true,
        sellerOrders: { select: { sellerId: true, items: { select: { variantId: true, qty: true } } } },
      },
    });
    // Never for an order money was taken for (it is refunded, not re-carted).
    if (!order || order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIALLY_REFUNDED' || order.paymentStatus === 'REFUNDED') return;
    const keys = order.sellerOrders.flatMap((sellerOrder) =>
      sellerOrder.items
        .filter((item) => item.variantId !== null)
        .map((item) => ({ sellerId: sellerOrder.sellerId, variantId: item.variantId! })),
    );
    if (keys.length === 0) return;
    const listings = await prisma.sellerListing.findMany({
      where: { OR: keys },
      select: { id: true, sellerId: true, variantId: true },
    });
    const listingId = new Map(listings.map((listing) => [`${listing.sellerId}|${listing.variantId}`, listing.id]));
    const lines = order.sellerOrders.flatMap((sellerOrder) =>
      sellerOrder.items.flatMap((item) => {
        const id = item.variantId ? listingId.get(`${sellerOrder.sellerId}|${item.variantId}`) : undefined;
        return id ? [{ sellerListingId: id, qty: item.qty }] : [];
      }),
    );
    await cartService.restoreLines(order.userId, lines);
  } catch (error) {
    log.error({ err: error, orderId }, 'unpaid order ended: lines not restored to the cart');
  }
}
