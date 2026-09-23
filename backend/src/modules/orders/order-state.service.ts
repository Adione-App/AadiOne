/**
 * Order state machine (Task 8.1).
 *
 * `transitionOrder` is THE ONLY code in this system permitted to write
 * `orders.status`. Everything else — admin actions, payment webhooks, jobs,
 * the customer cancelling — goes through it.
 *
 * That single choke point is what makes the guarantees real:
 *   - illegal transitions are impossible, not merely discouraged
 *   - every change is recorded in `order_status_history` with an actor
 *   - stock and payment side effects happen in the SAME transaction
 *   - notifications are queued but only dispatched after commit
 */

import type { Order } from '@prisma/client';
import {
  ActorType,
  CancelledBy,
  ErrorCode,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  ORDER_STATUS_LABELS,
  StockLedgerReason,
  canActorTransition,
  canTransition,
} from '../../shared';
import { AppError } from '../../common/errors';
import { runInTransaction, type Tx } from '../../infra/db/prisma';
import { moduleLogger } from '../../common/logger';
import * as inventoryService from '../inventory/inventory.service';
import * as notificationService from '../notifications/notification.service';
import * as referralService from '../referrals/referral.service';
import {
  emitNewOrder,
  emitOrderStatus,
  emitStoreOrderStatus,
} from '../../realtime/socket';

const log = moduleLogger('orders:state');

export interface TransitionInput {
  orderId: string;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  order: Order;
  fromStatus: OrderStatus;
  /** Queued for dispatch AFTER commit — never inside the transaction. */
  notification: NotificationType | null;
}

/** Which customer notification each arrival state produces. */
const NOTIFICATION_FOR: Partial<Record<OrderStatus, NotificationType>> = {
  [OrderStatus.ORDER_PLACED]: NotificationType.ORDER_PLACED,
  [OrderStatus.STORE_ACCEPTED]: NotificationType.ORDER_ACCEPTED,
  [OrderStatus.PREPARING]: NotificationType.ORDER_PREPARING,
  [OrderStatus.READY_FOR_PICKUP]: NotificationType.ORDER_READY,
  [OrderStatus.OUT_FOR_DELIVERY]: NotificationType.ORDER_OUT_FOR_DELIVERY,
  [OrderStatus.DELIVERED]: NotificationType.ORDER_DELIVERED,
  [OrderStatus.CANCELLED]: NotificationType.ORDER_CANCELLED,
  [OrderStatus.REJECTED]: NotificationType.ORDER_REJECTED,
  [OrderStatus.PAYMENT_FAILED]: NotificationType.PAYMENT_FAILED,
  [OrderStatus.REFUNDED]: NotificationType.REFUND_COMPLETED,
};

/** Timestamp column stamped on arrival at each state. */
const TIMESTAMP_FOR: Partial<Record<OrderStatus, keyof Order>> = {
  [OrderStatus.ORDER_PLACED]: 'placedAt',
  [OrderStatus.STORE_ACCEPTED]: 'acceptedAt',
  [OrderStatus.PREPARING]: 'preparingAt',
  [OrderStatus.READY_FOR_PICKUP]: 'readyAt',
  [OrderStatus.OUT_FOR_DELIVERY]: 'outForDeliveryAt',
  [OrderStatus.DELIVERED]: 'deliveredAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
};

/** States after which stock has left the shelf rather than merely being held. */
const COMMITTED_STATES: readonly OrderStatus[] = [
  OrderStatus.PAYMENT_CONFIRMED,
  OrderStatus.ORDER_PLACED,
  OrderStatus.STORE_ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

async function loadOrderItemsForStock(tx: Tx, orderId: string, storeId: string) {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { variantId: true, qty: true },
  });

  const variantIds = items
    .map((item) => item.variantId)
    .filter((id): id is string => id !== null);

  const offers = await tx.storeVariant.findMany({
    where: { storeId, variantId: { in: variantIds } },
    select: { id: true, variantId: true },
  });
  const offerByVariant = new Map(offers.map((offer) => [offer.variantId, offer.id]));

  return items
    .filter((item) => item.variantId && offerByVariant.has(item.variantId))
    .map((item) => ({
      storeVariantId: offerByVariant.get(item.variantId!)!,
      variantId: item.variantId!,
      qty: item.qty,
    }));
}

/**
 * Performs a state transition.
 *
 * Runs in a transaction with the order row locked `FOR UPDATE`, so two admins
 * clicking "Accept" simultaneously cannot both succeed — the second sees the
 * already-changed status and is rejected as an illegal transition.
 */
export async function transitionOrder(input: TransitionInput): Promise<TransitionResult> {
  const result = await runInTransaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
      SELECT id, status FROM orders WHERE id = ${input.orderId}::uuid FOR UPDATE`;

    if (!locked) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
    }

    const fromStatus = locked.status;
    const { toStatus } = input;

    if (fromStatus === toStatus) {
      // Idempotent no-op: a duplicate webhook or a double-clicked button must
      // not be an error.
      const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId } });
      return { order, fromStatus, notification: null };
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

    // --- stock side effects ------------------------------------------------
    const stockItems = await loadOrderItemsForStock(tx, order.id, order.storeId);

    if (toStatus === OrderStatus.PAYMENT_CONFIRMED) {
      // Payment cleared: the held units now actually leave the shelf.
      await inventoryService.commitReservation(tx, stockItems, order.id);
    }

    if (toStatus === OrderStatus.PAYMENT_FAILED) {
      await inventoryService.releaseReservation(tx, stockItems, order.id);
    }

    if (toStatus === OrderStatus.CANCELLED || toStatus === OrderStatus.REJECTED) {
      if (COMMITTED_STATES.includes(fromStatus)) {
        // Already sold: put the goods back on the shelf.
        await inventoryService.restockCommitted(tx, stockItems, order.id);
      } else {
        // Still only reserved: release the hold.
        await inventoryService.releaseReservation(
          tx,
          stockItems,
          order.id,
          StockLedgerReason.ORDER_RELEASE,
        );
      }
    }

    // --- payment status ----------------------------------------------------
    let paymentStatus = order.paymentStatus;
    if (toStatus === OrderStatus.PAYMENT_CONFIRMED) paymentStatus = OrderPaymentStatus.PAID;
    if (toStatus === OrderStatus.PAYMENT_FAILED) paymentStatus = OrderPaymentStatus.FAILED;
    if (toStatus === OrderStatus.REFUNDED) paymentStatus = OrderPaymentStatus.REFUNDED;
    // COD is collected at the door, so the money lands only on delivery.
    if (toStatus === OrderStatus.DELIVERED && order.paymentMethod === PaymentMethod.COD) {
      paymentStatus = OrderPaymentStatus.PAID;
    }

    const timestampField = TIMESTAMP_FOR[toStatus];
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        status: toStatus,
        paymentStatus,
        ...(timestampField ? { [timestampField]: new Date() } : {}),
        ...(toStatus === OrderStatus.CANCELLED || toStatus === OrderStatus.REJECTED
          ? {
              cancellationReason: input.reason ?? null,
              cancelledBy:
                input.actorType === ActorType.CUSTOMER
                  ? CancelledBy.CUSTOMER
                  : input.actorType === ActorType.ADMIN
                    ? CancelledBy.ADMIN
                    : CancelledBy.SYSTEM,
            }
          : {}),
        // The hold is meaningless once payment resolves either way.
        ...(toStatus === OrderStatus.PAYMENT_CONFIRMED ||
        toStatus === OrderStatus.PAYMENT_FAILED
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

    return {
      order: updated,
      fromStatus,
      notification: NOTIFICATION_FOR[toStatus] ?? null,
    };
  });

  // AFTER COMMIT. Push gateways and socket emits are network calls; running
  // them inside the transaction would hold inventory row locks for the
  // duration of a third party's latency, and a failing push would roll back a
  // perfectly good order.
  await dispatchSideEffects(result, input);

  return result;
}

async function dispatchSideEffects(
  result: TransitionResult,
  input: TransitionInput,
): Promise<void> {
  const { order } = result;

  const event = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    etaMinutes: order.etaMinutes,
  };

  // Best-effort, never fatal: the customer polls as well, and the store's
  // board falls back to polling every 20 s.
  try {
    emitOrderStatus(order.userId, event);
    emitStoreOrderStatus(order.storeId, event);
    if (order.status === OrderStatus.ORDER_PLACED) emitNewOrder(order.storeId, event);
  } catch (error) {
    log.warn({ err: error, orderId: order.id }, 'realtime emit failed');
  }

  if (result.notification) {
    await notificationService.notify({
      userId: order.userId,
      type: result.notification,
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalPaise: order.totalPaise,
      etaMinutes: order.etaMinutes,
      reason: input.reason ?? null,
    });
  }
}

/**
 * `PAYMENT_CONFIRMED` is transient by design: the customer should never see it
 * as a resting state, so it advances to `ORDER_PLACED` immediately.
 */
export async function confirmPaymentAndPlace(
  orderId: string,
  actorType: ActorType = ActorType.SYSTEM,
): Promise<TransitionResult> {
  await transitionOrder({ orderId, toStatus: OrderStatus.PAYMENT_CONFIRMED, actorType });
  return transitionOrder({ orderId, toStatus: OrderStatus.ORDER_PLACED, actorType });
}
