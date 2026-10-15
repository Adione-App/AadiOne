/**
 * Order and seller financials — the ONE place the platform's per-seller
 * money breakdown is computed (admin reporting only; sellers keep their own
 * earnings view in seller-settlement.service.ts, which this reuses for
 * settlement eligibility rather than re-implementing it).
 *
 * Every figure is read from snapshots taken at order creation (prices,
 * commission, coupon shares) plus the refunds actually recorded — nothing is
 * recomputed against today's rules. Integer paise throughout.
 *
 * PER SELLER PORTION (SellerOrder)
 *   subtotal            sum of its tax-inclusive line totals (pre-coupon)
 *   couponShare         its share of the Aadione-funded coupon
 *                       (coupon-allocation.ts; shares sum to the coupon)
 *   customerPaid        subtotal - couponShare
 *   grossCommission     commission snapshot, charged on subtotal
 *   sellerPayable       subtotal - grossCommission while the portion stands;
 *                       0 once it is cancelled/rejected. The coupon is NEVER
 *                       deducted from it — Aadione bears the coupon.
 *   netCommissionContribution
 *                       grossCommission - couponShare: what Aadione keeps on
 *                       the portion after paying for its coupon. A platform
 *                       accounting figure (can be negative), never charged
 *                       to the seller.
 * A cancelled/rejected portion earns nothing and costs nothing: its
 * commission and coupon expense are reversed (reported as 0 "effective",
 * with the reversed amounts shown separately). Derived from the portion's
 * status, so a reversal happens exactly once by construction — there is no
 * ledger entry that could be posted twice.
 */

import { ErrorCode, OrderPaymentStatus, PaymentMethod, SellerOrderStatus, SettlementStatus } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { sellerVisibleOrderWhere } from './order-visibility';
import { customerPaidPaise } from './coupon-allocation';
import {
  EARNINGS_SELECT,
  inRange,
  toEarningsRow,
  type IneligibleReason,
} from '../sellers/seller-settlement.service';

const ORPHAN_CAPTURE = 'ORPHAN_CAPTURE';
const MONEY_TAKEN = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

const isCancelled = (status: SellerOrderStatus) =>
  status === SellerOrderStatus.CANCELLED || status === SellerOrderStatus.REJECTED;

/** Pure: the platform figures for one seller portion. */
export function sellerPortionFigures(input: {
  status: SellerOrderStatus;
  subtotalPaise: number;
  couponDiscountPaise: number;
  commissionPaise: number;
}) {
  const active = !isCancelled(input.status);
  const customerPaid = customerPaidPaise(input.subtotalPaise, input.couponDiscountPaise);
  return {
    active,
    customerPaidPaise: customerPaid,
    sellerPayablePaise: active ? input.subtotalPaise - input.commissionPaise : 0,
    effectiveCommissionPaise: active ? input.commissionPaise : 0,
    effectiveCouponExpensePaise: active ? input.couponDiscountPaise : 0,
    netCommissionContributionPaise: active ? input.commissionPaise - input.couponDiscountPaise : 0,
    reversedCommissionPaise: active ? 0 : input.commissionPaise,
    reversedCouponExpensePaise: active ? 0 : input.couponDiscountPaise,
  };
}

export interface SellerPortionFinancialsDto {
  sellerOrderId: string;
  sellerId: string;
  sellerName: string;
  status: SellerOrderStatus;
  subtotalPaise: number;
  couponSharePaise: number;
  customerPaidPaise: number;
  commissionBp: number;
  grossCommissionPaise: number;
  netCommissionContributionPaise: number;
  sellerPayablePaise: number;
  reversedCommissionPaise: number;
  reversedCouponExpensePaise: number;
  refundedPaise: number;
  refundPendingPaise: number;
  remainingRefundablePaise: number;
  settlement: {
    eligible: boolean;
    ineligibleReason: IneligibleReason | null;
    settlementId: string | null;
    settlementStatus: SettlementStatus | null;
    paidAt: string | null;
    payoutReference: string | null;
  };
}

export interface OrderFinancialsDto {
  orderId: string;
  orderNumber: string;
  paymentMethod: string;
  paymentStatus: OrderPaymentStatus;
  itemsSubtotalPaise: number;
  couponCode: string | null;
  couponDiscountPaise: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  totalPaise: number;
  currentPayablePaise: number;
  /** Online: the captured payment that paid for the order (never an orphan). Null for COD. */
  capturedPaise: number | null;
  refundedPaise: number;
  refundPendingPaise: number;
  sellers: SellerPortionFinancialsDto[];
  platform: {
    grossCommissionPaise: number;
    couponExpensePaise: number;
    netCommissionContributionPaise: number;
    sellerPayablePaise: number;
  };
  reconciliation: {
    /** Seller coupon shares sum exactly to the order coupon. */
    couponAllocationMatches: boolean;
    /** Seller subtotals sum exactly to the order's items subtotal. */
    subtotalsMatch: boolean;
    /** Refunded + still-pending refunds never exceed what was captured. */
    refundsWithinCaptured: boolean;
  };
}

export async function getOrderFinancials(orderId: string): Promise<OrderFinancialsDto> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      paymentMethod: true,
      paymentStatus: true,
      itemsSubtotalPaise: true,
      couponCode: true,
      couponDiscountPaise: true,
      deliveryFeePaise: true,
      platformFeePaise: true,
      totalPaise: true,
      currentPayablePaise: true,
      payments: {
        where: { status: { in: [...MONEY_TAKEN] } },
        select: { id: true, amountPaise: true, failureCode: true },
      },
      refunds: { select: { amountPaise: true, status: true, paymentId: true, sellerOrderId: true } },
    },
  });
  if (!order) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });

  const sellerOrders = await prisma.sellerOrder.findMany({
    where: { orderId },
    select: {
      ...EARNINGS_SELECT,
      couponDiscountPaise: true,
      seller: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Money for THIS order only: an orphan capture (late/duplicate payment) and
  // its own refund belong to that stray money, not to the order.
  const orderPayments = order.payments.filter((p) => p.failureCode !== ORPHAN_CAPTURE);
  const orderPaymentIds = new Set(orderPayments.map((p) => p.id));
  const orderRefunds = order.refunds.filter((r) => orderPaymentIds.has(r.paymentId));
  const sum = (rows: { amountPaise: number }[]) => rows.reduce((total, r) => total + r.amountPaise, 0);
  const completed = (r: { status: string }) => r.status === 'COMPLETED';
  const pending = (r: { status: string }) => r.status === 'PENDING' || r.status === 'PROCESSING';

  const settlements = await prisma.sellerSettlement.findMany({
    where: { sellerId: { in: [...new Set(sellerOrders.map((so) => so.sellerId))] } },
    select: { id: true, sellerId: true, periodStart: true, periodEnd: true, status: true, paidAt: true, payoutReference: true },
  });

  const sellers: SellerPortionFinancialsDto[] = sellerOrders.map((so) => {
    const figures = sellerPortionFigures(so);
    const earnings = toEarningsRow(so);
    const own = orderRefunds.filter((r) => r.sellerOrderId === so.id);
    const refunded = sum(own.filter(completed));
    const refundPending = sum(own.filter(pending));
    const covering = earnings.eligibleForSettlement
      ? settlements.find(
          (s) => s.sellerId === so.sellerId && inRange(earnings.deliveredAt, { start: s.periodStart, end: s.periodEnd }),
        )
      : undefined;
    return {
      sellerOrderId: so.id,
      sellerId: so.sellerId,
      sellerName: so.seller.name,
      status: so.status,
      subtotalPaise: so.subtotalPaise,
      couponSharePaise: so.couponDiscountPaise,
      customerPaidPaise: figures.customerPaidPaise,
      commissionBp: so.commissionBp,
      grossCommissionPaise: so.commissionPaise,
      netCommissionContributionPaise: figures.netCommissionContributionPaise,
      sellerPayablePaise: figures.sellerPayablePaise,
      reversedCommissionPaise: figures.reversedCommissionPaise,
      reversedCouponExpensePaise: figures.reversedCouponExpensePaise,
      refundedPaise: refunded,
      refundPendingPaise: refundPending,
      remainingRefundablePaise:
        order.paymentMethod === PaymentMethod.ONLINE ? Math.max(0, figures.customerPaidPaise - refunded - refundPending) : 0,
      settlement: {
        eligible: earnings.eligibleForSettlement,
        ineligibleReason: earnings.ineligibleReason,
        settlementId: covering?.id ?? null,
        settlementStatus: covering?.status ?? null,
        paidAt: covering?.paidAt?.toISOString() ?? null,
        payoutReference: covering?.payoutReference ?? null,
      },
    };
  });

  const platform = sellerOrders.reduce(
    (acc, so) => {
      const f = sellerPortionFigures(so);
      acc.grossCommissionPaise += f.effectiveCommissionPaise;
      acc.couponExpensePaise += f.effectiveCouponExpensePaise;
      acc.netCommissionContributionPaise += f.netCommissionContributionPaise;
      acc.sellerPayablePaise += f.sellerPayablePaise;
      return acc;
    },
    { grossCommissionPaise: 0, couponExpensePaise: 0, netCommissionContributionPaise: 0, sellerPayablePaise: 0 },
  );

  const captured = order.paymentMethod === PaymentMethod.ONLINE ? sum(orderPayments) : null;
  const refundedPaise = sum(orderRefunds.filter(completed));
  const refundPendingPaise = sum(orderRefunds.filter(pending));

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    itemsSubtotalPaise: order.itemsSubtotalPaise,
    couponCode: order.couponCode,
    couponDiscountPaise: order.couponDiscountPaise,
    deliveryFeePaise: order.deliveryFeePaise,
    platformFeePaise: order.platformFeePaise,
    totalPaise: order.totalPaise,
    currentPayablePaise: order.currentPayablePaise,
    capturedPaise: captured,
    refundedPaise,
    refundPendingPaise,
    sellers,
    platform,
    reconciliation: {
      couponAllocationMatches: sum(sellerOrders.map((so) => ({ amountPaise: so.couponDiscountPaise }))) === order.couponDiscountPaise,
      subtotalsMatch: sum(sellerOrders.map((so) => ({ amountPaise: so.subtotalPaise }))) === order.itemsSubtotalPaise,
      refundsWithinCaptured: captured === null ? refundedPaise + refundPendingPaise === 0 : refundedPaise + refundPendingPaise <= captured,
    },
  };
}

export interface SellerPlatformAccountingDto {
  sellerId: string;
  /** Placed seller portions considered (unpaid / payment-failed orders excluded). */
  sellerOrders: number;
  subtotalPaise: number;
  grossCommissionPaise: number;
  couponExpensePaise: number;
  netCommissionContributionPaise: number;
  sellerPayablePaise: number;
  reversedCommissionPaise: number;
  reversedCouponExpensePaise: number;
}

/** Aadione's commission and coupon expense across one seller's placed portions (admin). */
export async function getSellerPlatformAccounting(sellerId: string): Promise<SellerPlatformAccountingDto> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { id: true } });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

  const rows = await prisma.sellerOrder.findMany({
    where: { sellerId, order: sellerVisibleOrderWhere },
    select: { status: true, subtotalPaise: true, couponDiscountPaise: true, commissionPaise: true },
  });
  const result: SellerPlatformAccountingDto = {
    sellerId,
    sellerOrders: rows.length,
    subtotalPaise: 0,
    grossCommissionPaise: 0,
    couponExpensePaise: 0,
    netCommissionContributionPaise: 0,
    sellerPayablePaise: 0,
    reversedCommissionPaise: 0,
    reversedCouponExpensePaise: 0,
  };
  for (const row of rows) {
    const f = sellerPortionFigures(row);
    if (f.active) result.subtotalPaise += row.subtotalPaise;
    result.grossCommissionPaise += f.effectiveCommissionPaise;
    result.couponExpensePaise += f.effectiveCouponExpensePaise;
    result.netCommissionContributionPaise += f.netCommissionContributionPaise;
    result.sellerPayablePaise += f.sellerPayablePaise;
    result.reversedCommissionPaise += f.reversedCommissionPaise;
    result.reversedCouponExpensePaise += f.reversedCouponExpensePaise;
  }
  return result;
}
