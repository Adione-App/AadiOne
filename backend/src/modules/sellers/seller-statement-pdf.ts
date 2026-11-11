/**
 * Renders a seller settlement statement (seller-statement.service.ts) as a
 * branded, multi-page A4 PDF.
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

import { existsSync } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { SettlementStatus } from '../../shared';
import { moduleLogger } from '../../common/logger';
import { AADIONE_LOGO_PNG, AADIONE_LOGO_SIZE } from './statement-logo';
import type { StatementData } from './seller-statement.service';

/** Mirrors seller-statement.service PAYMENT_HISTORY_LIMIT (a type-only import keeps this module free of DB code). */
const PAYMENT_HISTORY_ROWS = 12;

const log = moduleLogger('seller-statement-pdf');

const GREEN = '#176230';
const DARK = '#0E2E22';
const MUTED = '#5C6B63';
const LINE = '#D8EDDA';
const ZEBRA = '#F5FBF6';
const PAGE = { margin: 40, footer: 46 };

/* -------------------------------------------------------------------------- */
/* Fonts                                                                      */
/* -------------------------------------------------------------------------- */

const FONT_FILES = {
  regular: 'NotoSans-Regular.ttf',
  bold: 'NotoSans-Bold.ttf',
  devaRegular: 'NotoSansDevanagari-Regular.ttf',
  devaBold: 'NotoSansDevanagari-Bold.ttf',
} as const;

/** assets/fonts next to the running code (backend/ in development and tests, /app in the image). */
function fontDir(): string | null {
  for (const dir of [path.resolve(process.cwd(), 'assets/fonts'), path.resolve(__dirname, '../../../assets/fonts')]) {
    if (Object.values(FONT_FILES).every((file) => existsSync(path.join(dir, file)))) return dir;
  }
  return null;
}

const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ᳐-᳿]/u;
/** Characters that belong to whichever run they sit in (spaces, joiners). */
const NEUTRAL = /[\s‌‍]/u;

interface Run {
  text: string;
  deva: boolean;
}

/** "उदयपुर Store 12" → [{उदयपुर ,deva}, {Store 12,latin}] — each drawn with its own font. */
export function scriptRuns(text: string): Run[] {
  const out: Run[] = [];
  for (const ch of text) {
    const deva = DEVANAGARI.test(ch);
    const last = out[out.length - 1];
    if (last && (NEUTRAL.test(ch) || last.deva === deva)) last.text += ch;
    else out.push({ text: ch, deva });
  }
  return out;
}

type Doc = PDFKit.PDFDocument;

interface TextStyle {
  size: number;
  bold?: boolean;
  color?: string;
}

class Typesetter {
  readonly embedded: boolean;
  /** The page being drawn (1-based) — kept by Layout and the footer pass. */
  pageNo = 1;

  constructor(
    private readonly doc: Doc,
    /** Test hook: every line of text as drawn, with its page number. */
    private readonly trace?: (text: string, page: number) => void,
  ) {
    const dir = fontDir();
    this.embedded = dir !== null;
    if (dir) {
      doc.registerFont('st-regular', path.join(dir, FONT_FILES.regular));
      doc.registerFont('st-bold', path.join(dir, FONT_FILES.bold));
      doc.registerFont('st-deva', path.join(dir, FONT_FILES.devaRegular));
      doc.registerFont('st-deva-bold', path.join(dir, FONT_FILES.devaBold));
    } else {
      log.error('statement fonts not found (assets/fonts) — using Helvetica; Hindi text cannot be shown');
    }
  }

  private fontFor(run: Run, bold: boolean): string {
    if (!this.embedded) return bold ? 'Helvetica-Bold' : 'Helvetica';
    if (run.deva) return bold ? 'st-deva-bold' : 'st-deva';
    return bold ? 'st-bold' : 'st-regular';
  }

  /** Without the embedded fonts, anything outside Latin-1 becomes "?" rather than garbage. */
  private safe(text: string): string {
    return this.embedded ? text : text.replace(/[−]/g, '-').replace(/[^\x20-\x7E -ÿ–—…·•‘’“”]/g, '?');
  }

  width(text: string, style: TextStyle): number {
    return scriptRuns(this.safe(text)).reduce((sum, run) => {
      this.doc.font(this.fontFor(run, Boolean(style.bold))).fontSize(style.size);
      return sum + this.doc.widthOfString(run.text);
    }, 0);
  }

  /** The text shortened (at a word, else a letter cluster) with "…" so it fits `maxWidth`. */
  fit(text: string, maxWidth: number, style: TextStyle): string {
    const clean = this.safe(text);
    if (this.width(clean, style) <= maxWidth) return clean;
    const words = clean.split(' ');
    while (words.length > 1) {
      words.pop();
      const candidate = `${words.join(' ')}…`;
      if (this.width(candidate, style) <= maxWidth) return candidate;
    }
    const clusters = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(clean)].map((s) => s.segment);
    while (clusters.length > 1) {
      clusters.pop();
      const candidate = `${clusters.join('')}…`;
      if (this.width(candidate, style) <= maxWidth) return candidate;
    }
    return '…';
  }

  /**
   * One line of (possibly mixed-script) text at (x, y), never wrapped. Too
   * long for `width`: shortened with "…" — or, with `shrink` (IDs, amounts,
   * which must never be cut), drawn in a smaller size down to 6 pt first.
   */
  draw(text: string, x: number, y: number, style: TextStyle & { width?: number; align?: 'left' | 'right' | 'center'; shrink?: boolean }) {
    if (style.shrink && style.width !== undefined) {
      let size = style.size;
      while (size > 6 && this.width(text, { ...style, size }) > style.width) size -= 0.25;
      style = { ...style, size };
    }
    const fitted = style.width !== undefined ? this.fit(text, style.width, style) : this.safe(text);
    this.trace?.(fitted, this.pageNo);
    const total = this.width(fitted, style);
    let cx = x;
    if (style.width !== undefined && style.align === 'right') cx = x + style.width - total;
    if (style.width !== undefined && style.align === 'center') cx = x + (style.width - total) / 2;
    for (const run of scriptRuns(fitted)) {
      this.doc.font(this.fontFor(run, Boolean(style.bold))).fontSize(style.size).fillColor(style.color ?? DARK);
      this.doc.text(run.text, cx, y, { lineBreak: false });
      cx += this.doc.widthOfString(run.text);
    }
  }

  /** A wrapped paragraph of fixed (Latin) wording. */
  paragraph(text: string, x: number, y: number, width: number, style: TextStyle) {
    this.trace?.(this.safe(text), this.pageNo);
    this.doc.font(style.bold ? this.fontFor({ text, deva: false }, true) : this.fontFor({ text, deva: false }, false)).fontSize(style.size).fillColor(style.color ?? DARK);
    this.doc.text(this.safe(text), x, y, { width });
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const rupees = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "₹1,23,456.78" (or "Rs. 1,23,456.78" without the embedded fonts); negative as "−₹12.00". */
export const formatMoney = (paise: number, embedded = true) =>
  `${paise < 0 ? (embedded ? '−' : '- ') : ''}${embedded ? '₹' : 'Rs. '}${rupees.format(Math.abs(paise) / 100)}`;

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
export const date = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const dateTime = (iso: string | null) => (iso ? `${dateTimeFmt.format(new Date(iso))} IST` : '—');

export const STATUS_LABEL: Record<SettlementStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  FAILED: 'Failed',
};

/** The statement's short reference: SEL code + the settlement's first 8 id characters. */
export const statementRef = (data: StatementData) => `STM-${data.seller.sellerCode}-${data.settlement.id.slice(0, 8).toUpperCase()}`;

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
  /** IDs and amounts: shrink to fit, never shorten with "…". */
  exact?: boolean;
}

class Layout {
  readonly t: Typesetter;

  constructor(
    private readonly doc: Doc,
    private readonly data: StatementData,
    trace?: (text: string, page: number) => void,
  ) {
    this.t = new Typesetter(doc, trace);
  }

  money = (paise: number) => formatMoney(paise, this.t.embedded);

  get width() {
    return this.doc.page.width - PAGE.margin * 2;
  }

  get bottom() {
    return this.doc.page.height - PAGE.margin - PAGE.footer;
  }

  ensure(height: number) {
    if (this.doc.y + height > this.bottom) this.newPage();
  }

  newPage() {
    this.doc.addPage();
    this.t.pageNo += 1;
    this.runningHeader();
  }

  runningHeader() {
    const { doc } = this;
    doc.image(AADIONE_LOGO_PNG, PAGE.margin, PAGE.margin - 6, { height: 22 });
    this.t.draw(
      `Seller settlement statement · ${this.data.seller.storeName} · ${date(this.data.settlement.periodStart)} – ${date(this.data.settlement.periodEnd)}`,
      PAGE.margin + 90,
      PAGE.margin,
      { size: 8.5, color: MUTED, width: this.width - 90, align: 'right' },
    );
    doc.moveTo(PAGE.margin, PAGE.margin + 24).lineTo(PAGE.margin + this.width, PAGE.margin + 24).strokeColor(LINE).lineWidth(1).stroke();
    doc.x = PAGE.margin;
    doc.y = PAGE.margin + 36;
  }

  sectionTitle(letter: string, title: string) {
    this.ensure(48);
    const { doc } = this;
    doc.y += 8;
    const y = doc.y;
    doc.roundedRect(PAGE.margin, y, 20, 20, 5).fill(GREEN);
    this.t.draw(letter, PAGE.margin, y + 4, { size: 10, bold: true, color: '#FFFFFF', width: 20, align: 'center' });
    this.t.draw(title, PAGE.margin + 28, y + 2, { size: 12.5, bold: true, color: DARK, width: this.width - 28 });
    doc.x = PAGE.margin;
    doc.y = y + 28;
  }

  /**
   * "label — value" pairs inside a light box, two per row; an entry marked
   * `full` (a long address or name) takes a whole row.
   */
  keyValues(pairs: [string, string, 'full'?][]) {
    const { doc } = this;
    const colWidth = (this.width - 24) / 2;
    const rowHeight = 31;
    // Lay out: half entries pair up; a full entry closes the current row.
    const cells: { label: string; value: string; row: number; col: 0 | 1; full: boolean }[] = [];
    let row = 0;
    let col: 0 | 1 = 0;
    for (const [label, value, full] of pairs) {
      if (full) {
        if (col === 1) row += 1;
        cells.push({ label, value, row, col: 0, full: true });
        row += 1;
        col = 0;
      } else {
        cells.push({ label, value, row, col, full: false });
        if (col === 1) row += 1;
        col = col === 0 ? 1 : 0;
      }
    }
    const rows = row + (col === 1 ? 1 : 0);
    const height = rows * rowHeight + 10;
    this.ensure(height);
    const top = doc.y;
    doc.roundedRect(PAGE.margin, top, this.width, height, 8).fillAndStroke(ZEBRA, LINE);
    for (const cell of cells) {
      const x = PAGE.margin + 12 + cell.col * colWidth;
      const y = top + 7 + cell.row * rowHeight;
      const width = (cell.full ? colWidth * 2 : colWidth) - 14;
      this.t.draw(cell.label.toUpperCase(), x, y, { size: 7, color: MUTED, width });
      this.t.draw(cell.value || '—', x, y + 10, { size: 9.5, bold: true, color: DARK, width, shrink: true });
    }
    doc.x = PAGE.margin;
    doc.y = top + height + 6;
  }

  /** A table whose header repeats on each page; a row is never split. */
  table(columns: Column[], rows: string[][], options: { emptyText?: string; boldLastRow?: boolean; highlight?: (index: number) => boolean } = {}) {
    const { doc } = this;
    const total = columns.reduce((sum, c) => sum + c.width, 0);
    const cols = columns.map((c) => ({ ...c, width: (c.width * this.width) / total }));
    const headerHeight = 20;
    const rowHeight = 18;
    const pad = 5;

    const drawHeader = () => {
      const y = doc.y;
      doc.rect(PAGE.margin, y, this.width, headerHeight).fill(GREEN);
      let x = PAGE.margin;
      for (const c of cols) {
        this.t.draw(c.header, x + pad, y + 5, { size: 8, bold: true, color: '#FFFFFF', width: c.width - pad * 2, align: c.align ?? 'left' });
        x += c.width;
      }
      doc.y = y + headerHeight;
    };

    this.ensure(headerHeight + rowHeight * Math.min(2, Math.max(1, rows.length)));
    drawHeader();
    if (rows.length === 0) {
      this.t.draw(options.emptyText ?? 'None.', PAGE.margin + pad, doc.y + 5, { size: 9, color: MUTED, width: this.width - pad * 2 });
      doc.y += rowHeight + 6;
      doc.x = PAGE.margin;
      return;
    }
    rows.forEach((row, index) => {
      if (doc.y + rowHeight > this.bottom) {
        this.newPage();
        drawHeader();
      }
      const y = doc.y;
      const last = Boolean(options.boldLastRow) && index === rows.length - 1;
      const strong = last;
      if (last || options.highlight?.(index)) doc.rect(PAGE.margin, y, this.width, rowHeight).fill('#E8F4EA');
      else if (index % 2 === 1) doc.rect(PAGE.margin, y, this.width, rowHeight).fill(ZEBRA);
      let x = PAGE.margin;
      cols.forEach((c, i) => {
        this.t.draw(row[i] ?? '', x + pad, y + 4.5, { size: 8.5, bold: strong, color: DARK, width: c.width - pad * 2, align: c.align ?? 'left', shrink: c.exact });
        x += c.width;
      });
      doc.moveTo(PAGE.margin, y + rowHeight).lineTo(PAGE.margin + this.width, y + rowHeight).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.y = y + rowHeight;
    });
    doc.x = PAGE.margin;
    doc.y += 6;
  }

  note(text: string) {
    this.ensure(28);
    this.t.paragraph(text, PAGE.margin, this.doc.y, this.width, { size: 8, color: MUTED });
    this.doc.x = PAGE.margin;
    this.doc.y += 4;
  }
}

function firstPageHeader(doc: Doc, layout: Layout, data: StatementData) {
  const width = layout.width;
  const logoHeight = 44;
  doc.image(AADIONE_LOGO_PNG, PAGE.margin, PAGE.margin, { height: logoHeight, width: (AADIONE_LOGO_SIZE.width / AADIONE_LOGO_SIZE.height) * logoHeight });
  const right = { width: width - 200, align: 'right' as const };
  layout.t.draw('Seller Settlement Statement', PAGE.margin + 200, PAGE.margin, { size: 16, bold: true, ...right });
  layout.t.draw(`Statement ${statementRef(data)}`, PAGE.margin + 200, PAGE.margin + 24, { size: 9, color: MUTED, ...right });
  layout.t.draw(`Generated ${dateTime(data.generatedAt)}`, PAGE.margin + 200, PAGE.margin + 36, { size: 9, color: MUTED, ...right });

  const issuer = data.issuer;
  const lines = [
    [issuer.tradeName, issuer.legalName ? `operated by ${issuer.legalName}` : null].filter(Boolean).join(' — '),
    issuer.address,
    [issuer.gstin ? `GSTIN ${issuer.gstin}` : null, issuer.supportEmail, issuer.supportPhone, issuer.website].filter(Boolean).join('  ·  '),
  ].filter((line): line is string => Boolean(line));
  let y = PAGE.margin + 54;
  for (const line of lines) {
    layout.t.draw(line, PAGE.margin, y, { size: 8.5, color: MUTED, width });
    y += 12;
  }
  y += 6;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + width, y).strokeColor(GREEN).lineWidth(1.5).stroke();
  doc.x = PAGE.margin;
  doc.y = y + 4;
}

function footers(doc: Doc, layout: Layout, data: StatementData) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    layout.t.pageNo = i - range.start + 1;
    const width = doc.page.width - PAGE.margin * 2;
    const y = doc.page.height - PAGE.margin - 22;
    // Writing below the bottom margin must not start a new page.
    const margins = doc.page.margins;
    doc.page.margins = { ...margins, bottom: 0 };
    doc.moveTo(PAGE.margin, y - 6).lineTo(PAGE.margin + width, y - 6).strokeColor(LINE).lineWidth(0.75).stroke();
    layout.t.draw(`${data.issuer.tradeName} · ${statementRef(data)} · Confidential — for ${data.seller.storeName} and ${data.issuer.tradeName} only`, PAGE.margin, y, {
      size: 7.5,
      color: MUTED,
      width: width - 90,
    });
    layout.t.draw(`Page ${i - range.start + 1} of ${range.count}`, PAGE.margin, y, { size: 8, bold: true, width, align: 'right' });
    layout.t.draw('A record of earnings only. Aadione pays sellers manually outside the app; this document does not transfer money.', PAGE.margin, y + 11, {
      size: 7,
      color: MUTED,
      width,
    });
    doc.page.margins = margins;
  }
}

/** The statement as PDF bytes. `trace` (tests) receives every line of text drawn, with its page. */
export function renderStatementPdf(
  data: StatementData,
  options: { compress?: boolean; trace?: (text: string, page: number) => void } = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
    bufferPages: true,
    compress: options.compress ?? true,
    info: {
      Title: `Seller settlement statement ${statementRef(data)}`,
      Author: data.issuer.tradeName,
      Subject: `${data.seller.storeName} — ${date(data.settlement.periodStart)} to ${date(data.settlement.periodEnd)}`,
      Creator: 'Aadione',
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const layout = new Layout(doc, data, options.trace);
  const m = layout.money;
  const s = data.settlement;
  firstPageHeader(doc, layout, data);

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

  footers(doc, layout, data);
  doc.end();
  return done;
}
