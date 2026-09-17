/**
 * Cart actions shared by every screen that shows a product.
 *
 * ARCHITECTURE (see queries.ts's `write()` for the other half of this fix):
 *
 * 1. OPTIMISTIC QTY — `pendingQtyRef` is the qty a variant shows *right now*,
 *    ahead of the server confirming it. It's a ref, not state, so a fast
 *    second tap computes off the value the first tap just set rather than a
 *    stale one captured before the re-render landed. `qtyFor()` always reads
 *    this ref first, falling back to the real cart data only once nothing is
 *    pending for that variant.
 *
 * 2. ONE REQUEST IN FLIGHT PER VARIANT, SENT IMMEDIATELY, NO DEBOUNCE — every
 *    tap dispatches straight away; there is no artificial delay. If a
 *    request for a variant is already in flight, a new tap only updates the
 *    optimistic qty and returns — `dispatch`'s own `finally` notices the
 *    target moved and immediately re-dispatches once the current request
 *    settles. This isn't for smoothness (the UI is already instant); it's
 *    required for correctness: `POST /cart/items` is ADDITIVE server-side
 *    (qty sent is added to whatever's already there), so two concurrent
 *    "create the line" requests for the same variant would double-count.
 *    Serializing keeps exactly one request in flight, which both prevents
 *    that and means a stale response can never land after a newer one —
 *    there's only ever one response to receive at a time.
 *
 * 3. KNOWING WHETHER A LINE ALREADY EXISTS — a fresh dispatch (a real tap)
 *    reads this from `linesRef.current`, i.e. the live `cart` query data,
 *    never from a value cached on a previous tap. That data is shared across
 *    every screen (see queries.ts's `write()`), so it's correct regardless
 *    of which screen last touched the cart — this used to be cached in a
 *    ref that persisted for the hook's whole lifetime, which is exactly what
 *    broke: add a product from Home, clear the cart from the Cart screen,
 *    then tap Add on that product from Home again — Home's cache still
 *    "remembered" the line id the clear had just deleted, so it sent a PATCH
 *    to a cart item that no longer existed and the server correctly said
 *    "Cart item not found." A CHAINED re-dispatch (point 2, same synchronous
 *    continuation as the response it's reacting to) is the one place a fresh
 *    read would still be one render behind, so that case alone passes the
 *    just-confirmed line through as an explicit argument instead.
 *
 * 4. CLEAR ALL vs PER-ITEM TAPS — `clearInFlightRef` holds the in-progress
 *    clear's promise. A per-item dispatch that starts while a clear is
 *    running awaits it first, then re-reads pending/known state fresh. This
 *    is what stops "Delete B, then Clear All, then Add A" from racing: the
 *    Add's actual request can never be answered by a clear response that was
 *    computed before the add happened.
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
import type { CartDto } from "@shared";
import { ApiRequestError } from "./api";
import { useCart, useCartMutations } from "./queries";
import { useLocation } from "@/lib/store";

type KnownLine = { id: string; qty: number } | null;

export function useCartActions() {
  // IMPORTANT: pass the current serviceability distance
  // so cart pricing includes the correct delivery fee.
  const serviceability = useLocation(
    (state) => state.serviceability,
  );

  const distanceKm = serviceability?.distanceKm ?? null;

  const { data: cart } = useCart(distanceKm);

  const mutations = useCartMutations();
  const { addItem, updateQty, removeItem, clearCart } = mutations;

  const [error, setError] = useState<string | null>(null);

  // Mirrors pendingQtyRef so changing it triggers a re-render; the ref is
  // what's actually read/written synchronously during rapid taps.
  const pendingQtyRef = useRef<Record<string, number>>({});
  const [, forceRender] = useState(0);

  const linesByVariant = useMemo(() => {
    const map = new Map<string, CartDto["items"][number]>();

    for (const item of cart?.items ?? []) {
      map.set(item.variantId, item);
    }

    return map;
  }, [cart]);

  // Read by dispatch()/clear()/the unmount flush without needing any of
  // these in their own dependency lists — see file header, point 5.
  const linesRef = useRef(linesByVariant);
  linesRef.current = linesByVariant;
  const distanceKmRef = useRef(distanceKm);
  distanceKmRef.current = distanceKm;
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const mutationsRef = useRef(mutations);
  mutationsRef.current = mutations;

  const qtyForImpl = (variantId: string): number =>
    variantId in pendingQtyRef.current
      ? pendingQtyRef.current[variantId]!
      : (linesRef.current.get(variantId)?.qty ?? 0);

  const setPending = (variantId: string, qty: number): void => {
    pendingQtyRef.current = { ...pendingQtyRef.current, [variantId]: qty };
    forceRender((n) => n + 1);
  };

  const clearPending = (variantId: string): void => {
    if (!(variantId in pendingQtyRef.current)) return;
    const next = { ...pendingQtyRef.current };
    delete next[variantId];
    pendingQtyRef.current = next;
    forceRender((n) => n + 1);
  };

  const busyVariants = useRef<Set<string>>(new Set());
  const clearInFlightRef = useRef<Promise<void> | null>(null);
  // Debug-only, per variant — logged as [Cart] lines so the exact sequence
  // of taps/requests/responses can be read back during testing.
  const mutationSeqRef = useRef<Record<string, number>>({});

  const busy =
    addItem.isPending ||
    updateQty.isPending ||
    removeItem.isPending ||
    clearCart.isPending;

  const log = (...args: unknown[]): void => {
    if (__DEV__) console.log("[Cart]", ...args);
  };

  /**
   * Sends whatever qty is CURRENTLY pending for one variant. Safe to call
   * any number of times — it no-ops if a request for this variant is
   * already running or if there is nothing pending.
   */
  const dispatch = async (variantId: string, chainedKnown?: KnownLine): Promise<void> => {
    // A Clear All is in progress — its response must land and be applied
    // before this variant's own request is allowed to go out, or a clear
    // response computed before this tap could later overwrite it.
    if (clearInFlightRef.current) await clearInFlightRef.current;

    if (busyVariants.current.has(variantId)) return;
    const targetQty = pendingQtyRef.current[variantId];
    if (targetQty === undefined) return;

    // `chainedKnown` is only passed by the same-tick re-dispatch below, right
    // after applying its own response — for every other (i.e. real, fresh)
    // call this always reads the live, shared cart data. See file header.
    const known: KnownLine =
      chainedKnown !== undefined ? chainedKnown : (linesRef.current.get(variantId) ?? null);

    const seq = (mutationSeqRef.current[variantId] ?? 0) + 1;
    mutationSeqRef.current[variantId] = seq;

    if (targetQty <= 0 && !known) {
      // Already empty server-side — nothing to sync for a decrement-to-zero
      // that resolved before any line was ever created.
      log(variantId, "mutation", seq, "no-op: already empty, target 0");
      if (pendingQtyRef.current[variantId] === targetQty) clearPending(variantId);
      return;
    }

    log(variantId, "mutation", seq, "start, target qty", targetQty, "known line", known);

    setError(null);
    busyVariants.current.add(variantId);
    forceRender((n) => n + 1);

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
        : // Additive server-side. Safe ONLY because busyVariants guarantees
          // this is the sole in-flight request for this variant, so "0 +
          // targetQty" is exactly the qty the user asked for.
          await add_.mutateAsync({
            variantId,
            qty: targetQty,
            distanceKm: distanceKmRef.current,
          });

      const line = response.items.find((item) => item.variantId === variantId);
      confirmedKnown = line ? { id: line.id, qty: line.qty } : null;
      log(variantId, "mutation", seq, "response applied, server qty", line?.qty ?? 0);
    } catch (err) {
      log(variantId, "mutation", seq, "failed", err);
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not update your cart.",
      );
    } finally {
      busyVariants.current.delete(variantId);

      if (pendingQtyRef.current[variantId] === targetQty) {
        // Nothing changed while this was in flight — the response we just
        // applied IS the current truth, so the optimistic cover can drop.
        clearPending(variantId);
      } else {
        // A newer tap landed while this request was in flight. Do NOT let
        // the response we just got settle the UI — it's already stale.
        // Continue straight to the latest target; no delay.
        log(variantId, "mutation", seq, "superseded by newer tap, re-dispatching");
        void dispatch(variantId, confirmedKnown);
      }
    }
  };

  // A tap must not be silently dropped just because the screen it was made
  // on unmounts before its request finishes (e.g. navigating away right
  // after tapping). `mutate` (not `mutateAsync`) is used because the request
  // should outlive this component, and nothing here needs to await it.
  useEffect(() => {
    return () => {
      for (const variantId of Object.keys(pendingQtyRef.current)) {
        if (busyVariants.current.has(variantId)) continue; // already in flight, will complete on its own
        const targetQty = pendingQtyRef.current[variantId];
        if (targetQty === undefined) continue;

        const known = linesRef.current.get(variantId) ?? null;

        if (known) {
          updateQty.mutate({
            cartItemId: known.id,
            qty: Math.max(0, targetQty),
            distanceKm: distanceKmRef.current,
          });
        } else if (targetQty > 0) {
          addItem.mutate({ variantId, qty: targetQty, distanceKm: distanceKmRef.current });
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
  }, []);

  // Stable across every render (empty dep arrays) — see file header, point 5.
  // Everything each closure needs comes from a ref, never from render scope.
  const qtyFor = useCallback((variantId: string): number => qtyForImpl(variantId), []);

  const isBusy = useCallback(
    (variantId: string): boolean => busyVariants.current.has(variantId),
    [],
  );

  const add = useCallback((variantId: string, qty = 1): void => {
    setPending(variantId, qtyForImpl(variantId) + qty);
    void dispatch(variantId);
  }, []);

  const increment = useCallback((variantId: string): void => {
    setPending(variantId, qtyForImpl(variantId) + 1);
    void dispatch(variantId);
  }, []);

  const decrement = useCallback((variantId: string): void => {
    setPending(variantId, Math.max(0, qtyForImpl(variantId) - 1));
    void dispatch(variantId);
  }, []);

  const remove = useCallback((variantId: string): void => {
    // Instant, unconditional: whatever this variant was showing, it's gone
    // from the list the moment this runs — see CartScreen's displayItems.
    setPending(variantId, 0);
    void dispatch(variantId);
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    const items = cartRef.current?.items ?? [];
    if (items.length === 0) return;

    setError(null);

    for (const item of items) {
      // A per-item request mid-flight or one that's about to fire from a
      // just-set pending qty would otherwise land after the clear and put
      // the item right back. clearInFlightRef (below) additionally holds
      // off any NEW tap's request until this clear has fully settled.
      clearPending(item.variantId);
      busyVariants.current.add(item.variantId);
    }
    forceRender((n) => n + 1);

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
        for (const item of items) busyVariants.current.delete(item.variantId);
      }
    })();

    clearInFlightRef.current = run;
    await run;
    if (clearInFlightRef.current === run) clearInFlightRef.current = null;
  }, []);

  return {
    cart,
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
