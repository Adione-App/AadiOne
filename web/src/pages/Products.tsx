/**
 * Products — the marketplace-wide catalogue, for monitoring and moderation.
 *
 * Every seller — Aadione's own store included — creates and edits its
 * products in the Seller Panel; Product Approvals reviews them. This page
 * shows what is on the marketplace (GET /admin/marketplace/products: one row
 * per seller listing, plus seller products not listed yet) and offers the
 * one admin action on seller catalogue data: Disable / Enable
 * (PATCH /admin/products/:id/moderation, SELLER_MANAGE). It never edits a
 * product's content.
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { useSellerPermissions } from '@/lib/sellers';
import {
  adminErrorMessage,
  shortDate,
  toQuery,
  useMarketplaceProducts,
  useSellerOptions,
  type MarketplaceProductRow,
} from '@/lib/marketplace';
import { Button, ErrorBanner, Field, Icon, Modal, Surface, Thumb, inputClass } from '@/components/ui';
import { ApprovalBadge, Pager, ProductStatusBadge, SellerLink, StockBadge, VisibilityBadge } from '@/components/MarketplaceUi';
import { EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList } from '@/seller/sellerUi';
import { useDebouncedValue } from '@/seller/sellerQueries';

const PAGE_SIZE = 25;

const APPROVALS = [
  { value: 'ALL', label: 'Any approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'REJECTED', label: 'Rejected' },
] as const;
const VISIBILITIES = [
  { value: 'ALL', label: 'Any visibility' },
  { value: 'BUYABLE', label: 'Buyable now' },
  { value: 'NOT_BUYABLE', label: 'Not buyable' },
  { value: 'DISABLED', label: 'Disabled by Aadione' },
] as const;
const STOCKS = [
  { value: 'ALL', label: 'Any stock' },
  { value: 'LOW', label: 'Low stock' },
  { value: 'OUT', label: 'Out of stock' },
] as const;

export default function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const perms = useSellerPermissions();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 350);
  const sellerId = params.get('seller') ?? 'ALL';
  const approval = params.get('approval') ?? 'ALL';
  const visibility = params.get('visibility') ?? 'ALL';
  const stock = params.get('stock') ?? 'ALL';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [moderating, setModerating] = useState<MarketplaceProductRow | null>(null);

  const query = toQuery({
    q,
    sellerId: sellerId === 'ALL' ? null : sellerId,
    approval,
    visibility,
    stock,
    page,
    pageSize: PAGE_SIZE,
  });
  const products = useMarketplaceProducts(query);
  const sellers = useSellerOptions(perms.canRead);

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
  // The debounced search goes into the URL (and back to page 1).
  useEffect(() => {
    if ((params.get('q') ?? '') !== q) update({ q: q || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filtered = q !== '' || sellerId !== 'ALL' || approval !== 'ALL' || visibility !== 'ALL' || stock !== 'ALL';
  const summary = products.data?.summary;
  const tiles: { label: string; value: number | undefined; apply: Record<string, string | null> }[] = [
    { label: 'All products', value: summary?.total, apply: { approval: null, visibility: null, stock: null } },
    { label: 'Buyable now', value: summary?.buyable, apply: { visibility: 'BUYABLE', approval: null, stock: null } },
    { label: 'Pending approval', value: summary?.pendingApproval, apply: { approval: 'PENDING', visibility: null, stock: null } },
    { label: 'Rejected', value: summary?.rejected, apply: { approval: 'REJECTED', visibility: null, stock: null } },
    { label: 'Low stock', value: summary?.lowStock, apply: { stock: 'LOW', approval: null, visibility: null } },
    { label: 'Out of stock', value: summary?.outOfStock, apply: { stock: 'OUT', approval: null, visibility: null } },
    { label: 'Disabled by Aadione', value: summary?.disabled, apply: { visibility: 'DISABLED', approval: null, stock: null } },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-info-500/20 bg-info-50 px-4 py-3 text-sm text-gray-700">
        <Icon name="shield" className="mt-0.5 h-5 w-5 shrink-0 text-info-500" />
        <p>
          Every seller — Aadione included — creates and edits its products in the{' '}
          <span className="font-semibold">Seller Panel</span>. New products reach customers after{' '}
          <Link to="/product-approvals" className="font-semibold text-brand-600 hover:underline">
            Product Approvals
          </Link>
          . Here you monitor the whole marketplace and can disable a product when needed.
        </p>
      </div>

      <section aria-label="Catalogue summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {tiles.map((tile) => (
          <button
            key={tile.label}
            type="button"
            onClick={() => update(tile.apply)}
            className="rounded-2xl border border-gray-200/80 bg-white p-3.5 text-left shadow-sm outline-none transition hover:border-brand-200 focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <span className="block text-xs font-medium text-gray-500">{tile.label}</span>
            <span className="mt-1 block text-xl font-bold text-gray-900">{tile.value ?? '—'}</span>
          </button>
        ))}
      </section>

      <Surface className="grid gap-3 p-3 md:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto] md:items-end">
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Product</span>
          <SearchBox value={search} onChange={setSearch} placeholder="Search product name…" label="Search products" />
        </div>
        {perms.canRead && (
          <FilterSelect
            label="Seller"
            value={sellerId}
            options={[{ value: 'ALL', label: 'All sellers' }, ...(sellers.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
            onChange={(next) => update({ seller: next })}
          />
        )}
        <FilterSelect label="Approval" value={approval} options={APPROVALS} onChange={(next) => update({ approval: next })} />
        <FilterSelect label="Customer visibility" value={visibility} options={VISIBILITIES} onChange={(next) => update({ visibility: next })} />
        <FilterSelect label="Stock" value={stock} options={STOCKS} onChange={(next) => update({ stock: next })} />
        <Button
          variant="ghost"
          disabled={!filtered}
          onClick={() => {
            setSearch('');
            update({ q: null, seller: null, approval: null, visibility: null, stock: null });
          }}
        >
          Clear filters
        </Button>
      </Surface>

      {products.isPending ? (
        <SkeletonList rows={6} label="Loading the marketplace catalogue…" />
      ) : products.isError ? (
        <LoadError message={adminErrorMessage(products.error)} onRetry={() => void products.refetch()} />
      ) : products.data.items.length === 0 ? (
        <EmptyPanel icon="products" title="No products found" hint={filtered ? 'Try clearing your filters.' : 'Sellers have not added any products yet.'} />
      ) : (
        <>
          <Surface className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <caption className="sr-only">Marketplace products</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">Product</th>
                    <th scope="col" className="px-3 py-3">Seller</th>
                    <th scope="col" className="px-3 py-3">Category</th>
                    <th scope="col" className="px-3 py-3">Price</th>
                    <th scope="col" className="px-3 py-3">Stock</th>
                    <th scope="col" className="px-3 py-3">Approval</th>
                    <th scope="col" className="px-3 py-3">Visibility</th>
                    <th scope="col" className="px-3 py-3">Status</th>
                    <th scope="col" className="px-3 py-3">Updated</th>
                    <th scope="col" className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {products.data.items.map((row) => (
                    <tr key={row.key} className="align-middle hover:bg-gray-50/60">
                      <td className="px-4 py-3">
                        <div className="flex min-w-[13rem] items-center gap-3">
                          <Thumb src={row.imageUrl} alt={row.productName} />
                          <div className="min-w-0">
                            <p className="line-clamp-2 font-semibold text-gray-900">{row.productName}</p>
                            <p className="truncate text-xs text-gray-500">
                              {row.variantName ?? '—'}
                              {row.ownership === 'CATALOG' && ' · shared catalogue'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <SellerLink seller={row.seller} tab="products" />
                      </td>
                      <td className="px-3 py-3 text-gray-700">{row.category.name}</td>
                      <td className="whitespace-nowrap px-3 py-3">
                        {row.listing ? (
                          <>
                            <span className="font-semibold text-gray-900">{formatPaise(row.listing.pricePaise)}</span>
                            {row.listing.mrpPaise > row.listing.pricePaise && (
                              <span className="block text-xs text-gray-400 line-through">{formatPaise(row.listing.mrpPaise)}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-gray-400">Not listed</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        {row.listing ? (
                          <div className="space-y-1">
                            <p className="tabular-nums text-gray-900">
                              <span className="font-semibold">{row.listing.availableQty}</span> available
                            </p>
                            <p className="text-xs text-gray-500">
                              {row.listing.stockQty} stock · {row.listing.reservedQty} reserved
                            </p>
                            {row.listing.stock !== 'IN_STOCK' && <StockBadge state={row.listing.stock} />}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <ApprovalBadge status={row.approvalStatus} />
                      </td>
                      <td className="px-3 py-3">
                        <VisibilityBadge reason={row.visibility.reason} />
                      </td>
                      <td className="px-3 py-3">
                        <ProductStatusBadge status={row.productStatus} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-500">{shortDate.format(new Date(row.updatedAt))}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-end gap-1.5">
                          <Link
                            to={`/sellers/${row.seller.id}?tab=products`}
                            className="text-xs font-semibold text-brand-600 hover:underline"
                            aria-label={`View ${row.productName} in ${row.seller.name}'s products`}
                          >
                            Seller products
                          </Link>
                          {perms.canManage && (
                            <Button
                              variant={row.productStatus === 'ARCHIVED' ? 'soft' : 'secondary'}
                              className="min-h-8 px-2.5 text-xs"
                              onClick={() => setModerating(row)}
                            >
                              {row.productStatus === 'ARCHIVED' ? 'Enable' : 'Disable'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
          <Pager page={page} pageSize={PAGE_SIZE} total={products.data.total} onPage={(next) => update({ page: String(next) })} />
        </>
      )}

      {moderating && <ModerationModal row={moderating} onClose={() => setModerating(null)} />}
    </div>
  );
}

/** Disable (reason required, sellers see it) or enable a product. Never edits it. */
function ModerationModal({ row, onClose }: { row: MarketplaceProductRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const disabling = row.productStatus !== 'ARCHIVED';
  const [reason, setReason] = useState('');
  const moderate = useMutation({
    mutationFn: () =>
      api.patch(`/admin/products/${row.productId}/moderation`, {
        action: disabling ? 'DISABLE' : 'ENABLE',
        ...(disabling ? { reason: reason.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'marketplace'] });
      onClose();
    },
  });
  const valid = !disabling || reason.trim().length >= 3;

  return (
    <Modal
      title={`${disabling ? 'Disable' : 'Enable'} “${row.productName}”?`}
      subtitle={
        disabling
          ? row.ownership === 'CATALOG'
            ? 'This is a shared catalogue product: disabling it stops it being sold by every seller that lists it.'
            : `${row.seller.name} will not be able to put it back on sale until Aadione enables it.`
          : row.ownership === 'CATALOG'
            ? 'It becomes available to the sellers that list it again.'
            : 'It comes back hidden — the seller decides when to show it again.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={disabling ? 'danger' : 'primary'} disabled={!valid || moderate.isPending} onClick={() => moderate.mutate()}>
            {moderate.isPending ? 'Saving…' : disabling ? 'Disable product' : 'Enable product'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner message={moderate.isError ? adminErrorMessage(moderate.error) : null} />
        {disabling && (
          <Field label="Reason (shown to the seller)" required>
            <textarea value={reason} maxLength={300} rows={3} onChange={(event) => setReason(event.target.value)} className={inputClass} placeholder="e.g. Label shows an expired licence number" />
          </Field>
        )}
        <p className="text-xs text-gray-500">Recorded in the audit log with your name and the reason.</p>
      </div>
    </Modal>
  );
}
