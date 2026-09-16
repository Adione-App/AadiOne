/**
 * Cart actions shared by every screen that shows a product.
 *
 * OPTIMISTIC QTY: tapping Add/+/- used to sit frozen for a full network
 * round-trip (1-3s on the mid-range/rural-3G phones this app targets) before
 * showing any change at all. `pendingQtyRef` tracks the qty the UI should
 * show *right now*, ahead of the server confirming it, so the button reacts
 * the instant you tap it. It's a ref (not just state) so rapid taps compute
 * off the latest value synchronously rather than all reading the same stale
 * qty before a re-render lands. The server's response is still what
 * ultimately lands in the cache (via `write()`, unchanged) — this only
 * covers the gap while that response is in flight.
 */

import { useMemo, useRef, useState } from "react";
import type { CartDto } from "@shared";
import { ApiRequestError } from "./api";
import { useCart, useCartMutations } from "./queries";
import { useLocation } from "@/lib/store";

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

  const busy =
    addItem.isPending ||
    updateQty.isPending ||
    removeItem.isPending;

  const handle = async (variantId: string, action: Promise<unknown>): Promise<void> => {
    setError(null);
    busyVariants.current.add(variantId);

    try {
      await action;
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not update your cart.",
      );
    } finally {
      busyVariants.current.delete(variantId);
      clearPending(variantId);
    }
  };

  const add = (variantId: string, qty = 1) => {
    setPending(variantId, qtyFor(variantId) + qty);
    return handle(
      variantId,
      addItem.mutateAsync({
        variantId,
        qty,
        distanceKm,
      }),
    );
  };

  const increment = (variantId: string) => {
    const line = linesByVariant.get(variantId);
    const nextQty = qtyFor(variantId) + 1;
    setPending(variantId, nextQty);

    if (!line) {
      return handle(
        variantId,
        addItem.mutateAsync({
          variantId,
          qty: 1,
          distanceKm,
        }),
      );
    }

    return handle(
      variantId,
      updateQty.mutateAsync({
        cartItemId: line.id,
        qty: nextQty,
        distanceKm,
      }),
    );
  };

  const decrement = (variantId: string) => {
    const line = linesByVariant.get(variantId);

    if (!line) {
      return Promise.resolve();
    }

    const nextQty = Math.max(0, qtyFor(variantId) - 1);
    setPending(variantId, nextQty);

    return handle(
      variantId,
      updateQty.mutateAsync({
        cartItemId: line.id,
        qty: nextQty,
        distanceKm,
      }),
    );
  };

  const remove = (variantId: string) => {
    const line = linesByVariant.get(variantId);

    if (!line) {
      return Promise.resolve();
    }

    setPending(variantId, 0);

    return handle(
      variantId,
      removeItem.mutateAsync({
        cartItemId: line.id,
        distanceKm,
      }),
    );
  };

  const clear = async (): Promise<void> => {
    const items = cart?.items ?? [];

    if (items.length === 0) {
      return;
    }

    setError(null);

    try {
      for (const item of items) {
        await removeItem.mutateAsync({
          cartItemId: item.id,
          distanceKm,
        });
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not clear your cart.",
      );
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