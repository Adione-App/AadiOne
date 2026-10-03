/**
 * Settlements — every seller's settlements, on the existing backend:
 *
 *   GET   /admin/settlements                      list (SETTLEMENT_READ)
 *   GET   /admin/settlements/:id                  detail + the orders it pays for
 *   PATCH /admin/settlements/:id/status           PENDING → PROCESSING → PAID,
 *                                                 or → FAILED (→ PENDING to retry)
 *   GET   /admin/sellers/:id/settlements/eligible preview the next period
 *   POST  /admin/sellers/:id/settlements          create it (SETTLEMENT_MANAGE)
 *
 * Every amount is the server's. Orders with a refund are held back from
 * settlement by the backend, so a settlement's net is gross − commission.
 */

import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Permission, roleHasPermission } from '@shared';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSellerPermissions } from '@/lib/sellers';
import { adminErrorMessage, shortDate, shortDateTime, useSellerOptions } from '@/lib/marketplace';
import { Button, ErrorBanner, Icon, Modal, Pill, Surface, type Tone } from '@/components/ui';
import { SellerLink } from '@/components/MarketplaceUi';
import { ChipTabs, EmptyPanel, FilterSelect, LoadError, SkeletonList } from '@/seller/sellerUi';

interface SettlementRow {
  id: string;
  sellerId: string;
  sellerName: string;
  periodStart: string;
  periodEnd: string;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED';
  paidAt: string | null;
  createdAt: string;
}

interface SettlementOrder {
  orderNumber: string;
  deliveredAt: string | null;
  grossPaise: number;
  commissionPaise: number;
  refundedPaise: number;
  finalPayablePaise: number;
}

interface EligiblePreview {
  periodStart: string;
  periodEnd: string;
  overlapsExistingSettlement: boolean;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  sellerOrders: SettlementOrder[];
}

const STATUS_LOOK: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'amber' },
  PROCESSING: { label: 'Processing', tone: 'blue' },
  PAID: { label: 'Paid', tone: 'brand' },
  FAILED: { label: 'Failed', tone: 'red' },
};

/** The backend's ALLOWED_SETTLEMENT_TRANSITIONS, as buttons. */
const NEXT: Record<string, { to: SettlementRow['status']; label: string; danger?: boolean }[]> = {
  PENDING: [
    { to: 'PROCESSING', label: 'Mark processing' },
    { to: 'FAILED', label: 'Mark failed', danger: true },
  ],
  PROCESSING: [
    { to: 'PAID', label: 'Mark paid' },
    { to: 'FAILED', label: 'Mark failed', danger: true },
  ],
  FAILED: [{ to: 'PENDING', label: 'Retry (back to pending)' }],
  PAID: [],
};

const FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'PAID', label: 'Paid' },
  { value: 'FAILED', label: 'Failed' },
] as const;

export default function SettlementsPage() {
  const [params, setParams] = useSearchParams();
  const role = useAuth((state) => state.user?.role);
  const canManage = role ? roleHasPermission(role, Permission.SETTLEMENT_MANAGE) : false;
  const perms = useSellerPermissions();
  const sellerId = params.get('seller') ?? 'ALL';
  const status = params.get('status') ?? 'ALL';
  const [open, setOpen] = useState<string | null>(null);
  const [changing, setChanging] = useState<{ row: SettlementRow; to: SettlementRow['status']; label: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const sellers = useSellerOptions(perms.canRead);

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value && value !== 'ALL') next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  const list = useInfiniteQuery({
    queryKey: ['admin', 'settlements', sellerId, status],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: '25' });
      if (sellerId !== 'ALL') query.set('sellerId', sellerId);
      if (status !== 'ALL') query.set('status', status);
      if (pageParam) query.set('cursor', pageParam);
      return api.get<{ items: SettlementRow[]; hasMore: boolean; nextCursor: string | null }>(`/admin/settlements?${query.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
  });
  const rows = (list.data?.pages ?? []).flatMap((p) => p.items);

  return (
    <div className="space-y-5">
      <Surface className="space-y-3 p-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          {perms.canRead ? (
            <FilterSelect
              label="Seller"
              value={sellerId}
              className="min-w-[14rem]"
              options={[{ value: 'ALL', label: 'All sellers' }, ...(sellers.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
              onChange={(next) => update({ seller: next })}
            />
          ) : (
            <span />
          )}
          {canManage && perms.canRead && (
            <Button onClick={() => setCreating(true)}>
              <Icon name="plus" className="h-4 w-4" /> Create settlement
            </Button>
          )}
        </div>
        <ChipTabs label="Settlement status" value={status} options={FILTERS} onChange={(next) => update({ status: next })} />
        <p className="text-xs text-gray-500">
          A settlement pays a seller for delivered, paid orders in its period: net = gross − Aadione commission. Orders with a refund are held back
          by the backend and are not settled.
        </p>
      </Surface>

      {list.isPending ? (
        <SkeletonList rows={5} label="Loading settlements…" />
      ) : list.isError && rows.length === 0 ? (
        <LoadError message={adminErrorMessage(list.error)} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="clipboard" title="No settlements found" hint={sellerId !== 'ALL' || status !== 'ALL' ? 'Try clearing your filters.' : undefined} />
      ) : (
        <Surface className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <caption className="sr-only">Settlements</caption>
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th scope="col" className="px-4 py-3">Period</th>
                  <th scope="col" className="px-3 py-3">Seller</th>
                  <th scope="col" className="px-3 py-3 text-right">Gross</th>
                  <th scope="col" className="px-3 py-3 text-right">Commission</th>
                  <th scope="col" className="px-3 py-3 text-right">Net payable</th>
                  <th scope="col" className="px-3 py-3">Status</th>
                  <th scope="col" className="px-3 py-3">Paid on</th>
                  <th scope="col" className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr className="hover:bg-gray-50/60">
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-900">
                        {shortDate.format(new Date(row.periodStart))} – {shortDate.format(new Date(row.periodEnd))}
                      </td>
                      <td className="px-3 py-3">
                        <SellerLink seller={{ id: row.sellerId, name: row.sellerName }} tab="settlements" />
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatPaise(row.grossSalesPaise)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatPaise(row.commissionPaise)}</td>
                      <td className="px-3 py-3 text-right font-bold tabular-nums text-gray-900">{formatPaise(row.netPayablePaise)}</td>
                      <td className="px-3 py-3">
                        <Pill tone={STATUS_LOOK[row.status]?.tone ?? 'gray'}>{STATUS_LOOK[row.status]?.label ?? row.status}</Pill>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-600">{row.paidAt ? shortDate.format(new Date(row.paidAt)) : '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={() => setOpen(open === row.id ? null : row.id)}>
                            {open === row.id ? 'Hide orders' : 'Orders'}
                          </Button>
                          {canManage &&
                            NEXT[row.status]?.map((action) => (
                              <Button
                                key={action.to}
                                variant={action.danger ? 'secondary' : 'soft'}
                                className="min-h-9 px-3 text-xs"
                                onClick={() => setChanging({ row, to: action.to, label: action.label })}
                              >
                                {action.label}
                              </Button>
                            ))}
                        </div>
                      </td>
                    </tr>
                    {open === row.id && (
                      <tr>
                        <td colSpan={8} className="bg-gray-50/60 px-4 pb-4">
                          <SettlementOrders id={row.id} />
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
        </Surface>
      )}

      {changing && <StatusModal {...changing} onClose={() => setChanging(null)} />}
      {creating && <CreateModal sellers={sellers.data ?? []} onClose={() => setCreating(false)} />}
    </div>
  );
}

function OrdersTable({ orders }: { orders: SettlementOrder[] }) {
  if (orders.length === 0) return <p className="py-3 text-sm text-gray-500">No orders in this period.</p>;
  return (
    <table className="mt-3 w-full text-sm">
      <thead className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
        <tr>
          <th scope="col" className="py-2 pr-3">Order</th>
          <th scope="col" className="py-2 pr-3">Delivered</th>
          <th scope="col" className="py-2 pr-3 text-right">Gross</th>
          <th scope="col" className="py-2 pr-3 text-right">Commission</th>
          <th scope="col" className="py-2 pr-3 text-right">Refunded</th>
          <th scope="col" className="py-2 text-right">Seller gets</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-200">
        {orders.map((o) => (
          <tr key={o.orderNumber}>
            <td className="py-2 pr-3 font-mono font-semibold">#{o.orderNumber}</td>
            <td className="py-2 pr-3 text-gray-600">{o.deliveredAt ? shortDate.format(new Date(o.deliveredAt)) : '—'}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{formatPaise(o.grossPaise)}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{formatPaise(o.commissionPaise)}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{o.refundedPaise > 0 ? formatPaise(o.refundedPaise) : '—'}</td>
            <td className="py-2 text-right font-semibold tabular-nums">{formatPaise(o.finalPayablePaise)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettlementOrders({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ['admin', 'settlements', 'detail', id],
    queryFn: () => api.get<SettlementRow & { sellerOrders: SettlementOrder[] }>(`/admin/settlements/${id}`),
  });
  if (detail.isPending) return <SkeletonList rows={1} label="Loading settlement…" />;
  if (detail.isError) return <LoadError message={adminErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />;
  return (
    <div className="pt-2">
      <p className="text-xs text-gray-500">
        Created {shortDateTime.format(new Date(detail.data.createdAt))} · {detail.data.sellerOrders.length} order
        {detail.data.sellerOrders.length === 1 ? '' : 's'}
      </p>
      <OrdersTable orders={detail.data.sellerOrders} />
    </div>
  );
}

function StatusModal({ row, to, label, onClose }: { row: SettlementRow; to: SettlementRow['status']; label: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: () => api.patch(`/admin/settlements/${row.id}/status`, { status: to }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settlements'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sellers', row.sellerId] });
      onClose();
    },
  });
  return (
    <Modal
      title={`${label}?`}
      subtitle={`${row.sellerName} · ${formatPaise(row.netPayablePaise)} · ${shortDate.format(new Date(row.periodStart))} – ${shortDate.format(new Date(row.periodEnd))}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={to === 'FAILED' ? 'danger' : 'primary'} disabled={change.isPending} onClick={() => change.mutate()}>
            {change.isPending ? 'Saving…' : label}
          </Button>
        </>
      }
    >
      <ErrorBanner message={change.isError ? adminErrorMessage(change.error) : null} />
      <p className="text-sm text-gray-600">
        {to === 'PAID'
          ? 'Only mark it paid once the money has actually reached the seller. The seller sees it as paid straight away.'
          : to === 'FAILED'
            ? 'The seller sees this payout as failed. You can put it back to pending to retry.'
            : 'The seller sees the new status in their Settlements screen.'}
      </p>
    </Modal>
  );
}

function CreateModal({ sellers, onClose }: { sellers: { id: string; name: string }[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [sellerId, setSellerId] = useState(sellers[0]?.id ?? '');
  const preview = useQuery({
    queryKey: ['admin', 'settlements', 'eligible', sellerId],
    queryFn: () => api.get<EligiblePreview>(`/admin/sellers/${sellerId}/settlements/eligible`),
    enabled: sellerId !== '',
  });
  const create = useMutation({
    mutationFn: () => api.post(`/admin/sellers/${sellerId}/settlements`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settlements'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sellers', sellerId] });
      onClose();
    },
  });
  const p = preview.data;
  const nothing = p !== undefined && p.sellerOrders.length === 0;
  return (
    <Modal
      title="Create a settlement"
      subtitle="Settles the seller's delivered, paid orders since its last settlement."
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!p || nothing || p.overlapsExistingSettlement || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create settlement'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FilterSelect label="Seller" value={sellerId} options={sellers.map((s) => ({ value: s.id, label: s.name }))} onChange={setSellerId} />
        <ErrorBanner message={create.isError ? adminErrorMessage(create.error) : null} />
        {preview.isPending ? (
          <SkeletonList rows={2} label="Checking eligible orders…" />
        ) : preview.isError ? (
          <LoadError message={adminErrorMessage(preview.error)} onRetry={() => void preview.refetch()} />
        ) : p ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Period', `${shortDate.format(new Date(p.periodStart))} – ${shortDate.format(new Date(p.periodEnd))}`],
                ['Gross', formatPaise(p.grossSalesPaise)],
                ['Commission', formatPaise(p.commissionPaise)],
                ['Net payable', formatPaise(p.netPayablePaise)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-gray-50 px-3 py-2">
                  <dt className="text-xs text-gray-500">{label}</dt>
                  <dd className="font-semibold text-gray-900">{value}</dd>
                </div>
              ))}
            </dl>
            {p.overlapsExistingSettlement && <ErrorBanner message="This period overlaps an existing settlement, so it can't be created." />}
            {nothing ? <p className="text-sm text-gray-500">No delivered, paid orders are waiting to be settled for this seller.</p> : <OrdersTable orders={p.sellerOrders} />}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
