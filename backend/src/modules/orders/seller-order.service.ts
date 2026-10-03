/**
 * Seller-order management — the seller panel's own "my orders" list and
 * accept/reject/prepare/ready actions. Reused by admin (with full
 * cross-seller access) for the same actions on ANY seller's order (#26).
 *
 * Every function here takes an optional `scopeSellerId`: the seller-panel
 * routes always pass `req.sellerId` (from `attachSellerContext`), which
 * turns a mismatched or missing `sellerOrderId` into a plain NOT_FOUND —
 * exactly like a customer's own order lookup already does — rather than
 * ever revealing that a DIFFERENT seller's order exists (#15/#27). The admin
 * routes pass `undefined`, since admin has no such restriction.
 */

import {
  ActorType,
  ErrorCode,
  SELLER_ORDER_STATUS_LABELS,
  SellerOrderStatus,
  type CursorPage,
  type SellerOrderListRowDto,
} from '../../shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { transitionSellerOrder } from './order-state.service';
import { isOrderVisibleToSeller, sellerVisibleOrderWhere } from './order-visibility';
import {
  handoverOf,
  stageFilter,
  zonedDayRange,
  zonedToday,
  type SellerOrderHandover,
  type SellerOrderStage,
} from './seller-order-views';

async function loadOwned(sellerOrderId: string, scopeSellerId?: string) {
  const sellerOrder = await prisma.sellerOrder.findUnique({
    where: { id: sellerOrderId },
    include: {
      order: { select: { orderNumber: true, deliveryFullName: true, deliveryMobile: true, status: true, placedAt: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!sellerOrder || (scopeSellerId && sellerOrder.sellerId !== scopeSellerId)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
  }
  // A seller never sees an order that was not placed (unpaid, payment
  // failed/expired, or cancelled before payment) — see order-visibility.ts.
  if (scopeSellerId && !isOrderVisibleToSeller(sellerOrder.order)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
  }
  const { status: _status, placedAt: _placedAt, ...order } = sellerOrder.order;
  return { ...sellerOrder, order };
}

/**
 * A list row plus what the seller panel needs to group and explain it:
 * how the customer pays, and (once ready) whether the rider has the goods.
 * Both are read-only views of the parent order.
 */
export type SellerOrderListRow = SellerOrderListRowDto & {
  paymentMethod: string;
  handover: SellerOrderHandover | null;
};

export interface ListSellerOrdersOptions {
  sellerId?: string;
  status?: SellerOrderStatus;
  /** Grouped views (seller-order-views.ts); ignored when `status` is given. */
  stage?: SellerOrderStage;
  /** Order-number search (case-insensitive, partial). */
  q?: string;
  /** One parent order — e.g. opened from a notification about it. */
  orderId?: string;
  /** Calendar days ("YYYY-MM-DD") in the seller's timezone, inclusive. */
  from?: string;
  to?: string;
  cursor?: string | null;
  limit: number;
}

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

async function sellerTimezone(sellerId: string | undefined): Promise<string> {
  if (!sellerId) return DEFAULT_TIMEZONE;
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { timezone: true } });
  return seller?.timezone ?? DEFAULT_TIMEZONE;
}

export async function listSellerOrders(
  scopeSellerId: string | undefined,
  options: ListSellerOrdersOptions,
): Promise<CursorPage<SellerOrderListRow>> {
  const sellerId = scopeSellerId ?? options.sellerId;
  const stage = options.status ? null : options.stage ? stageFilter(options.stage) : null;
  const timezone = options.from || options.to ? await sellerTimezone(sellerId) : DEFAULT_TIMEZONE;

  const createdAt: Prisma.DateTimeFilter = {
    ...(options.cursor ? { lt: new Date(options.cursor) } : {}),
    ...(options.from ? { gte: zonedDayRange(options.from, timezone).start } : {}),
  };
  if (options.to) {
    const end = zonedDayRange(options.to, timezone).end;
    // Keep the cursor's bound when it is the tighter one.
    if (!createdAt.lt || end < (createdAt.lt as Date)) createdAt.lt = end;
  }

  // Parent-order conditions are ANDed so none overwrites another's `status`.
  const orderConditions: Prisma.OrderWhereInput[] = [
    // A seller's own list shows only placed orders; admins see all.
    ...(scopeSellerId ? [sellerVisibleOrderWhere] : []),
    ...(stage?.orderStatus ? [{ status: stage.orderStatus }] : []),
    ...(options.q ? [{ orderNumber: { contains: options.q, mode: 'insensitive' as const } }] : []),
  ];

  const rows = await prisma.sellerOrder.findMany({
    where: {
      ...(sellerId ? { sellerId } : {}),
      ...(orderConditions.length > 0 ? { order: { AND: orderConditions } } : {}),
      ...(options.status ? { status: options.status } : stage ? { status: stage.status } : {}),
      ...(options.orderId ? { orderId: options.orderId } : {}),
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    },
    include: {
      order: {
        select: { orderNumber: true, deliveryFullName: true, deliveryMobile: true, status: true, paymentMethod: true },
      },
      items: { select: { qty: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: options.limit + 1,
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order.orderNumber,
      status: row.status,
      statusLabel: SELLER_ORDER_STATUS_LABELS[row.status],
      subtotalPaise: row.subtotalPaise,
      itemCount: row.items.reduce((sum, item) => sum + item.qty, 0),
      customerName: row.order.deliveryFullName,
      customerMobile: row.order.deliveryMobile,
      createdAt: row.createdAt.toISOString(),
      paymentMethod: row.order.paymentMethod,
      handover: handoverOf(row.status, row.order.status),
    })),
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

export interface SellerOrderSummary {
  /** The seller's calendar day the "today" figures cover. */
  today: string;
  timezone: string;
  /** Orders placed with this seller today. */
  todayOrders: number;
  counts: { NEW: number; ACCEPTED: number; PREPARING: number; READY: number };
}

/**
 * The seller dashboard's order numbers in one round trip (instead of a
 * page of rows per status). Same visibility rule as the list.
 */
export async function getSellerOrderSummary(sellerId: string): Promise<SellerOrderSummary> {
  const timezone = await sellerTimezone(sellerId);
  const today = zonedToday(timezone);
  const { start, end } = zonedDayRange(today, timezone);
  const visible = { sellerId, order: sellerVisibleOrderWhere };
  const ready = stageFilter('READY');

  const [byStatus, readyCount, todayOrders] = await Promise.all([
    prisma.sellerOrder.groupBy({
      by: ['status'],
      where: {
        ...visible,
        status: { in: [SellerOrderStatus.NEW, SellerOrderStatus.ACCEPTED, SellerOrderStatus.PREPARING] },
      },
      _count: { _all: true },
    }),
    prisma.sellerOrder.count({
      where: {
        sellerId,
        status: ready.status,
        order: { AND: [sellerVisibleOrderWhere, { status: ready.orderStatus! }] },
      },
    }),
    prisma.sellerOrder.count({ where: { ...visible, createdAt: { gte: start, lt: end } } }),
  ]);
  const count = (status: SellerOrderStatus) => byStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    today,
    timezone,
    todayOrders,
    counts: {
      NEW: count(SellerOrderStatus.NEW),
      ACCEPTED: count(SellerOrderStatus.ACCEPTED),
      PREPARING: count(SellerOrderStatus.PREPARING),
      READY: readyCount,
    },
  };
}

export async function getSellerOrderDetail(sellerOrderId: string, scopeSellerId?: string) {
  return loadOwned(sellerOrderId, scopeSellerId);
}

export interface UpdateSellerOrderStatusInput {
  sellerOrderId: string;
  scopeSellerId?: string;
  toStatus: SellerOrderStatus;
  actorUserId: string;
  actorType: ActorType;
  reason?: string | null;
}

export async function updateSellerOrderStatus(input: UpdateSellerOrderStatusInput): Promise<void> {
  // Ownership check BEFORE the transition itself, so a seller acting on
  // someone else's order id sees a plain 404 rather than learning the id is
  // valid but forbidden.
  await loadOwned(input.sellerOrderId, input.scopeSellerId);

  await transitionSellerOrder({
    sellerOrderId: input.sellerOrderId,
    toStatus: input.toStatus,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    reason: input.reason ?? null,
  });
}
