/**
 * Seller settlement STATEMENT — the data behind the downloadable PDF
 * (seller-statement-pdf.ts). READ-ONLY: it never changes a settlement, and
 * it never moves money (payouts are manual, outside the app).
 *
 * Every money figure comes from what already exists:
 *   - the settlement's stored totals (gross, commission, deductions, net),
 *   - its SellerOrder rows and deduction lines exactly as
 *     `getSettlementDetail` returns them (the ONE eligibility/earnings rule
 *     in seller-settlement.service.ts — nothing is recalculated here),
 *   - earlier settlements of the same seller for the payment history.
 * The only derived figures are display ones: seller earnings (gross −
 * commission, as the settlement already defines it), the effective
 * commission rate, and "paid / remaining" from the settlement's own status.
 */

import { SellerOrderStatus, SettlementStatus } from '../../shared';
import { prisma } from '../../infra/db/prisma';
import { getBusinessInfo } from '../content/info-page.service';
import { getSettlementDetail } from './seller-settlement.service';

export interface StatementOrderLine {
  orderNumber: string;
  placedAt: string | null;
  deliveredAt: string | null;
  paymentMethod: string;
  status: string;
  amountPaise: number;
  commissionPaise: number;
  commissionRatePercent: string;
  earningPaise: number;
}

export interface StatementPaymentLine {
  settlementId: string;
  periodStart: string;
  periodEnd: string;
  status: SettlementStatus;
  paidAt: string | null;
  /**
   * Always generic: payouts are made manually by Aadione outside the app and
   * the specific method (bank transfer, UPI, …) is NOT stored — never shown as one.
   */
  method: string;
  reference: string | null;
  /** A payment screenshot / receipt is attached to that settlement. */
  hasProof: boolean;
  payablePaise: number;
  paidPaise: number;
  isThisStatement: boolean;
}

export interface StatementData {
  generatedAt: string;
  issuer: {
    tradeName: string;
    legalName: string | null;
    address: string | null;
    gstin: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
    website: string | null;
  };
  seller: {
    sellerId: string;
    sellerCode: string;
    storeName: string;
    businessName: string | null;
    ownerName: string | null;
    phone: string | null;
    email: string | null;
    address: string;
    gstNumber: string | null;
  };
  settlement: {
    id: string;
    periodStart: string;
    periodEnd: string;
    createdAt: string;
    status: SettlementStatus;
    paidAt: string | null;
    payoutReference: string | null;
    hasPayoutProof: boolean;
  };
  sales: {
    settledOrders: number;
    deliveredOrders: number;
    totalSalesPaise: number;
    averageOrderPaise: number;
    onlineOrders: number;
    codOrders: number;
    /** Informational: this seller's cancelled/rejected orders placed in the period (never part of a settlement). */
    cancelledOrders: number;
    cancelledValuePaise: number;
  };
  earnings: {
    grossSalesPaise: number;
    commissionPaise: number;
    commissionRatePercent: string;
    sellerEarningsPaise: number;
    deductionsPaise: number;
    deductionLines: { orderNumber: string; reason: string; amountPaise: number }[];
    netPayablePaise: number;
  };
  orders: StatementOrderLine[];
  payments: StatementPaymentLine[];
  summary: {
    totalPayablePaise: number;
    amountPaidPaise: number;
    remainingPaise: number;
    status: SettlementStatus;
  };
}

/** Percentage with two decimals, from paise — display only. */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return '0.00%';
  return `${((part / whole) * 100).toFixed(2)}%`;
}

/**
 * Payment history = this seller's settlements created up to (and including)
 * this one, latest period first, at most PAYMENT_HISTORY_LIMIT rows — and
 * THIS settlement is always one of them (even when later periods were
 * settled first). Settlements created after this one are not shown, so a
 * statement downloaded again later still describes the same history.
 */
export const PAYMENT_HISTORY_LIMIT = 12;

const HISTORY_SELECT = {
  id: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  paidAt: true,
  payoutReference: true,
  payoutProofKey: true,
  netPayablePaise: true,
} as const;

/** "Manual transfer" is a generic label: the actual method is not recorded. */
export const MANUAL_METHOD_LABEL = 'Manual transfer';

/**
 * Everything the statement shows for one settlement. `scopeSellerId` set =
 * a seller asking: its own settlement only (another's is "not found").
 */
export async function buildStatementData(settlementId: string, scopeSellerId?: string): Promise<StatementData> {
  // The existing detail: its rows and totals are THE settlement's figures.
  const detail = await getSettlementDetail(settlementId, scopeSellerId);
  const periodStart = new Date(detail.periodStart);
  const periodEnd = new Date(detail.periodEnd);

  const [seller, orderDates, cancelled, history, business] = await Promise.all([
    prisma.seller.findUniqueOrThrow({
      where: { id: detail.sellerId },
      select: {
        id: true,
        code: true,
        name: true,
        phone: true,
        addressLine: true,
        locality: true,
        city: true,
        district: true,
        state: true,
        pincode: true,
        customerCarePhone: true,
        customerCareEmail: true,
        profile: { select: { businessName: true, ownerFullName: true, ownerMobile: true, ownerEmail: true, gstNumber: true } },
      },
    }),
    prisma.order.findMany({
      where: { id: { in: detail.sellerOrders.map((row) => row.orderId) } },
      select: { id: true, placedAt: true, createdAt: true },
    }),
    // Informational only — cancelled/rejected seller orders are never settled.
    prisma.sellerOrder.findMany({
      where: {
        sellerId: detail.sellerId,
        status: { in: [SellerOrderStatus.CANCELLED, SellerOrderStatus.REJECTED] },
        order: { createdAt: { gte: periodStart, lt: periodEnd } },
      },
      select: { subtotalPaise: true },
    }),
    prisma.sellerSettlement.findMany({
      where: { sellerId: detail.sellerId, createdAt: { lte: new Date(detail.createdAt) } },
      orderBy: [{ periodEnd: 'desc' }, { id: 'asc' }],
      take: PAYMENT_HISTORY_LIMIT,
      select: HISTORY_SELECT,
    }),
    getBusinessInfo(),
  ]);

  // This settlement is always part of its own payment history.
  if (!history.some((s) => s.id === detail.id)) {
    const current = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: detail.id }, select: HISTORY_SELECT });
    history.splice(Math.min(history.length, PAYMENT_HISTORY_LIMIT - 1), history.length, current);
    history.sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
  }

  const placed = new Map(orderDates.map((o) => [o.id, (o.placedAt ?? o.createdAt).toISOString()]));
  const orders: StatementOrderLine[] = detail.sellerOrders.map((row) => ({
    orderNumber: row.orderNumber,
    placedAt: placed.get(row.orderId) ?? null,
    deliveredAt: row.deliveredAt,
    paymentMethod: row.paymentMethod,
    // Every settled row's parent order is DELIVERED (the settlement rule).
    status: 'Delivered',
    amountPaise: row.grossPaise,
    commissionPaise: row.commissionPaise,
    commissionRatePercent: percentOf(row.commissionPaise, row.grossPaise),
    earningPaise: row.finalPayablePaise,
  }));
  orders.sort((a, b) => (a.deliveredAt ?? '').localeCompare(b.deliveredAt ?? '') || a.orderNumber.localeCompare(b.orderNumber));

  const isPaid = detail.status === SettlementStatus.PAID;
  const profile = seller.profile;
  const address = [seller.addressLine, seller.locality, seller.city, seller.district, seller.state, seller.pincode].filter(Boolean).join(', ');
  const online = detail.sellerOrders.filter((row) => row.paymentMethod !== 'COD').length;

  return {
    generatedAt: new Date().toISOString(),
    issuer: {
      tradeName: business.tradeName,
      legalName: business.legalName,
      address: business.address,
      gstin: business.gstin,
      supportEmail: business.support.email,
      supportPhone: business.support.phone,
      website: business.website,
    },
    seller: {
      sellerId: seller.id,
      sellerCode: seller.code,
      storeName: seller.name,
      businessName: profile?.businessName ?? null,
      ownerName: profile?.ownerFullName ?? null,
      phone: seller.customerCarePhone ?? profile?.ownerMobile ?? seller.phone ?? null,
      email: seller.customerCareEmail ?? profile?.ownerEmail ?? null,
      address,
      gstNumber: profile?.gstNumber ?? null,
    },
    settlement: {
      id: detail.id,
      periodStart: detail.periodStart,
      periodEnd: detail.periodEnd,
      createdAt: detail.createdAt,
      status: detail.status,
      paidAt: detail.paidAt,
      payoutReference: detail.payoutReference,
      hasPayoutProof: detail.hasPayoutProof,
    },
    sales: {
      settledOrders: detail.sellerOrders.length,
      deliveredOrders: detail.sellerOrders.length,
      totalSalesPaise: detail.grossSalesPaise,
      averageOrderPaise: detail.sellerOrders.length ? Math.round(detail.grossSalesPaise / detail.sellerOrders.length) : 0,
      onlineOrders: online,
      codOrders: detail.sellerOrders.length - online,
      cancelledOrders: cancelled.length,
      cancelledValuePaise: cancelled.reduce((sum, so) => sum + so.subtotalPaise, 0),
    },
    earnings: {
      grossSalesPaise: detail.grossSalesPaise,
      commissionPaise: detail.commissionPaise,
      commissionRatePercent: percentOf(detail.commissionPaise, detail.grossSalesPaise),
      sellerEarningsPaise: detail.grossSalesPaise - detail.commissionPaise,
      deductionsPaise: detail.deductionsPaise,
      deductionLines: detail.deductions.map((d) => ({ orderNumber: d.orderNumber, reason: d.reason, amountPaise: d.amountPaise })),
      netPayablePaise: detail.netPayablePaise,
    },
    orders,
    payments: history.map((s) => ({
      settlementId: s.id,
      periodStart: s.periodStart.toISOString(),
      periodEnd: s.periodEnd.toISOString(),
      status: s.status,
      paidAt: s.paidAt?.toISOString() ?? null,
      method: s.status === SettlementStatus.PAID ? MANUAL_METHOD_LABEL : '—',
      reference: s.payoutReference,
      hasProof: Boolean(s.payoutProofKey),
      payablePaise: s.netPayablePaise,
      paidPaise: s.status === SettlementStatus.PAID ? s.netPayablePaise : 0,
      isThisStatement: s.id === detail.id,
    })),
    summary: {
      totalPayablePaise: detail.netPayablePaise,
      amountPaidPaise: isPaid ? detail.netPayablePaise : 0,
      remainingPaise: isPaid ? 0 : detail.netPayablePaise,
      status: detail.status,
    },
  };
}

/**
 * The statement as a downloadable file: `Aadione-Statement-<code>-<from>-to-<to>.pdf`
 * (dates in Indian time). Same checks as `buildStatementData`.
 */
export async function statementPdfFile(settlementId: string, scopeSellerId?: string) {
  const { renderStatementPdf } = await import('./seller-statement-pdf');
  const data = await buildStatementData(settlementId, scopeSellerId);
  const day = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return {
    fileName: `Aadione-Statement-${data.seller.sellerCode}-${day(data.settlement.periodStart)}-to-${day(data.settlement.periodEnd)}.pdf`,
    contentType: 'application/pdf',
    body: await renderStatementPdf(data),
  };
}
