/**
 * Seller Products — its own products (GET /seller/products) and the
 * catalogue products it sells (GET /seller/listings), one list
 * (productRows.ts). Search, quick views, approval/stock filters and sorting
 * run on the loaded lists (a seller's catalogue is small enough; the server
 * has no paged product search) and live in the URL. Table from lg up, cards
 * below it.
 *
 *   View / Edit / Images   → product page (/seller/products/:id) or, for a
 *                            catalogue product, the listing page
 *   Stock −/+              → POST /seller/listings/:id/stock-adjust
 *   Show / Hide            → own product: PATCH /seller/products/:id/status;
 *                            catalogue product: the listing's on-sale switch
 *
 * Status always comes from the server; every action re-fetches.
 */

import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { Button, Icon, Pill, Surface, Toggle } from '@/components/ui';
import { sellerApi, sellerErrorMessage, type SellerListingInventory, type SellerProductInventory } from '../sellerApi';
import { useApplyListing, useRefreshInventory, useSellerAvailability, useSellerListings, useSellerProducts } from '../sellerQueries';
import { ProductImage, StockStepper, VisibilityPill, shortDate } from '../productUi';
import { MenuSectionsModal, ProductFormModal, StartSellingModal } from '../productForms';
import { isHiddenBySeller, isOutOfStock, rowsOf, type ProductRow } from '../productRows';
import { ChipTabs, EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList, linkClass, toast } from '../sellerUi';

const PAGE = 20;

const VIEWS = [
  { value: 'ALL', label: 'All' },
  { value: 'ON_SALE', label: 'On sale' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'HIDDEN', label: 'Hidden' },
  { value: 'LOW_STOCK', label: 'Low stock' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock' },
  { value: 'DISABLED', label: 'Disabled by Aadione' },
] as const;
type View = (typeof VIEWS)[number]['value'];

const APPROVALS = [
  { value: 'ALL', label: 'Any approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'IN_REVIEW', label: 'In review' },
  { value: 'DRAFT', label: 'Draft (not submitted)' },
  { value: 'REJECTED', label: 'Rejected' },
] as const;
type Approval = (typeof APPROVALS)[number]['value'];

const STOCKS = [
  { value: 'ALL', label: 'Any stock' },
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'LOW', label: 'Low stock' },
  { value: 'OUT', label: 'Out of stock' },
  { value: 'NOT_LISTED', label: 'Not selling yet' },
] as const;
type Stock = (typeof STOCKS)[number]['value'];

const SORTS = [
  { value: 'UPDATED', label: 'Recently updated' },
  { value: 'NAME', label: 'Name (A–Z)' },
  { value: 'STOCK_ASC', label: 'Stock: low to high' },
  { value: 'STOCK_DESC', label: 'Stock: high to low' },
  { value: 'PRICE_ASC', label: 'Price: low to high' },
  { value: 'PRICE_DESC', label: 'Price: high to low' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

const pick = <T extends string>(options: readonly { value: T }[], raw: string | null, fallback: T): T =>
  options.find((option) => option.value === raw)?.value ?? fallback;

function matchesView(row: ProductRow, view: View): boolean {
  switch (view) {
    case 'ALL':
      return true;
    case 'ON_SALE':
      return row.visibility.sellable;
    case 'APPROVED':
      return row.approval === 'APPROVED';
    case 'PENDING':
      return row.approval === 'PENDING';
    case 'REJECTED':
      return row.approval === 'REJECTED';
    case 'HIDDEN':
      return isHiddenBySeller(row);
    case 'LOW_STOCK':
      return row.visibility.lowStock;
    case 'OUT_OF_STOCK':
      return isOutOfStock(row);
    case 'DISABLED':
      return row.adminLocked;
  }
}

function matchesApproval(row: ProductRow, approval: Approval): boolean {
  switch (approval) {
    case 'ALL':
      return true;
    case 'APPROVED':
      return row.approval === 'APPROVED';
    case 'IN_REVIEW':
      return row.approval === 'PENDING' && !row.draft;
    case 'DRAFT':
      return row.draft;
    case 'REJECTED':
      return row.approval === 'REJECTED';
  }
}

function matchesStock(row: ProductRow, stock: Stock): boolean {
  switch (stock) {
    case 'ALL':
      return true;
    case 'IN_STOCK':
      return row.listing !== null && row.listing.availableQty > 0 && !row.visibility.lowStock;
    case 'LOW':
      return row.visibility.lowStock;
    case 'OUT':
      return row.listing !== null && row.listing.availableQty <= 0;
    case 'NOT_LISTED':
      return row.listing === null;
  }
}

/** Rows without a listing sort after rows with one, whichever the direction. */
function compare(sort: Sort): (a: ProductRow, b: ProductRow) => number {
  const byNumber = (get: (row: ProductRow) => number | null, direction: 1 | -1) => (a: ProductRow, b: ProductRow) => {
    const x = get(a);
    const y = get(b);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return (x - y) * direction || a.name.localeCompare(b.name);
  };
  switch (sort) {
    case 'UPDATED':
      return (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
    case 'NAME':
      return (a, b) => a.name.localeCompare(b.name);
    case 'STOCK_ASC':
      return byNumber((row) => row.listing?.availableQty ?? null, 1);
    case 'STOCK_DESC':
      return byNumber((row) => row.listing?.availableQty ?? null, -1);
    case 'PRICE_ASC':
      return byNumber((row) => row.listing?.pricePaise ?? null, 1);
    case 'PRICE_DESC':
      return byNumber((row) => row.listing?.pricePaise ?? null, -1);
  }
}

export default function SellerProductsPage() {
  const [params, setParams] = useSearchParams();
  const view = pick(VIEWS, params.get('view') ?? legacyView(params.get('filter')), 'ALL');
  const approval = pick(APPROVALS, params.get('approval'), 'ALL');
  const stock = pick(STOCKS, params.get('stock'), 'ALL');
  const sort = pick(SORTS, params.get('sort'), 'UPDATED');
  const search = params.get('q') ?? '';
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState<SellerProductInventory | null>(null);
  const [managingSections, setManagingSections] = useState(false);
  const isRestaurant = useSellerAvailability().data?.sellerType === 'RESTAURANT';

  const products = useSellerProducts();
  const listings = useSellerListings();
  const refresh = useRefreshInventory();
  const apply = useApplyListing();

  const update = (changes: Record<string, string | null>) => {
    setShown(PAGE);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('filter');
        for (const [key, value] of Object.entries(changes)) {
          if (value && value !== 'ALL' && !(key === 'sort' && value === 'UPDATED')) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  };

  const adjust = useMutation({
    mutationFn: (input: { row: ProductRow; delta: number }) =>
      sellerApi.post<SellerListingInventory>(`/seller/listings/${input.row.listing!.id}/stock-adjust`, { delta: input.delta }),
    onSuccess: (listing, input) => {
      apply(listing);
      toast(`${input.row.name}: ${listing.availableQty} available.`);
    },
    onError: (error) => toast(sellerErrorMessage(error), false),
    onSettled: () => refresh(),
  });
  const toggle = useMutation({
    mutationFn: (row: ProductRow) =>
      row.own
        ? sellerApi.patch(`/seller/products/${row.productId}/status`, { status: row.productShown ? 'INACTIVE' : 'ACTIVE' })
        : sellerApi.patch(`/seller/listings/${row.listing!.id}`, { isAvailable: !row.listing!.isAvailable }),
    onSuccess: (_data, row) => toast(`${row.name} is now ${isShown(row) ? 'hidden' : 'shown'}.`),
    onError: (error) => toast(sellerErrorMessage(error), false),
    onSettled: () => refresh(),
  });

  // Rows with a change in flight — set synchronously, so a fast double click
  // never sends a second request before the buttons re-render disabled.
  const inFlight = useRef(new Set<string>());
  const guarded = (row: ProductRow, run: (done: () => void) => void) => {
    if (inFlight.current.has(row.key)) return;
    inFlight.current.add(row.key);
    run(() => inFlight.current.delete(row.key));
  };
  const onAdjust = (row: ProductRow, delta: number) => guarded(row, (done) => adjust.mutate({ row, delta }, { onSettled: done }));
  const onToggle = (row: ProductRow) => guarded(row, (done) => toggle.mutate(row, { onSettled: done }));

  const rows = useMemo(() => rowsOf(products.data ?? [], listings.data ?? []), [products.data, listings.data]);
  const term = search.trim().toLowerCase();
  const narrowed = rows.filter(
    (row) =>
      (!term || row.name.toLowerCase().includes(term) || row.category.toLowerCase().includes(term)) &&
      matchesApproval(row, approval) &&
      matchesStock(row, stock),
  );
  const visible = narrowed.filter((row) => matchesView(row, view)).sort(compare(sort));
  const loading = products.isPending || listings.isPending;
  const error = products.error ?? listings.error;
  const filtersOn = view !== 'ALL' || approval !== 'ALL' || stock !== 'ALL' || term !== '';

  const isShown = (row: ProductRow) => (row.own ? row.productShown : row.listing?.isAvailable ?? false);
  const adjusting = (row: ProductRow) => adjust.isPending && adjust.variables?.row.key === row.key;
  const toggling = (row: ProductRow) => toggle.isPending && toggle.variables?.key === row.key;
  const clearAll = () => update({ view: null, approval: null, stock: null, q: null });

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <SearchBox value={search} onChange={(next) => update({ q: next || null })} placeholder="Search products or categories…" label="Search products" className="min-w-0 flex-1" />
          <Button onClick={() => setAdding(true)} className="hidden shrink-0 sm:inline-flex">
            <Icon name="plus" className="h-4 w-4" /> Add Product
          </Button>
        </div>
        <ChipTabs
          label="Quick views"
          value={view}
          onChange={(next) => update({ view: next })}
          options={VIEWS.map((item) => ({ value: item.value, label: item.label, count: loading ? null : narrowed.filter((row) => matchesView(row, item.value)).length }))}
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(3,minmax(0,12rem))_auto] sm:items-end">
          <FilterSelect label="Approval" value={approval} options={APPROVALS} onChange={(next) => update({ approval: next })} />
          <FilterSelect label="Stock" value={stock} options={STOCKS} onChange={(next) => update({ stock: next })} />
          <FilterSelect label="Sort by" value={sort} options={SORTS} onChange={(next) => update({ sort: next })} className="col-span-2 sm:col-span-1" />
          <Button variant="ghost" disabled={!filtersOn} onClick={clearAll} className="col-span-2 sm:col-span-1">
            Clear filters
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {isRestaurant ? (
            <button type="button" onClick={() => setManagingSections(true)} className={linkClass}>
              Menu sections
            </button>
          ) : (
            <Link to="/seller/categories" className={linkClass}>
              Manage categories
            </Link>
          )}
          <Link to="/seller/inventory" className={linkClass}>
            Inventory & stock history
          </Link>
        </div>
      </div>

      {loading ? (
        <SkeletonList rows={5} label="Loading products…" />
      ) : error ? (
        <LoadError message={sellerErrorMessage(error)} onRetry={() => void refresh()} />
      ) : visible.length === 0 ? (
        rows.length === 0 ? (
          <EmptyPanel
            icon="products"
            title="No products yet"
            hint="Add a product — Aadione reviews it, then you set your price and stock to start selling."
            action={<Button onClick={() => setAdding(true)}>Add Product</Button>}
          />
        ) : (
          <EmptyPanel
            icon="search"
            title="No products found"
            hint="Try clearing your filters."
            action={
              <Button variant="secondary" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        <>
          <p className="text-sm text-gray-500">
            Showing {Math.min(shown, visible.length)} of {visible.length} product{visible.length === 1 ? '' : 's'}
          </p>
          {/* below lg: cards */}
          <ul className="grid gap-3 md:grid-cols-2 lg:hidden" aria-label="Your products">
            {visible.slice(0, shown).map((row) => (
              <li key={row.key}>
                <Surface className="space-y-3 p-3.5">
                  <Link to={row.href} className="flex items-start gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
                    <ProductImage src={row.image} alt={row.name} size="h-16 w-16" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 font-semibold leading-snug text-gray-900">{row.name}</p>
                      <p className="mt-0.5 truncate text-xs text-gray-500">{row.category}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {row.approval !== 'APPROVED' && <Pill tone={row.review.tone}>{row.review.label}</Pill>}
                        {!row.own && <Pill tone="gray">Catalogue</Pill>}
                        <CustomerPill row={row} />
                        {row.visibility.lowStock && <Pill tone="amber">Low stock</Pill>}
                      </div>
                    </div>
                  </Link>
                  {row.listing && (
                    <div className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-base font-bold text-gray-900">{formatPaise(row.listing.pricePaise)}</p>
                        <p className="text-xs text-gray-500">
                          {row.listing.stockQty} in stock · {row.listing.reservedQty} reserved
                        </p>
                      </div>
                      <StockStepper
                        label={row.name}
                        availableQty={row.listing.availableQty}
                        stockQty={row.listing.stockQty}
                        busy={adjusting(row)}
                        onAdjust={(delta) => onAdjust(row, delta)}
                      />
                    </div>
                  )}
                  <RowActions row={row} shown={isShown(row)} toggling={toggling(row)} onToggle={() => onToggle(row)} onStart={() => setStarting(row.product)} />
                </Surface>
              </li>
            ))}
          </ul>

          {/* lg+: table — the image sits in the Product cell and approval + customer
              status share one cell, so every column fits beside the sidebar. */}
          <Surface className="hidden overflow-hidden lg:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Your products</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">Product</th>
                    <th scope="col" className="px-3 py-3">Price</th>
                    <th scope="col" className="px-2 py-3 text-right">Stock</th>
                    <th scope="col" className="px-2 py-3 text-right">Reserved</th>
                    <th scope="col" className="px-2 py-3 text-center">Available</th>
                    <th scope="col" className="px-3 py-3">Status</th>
                    <th scope="col" className="px-3 py-3">Updated</th>
                    <th scope="col" className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visible.slice(0, shown).map((row) => (
                    <tr key={row.key} className="align-middle hover:bg-gray-50/60">
                      <td className="px-4 py-3">
                        <div className="flex min-w-[12rem] items-center gap-3">
                          <ProductImage src={row.image} alt={row.name} size="h-11 w-11" />
                          <div className="min-w-0">
                            <Link to={row.href} className="line-clamp-2 font-semibold text-gray-900 outline-none hover:text-brand-600 focus-visible:underline">
                              {row.name}
                            </Link>
                            <p className="truncate text-xs text-gray-500">{row.category}</p>
                            {!row.own && <p className="text-xs text-gray-400">Catalogue product</p>}
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        {row.listing ? (
                          <>
                            <p className="font-semibold text-gray-900">{formatPaise(row.listing.pricePaise)}</p>
                            {row.listing.mrpPaise > row.listing.pricePaise && <p className="text-xs text-gray-400 line-through">{formatPaise(row.listing.mrpPaise)}</p>}
                          </>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">{row.listing?.stockQty ?? '—'}</td>
                      <td className="px-2 py-3 text-right tabular-nums">{row.listing?.reservedQty ?? '—'}</td>
                      <td className="px-2 py-3">
                        {row.listing ? (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              aria-label={`Decrease stock of ${row.name}`}
                              disabled={adjusting(row) || row.listing.availableQty <= 0}
                              onClick={() => onAdjust(row, -1)}
                              className="h-7 w-7 rounded-lg border border-gray-200 text-gray-600 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40"
                            >
                              −
                            </button>
                            <span className={`min-w-[2rem] text-center font-semibold tabular-nums ${row.listing.availableQty === 0 ? 'text-danger-600' : 'text-gray-900'}`}>
                              {row.listing.availableQty}
                            </span>
                            <button
                              type="button"
                              aria-label={`Increase stock of ${row.name}`}
                              disabled={adjusting(row)}
                              onClick={() => onAdjust(row, 1)}
                              className="h-7 w-7 rounded-lg border border-gray-200 text-gray-600 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40"
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <span className="block text-center text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <span className="inline-flex items-center gap-1">
                            <span className="sr-only">Approval:</span>
                            <Pill tone={row.review.tone}>{row.review.label}</Pill>
                          </span>
                          <span className="inline-flex flex-wrap items-center gap-1">
                            <span className="sr-only">Customers:</span>
                            <CustomerPill row={row} />
                            {row.visibility.lowStock && <Pill tone="amber">Low</Pill>}
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-500">{shortDate.format(new Date(row.updatedAt))}</td>
                      <td className="px-4 py-3">
                        <RowActions row={row} shown={isShown(row)} toggling={toggling(row)} onToggle={() => onToggle(row)} onStart={() => setStarting(row.product)} compact />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
          {visible.length > shown && (
            <div className="text-center">
              <Button variant="secondary" onClick={() => setShown((value) => value + PAGE)}>
                Show more ({visible.length - shown} more)
              </Button>
            </div>
          )}
        </>
      )}

      <button
        type="button"
        onClick={() => setAdding(true)}
        aria-label="Add product"
        className="fixed bottom-20 right-4 z-20 inline-flex h-14 items-center gap-2 rounded-full bg-brand-500 px-5 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 outline-none transition focus-visible:ring-4 focus-visible:ring-brand-200 active:scale-95 sm:hidden"
      >
        <Icon name="plus" className="h-5 w-5" /> Add
      </button>

      {adding && (
        <ProductFormModal
          mode={{ kind: 'create' }}
          onClose={() => setAdding(false)}
          onDone={(result) => {
            setAdding(false);
            toast(result.text, result.ok);
            if (view !== 'ALL' && view !== 'PENDING') update({ view: 'PENDING' });
          }}
        />
      )}
      {managingSections && isRestaurant && <MenuSectionsModal onClose={() => setManagingSections(false)} />}
      {starting && (
        <StartSellingModal
          product={starting}
          onClose={() => setStarting(null)}
          onDone={(result) => {
            setStarting(null);
            toast(result.text, result.ok);
          }}
        />
      )}
    </div>
  );
}

/**
 * What customers see. When that is just the approval state again (pending /
 * rejected), say "Not on sale" instead of repeating the approval pill.
 */
function CustomerPill({ row }: { row: ProductRow }) {
  if (row.visibility.reason === 'PENDING_APPROVAL' || row.visibility.reason === 'REJECTED') return <Pill tone="gray">Not on sale</Pill>;
  return <VisibilityPill reason={row.visibility.reason} />;
}

/** Links from before the quick views were renamed (?filter=…). */
function legacyView(filter: string | null): string | null {
  if (filter === 'ON_SALE' || filter === 'PENDING' || filter === 'REJECTED' || filter === 'HIDDEN' || filter === 'LOW_STOCK' || filter === 'OUT_OF_STOCK') return filter;
  return null;
}

/** View · Edit · Images · Stock · Show/Hide (+ Start selling for an approved, unlisted product). */
function RowActions({
  row,
  shown,
  toggling,
  onToggle,
  onStart,
  compact = false,
}: {
  row: ProductRow;
  shown: boolean;
  toggling: boolean;
  onToggle: () => void;
  onStart: () => void;
  compact?: boolean;
}) {
  // A catalogue listing can only be shown when there is a listing to switch.
  const canToggle = row.own || row.listing !== null;
  const actions: { to: string; label: string; icon: 'eye' | 'edit' | 'image' | 'inventory' }[] = [
    { to: row.href, label: 'View', icon: 'eye' },
    ...(row.editable ? [{ to: `${row.href}#info`, label: 'Edit', icon: 'edit' as const }] : []),
    ...(row.own ? [{ to: `${row.href}#images`, label: 'Images', icon: 'image' as const }] : []),
    ...(row.listing ? [{ to: `${row.href}#inventory`, label: 'Stock', icon: 'inventory' as const }] : []),
  ];
  const toggleEl = canToggle && (
    <span className={`inline-flex items-center gap-2 text-gray-700 ${compact ? 'text-xs' : 'ml-auto min-h-10 text-sm'}`} title={row.adminLocked ? 'Disabled by Aadione' : undefined}>
      <span aria-hidden="true">{row.adminLocked ? 'Locked' : shown ? 'Shown' : 'Hidden'}</span>
      <Toggle
        checked={shown && !row.adminLocked}
        disabled={row.adminLocked || toggling}
        label={row.adminLocked ? `${row.name}: disabled by Aadione` : `Show ${row.name} to customers`}
        onChange={onToggle}
      />
    </span>
  );

  if (compact) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-0.5">
          {actions.map((action) => (
            <Link
              key={action.label}
              to={action.to}
              title={action.label}
              aria-label={`${action.label} ${row.name}`}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <Icon name={action.icon} className="h-4 w-4" />
            </Link>
          ))}
        </div>
        {row.canStartSelling ? (
          <Button onClick={onStart} className="min-h-8 px-2.5 text-xs">
            Start selling
          </Button>
        ) : (
          toggleEl
        )}
      </div>
    );
  }

  const link =
    'inline-flex min-h-10 items-center justify-center rounded-lg px-2.5 text-sm font-semibold text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-400';
  return (
    <div className="flex flex-wrap items-center gap-1">
      {actions.map((action) => (
        <Link key={action.label} to={action.to} className={link} aria-label={`${action.label} ${row.name}`}>
          {action.label}
        </Link>
      ))}
      {row.canStartSelling && <Button onClick={onStart}>Start selling</Button>}
      {toggleEl}
    </div>
  );
}
