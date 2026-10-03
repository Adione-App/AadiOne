/**
 * Settlements — read-only payout history.
 *
 *   GET /seller/earnings          pending / in-settlement / paid totals, next due
 *   GET /seller/settlements       history (cursor pages)
 *   GET /seller/settlements/:id   one settlement + the orders it paid for
 *
 * A seller never creates or pays a settlement (admin-only on the server).
 * Every amount is the server's.
 */

import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Icon, Surface } from '@/components/ui';
import {
  sellerApi,
  sellerErrorMessage,
  toSettlementDetail,
  type SellerSettlement,
  type SellerSettlementDetail,
  type SellerSettlementOrder,
} from '../sellerApi';
import { sellerKeys, useSellerEarnings } from '../sellerQueries';
import { SETTLEMENT_STATUS, SettlementBadge, date, dateTime, inr, settlementRows, useSettlementPages } from '../earningsUi';
import { EmptyPanel, LoadError, Skeleton, SkeletonList } from '../sellerUi';

export default function SellerSettlementsPage() {
  const summary = useSellerEarnings();
  const list = useSettlementPages();
  const [open, setOpen] = useState<string | null>(null);
  const rows = settlementRows(list.data?.pages);
  const s = summary.data;
  const figure = (value: number | undefined) => (value === undefined ? <Skeleton className="h-6 w-24" /> : inr(value));

  return (
    <div className="space-y-5">
      <section aria-label="Settlement summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Pending settlement', value: figure(s?.pendingSettlementPaise), hint: 'Ready for your next payout' },
          { label: 'In a settlement', value: figure(s?.inSettlementPaise), hint: 'Created, not paid yet' },
          { label: 'Paid to you', value: figure(s?.settledAmountPaise), hint: 'All paid settlements' },
          {
            label: 'Next settlement',
            value: s ? (s.nextSettlementDueAt ? date(s.nextSettlementDueAt) : 'After your first') : <Skeleton className="h-6 w-24" />,
            hint: s ? `Every ${s.settlementCycleHours} hours` : '',
          },
        ].map((card) => (
          <Surface key={card.label} className="p-4">
            <p className="text-sm font-medium text-gray-500">{card.label}</p>
            <div className="mt-1 text-xl font-bold text-gray-900">{card.value}</div>
            <p className="mt-0.5 text-xs text-gray-500">{card.hint}</p>
          </Surface>
        ))}
      </section>
      {summary.isError && <LoadError message={sellerErrorMessage(summary.error)} onRetry={() => void summary.refetch()} />}

      <Surface className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-4 sm:p-5">
          <h2 className="text-base font-semibold text-gray-900">Settlement history</h2>
        </div>
        {list.isPending ? (
          <div className="px-4 pb-4 sm:px-5">
            <SkeletonList rows={3} label="Loading settlements…" />
          </div>
        ) : list.isError && rows.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <LoadError message={sellerErrorMessage(list.error)} onRetry={() => void list.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyPanel icon="clipboard" title="No settlements yet" hint="Aadione creates one for each settlement period once orders are delivered and paid." />
          </div>
        ) : (
          <>
            {/* phones: rows */}
            <ul className="divide-y divide-gray-100 border-t border-gray-100 md:hidden">
              {rows.map((row) => (
                <li key={row.id} className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setOpen(open === row.id ? null : row.id)}
                    aria-expanded={open === row.id}
                    className="flex w-full items-start justify-between gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-gray-900">
                        {date(row.periodStart)} – {date(row.periodEnd)}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <SettlementBadge status={row.status} />
                        {row.paidAt ? `Paid ${date(row.paidAt)}` : `Created ${date(row.createdAt)}`}
                      </span>
                    </span>
                    <span className="flex items-start gap-2 text-right">
                      <span className="text-base font-bold text-gray-900">{inr(row.netPayablePaise)}</span>
                      <Icon name="chevronDown" className={`mt-1 h-4 w-4 text-gray-400 transition ${open === row.id ? 'rotate-180' : ''}`} />
                    </span>
                  </button>
                  {open === row.id && <SettlementDetail id={row.id} />}
                </li>
              ))}
            </ul>

            {/* md+: table */}
            <div className="hidden overflow-x-auto border-t border-gray-100 md:block">
              <table className="w-full min-w-[720px] text-sm">
                <caption className="sr-only">Settlement history</caption>
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-5 py-3">Period</th>
                    <th scope="col" className="px-3 py-3">Status</th>
                    <th scope="col" className="px-3 py-3 text-right">Gross sales</th>
                    <th scope="col" className="px-3 py-3 text-right">Commission</th>
                    <th scope="col" className="px-3 py-3 text-right">Payout</th>
                    <th scope="col" className="px-3 py-3">Paid on</th>
                    <th scope="col" className="px-5 py-3 text-right">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row: SellerSettlement) => (
                    <Fragment key={row.id}>
                      <tr className="hover:bg-gray-50/60">
                        <td className="whitespace-nowrap px-5 py-3 font-medium text-gray-900">
                          {date(row.periodStart)} – {date(row.periodEnd)}
                        </td>
                        <td className="px-3 py-3">
                          <SettlementBadge status={row.status} />
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{inr(row.grossSalesPaise)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{inr(row.commissionPaise)}</td>
                        <td className="px-3 py-3 text-right font-bold tabular-nums text-gray-900">{inr(row.netPayablePaise)}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-gray-600">{row.paidAt ? date(row.paidAt) : '—'}</td>
                        <td className="px-5 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setOpen(open === row.id ? null : row.id)}
                            aria-expanded={open === row.id}
                            className="inline-flex items-center gap-1 rounded-lg text-sm font-semibold text-brand-600 outline-none hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-400"
                          >
                            {open === row.id ? 'Hide' : 'Orders'}
                            <Icon name="chevronDown" className={`h-4 w-4 transition ${open === row.id ? 'rotate-180' : ''}`} />
                          </button>
                        </td>
                      </tr>
                      {open === row.id && (
                        <tr>
                          <td colSpan={7} className="bg-gray-50/60 px-5 pb-4">
                            <SettlementDetail id={row.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {list.hasNextPage && (
              <div className="border-t border-gray-100 p-3 text-center">
                <Button variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </Surface>
    </div>
  );
}

function OrderLine({ order }: { order: SellerSettlementOrder }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <span className="min-w-0">
        <span className="block font-mono text-sm font-semibold text-gray-900">#{order.orderNumber}</span>
        {order.deliveredAt && <span className="block text-xs text-gray-500">Delivered {date(order.deliveredAt)}</span>}
      </span>
      <span className="text-right text-xs text-gray-500">
        Order {inr(order.grossPaise)} · Commission {inr(order.commissionPaise)}
        {order.refundedPaise > 0 && <span className="block text-danger-600">Refunded {inr(order.refundedPaise)}</span>}
        <span className="block text-sm font-semibold text-gray-900">You earn {inr(order.finalPayablePaise)}</span>
      </span>
    </li>
  );
}

function SettlementDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: sellerKeys.settlementDetail(id),
    queryFn: () =>
      sellerApi
        .get<SellerSettlementDetail & { sellerOrders: SellerSettlementOrder[] }>(`/seller/settlements/${id}`)
        .then(toSettlementDetail),
  });

  if (detail.isPending) return <SkeletonList rows={2} label="Loading settlement…" />;
  if (detail.isError) {
    return (
      <div className="mt-2">
        <LoadError message={sellerErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      </div>
    );
  }
  const d = detail.data;
  const note = SETTLEMENT_STATUS[d.status]?.note;

  return (
    <div className="mt-3 space-y-3 rounded-xl bg-white p-3 ring-1 ring-gray-200">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3"><dt className="text-gray-600">Reference</dt><dd className="font-mono font-semibold">{d.id.slice(0, 8).toUpperCase()}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-gray-600">Period</dt><dd className="text-right">{dateTime(d.periodStart)} – {dateTime(d.periodEnd)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-gray-600">Gross sales</dt><dd className="font-semibold">{inr(d.grossSalesPaise)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-gray-600">Aadione commission</dt><dd className="font-semibold">{inr(d.commissionPaise)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-gray-600">Created</dt><dd>{dateTime(d.createdAt)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="font-semibold text-gray-900">Payout</dt><dd className="font-bold text-brand-600">{inr(d.netPayablePaise)}</dd></div>
        {d.paidAt && <div className="flex justify-between gap-3"><dt className="text-gray-600">Paid on</dt><dd>{dateTime(d.paidAt)}</dd></div>}
      </dl>
      {note && <p className="text-xs text-gray-500">{note}</p>}
      <div>
        <p className="text-sm font-semibold text-gray-900">Orders in this settlement ({d.orders.length})</p>
        {d.orders.length === 0 ? (
          <p className="text-sm text-gray-500">No orders in this period.</p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {d.orders.map((order) => <OrderLine key={order.orderNumber} order={order} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
