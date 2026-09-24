/**
 * Cart actions shared by every screen that shows a product.
 *
 * ARCHITECTURE (see queries.ts's `write()` for the other half of this fix):
 *
 * 0. TRULY SHARED OPTIMISTIC STATE — `usePendingCartStore` (a small Zustand
 *    store, module-scoped so there is exactly ONE instance for the whole
 *    app) holds the pending-quantity overlay and the in-flight/busy set.
 *    This is NOT a local ref/state inside the hook — it used to be, and
 *    that was a real bug: `useCartActions()` is called independently by
 *    every screen AND by the tab bar (`MainTabs.tsx`, for the cart badge).
 *    Each call used to get its OWN local pending state, so a tap on a
 *    product card in Home updated Home's own hook instance instantly, but
 *    the badge — a DIFFERENT hook instance living in a different component
 *    tree — had no way to know a tap happened anywhere except by waiting
 *    for the mutation's network response to update the shared React Query
 *    cache. That round trip was the entire 2–3 second delay: the card
 *    looked instant, the badge did not, because only the badge's copy of
 *    "what's pending" was still waiting on the network. Routing pending
 *    qty/busy through one shared store makes a tap ANYWHERE update EVERY
 *    subscriber (badge, every open screen) in the same tick, not just the
 *    screen the tap happened on.
 *
 * 1. OPTIMISTIC QTY — the store's `pendingQty` map is the qty a variant
 *    shows *right now*, ahead of the server confirming it. Reads inside
 *    imperative code (`dispatch`, `add`/`increment`/`decrement`) always go
 *    through `usePendingCartStore.getState()` rather than a value captured
 *    at the last render, so a fast second tap computes off the value the
 *    first tap just set rather than a stale one. Every component using
 *    this hook ALSO subscribes to the store reactively, which is what
 *    makes React re-render it the instant any tap — anywhere — changes the
 *    shared state.
 *
 * 2. ONE REQUEST IN FLIGHT PER VARIANT, SENT IMMEDIATELY, NO DEBOUNCE — every
 *    tap dispatches straight away; there is no artificial delay. If a
 *    request for a variant is already in flight (checked against the
 *    SHARED busy set, so this is true regardless of which screen started
 *    it), a new tap only updates the optimistic qty and returns —
 *    `dispatch`'s own `finally` notices the target moved and immediately
 *    re-dispatches once the current request settles. This isn't for
 *    smoothness (the UI is already instant); it's required for
 *    correctness: `POST /cart/items` is ADDITIVE server-side (qty sent is
 *    added to whatever's already there), so two concurrent "create the
 *    line" requests for the same variant would double-count. Serializing
 *    keeps exactly one request in flight, which both prevents that and
 *    means a stale response can never land after a newer one — there's
 *    only ever one response to receive at a time.
 *
 * 3. KNOWING WHETHER A LINE ALREADY EXISTS — a fresh dispatch (a real tap)
 *    reads this from `linesRef.current`, i.e. the live `cart` query data,
 *    never from a value cached on a previous tap. That data is shared across
 *    every screen (see queries.ts's `write()`), so it's correct regardless
 *    of which screen last touched the cart. A CHAINED re-dispatch (point 2,
 *    same synchronous continuation as the response it's reacting to) is the
 *    one place a fresh read would still be one render behind, so that case
 *    alone passes the just-confirmed line through as an explicit argument
 *    instead.
 *
 * 4. CLEAR ALL vs PER-ITEM TAPS — a module-level (so, again, genuinely
 *    shared) `clearInFlightPromise` holds the in-progress clear's promise.
 *    A per-item dispatch that starts while a clear is running awaits it
 *    first, then re-reads pending/known state fresh. This is what stops
 *    "Delete B, then Clear All, then Add A" from racing — including across
 *    different screens — the Add's actual request can never be answered by
 *    a clear response that was computed before the add happened.
 *
 * 5. STABLE FUNCTION IDENTITIES — every function this hook returns is
 *    `useCallback`'d with an empty dependency array and reads all changing
 *    values (cart lines, distanceKm, the mutation objects) through refs kept
 *    current on every render. That makes `cart.add`/`cart.increment`/etc.
 *    referentially stable across renders, which is what lets a screen wrap
 *    its own per-item handlers in `useCallback` too and actually get
 *    `React.memo` to skip re-rendering an unrelated ProductCard when a
 *    different product's quantity changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CartDto, CartItemDto, ProductSummaryDto, VariantDto } from "@shared";
import { ApiRequestError, resolveImageUrl } from "./api";
import { flyFromCart } from "./flyToCart";
import { useCart, useCartMutations } from "./queries";
import { useLocation } from "@/lib/store";

type KnownLine = { id: string; qty: number } | null;

/**
 * Enough product/variant display data to render a cart LINE for a variant
 * that has never been added before — i.e. the exact moment "Add" is tapped,
 * before the server has confirmed a line exists at all. Without this, the
 * FIRST add of a product had nothing to show in `optimisticCart.items`
 * (there was no existing `cart.items` entry to apply the pending qty to),
 * so the tapped card itself updated instantly (it reads `qtyFor` directly)
 * but the cart badge / Cart screen — which read the full item list — stayed
 * at their old numbers until the network round trip landed. Passed in by
 * whichever screen has the product data at hand (ProductCard builds it from
 * its own `product`/`variant` props; see `snapshotFromProduct` below).
 */
export interface CartItemSnapshot {
  productId: string;
  productName: string;
  variantName: string;
  brandName: string | null;
  imageUrl: string | null;
  mrpPaise: number;
  unitPricePaise: number;
  inStock: boolean;
  availableQty: number;
  maxQtyPerOrder: number;
  allowCod: boolean;
}

export function snapshotFromProduct(
  product: Pick<ProductSummaryDto, "id" | "name" | "brandName" | "thumbUrl">,
  variant: VariantDto,
): CartItemSnapshot {
  return {
    productId: product.id,
    productName: product.name,
    variantName: variant.variantName,
    brandName: product.brandName,
    imageUrl: variant.imageUrl ?? product.thumbUrl,
    mrpPaise: variant.mrpPaise,
    unitPricePaise: variant.pricePaise,
    inStock: variant.inStock,
    availableQty: variant.availableQty,
    maxQtyPerOrder: variant.maxQtyPerOrder,
    allowCod: variant.allowCod,
  };
}

/* -------------------------------------------------------------------------- */
/* CART HYDRATION — restoring the last known (server-confirmed) cart from    */
/* disk at app startup, so Product Cards and the Mini Cart don't have to sit */
/* on their empty defaults for the 2-3s the first `/cart` request takes.     */
/*                                                                            */
/* This is DELIBERATELY separate from the React Query disk cache (see        */
/* App.tsx's `shouldDehydrateQuery`, which explicitly EXCLUDES "cart" — a     */
/* stale/cancelled cart snapshot previously reappeared as if it were still   */
/* live). That persister would have re-served the cached RESULT indefinitely */
/* under its own normal cache/staleness rules; this instead only ever seeds  */
/* the very FIRST paint and is discarded the instant real `/cart` data has   */
/* been observed this session — every read after that is genuine server      */
/* truth, exactly as before this existed.                                    */
/* -------------------------------------------------------------------------- */

const CART_HYDRATION_STORAGE_KEY = "adione.cart-hydration.v1";

interface HydratedCartItem {
  variantId: string;
  qty: number;
  snapshot: CartItemSnapshot;
}

/**
 * variantId -> qty, for `qtyForImpl`'s fallback below. Empty until
 * `hydrateCartFromDisk()` (awaited in App.tsx's startup effect, alongside
 * auth/location restore — BEFORE any cart-dependent screen ever mounts)
 * finds something to restore.
 */
let hydratedQtyByVariant = new Map<string, number>();

/**
 * A full `CartDto`-shaped stand-in for `cart` (see `optimisticCart` below),
 * built once from whatever was restored. Business-rule fields nothing
 * before checkout depends on (`checkoutEnabled`, delivery/platform fees,
 * coupon, …) get safe placeholders — Product Cards and the Mini Cart only
 * ever need `items`/`bill.itemCount`, and by the time anyone could
 * plausibly reach an actual checkout screen, the real `/cart` response
 * (fired immediately once any screen mounts) has long since replaced this.
 */
let hydratedFallbackCart: CartDto | null = null;

/**
 * Called once at app startup (see App.tsx) alongside the other local-only
 * restores it already runs in parallel — a single, cheap AsyncStorage read,
 * same cost class as the location/wishlist/recent-searches hydration next
 * to it.
 */
export async function hydrateCartFromDisk(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CART_HYDRATION_STORAGE_KEY);
    if (!raw) return;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;

    const entries = parsed as HydratedCartItem[];

    hydratedQtyByVariant = new Map(
      entries.map((entry) => [entry.variantId, entry.qty]),
    );

    const items: CartItemDto[] = entries.map((entry) => ({
      id: `hydrated-${entry.variantId}`,
      variantId: entry.variantId,
      qty: entry.qty,
      lineTotalPaise: entry.snapshot.unitPricePaise * entry.qty,
      lineDiscountPaise: Math.max(
        0,
        (entry.snapshot.mrpPaise - entry.snapshot.unitPricePaise) * entry.qty,
      ),
      ...entry.snapshot,
    }));

    const itemsSubtotalPaise = items.reduce(
      (sum, item) => sum + item.lineTotalPaise,
      0,
    );
    const itemDiscountPaise = items.reduce(
      (sum, item) => sum + item.lineDiscountPaise,
      0,
    );
    const itemCount = items.reduce((sum, item) => sum + item.qty, 0);

    hydratedFallbackCart = {
      id: "hydrated",
      items,
      bill: {
        itemCount,
        itemsSubtotalPaise,
        itemDiscountPaise,
        couponCode: null,
        couponDiscountPaise: 0,
        deliveryFeePaise: 0,
        deliveryFeeWaivedReason: null,
        platformFeePaise: 0,
        taxPaise: 0,
        totalPaise: itemsSubtotalPaise,
        totalSavingsPaise: itemDiscountPaise,
      },
      changes: [],
      checkoutEnabled: false,
      checkoutBlockedReason: "Loading your cart…",
      minOrderValuePaise: 0,
      shortfallPaise: 0,
    };
  } catch {
    // Corrupt/unreadable snapshot — proceed with nothing restored, same as
    // a first-ever launch.
  }
}

/**
 * Persists the CURRENT real (server-confirmed) cart's items so the next
 * cold start can restore them instantly — see the effect in
 * `useCartActions` that calls this whenever `cart` changes. Built from the
 * real `cart.items`, never from `pendingQty`/optimistic state, so a request
 * that never actually confirmed can't get persisted as if it had.
 */
let lastPersistedCartJson: string | null = null;

function persistCartSnapshot(items: CartItemDto[]): void {
  const entries: HydratedCartItem[] = items.map((item) => ({
    variantId: item.variantId,
    qty: item.qty,
    snapshot: {
      productId: item.productId,
      productName: item.productName,
      variantName: item.variantName,
      brandName: item.brandName,
      imageUrl: item.imageUrl,
      mrpPaise: item.mrpPaise,
      unitPricePaise: item.unitPricePaise,
      inStock: item.inStock,
      availableQty: item.availableQty,
      maxQtyPerOrder: item.maxQtyPerOrder,
      allowCod: item.allowCod,
    },
  }));

  const json = JSON.stringify(entries);
  // `useCartActions()` is called from several places at once (the tab
  // badge, every screen) — every mounted instance's own effect reacts to
  // the SAME `cart` change, so this guard is what keeps that from writing
  // the same snapshot to disk redundantly once per instance.
  if (json === lastPersistedCartJson) return;
  lastPersistedCartJson = json;

  AsyncStorage.setItem(CART_HYDRATION_STORAGE_KEY, json).catch(() => {
    // Best-effort — a failed write just means the NEXT cold start falls
    // back to the normal network-loading behavior, not a functional bug.
  });
}

/* -------------------------------------------------------------------------- */
/* SHARED pending-cart store — see file header, point 0.                     */
/* -------------------------------------------------------------------------- */

interface PendingCartState {
  /** variantId -> the qty it should show right now, ahead of the server. */
  pendingQty: Record<string, number>;
  /** variantId -> true while a request for it is in flight. */
  busyVariants: Record<string, boolean>;
  /**
   * variantId -> display data for a variant added while it has no confirmed
   * server line yet, so `optimisticCart` can synthesize a full line for it
   * instead of only knowing its bare quantity. Never cleared: harmless to
   * keep (bounded by distinct variants touched this session, a few hundred
   * bytes each) and simpler than reasoning about exactly when it's safe to
   * drop — once a real line exists in `cart.items`, the snapshot is just
   * unused, not wrong.
   */
  pendingSnapshots: Record<string, CartItemSnapshot>;
  setPending: (variantId: string, qty: number) => void;
  clearPending: (variantId: string) => void;
  setBusy: (variantId: string, busy: boolean) => void;
  setSnapshot: (variantId: string, snapshot: CartItemSnapshot) => void;
}

const usePendingCartStore = create<PendingCartState>((set) => ({
  pendingQty: {},
  busyVariants: {},
  pendingSnapshots: {},

  setPending: (variantId, qty) =>
    set((state) => ({ pendingQty: { ...state.pendingQty, [variantId]: qty } })),

  setSnapshot: (variantId, snapshot) =>
    set((state) => ({
      pendingSnapshots: { ...state.pendingSnapshots, [variantId]: snapshot },
    })),

  clearPending: (variantId) =>
    set((state) => {
      if (!(variantId in state.pendingQty)) return state;
      const next = { ...state.pendingQty };
      delete next[variantId];
      return { pendingQty: next };
    }),

  setBusy: (variantId, busy) =>
    set((state) => {
      if (busy) {
        if (state.busyVariants[variantId]) return state;
        return { busyVariants: { ...state.busyVariants, [variantId]: true } };
      }
      if (!(variantId in state.busyVariants)) return state;
      const next = { ...state.busyVariants };
      delete next[variantId];
      return { busyVariants: next };
    }),
}));

/**
 * Serializes Clear Cart against every screen's dispatches, not just calls
 * made through the same hook instance — module scope, so there is exactly
 * one of these for the whole app, same reasoning as the store above.
 */
let clearInFlightPromise: Promise<void> | null = null;

export function useCartActions() {
  // IMPORTANT: pass the current serviceability distance
  // so cart pricing includes the correct delivery fee.
  const serviceability = useLocation(
    (state) => state.serviceability,
  );

  const distanceKm = serviceability?.distanceKm ?? null;

  const {
    data: cart,
    isLoading: cartIsLoading,
    isError: cartIsError,
    refetch: refetchCart,
  } = useCart(distanceKm);

  const mutations = useCartMutations();

  const [error, setError] = useState<string | null>(null);

  // Reactive subscriptions: purely so THIS component re-renders the instant
  // ANY component's tap changes the shared store — including one that
  // happened in a totally different screen. `pendingQty`/`busyVariants` are
  // replaced (not mutated) on every store update, so reference-equality
  // (Zustand's default) reliably detects every change.
  const pendingQty = usePendingCartStore((state) => state.pendingQty);
  const busyVariants = usePendingCartStore((state) => state.busyVariants);

  const linesByVariant = useMemo(() => {
    const map = new Map<string, CartDto["items"][number]>();

    for (const item of cart?.items ?? []) {
      map.set(item.variantId, item);
    }

    return map;
  }, [cart]);

  // Read by dispatch()/clear() without needing any of these in their own
  // dependency lists — see file header, point 5.
  // Real refs — a STABLE object mutated in place every render, not a new
  // object each time (a `useMemo`-built `{ current }` would be a fresh
  // object on every change, which is NOT the same thing: `add`/`increment`/
  // etc. below are `useCallback`'d with an empty dep array, so the `dispatch`
  // closure they capture is fixed at mount forever — it only stays correct
  // because it dereferences `.current` on a ref object whose IDENTITY never
  // changes, only its contents. A `useMemo` swap-the-object approach would
  // leave that mount-time closure reading data frozen from the first render.
  const linesRef = useRef(linesByVariant);
  linesRef.current = linesByVariant;
  const distanceKmRef = useRef(distanceKm);
  distanceKmRef.current = distanceKm;
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const mutationsRef = useRef(mutations);
  mutationsRef.current = mutations;

  // Keeps the on-disk hydration snapshot (see hydrateCartFromDisk above)
  // up to date with the real, server-confirmed cart, so the NEXT cold
  // start restores from here rather than an older session. Deliberately
  // keyed on `cart` (the real data), never `optimisticCart` — see
  // `persistCartSnapshot`'s own comment for why an unconfirmed, still-in-
  // flight change must never be what gets written to disk.
  useEffect(() => {
    if (!cart) return;
    persistCartSnapshot(cart.items);
  }, [cart]);

  // Drops a variant's optimistic `pendingQty` override the INSTANT the
  // real, server-confirmed `cart` (this same render's fresh React Query
  // data, not a callback-timing guess) already shows that exact quantity —
  // see `dispatch`'s own `finally` block for why it no longer clears this
  // itself right after its mutation resolves. Runs on every `cart` change
  // (not just after a mutation this hook instance started — a different
  // screen's tap, or the badge, needs the exact same reconciliation), and
  // is a no-op for every variant already reconciled (`clearPending` bails
  // out immediately if there's nothing pending for it).
  useEffect(() => {
    if (!cart) return;

    const pending = usePendingCartStore.getState().pendingQty;
    for (const variantId of Object.keys(pending)) {
      const knownQty =
        cart.items.find((item) => item.variantId === variantId)?.qty ?? 0;
      if (knownQty === pending[variantId]) {
        clearPending(variantId);
      }
    }
  }, [cart]);

  // Always the absolute-latest value, whether called during render or from
  // an event handler / async continuation — see file header, point 1.
  const qtyForImpl = (variantId: string): number => {
    const pending = usePendingCartStore.getState().pendingQty;
    if (variantId in pending) return pending[variantId]!;

    const known = linesRef.current.get(variantId)?.qty;
    if (known !== undefined) return known;

    // The real `/cart` response hasn't landed yet THIS SESSION
    // (`cartRef.current` — see file header, point 5, for why this reads a
    // ref rather than `cart` directly) — fall back to whatever was
    // restored from disk at startup (see hydrateCartFromDisk above), so a
    // returning customer's Product Cards show their actual last quantity
    // immediately instead of "Add". The instant `cartRef.current` is
    // defined, this branch is never reached again for the rest of the
    // session — every read after that reflects genuine server truth
    // exactly as it always has.
    if (cartRef.current === undefined) {
      const hydratedQty = hydratedQtyByVariant.get(variantId);
      if (hydratedQty !== undefined) return hydratedQty;
    }

    return 0;
  };

  const setPending = (variantId: string, qty: number): void => {
    usePendingCartStore.getState().setPending(variantId, qty);
  };

  const clearPending = (variantId: string): void => {
    usePendingCartStore.getState().clearPending(variantId);
  };

  const isBusyImpl = (variantId: string): boolean =>
    Boolean(usePendingCartStore.getState().busyVariants[variantId]);

  /**
   * The cart, repriced against whatever quantities are CURRENTLY pending —
   * i.e. what the customer's last tap asked for, not what the server has
   * confirmed yet. This is the single source every screen (cart badge, Cart
   * screen bill, sticky "N items" bars) reads instead of the raw server
   * `cart`, so a quantity change is reflected everywhere in the same render
   * instead of only once the mutation's response lands.
   *
   * Only per-unit arithmetic is redone here — each line's own
   * `unitPricePaise`/`mrpPaise` is already server-priced and fixed
   * regardless of qty, so `unitPricePaise × qty` is exact, not a guess.
   * `deliveryFeePaise` / `platformFeePaise` / `couponDiscountPaise` are left
   * exactly as the server last reported: they're policy (e.g. a
   * free-delivery threshold, a coupon's own rules), not something this hook
   * has the rules to recompute, and duplicating that logic client-side is
   * exactly the kind of drift-prone "trust the client's math" bug this
   * codebase deliberately avoids elsewhere. They catch up on the next real
   * cart response, same as a brand-new line for a product not yet in
   * `cart.items` (which has nothing local to reprice until the server
   * confirms it).
   */
  const optimisticCart = useMemo<CartDto | undefined>(() => {
    // Prefer the real server cart the instant it exists. Until then — and
    // ONLY until then, for the rest of this session — fall back to
    // whatever was restored from disk at startup (see
    // hydrateCartFromDisk/hydratedFallbackCart above), so the Mini Cart and
    // any other consumer of the full cart shape don't have to sit on
    // "empty" while the first `/cart` request is still in flight. The
    // moment `cart` is defined, `baseCart` is `cart` from then on, forever
    // — this never reintroduces stale data once real data exists.
    const baseCart = cart ?? hydratedFallbackCart;
    if (!baseCart) return cart;

    let itemsSubtotalPaise = 0;
    let itemDiscountPaise = 0;
    let itemCount = 0;

    const items = baseCart.items
      .map((item) => {
        const qty =
          item.variantId in pendingQty ? pendingQty[item.variantId]! : item.qty;
        if (qty <= 0) return null;

        const lineTotalPaise = item.unitPricePaise * qty;
        const lineDiscountPaise = Math.max(
          0,
          (item.mrpPaise - item.unitPricePaise) * qty,
        );

        itemsSubtotalPaise += lineTotalPaise;
        itemDiscountPaise += lineDiscountPaise;
        itemCount += qty;

        return { ...item, qty, lineTotalPaise, lineDiscountPaise };
      })
      .filter((item): item is CartDto["items"][number] => item !== null);

    // A variant pending its FIRST-EVER add has no entry in `cart.items` yet
    // (the server hasn't created the line), so the loop above never sees it
    // — this is what left the badge/Cart screen showing the old count until
    // the network response landed, even though the tapped card itself (which
    // reads `qtyFor` directly) looked instant. Synthesize a line from the
    // snapshot the tapping screen supplied, so it shows up everywhere in the
    // same tick as the tap.
    const knownVariantIds = new Set(items.map((item) => item.variantId));
    const snapshots = usePendingCartStore.getState().pendingSnapshots;

    for (const [variantId, qty] of Object.entries(pendingQty)) {
      if (qty <= 0 || knownVariantIds.has(variantId)) continue;
      const snapshot = snapshots[variantId];
      if (!snapshot) continue;

      const lineTotalPaise = snapshot.unitPricePaise * qty;
      const lineDiscountPaise = Math.max(
        0,
        (snapshot.mrpPaise - snapshot.unitPricePaise) * qty,
      );

      itemsSubtotalPaise += lineTotalPaise;
      itemDiscountPaise += lineDiscountPaise;
      itemCount += qty;

      items.push({
        id: `pending-${variantId}`,
        variantId,
        qty,
        lineTotalPaise,
        lineDiscountPaise,
        ...snapshot,
      });
    }

    const netItemsPaise = itemsSubtotalPaise - baseCart.bill.couponDiscountPaise;
    const totalPaise =
      netItemsPaise + baseCart.bill.deliveryFeePaise + baseCart.bill.platformFeePaise;

    return {
      ...baseCart,
      items,
      bill: {
        ...baseCart.bill,
        itemCount,
        itemsSubtotalPaise,
        itemDiscountPaise,
        totalSavingsPaise: itemDiscountPaise + baseCart.bill.couponDiscountPaise,
        totalPaise,
      },
    };
    // `pendingQty` is a new object reference on every store update (see the
    // store above), so this recomputes exactly when it should.
  }, [cart, pendingQty]);

  // Derived from the SHARED busy set (also true while Clear Cart is
  // running — `clear()` marks every affected variant busy) rather than this
  // particular hook instance's own `useMutation` `.isPending` flags, which
  // would have the same cross-screen blind spot `pendingQty` used to have:
  // a mutation fired by a DIFFERENT screen's hook instance wouldn't flip
  // THIS instance's `.isPending` at all.
  const busy = Object.keys(busyVariants).length > 0;

  /**
   * Sends whatever qty is CURRENTLY pending for one variant. Safe to call
   * any number of times — it no-ops if a request for this variant is
   * already running or if there is nothing pending.
   */
  const dispatch = async (variantId: string, chainedKnown?: KnownLine): Promise<void> => {
    // A Clear All is in progress — its response must land and be applied
    // before this variant's own request is allowed to go out, or a clear
    // response computed before this tap could later overwrite it.
    if (clearInFlightPromise) await clearInFlightPromise;

    const store = usePendingCartStore.getState();
    if (store.busyVariants[variantId]) return;
    const targetQty = store.pendingQty[variantId];
    if (targetQty === undefined) return;

    // `chainedKnown` is only passed by the same-tick re-dispatch below, right
    // after applying its own response — for every other (i.e. real, fresh)
    // call this always reads the live, shared cart data. See file header.
    const known: KnownLine =
      chainedKnown !== undefined ? chainedKnown : (linesRef.current.get(variantId) ?? null);

    if (targetQty <= 0 && !known) {
      // Already empty server-side — nothing to sync for a decrement-to-zero
      // that resolved before any line was ever created.
      if (usePendingCartStore.getState().pendingQty[variantId] === targetQty) {
        clearPending(variantId);
      }
      return;
    }

    setError(null);
    usePendingCartStore.getState().setBusy(variantId, true);

    const { addItem: add_, updateQty: update_ } = mutationsRef.current;
    // Set on success to the line this response just confirmed (or null), so
    // a same-tick chained re-dispatch (below) hands it straight through
    // instead of reading `cart` data that won't catch up until next render.
    // Left undefined on failure — a failed request confirmed nothing, so a
    // chained re-dispatch after one reads fresh from `cart` instead.
    let confirmedKnown: KnownLine | undefined;

    try {
      const response = known
        ? // Absolute-set — and the server deletes the row itself when
          // qty <= 0, so zero and a normal decrement take the same path.
          await update_.mutateAsync({
            cartItemId: known.id,
            qty: Math.max(0, targetQty),
            distanceKm: distanceKmRef.current,
          })
        : // Additive server-side. Safe ONLY because the shared busy set
          // guarantees this is the sole in-flight request for this
          // variant — across every screen, not just this one — so "0 +
          // targetQty" is exactly the qty the user asked for.
          await add_.mutateAsync({
            variantId,
            qty: targetQty,
            distanceKm: distanceKmRef.current,
          });

      const line = response.items.find((item) => item.variantId === variantId);
      confirmedKnown = line ? { id: line.id, qty: line.qty } : null;
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not update your cart.",
      );
    } finally {
      usePendingCartStore.getState().setBusy(variantId, false);

      if (usePendingCartStore.getState().pendingQty[variantId] === targetQty) {
        // Nothing changed while this was in flight — the response we just
        // applied IS the current truth. Don't clear the optimistic cover
        // HERE, though: the query cache write this same response triggers
        // (`onSuccess` -> `guardedWrite` in queries.ts) is scheduled
        // independently of this synchronous `finally` block, and isn't
        // guaranteed to have already re-rendered `cart` by this exact
        // point. Clearing right away risked `optimisticCart` (below)
        // falling back to reading `cart.items`' still-stale qty for one
        // frame before the fresh cache data actually landed — a visible
        // regress-then-correct blink on every tap. The reconciliation
        // effect below drops this override instead, the INSTANT `cart`
        // itself (not a guess about callback timing) actually reflects it
        // — never a frame too early. See that effect's own comment.
      } else {
        // A newer tap landed while this request was in flight. Do NOT let
        // the response we just got settle the UI — it's already stale.
        // Continue straight to the latest target; no delay.
        void dispatch(variantId, confirmedKnown);
      }
    }
  };

  // NOTE on "a tap must not be silently dropped when a screen unmounts":
  // the previous, per-component version of this hook had an unmount effect
  // that manually re-fired any pending-but-not-yet-dispatched request,
  // because its pending state was a ref local to that one component — once
  // it unmounted, nothing else would ever look at that ref again.
  //
  // That's no longer possible to lose: `pendingQty`/`busyVariants` now live
  // in the module-level store above, not in this component. `dispatch()` is
  // a plain async closure over that shared store and the mutation
  // functions — once called, it keeps running to completion (or to its own
  // re-dispatch) as a normal JS promise chain, completely independent of
  // whether the screen that happened to trigger it is still mounted. There
  // is no per-screen cleanup left to do.

  // Stable across every render (empty dep arrays) — see file header, point 5.
  // Everything each closure needs comes from a ref, never from render scope.
  const qtyFor = useCallback((variantId: string): number => qtyForImpl(variantId), []);

  const isBusy = useCallback(
    (variantId: string): boolean => isBusyImpl(variantId),
    [],
  );

  const add = useCallback((variantId: string, snapshot?: CartItemSnapshot): void => {
    // Stored BEFORE setPending so the same render pass that reacts to the
    // new pendingQty already has display data to synthesize a line with —
    // see `optimisticCart` above.
    if (snapshot) usePendingCartStore.getState().setSnapshot(variantId, snapshot);
    setPending(variantId, qtyForImpl(variantId) + 1);
    void dispatch(variantId);
  }, []);

  const increment = useCallback((variantId: string): void => {
    setPending(variantId, qtyForImpl(variantId) + 1);
    void dispatch(variantId);
  }, []);

  /**
   * The removed line's own image — read synchronously from `linesRef`
   * (the last server-confirmed cart, unaffected by anything pending) with
   * a fallback to `pendingSnapshots` for a variant whose first-ever add
   * hasn't been confirmed by the server yet (see `add` above / the file
   * header's point 3). Used to fire the Mini Cart's remove-flight
   * animation with the ACTUAL removed product's image, never the Mini
   * Cart's own currently-displayed "latest added" image — those are
   * unrelated: removing Apple must animate Apple's image out even while
   * the Mini Cart is still showing Milk.
   *
   * Passed through `resolveImageUrl` — `flyToCart`/`flyFromCart` render
   * whatever URL they're given as-is (see flyToCart.tsx: it never resolves
   * anything itself), so every OTHER caller already pre-resolves before
   * calling (e.g. ProductCard's `resolveImageUrl(product.thumbUrl)`). The
   * raw `CartItemDto.imageUrl` field is un-resolved (e.g. a bare
   * `localhost` URL that isn't reachable from a device/emulator) — without
   * this, the flying dot's <Image> silently fails to load, so the flight
   * still fires and moves correctly but is invisible.
   */
  const removedLineImageUrl = (variantId: string): string | null =>
    resolveImageUrl(
      linesRef.current.get(variantId)?.imageUrl ??
        usePendingCartStore.getState().pendingSnapshots[variantId]?.imageUrl ??
        null,
    );

  const decrement = useCallback((variantId: string): void => {
    const prevQty = qtyForImpl(variantId);
    const nextQty = Math.max(0, prevQty - 1);

    // Only a decrement that actually EMPTIES the line is a removal — a
    // qty-3-to-2 decrement isn't "removing a product," so it doesn't fire
    // the remove-flight animation. Fired here, synchronously, before
    // `dispatch()` below starts its async request — the visual never
    // waits on the network.
    if (nextQty === 0 && prevQty > 0) {
      flyFromCart(removedLineImageUrl(variantId));
    }

    setPending(variantId, nextQty);
    void dispatch(variantId);
  }, []);

  const remove = useCallback((variantId: string): void => {
    flyFromCart(removedLineImageUrl(variantId));

    // Instant, unconditional: whatever this variant was showing, it's gone
    // from the list the moment this runs — see CartScreen's displayItems.
    setPending(variantId, 0);
    void dispatch(variantId);
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    const items = cartRef.current?.items ?? [];
    if (items.length === 0) return;

    setError(null);

    const store = usePendingCartStore.getState();
    for (const item of items) {
      // A per-item request mid-flight or one that's about to fire from a
      // just-set pending qty would otherwise land after the clear and put
      // the item right back. `clearInFlightPromise` (below) additionally
      // holds off any NEW tap's request — from any screen — until this
      // clear has fully settled.
      store.clearPending(item.variantId);
      store.setBusy(item.variantId, true);
    }

    const run = (async () => {
      try {
        // One atomic bulk delete instead of one request per line — both
        // faster and immune to the per-request ordering issues N separate
        // deletes would have.
        await mutationsRef.current.clearCart.mutateAsync({ distanceKm: distanceKmRef.current });
      } catch (err) {
        setError(
          err instanceof ApiRequestError
            ? err.message
            : "Could not clear your cart.",
        );
      } finally {
        const current = usePendingCartStore.getState();
        for (const item of items) current.setBusy(item.variantId, false);
      }
    })();

    clearInFlightPromise = run;
    await run;
    if (clearInFlightPromise === run) clearInFlightPromise = null;
  }, []);

  return {
    // The optimistic view — see `optimisticCart` above. Every screen
    // (badge, Cart screen, sticky bars) should read cart state through
    // this hook rather than calling `useCart()` directly, so they all
    // share the exact same instantly-updating numbers instead of each
    // being its own separately-lagging source of truth.
    cart: optimisticCart,
    isLoading: cartIsLoading,
    isError: cartIsError,
    refetch: refetchCart,
    error,
    busy,

    clearError: () => setError(null),

    qtyFor,
    isBusy,

    add,
    increment,
    decrement,
    remove,
    clear,
  };
}
