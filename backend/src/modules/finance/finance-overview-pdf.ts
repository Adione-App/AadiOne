/**
 * The admin Financial Overview as a branded A4 PDF — exactly the view the
 * admin has selected (period + seller). Pure layout: every figure comes from
 * finance-overview.service.ts (the same function the page shows); nothing is
 * added up here except the order table's own total row, which the tests
 * check against the overview.
 */

import { createDocument, date, dateTime, firstPageHeader, footers, Layout } from '../../infra/pdf/branded-pdf';
import type { FinanceReportData, TrendPoint } from './finance-overview.service';

const DAILY_ROWS_MAX = 62;
const WEEKLY_ROWS_MAX = 60;

export const periodText = (data: FinanceReportData) => {
  const p = data.overview.period;
  return p.fromDate ? `${date(`${p.fromDate}T12:00:00Z`)} – ${date(`${p.toDate}T12:00:00Z`)}` : 'All time';
};

export const scopeText = (data: FinanceReportData) =>
  data.overview.seller ? `${data.overview.seller.name} (${data.overview.seller.code})` : 'All sellers';

export function renderFinanceReportPdf(data: FinanceReportData, options: { compress?: boolean; trace?: (text: string, page: number) => void } = {}): Promise<Buffer> {
  const o = data.overview;
  const f = o.figures;
  const m = o.measures;
  const { doc, done } = createDocument(
    {
      title: `Aadione financial overview — ${o.period.label}`,
      author: data.issuer.tradeName,
      subject: `${scopeText(data)} · ${periodText(data)}`,
    },
    options.compress ?? true,
  );
  const layout = new Layout(doc, `Financial overview · ${scopeText(data)} · ${o.period.label} (${periodText(data)})`, options.trace, data.issuer.logo ?? undefined);
  const money = layout.money;
  firstPageHeader(doc, layout, {
    title: 'Financial Overview',
    lines: [`${o.period.label} · ${scopeText(data)}`, `Generated ${dateTime(o.generatedAt)}`],
    issuer: data.issuer,
  });

  // A. Scope
  layout.sectionTitle('A', 'Report scope');
  layout.keyValues([
    ['Period', o.period.label],
    ['Date range', periodText(data)],
    ['Seller', scopeText(data), 'full'],
    ['Generated', dateTime(o.generatedAt)],
    ['Reporting timezone', o.timezone],
    ['Delivered orders counted', String(m.orders)],
    ['Orders listed in section I', data.ordersTruncated ? `${data.orders.length} of ${data.ordersTotal}` : String(data.ordersTotal)],
  ]);
  layout.note(
    'Counts delivered orders whose payment is recorded, dated by delivery (Indian time). Cancelled, unpaid, failed and in-progress orders are never revenue (section H). Refunds are shown against the order they belong to, including refunds made after the period, up to the time this report was generated.',
  );

  // B. Summary
  layout.sectionTitle('B', 'Financial summary');
  layout.table(
    [
      { header: 'Item', width: 72 },
      { header: 'Amount', width: 28, align: 'right', exact: true },
    ],
    [
      ['Total order revenue (collected from customers)', money(f.grossRevenuePaise)],
      ['Refunds after delivery', money(-f.refundsPaise)],
      ['Net order revenue', money(f.netRevenuePaise)],
      ['Seller product sales (seller price)', money(f.sellerPricePaise)],
      ['Seller amount (sales minus commission)', money(f.sellerPayablePaise)],
      ['Seller deductions for refunds after delivery', money(-f.sellerDeductionsPaise)],
      ['Net seller earnings', money(f.sellerNetPaise)],
      ['Aadione earnings (delivery + platform fees + commission)', money(f.aadioneGrossPaise)],
      ['Fee refunds and commission reversed', money(-(f.deliveryRefundedPaise + f.platformRefundedPaise + f.commissionReversedPaise))],
      ['Net Aadione earnings', money(f.aadioneNetPaise)],
    ],
    { boldLastRow: true },
  );
  layout.table(
    [
      { header: 'Aadione costs and reconciliation', width: 72 },
      { header: 'Amount', width: 28, align: 'right', exact: true },
    ],
    [
      ['Aadione-funded coupons', money(f.couponPaise)],
      ['Coupon cost recovered by refunds', money(-f.couponReversedPaise)],
      ['Refund rounding / amounts not recovered from sellers', money(f.refundCostBeyondReversalsPaise)],
      ['Unclassified refunds (not attributed)', money(f.unclassifiedRefundsPaise)],
      ['Net Aadione earnings after coupons and refund costs', money(f.aadioneNetAfterCouponsPaise)],
      ['Check: net seller earnings + this − unclassified refunds − net revenue', money(-f.reconciliationGapPaise)],
    ],
  );
  layout.note(
    'Seller money and Aadione earnings never overlap: seller amount = seller price − commission; Aadione earnings = delivery fees + platform fees + commission. Coupons are paid by Aadione, so collected revenue = seller amount + Aadione earnings − coupons. COD and Online are how customers paid, not extra revenue.',
  );

  // C. Payment methods
  layout.sectionTitle('C', 'Payment methods');
  const methodRow = (label: string, orders: number, x: (typeof o.byMethod)['COD']) => [label, String(orders), money(x.grossRevenuePaise), money(x.refundsPaise), money(x.netRevenuePaise)];
  layout.table(
    [
      { header: 'Method', width: 28 },
      { header: 'Orders', width: 12, align: 'right', exact: true },
      { header: 'Collected', width: 20, align: 'right', exact: true },
      { header: 'Refunded', width: 20, align: 'right', exact: true },
      { header: 'Net', width: 20, align: 'right', exact: true },
    ],
    [
      methodRow('Cash on delivery (COD)', m.codOrders, o.byMethod.COD),
      methodRow('Online payment', m.onlineOrders, o.byMethod.ONLINE),
      ['Total', String(m.orders), money(f.grossRevenuePaise), money(f.refundsPaise), money(f.netRevenuePaise)],
    ],
    { boldLastRow: true },
  );

  // D. Delivery and platform fees
  layout.sectionTitle('D', 'Delivery charges and platform fees');
  layout.keyValues([
    ['Delivery charges collected', money(f.deliveryPaise)],
    ['Platform fees collected', money(f.platformPaise)],
    ['Orders with a delivery charge', String(m.ordersWithDeliveryFee)],
    ['Free-delivery orders (₹0)', String(m.freeDeliveryOrders)],
    ['Orders with a platform fee', String(m.ordersWithPlatformFee)],
    ['Multi-seller orders', String(m.multiSellerOrders)],
    ['Delivery charges refunded', money(f.deliveryRefundedPaise)],
    ['Platform fees refunded', money(f.platformRefundedPaise)],
    ['Net delivery charge earnings', money(f.netDeliveryPaise)],
    ['Net platform fee earnings', money(f.netPlatformPaise)],
  ]);
  if (o.sharedFees) {
    layout.note(
      `Shared fees not allocated to this seller: ${o.sharedFees.orders} multi-seller order(s) with ${money(o.sharedFees.deliveryPaise)} delivery and ${money(o.sharedFees.platformPaise)} platform fees. Fees count for a seller only when it is the order's only seller.`,
    );
  } else if (o.unallocatedFees) {
    layout.note(
      `Of these, ${money(o.unallocatedFees.deliveryPaise)} delivery and ${money(o.unallocatedFees.platformPaise)} platform fees come from ${o.unallocatedFees.orders} multi-seller order(s) and are not allocated to any one seller (section F).`,
    );
  }
  if (o.pipeline.cancelledFeesRefunded) {
    const c = o.pipeline.cancelledFeesRefunded;
    layout.note(
      `Delivered orders have no fee refunds: fees are refunded only when a whole order is cancelled. Fees refunded on cancelled orders in this period (never earned): delivery ${money(c.deliveryPaise)}, platform ${money(c.platformPaise)}${c.combinedPaise ? `, combined (older refunds) ${money(c.combinedPaise)}` : ''}.`,
    );
  }

  // E. Commission
  layout.sectionTitle('E', 'Seller commission');
  const rate = f.sellerPricePaise > 0 ? `${((f.commissionPaise / f.sellerPricePaise) * 100).toFixed(2)}%` : '—';
  layout.keyValues([
    ['Commission earned', money(f.commissionPaise)],
    ['Effective commission rate', rate],
    ['Commission reversed (refunds after delivery)', money(f.commissionReversedPaise)],
    ['Net commission', money(f.netCommissionPaise)],
  ]);

  // F. Sellers
  layout.sectionTitle('F', o.seller ? 'Seller breakdown' : `Seller breakdown (${o.sellers.length} ${o.sellers.length === 1 ? 'seller' : 'sellers'})`);
  const sellerRows = o.sellers.map((s) => [
    `${s.sellerName} (${s.sellerCode})`,
    String(s.orders),
    money(s.sellerPricePaise),
    money(s.commissionPaise),
    money(s.sellerPayablePaise),
    money(s.deductionsPaise),
    money(s.sellerNetPaise),
    money(s.deliveryPaise + s.platformPaise),
    money(s.aadioneNetPaise),
  ]);
  if (o.unallocatedFees && (o.unallocatedFees.deliveryPaise || o.unallocatedFees.platformPaise)) {
    sellerRows.push(['Shared fees of multi-seller orders', String(o.unallocatedFees.orders), '', '', '', '', '', money(o.unallocatedFees.deliveryPaise + o.unallocatedFees.platformPaise), money(o.unallocatedFees.deliveryPaise + o.unallocatedFees.platformPaise)]);
  }
  layout.table(
    [
      { header: 'Seller', width: 22 },
      { header: 'Orders', width: 7, align: 'right', exact: true },
      { header: 'Sales', width: 10.5, align: 'right', exact: true },
      { header: 'Commission', width: 10, align: 'right', exact: true },
      { header: 'Seller amount', width: 10.5, align: 'right', exact: true },
      { header: 'Deductions', width: 9.5, align: 'right', exact: true },
      { header: 'Seller net', width: 10.5, align: 'right', exact: true },
      { header: 'Fees', width: 9, align: 'right', exact: true },
      { header: 'Aadione net', width: 11, align: 'right', exact: true },
    ],
    sellerRows,
    { emptyText: 'No delivered orders for this selection.' },
  );
  layout.note('Seller orders are counted per seller, so a multi-seller order counts once for each seller in it. "Fees" are those of orders where the seller was the only seller.');

  // G. Trend
  const trendTable = (title: string, points: TrendPoint[], fmt: (p: TrendPoint) => string) => {
    layout.sectionTitle('G', title);
    layout.table(
      [
        { header: 'Period', width: 18, exact: true },
        { header: 'Orders', width: 8, align: 'right', exact: true },
        { header: 'Revenue', width: 14, align: 'right', exact: true },
        { header: 'Seller net', width: 14, align: 'right', exact: true },
        { header: 'Delivery', width: 11.5, align: 'right', exact: true },
        { header: 'Platform', width: 11.5, align: 'right', exact: true },
        { header: 'Commission', width: 11, align: 'right', exact: true },
        { header: 'Aadione net', width: 12, align: 'right', exact: true },
      ],
      points.map((p) => [fmt(p), String(p.orders), money(p.grossRevenuePaise), money(p.sellerNetPaise), money(p.deliveryPaise), money(p.platformPaise), money(p.commissionPaise), money(p.aadioneNetPaise)]),
      { emptyText: 'No delivered orders for this selection.' },
    );
  };
  const monthName = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (o.trend.daily.length <= DAILY_ROWS_MAX) trendTable('Daily trend', o.trend.daily, (p) => date(`${p.start}T12:00:00Z`));
  else if (o.trend.weekly.length <= WEEKLY_ROWS_MAX) trendTable('Weekly trend (weeks start Monday)', o.trend.weekly, (p) => `Week of ${date(`${p.start}T12:00:00Z`)}`);
  trendTable('Monthly trend', o.trend.monthly, (p) => monthName.format(new Date(`${p.start}T00:00:00Z`)));

  // H. Pipeline and data quality
  layout.sectionTitle('H', 'Not counted as revenue');
  const pl = o.pipeline;
  layout.keyValues([
    ['In progress (placed, not delivered)', `${pl.inProgress.orders} orders`],
    ['COD still to collect on delivery', money(pl.inProgress.codToCollectPaise)],
    ['Online paid, awaiting delivery', money(pl.inProgress.onlinePaidPaise)],
    ['Refunds approved, not yet completed', money(pl.refundsPendingPaise)],
    ['Online checkouts awaiting payment', `${pl.awaitingPayment.orders} · ${money(pl.awaitingPayment.amountPaise)}`],
    ['Online payments failed', `${pl.paymentFailed.orders} · ${money(pl.paymentFailed.amountPaise)}`],
    [o.seller ? 'Cancelled / rejected seller orders' : 'Cancelled orders', `${pl.cancelled.orders} · ${money(pl.cancelled.amountPaise)}`],
    ['Cancelled seller portions inside delivered orders', `${m.cancelledPortions} · ${money(m.cancelledValue)}`],
  ]);
  if (o.dataQuality.notes.length) {
    for (const note of o.dataQuality.notes) layout.note(`Data check: ${note}`);
  } else {
    layout.note('Data check: every delivered order in this selection reconciles (recorded total = items after coupon + fees).');
  }

  // I. Orders
  layout.sectionTitle('I', data.ordersTruncated ? `Order details (first ${data.orders.length} of ${data.ordersTotal}, latest first)` : `Order details (${data.ordersTotal} ${data.ordersTotal === 1 ? 'order' : 'orders'}, latest first)`);
  const sum = (pick: (r: FinanceReportData['orders'][number]) => number) => data.orders.reduce((acc, r) => acc + pick(r), 0);
  layout.table(
    [
      { header: 'Order ID', width: 16, exact: true },
      { header: 'Delivered', width: 11, exact: true },
      { header: 'Mode', width: 7 },
      { header: 'Revenue', width: 11, align: 'right', exact: true },
      { header: 'Fees', width: 9, align: 'right', exact: true },
      { header: 'Commission', width: 10, align: 'right', exact: true },
      { header: 'Refunded', width: 9.5, align: 'right', exact: true },
      { header: 'Seller net', width: 11, align: 'right', exact: true },
      { header: 'Aadione net', width: 11, align: 'right', exact: true },
    ],
    [
      ...data.orders.map((r) => [
        r.orderNumber,
        date(r.deliveredAt),
        r.paymentMethod === 'COD' ? 'COD' : 'Online',
        money(r.grossRevenuePaise),
        money(r.deliveryPaise + r.platformPaise),
        money(r.commissionPaise),
        money(r.refundedPaise),
        money(r.sellerNetPaise),
        money(r.aadioneNetPaise),
      ]),
      ...(data.orders.length
        ? [[
            'Total',
            '',
            '',
            money(sum((r) => r.grossRevenuePaise)),
            money(sum((r) => r.deliveryPaise + r.platformPaise)),
            money(sum((r) => r.commissionPaise)),
            money(sum((r) => r.refundedPaise)),
            money(sum((r) => r.sellerNetPaise)),
            money(sum((r) => r.aadioneNetPaise)),
          ]]
        : []),
    ],
    { boldLastRow: data.orders.length > 0, emptyText: 'No delivered orders for this selection.' },
  );
  if (data.ordersTruncated) {
    layout.note(`Only the latest ${data.orders.length} orders are listed; the totals in sections B–H cover all ${data.ordersTotal}. Use the Admin Panel's order list for the rest.`);
  }

  footers(doc, layout, {
    reference: `${data.issuer.tradeName} · Financial overview · ${o.period.label} · ${scopeText(data)} · Confidential — internal`,
    notice: 'Read-only report from recorded orders, refunds and seller deductions. Generating it does not move money.',
  });
  doc.end();
  return done;
}
