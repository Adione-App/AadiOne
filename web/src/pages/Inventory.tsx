/**
 * Inventory — marketplace-wide stock monitoring (GET /admin/marketplace/
 * inventory). Every number here, including the summary, is computed by the
 * server over ALL sellers' listings with the seller panel's own definitions
 * (available = stock − reserved; low = 1…threshold; out = 0).
 *
 * Previously this page counted "Total products" from the customer catalogue
 * (first 100 active products) and "Low stock" from one store's listings, so
 * the two could disagree (e.g. 0 products but 1 low-stock item).
 *
 * READ ONLY. Every seller — Aadione included — manages its own price, stock
 * and on-sale switch in the Seller Panel; admin monitors and reads each
 * listing's stock history here.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { useSellerPermissions } from '@/lib/sellers';
import {
  adminErrorMessage,
  marketplaceKeys,
  shortDate,
  shortDateTime,
  toQuery,
  useMarketplaceInventory,
  useSellerOptions,
  type MarketplaceInventoryRow,
  type StockHistoryRow,
} from '@/lib/marketplace';
import { Button, Modal, Surface, Thumb } from '@/components/ui';
import { Pager, SellerLink, StockBadge, VisibilityBadge } from '@/components/MarketplaceUi';
import { ChipTabs, EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList } from '@/seller/sellerUi';
import { useDebouncedValue } from '@/seller/sellerQueries';

const PAGE_SIZE = 25;
const STOCK_FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'LOW', label: 'Low stock' },
  { value: 'OUT', label: 'Out of stock' },
  { value: 'IN', label: 'In stock' },
  { value: 'OFF', label: 'Off sale' },
] as const;
type StockFilter = (typeof STOCK_FILTERS)[number]['value'];

const MOVEMENT_LABEL: Record<string, string> = {
  PURCHASE: 'Stock received',
  MANUAL_ADJUST: 'Stock adjusted',
  ORDER_RESERVE: 'Held for an order',
  ORDER_RELEASE: 'Hold released',
  ORDER_COMMIT: 'Sold (order paid)',
  ORDER_CANCEL_RESTOCK: 'Returned (order cancelled)',
  DAMAGE: 'Damaged',
  EXPIRY: 'Expired',
  RETURN: 'Customer return',
};

export default function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const perms = useSellerPermissions();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 350);
  const sellerId = params.get('seller') ?? 'ALL';
  const stock = (STOCK_FILTERS.find((f) => f.value === params.get('stock'))?.value ?? 'ALL') as StockFilter;
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [history, setHistory] = useState<MarketplaceInventoryRow | null>(null);

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

  const inventory = useMarketplaceInventory(
    toQuery({ q, sellerId: sellerId === 'ALL' ? null : sellerId, stock, page, pageSize: PAGE_SIZE }),
  );
  const sellers = useSellerOptions(perms.canRead);
  const s = inventory.data?.summary;

  const cards: { label: string; value: string | number | undefined; hint: string; tone: string; filter?: StockFilter }[] = [
    { label: 'Listings', value: s?.totalListings, hint: s ? `${s.totalProducts} products · ${s.sellers} sellers` : '', tone: 'text-gray-900', filter: 'ALL' },
    { label: 'In stock', value: s?.inStock, hint: 'Above the low-stock level', tone: 'text-brand-600', filter: 'IN' },
    { label: 'Low stock', value: s?.lowStock, hint: 'At or under the threshold', tone: 'text-warn-500', filter: 'LOW' },
    { label: 'Out of stock', value: s?.outOfStock, hint: 'Nothing available', tone: 'text-danger-600', filter: 'OUT' },
    { label: 'Off sale', value: s?.offSale, hint: 'Switched off by the seller', tone: 'text-gray-700', filter: 'OFF' },
    { label: 'Stock value', value: s ? formatPaise(s.stockValuePaise) : undefined, hint: 'Available units × selling price', tone: 'text-gray-900' },
  ];

  return (
    <div className="space-y-5">
      <section aria-label="Stock summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) =>
          card.filter ? (
            <button
              key={card.label}
              type="button"
              onClick={() => update({ stock: card.filter! })}
              className="rounded-2xl border border-gray-200/80 bg-white p-3.5 text-left shadow-sm outline-none transition hover:border-brand-200 focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <span className="block text-xs font-medium text-gray-500">{card.label}</span>
              <span className={`mt-1 block text-xl font-bold ${card.tone}`}>{card.value ?? '—'}</span>
              <span className="block truncate text-[11px] text-gray-400">{card.hint}</span>
            </button>
          ) : (
            <div key={card.label} className="rounded-2xl border border-gray-200/80 bg-white p-3.5 shadow-sm">
              <span className="block text-xs font-medium text-gray-500">{card.label}</span>
              <span className={`mt-1 block text-xl font-bold ${card.tone}`}>{card.value ?? '—'}</span>
              <span className="block truncate text-[11px] text-gray-400">{card.hint}</span>
            </div>
          ),
        )}
      </section>

      <Surface className="space-y-3 p-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] md:items-end">
          <div>
            <span className="mb-1 block text-xs font-medium text-gray-500">Product</span>
            <SearchBox value={search} onChange={setSearch} placeholder="Search product name…" label="Search inventory" />
          </div>
          {perms.canRead && (
            <FilterSelect
              label="Seller"
              value={sellerId}
              options={[{ value: 'ALL', label: 'All sellers' }, ...(sellers.data ?? []).map((x) => ({ value: x.id, label: x.name }))]}
              onChange={(next) => update({ seller: next })}
            />
          )}
        </div>
        <ChipTabs label="Stock filter" value={stock} options={STOCK_FILTERS} onChange={(next) => update({ stock: next })} />
        <p className="text-xs text-gray-500">
          Every seller — Aadione included — manages its own stock in the Seller Panel. Each change is recorded in the stock history.
        </p>
      </Surface>

      {inventory.isPending ? (
        <SkeletonList rows={6} label="Loading inventory…" />
      ) : inventory.isError ? (
        <LoadError message={adminErrorMessage(inventory.error)} onRetry={() => void inventory.refetch()} />
      ) : inventory.data.items.length === 0 ? (
        <EmptyPanel icon="inventory" title="No listings found" hint="Try clearing your filters." />
      ) : (
        <>
          <Surface className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-sm">
                <caption className="sr-only">Marketplace inventory</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">Product</th>
                    <th scope="col" className="px-3 py-3">Seller</th>
                    <th scope="col" className="px-3 py-3 text-right">Stock</th>
                    <th scope="col" className="px-3 py-3 text-right">Reserved</th>
                    <th scope="col" className="px-3 py-3 text-right">Available</th>
                    <th scope="col" className="px-3 py-3">Status</th>
                    <th scope="col" className="px-3 py-3">Updated</th>
                    <th scope="col" className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {inventory.data.items.map((row) => (
                    <tr key={row.listingId} className="hover:bg-gray-50/60">
                      <td className="px-4 py-3">
                        <div className="flex min-w-[12rem] items-center gap-3">
                          <Thumb src={row.product.imageUrl} alt={row.product.name} />
                          <div className="min-w-0">
                            <p className="line-clamp-2 font-semibold text-gray-900">{row.product.name}</p>
                            <p className="truncate text-xs text-gray-500">{[row.product.variantName, row.product.category].filter(Boolean).join(' · ')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <SellerLink seller={row.seller} tab="products" />
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.stockQty}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.reservedQty}</td>
                      <td className={`px-3 py-3 text-right font-semibold tabular-nums ${row.stock === 'OUT' ? 'text-danger-600' : row.stock === 'LOW' ? 'text-warn-500' : 'text-gray-900'}`}>
                        {row.availableQty}
                        <span className="block text-[11px] font-normal text-gray-400">low at {row.lowStockThreshold}</span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <StockBadge state={row.stock} />
                          {row.visibilityReason !== 'VISIBLE' && row.visibilityReason !== 'OUT_OF_STOCK' && <VisibilityBadge reason={row.visibilityReason} />}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-500">{shortDate.format(new Date(row.updatedAt))}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={() => setHistory(row)}>
                            History
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
          <Pager page={page} pageSize={PAGE_SIZE} total={inventory.data.total} onPage={(next) => update({ page: String(next) })} />
        </>
      )}

      {history && <HistoryModal row={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function HistoryModal({ row, onClose }: { row: MarketplaceInventoryRow; onClose: () => void }) {
  const history = useQuery({
    queryKey: marketplaceKeys.history(row.listingId),
    queryFn: () => api.get<StockHistoryRow[]>(`/admin/marketplace/inventory/${row.listingId}/history`),
  });
  return (
    <Modal title={`Stock history · ${row.product.name}`} subtitle={row.seller.name} onClose={onClose} wide>
      {history.isPending ? (
        <SkeletonList rows={3} label="Loading stock history…" />
      ) : history.isError ? (
        <LoadError message={adminErrorMessage(history.error)} onRetry={() => void history.refetch()} />
      ) : history.data.length === 0 ? (
        <EmptyPanel icon="inventory" title="No stock changes yet" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">Stock history</caption>
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th scope="col" className="px-3 py-2">When</th>
                <th scope="col" className="px-3 py-2">Reason / note</th>
                <th scope="col" className="px-3 py-2 text-right">Before</th>
                <th scope="col" className="px-3 py-2 text-right">Change</th>
                <th scope="col" className="px-3 py-2 text-right">After</th>
                <th scope="col" className="px-3 py-2">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {history.data.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600">{shortDateTime.format(new Date(m.at))}</td>
                  <td className="px-3 py-2">
                    <span className="text-gray-900">{MOVEMENT_LABEL[m.reason] ?? m.reason}</span>
                    {m.orderNumber && <span className="block font-mono text-xs text-gray-500">#{m.orderNumber}</span>}
                    {m.note && <span className="block text-xs text-gray-500">“{m.note}”</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{m.availableBefore}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${m.delta >= 0 ? 'text-brand-600' : 'text-gray-700'}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{m.availableAfter}</td>
                  <td className="px-3 py-2 text-gray-600">{m.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
            Before / After are available units (stock minus reserved). A sale moves stock and its reservation together, so available does not change then.
          </p>
        </div>
      )}
    </Modal>
  );
}
