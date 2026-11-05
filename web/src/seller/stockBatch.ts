/**
 * Stock −/+ taps: instant on screen, batched on the wire.
 *
 *   - Every tap moves the figures on screen at once (optimistic).
 *   - Taps on one listing are added up while the seller keeps tapping
 *     (DEBOUNCE_MS after the last one) and sent as ONE relative change
 *     (POST /seller/listings/:id/stock-adjust { delta }) — five fast taps of
 *     +1 are one +5, not five requests. Taps that cancel out send nothing.
 *   - One request per listing at a time; taps made while it is on its way are
 *     the next batch.
 *   - The server stays the authority: it row-locks the listing, applies the
 *     delta and refuses a change that would go below zero or below what is
 *     reserved. Its answer replaces the guess (plus any taps not sent yet).
 *   - A refused or failed batch takes back everything not confirmed — the
 *     figures return to the last confirmed ones — and the error is shown.
 *
 * Pure (no React): unit-tested in web/tests/sellerStock.test.ts; the hook is
 * useStockBatcher (sellerQueries.ts).
 */

import type { ListingVisibility, SellerListingInventory, SellerProductInventory } from './sellerApi';

export const DEBOUNCE_MS = 400;

export interface StockBatchOptions<T> {
  delayMs?: number;
  send: (listingId: string, delta: number) => Promise<T>;
  /** The server's answer to a batch; `unsent` = taps made since it left (already on screen). */
  onConfirmed: (listingId: string, result: T, unsent: number) => void;
  /** A batch failed: `undo` = every tap not confirmed (the batch + any made since) — take it back. */
  onFailed: (listingId: string, error: unknown, undo: number) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Slot {
  pending: number;
  /** The batch on its way (0 when none). */
  sending: number;
  timer: unknown;
  inFlight: boolean;
}

export class StockBatcher<T> {
  private readonly slots = new Map<string, Slot>();
  private readonly delayMs: number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: StockBatchOptions<T>) {
    this.delayMs = options.delayMs ?? DEBOUNCE_MS;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** One tap (or a typed amount): counted at once, sent after the pause. */
  add(listingId: string, delta: number): void {
    if (!Number.isInteger(delta) || delta === 0) return;
    const slot = this.slots.get(listingId) ?? { pending: 0, sending: 0, timer: null, inFlight: false };
    this.slots.set(listingId, slot);
    slot.pending += delta;
    if (!slot.inFlight) this.arm(listingId, slot);
  }

  /** Taps counted but not sent yet, plus a batch on its way — what the screen shows on top of the server's figures. */
  unconfirmed(listingId: string): number {
    const slot = this.slots.get(listingId);
    return slot ? slot.pending + slot.sending : 0;
  }

  isBusy(listingId: string): boolean {
    const slot = this.slots.get(listingId);
    return Boolean(slot && (slot.inFlight || slot.pending !== 0));
  }

  /** Sends every waiting batch now (leaving the page never drops taps). */
  flushAll(): void {
    for (const [listingId, slot] of this.slots) {
      if (slot.timer !== null) this.clearTimer(slot.timer);
      slot.timer = null;
      if (!slot.inFlight) this.dispatch(listingId, slot);
    }
  }

  private arm(listingId: string, slot: Slot): void {
    if (slot.timer !== null) this.clearTimer(slot.timer);
    slot.timer = this.setTimer(() => {
      slot.timer = null;
      this.dispatch(listingId, slot);
    }, this.delayMs);
  }

  private dispatch(listingId: string, slot: Slot): void {
    const delta = slot.pending;
    if (delta === 0) {
      this.slots.delete(listingId);
      return;
    }
    slot.pending = 0;
    slot.sending = delta;
    slot.inFlight = true;
    this.options.send(listingId, delta).then(
      (result) => {
        slot.inFlight = false;
        slot.sending = 0;
        this.options.onConfirmed(listingId, result, slot.pending);
        if (slot.pending !== 0) this.arm(listingId, slot);
        else this.slots.delete(listingId);
      },
      (error: unknown) => {
        slot.inFlight = false;
        slot.sending = 0;
        const undo = delta + slot.pending;
        if (slot.timer !== null) this.clearTimer(slot.timer);
        this.slots.delete(listingId);
        this.options.onFailed(listingId, error, undo);
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Cache patching — the same listing appears in several cached screens         */
/* -------------------------------------------------------------------------- */

interface Figures {
  id: string;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
}

/** A listing's figures moved by `delta` units of stock (reserved never changes here). */
export function shiftFigures<F extends Figures & { visibility?: ListingVisibility }>(figures: F, delta: number): F {
  if (delta === 0) return figures;
  const availableQty = figures.availableQty + delta;
  return {
    ...figures,
    stockQty: figures.stockQty + delta,
    availableQty,
    ...(figures.visibility ? { visibility: { ...figures.visibility, availableQty } } : {}),
  };
}

/** The listing the server returned, with taps not confirmed yet on top. */
export function withUnsent(listing: SellerListingInventory, unsent: number): SellerListingInventory {
  return shiftFigures(listing, unsent);
}

type ProductListing = NonNullable<SellerProductInventory['listing']>;

/** The fields a product's own listing copy takes from a full listing. */
function listingFields(listing: SellerListingInventory) {
  return {
    stockQty: listing.stockQty,
    reservedQty: listing.reservedQty,
    availableQty: listing.availableQty,
    isAvailable: listing.isAvailable,
    pricePaise: listing.pricePaise,
    mrpPaise: listing.mrpPaise,
    updatedAt: listing.updatedAt,
  };
}

/**
 * A product (list row or detail) with one of its listings updated — the
 * default `listing` and the matching `variants[].listing` alike. `next` gets
 * the cached copy and returns the new one. Same object when it is not there.
 */
export function patchProduct(
  product: SellerProductInventory,
  listingId: string,
  next: (current: ProductListing) => ProductListing,
  visibility?: ListingVisibility,
): SellerProductInventory {
  const ownHit = product.listing?.id === listingId;
  const variants = product.variants ?? [];
  const variantHit = variants.some((variant) => variant.listing?.id === listingId);
  if (!ownHit && !variantHit) return product;
  return {
    ...product,
    listing: ownHit && product.listing ? next(product.listing) : product.listing,
    // The product's own visibility follows its default listing only.
    visibility: ownHit && visibility ? visibility : product.visibility,
    variants: variantHit
      ? variants.map((variant) =>
          variant.listing?.id === listingId
            ? { ...variant, listing: next(variant.listing), ...(visibility ? { visibility } : {}) }
            : variant,
        )
      : variants,
  };
}

/** A tap on screen: every cached copy of the listing moves by `delta`. */
export function shiftProduct(product: SellerProductInventory, listingId: string, delta: number): SellerProductInventory {
  return patchProduct(product, listingId, (current) => shiftFigures(current, delta));
}

/** The server's figures (with unsent taps on top) into every cached copy of the listing. */
export function confirmProduct(product: SellerProductInventory, listing: SellerListingInventory): SellerProductInventory {
  return patchProduct(product, listing.id, (current) => ({ ...current, ...listingFields(listing) }), listing.visibility);
}
