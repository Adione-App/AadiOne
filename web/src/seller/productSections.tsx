/**
 * Pricing, Inventory and Visibility sections — shared by the product detail
 * page (own products) and the listing detail page (catalogue products the
 * seller sells). Every change goes to the seller's own listing endpoints:
 *
 *   PATCH /seller/listings/:id               price / MRP / on-sale switch
 *   POST  /seller/listings/:id/stock-adjust  +N / −N (row-locked server-side)
 *   GET   /seller/listings/:id/stock-movements
 *   PATCH /seller/products/:id/status        show / hide an own product
 *
 * Commission is Aadione's (resolved at order time from its rules) — nothing
 * here computes it.
 */

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { Button, ErrorBanner, Field, Icon, Spinner, Surface, Toggle, inputClass } from '@/components/ui';
import { sellerApi, sellerErrorMessage, type ListingVisibility, type SellerAvailability, type StockMovement } from './sellerApi';
import { sellerKeys, useSellerAvailability } from './sellerQueries';
import { NoticeBar, VISIBILITY, VisibilityPill, dateTime, toPaise, type Notice } from './productUi';

export function Section({ id, title, subtitle, action, children }: { id: string; title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <Surface className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id={`${id}-title`} className="text-base font-semibold text-gray-900">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
          </div>
          {action}
        </div>
        {children}
      </Surface>
    </section>
  );
}

export interface ListingFigures {
  id: string;
  mrpPaise: number;
  pricePaise: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  isAvailable: boolean;
  lowStockThreshold: number;
  maxQtyPerOrder: number;
}

/* -------------------------------------------------------------------------- */
/* pricing                                                                     */
/* -------------------------------------------------------------------------- */

export function PricingPanel({ listing, onChanged }: { listing: ListingFigures; onChanged: () => Promise<unknown> }) {
  const [price, setPrice] = useState((listing.pricePaise / 100).toString());
  const [mrp, setMrp] = useState((listing.mrpPaise / 100).toString());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  // When the server's figures change (this save, or another tab), the inputs
  // follow them — without remounting, which would drop the "saved" notice.
  const [shown, setShown] = useState({ pricePaise: listing.pricePaise, mrpPaise: listing.mrpPaise });
  if (shown.pricePaise !== listing.pricePaise || shown.mrpPaise !== listing.mrpPaise) {
    setShown({ pricePaise: listing.pricePaise, mrpPaise: listing.mrpPaise });
    setPrice((listing.pricePaise / 100).toString());
    setMrp((listing.mrpPaise / 100).toString());
  }
  const save = useMutation({
    mutationFn: (body: { pricePaise?: number; mrpPaise?: number }) => sellerApi.patch(`/seller/listings/${listing.id}`, body),
  });

  async function submit(): Promise<void> {
    const pricePaise = toPaise(price);
    const mrpPaise = toPaise(mrp);
    if (pricePaise === null || mrpPaise === null) return setNotice({ ok: false, text: 'Enter valid prices greater than 0.' });
    if (pricePaise > mrpPaise) return setNotice({ ok: false, text: 'Your selling price cannot be higher than the MRP.' });
    const changes = {
      ...(pricePaise !== listing.pricePaise ? { pricePaise } : {}),
      ...(mrpPaise !== listing.mrpPaise ? { mrpPaise } : {}),
    };
    if (Object.keys(changes).length === 0) return setNotice({ ok: true, text: 'Nothing to save — no changes.' });
    setNotice(null);
    setBusy(true);
    try {
      await save.mutateAsync(changes);
      // Confirm only once the page shows the server's new figures.
      await onChanged();
      setNotice({ ok: true, text: `Price saved: ${formatPaise(pricePaise)} (MRP ${formatPaise(mrpPaise)}).` });
    } catch (error) {
      setNotice({ ok: false, text: sellerErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const discount = listing.mrpPaise > 0 ? Math.round(((listing.mrpPaise - listing.pricePaise) / listing.mrpPaise) * 100) : 0;
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Customers pay <span className="font-semibold text-gray-900">{formatPaise(listing.pricePaise)}</span>
        {discount > 0 && <span className="text-gray-500"> · {discount}% below MRP {formatPaise(listing.mrpPaise)}</span>}. Aadione&apos;s
        commission is worked out from its commission rules when an order is placed.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Selling price (₹)">
          <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" className={inputClass} />
        </Field>
        <Field label="MRP (₹)">
          <input value={mrp} onChange={(event) => setMrp(event.target.value)} inputMode="decimal" className={inputClass} />
        </Field>
      </div>
      <NoticeBar notice={notice} />
      <Button onClick={() => void submit()} disabled={busy} className="w-full sm:w-auto">
        {busy ? 'Saving…' : 'Save price'}
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* inventory                                                                   */
/* -------------------------------------------------------------------------- */

/** StockLedgerReason (schema.prisma) as the seller reads it. */
export const MOVEMENT_LABEL: Record<string, string> = {
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

function Figure({ label, value, tone = 'text-gray-900', hint }: { label: string; value: number; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-bold leading-tight ${tone}`}>{value}</p>
      {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

export function InventoryPanel({ listing, label, onChanged }: { listing: ListingFigures; label: string; onChanged: () => Promise<unknown> }) {
  const [direction, setDirection] = useState<1 | -1>(1);
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  // True from the request until the refreshed figures are on screen, so a
  // second tap never acts on stale numbers.
  const [busy, setBusy] = useState(false);
  const movements = useQuery({
    queryKey: [...sellerKeys.listings, listing.id, 'movements'],
    queryFn: () => sellerApi.get<StockMovement[]>(`/seller/listings/${listing.id}/stock-movements`),
  });
  const adjust = useMutation({
    mutationFn: (body: { delta: number; note?: string }) => sellerApi.post(`/seller/listings/${listing.id}/stock-adjust`, body),
  });

  async function apply(delta: number, withNote?: string): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      await adjust.mutateAsync({ delta, ...(withNote?.trim() ? { note: withNote.trim() } : {}) });
      setQty('');
      setNote('');
      await Promise.all([onChanged(), movements.refetch()]);
      setNotice({ ok: true, text: `${delta > 0 ? 'Added' : 'Removed'} ${Math.abs(delta)} unit${Math.abs(delta) === 1 ? '' : 's'} of ${label}.` });
    } catch (error) {
      setNotice({ ok: false, text: sellerErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const amount = Number(qty);
  const validAmount = qty.trim() !== '' && Number.isInteger(amount) && amount > 0 && amount <= 100_000;
  const out = listing.availableQty <= 0;
  const low = !out && listing.availableQty <= listing.lowStockThreshold;
  const quick = 'min-h-11 flex-1 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-800 transition active:scale-95 disabled:opacity-40';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Figure label="In stock" value={listing.stockQty} hint="on your shelf" />
        <Figure label="Reserved" value={listing.reservedQty} hint="held for open orders" />
        <Figure label="Available" value={listing.availableQty} tone={out ? 'text-danger-600' : low ? 'text-warn-500' : 'text-brand-600'} hint="customers can buy" />
      </div>
      {(out || low) && (
        <p className={`rounded-xl px-3 py-2 text-sm ${out ? 'bg-danger-50 text-danger-600' : 'bg-warn-50 text-gray-700'}`}>
          {out ? 'Out of stock — customers can’t buy it until you add stock.' : `Low stock — ${listing.availableQty} left (alert at ${listing.lowStockThreshold} or fewer).`}
        </p>
      )}

      <div className="flex gap-2" role="group" aria-label="Quick stock changes">
        {[-10, -1, 1, 10].map((delta) => (
          <button
            key={delta}
            type="button"
            className={quick}
            disabled={busy || (delta < 0 && listing.availableQty + delta < 0)}
            onClick={() => void apply(delta)}
          >
            {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
          </button>
        ))}
      </div>

      <div className="space-y-2 rounded-xl border border-gray-200 p-3">
        <p className="text-sm font-medium text-gray-800">Adjust by an amount</p>
        <div className="flex gap-2">
          <div className="inline-flex shrink-0 overflow-hidden rounded-xl border border-gray-200" role="radiogroup" aria-label="Add or remove">
            {([1, -1] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={direction === value}
                onClick={() => setDirection(value)}
                className={`min-h-11 px-4 text-sm font-semibold ${direction === value ? 'bg-brand-500 text-white' : 'bg-white text-gray-700'}`}
              >
                {value > 0 ? 'Add' : 'Remove'}
              </button>
            ))}
          </div>
          <input value={qty} onChange={(event) => setQty(event.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Qty" aria-label="Quantity" className={`${inputClass} min-w-0 flex-1`} />
        </div>
        <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Note (optional), e.g. new delivery" aria-label="Note" className={inputClass} />
        <Button onClick={() => void apply(direction * amount, note)} disabled={!validAmount || busy} className="w-full sm:w-auto">
          {busy ? 'Saving…' : validAmount ? `${direction > 0 ? 'Add' : 'Remove'} ${amount}` : 'Enter a quantity'}
        </Button>
        <p className="text-xs text-gray-500">
          Stock can never go below what is reserved for open orders ({listing.reservedQty}). Each change is recorded with who made it and when.
        </p>
      </div>
      <NoticeBar notice={notice} />

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-800">Recent stock changes</p>
        {movements.isPending ? (
          <Spinner label="Loading stock history…" />
        ) : movements.isError ? (
          <ErrorBanner message={sellerErrorMessage(movements.error)} />
        ) : movements.data.length === 0 ? (
          <p className="text-sm text-gray-500">No stock changes yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
            {movements.data.slice(0, 10).map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="text-gray-800">{MOVEMENT_LABEL[row.reason] ?? row.reason}</p>
                  <p className="truncate text-xs text-gray-500">
                    {dateTime.format(new Date(row.at))} · {row.by}
                    {row.note ? ` · ${row.note.replace(/^seller: /, '')}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={`font-semibold ${row.delta >= 0 ? 'text-brand-600' : 'text-gray-700'}`}>{row.delta > 0 ? `+${row.delta}` : row.delta}</p>
                  <p className="text-[11px] text-gray-400">
                    {row.availableBefore} → {row.balanceAfter} avail.
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Why the store is not taking orders now — the server's own closed reason, in words. */
function storeClosedReason(a: SellerAvailability): string {
  const next = a.nextOpenText ? ` ${a.nextOpenText}.` : '';
  switch (a.closedReason) {
    case 'MANUALLY_CLOSED':
      return 'You switched Accepting Orders OFF.';
    case 'OUTSIDE_HOURS':
      return `Store closed — outside your business hours.${next}`;
    case 'CLOSED_TODAY':
      return `Store closed today (weekly hours).${next}`;
    case 'CLOSURE':
      return `Store closed today (scheduled closure).${next}`;
    case 'SELLER_INACTIVE':
    case 'SELLER_DELETED':
      return 'Your store is paused by Aadione.';
    default:
      return 'Your store is not accepting orders right now.';
  }
}

/**
 * Full stock history of one listing (GET /seller/listings/:id/stock-movements):
 * when, what, available before → after, the note, and who. Table on wide
 * screens, stacked rows on phones.
 */
export function StockHistory({ listingId }: { listingId: string }) {
  const movements = useQuery({
    queryKey: [...sellerKeys.listings, listingId, 'movements'],
    queryFn: () => sellerApi.get<StockMovement[]>(`/seller/listings/${listingId}/stock-movements`),
  });
  if (movements.isPending) return <Spinner label="Loading stock history…" />;
  if (movements.isError) return <ErrorBanner message={sellerErrorMessage(movements.error)} />;
  if (movements.data.length === 0) return <p className="text-sm text-gray-500">No stock changes yet.</p>;
  const note = (row: StockMovement) => (row.note ? row.note.replace(/^seller: /, '') : null);
  return (
    <>
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 sm:hidden">
        {movements.data.map((row) => (
          <li key={row.id} className="px-3 py-2.5 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-gray-900">{MOVEMENT_LABEL[row.reason] ?? row.reason}</span>
              <span className={`font-semibold ${row.delta >= 0 ? 'text-brand-600' : 'text-gray-700'}`}>{row.delta > 0 ? `+${row.delta}` : row.delta}</span>
            </div>
            <p className="text-xs text-gray-500">
              {row.availableBefore} → {row.balanceAfter} available · {row.by} · {dateTime.format(new Date(row.at))}
            </p>
            {note(row) && <p className="text-xs text-gray-600">“{note(row)}”</p>}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-gray-200 sm:block">
        <table className="w-full text-sm">
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
            {movements.data.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap px-3 py-2 text-gray-600">{dateTime.format(new Date(row.at))}</td>
                <td className="px-3 py-2">
                  <span className="text-gray-900">{MOVEMENT_LABEL[row.reason] ?? row.reason}</span>
                  {note(row) && <span className="block text-xs text-gray-500">“{note(row)}”</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{row.availableBefore}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${row.delta >= 0 ? 'text-brand-600' : 'text-gray-700'}`}>
                  {row.delta > 0 ? `+${row.delta}` : row.delta}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-900">{row.balanceAfter}</td>
                <td className="px-3 py-2 text-gray-600">{row.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Quantities are what customers can buy (stock minus what is held for open orders). A sale moves stock and its hold together, so “available” does not change then.
      </p>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* visibility                                                                  */
/* -------------------------------------------------------------------------- */

export function VisibilityPanel({
  visibility,
  listing,
  product,
  adminDisabled,
  onChanged,
}: {
  visibility: ListingVisibility;
  listing: { id: string; isAvailable: boolean } | null;
  /** Own products only: the product-level show/hide switch. */
  product: { id: string; status: string } | null;
  adminDisabled: { reason: string | null; at: string } | null;
  onChanged: () => Promise<unknown>;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const look = VISIBILITY[visibility.reason];
  const disabledByAdmin = visibility.reason === 'DISABLED_BY_ADMIN' || (product?.status === 'ARCHIVED');
  // The product itself may be buyable while the STORE is not taking orders
  // right now — that reason comes from GET /seller/availability.
  const availability = useSellerAvailability().data;
  const storeBlock = visibility.sellable && availability && !availability.acceptingOrdersNow ? storeClosedReason(availability) : null;
  const buyable = visibility.sellable && storeBlock === null;
  const setProduct = useMutation({
    mutationFn: (status: 'ACTIVE' | 'INACTIVE') => sellerApi.patch(`/seller/products/${product!.id}/status`, { status }),
  });
  const setListing = useMutation({
    mutationFn: (isAvailable: boolean) => sellerApi.patch(`/seller/listings/${listing!.id}`, { isAvailable }),
  });

  async function change(action: () => Promise<unknown>, text: string): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      await action();
      await onChanged();
      setNotice({ ok: true, text });
    } catch (error) {
      setNotice({ ok: false, text: sellerErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className={`flex items-start gap-3 rounded-xl px-3.5 py-3 ${buyable ? 'bg-brand-50' : look.admin ? 'bg-danger-50' : 'bg-gray-50'}`}>
        <Icon name={buyable ? 'check' : look.admin ? 'lock' : 'alert'} className={`mt-0.5 h-5 w-5 shrink-0 ${buyable ? 'text-brand-600' : look.admin ? 'text-danger-600' : 'text-gray-500'}`} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-gray-900">{buyable ? 'Customers can buy this' : 'Customers cannot buy this'}</p>
            <VisibilityPill reason={visibility.reason} />
            {visibility.lowStock && <span className="text-xs font-semibold text-warn-500">Low stock</span>}
          </div>
          {storeBlock ? (
            <p className="mt-0.5 text-sm text-gray-600">
              <span className="font-medium text-gray-800">Reason: {storeBlock}</span> The product itself is ready to sell.
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-gray-600">
              {!buyable && <span className="font-medium text-gray-800">Reason: {look.label}. </span>}
              {look.help}
            </p>
          )}
          {adminDisabled?.reason && <p className="mt-1 text-sm text-danger-600">Aadione&apos;s note: {adminDisabled.reason}</p>}
        </div>
      </div>

      {product && (
        <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-gray-200 px-3.5 py-2">
          <span>
            <span className="block text-sm font-medium text-gray-800">Show product</span>
            <span className="block text-xs text-gray-500">{disabledByAdmin ? 'Locked — disabled by Aadione.' : 'Hide it without losing its listing or stock.'}</span>
          </span>
          <Toggle
            checked={product.status === 'ACTIVE'}
            disabled={disabledByAdmin || busy}
            label="Show product"
            onChange={(next) => void change(() => setProduct.mutateAsync(next ? 'ACTIVE' : 'INACTIVE'), next ? 'Product shown.' : 'Product hidden.')}
          />
        </label>
      )}
      {listing && (
        <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-gray-200 px-3.5 py-2">
          <span>
            <span className="block text-sm font-medium text-gray-800">On sale</span>
            <span className="block text-xs text-gray-500">{disabledByAdmin ? 'Locked — disabled by Aadione.' : 'Pause selling, e.g. while restocking.'}</span>
          </span>
          <Toggle
            checked={listing.isAvailable}
            disabled={(disabledByAdmin && !listing.isAvailable) || busy}
            label="On sale"
            onChange={(next) => void change(() => setListing.mutateAsync(next), next ? 'Back on sale.' : 'Taken off sale.')}
          />
        </label>
      )}
      <NoticeBar notice={notice} />
    </div>
  );
}
