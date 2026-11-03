/**
 * The customer's OWN held stock, shown on product cards.
 *
 * An unpaid online checkout holds its units (`reserved_qty`) until Cashfree
 * confirms the payment. The catalogue (Home, categories, search, stores,
 * product pages) is shared and cached for everyone, so it rightly counts
 * every hold as taken — and showed the customer's own last unit "Sold out"
 * to the very customer it is held for.
 *
 * The fix never touches the catalogue or its caches. The customer's own
 * cart — a private, per-account query (never persisted, dropped on sign-out:
 * queries.ts `forgetPrivateQueries`) — already carries the server's answer
 * for each line: `heldForYouQty` (what their own checkout holds) and the
 * `availableQty` / `inStock` that count those units as theirs. Only a line
 * with a hold overrides the catalogue, so a customer holding nothing (and a
 * guest, who has no cart) always sees the catalogue exactly as before.
 *
 * Pure (no React Native), so `npm run test:unit` covers it.
 */

export interface OwnHold {
  /** Units this customer may have of the listing, their own hold included. */
  availableQty: number;
}

export type OwnHolds = ReadonlyMap<string, OwnHold>;

export const NO_OWN_HOLDS: OwnHolds = new Map();

export interface CartLineHold {
  sellerListingId: string;
  availableQty: number;
  inStock: boolean;
  heldForYouQty?: number | undefined;
}

/**
 * From the SERVER-CONFIRMED cart only — never a cart restored from disk or
 * an optimistic one, whose availability may be hours old.
 */
export function ownHoldsFromCart(items: readonly CartLineHold[] | null | undefined): OwnHolds {
  const holds = new Map<string, OwnHold>();
  for (const item of items ?? []) {
    if (!item.heldForYouQty || item.heldForYouQty <= 0) continue;
    // Off sale (the seller switched it off) or nothing left even with the
    // hold: the line's own `inStock` says so — never shown as available.
    holds.set(item.sellerListingId, { availableQty: item.inStock ? Math.max(0, item.availableQty) : 0 });
  }
  return holds.size > 0 ? holds : NO_OWN_HOLDS;
}

/** What one card shows for a listing: its own hold's availability, or null (the catalogue's). */
export function ownAvailableQty(holds: OwnHolds, sellerListingId: string | null | undefined): number | null {
  if (!sellerListingId) return null;
  return holds.get(sellerListingId)?.availableQty ?? null;
}

/** A catalogue variant as this customer sees it (unchanged when they hold none of it). */
export function withOwnHold<V extends { sellerListingId: string; availableQty: number; inStock: boolean }>(
  variant: V,
  holds: OwnHolds,
): V {
  const available = ownAvailableQty(holds, variant.sellerListingId);
  if (available === null) return variant;
  return { ...variant, availableQty: available, inStock: available > 0 };
}
