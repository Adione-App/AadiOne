/**
 * Stock −/+ taps: instant on screen, batched on the wire.
 *
 *   - Every tap moves the figures on screen at once (optimistic). No control
 *     is ever disabled because an earlier change is still on its way.
 *   - Taps on one listing are added up while the seller keeps tapping
 *     (DEBOUNCE_MS after the last one) and sent as ONE relative change
 *     (POST /seller/listings/:id/stock-adjust { delta }) — five fast taps of
 *     +1 are one +5, not five requests. Taps that cancel out send nothing.
 *   - An amount typed with a note ("Add 25 · new delivery") is its own change,
 *     sent at once (its note goes on its own ledger row), in the order made.
 *   - One request per listing at a time, in order; changes made while it is on
 *     its way queue up behind it. So answers can never arrive out of order.
 *   - The server stays the authority: one guarded UPDATE applies the delta
 *     and refuses a change that would go below zero or below what is
 *     reserved. Its answer replaces the guess (plus any changes not sent
 *     yet). While changes are unconfirmed, figures fetched for any other
 *     reason (a page opening, a list re-read) never overwrite them
 *     (`holdFigures`) — a stale answer can never undo newer taps.
 *   - A refused or failed change takes back everything not confirmed — the
 *     figures return to the last confirmed ones — and the error is shown.
 *
 * Pure (no React): unit-tested in web/tests/sellerStock.test.ts; the hook is
 * useStockBatcher (sellerQueries.ts).
 */

import type { ListingVisibility, SellerListingInventory, SellerProductInventory } from './sellerApi';

export const DEBOUNCE_MS = 400;

export interface StockBatchOptions<T> {
  delayMs?: number;
  send: (listingId: string, delta: number, note?: string) => Promise<T>;
  /** The server's answer to a batch; `unsent` = changes made since it left (already on screen). */
  onConfirmed: (listingId: string, result: T, unsent: number) => void;
  /** A batch failed: `undo` = every change not confirmed (the batch + any made since) — take it back. */
  onFailed: (listingId: string, error: unknown, undo: number) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Batch {
  delta: number;
  /** Set for a typed amount with a note: never merged, sent at once. */
  note?: string;
}

interface Slot {
  /** Changes not sent yet, in the order made. Consecutive plain taps share one batch. */
  queue: Batch[];
  /** The batch on its way (0 when none). */
  sending: number;
  timer: unknown;
  inFlight: boolean;
}

const sum = (queue: Batch[]) => queue.reduce((total, batch) => total + batch.delta, 0);

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

  /**
   * One tap (or a typed amount): counted at once. A plain tap is sent after
   * the pause; one with a `note` is sent as soon as nothing is on its way.
   */
  add(listingId: string, delta: number, note?: string): void {
    if (!Number.isInteger(delta) || delta === 0) return;
    const slot = this.slots.get(listingId) ?? { queue: [], sending: 0, timer: null, inFlight: false };
    this.slots.set(listingId, slot);
    const tail = slot.queue.at(-1);
    if (note === undefined && tail && tail.note === undefined) tail.delta += delta;
    else slot.queue.push(note === undefined ? { delta } : { delta, note });
    if (slot.inFlight) return;
    if (note === undefined) this.arm(listingId, slot);
    else this.sendNow(listingId, slot);
  }

  /** Changes counted but not sent yet, plus a batch on its way — what the screen shows on top of the server's figures. */
  unconfirmed(listingId: string): number {
    const slot = this.slots.get(listingId);
    return slot ? sum(slot.queue) + slot.sending : 0;
  }

  isBusy(listingId: string): boolean {
    const slot = this.slots.get(listingId);
    return Boolean(slot && (slot.inFlight || slot.queue.some((batch) => batch.delta !== 0)));
  }

  /** Listings with changes not confirmed yet. */
  busyListings(): string[] {
    return [...this.slots.keys()].filter((listingId) => this.isBusy(listingId));
  }

  /** Sends every waiting batch now (leaving the page never drops taps). */
  flushAll(): void {
    for (const [listingId, slot] of this.slots) {
      if (!slot.inFlight) this.sendNow(listingId, slot);
    }
  }

  private arm(listingId: string, slot: Slot): void {
    if (slot.timer !== null) this.clearTimer(slot.timer);
    slot.timer = this.setTimer(() => {
      slot.timer = null;
      this.dispatch(listingId, slot);
    }, this.delayMs);
  }

  private sendNow(listingId: string, slot: Slot): void {
    if (slot.timer !== null) this.clearTimer(slot.timer);
    slot.timer = null;
    this.dispatch(listingId, slot);
  }

  /** After an answer: the next batch — at once if it carries a note, else after the pause. */
  private next(listingId: string, slot: Slot): void {
    while (slot.queue.length > 0 && slot.queue[0]!.delta === 0) slot.queue.shift();
    if (slot.queue.length === 0) {
      this.slots.delete(listingId);
      return;
    }
    if (slot.queue[0]!.note !== undefined) this.sendNow(listingId, slot);
    else this.arm(listingId, slot);
  }

  private dispatch(listingId: string, slot: Slot): void {
    while (slot.queue.length > 0 && slot.queue[0]!.delta === 0) slot.queue.shift();
    const batch = slot.queue.shift();
    if (!batch) {
      this.slots.delete(listingId);
      return;
    }
    slot.sending = batch.delta;
    slot.inFlight = true;
    this.options.send(listingId, batch.delta, batch.note).then(
      (result) => {
        slot.inFlight = false;
        slot.sending = 0;
        this.options.onConfirmed(listingId, result, sum(slot.queue));
        this.next(listingId, slot);
      },
      (error: unknown) => {
        slot.inFlight = false;
        slot.sending = 0;
        const undo = batch.delta + sum(slot.queue);
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

/** The stock figures on screen for a listing whose changes are not confirmed yet. */
export type HeldFigures = Pick<Figures, 'stockQty' | 'reservedQty' | 'availableQty'>;

/**
 * Data FETCHED for any reason (a page opening, a list re-read) while taps of
 * a listing are unconfirmed: keep the figures on screen for that listing, so
 * an answer read before (or while) the taps were applied can never undo them.
 * The confirmation of the taps then puts the server's figures in. Works on
 * every cached shape — listing rows / a listing page, product rows / a
 * product page (default and size listings); anything else is left alone.
 */
export function holdFigures(data: unknown, listingId: string, held: HeldFigures): unknown {
  const one = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    if ('variants' in item) return patchProduct(item as SellerProductInventory, listingId, (current) => ({ ...current, ...held }));
    const listing = item as SellerListingInventory;
    if (listing.id !== listingId || typeof listing.stockQty !== 'number') return item;
    return {
      ...listing,
      ...held,
      ...(listing.visibility ? { visibility: { ...listing.visibility, availableQty: held.availableQty } } : {}),
    };
  };
  return Array.isArray(data) ? data.map(one) : one(data);
}

/** The figures of a listing in one cached value (see holdFigures for the shapes), or null. */
export function figuresIn(data: unknown, listingId: string): HeldFigures | null {
  const items: unknown[] = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if ('variants' in item) {
      const product = item as SellerProductInventory;
      const hit =
        product.listing?.id === listingId ? product.listing : product.variants?.find((variant) => variant.listing?.id === listingId)?.listing;
      if (hit) return { stockQty: hit.stockQty, reservedQty: hit.reservedQty, availableQty: hit.availableQty };
      continue;
    }
    const listing = item as SellerListingInventory;
    if (listing.id === listingId && typeof listing.stockQty === 'number') {
      return { stockQty: listing.stockQty, reservedQty: listing.reservedQty, availableQty: listing.availableQty };
    }
  }
  return null;
}
