/**
 * New-order alerts for the admin panel — the Orders badge and the "NEW ORDER"
 * popups.
 *
 * WHEN. An order is announced exactly when it becomes a real order, the same
 * two moments the sellers hear about it: a COD order at placement
 * (order.service notifyOrderPlaced), an ONLINE order only once its payment is
 * verified (order-state.service, PAYMENT_CONFIRMED side effects — reached
 * only through the existing, unchanged Cashfree verification: webhook, app
 * refresh or reconciliation). An unpaid, pending or failed checkout is never
 * announced.
 *
 * ONCE. Each admin gets ONE notification row per order (dedupe key
 * `order:<id>:admin-new`, unique per user): a webhook retry, a reconciliation
 * run or two paths finishing together can never add a second alert or a
 * second unread. The realtime event goes out only when a row was really
 * created, and the panel also re-reads the list (API recovery), so a dropped
 * socket loses nothing.
 *
 * READ STATE is the admin's own row (notifications.read_at): per admin,
 * persisted, survives refresh and logout.
 */

import {
  NotificationAudience,
  NotificationType,
  ORDER_STATUS_LABELS,
  Permission,
  type AdminOrderAlertDto,
  type AdminOrderAlertsDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { ErrorCode } from '../../shared';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import { emitNewOrder } from '../../realtime/socket';
import * as notificationService from '../notifications/notification.service';

const log = moduleLogger('admin:order-alerts');

/** The dedupe key of an order's admin alert (one per admin per order). */
export const adminNewOrderKey = (orderId: string) => `order:${orderId}:admin-new`;

/**
 * Announce a just-confirmed order to every admin who works the orders.
 * Best effort and idempotent: never throws, never alerts twice.
 */
export async function announceNewOrderToAdmins(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, status: true, paymentMethod: true, totalPaise: true },
    });
    if (!order) return;
    const created = await notificationService.notifyAdmins(Permission.ORDER_READ_ALL, {
      type: NotificationType.ORDER_PLACED,
      dedupeKey: adminNewOrderKey(order.id),
      orderId: order.id,
      context: { orderNumber: order.orderNumber, totalPaise: order.totalPaise, paymentMethod: order.paymentMethod },
    });
    // Only a genuinely new announcement goes out live (a repeat created no row).
    if (created > 0) {
      emitNewOrder({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        statusLabel: ORDER_STATUS_LABELS[order.status],
      });
    }
  } catch (error) {
    log.error({ err: error, orderId }, 'admin new-order alert failed');
  }
}

const ALERT_WHERE = (userId: string) => ({
  userId,
  audience: NotificationAudience.ADMIN,
  type: NotificationType.ORDER_PLACED,
  orderId: { not: null },
  readAt: null,
});

/** This admin's unread new-order alerts with each order's summary (newest first, max 50 shown). */
export async function listOrderAlerts(userId: string): Promise<AdminOrderAlertsDto> {
  const [unread, rows] = await Promise.all([
    prisma.notification.count({ where: ALERT_WHERE(userId) }),
    prisma.notification.findMany({
      where: ALERT_WHERE(userId),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { id: true, orderId: true, createdAt: true },
    }),
  ]);
  if (rows.length === 0) return { unread, items: [] };

  const orders = await prisma.order.findMany({
    where: { id: { in: rows.map((r) => r.orderId!) } },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentMethod: true,
      paymentStatus: true,
      deliveryFullName: true,
      itemsSubtotalPaise: true,
      deliveryFeePaise: true,
      platformFeePaise: true,
      taxPaise: true,
      couponDiscountPaise: true,
      totalPaise: true,
      placedAt: true,
      createdAt: true,
      sellerOrders: {
        orderBy: { createdAt: 'asc' },
        select: {
          items: {
            orderBy: { createdAt: 'asc' },
            select: { productName: true, variantName: true, qty: true, imageUrl: true },
          },
        },
      },
    },
  });
  const byId = new Map(orders.map((o) => [o.id, o]));

  const items: AdminOrderAlertDto[] = [];
  for (const row of rows) {
    const order = byId.get(row.orderId!);
    if (!order) continue;
    const lines = order.sellerOrders.flatMap((so) => so.items);
    // The first line WITH a photo represents the order; else the first line.
    const first = lines.find((line) => line.imageUrl) ?? lines[0] ?? null;
    items.push({
      alertId: row.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentMethod: order.paymentMethod === 'COD' ? 'COD' : 'ONLINE',
      paymentStatus: order.paymentStatus,
      customerName: order.deliveryFullName,
      firstItem: first ? { productName: first.productName, variantName: first.variantName, qty: first.qty, imageUrl: first.imageUrl } : null,
      lineCount: lines.length,
      unitCount: lines.reduce((sum, line) => sum + line.qty, 0),
      sellerCount: order.sellerOrders.length,
      itemsSubtotalPaise: order.itemsSubtotalPaise,
      deliveryFeePaise: order.deliveryFeePaise,
      platformFeePaise: order.platformFeePaise,
      taxPaise: order.taxPaise,
      discountPaise: order.couponDiscountPaise,
      totalPaise: order.totalPaise,
      placedAt: (order.placedAt ?? order.createdAt).toISOString(),
      alertedAt: row.createdAt.toISOString(),
    });
  }
  return { unread, items };
}

/**
 * The admin opened this order: its alert is read — for THIS admin only.
 * Idempotent (already read / no alert = nothing to do); an unknown order is
 * NOT_FOUND.
 */
export async function markOrderAlertRead(userId: string, orderId: string): Promise<{ unread: number }> {
  const exists = await prisma.order.count({ where: { id: orderId } });
  if (exists === 0) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
  await prisma.notification.updateMany({
    where: { ...ALERT_WHERE(userId), orderId },
    data: { readAt: new Date() },
  });
  return { unread: await prisma.notification.count({ where: ALERT_WHERE(userId) }) };
}
