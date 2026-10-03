/**
 * Payments — every customer payment (GET /admin/payments, ORDER_REFUND),
 * read-only. Payments are created and confirmed by the Cashfree flow; a
 * refund is issued from the order (Orders → Refund), never from here. The
 * provider's raw payload is never sent to the browser, and customer mobiles
 * arrive masked.
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { adminErrorMessage, marketplaceKeys, shortDateTime, toQuery, type Paged, type PaymentRow } from '@/lib/marketplace';
import { Button, Pill, Surface, type Tone } from '@/components/ui';
import { Pager } from '@/components/MarketplaceUi';
import { EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList } from '@/seller/sellerUi';
import { useDebouncedValue } from '@/seller/sellerQueries';

const PAGE_SIZE = 25;
const STATUSES = [
  { value: 'ALL', label: 'Any status' },
  { value: 'CAPTURED', label: 'Captured (paid)' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'CREATED', label: 'Created' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'REFUNDED', label: 'Refunded' },
  { value: 'PARTIALLY_REFUNDED', label: 'Partially refunded' },
] as const;

const PAYMENT_TONE: Record<string, Tone> = {
  CAPTURED: 'brand',
  AUTHORIZED: 'blue',
  PENDING: 'amber',
  CREATED: 'gray',
  FAILED: 'red',
  REFUNDED: 'purple',
  PARTIALLY_REFUNDED: 'purple',
};
const REFUND_LOOK: Record<PaymentRow['refund']['state'], { label: string; tone: Tone }> = {
  NONE: { label: 'None', tone: 'gray' },
  PENDING: { label: 'Refund pending', tone: 'amber' },
  PARTIAL: { label: 'Partly refunded', tone: 'purple' },
  REFUNDED: { label: 'Refunded', tone: 'purple' },
  FAILED: { label: 'Refund failed', tone: 'red' },
};
const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

export default function PaymentsPage() {
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
  const payments = useQuery({
    queryKey: marketplaceKeys.payments(query),
    queryFn: () => api.get<Paged<PaymentRow>>(`/admin/payments?${query}`),
    placeholderData: (previous) => previous,
  });

  return (
    <div className="space-y-5">
      <p className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
        Payments are taken and confirmed through Cashfree. To refund a customer, open the order in{' '}
        <Link to="/orders" className="font-semibold text-brand-600 hover:underline">
          Orders
        </Link>{' '}
        — refunds go back through Cashfree and appear under{' '}
        <Link to="/refunds" className="font-semibold text-brand-600 hover:underline">
          Refunds
        </Link>
        .
      </p>

      <Surface className="grid gap-3 p-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Order / Cashfree ID</span>
          <SearchBox value={search} onChange={setSearch} placeholder="Order number, Cashfree order or payment ID…" label="Search payments" />
        </div>
        <FilterSelect label="Payment status" value={status} options={STATUSES} onChange={(next) => update({ status: next })} />
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

      {payments.isPending ? (
        <SkeletonList rows={6} label="Loading payments…" />
      ) : payments.isError ? (
        <LoadError message={adminErrorMessage(payments.error)} onRetry={() => void payments.refetch()} />
      ) : payments.data.items.length === 0 ? (
        <EmptyPanel icon="rupee" title="No payments found" hint={q || status !== 'ALL' ? 'Try clearing your filters.' : undefined} />
      ) : (
        <>
          <Surface className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <caption className="sr-only">Payments</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">Date</th>
                    <th scope="col" className="px-3 py-3">Order</th>
                    <th scope="col" className="px-3 py-3">Customer</th>
                    <th scope="col" className="px-3 py-3 text-right">Amount</th>
                    <th scope="col" className="px-3 py-3">Payment</th>
                    <th scope="col" className="px-3 py-3">Cashfree order ID</th>
                    <th scope="col" className="px-3 py-3">Payment ID</th>
                    <th scope="col" className="px-4 py-3">Refund</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {payments.data.items.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-50/60">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">{shortDateTime.format(new Date(p.createdAt))}</td>
                      <td className="px-3 py-3">
                        <span className="font-mono font-semibold text-gray-900">#{p.order.orderNumber}</span>
                        <span className="block text-xs text-gray-500">{humanize(p.order.status)}</span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="text-gray-900">{p.customer.name ?? '—'}</span>
                        {p.customer.mobile && <span className="block font-mono text-xs text-gray-500">{p.customer.mobile}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{formatPaise(p.amountPaise)}</td>
                      <td className="px-3 py-3">
                        <Pill tone={PAYMENT_TONE[p.status] ?? 'gray'}>{humanize(p.status)}</Pill>
                        <span className="mt-1 block text-xs text-gray-500">
                          {p.provider}
                          {p.method ? ` · ${p.method.toUpperCase()}` : ''}
                        </span>
                        {p.failureReason && <span className="block text-xs text-danger-600">{p.failureReason}</span>}
                      </td>
                      <td className="max-w-[12rem] break-all px-3 py-3 font-mono text-xs text-gray-700">{p.providerOrderId ?? '—'}</td>
                      <td className="max-w-[10rem] break-all px-3 py-3 font-mono text-xs text-gray-700">{p.providerPaymentId ?? '—'}</td>
                      <td className="px-4 py-3">
                        <Pill tone={REFUND_LOOK[p.refund.state].tone}>{REFUND_LOOK[p.refund.state].label}</Pill>
                        {p.refund.refundedPaise > 0 && <span className="mt-1 block text-xs text-gray-600">{formatPaise(p.refund.refundedPaise)} back</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
          <Pager page={page} pageSize={PAGE_SIZE} total={payments.data.total} onPage={(next) => update({ page: String(next) })} />
        </>
      )}
    </div>
  );
}
