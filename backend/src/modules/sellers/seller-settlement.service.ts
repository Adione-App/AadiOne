/**
 * Seller earnings and settlement.
 *
 * SOURCE OF TRUTH: `SellerOrder.subtotalPaise` and `SellerOrder.
 * commissionPaise` (the latter the exact sum of `OrderItem.commissionPaise`,
 * snapshotted at order-creation time — see order.service.ts's `placeOrder`)
 * are NEVER recomputed here against today's commission rules. A rule
 * changing after an order was placed must not change what that order
 * already owes the seller — same principle as `OrderItem`'s own price
 * snapshot.
 *
 * `subtotalPaise` is the sum of this seller's tax-INCLUSIVE line totals
 * (tax is extracted from the price for the receipt, never added on top —
 * see placeOrder), so it is already this seller's full gross. Adding
 * `taxPaise` to it would double-count tax.
 *
 * ELIGIBILITY — a SellerOrder counts toward a payout only once ALL of:
 *   1. its own status is neither CANCELLED nor REJECTED (still active).
 *   2. the PARENT Order has actually reached DELIVERED — SellerOrderStatus
 *      has no "delivered" state of its own (delivery is platform-wide, one
 *      DeliveryTask per parent Order, never per seller — see DeliveryTask's
 *      own doc comment), so this is the only correct fulfilment signal.
 *   3. the parent's `paymentStatus` is PAID or PARTIALLY_REFUNDED — i.e.
 *      money has actually been collected. For ONLINE orders that status is
 *      only ever set by the capture path (PAYMENT_CONFIRMED transition /
 *      manual UPI confirmation, both of which mark the Payment CAPTURED).
 *      For COD it only becomes PAID in the SAME transition that sets
 *      `deliveredAt` (see order-state.service.ts's `transitionOrder`), so an
 *      undelivered COD order can never be mistaken for a captured online
 *      payment — no `paymentMethod` branch is needed.
 *   4. no live (PENDING/PROCESSING/COMPLETED) refund is attached to this
 *      still-active SellerOrder, and none to its parent Order as a whole
 *      (`Refund.sellerOrderId = null`, a full-order refund). Money that went
 *      back to the customer is never paid out to the seller. Existing flows
 *      only refund a SellerOrder by cancelling it (which (1) excludes), and
 *      payment.service.ts's `refundOrder` refuses a DELIVERED order before
 *      any money moves — so neither hold can fire for a new order; they are
 *      holds (not deductions) for rows created before those guards existed.
 *
 * STABILITY: every input to (1)-(3) is frozen once the parent is DELIVERED
 * — DELIVERED is terminal in the order state machine, `paymentStatus` has
 * no writer for a delivered order, and a SellerOrder can no longer be
 * cancelled once the parent's delivery leg has started (guarded in
 * order-state.service.ts's `transitionSellerOrder`). That is what makes a
 * settlement's period a stable description of exactly which SellerOrders
 * it paid for, with no per-SellerOrder link column.
 *
 * DUPLICATE-SETTLEMENT PROTECTION: `SellerSettlement` is `(sellerId,
 * periodStart, periodEnd)` with a schema-level unique constraint on that
 * triple. Eligibility is filtered by `Order.deliveredAt` falling inside the
 * period, a fixed timestamp, so:
 *   - periods for the same seller may never overlap (checked under a
 *     per-seller row lock, so two concurrent creates cannot both pass);
 *   - a period may never end in the future, or within SETTLEMENT_CLOSE_LAG_MS
 *     of now — otherwise an order delivered AFTER creation but inside the
 *     period would be "covered" without being in the stored totals, and
 *     never paid;
 * which together make "the same SellerOrder settled twice" (and "never
 * settled at all") structurally impossible.
 */

import {
  ErrorCode,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  Permission,
  SellerOrderStatus,
  SettlementStatus,
  type CursorPage,
} from '../../shared';
import * as notificationService from '../notifications/notification.service';
import { sellerVisibleOrderWhere } from '../orders/order-visibility';
import { zonedDayRange, zonedToday } from '../orders/seller-order-views';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction, type DbClient } from '../../infra/db/prisma';

const log = moduleLogger('seller-settlement');

/**
 * A period must end at least this long ago. `transitionOrder` stamps
 * `deliveredAt = new Date()` inside a transaction that may commit up to
 * `runInTransaction`'s 10 s timeout later; a settlement whose period ended
 * "now" could miss a delivery stamped just before its end but committed just
 * after its query. 60 s comfortably exceeds that window.
 */
export const SETTLEMENT_CLOSE_LAG_MS = 60_000;

const PAID_PAYMENT_STATUSES = [OrderPaymentStatus.PAID, OrderPaymentStatus.PARTIALLY_REFUNDED] as const;
const HOLDING_REFUND_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED'] as const;

/* -------------------------------------------------------------------------- */
/* Per-SellerOrder earnings row                                              */
/* -------------------------------------------------------------------------- */

export type IneligibleReason =
  | 'CANCELLED'
  | 'NOT_DELIVERED'
  | 'NOT_PAID'
  | 'REFUND_ON_ACTIVE_ORDER'
  | 'ORDER_REFUNDED';

export interface SellerOrderEarningsRow {
  sellerOrderId: string;
  orderId: string;
  orderNumber: string;
  paymentMethod: string;
  status: SellerOrderStatus;
  deliveredAt: string | null;
  /** SellerOrder.subtotalPaise — this seller's tax-inclusive share of the items. */
  grossPaise: number;
  /** Display-only weighted average; never used in any money calculation. */
  commissionBp: number;
  /** SellerOrder.commissionPaise snapshot (= sum of OrderItem.commissionPaise). */
  commissionPaise: number;
  /** grossPaise - commissionPaise, before cancellation/refund. */
  sellerPayablePaise: number;
  /** grossPaise when cancelled/rejected, else 0. */
  cancelledPaise: number;
  /** COMPLETED refunds issued against this SellerOrder specifically. */
  refundedPaise: number;
  /** What this SellerOrder actually contributes to a payout: 0 when
   * cancelled/rejected, else sellerPayablePaise. */
  finalPayablePaise: number;
  eligibleForSettlement: boolean;
  ineligibleReason: IneligibleReason | null;
}

interface SellerOrderForEarnings {
  id: string;
  orderId: string;
  status: SellerOrderStatus;
  subtotalPaise: number;
  commissionBp: number;
  commissionPaise: number;
  order: {
    orderNumber: string;
    deliveredAt: Date | null;
    status: OrderStatus;
    paymentStatus: OrderPaymentStatus;
    paymentMethod: string;
    /** Full-order refunds only (sellerOrderId = null). */
    refunds: { amountPaise: number; status: string }[];
  };
  refunds: { amountPaise: number; status: string }[];
}

function toEarningsRow(sellerOrder: SellerOrderForEarnings): SellerOrderEarningsRow {
  const cancelled =
    sellerOrder.status === SellerOrderStatus.CANCELLED || sellerOrder.status === SellerOrderStatus.REJECTED;
  const grossPaise = sellerOrder.subtotalPaise;
  const sellerPayablePaise = grossPaise - sellerOrder.commissionPaise;
  const refundedPaise = sellerOrder.refunds
    .filter((r) => r.status === 'COMPLETED')
    .reduce((sum, r) => sum + r.amountPaise, 0);
  const isLive = (r: { status: string }) => (HOLDING_REFUND_STATUSES as readonly string[]).includes(r.status);
  const holdingRefund = sellerOrder.refunds.some(isLive);
  const orderRefunded = sellerOrder.order.refunds.some(isLive);

  let ineligibleReason: IneligibleReason | null = null;
  if (cancelled) ineligibleReason = 'CANCELLED';
  else if (sellerOrder.order.status !== OrderStatus.DELIVERED) ineligibleReason = 'NOT_DELIVERED';
  else if (!(PAID_PAYMENT_STATUSES as readonly OrderPaymentStatus[]).includes(sellerOrder.order.paymentStatus))
    ineligibleReason = 'NOT_PAID';
  else if (holdingRefund) ineligibleReason = 'REFUND_ON_ACTIVE_ORDER';
  else if (orderRefunded) ineligibleReason = 'ORDER_REFUNDED';

  return {
    sellerOrderId: sellerOrder.id,
    orderId: sellerOrder.orderId,
    orderNumber: sellerOrder.order.orderNumber,
    paymentMethod: sellerOrder.order.paymentMethod,
    status: sellerOrder.status,
    deliveredAt: sellerOrder.order.deliveredAt?.toISOString() ?? null,
    grossPaise,
    commissionBp: sellerOrder.commissionBp,
    commissionPaise: sellerOrder.commissionPaise,
    sellerPayablePaise,
    cancelledPaise: cancelled ? grossPaise : 0,
    refundedPaise,
    finalPayablePaise: cancelled ? 0 : sellerPayablePaise,
    eligibleForSettlement: ineligibleReason === null,
    ineligibleReason,
  };
}

const EARNINGS_SELECT = {
  id: true,
  orderId: true,
  sellerId: true,
  status: true,
  subtotalPaise: true,
  commissionBp: true,
  commissionPaise: true,
  order: {
    select: {
      orderNumber: true,
      deliveredAt: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      refunds: { where: { sellerOrderId: null }, select: { amountPaise: true, status: true } },
    },
  },
  refunds: { select: { amountPaise: true, status: true } },
} as const;

async function loadSellerOrThrow(sellerId: string, scopeSellerId?: string) {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller || (scopeSellerId && seller.id !== scopeSellerId)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  }
  return seller;
}

type Range = { start: Date; end: Date };

/** Periods are half-open on the left: (periodStart, periodEnd]. */
function inRange(deliveredAt: string | null, range: Range): boolean {
  if (!deliveredAt) return false;
  const t = new Date(deliveredAt).getTime();
  return t > range.start.getTime() && t <= range.end.getTime();
}

/* -------------------------------------------------------------------------- */
/* Earnings summary — "my earnings" / admin's per-seller + cross-seller view  */
/* -------------------------------------------------------------------------- */

export interface SellerEarningsSummaryDto {
  sellerId: string;
  sellerName: string;
  settlementCycleHours: number;
  /** Sum of grossPaise over active (non-cancelled/rejected) SellerOrders. */
  grossSalesPaise: number;
  /** Sum of commissionPaise snapshots over the same orders. */
  commissionPaise: number;
  /** Gross of cancelled/rejected SellerOrders — never payable. */
  cancelledAmountPaise: number;
  /** COMPLETED refunds issued against this seller's SellerOrders. */
  refundedAmountPaise: number;
  /** grossSalesPaise - commissionPaise: everything this seller has earned
   * on orders still standing. Always equals
   * notYetEligible + pendingSettlement + inSettlement + settled. */
  netPayablePaise: number;
  /** Active but not yet delivered/paid (or held) — not settleable yet. */
  notYetEligiblePaise: number;
  /** Eligible and not yet inside any settlement's period. */
  pendingSettlementPaise: number;
  /** Inside a settlement that is PENDING/PROCESSING/FAILED — not paid yet. */
  inSettlementPaise: number;
  /** Sum of every PAID settlement's netPayablePaise. */
  settledAmountPaise: number;
  lastSettlementPeriodEnd: string | null;
  /** lastSettlementPeriodEnd + settlementCycleHours; null before the first settlement. */
  nextSettlementDueAt: string | null;
}

function summarise(
  seller: { id: string; name: string; settlementCycleHours: number },
  rows: SellerOrderEarningsRow[],
  settlements: { periodStart: Date; periodEnd: Date; status: SettlementStatus; netPayablePaise: number }[],
): SellerEarningsSummaryDto {
  const active = rows.filter((r) => r.cancelledPaise === 0);
  const grossSalesPaise = active.reduce((s, r) => s + r.grossPaise, 0);
  const commissionPaise = active.reduce((s, r) => s + r.commissionPaise, 0);

  let notYetEligiblePaise = 0;
  let pendingSettlementPaise = 0;
  let inSettlementPaise = 0;
  let settledFromRows = 0;
  for (const row of active) {
    if (!row.eligibleForSettlement) {
      notYetEligiblePaise += row.finalPayablePaise;
      continue;
    }
    const covering = settlements.find((s) => inRange(row.deliveredAt, { start: s.periodStart, end: s.periodEnd }));
    if (!covering) pendingSettlementPaise += row.finalPayablePaise;
    else if (covering.status === SettlementStatus.PAID) settledFromRows += row.finalPayablePaise;
    else inSettlementPaise += row.finalPayablePaise;
  }

  const settledAmountPaise = settlements
    .filter((s) => s.status === SettlementStatus.PAID)
    .reduce((s, row) => s + row.netPayablePaise, 0);
  if (settledAmountPaise !== settledFromRows) {
    // Stored settlement totals and the live SellerOrders they cover must
    // agree (see this module's STABILITY note). A mismatch means some
    // settled order's inputs changed after the fact — loud, never silent.
    log.error(
      { sellerId: seller.id, settledAmountPaise, settledFromRows },
      'settled total disagrees with the SellerOrders its periods cover',
    );
  }

  const last = settlements.reduce<Date | null>(
    (latest, s) => (!latest || s.periodEnd > latest ? s.periodEnd : latest),
    null,
  );

  return {
    sellerId: seller.id,
    sellerName: seller.name,
    settlementCycleHours: seller.settlementCycleHours,
    grossSalesPaise,
    commissionPaise,
    cancelledAmountPaise: rows.reduce((s, r) => s + r.cancelledPaise, 0),
    refundedAmountPaise: rows.reduce((s, r) => s + r.refundedPaise, 0),
    netPayablePaise: grossSalesPaise - commissionPaise,
    notYetEligiblePaise,
    pendingSettlementPaise,
    inSettlementPaise,
    settledAmountPaise,
    lastSettlementPeriodEnd: last?.toISOString() ?? null,
    nextSettlementDueAt: last
      ? new Date(last.getTime() + seller.settlementCycleHours * 3_600_000).toISOString()
      : null,
  };
}

export async function getEarningsSummary(
  sellerId: string,
  scopeSellerId: string | undefined,
): Promise<SellerEarningsSummaryDto> {
  const seller = await loadSellerOrThrow(sellerId, scopeSellerId);
  const [sellerOrders, settlements] = await Promise.all([
    // Only placed orders are sales: an unpaid, payment-failed or
    // cancelled-before-payment order never earned anything (order-visibility.ts).
    prisma.sellerOrder.findMany({ where: { sellerId, order: sellerVisibleOrderWhere }, select: EARNINGS_SELECT }),
    prisma.sellerSettlement.findMany({ where: { sellerId } }),
  ]);
  return summarise(seller, sellerOrders.map(toEarningsRow), settlements);
}

export interface SellerTodayEarningsDto {
  /** The seller's calendar day ("YYYY-MM-DD") these figures cover. */
  today: string;
  timezone: string;
  /** Orders placed today that are still standing (not cancelled/rejected). */
  orderCount: number;
  grossSalesPaise: number;
  commissionPaise: number;
  /** grossSalesPaise - commissionPaise — the same "earnings" as the summary. */
  netPayablePaise: number;
}

/**
 * Today's sales — the summary's own definitions (toEarningsRow + totals over
 * orders that are not cancelled/rejected), limited to orders placed today
 * in the seller's timezone. Nothing here is a new money rule.
 */
export async function getTodayEarnings(sellerId: string): Promise<SellerTodayEarningsDto> {
  const seller = await loadSellerOrThrow(sellerId, sellerId);
  const today = zonedToday(seller.timezone);
  const { start, end } = zonedDayRange(today, seller.timezone);
  const sellerOrders = await prisma.sellerOrder.findMany({
    where: { sellerId, order: sellerVisibleOrderWhere, createdAt: { gte: start, lt: end } },
    select: EARNINGS_SELECT,
  });
  const active = sellerOrders.map(toEarningsRow).filter((row) => row.cancelledPaise === 0);
  return { today, timezone: seller.timezone, orderCount: active.length, ...totals(active) };
}

/** Admin's cross-seller view: one summary per seller that has any orders
 * or settlements, highest pending amount first. */
export async function listEarningsSummaries(options: { sellerId?: string }): Promise<SellerEarningsSummaryDto[]> {
  const sellerFilter = options.sellerId ? { sellerId: options.sellerId } : {};
  const [sellerOrders, settlements] = await Promise.all([
    prisma.sellerOrder.findMany({ where: { ...sellerFilter, order: sellerVisibleOrderWhere }, select: EARNINGS_SELECT }),
    prisma.sellerSettlement.findMany({ where: sellerFilter }),
  ]);
  const sellerIds = [...new Set([...sellerOrders.map((so) => so.sellerId), ...settlements.map((s) => s.sellerId)])];
  const sellers = await prisma.seller.findMany({
    where: { id: { in: sellerIds } },
    select: { id: true, name: true, settlementCycleHours: true },
  });

  return sellers
    .map((seller) =>
      summarise(
        seller,
        sellerOrders.filter((so) => so.sellerId === seller.id).map(toEarningsRow),
        settlements.filter((s) => s.sellerId === seller.id),
      ),
    )
    .sort((a, b) => b.pendingSettlementPaise - a.pendingSettlementPaise);
}

/* -------------------------------------------------------------------------- */
/* Period resolution + eligible rows                                         */
/* -------------------------------------------------------------------------- */

export interface SettlementPeriodInput {
  periodStart?: string;
  periodEnd?: string;
}

function latestAllowedPeriodEnd(): Date {
  return new Date(Date.now() - SETTLEMENT_CLOSE_LAG_MS);
}

/**
 * Default period: from the end of this seller's last settlement (or, before
 * the first one, the seller's own creation — so nothing delivered earlier is
 * ever skipped) up to now minus SETTLEMENT_CLOSE_LAG_MS. Explicit bounds are
 * an admin override, validated the same way.
 */
async function resolvePeriod(
  db: DbClient,
  seller: { id: string; createdAt: Date },
  input: SettlementPeriodInput,
): Promise<{ periodStart: Date; periodEnd: Date; lastPeriodEnd: Date | null }> {
  const lastSettlement = await db.sellerSettlement.findFirst({
    where: { sellerId: seller.id },
    orderBy: { periodEnd: 'desc' },
  });
  const lastPeriodEnd = lastSettlement?.periodEnd ?? null;

  const periodEnd = input.periodEnd ? new Date(input.periodEnd) : latestAllowedPeriodEnd();
  const periodStart = input.periodStart ? new Date(input.periodStart) : (lastPeriodEnd ?? seller.createdAt);

  if (periodEnd > latestAllowedPeriodEnd()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `periodEnd must be at least ${SETTLEMENT_CLOSE_LAG_MS / 1000} seconds in the past.`,
    });
  }
  if (periodStart >= periodEnd) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'periodStart must be before periodEnd.' });
  }
  return { periodStart, periodEnd, lastPeriodEnd };
}

async function findEligibleRows(
  db: DbClient,
  sellerId: string,
  range: Range,
): Promise<SellerOrderEarningsRow[]> {
  const sellerOrders = await db.sellerOrder.findMany({
    where: {
      sellerId,
      status: { notIn: [SellerOrderStatus.CANCELLED, SellerOrderStatus.REJECTED] },
      order: {
        status: OrderStatus.DELIVERED,
        paymentStatus: { in: [...PAID_PAYMENT_STATUSES] },
        deliveredAt: { gt: range.start, lte: range.end },
      },
    },
    select: EARNINGS_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  return sellerOrders.map(toEarningsRow).filter((r) => r.eligibleForSettlement);
}

function totals(rows: SellerOrderEarningsRow[]) {
  const grossSalesPaise = rows.reduce((s, r) => s + r.grossPaise, 0);
  const commissionPaise = rows.reduce((s, r) => s + r.commissionPaise, 0);
  return { grossSalesPaise, commissionPaise, netPayablePaise: grossSalesPaise - commissionPaise };
}

/* -------------------------------------------------------------------------- */
/* Eligible-orders preview (admin, before creating a settlement)             */
/* -------------------------------------------------------------------------- */

export interface EligiblePreview {
  sellerId: string;
  periodStart: string;
  periodEnd: string;
  /** True when this period overlaps an existing settlement — creating it
   * would be refused; rows already covered are left out below. */
  overlapsExistingSettlement: boolean;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  sellerOrders: SellerOrderEarningsRow[];
}

export async function previewEligibleSettlement(
  sellerId: string,
  input: SettlementPeriodInput,
): Promise<EligiblePreview> {
  const seller = await loadSellerOrThrow(sellerId);
  const { periodStart, periodEnd } = await resolvePeriod(prisma, seller, input);

  const [rows, overlapping] = await Promise.all([
    findEligibleRows(prisma, sellerId, { start: periodStart, end: periodEnd }),
    prisma.sellerSettlement.findMany({
      where: { sellerId, periodStart: { lt: periodEnd }, periodEnd: { gt: periodStart } },
    }),
  ]);
  const uncovered = rows.filter(
    (r) => !overlapping.some((s) => inRange(r.deliveredAt, { start: s.periodStart, end: s.periodEnd })),
  );

  return {
    sellerId,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    overlapsExistingSettlement: overlapping.length > 0,
    ...totals(uncovered),
    sellerOrders: uncovered,
  };
}

/* -------------------------------------------------------------------------- */
/* Create a settlement                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateSettlementResult {
  created: boolean;
  settlement: SettlementDetailDto;
}

/**
 * Creates a PENDING settlement for every eligible SellerOrder delivered in
 * the period. Safe to retry:
 *   - the exact same explicit period again -> the existing settlement is
 *     returned (`created: false`), nothing new is written;
 *   - no body again (default period) -> refused until the seller's
 *     `settlementCycleHours` has elapsed since the last period's end, so a
 *     double-click cannot open a tiny second settlement;
 *   - any other overlapping period -> 409.
 * The overlap check and the insert run under a per-seller row lock, so two
 * concurrent requests serialise instead of both passing the check.
 */
export async function createSettlement(
  sellerId: string,
  input: SettlementPeriodInput,
): Promise<CreateSettlementResult> {
  const result = await runInTransaction(async (tx): Promise<CreateSettlementResult> => {
    await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${sellerId}::uuid FOR UPDATE`;
    const seller = await tx.seller.findUnique({ where: { id: sellerId } });
    if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

    const explicit = Boolean(input.periodStart || input.periodEnd);
    const { periodStart, periodEnd, lastPeriodEnd } = await resolvePeriod(tx, seller, input);

    if (!explicit && lastPeriodEnd) {
      const dueAt = new Date(lastPeriodEnd.getTime() + seller.settlementCycleHours * 3_600_000);
      if (periodEnd < dueAt) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          status: 409,
          message: `The next settlement for this seller is not due until ${dueAt.toISOString()}.`,
          internalMessage: `settlement cycle ${seller.settlementCycleHours}h not elapsed since ${lastPeriodEnd.toISOString()}`,
        });
      }
    }

    const overlapping = await tx.sellerSettlement.findFirst({
      where: { sellerId, periodStart: { lt: periodEnd }, periodEnd: { gt: periodStart } },
    });
    if (overlapping) {
      if (
        overlapping.periodStart.getTime() === periodStart.getTime() &&
        overlapping.periodEnd.getTime() === periodEnd.getTime()
      ) {
        // Idempotent replay of the same request.
        return { created: false, settlement: await buildDetail(tx, overlapping, seller.name) };
      }
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        status: 409,
        message: 'This period overlaps an existing settlement for this seller.',
        internalMessage: `overlaps settlement ${overlapping.id} (${overlapping.periodStart.toISOString()}..${overlapping.periodEnd.toISOString()})`,
      });
    }

    const rows = await findEligibleRows(tx, sellerId, { start: periodStart, end: periodEnd });
    if (rows.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'No settlement-eligible seller orders were found in this period.',
      });
    }

    const settlement = await tx.sellerSettlement.create({
      data: {
        sellerId,
        periodStart,
        periodEnd,
        ...totals(rows),
        status: SettlementStatus.PENDING,
      },
    });
    log.info(
      { settlementId: settlement.id, sellerId, sellerOrders: rows.length, netPayablePaise: settlement.netPayablePaise },
      'settlement created',
    );
    return { created: true, settlement: toSettlementDetail(settlement, seller.name, rows) };
  });

  // After commit, and only for a NEW settlement (an idempotent replay
  // returns created: false and announces nothing).
  if (result.created) {
    await notificationService.notifySeller(sellerId, {
      type: NotificationType.SELLER_SETTLEMENT_CREATED,
      dedupeKey: `settlement:${result.settlement.id}:created`,
      context: { amountPaise: result.settlement.netPayablePaise },
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                     */
/* -------------------------------------------------------------------------- */

interface SettlementRow {
  id: string;
  sellerId: string;
  periodStart: Date;
  periodEnd: Date;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  status: SettlementStatus;
  paidAt: Date | null;
  createdAt: Date;
}

function toSettlementDto(settlement: SettlementRow, sellerName: string) {
  return {
    id: settlement.id,
    sellerId: settlement.sellerId,
    sellerName,
    periodStart: settlement.periodStart.toISOString(),
    periodEnd: settlement.periodEnd.toISOString(),
    grossSalesPaise: settlement.grossSalesPaise,
    commissionPaise: settlement.commissionPaise,
    netPayablePaise: settlement.netPayablePaise,
    status: settlement.status,
    paidAt: settlement.paidAt?.toISOString() ?? null,
    createdAt: settlement.createdAt.toISOString(),
  };
}

export type SettlementDetailDto = ReturnType<typeof toSettlementDto> & { sellerOrders: SellerOrderEarningsRow[] };

function toSettlementDetail(
  settlement: SettlementRow,
  sellerName: string,
  sellerOrders: SellerOrderEarningsRow[],
): SettlementDetailDto {
  return { ...toSettlementDto(settlement, sellerName), sellerOrders };
}

async function buildDetail(db: DbClient, settlement: SettlementRow, sellerName: string) {
  const rows = await findEligibleRows(db, settlement.sellerId, {
    start: settlement.periodStart,
    end: settlement.periodEnd,
  });
  const live = totals(rows);
  if (live.netPayablePaise !== settlement.netPayablePaise || live.grossSalesPaise !== settlement.grossSalesPaise) {
    log.error(
      { settlementId: settlement.id, stored: settlement.netPayablePaise, live: live.netPayablePaise },
      'settlement totals disagree with the SellerOrders its period covers',
    );
  }
  return toSettlementDetail(settlement, sellerName, rows);
}

export async function getSettlementDetail(settlementId: string, scopeSellerId?: string) {
  const settlement = await prisma.sellerSettlement.findUnique({
    where: { id: settlementId },
    include: { seller: { select: { name: true } } },
  });
  // Same non-revealing convention as SellerOrder/onboarding: another
  // seller's settlement is indistinguishable from one that doesn't exist.
  if (!settlement || (scopeSellerId && settlement.sellerId !== scopeSellerId)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Settlement not found.' });
  }
  return buildDetail(prisma, settlement, settlement.seller.name);
}

export async function listSettlements(
  scopeSellerId: string | undefined,
  options: { sellerId?: string; status?: SettlementStatus; cursor?: string | null; limit: number },
): Promise<CursorPage<ReturnType<typeof toSettlementDto>>> {
  const sellerId = scopeSellerId ?? options.sellerId;
  const settlements = await prisma.sellerSettlement.findMany({
    where: {
      ...(sellerId ? { sellerId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    include: { seller: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: options.limit + 1,
  });

  const hasMore = settlements.length > options.limit;
  const page = hasMore ? settlements.slice(0, options.limit) : settlements;
  const last = page[page.length - 1];

  return {
    items: page.map((s) => toSettlementDto(s, s.seller.name)),
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Status transitions — PENDING -> PROCESSING -> PAID, or -> FAILED          */
/* -------------------------------------------------------------------------- */

const SETTLEMENT_NOTIFICATION_FOR: Partial<Record<SettlementStatus, NotificationType>> = {
  [SettlementStatus.PROCESSING]: NotificationType.SELLER_SETTLEMENT_PROCESSING,
  [SettlementStatus.PAID]: NotificationType.SELLER_SETTLEMENT_PAID,
  [SettlementStatus.FAILED]: NotificationType.SELLER_SETTLEMENT_FAILED,
};

/**
 * Called only when THIS request's compare-and-set actually moved the status,
 * so a repeated or concurrent "mark PAID" announces once. The key carries the
 * row's updatedAt: a settlement retried FAILED -> PENDING -> PROCESSING again
 * is a genuinely new event, not a duplicate.
 */
async function announceSettlementStatus(settlementId: string, status: SettlementStatus): Promise<void> {
  const type = SETTLEMENT_NOTIFICATION_FOR[status];
  if (!type) return;
  const s = await prisma.sellerSettlement.findUniqueOrThrow({
    where: { id: settlementId },
    select: { sellerId: true, netPayablePaise: true, updatedAt: true, seller: { select: { name: true } } },
  });
  const dedupeKey = `settlement:${settlementId}:${status}:${s.updatedAt.getTime()}`;
  await notificationService.notifySeller(s.sellerId, { type, dedupeKey, context: { amountPaise: s.netPayablePaise } });
  if (status === SettlementStatus.FAILED) {
    await notificationService.notifyAdmins(Permission.SETTLEMENT_MANAGE, {
      type: NotificationType.ADMIN_SETTLEMENT_FAILED,
      dedupeKey,
      context: { amountPaise: s.netPayablePaise, sellerName: s.seller.name },
    });
  }
}

const ALLOWED_SETTLEMENT_TRANSITIONS: Readonly<Record<SettlementStatus, readonly SettlementStatus[]>> = {
  [SettlementStatus.PENDING]: [SettlementStatus.PROCESSING, SettlementStatus.FAILED],
  [SettlementStatus.PROCESSING]: [SettlementStatus.PAID, SettlementStatus.FAILED],
  [SettlementStatus.PAID]: [],
  // A failed payout is retried by re-queueing the SAME settlement — its
  // period still covers those orders, so a new one could not be created.
  [SettlementStatus.FAILED]: [SettlementStatus.PENDING],
};

export async function updateSettlementStatus(settlementId: string, toStatus: SettlementStatus) {
  const settlement = await prisma.sellerSettlement.findUnique({ where: { id: settlementId } });
  if (!settlement) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Settlement not found.' });

  if (settlement.status === toStatus) {
    // Idempotent no-op — a retried "mark as paid" must not error, and must
    // not stamp `paidAt` a second time.
    return getSettlementDetail(settlementId);
  }

  if (!ALLOWED_SETTLEMENT_TRANSITIONS[settlement.status].includes(toStatus)) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: `A settlement cannot move from ${settlement.status} to ${toStatus}.`,
      internalMessage: `illegal settlement transition ${settlement.status} -> ${toStatus} on ${settlementId}`,
    });
  }

  // Compare-and-set on the status we validated against: two concurrent
  // "mark PAID" requests cannot both apply (and double-stamp paidAt).
  const { count } = await prisma.sellerSettlement.updateMany({
    where: { id: settlementId, status: settlement.status },
    data: {
      status: toStatus,
      ...(toStatus === SettlementStatus.PAID ? { paidAt: new Date() } : {}),
      ...(toStatus === SettlementStatus.PENDING ? { paidAt: null } : {}),
    },
  });

  if (count === 0) {
    const current = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    if (current.status !== toStatus) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: `This settlement changed to ${current.status} while you were updating it.`,
        internalMessage: `lost settlement status race on ${settlementId}: expected ${settlement.status}, found ${current.status}`,
      });
    }
  } else {
    log.info({ settlementId, from: settlement.status, to: toStatus }, 'settlement status changed');
    await announceSettlementStatus(settlementId, toStatus);
  }

  return getSettlementDetail(settlementId);
}
