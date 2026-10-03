/**
 * Seller earnings — read-only. Every amount shown is a value the backend
 * computed (paise, formatted with the shared formatPaise); the page never
 * derives a financial figure itself.
 *
 *   GET /seller/earnings/today      today's sales and earnings
 *   GET /seller/earnings            lifetime summary (SellerEarningsSummaryDto)
 *   GET /seller/settlements         the latest settlement (Settlements has the history)
 *   GET /seller/commission/orders   per-order amount + commission snapshot
 *
 * All are scoped by the server to the signed-in seller; nothing here takes a
 * seller id. Per-order NET earnings and settlement status are not returned
 * by any seller order list — they appear per order only inside a
 * settlement's detail, exactly as the backend reports them.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon, Surface } from '@/components/ui';
import { sellerOrderStatusLabel, sellerOrderStatusStyle } from '@/lib/v2Orders';
import { HANDOVER_LABEL, sellerApi, sellerErrorMessage, toOrderCommissions, type SellerOrderCommission } from '../sellerApi';
import { sellerKeys, useSellerEarnings, useSellerTodayEarnings } from '../sellerQueries';
import { SettlementBadge, date, dateTime, inr, percent, settlementRows, useSettlementPages } from '../earningsUi';
import { CardHeader, EmptyPanel, LoadError, Skeleton, SkeletonBlock, linkClass } from '../sellerUi';

const ORDER_LIMIT = 100;

export default function SellerEarningsPage() {
  return (
    <div className="space-y-5">
      <TopCards />
      <Breakdown />
      <OrderEarnings />
    </div>
  );
}

/* --------------------------------------------------------------- top cards */

function Card({ label, value, hint, strong, to }: { label: string; value: React.ReactNode; hint?: React.ReactNode; strong?: boolean; to?: string }) {
  const body = (
    <Surface className={`h-full p-4 ${strong ? 'border-brand-500/40 bg-brand-50/40' : ''} ${to ? 'transition hover:border-brand-200' : ''}`}>
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <div className={`mt-1 text-xl font-bold ${strong ? 'text-brand-600' : 'text-gray-900'}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-gray-500">{hint}</div>}
    </Surface>
  );
  return to ? (
    <Link to={to} className="block h-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
      {body}
    </Link>
  ) : (
    body
  );
}

function TopCards() {
  const today = useSellerTodayEarnings();
  const summary = useSellerEarnings();
  const settlements = useSettlementPages();
  const last = settlementRows(settlements.data?.pages)[0] ?? null;
  const pending = <Skeleton className="h-6 w-24" />;

  if (summary.isError) return <LoadError message={sellerErrorMessage(summary.error)} onRetry={() => void summary.refetch()} />;
  const s = summary.data;

  return (
    <section aria-label="Earnings overview" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Card
        label="Today's earnings"
        strong
        value={today.isPending ? pending : today.data ? inr(today.data.netPayablePaise) : '—'}
        hint={today.data ? `${inr(today.data.grossSalesPaise)} sales · ${today.data.orderCount} order${today.data.orderCount === 1 ? '' : 's'}` : undefined}
      />
      <Card label="Pending settlement" value={s ? inr(s.pendingSettlementPaise) : pending} hint="Ready for your next payout" />
      <Card
        label="Upcoming settlement"
        value={s ? (s.nextSettlementDueAt ? date(s.nextSettlementDueAt) : 'After your first') : pending}
        hint={s ? `Settled every ${s.settlementCycleHours} hours` : undefined}
        to="/seller/settlements"
      />
      <Card
        label="Last settlement"
        value={settlements.isPending ? pending : last ? inr(last.netPayablePaise) : 'None yet'}
        hint={last ? <span className="inline-flex items-center gap-1.5">{date(last.periodEnd)} <SettlementBadge status={last.status} /></span> : undefined}
        to="/seller/settlements"
      />
      <Card label="Total earnings" value={s ? inr(s.netPayablePaise) : pending} hint="All orders still standing" />
    </section>
  );
}

/* --------------------------------------------------------------- breakdown */

function Line({ label, paise, hint, sign, total }: { label: string; paise: number; hint?: string; sign?: '−' | '='; total?: boolean }) {
  return (
    <div className={`flex flex-wrap items-baseline justify-between gap-x-4 py-2.5 ${total ? 'border-t-2 border-gray-200' : ''}`}>
      <dt className={`text-sm ${total ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
        {sign && <span aria-hidden="true" className="mr-1 inline-block w-3 text-gray-400">{sign}</span>}
        {label}
        {hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </dt>
      <dd className={`text-sm ${total ? 'text-base font-bold text-brand-600' : 'font-semibold text-gray-900'}`}>{inr(paise)}</dd>
    </div>
  );
}

function Breakdown() {
  const summary = useSellerEarnings();
  if (summary.isPending) return <SkeletonBlock lines={6} label="Loading your earnings…" />;
  if (summary.isError) return null;
  const s = summary.data;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Surface className="p-4 sm:p-5">
        <CardHeader title="How your earnings add up" subtitle="All orders that were not cancelled." />
        <dl className="mt-2 divide-y divide-gray-100">
          <Line label="Gross sales" paise={s.grossSalesPaise} hint="What customers paid for your items" />
          <Line label="Aadione commission" paise={s.commissionPaise} sign="−" hint="Worked out from Aadione's commission rules per order" />
          <Line label="Net earnings" paise={s.netPayablePaise} sign="=" total />
        </dl>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Not included</p>
        <dl className="divide-y divide-gray-100">
          <Line label="Cancelled orders" paise={s.cancelledAmountPaise} hint="Never paid out" />
          <Line label="Refunds to customers" paise={s.refundedAmountPaise} hint="Not paid out" />
        </dl>
      </Surface>

      <Surface className="p-4 sm:p-5">
        <CardHeader
          title="Where your earnings are"
          action={
            <Link to="/seller/settlements" className={linkClass}>
              Settlements <Icon name="chevronRight" className="h-4 w-4" />
            </Link>
          }
        />
        <dl className="mt-2 divide-y divide-gray-100">
          <Line label="Waiting for delivery or payment" paise={s.notYetEligiblePaise} hint="Becomes payable once delivered and paid" />
          <Line label="Pending settlement" paise={s.pendingSettlementPaise} hint="Ready for your next payout" />
          <Line label="In a settlement" paise={s.inSettlementPaise} hint="Settlement created, not paid yet" />
          <Line label="Paid to you" paise={s.settledAmountPaise} hint="Settlements marked paid" />
        </dl>
        <p className="mt-3 text-xs text-gray-500">
          Settled every {s.settlementCycleHours} hours
          {s.nextSettlementDueAt ? ` · next settlement due ${dateTime(s.nextSettlementDueAt)}` : ''}
          {s.lastSettlementPeriodEnd ? ` · last period ended ${dateTime(s.lastSettlementPeriodEnd)}` : ''}
        </p>
      </Surface>
    </div>
  );
}

/* ---------------------------------------------------------- order earnings */

function OrderEarnings() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const orders = useQuery({
    queryKey: sellerKeys.orderCommissions,
    queryFn: () =>
      sellerApi.get<SellerOrderCommission[]>(`/seller/commission/orders?limit=${ORDER_LIMIT}`).then(toOrderCommissions),
  });

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Surface className="p-4 sm:p-5">
      <CardHeader title="Order earnings" subtitle="Each order's amount and the commission on it." />
      <div className="mt-3">
        {orders.isPending ? (
          <SkeletonBlock lines={4} label="Loading orders…" />
        ) : orders.isError ? (
          <LoadError message={sellerErrorMessage(orders.error)} onRetry={() => void orders.refetch()} />
        ) : orders.data.length === 0 ? (
          <EmptyPanel icon="rupee" title="No earnings yet" hint="Your orders will appear here." />
        ) : (
          <>
            <ul className="divide-y divide-gray-100">
              {orders.data.map((order) => {
                const key = order.orderNumber;
                const isOpen = open.has(key);
                const cancelled = order.status === 'CANCELLED' || order.status === 'REJECTED';
                return (
                  <li key={key} className="py-3">
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      aria-expanded={isOpen}
                      className="flex w-full flex-wrap items-start justify-between gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-gray-900">#{order.orderNumber}</span>
                          <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${sellerOrderStatusStyle(order.status)}`}>
                            {order.handover ? HANDOVER_LABEL[order.handover] : sellerOrderStatusLabel(order.status)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-500">{date(order.createdAt)}</span>
                      </span>
                      <span className="flex items-start gap-3 text-right">
                        <span>
                          <span className={`block text-sm font-semibold ${cancelled ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                            {inr(order.subtotalPaise)}
                          </span>
                          <span className="block text-xs text-gray-500">
                            {cancelled ? 'Cancelled — not paid out' : `Commission ${inr(order.commissionPaise)} (${percent(order.commissionBp)})`}
                          </span>
                        </span>
                        <Icon name="chevronDown" className={`mt-0.5 h-4 w-4 text-gray-400 transition ${isOpen ? 'rotate-180' : ''}`} />
                      </span>
                    </button>

                    {isOpen && (
                      <div className="mt-3 rounded-xl bg-gray-50 p-3">
                        <ul className="space-y-1.5 text-sm">
                          {order.items.map((item, index) => (
                            <li key={index} className="flex flex-wrap justify-between gap-2">
                              <span className="text-gray-700">
                                {item.qty} × {item.productName}
                                {item.variantName && <span className="text-gray-400"> · {item.variantName}</span>}
                              </span>
                              <span className="text-gray-900">
                                {inr(item.lineTotalPaise)}
                                <span className="ml-2 text-xs text-gray-500">commission {inr(item.commissionPaise)}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                        <dl className="mt-3 space-y-1 border-t border-gray-200 pt-2 text-sm">
                          <div className="flex justify-between"><dt className="text-gray-600">Order amount</dt><dd className="font-semibold">{inr(order.subtotalPaise)}</dd></div>
                          <div className="flex justify-between"><dt className="text-gray-600">Aadione commission ({percent(order.commissionBp)})</dt><dd className="font-semibold">{inr(order.commissionPaise)}</dd></div>
                        </dl>
                        <p className="mt-2 text-xs text-gray-500">
                          {cancelled
                            ? 'This order was cancelled, so it is not paid out.'
                            : 'Your earning for this order is shown in the settlement that pays for it.'}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {orders.data.length === ORDER_LIMIT && <p className="mt-2 text-xs text-gray-500">Showing your latest {ORDER_LIMIT} orders.</p>}
          </>
        )}
      </div>
    </Surface>
  );
}
