/**
 * A new POST /orders while the customer still has an unpaid ONLINE checkout
 * open. Its lines are still in the cart (cart-retention.ts), so the request
 * is very likely the same checkout again — "Retry payment", Pay Online
 * tapped again after closing the failed-payment sheet — or the customer
 * choosing another way to pay. Never a second order for the same items:
 *
 *   paid meanwhile    Cashfree is asked first (refreshPayment, the same
 *                     server-side check as the app's): money that arrived
 *                     confirms THAT order — the request is refused
 *                     (PAYMENT_ALREADY_CAPTURED) and the cart, now without
 *                     the paid lines, is shown again;
 *   payment pending   the UPI app / bank has not answered: refused
 *                     (ORDER_IN_PROGRESS) — paying again could charge twice;
 *   same checkout     same lines and quantities, destination, coupon and
 *                     total, paid online: that order is REUSED (no new
 *                     order, no new stock hold; the route reopens its
 *                     Cashfree checkout, reusing the open Cashfree order);
 *   anything else     the cart changed, another destination, cash on
 *                     delivery: the open checkout is cancelled first (stock
 *                     and coupon released; nothing to put back — its lines
 *                     never left the cart), then the new order is placed. A
 *                     payment that still arrives for it is refunded by the
 *                     existing late-payment path.
 *
 * Orders placed before cart-retention.ts (their lines already left the
 * cart) are not touched: they end as they always did.
 */

import { ActorType, DeliveryMode, ErrorCode, OrderPaymentStatus, OrderStatus, PaymentMethod } from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, type DbClient } from '../../infra/db/prisma';
import { refreshPayment } from '../payments/payment.service';
import { ordersRetainingCart } from './cart-retention';
import { transitionOrder } from './order-state.service';

const log = moduleLogger('open-checkout');

/** A checkout this close to its hold's end is not reused (it could expire mid-payment). */
export const REUSE_MIN_HOLD_MS = 2 * 60_000;

export interface CheckoutRequestShape {
  paymentMethod: PaymentMethod;
  destination: { mode: DeliveryMode; addressId: string | null; latitude: number; longitude: number };
  /** The lines being ordered: seller, master variant, quantity. */
  lines: readonly { sellerId: string; variantId: string; qty: number }[];
  couponCode: string | null;
  expectedTotalPaise?: number | undefined;
}

export interface OpenCheckoutShape {
  totalPaise: number;
  couponCode: string | null;
  addressId: string | null;
  deliveryMode: DeliveryMode;
  deliveryLatitude: number;
  deliveryLongitude: number;
  reservationExpiresAt: Date | null;
  sellerOrders: readonly { sellerId: string; items: readonly { variantId: string | null; qty: number }[] }[];
}

const linesKey = (lines: readonly { sellerId: string; variantId: string | null; qty: number }[]) =>
  lines
    .map((line) => `${line.sellerId}|${line.variantId ?? '-'}:${line.qty}`)
    .sort()
    .join(',');

/** The open checkout IS this request: reusable as it is. Pure — unit-tested. */
export function isSameCheckout(order: OpenCheckoutShape, request: CheckoutRequestShape, now: number = Date.now()): boolean {
  if (request.paymentMethod !== PaymentMethod.ONLINE) return false;
  if (order.reservationExpiresAt && order.reservationExpiresAt.getTime() - now < REUSE_MIN_HOLD_MS) return false;
  const orderLines = order.sellerOrders.flatMap((sellerOrder) =>
    sellerOrder.items.map((item) => ({ sellerId: sellerOrder.sellerId, variantId: item.variantId, qty: item.qty })),
  );
  if (orderLines.some((line) => line.variantId === null)) return false;
  if (linesKey(orderLines) !== linesKey(request.lines)) return false;
  if (order.deliveryMode !== request.destination.mode) return false;
  if (request.destination.mode === DeliveryMode.SAVED_ADDRESS) {
    if (order.addressId !== request.destination.addressId) return false;
  } else if (
    Math.abs(order.deliveryLatitude - request.destination.latitude) > 1e-7 ||
    Math.abs(order.deliveryLongitude - request.destination.longitude) > 1e-7
  ) {
    return false;
  }
  if ((order.couponCode ?? '').toUpperCase() !== (request.couponCode ?? '').toUpperCase()) return false;
  if (request.expectedTotalPaise !== undefined && request.expectedTotalPaise !== order.totalPaise) return false;
  return true;
}

const PAID_ELSEWHERE_MESSAGE =
  'Your earlier payment went through, and that order is confirmed. Your cart has been updated — please check it before ordering again.';
const PAYMENT_PENDING_MESSAGE =
  "Your last payment is still being processed. Please wait a moment — if money was deducted, your order is confirmed automatically, so there's no need to pay again.";

/**
 * Settles the customer's open unpaid checkouts before a new order. Returns
 * the id of the open order to reuse for this request, or null when a new
 * order must be placed. Throws when nothing may be placed right now.
 */
export async function settleOpenCheckouts(userId: string, request: CheckoutRequestShape): Promise<string | null> {
  const open = await prisma.order.findMany({
    where: { userId, status: OrderStatus.PENDING_PAYMENT, paymentMethod: PaymentMethod.ONLINE },
    select: {
      id: true,
      totalPaise: true,
      couponCode: true,
      addressId: true,
      deliveryMode: true,
      deliveryLatitude: true,
      deliveryLongitude: true,
      reservationExpiresAt: true,
      sellerOrders: { select: { sellerId: true, items: { select: { variantId: true, qty: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (open.length === 0) return null;
  const retained = await ordersRetainingCart(open.map((order) => order.id));

  let reuse: string | null = null;
  for (const order of open) {
    if (!retained.has(order.id)) continue;

    // What Cashfree says about it now (also settles a capture the webhook
    // has not delivered yet). Unreachable: unknown — it is never assumed paid
    // or failed; a cancellation below is refused if a capture is recorded,
    // and money that arrives later is refunded.
    let state: Awaited<ReturnType<typeof refreshPayment>> | null = null;
    try {
      state = await refreshPayment(userId, order.id);
    } catch (error) {
      log.warn({ err: error, orderId: order.id }, 'open checkout could not be checked with the gateway');
    }
    if (state) {
      if (state.paymentStatus === OrderPaymentStatus.PAID || state.paymentStatus === OrderPaymentStatus.PARTIALLY_REFUNDED) {
        throw new AppError(ErrorCode.PAYMENT_ALREADY_CAPTURED, {
          message: PAID_ELSEWHERE_MESSAGE,
          internalMessage: `open checkout ${order.id} was paid before the new order request`,
        });
      }
      if (state.status !== OrderStatus.PENDING_PAYMENT) continue; // ended meanwhile
      if (state.attemptPending) {
        throw new AppError(ErrorCode.ORDER_IN_PROGRESS, {
          message: PAYMENT_PENDING_MESSAGE,
          internalMessage: `open checkout ${order.id} has a payment attempt in progress`,
        });
      }
    }

    if (reuse === null && isSameCheckout(order, request)) {
      reuse = order.id;
      continue;
    }

    try {
      await transitionOrder({
        orderId: order.id,
        toStatus: OrderStatus.CANCELLED,
        actorType: ActorType.SYSTEM,
        reason: 'Replaced by a new checkout before payment',
      });
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.PAYMENT_ALREADY_CAPTURED) {
        throw new AppError(ErrorCode.PAYMENT_ALREADY_CAPTURED, {
          message: PAID_ELSEWHERE_MESSAGE,
          internalMessage: `open checkout ${order.id} was paid while being replaced`,
        });
      }
      throw error;
    }
    log.info({ orderId: order.id }, 'open unpaid checkout replaced by a new checkout');
  }
  return reuse;
}

/**
 * Inside the order transaction, under the cart's row lock: another request
 * of this customer placed an unpaid checkout a moment ago (a double tap with
 * two keys, two devices). Its lines are still in the cart — this one must
 * not make a second order of them.
 */
export async function assertNoConcurrentCheckout(client: DbClient, userId: string): Promise<void> {
  const open = await client.order.findMany({
    where: { userId, status: OrderStatus.PENDING_PAYMENT, paymentMethod: PaymentMethod.ONLINE },
    select: { id: true },
  });
  if (open.length === 0) return;
  const retained = await ordersRetainingCart(
    open.map((order) => order.id),
    client,
  );
  if (retained.size > 0) {
    throw new AppError(ErrorCode.ORDER_IN_PROGRESS, {
      internalMessage: `user ${userId}: an unpaid checkout was placed concurrently`,
    });
  }
}
