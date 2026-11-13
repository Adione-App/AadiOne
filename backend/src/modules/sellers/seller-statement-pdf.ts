/**
 * Renders a seller settlement statement (seller-statement.service.ts) as a
 * branded, multi-page A4 PDF — layout from infra/pdf/branded-pdf.ts.
 *
 *   - Aadione logo + statement title on the first page, a slim running header
 *     on the others; "Page X of Y" and the statement reference in every footer.
 *   - Tables repeat their header row on each page and never split a row; a
 *     value too long for its cell is shortened with "…", never wrapped.
 *   - Text is drawn with Noto Sans (Latin, ₹) and Noto Sans Devanagari (Hindi
 *     store / seller names), switching font per run — assets/fonts, SIL OFL.
 *     If those files are missing the built-in Helvetica is used instead
 *     (amounts then read "Rs.", and non-Latin letters cannot be shown).
 *   - Dates are shown in Indian time (IST).
 *
 * Pure layout: every number comes from StatementData, nothing is computed here.
 */

import { SettlementStatus } from '../../shared';
import {
  createDocument,
  date,
  dateTime,
  firstPageHeader,
  footers,
  formatMoney,
  Layout,
  scriptRuns,
} from '../../infra/pdf/branded-pdf';
import type { StatementData } from './seller-statement.service';

export { date, dateTime, formatMoney, scriptRuns };

/** Mirrors seller-statement.service PAYMENT_HISTORY_LIMIT (a type-only import keeps this module free of DB code). */
const PAYMENT_HISTORY_ROWS = 12;

export const STATUS_LABEL: Record<SettlementStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  FAILED: 'Failed',
};

/** The statement's short reference: SEL code + the settlement's first 8 id characters. */
export const statementRef = (data: StatementData) => `STM-${data.seller.sellerCode}-${data.settlement.id.slice(0, 8).toUpperCase()}`;

/** The statement as PDF bytes. `trace` (tests) receives every line of text drawn, with its page. */
export function renderStatementPdf(
  data: StatementData,
  options: { compress?: boolean; trace?: (text: string, page: number) => void } = {},
): Promise<Buffer> {
  const { doc, done } = createDocument(
    {
      title: `Seller settlement statement ${statementRef(data)}`,
      author: data.issuer.tradeName,
      subject: `${data.seller.storeName} — ${date(data.settlement.periodStart)} to ${date(data.settlement.periodEnd)}`,
    },
    options.compress ?? true,
  );

  const layout = new Layout(
    doc,
    `Seller settlement statement · ${data.seller.storeName} · ${date(data.settlement.periodStart)} – ${date(data.settlement.periodEnd)}`,
    options.trace,
    data.issuer.logo ?? undefined,
  );
  const m = layout.money;
  const s = data.settlement;
  firstPageHeader(doc, layout, {
    title: 'Seller Settlement Statement',
    lines: [`Statement ${statementRef(data)}`, `Generated ${dateTime(data.generatedAt)}`],
    issuer: data.issuer,
  });

  // A. Seller details
  layout.sectionTitle('A', 'Seller details');
  layout.keyValues([
    ['Store name', data.seller.storeName],
    ['Seller ID', data.seller.sellerCode],
    ['Business name', data.seller.businessName ?? '—', 'full'],
    ['Owner', data.seller.ownerName ?? '—'],
    ['Seller GSTIN', data.seller.gstNumber ?? '—'],
    ['Phone', data.seller.phone ?? '—'],
    ['Email', data.seller.email ?? '—'],
    ['Store address', data.seller.address, 'full'],
    ['Statement period from', dateTime(s.periodStart)],
    ['Statement period to', dateTime(s.periodEnd)],
    ['Statement generated', dateTime(data.generatedAt)],
    ['Settlement created', dateTime(s.createdAt)],
  ]);

  // B. Sales summary
  layout.sectionTitle('B', 'Sales summary');
  layout.keyValues([
    ['Orders in this settlement', String(data.sales.settledOrders)],
    ['Delivered orders', String(data.sales.deliveredOrders)],
    ['Total sales', m(data.sales.totalSalesPaise)],
    ['Average order value', m(data.sales.averageOrderPaise)],
    ['Online-paid orders', String(data.sales.onlineOrders)],
    ['Cash on delivery orders', String(data.sales.codOrders)],
    ['Cancelled / rejected orders in period', String(data.sales.cancelledOrders)],
    ['Value of cancelled / rejected orders', m(data.sales.cancelledValuePaise)],
  ]);
  layout.note('Cancelled or rejected orders are never paid out and are not part of the totals below.');

  // C. Earnings summary
  layout.sectionTitle('C', 'Earnings summary');
  layout.table(
    [
      { header: 'Item', width: 70 },
      { header: 'Amount', width: 30, align: 'right', exact: true },
    ],
    [
      ['Gross sales (delivered and paid orders)', m(data.earnings.grossSalesPaise)],
      [`Aadione commission (effective rate ${data.earnings.commissionRatePercent})`, m(-data.earnings.commissionPaise)],
      ['Seller earnings (gross sales minus commission)', m(data.earnings.sellerEarningsPaise)],
      ['Refund deductions (refunds after delivery)', m(-data.earnings.deductionsPaise)],
      ['Net payable for this period', m(data.earnings.netPayablePaise)],
    ],
    { boldLastRow: true },
  );
  if (data.earnings.deductionLines.length > 0) {
    layout.table(
      [
        { header: 'Deducted for order', width: 25, exact: true },
        { header: 'Reason', width: 55 },
        { header: 'Amount', width: 20, align: 'right', exact: true },
      ],
      data.earnings.deductionLines.map((d) => [d.orderNumber, d.reason, m(d.amountPaise)]),
    );
  }

  // D. Detailed order history
  layout.sectionTitle('D', `Order history (${data.orders.length} ${data.orders.length === 1 ? 'order' : 'orders'})`);
  const sum = (pick: (o: StatementData['orders'][number]) => number) => data.orders.reduce((acc, o) => acc + pick(o), 0);
  layout.table(
    [
      { header: '#', width: 5, align: 'right', exact: true },
      { header: 'Order ID', width: 19, exact: true },
      { header: 'Order date', width: 11.5, exact: true },
      { header: 'Delivered', width: 11.5, exact: true },
      { header: 'Mode', width: 7.5 },
      { header: 'Status', width: 9.5 },
      { header: 'Amount', width: 12.5, align: 'right', exact: true },
      { header: 'Commission', width: 11.5, align: 'right', exact: true },
      { header: 'Your earning', width: 12, align: 'right', exact: true },
    ],
    [
      ...data.orders.map((o, i) => [
        String(i + 1),
        o.orderNumber,
        date(o.placedAt),
        date(o.deliveredAt),
        o.paymentMethod === 'COD' ? 'COD' : 'Online',
        o.status,
        m(o.amountPaise),
        m(o.commissionPaise),
        m(o.earningPaise),
      ]),
      ...(data.orders.length ? [['', 'Total', '', '', '', '', m(sum((o) => o.amountPaise)), m(sum((o) => o.commissionPaise)), m(sum((o) => o.earningPaise))]] : []),
    ],
    { boldLastRow: data.orders.length > 0, emptyText: 'No orders in this settlement.' },
  );

  // E. Payment history
  layout.sectionTitle('E', 'Payment history');
  layout.table(
    [
      { header: 'Settlement period', width: 23.5, exact: true },
      { header: 'Status', width: 9.5 },
      { header: 'Paid on', width: 11.5, exact: true },
      { header: 'Method', width: 15.5, exact: true },
      { header: 'Transaction / UPI ref.', width: 19, exact: true },
      { header: 'Proof', width: 7.5, align: 'center' },
      { header: 'Amount paid', width: 13.5, align: 'right', exact: true },
    ],
    data.payments.map((p) => [
      `${date(p.periodStart)} – ${date(p.periodEnd)}`,
      STATUS_LABEL[p.status],
      date(p.paidAt),
      p.method,
      p.reference ?? '—',
      p.hasProof ? 'Yes' : '—',
      m(p.paidPaise),
    ]),
    { emptyText: 'No settlements yet.', highlight: (i) => Boolean(data.payments[i]?.isThisStatement) },
  );
  layout.note(
    `The highlighted row is this statement. Lists up to ${PAYMENT_HISTORY_ROWS} of this seller's settlements created up to this one, latest period first. "Manual transfer" means Aadione paid outside the app; the specific method (bank transfer, UPI, …) is not recorded. A "Pending" or "Processing" settlement has not been paid yet.`,
  );

  // F. Final settlement summary
  layout.sectionTitle('F', 'Final settlement summary');
  layout.keyValues([
    ['Total payable', m(data.summary.totalPayablePaise)],
    ['Amount paid', m(data.summary.amountPaidPaise)],
    ['Remaining balance', m(data.summary.remainingPaise)],
    ['Settlement status', STATUS_LABEL[data.summary.status]],
    ['Paid on', s.paidAt ? dateTime(s.paidAt) : '—'],
    ['Transaction / UPI reference', s.payoutReference ?? '—'],
    ['Payment method', s.status === SettlementStatus.PAID ? 'Manual transfer (method not recorded)' : '—'],
    ['Payment proof', s.hasPayoutProof ? 'Attached — view it in the Aadione panel' : 'Not attached'],
  ]);

  footers(doc, layout, {
    reference: `${data.issuer.tradeName} · ${statementRef(data)} · Confidential — for ${data.seller.storeName} and ${data.issuer.tradeName} only`,
    notice: 'A record of earnings only. Aadione pays sellers manually outside the app; this document does not transfer money.',
  });
  doc.end();
  return done;
}
