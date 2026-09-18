/**
 * Admin order board + dashboard (Tasks 13.2, 13.3).
 *
 * The order board is the highest-frequency screen in the whole system — the
 * store watches it all day — so the queries are shaped to hit the
 * `orders_active_board` partial index.
 */

import {
  ACTIVE_ORDER_STATUSES,
  ActorType,
  ADMIN_TAB_STATUSES,
  AdminOrderTab,
  ErrorCode,
  ORDER_STATUS_LABELS,
  OrderStatus,
  PaymentMethod,
  toOrderBucket,
  type AdminDashboardDto,
  type AdminOrderSummaryDto,
  type CursorPage,
} from "../../shared";
import { startOfZonedDay, endOfZonedDay } from "../../shared/datetime";
import { AppError } from "../../common/errors";
import { prisma } from "../../infra/db/prisma";
import * as storeService from "../stores/store.service";
import * as inventoryService from "../inventory/inventory.service";
import * as deliveryService from "../delivery/delivery.service";
import * as orderService from "../orders/order.service";
import * as paymentService from "../payments/payment.service";
import { transitionOrder } from "../orders/order-state.service";

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export async function getDashboard(): Promise<AdminDashboardDto> {
  const store = await storeService.getActiveStore();
  const now = new Date();
  // "Today" means the store's local day, not the server's UTC day.
  const dayStart = startOfZonedDay(now, store.timezone);
  const dayEnd = endOfZonedDay(now, store.timezone);

  const paidStatuses = [OrderStatus.DELIVERED, OrderStatus.OUT_FOR_DELIVERY];

  const [
    todayOrders,
    todayRevenue,
    totalOrders,
    totalRevenue,
    byStatus,
    pendingCount,
    completedToday,
    cancelledToday,
    lowStock,
  ] = await Promise.all([
    prisma.order.count({
      where: { storeId: store.id, createdAt: { gte: dayStart, lte: dayEnd } },
    }),
    prisma.order.aggregate({
      _sum: { totalPaise: true },
      where: {
        storeId: store.id,
        createdAt: { gte: dayStart, lte: dayEnd },
        status: { in: paidStatuses },
      },
    }),
    prisma.order.count({ where: { storeId: store.id } }),
    prisma.order.aggregate({
      _sum: { totalPaise: true },
      where: { storeId: store.id, status: OrderStatus.DELIVERED },
    }),
    prisma.order.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: { storeId: store.id, status: { in: [...ACTIVE_ORDER_STATUSES] } },
    }),
    prisma.order.count({
      where: { storeId: store.id, status: OrderStatus.ORDER_PLACED },
    }),
    prisma.order.count({
      where: {
        storeId: store.id,
        status: OrderStatus.DELIVERED,
        deliveredAt: { gte: dayStart, lte: dayEnd },
      },
    }),
    prisma.order.count({
      where: {
        storeId: store.id,
        status: { in: [OrderStatus.CANCELLED, OrderStatus.REJECTED] },
        cancelledAt: { gte: dayStart, lte: dayEnd },
      },
    }),
    inventoryService.listLowStock(store.id, 20),
  ]);

  return {
    todayOrderCount: todayOrders,
    todayRevenuePaise: todayRevenue._sum.totalPaise ?? 0,
    totalOrderCount: totalOrders,
    totalRevenuePaise: totalRevenue._sum.totalPaise ?? 0,
    ordersByStatus: byStatus.map((row) => ({
      status: row.status,
      count: row._count._all,
    })),
    pendingOrderCount: pendingCount,
    completedTodayCount: completedToday,
    cancelledTodayCount: cancelledToday,
    lowStockCount: lowStock.length,
    lowStockItems: lowStock,
  };
}

/* -------------------------------------------------------------------------- */
/* Order board                                                                */
/* -------------------------------------------------------------------------- */

export async function listOrders(options: {
  tab?: AdminOrderTab;
  search?: string;
  cursor?: string | null;
  limit: number;
}): Promise<CursorPage<AdminOrderSummaryDto>> {
  const store = await storeService.getActiveStore();
  const statuses = options.tab ? ADMIN_TAB_STATUSES[options.tab] : undefined;

  const orders = await prisma.order.findMany({
    where: {
      storeId: store.id,
      ...(statuses ? { status: { in: [...statuses] } } : {}),
      ...(options.search
        ? {
            OR: [
              {
                orderNumber: { contains: options.search, mode: "insensitive" },
              },
              { deliveryMobile: { contains: options.search } },
              {
                deliveryFullName: {
                  contains: options.search,
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
      ...(options.cursor
        ? { createdAt: { lt: new Date(options.cursor) } }
        : {}),
    },
    include: {
      items: { select: { qty: true, imageUrl: true } },
      assignments: {
        where: { status: { not: "CANCELLED" } },
        include: { agent: { select: { name: true } } },
        take: 1,
      },
      payments: {
        where: { status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { rawPayload: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: options.limit + 1,
  });

  const hasMore = orders.length > options.limit;
  const page = hasMore ? orders.slice(0, options.limit) : orders;
  const last = page[page.length - 1];
  const now = Date.now();

  return {
    items: page.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      statusLabel: ORDER_STATUS_LABELS[order.status],
      bucket: toOrderBucket(order.status),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      totalPaise: order.totalPaise,
      itemCount: order.items.reduce((sum, item) => sum + item.qty, 0),
      lineItemCount: order.items.length,
      itemThumbnails: order.items
        .map((item) => item.imageUrl)
        .filter((url): url is string => url !== null)
        .slice(0, 3),
      placedAt: (order.placedAt ?? order.createdAt).toISOString(),
      deliveredAt: order.deliveredAt?.toISOString() ?? null,
      customerName: order.deliveryFullName,
      customerMobile: order.deliveryMobile,
      distanceKm: order.distanceKm,
      addressSummary: `${order.deliveryAddressLine}, ${order.deliveryCity} ${order.deliveryPincode}`,
      deliveryAgentName: order.assignments[0]?.agent.name ?? null,
      // Drives the "2 mins ago" ageing indicator that tells the counter which
      // order has been waiting longest.
      minutesSincePlaced: Math.floor(
        (now - (order.placedAt ?? order.createdAt).getTime()) / 60_000,
      ),
      paymentClaim: (() => {
        const claim = order.payments[0]?.rawPayload as
          | { utr?: string | null; claimedAt?: string | null }
          | null
          | undefined;
        if (!claim) return null;
        return { utr: claim.utr ?? null, claimedAt: claim.claimedAt ?? null };
      })(),
    })),
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

export async function getOrderForAdmin(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      statusHistory: {
        orderBy: { createdAt: "asc" },
        include: { actor: true },
      },
      payments: true,
      refunds: true,
      user: { select: { id: true, fullName: true, mobile: true, email: true } },
      assignments: {
        include: { agent: true },
        orderBy: { assignedAt: "desc" },
      },
    },
  });
  if (!order)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });
  return order;
}

/* -------------------------------------------------------------------------- */
/* Status updates                                                             */
/* -------------------------------------------------------------------------- */

export interface UpdateStatusInput {
  orderId: string;
  toStatus: OrderStatus;
  actorUserId: string;
  reason?: string | null;
  cashCollectedPaise?: number | null;
}

/**
 * The store's accept / prepare / ready / dispatch / deliver actions.
 *
 * Extra guards beyond the state machine, each protecting something physical:
 *   - dispatch requires an assigned rider (otherwise nobody has the parcel)
 *   - COD delivery requires the customer's OTP (proof it reached them)
 *   - rejecting a paid order auto-refunds
 */
export async function updateOrderStatus(
  input: UpdateStatusInput,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      assignments: { where: { status: { not: "CANCELLED" } }, take: 1 },
    },
  });
  if (!order)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });

  if (
    input.toStatus === OrderStatus.OUT_FOR_DELIVERY &&
    order.assignments.length === 0
  ) {
    throw new AppError(ErrorCode.DELIVERY_AGENT_REQUIRED);
  }

  await transitionOrder({
    orderId: input.orderId,
    toStatus: input.toStatus,
    actorType: ActorType.ADMIN,
    actorUserId: input.actorUserId,
    reason: input.reason ?? null,
  });

  if (input.toStatus === OrderStatus.DELIVERED) {
    await deliveryService.recordDelivery(order.id, {
      cashCollectedPaise:
        order.paymentMethod === PaymentMethod.COD
          ? (input.cashCollectedPaise ?? order.totalPaise)
          : null,
    });
  }

  // Money back automatically — never left as a manual step someone forgets.
  if (
    input.toStatus === OrderStatus.CANCELLED ||
    input.toStatus === OrderStatus.REJECTED
  ) {
    await paymentService.refundIfPaid(
      order.id,
      input.reason ?? "Order cancelled by the store",
    );
  }
}
