/**
 * The seller's own orders (GET /seller/orders — the server returns only this
 * seller's SellerOrders). Tabs map to a status or one of the server's grouped
 * views; search (order number) and the date range are server filters, kept
 * in the URL so a refresh or a shared link shows the same list.
 *
 * Actions follow the backend state machine exactly (SELLER_ORDER_ACTIONS)
 * and call PATCH /seller/orders/:id/status. While one is in flight every
 * action button is disabled (no double submits); afterwards the lists,
 * counts and details are re-read from the server — nothing is optimistic.
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { formatRelativeTime } from '@shared/datetime';
import { Button, ErrorBanner, Field, Icon, Modal, Pill, Surface, Thumb, inputClass } from '@/components/ui';
import { sellerOrderStatusLabel, sellerOrderStatusStyle } from '@/lib/v2Orders';
import {
  HANDOVER_LABEL,
  SELLER_ORDER_ACTIONS,
  SELLER_ORDER_TABS,
  sellerApi,
  sellerErrorMessage,
  toSellerOrderDetailView,
  type SellerOrderAction,
  type SellerOrderPage,
  type SellerOrderRow,
  type SellerOrderTabKey,
} from '../sellerApi';
import { sellerKeys, useDebouncedValue, useSellerOrderSummary } from '../sellerQueries';
import { ChipTabs, EmptyPanel, LoadError, SearchBox, SkeletonList, toast } from '../sellerUi';

const PAGE_SIZE = 25;
const dateTime = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** Labels for the primary (forward) action — what the seller does next. */
const PRIMARY_LABEL: Record<string, string> = {
  ACCEPTED: 'Accept order',
  PREPARING: 'Start preparing',
  READY_FOR_PICKUP: 'Ready for pickup',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${sellerOrderStatusStyle(status)}`}>
      {sellerOrderStatusLabel(status)}
    </span>
  );
}

export default function SellerOrdersPage() {
  const [params, setParams] = useSearchParams();
  const tab: SellerOrderTabKey = SELLER_ORDER_TABS.find((item) => item.key === params.get('tab'))?.key ?? (params.get('order') ? 'ALL' : 'NEW');
  const tabDef = SELLER_ORDER_TABS.find((item) => item.key === tab)!;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const orderId = params.get('order') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 350);

  // The debounced search is written to the URL (replace, not a new history entry).
  useEffect(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (q) next.set('q', q);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [q, setParams]);

  const update = (changes: Record<string, string | null>) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });

  const filters: Record<string, string> = {
    ...(tabDef.status ? { status: tabDef.status } : {}),
    ...(tabDef.stage ? { stage: tabDef.stage } : {}),
    ...(q ? { q } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(orderId ? { orderId } : {}),
  };
  const filtered = Boolean(q || from || to || orderId);

  const queryClient = useQueryClient();
  const summary = useSellerOrderSummary();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(orderId ? ['__first'] : []));
  const [confirming, setConfirming] = useState<{ row: SellerOrderRow; action: SellerOrderAction } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Set synchronously on click: a double click can't send a second update
  // before React re-renders the disabled buttons.
  const inFlight = useRef(false);

  const list = useInfiniteQuery({
    queryKey: sellerKeys.orderList(filters),
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...filters });
      if (pageParam) query.set('cursor', pageParam);
      return sellerApi.get<SellerOrderPage>(`/seller/orders?${query.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    refetchInterval: 30_000,
  });

  const action = useMutation({
    mutationFn: (input: { row: SellerOrderRow; action: SellerOrderAction; reason?: string }) =>
      sellerApi.patch(`/seller/orders/${input.row.id}/status`, {
        toStatus: input.action.to,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    onSuccess: (_data, input) => {
      setError(null);
      toast(`Order #${input.row.orderNumber}: ${sellerOrderStatusLabel(input.action.to)}.`);
    },
    onError: (err) => setError(sellerErrorMessage(err)),
    // Success or failure, re-read what the server now says (lists, counts, activity).
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sellerKeys.orders }),
        queryClient.invalidateQueries({ queryKey: sellerKeys.activity }),
      ]),
  });

  function send(input: { row: SellerOrderRow; action: SellerOrderAction; reason?: string }): void {
    if (inFlight.current) return;
    inFlight.current = true;
    action.mutate(input, { onSettled: () => { inFlight.current = false; } });
  }

  function run(row: SellerOrderRow, next: SellerOrderAction): void {
    if (inFlight.current) return;
    setError(null);
    if (next.kind === 'advance') {
      send({ row, action: next });
      return;
    }
    setReason('');
    setConfirming({ row, action: next });
  }

  function toggle(id: string): void {
    setExpanded((current) => {
      const nextSet = new Set(current);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
  }

  // Pages can overlap at a timestamp boundary; keep the first copy of each.
  const seen = new Set<string>();
  const rows = (list.data?.pages ?? []).flatMap((page) => page.items).filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const busyId = action.isPending ? action.variables?.row.id : null;
  const counts = summary.data?.counts;
  const tabCount = (key: SellerOrderTabKey): number | null =>
    !counts ? null : key === 'NEW' ? counts.NEW : key === 'ACCEPTED' ? counts.ACCEPTED : key === 'PREPARING' ? counts.PREPARING : key === 'READY_FOR_PICKUP' ? counts.READY : null;

  return (
    <div className="space-y-4">
      <ChipTabs
        label="Order status"
        value={tab}
        onChange={(key) => {
          setError(null);
          update({ tab: key, order: null });
        }}
        options={SELLER_ORDER_TABS.map((item) => ({ value: item.key, label: item.label, count: tabCount(item.key) }))}
      />

      <Surface className="grid gap-3 p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Order number</span>
          <SearchBox value={search} onChange={setSearch} placeholder="Search by order number…" label="Search by order number" />
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">From</span>
          <input type="date" value={from} max={to || undefined} onChange={(event) => update({ from: event.target.value || null })} className={`${inputClass} h-11 py-0`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(event) => update({ to: event.target.value || null })} className={`${inputClass} h-11 py-0`} />
        </label>
        <Button
          variant="ghost"
          disabled={!filtered}
          onClick={() => {
            setSearch('');
            update({ q: null, from: null, to: null, order: null });
          }}
        >
          Clear filters
        </Button>
      </Surface>
      {orderId && (
        <p className="rounded-xl bg-info-50 px-3.5 py-2.5 text-sm text-info-500">
          Showing the order from your notification.{' '}
          <button type="button" className="font-semibold underline" onClick={() => update({ order: null })}>
            Show all
          </button>
        </p>
      )}

      <ErrorBanner message={error} />

      {list.isPending ? (
        <SkeletonList rows={4} label="Loading orders…" />
      ) : list.isError && rows.length === 0 ? (
        <LoadError message={sellerErrorMessage(list.error)} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyPanel
          icon="orders"
          title={filtered ? 'No orders match these filters' : tab === 'NEW' ? 'No new orders right now' : `No ${tabDef.label.toLowerCase()} orders`}
          hint={filtered ? 'Try another order number or date, or clear the filters.' : tab === 'NEW' ? 'New orders appear here automatically.' : undefined}
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  update({ q: null, from: null, to: null, order: null });
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3">
          {rows.map((row, index) => {
            const actions = SELLER_ORDER_ACTIONS[row.status] ?? [];
            const primary = actions.find((item) => item.kind === 'advance');
            const secondary = actions.filter((item) => item.kind !== 'advance');
            const isOpen = expanded.has(row.id) || (index === 0 && expanded.has('__first'));
            return (
              <Surface key={row.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-base font-semibold text-gray-900">#{row.orderNumber}</span>
                      <StatusBadge status={row.status} />
                      {row.handover && <Pill tone={row.handover === 'DELIVERED' ? 'brand' : row.handover === 'AWAITING_PICKUP' ? 'amber' : 'blue'}>{HANDOVER_LABEL[row.handover]}</Pill>}
                    </div>
                    <p className="mt-1 text-sm text-gray-700">
                      {row.customerName ?? 'Customer'} · {row.itemCount} item{row.itemCount === 1 ? '' : 's'}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      <time dateTime={row.createdAt} title={dateTime.format(new Date(row.createdAt))}>
                        {formatRelativeTime(new Date(row.createdAt))}
                      </time>{' '}
                      · {row.paymentMethod === 'COD' ? 'Cash on delivery' : 'Paid online'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-gray-900">{formatPaise(row.subtotalPaise)}</p>
                    <p className="text-xs text-gray-500">Your items</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {primary && (
                    <Button disabled={action.isPending} onClick={() => run(row, primary)} className="flex-1 sm:flex-none">
                      {busyId === row.id && action.variables?.action.to === primary.to ? 'Updating…' : PRIMARY_LABEL[primary.to] ?? primary.label}
                    </Button>
                  )}
                  {secondary.map((next) => (
                    <Button key={next.to} variant="secondary" disabled={action.isPending} onClick={() => run(row, next)}>
                      {busyId === row.id && action.variables?.action.to === next.to ? 'Updating…' : next.label}
                    </Button>
                  ))}
                  <button
                    type="button"
                    onClick={() => toggle(row.id)}
                    aria-expanded={isOpen}
                    className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-brand-600 outline-none hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-400"
                  >
                    {isOpen ? 'Hide details' : 'View details'}
                    <Icon name="chevronDown" className={`h-4 w-4 transition ${isOpen ? 'rotate-180' : ''}`} />
                  </button>
                </div>

                {isOpen && <OrderDetail id={row.id} paymentMethod={row.paymentMethod} />}
              </Surface>
            );
          })}

          {list.hasNextPage && (
            <div className="text-center">
              <Button variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}

      {confirming && (
        <Modal
          title={`${confirming.action.label} order #${confirming.row.orderNumber}?`}
          subtitle={
            confirming.action.kind === 'reject'
              ? 'The customer will be told this part of their order was declined.'
              : 'The customer will be told this part of their order was cancelled.'
          }
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(null)}>
                Keep order
              </Button>
              <Button
                variant="danger"
                disabled={action.isPending}
                onClick={() => {
                  const target = confirming;
                  setConfirming(null);
                  send({ row: target.row, action: target.action, ...(reason.trim() ? { reason: reason.trim() } : {}) });
                }}
              >
                {confirming.action.label} order
              </Button>
            </>
          }
        >
          <Field label="Reason (optional)" hint="Shown to the customer.">
            <textarea
              value={reason}
              maxLength={300}
              rows={3}
              onChange={(event) => setReason(event.target.value)}
              className={inputClass}
              placeholder={confirming.action.kind === 'reject' ? 'e.g. Item not available today' : 'e.g. Ran out of stock'}
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function OrderDetail({ id, paymentMethod }: { id: string; paymentMethod: string }) {
  const detail = useQuery({
    queryKey: sellerKeys.orderDetail(id),
    queryFn: () => sellerApi.get<unknown>(`/seller/orders/${id}`).then(toSellerOrderDetailView),
  });

  if (detail.isPending) {
    return (
      <div className="mt-3 border-t border-gray-100 pt-3">
        <SkeletonList rows={1} label="Loading order details…" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="mt-3 border-t border-gray-100 pt-3">
        <LoadError message={sellerErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const view = detail.data;
  return (
    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
      <ul className="divide-y divide-gray-100">
        {view.items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 py-2">
            <Thumb src={item.imageUrl} alt={item.productName} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">{item.productName}</p>
              <p className="text-xs text-gray-500">
                {item.variantName && `${item.variantName} · `}
                Qty {item.qty} × {formatPaise(item.unitPricePaise)}
              </p>
            </div>
            <span className="text-sm font-semibold text-gray-900">{formatPaise(item.lineTotalPaise)}</span>
          </li>
        ))}
      </ul>

      <div className="flex justify-between border-t border-gray-100 pt-2 text-sm font-semibold text-gray-900">
        <span>Your items subtotal</span>
        <span>{formatPaise(view.subtotalPaise)}</span>
      </div>

      <dl className="grid gap-2 rounded-xl bg-gray-50 p-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-gray-500">Deliver to</dt>
          <dd className="font-medium text-gray-900">
            {view.customerName ?? '—'}
            {view.customerMobile && <span className="block text-gray-600">{view.customerMobile}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Payment</dt>
          <dd className="font-medium text-gray-900">{paymentMethod === 'COD' ? 'Cash on delivery' : 'Paid online'}</dd>
        </div>
      </dl>
      {view.rejectionReason && (
        <p className="rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-600">
          <span className="font-semibold">Rejected:</span> {view.rejectionReason}
        </p>
      )}
      {view.cancellationReason && (
        <p className="rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-600">
          <span className="font-semibold">Cancelled:</span> {view.cancellationReason}
        </p>
      )}
    </div>
  );
}
