/**
 * Admin Financial Overview — read-only analytics over the money already
 * recorded on orders, refunds and seller deductions. Nothing here changes a
 * commission, fee, payment, refund or settlement; it only adds them up.
 *
 * WHICH ORDERS COUNT (the "delivered cohort")
 *   Delivered orders whose payment is recorded (PAID, PARTIALLY_REFUNDED, or
 *   REFUNDED after delivery) — the same orders seller settlement pays for
 *   (seller-settlement.service.ts › toEarningsRow). Dated by `deliveredAt` in
 *   the marketplace timezone, like the Dashboard's revenue. Cancelled, unpaid,
 *   payment-failed and still-in-progress orders are never revenue; they are
 *   reported separately under "pipeline".
 *
 * PER ORDER (snapshots written at checkout, never recomputed)
 *   collected        Order.currentPayablePaise — what the customer paid for
 *                    what was delivered (checkout total minus any seller
 *                    portion cancelled before delivery)
 *                  = Σ active portions (subtotal − coupon share) + delivery fee + platform fee
 *   seller price     Σ active SellerOrder.subtotalPaise (tax-inclusive)
 *   coupon           Σ active SellerOrder.couponDiscountPaise — Aadione-funded,
 *                    never taken from the seller (order-financials.service.ts)
 *   commission       Σ active SellerOrder.commissionPaise (= Σ OrderItem.commissionPaise)
 *   seller payable   seller price − commission
 *   delivery / platform fee   Order.deliveryFeePaise / platformFeePaise (free delivery = 0)
 *
 * AFTER DELIVERY (refund requests — the only refunds a delivered order can get)
 *   refunded         COMPLETED Cashfree refunds and CONFIRMED manual (COD)
 *                    payouts of post-delivery refund groups, per seller portion
 *   deductions       SellerDeduction.amountPaise — the seller's net share taken
 *                    back; commissionReversedPaise / couponReversedPaise — what
 *                    Aadione gives up / no longer bears (refund-accounting.ts)
 *   Refunds are shown against the order they belong to (so "Last month" means
 *   orders delivered last month, with every refund on them to date).
 *
 * TOTALS
 *   Aadione earnings (gross) = delivery fees + platform fees + commission
 *   Aadione earnings (net)   = gross − fee refunds − commission reversed
 *   Seller net               = seller payable − deductions
 *   Net collected            = collected − refunds after delivery
 *   and, to the paisa:
 *   Net collected = seller net + Aadione net − (coupon − coupon reversed)
 *                   − refund cost beyond reversals − unclassified refunds
 *
 * SELLER FILTER
 *   A seller's own portions only. Order-level fees go to a seller only when it
 *   is the order's ONLY active seller; fees of multi-seller orders are shown as
 *   "shared — not allocated", never split or duplicated.
 */

import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { ConfigKey, ErrorCode, OrderPaymentStatus, OrderStatus } from '../../shared';
import * as configService from '../configuration/configuration.service';
import { getBusinessInfo } from '../content/info-page.service';
import type { DocumentIssuer } from '../../infra/pdf/branded-pdf';
import {
  monthStart,
  PeriodError,
  resolvePeriod,
  weekStart,
  type FinancePeriod,
  type ResolvedPeriod,
} from './finance-period';

/** Payment states of a delivered order whose money was collected (seller settlement's rule). */
const COLLECTED_PAYMENT_STATUSES: string[] = [
  OrderPaymentStatus.PAID,
  OrderPaymentStatus.PARTIALLY_REFUNDED,
  OrderPaymentStatus.REFUNDED,
];
/** Placed and still on its way — not revenue yet. */
const IN_PROGRESS_STATUSES: string[] = [
  OrderStatus.PAYMENT_CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.PARTIALLY_CANCELLED,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.PICKED_UP,
  OrderStatus.OUT_FOR_DELIVERY,
];

/** Orders listed in one PDF at most; the totals always cover every order. */
export const PDF_ORDER_LIMIT = 2000;

export interface FinanceFilter {
  period: ResolvedPeriod;
  sellerId: string | null;
  timeZone: string;
}

/* -------------------------------------------------------------------------- */
/* Filter                                                                     */
/* -------------------------------------------------------------------------- */

async function reportingTimezone(): Promise<string> {
  return (await configService.get(ConfigKey.STORE_TIMEZONE)) || 'Asia/Kolkata';
}

export async function resolveFilter(input: { period: FinancePeriod; from?: string; to?: string; sellerId?: string }, now = new Date()): Promise<FinanceFilter> {
  const timeZone = await reportingTimezone();
  let period: ResolvedPeriod;
  try {
    period = resolvePeriod(input.period, { from: input.from, to: input.to }, now, timeZone);
  } catch (error) {
    if (error instanceof PeriodError) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: error.message });
    throw error;
  }
  if (input.sellerId) {
    const seller = await prisma.seller.findUnique({ where: { id: input.sellerId }, select: { id: true } });
    if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  }
  return { period, sellerId: input.sellerId ?? null, timeZone };
}

/* -------------------------------------------------------------------------- */
/* SQL — one fact table for the overview, the order list and the PDF          */
/* -------------------------------------------------------------------------- */

const rangeOn = (column: Prisma.Sql, period: ResolvedPeriod) =>
  Prisma.sql`${period.from ? Prisma.sql`AND ${column} >= ${period.from}` : Prisma.empty}
             ${period.to ? Prisma.sql`AND ${column} < ${period.to}` : Prisma.empty}`;

/**
 * `scoped_orders`: one row per delivered-cohort order, every figure scoped to
 * the selected seller (all sellers when none). Integer paise (bigint).
 *
 * Built so the plan cannot degrade with table size or stale statistics: each
 * seller portion is read once (joined to its order by primary key), its own
 * refunds are looked up by the indexed `seller_order_id`, order-level shape
 * comes from window functions rather than self-joins, and every stage is
 * MATERIALIZED (computed once, never re-run per row of another stage).
 */
function factsCte(filter: FinanceFilter): Prisma.Sql {
  const seller = filter.sellerId;
  const scoped = seller ? Prisma.sql`p.seller_id = ${seller}::uuid` : Prisma.sql`TRUE`;
  // The order's fees belong to this view: always for all sellers; for one
  // seller only when it is the order's sole active seller.
  // (A multi-seller order has no sole seller: NULL, so COALESCE makes it FALSE, never NULL.)
  const feesHere = seller ? Prisma.sql`COALESCE(f.sole_seller_id = ${seller}::uuid, FALSE)` : Prisma.sql`TRUE`;
  const ACTIVE = Prisma.sql`so.status::text NOT IN ('CANCELLED', 'REJECTED')`;
  return Prisma.sql`
  WITH
  -- Manual (COD) refunds after delivery, per seller portion: confirmed, or still to be paid.
  manual_lines AS MATERIALIZED (
    SELECT (line->>'sellerOrderId')::uuid AS portion_id,
           SUM(CASE WHEN m.status = 'CONFIRMED' THEN (line->>'amountPaise')::bigint ELSE 0 END)::bigint AS done,
           SUM(CASE WHEN m.status IS DISTINCT FROM 'CONFIRMED' AND g.status <> 'FAILED' THEN (line->>'amountPaise')::bigint ELSE 0 END)::bigint AS pending
    FROM refund_groups g
    LEFT JOIN manual_refund_payouts m ON m.group_id = g.id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(g.allocation) = 'array' THEN g.allocation ELSE '[]'::jsonb END) AS line
    WHERE g.channel = 'MANUAL' AND g.post_delivery AND line ? 'sellerOrderId'
    GROUP BY 1
  ),
  deductions AS MATERIALIZED (
    SELECT d.seller_order_id AS portion_id,
           SUM(d.amount_paise)::bigint AS amount,
           SUM(d.commission_reversed_paise)::bigint AS commission_reversed,
           SUM(d.coupon_reversed_paise)::bigint AS coupon_reversed
    FROM seller_deductions d GROUP BY d.seller_order_id
  ),
  portion_facts AS MATERIALIZED (
    SELECT so.id, so.order_id, so.seller_id,
           (${ACTIVE}) AS active,
           so.subtotal_paise::bigint AS subtotal,
           so.coupon_discount_paise::bigint AS coupon,
           so.commission_paise::bigint AS commission,
           o.order_number, o.delivered_at, o."paymentMethod"::text AS method,
           to_char(o.delivered_at AT TIME ZONE ${filter.timeZone}, 'YYYY-MM-DD') AS day,
           o.current_payable_paise::bigint AS payable,
           o.delivery_fee_paise::bigint AS order_delivery,
           o.platform_fee_paise::bigint AS order_platform,
           COUNT(*) FILTER (WHERE ${ACTIVE}) OVER (PARTITION BY so.order_id) AS active_sellers,
           MAX(so.seller_id::text) FILTER (WHERE ${ACTIVE}) OVER (PARTITION BY so.order_id) AS an_active_seller,
           -- Money returned AFTER delivery for this portion: Cashfree refunds
           -- (completed / still pending) plus manual COD payouts.
           (COALESCE(rf.done, 0) + COALESCE(ml.done, 0))::bigint AS refunded,
           (COALESCE(rf.pending, 0) + COALESCE(ml.pending, 0))::bigint AS refund_pending,
           COALESCE(dd.amount, 0)::bigint AS deducted,
           COALESCE(dd.commission_reversed, 0)::bigint AS commission_reversed,
           COALESCE(dd.coupon_reversed, 0)::bigint AS coupon_reversed,
           COALESCE(uc.amount, 0)::bigint AS unclassified
    FROM orders o
    JOIN seller_orders so ON so.order_id = o.id
    LEFT JOIN LATERAL (
      SELECT SUM(r.amount_paise) FILTER (WHERE r.status = 'COMPLETED')::bigint AS done,
             SUM(r.amount_paise) FILTER (WHERE r.status IN ('PENDING', 'PROCESSING'))::bigint AS pending
      FROM refunds r JOIN refund_groups g ON g.id = r.group_id
      WHERE r.seller_order_id = so.id AND g.post_delivery
    ) rf ON TRUE
    -- Completed refunds of a STILL-ACTIVE portion that are not a refund
    -- request (a cancelled portion's refund is expected: currentPayable
    -- already excludes its money): legacy / unexplained — reported, never guessed.
    LEFT JOIN LATERAL (
      SELECT SUM(r.amount_paise)::bigint AS amount
      FROM refunds r
      JOIN payments pay ON pay.id = r.payment_id
      LEFT JOIN refund_groups g ON g.id = r.group_id
      WHERE r.seller_order_id = so.id AND ${ACTIVE}
        AND r.status = 'COMPLETED'
        AND r.component_type IS DISTINCT FROM 'ORPHAN_PAYMENT'
        AND pay.failure_code IS DISTINCT FROM 'ORPHAN_CAPTURE'
        AND g.post_delivery IS NOT TRUE
    ) uc ON TRUE
    LEFT JOIN manual_lines ml ON ml.portion_id = so.id
    LEFT JOIN deductions dd ON dd.portion_id = so.id
    WHERE o.status = 'DELIVERED'
      AND o.payment_status::text = ANY(${COLLECTED_PAYMENT_STATUSES})
      AND o.delivered_at IS NOT NULL
      ${rangeOn(Prisma.sql`o.delivered_at`, filter.period)}
  ),
  -- Completed order-level refunds (no seller portion) on a delivered order:
  -- none are expected (fees are refunded only for whole cancellations) — unclassified.
  order_unclassified AS MATERIALIZED (
    SELECT r.order_id, SUM(r.amount_paise)::bigint AS amount
    FROM refunds r
    JOIN payments pay ON pay.id = r.payment_id
    WHERE r.seller_order_id IS NULL
      AND r.status = 'COMPLETED'
      AND r.component_type IS DISTINCT FROM 'ORPHAN_PAYMENT'
      AND pay.failure_code IS DISTINCT FROM 'ORPHAN_CAPTURE'
      AND r.order_id IN (SELECT order_id FROM portion_facts)
    GROUP BY r.order_id
  ),
  order_facts AS MATERIALIZED (
    SELECT p.order_id AS id, p.order_number, p.delivered_at, p.day, p.method, p.payable, p.order_delivery, p.order_platform,
           MAX(p.active_sellers)::int AS active_sellers,
           CASE WHEN MAX(p.active_sellers) = 1 THEN MAX(p.an_active_seller)::uuid END AS sole_seller_id,
           COUNT(*) FILTER (WHERE p.active AND ${scoped})::int AS scoped_portions,
           COUNT(*) FILTER (WHERE NOT p.active AND ${scoped})::int AS cancelled_portions,
           COALESCE(SUM(p.subtotal - p.coupon) FILTER (WHERE NOT p.active AND ${scoped}), 0)::bigint AS cancelled_value,
           COALESCE(SUM(p.subtotal) FILTER (WHERE p.active AND ${scoped}), 0)::bigint AS seller_price,
           COALESCE(SUM(p.coupon) FILTER (WHERE p.active AND ${scoped}), 0)::bigint AS coupon,
           COALESCE(SUM(p.commission) FILTER (WHERE p.active AND ${scoped}), 0)::bigint AS commission,
           COALESCE(SUM(p.refunded) FILTER (WHERE ${scoped}), 0)::bigint AS product_refunded,
           COALESCE(SUM(p.refund_pending) FILTER (WHERE ${scoped}), 0)::bigint AS refund_pending,
           COALESCE(SUM(p.deducted) FILTER (WHERE ${scoped}), 0)::bigint AS deducted,
           COALESCE(SUM(p.commission_reversed) FILTER (WHERE ${scoped}), 0)::bigint AS commission_reversed,
           COALESCE(SUM(p.coupon_reversed) FILTER (WHERE ${scoped}), 0)::bigint AS coupon_reversed,
           COALESCE(SUM(p.unclassified) FILTER (WHERE ${scoped}), 0)::bigint AS portion_unclassified,
           -- The recorded order total against its parts (all sellers only).
           (p.payable - COALESCE(SUM(p.subtotal - p.coupon) FILTER (WHERE p.active), 0) - p.order_delivery - p.order_platform)::bigint AS payable_gap
    FROM portion_facts p
    GROUP BY p.order_id, p.order_number, p.delivered_at, p.day, p.method, p.payable, p.order_delivery, p.order_platform
  ),
  scoped_orders AS MATERIALIZED (
    SELECT f.id, f.order_number, f.delivered_at, f.day, f.method, f.active_sellers, f.sole_seller_id,
           f.scoped_portions, f.cancelled_portions, f.cancelled_value, f.seller_price, f.coupon, f.commission,
           f.product_refunded, f.refund_pending, f.deducted, f.commission_reversed, f.coupon_reversed, f.payable, f.payable_gap,
           (f.portion_unclassified + CASE WHEN ${feesHere} THEN COALESCE(ou.amount, 0) ELSE 0 END)::bigint AS unclassified,
           CASE WHEN ${feesHere} THEN f.order_delivery ELSE 0 END::bigint AS delivery,
           CASE WHEN ${feesHere} THEN f.order_platform ELSE 0 END::bigint AS platform,
           (NOT ${feesHere} AND f.active_sellers > 1) AS is_shared,
           CASE WHEN NOT ${feesHere} AND f.active_sellers > 1 THEN f.order_delivery ELSE 0 END::bigint AS shared_delivery,
           CASE WHEN NOT ${feesHere} AND f.active_sellers > 1 THEN f.order_platform ELSE 0 END::bigint AS shared_platform,
           -- what the customer paid in THIS view: the order total for all
           -- sellers; one seller's products (after coupon) plus fees it owns.
           ${
             seller
               ? Prisma.sql`(f.seller_price - f.coupon + CASE WHEN ${feesHere} THEN f.order_delivery + f.order_platform ELSE 0 END)`
               : Prisma.sql`f.payable`
           }::bigint AS collected
    FROM order_facts f
    LEFT JOIN order_unclassified ou ON ou.order_id = f.id
    ${seller ? Prisma.sql`WHERE f.scoped_portions > 0` : Prisma.empty}
  )`;
}

/* -------------------------------------------------------------------------- */
/* Aggregates                                                                  */
/* -------------------------------------------------------------------------- */

/** The additive measures of a group of orders. */
export interface Measures {
  orders: number;
  codOrders: number;
  onlineOrders: number;
  ordersWithDeliveryFee: number;
  freeDeliveryOrders: number;
  ordersWithPlatformFee: number;
  multiSellerOrders: number;
  ordersWithRefund: number;
  collected: number;
  codCollected: number;
  onlineCollected: number;
  sellerPrice: number;
  coupon: number;
  commission: number;
  delivery: number;
  platform: number;
  productRefunded: number;
  codRefunded: number;
  onlineRefunded: number;
  refundPending: number;
  deducted: number;
  commissionReversed: number;
  couponReversed: number;
  unclassified: number;
  sharedDelivery: number;
  sharedPlatform: number;
  sharedOrders: number;
  cancelledPortions: number;
  cancelledValue: number;
  payableGapOrders: number;
  payableGap: number;
}

const MEASURE_KEYS: (keyof Measures)[] = [
  'orders', 'codOrders', 'onlineOrders', 'ordersWithDeliveryFee', 'freeDeliveryOrders', 'ordersWithPlatformFee',
  'multiSellerOrders', 'ordersWithRefund', 'collected', 'codCollected', 'onlineCollected', 'sellerPrice', 'coupon',
  'commission', 'delivery', 'platform', 'productRefunded', 'codRefunded', 'onlineRefunded', 'refundPending', 'deducted',
  'commissionReversed', 'couponReversed', 'unclassified', 'sharedDelivery', 'sharedPlatform', 'sharedOrders',
  'cancelledPortions', 'cancelledValue', 'payableGapOrders', 'payableGap',
];

export const zeroMeasures = (): Measures => Object.fromEntries(MEASURE_KEYS.map((k) => [k, 0])) as unknown as Measures;

function addMeasures(target: Measures, source: Measures): Measures {
  for (const key of MEASURE_KEYS) target[key] += source[key];
  return target;
}

/** The SQL that sums scoped_orders into Measures (one row per GROUP BY key). */
const MEASURES_SQL = Prisma.sql`
  COUNT(*)::bigint AS orders,
  COUNT(*) FILTER (WHERE method = 'COD')::bigint AS cod_orders,
  COUNT(*) FILTER (WHERE method <> 'COD')::bigint AS online_orders,
  COUNT(*) FILTER (WHERE delivery > 0)::bigint AS orders_with_delivery_fee,
  COUNT(*) FILTER (WHERE delivery = 0 AND NOT is_shared)::bigint AS free_delivery_orders,
  COUNT(*) FILTER (WHERE platform > 0)::bigint AS orders_with_platform_fee,
  COUNT(*) FILTER (WHERE active_sellers > 1)::bigint AS multi_seller_orders,
  COUNT(*) FILTER (WHERE product_refunded + unclassified > 0)::bigint AS orders_with_refund,
  COALESCE(SUM(collected), 0)::bigint AS collected,
  COALESCE(SUM(collected) FILTER (WHERE method = 'COD'), 0)::bigint AS cod_collected,
  COALESCE(SUM(collected) FILTER (WHERE method <> 'COD'), 0)::bigint AS online_collected,
  COALESCE(SUM(seller_price), 0)::bigint AS seller_price,
  COALESCE(SUM(coupon), 0)::bigint AS coupon,
  COALESCE(SUM(commission), 0)::bigint AS commission,
  COALESCE(SUM(delivery), 0)::bigint AS delivery,
  COALESCE(SUM(platform), 0)::bigint AS platform,
  COALESCE(SUM(product_refunded), 0)::bigint AS product_refunded,
  COALESCE(SUM(product_refunded + unclassified) FILTER (WHERE method = 'COD'), 0)::bigint AS cod_refunded,
  COALESCE(SUM(product_refunded + unclassified) FILTER (WHERE method <> 'COD'), 0)::bigint AS online_refunded,
  COALESCE(SUM(refund_pending), 0)::bigint AS refund_pending,
  COALESCE(SUM(deducted), 0)::bigint AS deducted,
  COALESCE(SUM(commission_reversed), 0)::bigint AS commission_reversed,
  COALESCE(SUM(coupon_reversed), 0)::bigint AS coupon_reversed,
  COALESCE(SUM(unclassified), 0)::bigint AS unclassified,
  COALESCE(SUM(shared_delivery), 0)::bigint AS shared_delivery,
  COALESCE(SUM(shared_platform), 0)::bigint AS shared_platform,
  COUNT(*) FILTER (WHERE is_shared)::bigint AS shared_orders,
  COALESCE(SUM(cancelled_portions), 0)::bigint AS cancelled_portions,
  COALESCE(SUM(cancelled_value), 0)::bigint AS cancelled_value,
  COUNT(*) FILTER (WHERE payable_gap <> 0)::bigint AS payable_gap_orders,
  COALESCE(SUM(payable_gap), 0)::bigint AS payable_gap`;

type Row = Record<string, bigint | number | string | null | Date>;

const toNumber = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

function rowToMeasures(row: Row): Measures {
  const m = zeroMeasures();
  for (const key of MEASURE_KEYS) {
    const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    m[key] = toNumber(row[column]);
  }
  return m;
}

/* -------------------------------------------------------------------------- */
/* Derived figures                                                             */
/* -------------------------------------------------------------------------- */

export interface Figures {
  /** What customers paid for the orders in view (before refunds after delivery). */
  grossRevenuePaise: number;
  refundsPaise: number;
  netRevenuePaise: number;
  sellerPricePaise: number;
  sellerPayablePaise: number;
  sellerDeductionsPaise: number;
  sellerNetPaise: number;
  deliveryPaise: number;
  platformPaise: number;
  commissionPaise: number;
  aadioneGrossPaise: number;
  deliveryRefundedPaise: number;
  platformRefundedPaise: number;
  commissionReversedPaise: number;
  netDeliveryPaise: number;
  netPlatformPaise: number;
  netCommissionPaise: number;
  aadioneNetPaise: number;
  couponPaise: number;
  couponReversedPaise: number;
  netCouponCostPaise: number;
  /** Refunded − (taken back from the seller + commission reversed − coupon reversed): rounding / unrecovered, borne by Aadione. */
  refundCostBeyondReversalsPaise: number;
  unclassifiedRefundsPaise: number;
  /** Aadione net earnings after paying for coupons and refund costs. */
  aadioneNetAfterCouponsPaise: number;
  /** netRevenue − (sellerNet + aadioneNetAfterCoupons − unclassified): 0 when everything reconciles. */
  reconciliationGapPaise: number;
}

/**
 * Fee refunds on a delivered order: none exist — fees are refunded only when
 * every seller portion is cancelled (payment.service.ts), so the order is never
 * delivered. Kept as explicit zeros so the formula reads in full.
 */
export function figures(m: Measures): Figures {
  const deliveryRefunded = 0;
  const platformRefunded = 0;
  const refunds = m.productRefunded + m.unclassified + deliveryRefunded + platformRefunded;
  const sellerPayable = m.sellerPrice - m.commission;
  const sellerNet = sellerPayable - m.deducted;
  const aadioneGross = m.delivery + m.platform + m.commission;
  const netDelivery = m.delivery - deliveryRefunded;
  const netPlatform = m.platform - platformRefunded;
  const netCommission = m.commission - m.commissionReversed;
  const aadioneNet = netDelivery + netPlatform + netCommission;
  const netCouponCost = m.coupon - m.couponReversed;
  const beyond = m.productRefunded - m.deducted - m.commissionReversed + m.couponReversed;
  const aadioneNetAfterCoupons = aadioneNet - netCouponCost - beyond;
  const netRevenue = m.collected - refunds;
  return {
    grossRevenuePaise: m.collected,
    refundsPaise: refunds,
    netRevenuePaise: netRevenue,
    sellerPricePaise: m.sellerPrice,
    sellerPayablePaise: sellerPayable,
    sellerDeductionsPaise: m.deducted,
    sellerNetPaise: sellerNet,
    deliveryPaise: m.delivery,
    platformPaise: m.platform,
    commissionPaise: m.commission,
    aadioneGrossPaise: aadioneGross,
    deliveryRefundedPaise: deliveryRefunded,
    platformRefundedPaise: platformRefunded,
    commissionReversedPaise: m.commissionReversed,
    netDeliveryPaise: netDelivery,
    netPlatformPaise: netPlatform,
    netCommissionPaise: netCommission,
    aadioneNetPaise: aadioneNet,
    couponPaise: m.coupon,
    couponReversedPaise: m.couponReversed,
    netCouponCostPaise: netCouponCost,
    refundCostBeyondReversalsPaise: beyond,
    unclassifiedRefundsPaise: m.unclassified,
    aadioneNetAfterCouponsPaise: aadioneNetAfterCoupons,
    reconciliationGapPaise: netRevenue - (sellerNet + aadioneNetAfterCoupons - m.unclassified),
  };
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

export interface TrendPoint {
  /** First local day of the bucket ("YYYY-MM-DD"). */
  start: string;
  grossRevenuePaise: number;
  netRevenuePaise: number;
  sellerNetPaise: number;
  aadioneGrossPaise: number;
  aadioneNetPaise: number;
  deliveryPaise: number;
  platformPaise: number;
  commissionPaise: number;
  netCommissionPaise: number;
  codPaise: number;
  onlinePaise: number;
  orders: number;
}

export interface SellerFinanceRow {
  sellerId: string;
  sellerCode: string;
  sellerName: string;
  orders: number;
  codOrders: number;
  onlineOrders: number;
  sellerPricePaise: number;
  customerPaidProductsPaise: number;
  codProductsPaise: number;
  onlineProductsPaise: number;
  couponPaise: number;
  commissionPaise: number;
  commissionReversedPaise: number;
  sellerPayablePaise: number;
  refundedPaise: number;
  deductionsPaise: number;
  sellerNetPaise: number;
  /** Fees of orders where this seller was the only active seller. */
  deliveryPaise: number;
  platformPaise: number;
  /** Multi-seller orders this seller took part in (their fees are shared, not allocated). */
  sharedOrders: number;
  aadioneNetPaise: number;
}

export interface FinanceOverviewDto {
  generatedAt: string;
  timezone: string;
  period: { preset: FinancePeriod; fromDate: string | null; toDate: string | null; label: string };
  seller: { id: string; code: string; name: string } | null;
  measures: Measures;
  figures: Figures;
  byMethod: { COD: Figures; ONLINE: Figures };
  /** Seller view only: fees of the multi-seller orders this seller took part in. */
  sharedFees: { orders: number; deliveryPaise: number; platformPaise: number } | null;
  pipeline: {
    inProgress: { orders: number; codOrders: number; onlineOrders: number; codToCollectPaise: number; onlinePaidPaise: number };
    awaitingPayment: { orders: number; amountPaise: number };
    paymentFailed: { orders: number; amountPaise: number };
    cancelled: { orders: number; amountPaise: number };
    /** Fees refunded on cancelled orders in the period (never earned). All sellers only. */
    cancelledFeesRefunded: { deliveryPaise: number; platformPaise: number; combinedPaise: number } | null;
    refundsPendingPaise: number;
  };
  dataQuality: {
    /** Delivered orders whose payment is not recorded as collected — excluded from every figure. */
    deliveredUnpaid: { orders: number; amountPaise: number };
    /** Delivered orders without a delivery time — excluded (cannot be dated). */
    deliveredWithoutTime: number;
    /** Orders whose recorded total differs from its seller portions + fees (all sellers only). */
    payableMismatch: { orders: number; amountPaise: number };
    notes: string[];
  };
  trend: { daily: TrendPoint[]; weekly: TrendPoint[]; monthly: TrendPoint[] };
  /** All sellers: one row per seller with delivered orders in the period. Seller view: that seller. */
  sellers: SellerFinanceRow[];
  /** All sellers: fees of multi-seller orders, which no single seller row includes. */
  unallocatedFees: { orders: number; deliveryPaise: number; platformPaise: number } | null;
}

function trendPoint(start: string, m: Measures): TrendPoint {
  const f = figures(m);
  return {
    start,
    grossRevenuePaise: f.grossRevenuePaise,
    netRevenuePaise: f.netRevenuePaise,
    sellerNetPaise: f.sellerNetPaise,
    aadioneGrossPaise: f.aadioneGrossPaise,
    aadioneNetPaise: f.aadioneNetPaise,
    deliveryPaise: f.deliveryPaise,
    platformPaise: f.platformPaise,
    commissionPaise: f.commissionPaise,
    netCommissionPaise: f.netCommissionPaise,
    codPaise: m.codCollected,
    onlinePaise: m.onlineCollected,
    orders: m.orders,
  };
}

/** Day rows (day, method) → daily / weekly / monthly series. Pure. */
export function buildTrend(dayRows: { day: string; measures: Measures }[]) {
  const bucket = (key: (day: string) => string) => {
    const map = new Map<string, Measures>();
    for (const row of dayRows) {
      const k = key(row.day);
      map.set(k, addMeasures(map.get(k) ?? zeroMeasures(), row.measures));
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, m]) => trendPoint(start, m));
  };
  return { daily: bucket((d) => d), weekly: bucket(weekStart), monthly: bucket(monthStart) };
}

async function dayMethodRows(filter: FinanceFilter) {
  const rows = await prisma.$queryRaw<Row[]>`
    ${factsCte(filter)}
    SELECT day, method, ${MEASURES_SQL} FROM scoped_orders GROUP BY day, method ORDER BY day`;
  return rows.map((row) => ({ day: String(row.day), method: String(row.method), measures: rowToMeasures(row) }));
}

async function sellerRows(filter: FinanceFilter): Promise<SellerFinanceRow[]> {
  const scope = filter.sellerId ? Prisma.sql`AND pf.seller_id = ${filter.sellerId}::uuid` : Prisma.empty;
  const rows = await prisma.$queryRaw<Row[]>`
    ${factsCte({ ...filter, sellerId: null })}
    , per_seller AS (
      SELECT pf.seller_id,
             COUNT(DISTINCT pf.order_id) FILTER (WHERE pf.active)::bigint AS orders,
             COUNT(DISTINCT pf.order_id) FILTER (WHERE pf.active AND pf.method = 'COD')::bigint AS cod_orders,
             COUNT(DISTINCT pf.order_id) FILTER (WHERE pf.active AND pf.method <> 'COD')::bigint AS online_orders,
             COALESCE(SUM(pf.subtotal) FILTER (WHERE pf.active), 0)::bigint AS seller_price,
             COALESCE(SUM(pf.subtotal - pf.coupon) FILTER (WHERE pf.active AND pf.method = 'COD'), 0)::bigint AS cod_products,
             COALESCE(SUM(pf.subtotal - pf.coupon) FILTER (WHERE pf.active AND pf.method <> 'COD'), 0)::bigint AS online_products,
             COALESCE(SUM(pf.coupon) FILTER (WHERE pf.active), 0)::bigint AS coupon,
             COALESCE(SUM(pf.commission) FILTER (WHERE pf.active), 0)::bigint AS commission,
             COALESCE(SUM(pf.commission_reversed), 0)::bigint AS commission_reversed,
             COALESCE(SUM(pf.refunded), 0)::bigint AS refunded,
             COALESCE(SUM(pf.deducted), 0)::bigint AS deducted
      FROM portion_facts pf
      WHERE TRUE ${scope}
      GROUP BY pf.seller_id
    ),
    sole_fees AS (
      SELECT sole_seller_id AS seller_id, SUM(order_delivery)::bigint AS delivery, SUM(order_platform)::bigint AS platform
      FROM order_facts WHERE sole_seller_id IS NOT NULL GROUP BY sole_seller_id
    ),
    shared AS (
      SELECT pf.seller_id, COUNT(DISTINCT pf.order_id)::bigint AS shared_orders
      FROM portion_facts pf
      WHERE pf.active AND pf.active_sellers > 1
      GROUP BY pf.seller_id
    )
    SELECT ps.*, se.code, se.name,
           COALESCE(sf.delivery, 0)::bigint AS delivery, COALESCE(sf.platform, 0)::bigint AS platform,
           COALESCE(sh.shared_orders, 0)::bigint AS shared_orders
    FROM per_seller ps
    JOIN sellers se ON se.id = ps.seller_id
    LEFT JOIN sole_fees sf ON sf.seller_id = ps.seller_id
    LEFT JOIN shared sh ON sh.seller_id = ps.seller_id
    WHERE ps.orders > 0 OR ps.refunded > 0 OR ps.deducted > 0
    ORDER BY seller_price DESC, se.name ASC`;
  return rows.map((r) => {
    const n = (key: string) => toNumber(r[key]);
    const commission = n('commission');
    const payable = n('seller_price') - commission;
    return {
      sellerId: String(r.seller_id),
      sellerCode: String(r.code),
      sellerName: String(r.name),
      orders: n('orders'),
      codOrders: n('cod_orders'),
      onlineOrders: n('online_orders'),
      sellerPricePaise: n('seller_price'),
      customerPaidProductsPaise: n('cod_products') + n('online_products'),
      codProductsPaise: n('cod_products'),
      onlineProductsPaise: n('online_products'),
      couponPaise: n('coupon'),
      commissionPaise: commission,
      commissionReversedPaise: n('commission_reversed'),
      sellerPayablePaise: payable,
      refundedPaise: n('refunded'),
      deductionsPaise: n('deducted'),
      sellerNetPaise: payable - n('deducted'),
      deliveryPaise: n('delivery'),
      platformPaise: n('platform'),
      sharedOrders: n('shared_orders'),
      aadioneNetPaise: commission - n('commission_reversed') + n('delivery') + n('platform'),
    };
  });
}

async function pipeline(filter: FinanceFilter): Promise<FinanceOverviewDto['pipeline'] & { deliveredUnpaid: { orders: number; amountPaise: number } }> {
  const seller = filter.sellerId;
  const placedOn = Prisma.sql`COALESCE(o.placed_at, o.created_at)`;
  // The value in view: the order's payable for all sellers; the seller's own
  // active products (after coupon) for one seller.
  const value = seller
    ? Prisma.sql`COALESCE((SELECT SUM(so.subtotal_paise - so.coupon_discount_paise) FROM seller_orders so
        WHERE so.order_id = o.id AND so.seller_id = ${seller}::uuid AND so.status::text NOT IN ('CANCELLED', 'REJECTED')), 0)`
    : Prisma.sql`o.current_payable_paise`;
  const hasSeller = seller
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM seller_orders so WHERE so.order_id = o.id AND so.seller_id = ${seller}::uuid)`
    : Prisma.empty;
  const [row] = await prisma.$queryRaw<Row[]>`
    SELECT
      COUNT(*) FILTER (WHERE o.status::text = ANY(${IN_PROGRESS_STATUSES}) ${rangeOn(placedOn, filter.period)})::bigint AS in_progress,
      COUNT(*) FILTER (WHERE o.status::text = ANY(${IN_PROGRESS_STATUSES}) AND o."paymentMethod" = 'COD' ${rangeOn(placedOn, filter.period)})::bigint AS in_progress_cod,
      COUNT(*) FILTER (WHERE o.status::text = ANY(${IN_PROGRESS_STATUSES}) AND o."paymentMethod" <> 'COD' ${rangeOn(placedOn, filter.period)})::bigint AS in_progress_online,
      COALESCE(SUM(${value}) FILTER (WHERE o.status::text = ANY(${IN_PROGRESS_STATUSES}) AND o."paymentMethod" = 'COD' ${rangeOn(placedOn, filter.period)}), 0)::bigint AS cod_to_collect,
      COALESCE(SUM(${value}) FILTER (WHERE o.status::text = ANY(${IN_PROGRESS_STATUSES}) AND o."paymentMethod" <> 'COD' ${rangeOn(placedOn, filter.period)}), 0)::bigint AS online_paid,
      COUNT(*) FILTER (WHERE o.status = 'PENDING_PAYMENT' ${rangeOn(Prisma.sql`o.created_at`, filter.period)})::bigint AS awaiting,
      COALESCE(SUM(o.total_paise) FILTER (WHERE o.status = 'PENDING_PAYMENT' ${rangeOn(Prisma.sql`o.created_at`, filter.period)}), 0)::bigint AS awaiting_amount,
      COUNT(*) FILTER (WHERE o.status = 'PAYMENT_FAILED' ${rangeOn(Prisma.sql`o.created_at`, filter.period)})::bigint AS failed,
      COALESCE(SUM(o.total_paise) FILTER (WHERE o.status = 'PAYMENT_FAILED' ${rangeOn(Prisma.sql`o.created_at`, filter.period)}), 0)::bigint AS failed_amount,
      COUNT(*) FILTER (WHERE o.status IN ('CANCELLED', 'REFUNDED') ${rangeOn(Prisma.sql`COALESCE(o.cancelled_at, o.updated_at)`, filter.period)})::bigint AS cancelled,
      COALESCE(SUM(o.total_paise) FILTER (WHERE o.status IN ('CANCELLED', 'REFUNDED') ${rangeOn(Prisma.sql`COALESCE(o.cancelled_at, o.updated_at)`, filter.period)}), 0)::bigint AS cancelled_amount,
      COUNT(*) FILTER (WHERE o.status = 'DELIVERED' AND o.delivered_at IS NOT NULL AND o.payment_status::text <> ALL(${COLLECTED_PAYMENT_STATUSES}) ${rangeOn(Prisma.sql`o.delivered_at`, filter.period)})::bigint AS delivered_unpaid,
      COALESCE(SUM(${value}) FILTER (WHERE o.status = 'DELIVERED' AND o.delivered_at IS NOT NULL AND o.payment_status::text <> ALL(${COLLECTED_PAYMENT_STATUSES}) ${rangeOn(Prisma.sql`o.delivered_at`, filter.period)}), 0)::bigint AS delivered_unpaid_amount
    FROM orders o
    WHERE TRUE ${hasSeller}`;
  // Seller view: the seller's own cancelled / rejected portions instead of whole orders.
  let cancelled = { orders: toNumber(row?.cancelled), amountPaise: toNumber(row?.cancelled_amount) };
  if (seller) {
    const [c] = await prisma.$queryRaw<Row[]>`
      SELECT COUNT(*)::bigint AS n, COALESCE(SUM(so.subtotal_paise - so.coupon_discount_paise), 0)::bigint AS amount
      FROM seller_orders so JOIN orders o ON o.id = so.order_id
      WHERE so.seller_id = ${seller}::uuid AND so.status::text IN ('CANCELLED', 'REJECTED')
        AND o.status::text <> ALL(${['PENDING_PAYMENT', 'PAYMENT_FAILED']})
        ${rangeOn(Prisma.sql`COALESCE(so.cancelled_at, so.rejected_at, so.updated_at)`, filter.period)}`;
    cancelled = { orders: toNumber(c?.n), amountPaise: toNumber(c?.amount) };
  }
  let cancelledFeesRefunded: FinanceOverviewDto['pipeline']['cancelledFeesRefunded'] = null;
  if (!seller) {
    const [f] = await prisma.$queryRaw<Row[]>`
      SELECT
        COALESCE(SUM(r.amount_paise) FILTER (WHERE r.component_type = 'DELIVERY_FEE'), 0)::bigint AS delivery,
        COALESCE(SUM(r.amount_paise) FILTER (WHERE r.component_type = 'PLATFORM_FEE'), 0)::bigint AS platform,
        COALESCE(SUM(r.amount_paise) FILTER (WHERE r.component_type = 'ORDER_FEES'), 0)::bigint AS combined
      FROM refunds r JOIN orders o ON o.id = r.order_id
      WHERE r.status = 'COMPLETED' AND o.status <> 'DELIVERED'
        AND r.component_type::text IN ('DELIVERY_FEE', 'PLATFORM_FEE', 'ORDER_FEES')
        ${rangeOn(Prisma.sql`COALESCE(r.completed_at, r.updated_at)`, filter.period)}`;
    cancelledFeesRefunded = { deliveryPaise: toNumber(f?.delivery), platformPaise: toNumber(f?.platform), combinedPaise: toNumber(f?.combined) };
  }
  return {
    inProgress: {
      orders: toNumber(row?.in_progress),
      codOrders: toNumber(row?.in_progress_cod),
      onlineOrders: toNumber(row?.in_progress_online),
      codToCollectPaise: toNumber(row?.cod_to_collect),
      onlinePaidPaise: toNumber(row?.online_paid),
    },
    awaitingPayment: { orders: toNumber(row?.awaiting), amountPaise: toNumber(row?.awaiting_amount) },
    paymentFailed: { orders: toNumber(row?.failed), amountPaise: toNumber(row?.failed_amount) },
    cancelled,
    cancelledFeesRefunded,
    refundsPendingPaise: 0,
    deliveredUnpaid: { orders: toNumber(row?.delivered_unpaid), amountPaise: toNumber(row?.delivered_unpaid_amount) },
  };
}

export async function getFinancialOverview(filter: FinanceFilter): Promise<FinanceOverviewDto> {
  const [days, sellers, pipe, undated, sellerInfo] = await Promise.all([
    dayMethodRows(filter),
    sellerRows(filter),
    pipeline(filter),
    prisma.order.count({ where: { status: OrderStatus.DELIVERED, deliveredAt: null } }),
    filter.sellerId ? prisma.seller.findUnique({ where: { id: filter.sellerId }, select: { id: true, code: true, name: true } }) : null,
  ]);

  const total = zeroMeasures();
  const cod = zeroMeasures();
  const online = zeroMeasures();
  const perDay = new Map<string, Measures>();
  for (const row of days) {
    addMeasures(total, row.measures);
    addMeasures(row.method === 'COD' ? cod : online, row.measures);
    perDay.set(row.day, addMeasures(perDay.get(row.day) ?? zeroMeasures(), row.measures));
  }
  const trend = buildTrend([...perDay.entries()].map(([day, measures]) => ({ day, measures })));

  const notes: string[] = [];
  if (pipe.deliveredUnpaid.orders > 0) notes.push(`${pipe.deliveredUnpaid.orders} delivered order(s) have no recorded payment and are not counted.`);
  if (undated > 0) notes.push(`${undated} delivered order(s) have no delivery time and are not counted.`);
  if (!filter.sellerId && total.payableGapOrders > 0) notes.push(`${total.payableGapOrders} order(s) have a recorded total that differs from their items and fees.`);
  if (total.unclassified > 0) notes.push('Some refunds on delivered orders could not be matched to a product or fee; they reduce net revenue but are not attributed to a seller or to Aadione.');

  return {
    generatedAt: new Date().toISOString(),
    timezone: filter.timeZone,
    period: { preset: filter.period.preset, fromDate: filter.period.fromDate, toDate: filter.period.toDate, label: filter.period.label },
    seller: sellerInfo ? { id: sellerInfo.id, code: sellerInfo.code, name: sellerInfo.name } : null,
    measures: total,
    figures: figures(total),
    byMethod: { COD: figures(cod), ONLINE: figures(online) },
    sharedFees: filter.sellerId ? { orders: total.sharedOrders, deliveryPaise: total.sharedDelivery, platformPaise: total.sharedPlatform } : null,
    pipeline: {
      inProgress: pipe.inProgress,
      awaitingPayment: pipe.awaitingPayment,
      paymentFailed: pipe.paymentFailed,
      cancelled: pipe.cancelled,
      cancelledFeesRefunded: pipe.cancelledFeesRefunded,
      refundsPendingPaise: total.refundPending,
    },
    dataQuality: {
      deliveredUnpaid: pipe.deliveredUnpaid,
      deliveredWithoutTime: undated,
      payableMismatch: filter.sellerId ? { orders: 0, amountPaise: 0 } : { orders: total.payableGapOrders, amountPaise: total.payableGap },
      notes,
    },
    trend,
    sellers,
    unallocatedFees: filter.sellerId
      ? null
      : {
          orders: total.multiSellerOrders,
          deliveryPaise: total.delivery - sellers.reduce((s, r) => s + r.deliveryPaise, 0),
          platformPaise: total.platform - sellers.reduce((s, r) => s + r.platformPaise, 0),
        },
  };
}

/* -------------------------------------------------------------------------- */
/* Orders — paginated, the same figures per order                             */
/* -------------------------------------------------------------------------- */

export interface FinanceOrderRow {
  orderId: string;
  orderNumber: string;
  deliveredAt: string;
  paymentMethod: string;
  activeSellers: number;
  grossRevenuePaise: number;
  sellerPricePaise: number;
  couponPaise: number;
  deliveryPaise: number;
  platformPaise: number;
  sharedFeesPaise: number;
  commissionPaise: number;
  sellerPayablePaise: number;
  refundedPaise: number;
  deductionsPaise: number;
  sellerNetPaise: number;
  aadioneNetPaise: number;
  netRevenuePaise: number;
}

export async function listFinanceOrders(filter: FinanceFilter, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [rows, [count]] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      ${factsCte(filter)}
      SELECT * FROM scoped_orders ORDER BY delivered_at DESC, id ASC LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.$queryRaw<Row[]>`${factsCte(filter)} SELECT COUNT(*)::bigint AS n FROM scoped_orders`,
  ]);
  const items: FinanceOrderRow[] = rows.map((r) => {
    const m = rowToMeasures({
      ...r,
      orders: 1,
      cod_collected: r.method === 'COD' ? r.collected : 0,
      online_collected: r.method === 'COD' ? 0 : r.collected,
    } as Row);
    const f = figures(m);
    return {
      orderId: String(r.id),
      orderNumber: String(r.order_number),
      deliveredAt: (r.delivered_at as Date).toISOString(),
      paymentMethod: String(r.method),
      activeSellers: toNumber(r.active_sellers),
      grossRevenuePaise: f.grossRevenuePaise,
      sellerPricePaise: f.sellerPricePaise,
      couponPaise: f.couponPaise,
      deliveryPaise: f.deliveryPaise,
      platformPaise: f.platformPaise,
      sharedFeesPaise: toNumber(r.shared_delivery) + toNumber(r.shared_platform),
      commissionPaise: f.commissionPaise,
      sellerPayablePaise: f.sellerPayablePaise,
      refundedPaise: f.refundsPaise,
      deductionsPaise: f.sellerDeductionsPaise,
      sellerNetPaise: f.sellerNetPaise,
      aadioneNetPaise: f.aadioneNetPaise,
      netRevenuePaise: f.netRevenuePaise,
    };
  });
  const total = toNumber(count?.n);
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** The seller filter's options: every seller (a closed or suspended one still has history). */
export async function listFinanceSellers() {
  return prisma.seller.findMany({ select: { id: true, code: true, name: true }, orderBy: [{ name: 'asc' }, { code: 'asc' }] });
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

export interface FinanceReportData {
  overview: FinanceOverviewDto;
  issuer: DocumentIssuer;
  orders: FinanceOrderRow[];
  ordersTotal: number;
  ordersTruncated: boolean;
}

export async function buildFinanceReport(filter: FinanceFilter): Promise<FinanceReportData> {
  const [overview, orders, business] = await Promise.all([
    getFinancialOverview(filter),
    listFinanceOrders(filter, 1, PDF_ORDER_LIMIT),
    getBusinessInfo(),
  ]);
  return {
    overview,
    issuer: {
      tradeName: business.tradeName,
      legalName: business.legalName,
      address: business.address,
      gstin: business.gstin,
      supportEmail: business.support.email,
      supportPhone: business.support.phone,
      website: business.website,
    },
    orders: orders.items,
    ordersTotal: orders.total,
    ordersTruncated: orders.total > orders.items.length,
  };
}

export async function financeReportPdfFile(filter: FinanceFilter) {
  const data = await buildFinanceReport(filter);
  const { renderFinanceReportPdf } = await import('./finance-overview-pdf');
  const p = data.overview.period;
  const range = p.fromDate ? `${p.fromDate}-to-${p.toDate}` : 'lifetime';
  const who = data.overview.seller ? data.overview.seller.code : 'all-sellers';
  return {
    fileName: `Aadione-Financial-Overview-${who}-${range}.pdf`,
    contentType: 'application/pdf',
    body: await renderFinanceReportPdf(data),
  };
}
