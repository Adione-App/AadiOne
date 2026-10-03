/**
 * Refunds — every refund (GET /admin/refunds, ORDER_REFUND), read-only.
 * Refunds are raised from an order (Orders → Refund) or automatically when a
 * seller's portion is cancelled, and always go back through Cashfree; this
 * page tracks them. Nothing here moves money.
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { adminErrorMessage, marketplaceKeys, shortDateTime, toQuery, type Paged, type RefundRow } from '@/lib/marketplace';
import { Button, Pill, Surface, type Tone } from '@/components/ui';
import { Pager } from '@/components/MarketplaceUi';
import { EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList } from '@/seller/sellerUi';
import { useDebouncedValue } from '@/seller/sellerQueries';

const PAGE_SIZE = 25;
const STATUSES = [
  { value: 'ALL', label: 'Any status' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
] as const;
const TONE: Record<string, Tone> = { PENDING: 'amber', PROCESSING: 'blue', COMPLETED: 'brand', FAILED: 'red' };
const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

export default function RefundsPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 350);
  const status = params.get('status') ?? 'ALL';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const update = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value && value !== 'ALL') next.set(key, value);
          else next.delete(key);
        }
        if (!('page' in changes)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  useEffect(() => {
    if ((params.get('q') ?? '') !== q) update({ q: q || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = toQuery({ q, status, page, pageSize: PAGE_SIZE });
  const refunds = useQuery({
    queryKey: marketplaceKeys.refunds(query),
    queryFn: () => api.get<Paged<RefundRow>>(`/admin/refunds?${query}`),
    placeholderData: (previous) => previous,
  });

  return (
    <div className="space-y-5">
      <p className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
        Refunds go back to the customer through Cashfree. Raise one from the order in{' '}
        <Link to="/orders" className="font-semibold text-brand-600 hover:underline">
          Orders
        </Link>
        ; cancelled seller portions are refunded automatically.
      </p>

      <Surface className="grid gap-3 p-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Order</span>
          <SearchBox value={search} onChange={setSearch} placeholder="Order number…" label="Search refunds" />
        </div>
        <FilterSelect label="Refund status" value={status} options={STATUSES} onChange={(next) => update({ status: next })} />
        <Button
          variant="ghost"
          disabled={!q && status === 'ALL'}
          onClick={() => {
            setSearch('');
            update({ q: null, status: null });
          }}
        >
          Clear filters
        </Button>
      </Surface>

      {refunds.isPending ? (
        <SkeletonList rows={5} label="Loading refunds…" />
      ) : refunds.isError ? (
        <LoadError message={adminErrorMessage(refunds.error)} onRetry={() => void refunds.refetch()} />
      ) : refunds.data.items.length === 0 ? (
        <EmptyPanel icon="rupee" title="No refunds found" hint={q || status !== 'ALL' ? 'Try clearing your filters.' : undefined} />
      ) : (
        <>
          <Surface className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <caption className="sr-only">Refunds</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">Created</th>
                    <th scope="col" className="px-3 py-3">Order</th>
                    <th scope="col" className="px-3 py-3">Seller portion</th>
                    <th scope="col" className="px-3 py-3 text-right">Amount</th>
                    <th scope="col" className="px-3 py-3">Status</th>
                    <th scope="col" className="px-3 py-3">Reason</th>
                    <th scope="col" className="px-4 py-3">Cashfree refund ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {refunds.data.items.map((r) => (
                    <tr key={r.id} className="align-top hover:bg-gray-50/60">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                        {shortDateTime.format(new Date(r.createdAt))}
                        {r.completedAt && <span className="block text-xs text-gray-400">Done {shortDateTime.format(new Date(r.completedAt))}</span>}
                      </td>
                      <td className="px-3 py-3">
                        <span className="font-mono font-semibold text-gray-900">#{r.order.orderNumber}</span>
                        {r.order.customerName && <span className="block text-xs text-gray-500">{r.order.customerName}</span>}
                      </td>
                      <td className="px-3 py-3 text-gray-700">{r.seller ? r.seller.name : <span className="text-gray-400">Whole order</span>}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{formatPaise(r.amountPaise)}</td>
                      <td className="px-3 py-3">
                        <Pill tone={TONE[r.status] ?? 'gray'}>{humanize(r.status)}</Pill>
                        {r.failureReason && <span className="mt-1 block text-xs text-danger-600">{r.failureReason}</span>}
                      </td>
                      <td className="max-w-[18rem] px-3 py-3 text-xs text-gray-600">{r.reason ?? '—'}</td>
                      <td className="max-w-[12rem] break-all px-4 py-3 font-mono text-xs text-gray-700">{r.providerRefundId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
          <Pager page={page} pageSize={PAGE_SIZE} total={refunds.data.total} onPage={(next) => update({ page: String(next) })} />
        </>
      )}
    </div>
  );
}
