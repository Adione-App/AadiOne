/**
 * Inventory — every listing the seller sells (GET /seller/listings), with
 * stock, reserved and available side by side, quick ±1, a full adjustment
 * dialog (the product page's InventoryPanel) and the stock history
 * (GET /seller/listings/:id/stock-movements).
 *
 * All changes go through POST /seller/listings/:id/stock-adjust, which the
 * server row-locks and never lets go below what is reserved for open orders
 * or below zero; the buttons here only avoid offering an obviously invalid
 * change. Quick ±1 taps show at once and are batched per listing
 * (stockBatch.ts); the server's answer replaces the figures, a refused batch
 * is taken back.
 */

import { useMemo, useState } from 'react';
import { smartSearch } from '@shared/search-match';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Modal, Pill, Surface } from '@/components/ui';
import { sellerErrorMessage, type SellerListingInventory } from '../sellerApi';
import { useRefreshInventory, useSellerListings, useStockBatcher } from '../sellerQueries';
import { listingCategories } from '../productSearch';
import { ProductImage, StockStepper, VisibilityPill, shortDate } from '../productUi';
import { InventoryPanel, StockHistory } from '../productSections';
import { ChipTabs, EmptyPanel, LoadError, SearchBox, SkeletonList } from '../sellerUi';

const FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'LOW', label: 'Low stock' },
  { value: 'OUT', label: 'Out of stock' },
  { value: 'OFF', label: 'Off sale' },
] as const;
type StockFilter = (typeof FILTERS)[number]['value'];

const matches = (listing: SellerListingInventory, filter: StockFilter): boolean => {
  switch (filter) {
    case 'ALL':
      return true;
    case 'LOW':
      return listing.visibility.lowStock;
    case 'OUT':
      return listing.availableQty <= 0;
    case 'OFF':
      return !listing.isAvailable;
  }
};

/** Product page for an own product, listing page for a catalogue product. */
const hrefOf = (listing: SellerListingInventory): string =>
  listing.ownProduct ? `/seller/products/${listing.productId}` : `/seller/listings/${listing.id}`;

export default function SellerInventoryPage() {
  const [params, setParams] = useSearchParams();
  const filter: StockFilter = FILTERS.find((item) => item.value === params.get('stock'))?.value ?? 'ALL';
  const search = params.get('q') ?? '';
  const listings = useSellerListings();
  const refresh = useRefreshInventory();
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);

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

  // Quick ±1: on screen at once, batched per listing, never ignored while saving.
  const stock = useStockBatcher();
  const onAdjust = (listing: SellerListingInventory, delta: number) => stock.adjust(listing.id, delta, listing.productName);

  const all = listings.data ?? [];
  const term = search.trim();
  // Smart Search (shared/search-match.ts): English / Hindi / Hinglish names,
  // synonyms and typos; the urgency order below still applies to the matches.
  const searched = useMemo(
    () =>
      term
        ? smartSearch(all, term, (l) => [
            { text: l.productName, source: 'NAME' },
            // Subcategory and its top category, each its own field (like the backend index).
            ...listingCategories(l).map((c) => ({ text: c.name, source: 'CATEGORY' as const })),
          ])
        : all,
    [all, term],
  );
  // Most urgent first: out of stock, then low, then the rest by name.
  const rank = (l: SellerListingInventory) => (l.availableQty <= 0 ? 0 : l.visibility.lowStock ? 1 : 2);
  const visible = searched.filter((l) => matches(l, filter)).sort((a, b) => rank(a) - rank(b) || a.productName.localeCompare(b.productName));
  const selected = all.find((l) => l.id === adjusting) ?? null;
  const historyOf = all.find((l) => l.id === history) ?? null;
  const saving = (l: SellerListingInventory) => stock.busy(l.id);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <SearchBox value={search} onChange={(next) => update({ q: next || null })} placeholder="Search products…" label="Search inventory" />
        <ChipTabs
          label="Stock filter"
          value={filter}
          onChange={(next) => update({ stock: next })}
          options={FILTERS.map((item) => ({ value: item.value, label: item.label, count: listings.isPending ? null : searched.filter((l) => matches(l, item.value)).length }))}
        />
        <p className="text-xs text-gray-500">
          Available = in stock minus what is reserved for open orders. Stock can never go below what is reserved.
        </p>
      </div>

      {listings.isPending ? (
        <SkeletonList rows={5} label="Loading inventory…" />
      ) : listings.isError ? (
        <LoadError message={sellerErrorMessage(listings.error)} onRetry={() => void listings.refetch()} />
      ) : visible.length === 0 ? (
        all.length === 0 ? (
          <EmptyPanel
            icon="inventory"
            title="Nothing in your inventory yet"
            hint="Once a product is approved and you start selling it, its stock is managed here."
            action={
              <Link to="/seller/products" className="inline-flex min-h-11 items-center rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white">
                Go to Products
              </Link>
            }
          />
        ) : (
          <EmptyPanel
            icon="search"
            title="No products found"
            hint="Try clearing your filters."
            action={
              <Button variant="secondary" onClick={() => update({ q: null, stock: null })}>
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        <>
          {/* phones: cards */}
          <ul className="grid gap-3 md:hidden" aria-label="Inventory">
            {visible.map((l) => (
              <li key={l.id}>
                <Surface className="space-y-3 p-3.5">
                  <Link to={hrefOf(l)} className="flex items-start gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
                    <ProductImage src={l.imageUrl} alt={l.productName} size="h-14 w-14" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-semibold leading-snug text-gray-900">{l.productName}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <VisibilityPill reason={l.visibility.reason} />
                        {l.visibility.lowStock && <Pill tone="amber">Low stock</Pill>}
                      </div>
                    </div>
                  </Link>
                  <dl className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ['Stock', l.stockQty],
                      ['Reserved', l.reservedQty],
                      ['Available', l.availableQty],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-gray-50 py-2">
                        <dt className="text-[11px] text-gray-500">{label}</dt>
                        <dd className={`text-base font-bold ${label === 'Available' && l.availableQty <= 0 ? 'text-danger-600' : 'text-gray-900'}`}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <StockStepper label={l.productName} availableQty={l.availableQty} stockQty={l.stockQty} busy={false} saving={saving(l)} onAdjust={(delta) => onAdjust(l, delta)} />
                    <div className="flex gap-1">
                      <Button variant="soft" onClick={() => setAdjusting(l.id)}>
                        Adjust
                      </Button>
                      <Button variant="ghost" onClick={() => setHistory(l.id)}>
                        History
                      </Button>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400">Updated {shortDate.format(new Date(l.updatedAt))}</p>
                </Surface>
              </li>
            ))}
          </ul>

          {/* md+: table sized to the page — stock, reserved and available share one cell. */}
          <Surface className="hidden overflow-hidden md:block">
            <div>
              <table className="w-full text-sm">
                <caption className="sr-only">Inventory</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-3 py-2.5">Product</th>
                    <th scope="col" className="px-2.5 py-2.5 text-center">Stock</th>
                    <th scope="col" className="px-2.5 py-2.5">Status</th>
                    <th scope="col" className="px-2.5 py-2.5">Last updated</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visible.map((l) => (
                    <tr key={l.id} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-3">
                          <ProductImage src={l.imageUrl} alt="" size="h-10 w-10" />
                          <div className="min-w-0">
                            <Link to={hrefOf(l)} className="break-words font-semibold leading-snug text-gray-900 outline-none hover:text-brand-600 focus-visible:underline">
                              {l.productName}
                            </Link>
                            <p className="break-words text-xs text-gray-500">{[l.categoryName, l.variantName].filter(Boolean).join(' · ')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2.5 py-2.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            aria-label={`Decrease stock of ${l.productName}`}
                            disabled={l.availableQty <= 0}
                            onClick={() => onAdjust(l, -1)}
                            className="h-7 w-7 rounded-lg border border-gray-200 text-gray-600 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40"
                          >
                            −
                          </button>
                          <span
                            aria-busy={saving(l)}
                            className={`min-w-[2.5rem] text-center font-semibold tabular-nums ${l.availableQty <= 0 ? 'text-danger-600' : l.visibility.lowStock ? 'text-warn-500' : 'text-gray-900'} ${saving(l) ? 'opacity-70' : ''}`}
                          >
                            {l.availableQty}
                          </span>
                          <button
                            type="button"
                            aria-label={`Increase stock of ${l.productName}`}
                            onClick={() => onAdjust(l, 1)}
                            className="h-7 w-7 rounded-lg border border-gray-200 text-gray-600 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40"
                          >
                            +
                          </button>
                        </div>
                        <span className="mt-0.5 block text-[11px] tabular-nums text-gray-500">
                          {l.stockQty} stock · {l.reservedQty} reserved
                        </span>
                      </td>
                      <td className="px-2.5 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <VisibilityPill reason={l.visibility.reason} />
                          {l.visibility.lowStock && <Pill tone="amber">Low</Pill>}
                        </div>
                      </td>
                      <td className="px-2.5 py-2.5 text-xs text-gray-500">{shortDate.format(new Date(l.updatedAt))}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button variant="soft" onClick={() => setAdjusting(l.id)} className="min-h-9 px-3 text-xs">
                            Adjust
                          </Button>
                          <Button variant="ghost" onClick={() => setHistory(l.id)} className="min-h-9 px-3 text-xs">
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
        </>
      )}

      {selected && (
        <Modal title={`Stock · ${selected.productName}`} subtitle="Add or remove units. Every change is recorded." onClose={() => setAdjusting(null)} wide>
          <InventoryPanel key={selected.id} listing={selected} label={selected.productName} onChanged={refresh} />
        </Modal>
      )}
      {historyOf && (
        <Modal title={`Stock history · ${historyOf.productName}`} onClose={() => setHistory(null)} wide>
          <StockHistory listingId={historyOf.id} />
        </Modal>
      )}
    </div>
  );
}
