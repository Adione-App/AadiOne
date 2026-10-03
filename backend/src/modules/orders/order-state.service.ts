/**
 * Order state machines (V2) — see shared/order-state-machine.ts for the two
 * legal-transition tables this enforces.
 *
 * `transitionSellerOrder` is THE ONLY code permitted to write
 * `seller_orders.status` — every seller accept/reject/prepare/ready action,
 * admin override included, goes through it. `transitionOrder` is THE ONLY
 * code permitted to write `orders.status` directly for the transitions an
 * actor genuinely chooses (payment, the delivery leg); every OTHER parent
 * status change is DERIVED from the aggregate of a SellerOrder change by
 * `recomputeParentOrderStatus`, called from inside `transitionSellerOrder`'s
 * own transaction.
 *
 * That single choke point per level is what makes the guarantees real:
 *   - illegal transitions are impossible, not merely discouraged
 *   - every change is recorded in the matching *_status_history table
 *   - stock and payment side effects happen in the SAME transaction
 *   - one seller's cancellation never touches another seller's rows (#8/#18)
 *   - notifications are queued but only dispatched after commit
 */

import type { Order, SellerOrder } from '@prisma/client';
import {
  ActorType,
  CancelledBy,
  ErrorCode,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  SellerOrderStatus,
  ORDER_STATUS_LABELS,
  SELLER_ORDER_STATUS_LABELS,
  StockLedgerReason,
  canActorTransition,
  canActorTransitionSellerOrder,
  canTransition,
  canTransitionSellerOrder,
} from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { moduleLogger } from '../../common/logger';
import * as inventoryService from '../inventory/inventory.service';
import * as notificationService from '../notifications/notification.service';
import * as referralService from '../referrals/referral.service';
import * as deliveryService from '../delivery/delivery.service';
import {
  emitAdminOrderStatus,
  emitNewSellerOrder,
  emitOrderStatus,
  emitSellerOrderStatus,
} from '../../realtime/socket';

const log = moduleLogger('orders:state');

/**
 * Resolves the stock-ledger-ready line items for one SellerOrder (#6:
 * inventory reservation/restoration is seller-listing specific, never
 * derived loosely from a bare variant id).
 *
 * Prefers each OrderItem's own `sellerListingId` — set directly at order
 * creation (see order.service.ts), so this is an exact, unambiguous link
 * rather than a re-derived (sellerId, variantId) lookup. Falls back to that
 * derivation only for the rare row where the listing was hard-deleted after
 * the order was placed (`onDelete: SetNull` leaves `sellerListingId` null).
 */
async function loadStockItems(
  tx: Tx,
  sellerOrderId: string,
  sellerId: string,
): Promise<{ sellerListingId: string; qty: number }[]> {
  const items = await tx.orderItem.findMany({
    where: { sellerOrderId },
    select: { sellerListingId: true, variantId: true, qty: true },
  });

  const direct = items.filter((i): i is typeof i & { sellerListingId: string } => i.sellerListingId !== null);
  const orphaned = items.filter((i) => i.sellerListingId === null);

  const fallback: { sellerListingId: string; qty: number }[] = [];
  if (orphaned.length > 0) {
    const variantIds = orphaned.map((i) => i.variantId).filter((id): id is string => id !== null);
    const listings = await tx.sellerListing.findMany({
      where: { sellerId, variantId: { in: variantIds } },
      select: { id: true, variantId: true },
    });
    const listingByVariant = new Map(listings.map((l) => [l.variantId, l.id]));
    for (const item of orphaned) {
      const listingId = item.variantId ? listingByVariant.get(item.variantId) : undefined;
      if (listingId) fallback.push({ sellerListingId: listingId, qty: item.qty });
    }
  }

  return [
    ...direct.map((i) => ({ sellerListingId: i.sellerListingId, qty: i.qty })),
    ...fallback,
  ];
}

/* ============================================================================
 * SellerOrder — per-seller transitions
 * ==========================================================================*/

export interface SellerOrderTransitionInput {
  sellerOrderId: string;
  toStatus: SellerOrderStatus;
  actorType: ActorType;
  actorUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SellerOrderTransitionResult {
  sellerOrder: SellerOrder;
  order: Order;
  fromStatus: SellerOrderStatus;
  changed: boolean;
}

const SELLER_ORDER_NOTIFICATION_FOR: Partial<Record<SellerOrderStatus, NotificationType>> = {
  [SellerOrderStatus.ACCEPTED]: NotificationType.ORDER_ACCEPTED,
  [SellerOrderStatus.PREPARING]: NotificationType.ORDER_PREPARING,
  [SellerOrderStatus.READY_FOR_PICKUP]: NotificationType.ORDER_READY,
  [SellerOrderStatus.REJECTED]: NotificationType.ORDER_REJECTED,
  [SellerOrderStatus.CANCELLED]: NotificationType.ORDER_CANCELLED,
};

const SELLER_ORDER_TIMESTAMP_FOR: Partial<Record<SellerOrderStatus, keyof SellerOrder>> = {
  [SellerOrderStatus.ACCEPTED]: 'acceptedAt',
  [SellerOrderStatus.PREPARING]: 'preparingAt',
  [SellerOrderStatus.READY_FOR_PICKUP]: 'readyAt',
  [SellerOrderStatus.REJECTED]: 'rejectedAt',
  [SellerOrderStatus.CANCELLED]: 'cancelledAt',
};

const DELIVERY_LEG_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PICKED_UP,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

function cancelledByFor(actorType: ActorType): CancelledBy {
  switch (actorType) {
    case ActorType.CUSTOMER:
      return CancelledBy.CUSTOMER;
    case ActorType.SELLER:
      return CancelledBy.SELLER;
    case ActorType.ADMIN:
      return CancelledBy.ADMIN;
    default:
      return CancelledBy.SYSTEM;
  }
}

/**
 * Performs one SellerOrder transition. Locks the row `FOR UPDATE` so two
 * simultaneous "Accept" clicks (seller panel + admin override, say) cannot
 * both succeed — the second sees the already-changed status and is rejected
 * as an illegal transition.
 */
export async function transitionSellerOrder(
  input: SellerOrderTransitionInput,
): Promise<SellerOrderTransitionResult> {
  const result = await runInTransaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      { id: string; status: SellerOrderStatus; order_id: string; seller_id: string }[]
    >`SELECT id, status, order_id, seller_id FROM seller_orders WHERE id = ${input.sellerOrderId}::uuid FOR UPDATE`;

    if (!locked) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
    }

    const fromStatus = locked.status;
    const { toStatus } = input;
    const sellerOrderBefore = await tx.sellerOrder.findUniqueOrThrow({
      where: { id: input.sellerOrderId },
    });
    const order = await tx.order.findUniqueOrThrow({ where: { id: locked.order_id } });

    if (fromStatus === toStatus) {
      // Idempotent no-op: a duplicate action or a double-clicked button must
      // not be an error.
      return { sellerOrder: sellerOrderBefore, order, fromStatus, changed: false };
    }

    // An online order whose payment is still outstanding — or failed/expired
    // — was never placed: no seller portion of it may be accepted, prepared
    // or otherwise acted on (by a seller or an admin). Once paid it moves on
    // normally; if the payment fails, the parent's own PAYMENT_FAILED step
    // closes the seller orders.
    if (order.status === OrderStatus.PENDING_PAYMENT || order.status === OrderStatus.PAYMENT_FAILED) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: 'This order has not been paid, so it cannot be processed.',
        internalMessage: `seller-order ${input.sellerOrderId} ${fromStatus} -> ${toStatus} refused: parent is ${order.status}`,
      });
    }

    // Once the rider has the parcel (or it is delivered), no seller portion
    // may move any more — in particular it can no longer be cancelled and
    // refunded after the fact, which would also silently change what an
    // already-created seller settlement covers.
    if (DELIVERY_LEG_ORDER_STATUSES.includes(order.status)) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: 'This order is already out with the delivery partner and can no longer be changed.',
        internalMessage: `seller-order ${input.sellerOrderId} ${fromStatus} -> ${toStatus} refused: parent is ${order.status}`,
      });
    }

    if (!canTransitionSellerOrder(fromStatus, toStatus)) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: `This order cannot move from ${fromStatus} to ${toStatus}.`,
        internalMessage: `illegal seller-order transition ${fromStatus} -> ${toStatus}`,
      });
    }
    if (!canActorTransitionSellerOrder(fromStatus, toStatus, input.actorType)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'You are not allowed to make this change.',
        internalMessage: `${input.actorType} may not perform ${fromStatus} -> ${toStatus}`,
      });
    }

    // --- stock side effects, scoped to THIS seller's items only (#8/#18) ---
    if (toStatus === SellerOrderStatus.REJECTED || toStatus === SellerOrderStatus.CANCELLED) {
      const stockItems = await loadStockItems(tx, input.sellerOrderId, locked.seller_id);

      // Stock is already committed (sold) the instant payment cleared, or
      // immediately for COD (see order.service.ts's placeOrder /
      // transitionOrder's PAYMENT_CONFIRMED handling below). Whether THIS
      // order's payment has cleared decides restock vs release.
      //
      // Committed = COD (committed at creation), or an online payment that was
      // captured at some point. Capture is the only way out of PENDING, so
      // PARTIALLY_REFUNDED/REFUNDED are still committed: checking `=== PAID`
      // alone sent every cancellation AFTER a sibling's partial refund down
      // the release path — driving reserved_qty negative and never putting
      // the sold units back on the shelf.
      const stockCommitted =
        order.paymentMethod === PaymentMethod.COD ||
        (order.paymentStatus !== OrderPaymentStatus.PENDING && order.paymentStatus !== OrderPaymentStatus.FAILED);

      if (stockCommitted) {
        await inventoryService.restockCommitted(tx, stockItems, input.sellerOrderId);
      } else {
        await inventoryService.releaseReservation(
          tx,
          stockItems,
          input.sellerOrderId,
          StockLedgerReason.ORDER_RELEASE,
        );
      }
    }

    const timestampField = SELLER_ORDER_TIMESTAMP_FOR[toStatus];
    const updatedSellerOrder = await tx.sellerOrder.update({
      where: { id: input.sellerOrderId },
      data: {
        status: toStatus,
        ...(timestampField ? { [timestampField]: new Date() } : {}),
        ...(toStatus === SellerOrderStatus.REJECTED
          ? { rejectionReason: input.reason ?? null }
          : {}),
        ...(toStatus === SellerOrderStatus.CANCELLED
          ? { cancellationReason: input.reason ?? null }
          : {}),
      },
    });

    await tx.sellerOrderStatusHistory.create({
      data: {
        sellerOrderId: input.sellerOrderId,
        fromStatus,
        toStatus,
        actorType: input.actorType,
        actorUserId: input.actorUserId ?? null,
        reason: input.reason ?? null,
        metadata: (input.metadata ?? null) as never,
      },
    });

    // Cancelling/rejecting THIS seller's portion drops what the customer
    // still owes by exactly this portion's share (#9/#20) — every other
    // seller's portion, and the original checkout snapshot, is untouched.
    if (toStatus === SellerOrderStatus.REJECTED || toStatus === SellerOrderStatus.CANCELLED) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          currentPayablePaise: {
            // subtotalPaise is tax-INCLUSIVE (see placeOrder) — adding
            // taxPaise again would over-decrement.
            decrement: sellerOrderBefore.subtotalPaise,
          },
        },
      });
    }

    const updatedOrder = await recomputeParentOrderStatus(tx, order.id, input.actorType);

    log.info(
      {
        sellerOrderId: input.sellerOrderId,
        orderId: order.id,
        fromStatus,
        toStatus,
        actorType: input.actorType,
      },
      'seller order transitioned',
    );

    return { sellerOrder: updatedSellerOrder, order: updatedOrder, fromStatus, changed: true };
  });

  if (result.changed) {
    await dispatchSellerOrderSideEffects(result, input);
  }

  return result;
}

async function dispatchSellerOrderSideEffects(
  result: SellerOrderTransitionResult,
  input: SellerOrderTransitionInput,
): Promise<void> {
  const { sellerOrder, order } = result;

  try {
    emitSellerOrderStatus(sellerOrder.sellerId, {
      orderId: order.id,
      sellerOrderId: sellerOrder.id,
      orderNumber: order.orderNumber,
      status: sellerOrder.status,
      statusLabel: SELLER_ORDER_STATUS_LABELS[sellerOrder.status],
    });
    emitOrderStatus(order.userId, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      statusLabel: ORDER_STATUS_LABELS[order.status],
      etaMinutes: order.etaMinutes,
    });
  } catch (error) {
    log.warn({ err: error, sellerOrderId: sellerOrder.id }, 'realtime emit failed');
  }

  // Keys are per (seller order, status): each status is reached at most once
  // (the state machine only moves forward), and a repeated/no-op transition
  // never reaches here (`changed` is false) — the unique key is the backstop.
  const seller = await prisma.seller.findUnique({ where: { id: sellerOrder.sellerId }, select: { name: true } });
  const context = {
    orderNumber: order.orderNumber,
    totalPaise: order.totalPaise,
    amountPaise: sellerOrder.subtotalPaise,
    reason: input.reason ?? null,
    ...(seller ? { sellerName: seller.name } : {}),
    status: sellerOrder.status,
  };
  const notification = SELLER_ORDER_NOTIFICATION_FOR[sellerOrder.status];
  if (notification) {
    await notificationService.notify({
      userId: order.userId,
      type: notification,
      dedupeKey: `so:${sellerOrder.id}:${sellerOrder.status}`,
      orderId: order.id,
      context,
    });
  }
  // The seller hears about changes it did not make itself: a customer or
  // admin cancellation, or an admin override of its status.
  if (input.actorType !== ActorType.SELLER) {
    await notificationService.notifySeller(sellerOrder.sellerId, {
      type:
        sellerOrder.status === SellerOrderStatus.CANCELLED
          ? NotificationType.SELLER_ORDER_CANCELLED
          : NotificationType.SELLER_ORDER_UPDATE,
      dedupeKey: `so:${sellerOrder.id}:${sellerOrder.status}:seller`,
      orderId: order.id,
      context,
    });
  }

  // Money back automatically for exactly this seller's portion (#10/#19) —
  // never a manual step someone forgets, and never touching any other
  // seller's slice of the same parent order. Lazily imported to avoid a
  // top-level circular dependency (payment.service.ts itself calls back
  // into this module's `transitionOrder`/`confirmPaymentAndPlace`).
  if (sellerOrder.status === SellerOrderStatus.REJECTED || sellerOrder.status === SellerOrderStatus.CANCELLED) {
    const paymentService = await import('../payments/payment.service');
    await paymentService.refundSellerOrderIfPaid(
      sellerOrder.id,
      input.reason ?? 'Seller order cancelled or rejected',
    );
  }
}

/**
 * Parent statuses still driven by their seller orders. READY_FOR_PICKUP is
 * one of them in exactly one way: an admin may still cancel a ready portion
 * (READY_FOR_PICKUP -> CANCELLED is the only seller-order move left then, and
 * it is ADMIN-only). Delivery-leg and terminal parents are not — their seller
 * orders are frozen (DELIVERY_LEG_ORDER_STATUSES) or finished.
 */
const SELLER_DRIVEN_PARENT_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PROCESSING,
  OrderStatus.PARTIALLY_CANCELLED,
  OrderStatus.READY_FOR_PICKUP,
];

/**
 * The parent status its seller orders now imply, or null when the parent
 * must stay where it is. Pure — the decision `recomputeParentOrderStatus`
 * applies.
 *
 * A READY_FOR_PICKUP parent only ever moves to CANCELLED (its last active
 * portion was cancelled — nothing left to fulfil); it never goes back to
 * PROCESSING / PARTIALLY_CANCELLED. Before READY_FOR_PICKUP was recomputed at
 * all, cancelling that last portion left the parent waiting for a pickup of
 * nothing, so it could never reach REFUNDED.
 */
export function derivedParentOrderStatus(
  current: OrderStatus,
  sellerOrderStatuses: readonly SellerOrderStatus[],
): OrderStatus | null {
  if (!SELLER_DRIVEN_PARENT_STATUSES.includes(current)) return null;

  const isCancelled = (s: SellerOrderStatus) =>
    s === SellerOrderStatus.REJECTED || s === SellerOrderStatus.CANCELLED;
  const active = sellerOrderStatuses.filter((s) => !isCancelled(s));

  let next: OrderStatus;
  if (active.length === 0) {
    // Every seller portion was cancelled/rejected — nothing left to fulfil.
    next = OrderStatus.CANCELLED;
  } else if (active.every((s) => s === SellerOrderStatus.READY_FOR_PICKUP)) {
    // Every REQUIRED (still-active) seller order is ready — delivery may
    // now proceed (#13), regardless of whether some OTHER portion was
    // separately cancelled.
    next = OrderStatus.READY_FOR_PICKUP;
  } else if (active.length < sellerOrderStatuses.length) {
    next = OrderStatus.PARTIALLY_CANCELLED;
  } else {
    next = OrderStatus.PROCESSING;
  }

  if (next === current) return null;
  if (current === OrderStatus.READY_FOR_PICKUP && next !== OrderStatus.CANCELLED) return null;
  return next;
}

/**
 * Rolls the aggregate of every SellerOrder under `orderId` up into the
 * parent's own status (#7). Only acts while the parent is still in a
 * seller-driven phase — once delivery has started or the order reached a
 * terminal state, a SellerOrder can no longer move anyway (see
 * ALLOWED_SELLER_ORDER_TRANSITIONS), so there is nothing left to recompute.
 */
async function recomputeParentOrderStatus(
  tx: Tx,
  orderId: string,
  actorType: ActorType,
): Promise<Order> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!SELLER_DRIVEN_PARENT_STATUSES.includes(order.status)) return order;

  const sellerOrders = await tx.sellerOrder.findMany({ where: { orderId } });
  const nextStatus = derivedParentOrderStatus(order.status, sellerOrders.map((so) => so.status));
  if (!nextStatus) return order;

  const updated = await tx.order.update({
    where: { id: orderId },
    data: {
      status: nextStatus,
      ...(nextStatus === OrderStatus.READY_FOR_PICKUP ? { readyAt: new Date() } : {}),
      ...(nextStatus === OrderStatus.CANCELLED
        ? {
            cancelledAt: new Date(),
            cancellationReason: 'Every seller portion was cancelled or rejected.',
            cancelledBy: cancelledByFor(actorType),
          }
        : {}),
    },
  });

  await tx.orderStatusHistory.create({
    data: {
      orderId,
      fromStatus: order.status,
      toStatus: nextStatus,
      actorType: ActorType.SYSTEM,
      reason: 'Recomputed from seller order statuses.',
    },
  });

  // Nothing left to deliver: release any rider already assigned (only
  // reachable before pickup — delivery-leg parents are never recomputed).
  if (nextStatus === OrderStatus.CANCELLED) {
    const released = await deliveryService.releaseTasksForCancelledOrder(tx, orderId);
    if (released > 0) log.info({ orderId, released }, 'rider released — order fully cancelled before pickup');
  }

  try {
    emitAdminOrderStatus({
      orderId,
      orderNumber: updated.orderNumber,
      status: updated.status,
      statusLabel: ORDER_STATUS_LABELS[updated.status],
      etaMinutes: updated.etaMinutes,
    });
  } catch (error) {
    log.warn({ err: error, orderId }, 'realtime emit failed');
  }

  return updated;
}

/* ============================================================================
 * Order — parent-level transitions (payment + the delivery leg)
 * ==========================================================================*/

export interface OrderTransitionInput {
  orderId: string;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OrderTransitionResult {
  order: Order;
  fromStatus: OrderStatus;
  changed: boolean;
}

// REFUNDED is deliberately absent: every refund (full or per seller) is
// announced by payment.service.ts when it completes, keyed by the refund —
// a parent-level notice here would tell the customer twice.
const ORDER_NOTIFICATION_FOR: Partial<Record<OrderStatus, NotificationType>> = {
  [OrderStatus.PAYMENT_CONFIRMED]: NotificationType.PAYMENT_SUCCESS,
  [OrderStatus.OUT_FOR_DELIVERY]: NotificationType.ORDER_OUT_FOR_DELIVERY,
  [OrderStatus.DELIVERED]: NotificationType.ORDER_DELIVERED,
  [OrderStatus.CANCELLED]: NotificationType.ORDER_CANCELLED,
  [OrderStatus.PAYMENT_FAILED]: NotificationType.PAYMENT_FAILED,
};

/** Parent transitions each still-active seller is told about. */
const SELLER_PARENT_UPDATES: readonly OrderStatus[] = [OrderStatus.PICKED_UP, OrderStatus.DELIVERED];

const ORDER_TIMESTAMP_FOR: Partial<Record<OrderStatus, keyof Order>> = {
  [OrderStatus.PROCESSING]: 'placedAt',
  [OrderStatus.PICKED_UP]: 'pickedUpAt',
  [OrderStatus.OUT_FOR_DELIVERY]: 'outForDeliveryAt',
  [OrderStatus.DELIVERED]: 'deliveredAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
};

/**
 * Performs a PARENT-level state transition — payment settling, or the
 * delivery leg once every required SellerOrder is ready. Every OTHER parent
 * status change (PROCESSING/PARTIALLY_CANCELLED/CANCELLED driven by seller
 * activity) is derived instead — see `recomputeParentOrderStatus` — so this
 * function's own `ALLOWED_TRANSITIONS`/`TRANSITION_ACTORS` entries for those
 * are deliberately SYSTEM-only and never invoked directly from here.
 */
export async function transitionOrder(input: OrderTransitionInput): Promise<OrderTransitionResult> {
  const result = await runInTransaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
      SELECT id, status FROM orders WHERE id = ${input.orderId}::uuid FOR UPDATE`;

    if (!locked) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
    }

    const fromStatus = locked.status;
    const { toStatus } = input;

    if (fromStatus === toStatus) {
      const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId } });
      return { order, fromStatus, changed: false };
    }

    if (!canTransition(fromStatus, toStatus)) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: `This order cannot move from ${fromStatus} to ${toStatus}.`,
        internalMessage: `illegal transition ${fromStatus} -> ${toStatus}`,
      });
    }
    if (!canActorTransition(fromStatus, toStatus, input.actorType)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'You are not allowed to make this change.',
        internalMessage: `${input.actorType} may not perform ${fromStatus} -> ${toStatus}`,
      });
    }

    const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId } });
    const sellerOrders = await tx.sellerOrder.findMany({ where: { orderId: order.id } });

    // --- stock side effects, across every seller order under this parent --
    if (toStatus === OrderStatus.PAYMENT_CONFIRMED) {
      // Payment cleared: the held units now actually leave the shelf, for
      // every seller involved — COD already did this at creation.
      for (const so of sellerOrders) {
        const stockItems = await loadStockItems(tx, so.id, so.sellerId);
        await inventoryService.commitReservation(tx, stockItems, so.id);
      }
    }

    if (toStatus === OrderStatus.PAYMENT_FAILED) {
      for (const so of sellerOrders) {
        const stockItems = await loadStockItems(tx, so.id, so.sellerId);
        await inventoryService.releaseReservation(tx, stockItems, so.id);

        // The order was never paid, so no seller portion can go ahead: close
        // each one as CANCELLED (the same terminal state, history and reason
        // as cancelling an unpaid order, below) instead of leaving it NEW.
        // The seller was never told about it — an online order reaches its
        // sellers only once paid — so nothing is announced to them now.
        if (so.status === SellerOrderStatus.CANCELLED || so.status === SellerOrderStatus.REJECTED) continue;
        await tx.sellerOrder.update({
          where: { id: so.id },
          data: {
            status: SellerOrderStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: input.reason ?? 'Payment was not completed.',
          },
        });
        await tx.sellerOrderStatusHistory.create({
          data: {
            sellerOrderId: so.id,
            fromStatus: so.status,
            toStatus: SellerOrderStatus.CANCELLED,
            actorType: input.actorType,
            actorUserId: input.actorUserId ?? null,
            reason: input.reason ?? 'Payment was not completed.',
          },
        });
      }
    }

    // Cancelling the WHOLE order before any seller acted (still
    // PENDING_PAYMENT) cascades to every SellerOrder, so nothing is left
    // dangling in NEW once the parent itself is cancelled.
    if (toStatus === OrderStatus.CANCELLED && fromStatus === OrderStatus.PENDING_PAYMENT) {
      for (const so of sellerOrders) {
        const stockItems = await loadStockItems(tx, so.id, so.sellerId);
        await inventoryService.releaseReservation(
          tx,
          stockItems,
          so.id,
          StockLedgerReason.ORDER_RELEASE,
        );
        await tx.sellerOrder.update({
          where: { id: so.id },
          data: {
            status: SellerOrderStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: input.reason ?? 'Order cancelled before payment.',
          },
        });
        await tx.sellerOrderStatusHistory.create({
          data: {
            sellerOrderId: so.id,
            fromStatus: so.status,
            toStatus: SellerOrderStatus.CANCELLED,
            actorType: input.actorType,
            actorUserId: input.actorUserId ?? null,
            reason: input.reason ?? null,
          },
        });
      }
    }

    let paymentStatus = order.paymentStatus;
    if (toStatus === OrderStatus.PAYMENT_CONFIRMED) paymentStatus = OrderPaymentStatus.PAID;
    if (toStatus === OrderStatus.PAYMENT_FAILED) paymentStatus = OrderPaymentStatus.FAILED;
    if (toStatus === OrderStatus.REFUNDED) paymentStatus = OrderPaymentStatus.REFUNDED;
    // COD is collected at the door, so the money lands only on delivery.
    if (toStatus === OrderStatus.DELIVERED && order.paymentMethod === PaymentMethod.COD) {
      paymentStatus = OrderPaymentStatus.PAID;
    }

    const timestampField = ORDER_TIMESTAMP_FOR[toStatus];
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        status: toStatus,
        paymentStatus,
        ...(timestampField ? { [timestampField]: new Date() } : {}),
        ...(toStatus === OrderStatus.CANCELLED
          ? {
              cancellationReason: input.reason ?? null,
              cancelledBy: cancelledByFor(input.actorType),
            }
          : {}),
        // The hold is meaningless once payment resolves either way.
        ...(toStatus === OrderStatus.PAYMENT_CONFIRMED || toStatus === OrderStatus.PAYMENT_FAILED
          ? { reservationExpiresAt: null }
          : {}),
      },
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus,
        toStatus,
        actorType: input.actorType,
        actorUserId: input.actorUserId ?? null,
        reason: input.reason ?? null,
        metadata: (input.metadata ?? null) as never,
      },
    });

    // Fully cancelled/refunded (the state machine allows neither after
    // pickup): release any rider still holding the order. A no-op when the
    // CANCELLED step already released it.
    if (toStatus === OrderStatus.CANCELLED || toStatus === OrderStatus.REFUNDED) {
      const released = await deliveryService.releaseTasksForCancelledOrder(tx, order.id);
      if (released > 0) log.info({ orderId: order.id, released, toStatus }, 'rider released — order ended before pickup');
    }

    // Refer & Earn: DELIVERED is the one unambiguous "genuinely fulfilled
    // order" event in this system (COD collects money only on delivery,
    // online orders only reach it after a real delivery scan) — see
    // referral.service.ts's own doc comment for why this single call, inside
    // this same transaction, is both correct and race-safe with no extra
    // locking of its own beyond what it already does internally.
    if (toStatus === OrderStatus.DELIVERED) {
      await referralService.tryRewardForOrder(tx, {
        id: updated.id,
        userId: updated.userId,
        itemsSubtotalPaise: updated.itemsSubtotalPaise,
      });
    }

    log.info(
      { orderId: order.id, fromStatus, toStatus, actorType: input.actorType },
      'order transitioned',
    );

    return { order: updated, fromStatus, changed: true };
  });

  if (result.changed) {
    await dispatchOrderSideEffects(result, input);
  }

  return result;
}

async function dispatchOrderSideEffects(
  result: OrderTransitionResult,
  input: OrderTransitionInput,
): Promise<void> {
  const { order } = result;

  const event = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    etaMinutes: order.etaMinutes,
  };

  // Best-effort, never fatal: the customer polls as well, and admin/seller
  // panels fall back to polling every 20 s.
  try {
    emitOrderStatus(order.userId, event);
    emitAdminOrderStatus(event);
  } catch (error) {
    log.warn({ err: error, orderId: order.id }, 'realtime emit failed');
  }

  const notification = ORDER_NOTIFICATION_FOR[order.status];
  if (notification) {
    await notificationService.notify({
      userId: order.userId,
      type: notification,
      dedupeKey: `order:${order.id}:${order.status}`,
      orderId: order.id,
      context: {
        orderNumber: order.orderNumber,
        totalPaise: order.totalPaise,
        etaMinutes: order.etaMinutes,
        reason: input.reason ?? null,
      },
    });
  }

  // Sellers: an ONLINE order reaches them only once it is paid (never start
  // preparing an unpaid order); pickup/delivery is announced to every seller
  // still active on the order. COD new-order notices are sent at placement.
  const announceNew = order.status === OrderStatus.PAYMENT_CONFIRMED;
  if (announceNew || SELLER_PARENT_UPDATES.includes(order.status)) {
    const sellerOrders = await prisma.sellerOrder.findMany({
      where: { orderId: order.id },
      select: { id: true, sellerId: true, status: true, subtotalPaise: true },
    });
    for (const so of sellerOrders) {
      if (so.status === SellerOrderStatus.CANCELLED || so.status === SellerOrderStatus.REJECTED) continue;
      if (announceNew) {
        // The realtime "new order" for an online order — held back at
        // placement until now (see announceNewOrder).
        try {
          emitNewSellerOrder(so.sellerId, {
            orderId: order.id,
            sellerOrderId: so.id,
            orderNumber: order.orderNumber,
            status: so.status,
            statusLabel: SELLER_ORDER_STATUS_LABELS[so.status],
          });
        } catch (error) {
          log.warn({ err: error, orderId: order.id }, 'realtime emit failed');
        }
      }
      await notificationService.notifySeller(so.sellerId, {
        type: announceNew ? NotificationType.SELLER_NEW_ORDER : NotificationType.SELLER_ORDER_UPDATE,
        dedupeKey: announceNew ? `so:${so.id}:new` : `so:${so.id}:parent:${order.status}`,
        orderId: order.id,
        context: { orderNumber: order.orderNumber, amountPaise: so.subtotalPaise, status: order.status },
      });
    }
  }
}

/**
 * `PAYMENT_CONFIRMED` is transient by design: the customer should never see
 * it as a resting state, so it advances to `PROCESSING` immediately.
 */
export async function confirmPaymentAndPlace(
  orderId: string,
  actorType: ActorType = ActorType.SYSTEM,
): Promise<OrderTransitionResult> {
  await transitionOrder({ orderId, toStatus: OrderStatus.PAYMENT_CONFIRMED, actorType });
  return transitionOrder({ orderId, toStatus: OrderStatus.PROCESSING, actorType });
}

/** Emits "a brand-new order landed" — called once, right after creation
 * (placeOrder itself doesn't go through `transitionOrder`, since creating a
 * row isn't a transition). */
export function announceNewOrder(order: Order, sellerOrders: SellerOrder[]): void {
  const event = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
  };
  try {
    emitAdminOrderStatus(event);
    // An unpaid ONLINE order is not the sellers' yet: they hear about it
    // when payment is confirmed (dispatchOrderSideEffects), never before.
    if (order.status === OrderStatus.PENDING_PAYMENT) return;
    for (const so of sellerOrders) {
      emitNewSellerOrder(so.sellerId, {
        orderId: order.id,
        sellerOrderId: so.id,
        orderNumber: order.orderNumber,
        status: so.status,
        statusLabel: SELLER_ORDER_STATUS_LABELS[so.status],
      });
    }
  } catch (error) {
    log.warn({ err: error, orderId: order.id }, 'realtime emit failed');
  }
}
