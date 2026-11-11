/**
 * Admin › Finance › Financial Overview — Aadione's money in one place, for any
 * period and any seller: order revenue, the sellers' money, Aadione's own
 * earnings (delivery fees + platform fees + commission), COD vs Online,
 * refunds, and the trend. Read-only: nothing here moves money.
 *
 * Every number comes from GET /admin/finance/overview — the same calculation
 * the PDF ("Download PDF") prints for the exact filters selected here.
 */

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { adminErrorMessage } from '@/lib/marketplace';
import { todayIsoInIndia } from '@/lib/dashboardDate';
import { adminOrderTabOf } from '@/lib/v2Orders';
import {
  bucketLabel,
  chartSeries,
  customRangeProblem,
  defaultScale,
  financePdfFileName,
  financeQuery,
  FINANCE_PERIODS,
  type FinanceFilterState,
  type FinanceOrderPage,
  type FinanceOverview,
  type FinancePeriod,
  type FinanceSellerOption,
  type TrendScale,
} from '@/lib/financeOverview';
import { saveBlob } from '@/components/SettlementFiles';
import { BarChart, DonutChart } from '@/components/FinanceCharts';
import { Button, EmptyState, ErrorBanner, Icon, Panel, Pill, Spinner, StatCard, TableWrap, Td, Th, inputClass, type Tone } from '@/components/ui';
import type { IconName } from '@/components/ui';

const COLOURS = {
  delivery: '#3B82F6',
  platform: '#8B5CF6',
  commission: '#1E8E3E',
  seller: '#F59E0B',
  cod: '#F59E0B',
  online: '#3B82F6',
};

const m = formatPaise;

function Row({ label, value, strong, hint }: { label: string; value: string; strong?: boolean; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className={strong ? 'font-semibold text-gray-900' : 'text-gray-600'}>
        {label}
        {hint && <span className="block text-xs font-normal text-gray-500">{hint}</span>}
      </dt>
      <dd className={`whitespace-nowrap text-right ${strong ? 'font-bold text-gray-900' : 'font-medium text-gray-900'}`}>{value}</dd>
    </div>
  );
}

function Card({ icon, label, value, foot, tone }: { icon: IconName; label: string; value: string; foot: React.ReactNode; tone: Tone }) {
  return <StatCard icon={icon} label={label} value={value} foot={foot} tone={tone} />;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

function Filters({
  filter,
  onChange,
  sellers,
  onDownload,
  downloading,
  canDownload,
}: {
  filter: FinanceFilterState;
  onChange: (next: FinanceFilterState) => void;
  sellers: FinanceSellerOption[];
  onDownload: () => void;
  downloading: boolean;
  canDownload: boolean;
}) {
  const today = todayIsoInIndia();
  const [from, setFrom] = useState(filter.from ?? today);
  const [to, setTo] = useState(filter.to ?? today);
  const problem = customRangeProblem(from, to);

  const pick = (period: FinancePeriod) => {
    if (period === 'CUSTOM') onChange({ ...filter, period, from, to });
    else onChange({ period, sellerId: filter.sellerId });
  };

  return (
    <div className="space-y-3 rounded-2xl border border-gray-200/80 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
        {FINANCE_PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => pick(p.key)}
            aria-pressed={filter.period === p.key}
            className={`min-h-10 rounded-full px-3.5 text-sm font-medium transition ${
              filter.period === p.key ? 'bg-brand-500 text-white shadow-sm' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {filter.period === 'CUSTOM' && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">From</span>
              <input type="date" className={inputClass} value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">To</span>
              <input type="date" className={inputClass} value={to} max={today} onChange={(e) => setTo(e.target.value)} />
            </label>
            <Button variant="secondary" disabled={Boolean(problem)} onClick={() => onChange({ ...filter, period: 'CUSTOM', from, to })} title={problem ?? undefined}>
              Apply range
            </Button>
          </>
        )}
        <label className="block min-w-[220px] flex-1 sm:max-w-sm">
          <span className="mb-1 block text-xs font-medium text-gray-600">Seller</span>
          <select className={inputClass} value={filter.sellerId ?? ''} onChange={(e) => onChange({ ...filter, sellerId: e.target.value || undefined })}>
            <option value="">All sellers</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <Button onClick={onDownload} disabled={!canDownload || downloading}>
            <Icon name="upload" className="h-4 w-4 rotate-180" />
            {downloading ? 'Preparing PDF…' : 'Download PDF'}
          </Button>
        </div>
      </div>
      {filter.period === 'CUSTOM' && problem && <p className="text-xs text-danger-500">{problem}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function FinancialOverviewPage() {
  const [filter, setFilter] = useState<FinanceFilterState>({ period: 'THIS_MONTH' });
  const [scale, setScale] = useState<TrendScale | null>(null);
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const query = financeQuery(filter);

  useEffect(() => {
    setPage(1);
    setScale(null);
  }, [query]);

  const sellers = useQuery({ queryKey: ['finance', 'sellers'], queryFn: () => api.get<FinanceSellerOption[]>('/admin/finance/sellers'), staleTime: 5 * 60_000 });
  const overview = useQuery({
    queryKey: ['finance', 'overview', query],
    queryFn: () => api.get<FinanceOverview>(`/admin/finance/overview?${query}`),
    placeholderData: keepPreviousData,
  });
  const orders = useQuery({
    queryKey: ['finance', 'orders', query, page],
    queryFn: () => api.get<FinanceOrderPage>(`/admin/finance/orders?${financeQuery(filter, { page, pageSize: 20 })}`),
    placeholderData: keepPreviousData,
  });

  const download = async () => {
    if (!overview.data) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await api.getBlob(`/admin/finance/overview.pdf?${query}`);
      saveBlob(blob, financePdfFileName(overview.data));
    } catch (error) {
      setDownloadError(adminErrorMessage(error, 'The PDF could not be prepared. Please try again.'));
    } finally {
      setDownloading(false);
    }
  };

  const v = overview.data;
  const stale = overview.isPlaceholderData;

  return (
    <div className="space-y-5">
      <Filters
        key={filter.period === 'CUSTOM' ? 'custom' : 'preset'}
        filter={filter}
        onChange={setFilter}
        sellers={sellers.data ?? []}
        onDownload={download}
        downloading={downloading}
        canDownload={Boolean(v) && !stale}
      />
      <ErrorBanner message={downloadError} />
      {overview.isError && <ErrorBanner message={adminErrorMessage(overview.error, 'The financial overview could not be loaded.')} />}
      {!v && overview.isLoading && <Spinner label="Adding up the orders…" />}
      {v && <Overview v={v} stale={stale} scale={scale ?? defaultScale(v.trend)} onScale={setScale} onSeller={(id) => setFilter({ ...filter, sellerId: id })} />}
      {v && (
        <OrdersPanel
          data={orders.data}
          loading={orders.isLoading}
          error={orders.isError ? adminErrorMessage(orders.error, 'The orders could not be loaded.') : null}
          page={page}
          onPage={setPage}
          sellerView={Boolean(v.seller)}
        />
      )}
    </div>
  );
}

function Overview({ v, stale, scale, onScale, onSeller }: { v: FinanceOverview; stale: boolean; scale: TrendScale; onScale: (s: TrendScale) => void; onSeller: (id: string) => void }) {
  const f = v.figures;
  const ms = v.measures;
  const range = v.period.fromDate ? (v.period.fromDate === v.period.toDate ? v.period.fromDate : `${v.period.fromDate} to ${v.period.toDate}`) : 'all time';
  const rate = f.sellerPricePaise > 0 ? `${((f.commissionPaise / f.sellerPricePaise) * 100).toFixed(2)}%` : '—';
  const { points, hidden } = chartSeries(v.trend, scale);
  const bars = points.map((p) => ({ label: bucketLabel(p.start, scale), values: p as unknown as Record<string, number> }));

  return (
    <div className={`space-y-5 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <Pill tone="brand">{v.period.label}</Pill>
        <span>{range}</span>
        <span className="text-gray-300">·</span>
        {v.seller ? (
          <span>
            Seller <span className="font-semibold text-gray-900">{v.seller.name}</span> ({v.seller.code})
          </span>
        ) : (
          <span>All sellers</span>
        )}
        <span className="text-gray-300">·</span>
        <span>
          {ms.orders} delivered {ms.orders === 1 ? 'order' : 'orders'}
        </span>
      </div>

      {/* 1–9: summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card icon="rupee" tone="brand" label="Total order revenue" value={m(f.grossRevenuePaise)} foot={`Net ${m(f.netRevenuePaise)} after refunds`} />
        <Card icon="store" tone="amber" label={v.seller ? "Seller's earnings" : 'Seller earnings'} value={m(f.sellerNetPaise)} foot={`${m(f.sellerPayablePaise)} before ${m(f.sellerDeductionsPaise)} refund deductions`} />
        <Card icon="barChart" tone="brand" label="Total Aadione earnings" value={m(f.aadioneGrossPaise)} foot={`Net ${m(f.aadioneNetPaise)} · delivery + platform fees + commission`} />
        <Card icon="delivery" tone="amber" label="Total COD payments" value={m(v.byMethod.COD.grossRevenuePaise)} foot={`${ms.codOrders} orders · net ${m(v.byMethod.COD.netRevenuePaise)}`} />
        <Card icon="zap" tone="blue" label="Total online payments" value={m(v.byMethod.ONLINE.grossRevenuePaise)} foot={`${ms.onlineOrders} orders · net ${m(v.byMethod.ONLINE.netRevenuePaise)}`} />
        <Card icon="delivery" tone="blue" label="Total delivery charges" value={m(f.deliveryPaise)} foot={`${ms.ordersWithDeliveryFee} paid · ${ms.freeDeliveryOrders} free delivery`} />
        <Card icon="clipboard" tone="purple" label="Total platform fees" value={m(f.platformPaise)} foot={`${ms.ordersWithPlatformFee} orders with a platform fee`} />
        <Card icon="gift" tone="brand" label="Total seller commission" value={m(f.commissionPaise)} foot={`Net ${m(f.netCommissionPaise)} · effective ${rate}`} />
        <Card icon="alert" tone="red" label="Total refunds / reversals" value={m(f.refundsPaise)} foot={`Commission reversed ${m(f.commissionReversedPaise)} · ${ms.ordersWithRefund} orders`} />
      </div>

      {v.dataQuality.notes.length > 0 && (
        <div className="rounded-xl border border-warn-500/40 bg-warn-50 p-4 text-sm text-gray-800">
          <p className="font-semibold">Data checks</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {v.dataQuality.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Where the money goes">
          <dl className="divide-y divide-gray-100 text-sm">
            <Row label="Total order revenue" value={m(f.grossRevenuePaise)} hint="Delivered orders with payment recorded" />
            <Row label="Refunds after delivery" value={`−${m(f.refundsPaise)}`} />
            <Row label="Net order revenue" value={m(f.netRevenuePaise)} strong />
            <Row label="Seller product sales (seller price)" value={m(f.sellerPricePaise)} />
            <Row label="Commission" value={`−${m(f.commissionPaise)}`} />
            <Row label="Refund deductions" value={`−${m(f.sellerDeductionsPaise)}`} />
            <Row label="Net seller earnings" value={m(f.sellerNetPaise)} strong />
            <Row label="Delivery charges" value={m(f.deliveryPaise)} />
            <Row label="Platform fees" value={m(f.platformPaise)} />
            <Row label="Commission, net of reversals" value={m(f.netCommissionPaise)} />
            <Row label="Net Aadione earnings" value={m(f.aadioneNetPaise)} strong />
            <Row label="Aadione-funded coupons" value={`−${m(f.netCouponCostPaise)}`} hint="Paid by Aadione, never by the seller" />
            {f.refundCostBeyondReversalsPaise !== 0 && <Row label="Refund rounding / not recovered" value={`−${m(f.refundCostBeyondReversalsPaise)}`} />}
            <Row label="Aadione after coupons and refund costs" value={m(f.aadioneNetAfterCouponsPaise)} strong />
          </dl>
          <p className={`mt-3 rounded-lg px-3 py-2 text-xs ${f.reconciliationGapPaise === 0 ? 'bg-brand-50 text-brand-700' : 'bg-warn-50 text-gray-800'}`}>
            {f.reconciliationGapPaise === 0
              ? 'Reconciled: net seller earnings + Aadione after coupons = net order revenue, to the paisa. Seller money is never counted as Aadione income.'
              : `Does not reconcile by ${m(f.reconciliationGapPaise)} — see the data checks above.`}
            {f.unclassifiedRefundsPaise > 0 && ` ${m(f.unclassifiedRefundsPaise)} of refunds could not be attributed.`}
          </p>
        </Panel>

        <Panel title="Payment methods">
          <DonutChart
            centre={`${ms.orders} orders`}
            parts={[
              { label: 'Cash on delivery', value: v.byMethod.COD.grossRevenuePaise, colour: COLOURS.cod, detail: `${ms.codOrders} orders · ${m(v.byMethod.COD.refundsPaise)} refunded` },
              { label: 'Online', value: v.byMethod.ONLINE.grossRevenuePaise, colour: COLOURS.online, detail: `${ms.onlineOrders} orders · ${m(v.byMethod.ONLINE.refundsPaise)} refunded` },
            ]}
          />
          <dl className="mt-4 divide-y divide-gray-100 text-sm">
            <Row label="COD still to collect (orders on the way)" value={m(v.pipeline.inProgress.codToCollectPaise)} hint={`${v.pipeline.inProgress.codOrders} orders — not revenue until delivered`} />
            <Row label="Online paid, awaiting delivery" value={m(v.pipeline.inProgress.onlinePaidPaise)} hint={`${v.pipeline.inProgress.onlineOrders} orders`} />
            <Row label="Online checkouts awaiting payment" value={m(v.pipeline.awaitingPayment.amountPaise)} hint={`${v.pipeline.awaitingPayment.orders} — not orders yet`} />
            <Row label="Online payments failed" value={m(v.pipeline.paymentFailed.amountPaise)} hint={`${v.pipeline.paymentFailed.orders} — never revenue`} />
            <Row label="Refunds approved, not yet completed" value={m(v.pipeline.refundsPendingPaise)} />
          </dl>
          <p className="mt-2 text-xs text-gray-500">COD and Online are how customers paid — the same revenue, never added twice.</p>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Delivery charges and platform fees">
          <dl className="divide-y divide-gray-100 text-sm">
            <Row label="Delivery charges collected" value={m(f.deliveryPaise)} hint={`${ms.ordersWithDeliveryFee} orders with a charge · ${ms.freeDeliveryOrders} free delivery (₹0)`} />
            <Row label="Delivery charges refunded" value={m(f.deliveryRefundedPaise)} />
            <Row label="Net delivery charge earnings" value={m(f.netDeliveryPaise)} strong />
            <Row label="Platform fees collected" value={m(f.platformPaise)} hint={`${ms.ordersWithPlatformFee} orders with a platform fee`} />
            <Row label="Platform fees refunded" value={m(f.platformRefundedPaise)} />
            <Row label="Net platform fee earnings" value={m(f.netPlatformPaise)} strong />
          </dl>
          {v.sharedFees && (
            <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Shared, not allocated to this seller: {v.sharedFees.orders} multi-seller {v.sharedFees.orders === 1 ? 'order' : 'orders'} with {m(v.sharedFees.deliveryPaise)} delivery and{' '}
              {m(v.sharedFees.platformPaise)} platform fees. Fees count for a seller only when it is the order's only seller.
            </p>
          )}
          {v.unallocatedFees && (v.unallocatedFees.deliveryPaise > 0 || v.unallocatedFees.platformPaise > 0) && (
            <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
              {m(v.unallocatedFees.deliveryPaise + v.unallocatedFees.platformPaise)} of these fees come from {v.unallocatedFees.orders} multi-seller orders and are not allocated to any one seller.
            </p>
          )}
          {v.pipeline.cancelledFeesRefunded && (
            <p className="mt-2 text-xs text-gray-500">
              Delivered orders have no fee refunds — fees are refunded only when a whole order is cancelled. Refunded on cancelled orders in this period (never earned):{' '}
              {m(v.pipeline.cancelledFeesRefunded.deliveryPaise)} delivery, {m(v.pipeline.cancelledFeesRefunded.platformPaise)} platform
              {v.pipeline.cancelledFeesRefunded.combinedPaise > 0 && `, ${m(v.pipeline.cancelledFeesRefunded.combinedPaise)} combined (older refunds)`}.
            </p>
          )}
        </Panel>

        <Panel title="Aadione earnings mix">
          <DonutChart
            centre={m(f.aadioneGrossPaise).replace(/\.\d\d$/, '')}
            parts={[
              { label: 'Delivery charges', value: f.deliveryPaise, colour: COLOURS.delivery },
              { label: 'Platform fees', value: f.platformPaise, colour: COLOURS.platform },
              { label: 'Seller commission', value: f.commissionPaise, colour: COLOURS.commission, detail: `${m(f.commissionReversedPaise)} reversed by refunds` },
            ]}
          />
        </Panel>
      </div>

      {/* The two trend charts: side by side on wide screens, stacked below that; same scale, same height. */}
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel
          title="Earnings trend"
          bodyClass="px-5 pb-4"
          action={
            <div className="flex gap-0.5 rounded-lg bg-gray-100 p-0.5" role="group" aria-label="Chart scale">
              {(['daily', 'weekly', 'monthly'] as const).map((s) => (
                <button key={s} type="button" onClick={() => onScale(s)} aria-pressed={scale === s} className={`min-h-8 rounded-md px-2.5 text-xs font-semibold capitalize ${scale === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'}`}>
                  {s}
                </button>
              ))}
            </div>
          }
        >
          <p className="mb-2 truncate text-xs text-gray-500" title={hidden > 0 ? `${hidden} earlier periods are in the PDF.` : undefined}>
            Aadione earnings by {scale === 'daily' ? 'day' : scale === 'weekly' ? 'week (from Monday)' : 'month'}{hidden > 0 && ` · latest ${points.length} shown`}
          </p>
          <BarChart
            stacked
            data={bars}
            series={[
              { key: 'deliveryPaise', label: 'Delivery charges', colour: COLOURS.delivery },
              { key: 'platformPaise', label: 'Platform fees', colour: COLOURS.platform },
              { key: 'commissionPaise', label: 'Commission', colour: COLOURS.commission },
            ]}
          />
        </Panel>

        {/* Same header height as the trend chart's (its scale switch), so both charts line up. */}
        <Panel title="Seller earnings vs Aadione earnings" bodyClass="px-5 pb-4" action={<span aria-hidden="true" className="block h-9" />}>
          <p className="mb-2 truncate text-xs text-gray-500">
            Net, by {scale === 'daily' ? 'day' : scale === 'weekly' ? 'week' : 'month'} · same Daily / Weekly / Monthly choice{hidden > 0 && ` · latest ${points.length} shown`}
          </p>
          <BarChart
            data={bars}
            series={[
              { key: 'sellerNetPaise', label: 'Net seller earnings', colour: COLOURS.seller },
              { key: 'aadioneNetPaise', label: 'Net Aadione earnings', colour: COLOURS.commission },
            ]}
          />
        </Panel>
      </div>

      <Panel title={v.seller ? 'This seller' : `Sellers (${v.sellers.length})`} bodyClass="p-0">
        <SellerTable v={v} onSeller={onSeller} />
      </Panel>

      <Panel title="Not counted as revenue">
        <dl className="grid gap-x-8 text-sm sm:grid-cols-2">
          <Row label="Orders in progress" value={`${v.pipeline.inProgress.orders}`} hint="Placed, not delivered yet" />
          <Row label={v.seller ? 'Cancelled / rejected seller orders' : 'Cancelled orders'} value={`${v.pipeline.cancelled.orders} · ${m(v.pipeline.cancelled.amountPaise)}`} />
          <Row label="Cancelled seller portions in delivered orders" value={`${ms.cancelledPortions} · ${m(ms.cancelledValue)}`} />
          <Row label="Delivered, payment not recorded" value={`${v.dataQuality.deliveredUnpaid.orders} · ${m(v.dataQuality.deliveredUnpaid.amountPaise)}`} />
        </dl>
        <p className="mt-2 text-xs text-gray-500">
          Revenue counts delivered orders whose payment is recorded, by delivery date ({v.timezone}). Refunds are shown against their order, including refunds made later. Generated{' '}
          {new Date(v.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.
        </p>
      </Panel>
    </div>
  );
}

function SellerTable({ v, onSeller }: { v: FinanceOverview; onSeller: (id: string) => void }) {
  if (v.sellers.length === 0) return <div className="p-5"><EmptyState title="No delivered orders" hint="Nothing was delivered for this selection." /></div>;
  return (
    <TableWrap>
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <Th>Seller</Th>
            <Th className="text-right">Orders</Th>
            <Th className="text-right">Sales</Th>
            <Th className="text-right">COD / Online</Th>
            <Th className="text-right">Commission</Th>
            <Th className="text-right">Deductions</Th>
            <Th className="text-right">Seller net</Th>
            <Th className="text-right">Own fees</Th>
            <Th className="text-right">Aadione net</Th>
          </tr>
        </thead>
        <tbody>
          {v.sellers.map((s) => (
            <tr key={s.sellerId} className="border-t border-gray-100">
              <Td>
                {v.seller ? (
                  <span className="font-medium text-gray-900">{s.sellerName}</span>
                ) : (
                  <button type="button" className="text-left font-medium text-brand-700 hover:underline" onClick={() => onSeller(s.sellerId)}>
                    {s.sellerName}
                  </button>
                )}
                <span className="block text-xs text-gray-500">
                  {s.sellerCode}
                  {s.sharedOrders > 0 && ` · ${s.sharedOrders} shared orders`}
                </span>
              </Td>
              <Td className="text-right">{s.orders}</Td>
              <Td className="text-right">{m(s.sellerPricePaise)}</Td>
              <Td className="text-right text-xs">
                {m(s.codProductsPaise)}
                <span className="block text-gray-500">{m(s.onlineProductsPaise)}</span>
              </Td>
              <Td className="text-right">
                {m(s.commissionPaise)}
                {s.commissionReversedPaise > 0 && <span className="block text-xs text-gray-500">−{m(s.commissionReversedPaise)} reversed</span>}
              </Td>
              <Td className="text-right">{m(s.deductionsPaise)}</Td>
              <Td className="text-right font-semibold">{m(s.sellerNetPaise)}</Td>
              <Td className="text-right">{m(s.deliveryPaise + s.platformPaise)}</Td>
              <Td className="text-right font-semibold">{m(s.aadioneNetPaise)}</Td>
            </tr>
          ))}
          {v.unallocatedFees && v.unallocatedFees.deliveryPaise + v.unallocatedFees.platformPaise > 0 && (
            <tr className="border-t border-gray-100 bg-gray-50/60">
              <Td>
                <span className="text-gray-700">Shared fees of multi-seller orders</span>
                <span className="block text-xs text-gray-500">{v.unallocatedFees.orders} orders · not allocated to a seller</span>
              </Td>
              <Td className="text-right">—</Td>
              <Td className="text-right">—</Td>
              <Td className="text-right">—</Td>
              <Td className="text-right">—</Td>
              <Td className="text-right">—</Td>
              <Td className="text-right">—</Td>
              <Td className="text-right">{m(v.unallocatedFees.deliveryPaise + v.unallocatedFees.platformPaise)}</Td>
              <Td className="text-right font-semibold">{m(v.unallocatedFees.deliveryPaise + v.unallocatedFees.platformPaise)}</Td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="px-5 py-3 text-xs text-gray-500">
        Sales = seller price; COD / Online = what customers paid for these products after coupons. A multi-seller order counts once for each seller in it; its fees are listed separately.
      </p>
    </TableWrap>
  );
}

function OrdersPanel({ data, loading, error, page, onPage, sellerView }: { data?: FinanceOrderPage; loading: boolean; error: string | null; page: number; onPage: (p: number) => void; sellerView: boolean }) {
  return (
    <Panel title={`Delivered orders${data ? ` (${data.total})` : ''}`} bodyClass="p-0">
      <ErrorBanner message={error} />
      {loading && !data && <Spinner />}
      {data && data.items.length === 0 && <div className="p-5"><EmptyState title="No delivered orders" hint="Nothing was delivered for this selection." /></div>}
      {data && data.items.length > 0 && (
        <>
          <TableWrap>
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th>Delivered</Th>
                  <Th>Mode</Th>
                  <Th className="text-right">Revenue</Th>
                  <Th className="text-right">Delivery + platform</Th>
                  <Th className="text-right">Commission</Th>
                  <Th className="text-right">Refunded</Th>
                  <Th className="text-right">Seller net</Th>
                  <Th className="text-right">Aadione net</Th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o.orderId} className="border-t border-gray-100">
                    <Td>
                      <Link
                        to={`/orders?tab=${adminOrderTabOf('DELIVERED')}&search=${encodeURIComponent(o.orderNumber)}&open=${o.orderId}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {o.orderNumber}
                      </Link>
                      {o.activeSellers > 1 && <span className="block text-xs text-gray-500">{o.activeSellers} sellers</span>}
                    </Td>
                    <Td>{new Date(o.deliveredAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}</Td>
                    <Td>{o.paymentMethod === 'COD' ? 'COD' : 'Online'}</Td>
                    <Td className="text-right">{m(o.grossRevenuePaise)}</Td>
                    <Td className="text-right">
                      {m(o.deliveryPaise + o.platformPaise)}
                      {sellerView && o.sharedFeesPaise > 0 && <span className="block text-xs text-gray-500">{m(o.sharedFeesPaise)} shared</span>}
                    </Td>
                    <Td className="text-right">{m(o.commissionPaise)}</Td>
                    <Td className="text-right">{o.refundedPaise ? m(o.refundedPaise) : '—'}</Td>
                    <Td className="text-right">{m(o.sellerNetPaise)}</Td>
                    <Td className="text-right font-semibold">{m(o.aadioneNetPaise)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm text-gray-600">
            <span>
              Page {data.page} of {data.totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
                <Icon name="chevronLeft" className="h-4 w-4" />
              </Button>
              <Button variant="secondary" disabled={page >= data.totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">
                <Icon name="chevronRight" className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
