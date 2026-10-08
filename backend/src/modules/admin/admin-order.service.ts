/**
 * Admin order board + dashboard (Tasks 13.2, 13.3) — V2: cross-seller.
 *
 * Admin has full visibility across every seller (#26), so unlike V1 there is
 * no `storeId` scoping here at all — every query below spans the whole
 * marketplace. `getDashboard` anchors its "today" boundary on the
 * marketplace timezone (STORE_TIMEZONE); sellers keep their own timezones
 * for opening hours.
 */

import {
  ActorType,
  ADMIN_TAB_STATUSES,
  AdminOrderTab,
  ConfigKey,
  ErrorCode,
  ORDER_STATUS_LABELS,
  OrderStatus,
  PaymentMethod,
  toOrderBucket,
  type AdminCustomersDto,
  type AdminDashboardDto,
  type AdminOrderSummaryDto,
  type CursorPage,
} from "../../shared";
import { startOfZonedDay, endOfZonedDay, getZonedParts } from "../../shared/datetime";
import { AppError } from "../../common/errors";
import { moduleLogger } from "../../common/logger";
import { prisma } from "../../infra/db/prisma";
import * as configService from "../configuration/configuration.service";
import * as inventoryService from "../inventory/inventory.service";
import * as deliveryService from "../delivery/delivery.service";
import * as paymentService from "../payments/payment.service";
import { verifyDeliveryOtp } from "../orders/order.service";
import { SellerOrderStatus } from "../../shared";
import { transitionOrder, transitionSellerOrder } from "../orders/order-state.service";
import {
  COLLECTED_PAYMENT_STATUS_LIST,
  COMPLETED_SALE_STATUS_LIST,
  PLACED_ORDER_STATUS_LIST,
  completedSaleWhere,
  placedOrderWhere,
} from "../orders/sales-metrics";
import { Prisma } from "@prisma/client";

const log = moduleLogger("admin:orders");

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

function parseCalendarDate(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00.000Z`);
}

/**
 * The marketplace's reporting timezone (STORE_TIMEZONE) — what "today" means
 * on the dashboard. Not any one seller's: sellers keep their own timezones for
 * their opening hours.
 */
async function marketplaceTimezone(): Promise<string> {
  return (await configService.get(ConfigKey.STORE_TIMEZONE)) || "Asia/Kolkata";
}

function formatZonedDateOnly(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * `date` is the reference calendar day to report on ("YYYY-MM-DD"), from the
 * admin dashboard's date picker. Defaults to today when omitted.
 */
export async function getDashboard(date?: string): Promise<AdminDashboardDto> {
  const timezone = await marketplaceTimezone();
  const referenceDate = date ? parseCalendarDate(date) : new Date();
  const dayStart = startOfZonedDay(referenceDate, timezone);
  const dayEnd = endOfZonedDay(referenceDate, timezone);
  const todayStart = startOfZonedDay(new Date(), timezone);

  // One definition of a sale (sales-metrics.ts): orders count only once
  // placed and still standing; revenue only once delivered and collected, at
  // what is still payable after any cancelled seller portion. Cancelled,
  // payment-failed and unpaid orders never count, by status — nothing here
  // filters on amounts or particular orders.
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
      where: { ...placedOrderWhere, placedAt: { gte: dayStart, lte: dayEnd } },
    }),
    prisma.order.aggregate({
      _sum: { currentPayablePaise: true },
      where: { ...completedSaleWhere, deliveredAt: { gte: dayStart, lte: dayEnd } },
    }),
    prisma.order.count({ where: placedOrderWhere }),
    prisma.order.aggregate({
      _sum: { currentPayablePaise: true },
      where: completedSaleWhere,
    }),
    prisma.order.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: { status: { in: [OrderStatus.PROCESSING, OrderStatus.PARTIALLY_CANCELLED, OrderStatus.READY_FOR_PICKUP, OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY] } },
    }),
    prisma.order.count({
      where: { status: OrderStatus.PENDING_PAYMENT },
    }),
    prisma.order.count({
      where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: dayStart, lte: dayEnd } },
    }),
    prisma.order.count({
      where: { status: OrderStatus.CANCELLED, cancelledAt: { gte: dayStart, lte: dayEnd } },
    }),
    inventoryService.listLowStockAllSellers(20),
  ]);

  return {
    date: date ?? formatZonedDateOnly(new Date(), timezone),
    isToday: dayStart.getTime() === todayStart.getTime(),
    todayOrderCount: todayOrders,
    todayRevenuePaise: todayRevenue._sum.currentPayablePaise ?? 0,
    totalOrderCount: totalOrders,
    totalRevenuePaise: totalRevenue._sum.currentPayablePaise ?? 0,
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
  date?: string;
}): Promise<CursorPage<AdminOrderSummaryDto>> {
  const timezone = await marketplaceTimezone();
  const statuses = options.tab ? ADMIN_TAB_STATUSES[options.tab] : undefined;

  const dateRange = options.date
    ? {
        gte: startOfZonedDay(parseCalendarDate(options.date), timezone),
        lte: endOfZonedDay(parseCalendarDate(options.date), timezone),
      }
    : null;

  const orders = await prisma.order.findMany({
    where: {
      ...(statuses ? { status: { in: [...statuses] } } : {}),
      ...(options.search
        ? {
            OR: [
              { orderNumber: { contains: options.search, mode: "insensitive" } },
              { deliveryMobile: { contains: options.search } },
              { deliveryFullName: { contains: options.search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(dateRange || options.cursor
        ? {
            createdAt: {
              ...dateRange,
              ...(options.cursor ? { lt: new Date(options.cursor) } : {}),
            },
          }
        : {}),
    },
    include: {
      sellerOrders: { select: { id: true, items: { select: { qty: true, imageUrl: true } } } },
      deliveryTasks: {
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
    items: page.map((order) => {
      const allItems = order.sellerOrders.flatMap((so) => so.items);
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        statusLabel: ORDER_STATUS_LABELS[order.status],
        bucket: toOrderBucket(order.status),
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        totalPaise: order.totalPaise,
        currentPayablePaise: order.currentPayablePaise,
        itemCount: allItems.reduce((sum, item) => sum + item.qty, 0),
        lineItemCount: allItems.length,
        itemThumbnails: allItems
          .map((item) => item.imageUrl)
          .filter((url): url is string => url !== null)
          .slice(0, 3),
        sellerCount: order.sellerOrders.length,
        placedAt: (order.placedAt ?? order.createdAt).toISOString(),
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        customerName: order.deliveryFullName,
        customerMobile: order.deliveryMobile,
        distanceKm: order.distanceKm,
        addressSummary: `${order.deliveryAddressLine}, ${order.deliveryCity} ${order.deliveryPincode}`,
        deliveryAgentName: order.deliveryTasks[0]?.agent.name ?? null,
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
      };
    }),
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

export async function getOrderForAdmin(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      sellerOrders: {
        include: {
          seller: { select: { id: true, name: true } },
          items: true,
          statusHistory: { orderBy: { createdAt: "asc" }, include: { actor: true } },
        },
      },
      statusHistory: { orderBy: { createdAt: "asc" }, include: { actor: true } },
      payments: true,
      refunds: true,
      user: { select: { id: true, fullName: true, mobile: true, email: true } },
      deliveryTasks: {
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
/* Status updates — parent-level (delivery leg) only. Per-seller             */
/* accept/prepare/ready/reject/cancel goes through seller-order.service.ts.  */
/* -------------------------------------------------------------------------- */

export interface UpdateStatusInput {
  orderId: string;
  toStatus: OrderStatus;
  actorUserId: string;
  reason?: string | null;
  cashCollectedPaise?: number | null;
  deliveryOtp?: string | null;
}

/**
 * Pure filter: which of a parent order's SellerOrders are still eligible to
 * be force-cancelled. Exported so this branching logic is unit-testable
 * without a database (#7) — `updateOrderStatus`/`cancelWholeOrder` below are
 * the only callers.
 */
export function selectSellerOrdersToCancel<T extends { status: SellerOrderStatus }>(
  sellerOrders: readonly T[],
): T[] {
  return sellerOrders.filter(
    (so) => so.status !== SellerOrderStatus.REJECTED && so.status !== SellerOrderStatus.CANCELLED,
  );
}

/**
 * Cancels every still-active SellerOrder under a parent order individually
 * (#2). Each one's own transition — stock restoration, the currentPayable
 * decrement, and its own partial refund if the order was paid online — is
 * independently transaction-safe and idempotent (see
 * order-state.service.ts's `transitionSellerOrder`: a row lock plus a
 * `fromStatus === toStatus` no-op means re-running this on an
 * already-cancelled SellerOrder is a guaranteed no-op, and
 * `payment.service.ts`'s `refundSellerOrderIfPaid` refuses to create a
 * second refund for one that already has one). The parent's own aggregate
 * status is recomputed by `transitionSellerOrder` itself, AFTER each
 * SellerOrder's row is updated, never chosen directly here.
 *
 * One seller's cancellation failing (e.g. a transient error from ITS OWN
 * refund attempt) does not abort the rest — every other still-active seller
 * order is still attempted, and the caller is told to retry so the ONE that
 * failed gets picked up again. A retry is always safe: `selectSellerOrdersToCancel`
 * re-reads current status each time, so an already-cancelled seller order is
 * simply skipped, never touched twice.
 */
export async function cancelWholeOrder(
  orderId: string,
  sellerOrders: { id: string; status: SellerOrderStatus }[],
  actorUserId: string,
  reason: string | null,
): Promise<void> {
  const active = selectSellerOrdersToCancel(sellerOrders);
  const failures: { sellerOrderId: string; error: unknown }[] = [];

  for (const sellerOrder of active) {
    try {
      await transitionSellerOrder({
        sellerOrderId: sellerOrder.id,
        toStatus: SellerOrderStatus.CANCELLED,
        actorType: ActorType.ADMIN,
        actorUserId,
        reason: reason ?? "Order cancelled by admin",
      });
    } catch (error) {
      failures.push({ sellerOrderId: sellerOrder.id, error });
      log.error(
        { err: error, orderId, sellerOrderId: sellerOrder.id },
        "seller order cancellation failed during whole-order cancel — safe to retry",
      );
    }
  }

  if (failures.length > 0) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, {
      message: `${failures.length} of ${active.length} seller order(s) could not be cancelled. Please try again.`,
      internalMessage: `orderId=${orderId} failed=${failures.map((f) => f.sellerOrderId).join(",")}`,
    });
  }
}

/**
 * The parent order's dispatch / deliver actions.
 *
 * Extra guards beyond the state machine, each protecting something physical:
 *   - dispatch requires an assigned rider (otherwise nobody has the parcel)
 *   - COD delivery requires the customer's OTP (proof it reached them)
 */
export async function updateOrderStatus(input: UpdateStatusInput): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      sellerOrders: { select: { id: true, status: true } },
      deliveryTasks: { where: { status: { not: "CANCELLED" } }, take: 1 },
    },
  });
  if (!order)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });

  // Admin force-cancelling the WHOLE order is not itself a direct parent
  // transition once any seller has been engaged — PROCESSING/
  // PARTIALLY_CANCELLED -> CANCELLED is derived (SYSTEM-only), by design (see
  // order-state.service.ts). Cascading through every still-active
  // SellerOrder gets the same end result correctly: each one's own refund
  // fires individually (#10/#19), and the parent lands on CANCELLED once
  // none are left active.
  if (input.toStatus === OrderStatus.CANCELLED && order.status !== OrderStatus.PENDING_PAYMENT) {
    await cancelWholeOrder(order.id, order.sellerOrders, input.actorUserId, input.reason ?? null);
    return;
  }

  if (
    (input.toStatus === OrderStatus.PICKED_UP || input.toStatus === OrderStatus.OUT_FOR_DELIVERY) &&
    order.deliveryTasks.length === 0
  ) {
    throw new AppError(ErrorCode.DELIVERY_AGENT_REQUIRED);
  }

  // The delivery OTP is OPTIONAL: an order is marked delivered without one.
  // When one IS supplied it must still match the order's (see
  // Order.deliveryOtpHash) — checked before the transition, so a wrong code
  // never marks an order DELIVERED. Every other check above and in
  // transitionOrder applies either way.
  if (input.toStatus === OrderStatus.DELIVERED && input.deliveryOtp) {
    await verifyDeliveryOtp(order.id, input.deliveryOtp);
  }

  const transition = await transitionOrder({
    orderId: input.orderId,
    toStatus: input.toStatus,
    actorType: ActorType.ADMIN,
    actorUserId: input.actorUserId,
    reason: input.reason ?? null,
  });

  // Only the request that actually delivered the order completes the rider's
  // task. A repeated DELIVERED on an already-delivered order is a no-op in
  // transitionOrder (`changed: false`), and must stay one here — otherwise it
  // would rewrite the task's deliveredAt, cash collected and notes.
  if (input.toStatus === OrderStatus.DELIVERED && transition.changed) {
    await deliveryService.recordDelivery(order.id, {
      cashCollectedPaise:
        order.paymentMethod === PaymentMethod.COD
          ? (input.cashCollectedPaise ?? order.totalPaise)
          : null,
    });
  }

  // PENDING_PAYMENT -> CANCELLED is a direct parent transition (nothing was
  // ever engaged) — no payment could have been captured yet either, so this
  // is a safe no-op guard, not a live refund path.
  if (input.toStatus === OrderStatus.CANCELLED) {
    await paymentService.refundIfPaid(order.id, input.reason ?? "Order cancelled by admin");
  }
}

/* -------------------------------------------------------------------------- */
/* Customers                                                                  */
/* -------------------------------------------------------------------------- */

const CANCELLED_ORDER_STATUS_LIST: string[] = [
  OrderStatus.CANCELLED,
  OrderStatus.PAYMENT_FAILED,
  OrderStatus.REFUNDED,
];

/**
 * GET /admin/customers — every customer who has ever checked out, with
 * order counts and spend aggregated IN THE DATABASE by the single sale
 * definition (sales-metrics.ts): placed orders that still stand are counted,
 * only delivered-and-collected orders are spent (at `currentPayablePaise`),
 * and cancelled / payment-failed / refunded orders are reported separately,
 * never as sales. Replaces the old client-side merge of the order tabs, which
 * summed every order's total (cancelled ones included) and saw only the most
 * recent 50 orders per tab.
 */
export async function listCustomers(query: {
  q?: string | undefined;
  page: number;
  pageSize: number;
}): Promise<AdminCustomersDto> {
  const placed = Prisma.sql`o.status::text = ANY(${PLACED_ORDER_STATUS_LIST})`;
  const completed = Prisma.sql`o.status::text = ANY(${COMPLETED_SALE_STATUS_LIST}) AND o.payment_status::text = ANY(${COLLECTED_PAYMENT_STATUS_LIST})`;
  const cancelled = Prisma.sql`o.status::text = ANY(${CANCELLED_ORDER_STATUS_LIST})`;
  const term = query.q?.trim();
  const search = term
    ? Prisma.sql`HAVING (u.full_name ILIKE ${`%${term}%`} OR u.mobile LIKE ${`%${term.replace(/\D/g, "") || term}%`} OR MAX(o.delivery_full_name) ILIKE ${`%${term}%`})`
    : Prisma.empty;

  const perCustomer = Prisma.sql`
    SELECT
      u.id AS user_id,
      COALESCE(u.full_name, MAX(o.delivery_full_name)) AS name,
      u.mobile AS mobile,
      COUNT(*) FILTER (WHERE ${placed}) AS order_count,
      COUNT(*) FILTER (WHERE ${placed} AND NOT (${completed})) AS active_count,
      COUNT(*) FILTER (WHERE ${cancelled}) AS cancelled_count,
      COALESCE(SUM(o.current_payable_paise) FILTER (WHERE ${completed}), 0) AS spent,
      MAX(COALESCE(o.placed_at, o.created_at)) AS last_order_at
    FROM orders o
    JOIN users u ON u.id = o.user_id
    GROUP BY u.id, u.full_name, u.mobile`;

  const [rows, totals, summary] = await Promise.all([
    prisma.$queryRaw<
      {
        user_id: string;
        name: string | null;
        mobile: string;
        order_count: bigint;
        active_count: bigint;
        cancelled_count: bigint;
        spent: bigint;
        last_order_at: Date;
      }[]
    >`
      ${perCustomer}
      ${search}
      ORDER BY spent DESC, order_count DESC, last_order_at DESC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*) AS total FROM (${perCustomer} ${search}) AS customers`,
    prisma.$queryRaw<{ customers: bigint; repeat: bigint; revenue: bigint | null }[]>`
      SELECT
        COUNT(*) FILTER (WHERE order_count > 0) AS customers,
        COUNT(*) FILTER (WHERE order_count > 1) AS repeat,
        SUM(spent) AS revenue
      FROM (${perCustomer}) AS customers`,
  ]);

  return {
    summary: {
      customerCount: Number(summary[0]?.customers ?? 0),
      repeatCustomerCount: Number(summary[0]?.repeat ?? 0),
      revenuePaise: Number(summary[0]?.revenue ?? 0),
    },
    items: rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      mobile: row.mobile,
      orderCount: Number(row.order_count),
      activeOrderCount: Number(row.active_count),
      cancelledOrderCount: Number(row.cancelled_count),
      totalSpentPaise: Number(row.spent),
      lastOrderAt: row.last_order_at.toISOString(),
    })),
    total: Number(totals[0]?.total ?? 0),
    page: query.page,
    pageSize: query.pageSize,
  };
}
