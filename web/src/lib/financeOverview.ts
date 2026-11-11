/**
 * Financial Overview (admin) — the API's shapes and the page's pure helpers.
 * Every figure comes from GET /admin/finance/overview (backend
 * modules/finance/finance-overview.service.ts); nothing is calculated here
 * beyond choosing which series a chart shows.
 */

export const FINANCE_PERIODS = [
  { key: 'TODAY', label: 'Today' },
  { key: 'YESTERDAY', label: 'Yesterday' },
  { key: 'LAST_7_DAYS', label: 'Last 7 days' },
  { key: 'THIS_WEEK', label: 'This week' },
  { key: 'THIS_MONTH', label: 'This month' },
  { key: 'LAST_MONTH', label: 'Last month' },
  { key: 'THIS_YEAR', label: 'This year' },
  { key: 'LIFETIME', label: 'Lifetime' },
  { key: 'CUSTOM', label: 'Custom range' },
] as const;
export type FinancePeriod = (typeof FINANCE_PERIODS)[number]['key'];

export interface FinanceFilterState {
  period: FinancePeriod;
  /** CUSTOM only, "YYYY-MM-DD" inclusive. */
  from?: string;
  to?: string;
  sellerId?: string;
}

export interface Figures {
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
  refundCostBeyondReversalsPaise: number;
  unclassifiedRefundsPaise: number;
  aadioneNetAfterCouponsPaise: number;
  reconciliationGapPaise: number;
}

export interface Measures {
  orders: number;
  codOrders: number;
  onlineOrders: number;
  ordersWithDeliveryFee: number;
  freeDeliveryOrders: number;
  ordersWithPlatformFee: number;
  multiSellerOrders: number;
  ordersWithRefund: number;
  refundPending: number;
  cancelledPortions: number;
  cancelledValue: number;
}

export interface TrendPoint {
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
  deliveryPaise: number;
  platformPaise: number;
  sharedOrders: number;
  aadioneNetPaise: number;
}

export interface FinanceOverview {
  generatedAt: string;
  timezone: string;
  period: { preset: FinancePeriod; fromDate: string | null; toDate: string | null; label: string };
  seller: { id: string; code: string; name: string } | null;
  measures: Measures;
  figures: Figures;
  byMethod: { COD: Figures; ONLINE: Figures };
  sharedFees: { orders: number; deliveryPaise: number; platformPaise: number } | null;
  pipeline: {
    inProgress: { orders: number; codOrders: number; onlineOrders: number; codToCollectPaise: number; onlinePaidPaise: number };
    awaitingPayment: { orders: number; amountPaise: number };
    paymentFailed: { orders: number; amountPaise: number };
    cancelled: { orders: number; amountPaise: number };
    cancelledFeesRefunded: { deliveryPaise: number; platformPaise: number; combinedPaise: number } | null;
    refundsPendingPaise: number;
  };
  dataQuality: {
    deliveredUnpaid: { orders: number; amountPaise: number };
    deliveredWithoutTime: number;
    payableMismatch: { orders: number; amountPaise: number };
    notes: string[];
  };
  trend: { daily: TrendPoint[]; weekly: TrendPoint[]; monthly: TrendPoint[] };
  sellers: SellerFinanceRow[];
  unallocatedFees: { orders: number; deliveryPaise: number; platformPaise: number } | null;
}

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

export interface FinanceOrderPage {
  items: FinanceOrderRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface FinanceSellerOption {
  id: string;
  code: string;
  name: string;
}

/** A custom range is complete when both dates are set and in order. */
export function customRangeProblem(from?: string, to?: string): string | null {
  if (!from || !to) return 'Choose both a start and an end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  return null;
}

/** The query string for the API — the same for the page, the order list and the PDF. */
export function financeQuery(filter: FinanceFilterState, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({ period: filter.period });
  if (filter.period === 'CUSTOM') {
    if (filter.from) params.set('from', filter.from);
    if (filter.to) params.set('to', filter.to);
  }
  if (filter.sellerId) params.set('sellerId', filter.sellerId);
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params.toString();
}

/** The downloaded PDF's name — the server's own naming (finance-overview.service.ts). */
export function financePdfFileName(view: Pick<FinanceOverview, 'period' | 'seller'>): string {
  const range = view.period.fromDate ? `${view.period.fromDate}-to-${view.period.toDate}` : 'lifetime';
  return `Aadione-Financial-Overview-${view.seller ? view.seller.code : 'all-sellers'}-${range}.pdf`;
}

export type TrendScale = 'daily' | 'weekly' | 'monthly';

/** At most this many bars per chart; older buckets are summarised by the tables / PDF. */
export const MAX_CHART_BARS = 31;

/** The chart's series: the selected scale, its latest MAX_CHART_BARS buckets. */
export function chartSeries(trend: FinanceOverview['trend'], scale: TrendScale): { points: TrendPoint[]; hidden: number } {
  const all = trend[scale];
  const points = all.slice(-MAX_CHART_BARS);
  return { points, hidden: all.length - points.length };
}

/** The scale that best fits the period: daily up to a month, weekly up to ~6 months, then monthly. */
export function defaultScale(trend: FinanceOverview['trend']): TrendScale {
  if (trend.daily.length <= MAX_CHART_BARS) return 'daily';
  if (trend.weekly.length <= MAX_CHART_BARS) return 'weekly';
  return 'monthly';
}

const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Bar label for a bucket starting on `start` ("YYYY-MM-DD"). */
export function bucketLabel(start: string, scale: TrendScale): string {
  const d = new Date(`${start}T12:00:00.000Z`);
  return scale === 'monthly' ? monthFmt.format(d) : dayFmt.format(d);
}

/** "₹1.2K", "₹3.4L", "₹1.1Cr" — the Indian short scale, for axis labels only. */
export function compactRupees(paise: number): string {
  const rupees = paise / 100;
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '−' : '';
  const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/\.?0+$/, ''));
  if (abs >= 1e7) return `${sign}₹${fmt(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${fmt(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${fmt(abs / 1e3)}K`;
  return `${sign}₹${fmt(abs)}`;
}
