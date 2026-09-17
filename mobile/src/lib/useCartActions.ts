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
 * 3. `knownLineRef` — tracks each variant's cart-line id (or null) from the
 *    MUTATION RESPONSE ITSELF, not from the `cart` query data. That data only
 *    updates once React re-renders this hook with the new cache contents,
 *    which can lag behind a same-tick chained re-dispatch (see point 2) by a
 *    render. Reading the response directly means a decrement-to-zero that
 *    lands the instant an add's response comes back always sees the line
 *    that add just created, never a stale "doesn't exist yet".
 */

import { useEffect, useMemo, useRef, useState } from "react";
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

  const { addItem, updateQty, removeItem } = useCartMutations();

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

  // Read by dispatch()/the unmount flush without needing either in their own
  // dependency lists — plain functions defined once, not per render.
  const linesRef = useRef(linesByVariant);
  linesRef.current = linesByVariant;
  const distanceKmRef = useRef(distanceKm);
  distanceKmRef.current = distanceKm;

  const qtyFor = (variantId: string): number =>
    variantId in pendingQtyRef.current
      ? pendingQtyRef.current[variantId]!
      : (linesByVariant.get(variantId)?.qty ?? 0);

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
  const knownLineRef = useRef<Record<string, KnownLine>>({});
  // Debug-only, per variant — logged as [Cart] lines so the exact sequence
  // of taps/requests/responses can be read back during testing.
  const mutationSeqRef = useRef<Record<string, number>>({});

  const busy =
    addItem.isPending ||
    updateQty.isPending ||
    removeItem.isPending;

  const log = (...args: unknown[]): void => {
    if (__DEV__) console.log("[Cart]", ...args);
  };

  /**
   * Sends whatever qty is CURRENTLY pending for one variant. Safe to call
   * any number of times — it no-ops if a request for this variant is
   * already running or if there is nothing pending.
   */
  const dispatch = async (variantId: string): Promise<void> => {
    if (busyVariants.current.has(variantId)) return;
    const targetQty = pendingQtyRef.current[variantId];
    if (targetQty === undefined) return;

    // undefined = never touched this session, fall back to the real cart;
    // explicit null (a prior request confirmed no line) must NOT fall back.
    const known: KnownLine =
      knownLineRef.current[variantId] !== undefined
        ? knownLineRef.current[variantId]!
        : (linesRef.current.get(variantId) ?? null);

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

    try {
      const response = known
        ? // Absolute-set — and the server deletes the row itself when
          // qty <= 0, so zero and a normal decrement take the same path.
          await updateQty.mutateAsync({
            cartItemId: known.id,
            qty: Math.max(0, targetQty),
            distanceKm: distanceKmRef.current,
          })
        : // Additive server-side. Safe ONLY because busyVariants guarantees
          // this is the sole in-flight request for this variant, so "0 +
          // targetQty" is exactly the qty the user asked for.
          await addItem.mutateAsync({
            variantId,
            qty: targetQty,
            distanceKm: distanceKmRef.current,
          });

      const line = response.items.find((item) => item.variantId === variantId);
      knownLineRef.current[variantId] = line ? { id: line.id, qty: line.qty } : null;
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
        void dispatch(variantId);
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

        const known =
          knownLineRef.current[variantId] !== undefined
            ? knownLineRef.current[variantId]
            : (linesRef.current.get(variantId) ?? null);

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

  const add = (variantId: string, qty = 1): void => {
    setPending(variantId, qtyFor(variantId) + qty);
    void dispatch(variantId);
  };

  const increment = (variantId: string): void => {
    setPending(variantId, qtyFor(variantId) + 1);
    void dispatch(variantId);
  };

  const decrement = (variantId: string): void => {
    setPending(variantId, Math.max(0, qtyFor(variantId) - 1));
    void dispatch(variantId);
  };

  const remove = (variantId: string): void => {
    setPending(variantId, 0);
    void dispatch(variantId);
  };

  const clear = async (): Promise<void> => {
    const items = cart?.items ?? [];

    if (items.length === 0) {
      return;
    }

    setError(null);

    for (const item of items) {
      // A per-item request mid-flight or one that's about to fire from a
      // just-set pending qty would otherwise land after the clear and put
      // the item right back.
      clearPending(item.variantId);
      knownLineRef.current[item.variantId] = null;
      busyVariants.current.add(item.variantId);
    }

    try {
      // Each deletion targets its own line and is independent of the others,
      // so firing them together turns an N-item cart from N sequential round
      // trips (seconds, on the rural 3G this app targets) into one.
      await Promise.all(
        items.map((item) =>
          removeItem.mutateAsync({
            cartItemId: item.id,
            distanceKm,
          }),
        ),
      );
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not clear your cart.",
      );
    } finally {
      for (const item of items) busyVariants.current.delete(item.variantId);
    }
  };

  return {
    cart,
    error,
    busy,

    clearError: () => setError(null),

    qtyFor,

    /** Only the tapped product is disabled while its own update is in flight. */
    isBusy: (variantId: string) => busyVariants.current.has(variantId),

    add,
    increment,
    decrement,
    remove,
    clear,
  };
}
