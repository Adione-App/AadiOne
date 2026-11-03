/**
 * The ONE definition of "how much of a listing can be sold".
 *
 * Two inventory modes, chosen per listing by `seller_listings.tracks_stock`:
 *
 *   TRACKED (tracks_stock = true) — physical goods: grocery, fashion, home…
 *     available = stock_qty − reserved_qty; orders reserve, commit and
 *     restock it; it can run out; it counts in every stock total.
 *
 *   NOT TRACKED (tracks_stock = false) — made-to-order food (restaurants,
 *     cafes). There is NO stock count: stock_qty and reserved_qty stay 0 and
 *     are never read; orders reserve nothing; the item is sellable while the
 *     seller has it switched on (is_available) and the restaurant is open.
 *     It never appears in stock totals, low-stock or out-of-stock lists.
 *     (Food items used to carry a fabricated stock of 100000 so the shared
 *     "stock − reserved" checks would pass — that number distorted every
 *     inventory total. scripts/food-stock-backfill.ts clears existing rows.)
 *
 * A restaurant that wants to sell a limited number of portions is simply a
 * TRACKED listing: everything above then applies to it unchanged.
 */

import { Prisma } from '@prisma/client';

export interface StockFields {
  tracksStock: boolean;
  stockQty: number;
  reservedQty: number;
}

/** Units left to sell of a TRACKED listing; null when the listing is not tracked. */
export function trackedAvailableQty(listing: StockFields): number | null {
  return listing.tracksStock ? Math.max(0, listing.stockQty - listing.reservedQty) : null;
}

/**
 * Units of a TRACKED listing ONE customer can have, given what their own
 * unpaid online checkout already holds of it (`ownHeldQty`, from
 * orders/own-checkout-holds.ts). Those units are reserved FOR this customer
 * — still theirs to pay for, not sold — so their own cart must never call
 * them "out of stock": that was the last-unit bug (Pay Online, return from
 * Cashfree without paying, the cart says OUT OF STOCK). Everyone else's
 * holds still count, so no one else can take a unit that is held.
 *
 * Only for cart / checkout decisions about the customer's own lines. The
 * order transaction itself never uses this: it re-checks plain
 * `stock − reserved` under the row lock, after the customer's open checkout
 * was reused or released (orders/open-checkout.ts).
 */
export function trackedAvailableQtyFor(listing: StockFields, ownHeldQty: number): number | null {
  if (!listing.tracksStock) return null;
  const heldByOthers = Math.max(0, listing.reservedQty - Math.max(0, ownHeldQty));
  return Math.max(0, listing.stockQty - heldByOthers);
}

/** Whether stock allows a sale at all (availability switch and seller state are separate checks). */
export function hasStockToSell(listing: StockFields): boolean {
  return !listing.tracksStock || listing.stockQty - listing.reservedQty > 0;
}

/**
 * What a customer may add of one listing, ignoring what is already in the
 * cart: a tracked listing's stock left, else (made to order) the per-order
 * limit — the only real limit such an item has. Never a fabricated stock.
 */
export function sellableQty(listing: StockFields & { maxQtyPerOrder: number }): number {
  return trackedAvailableQty(listing) ?? listing.maxQtyPerOrder;
}

/**
 * SQL form of `hasStockToSell`, for a seller_listings row aliased `alias`
 * (a plain identifier — never user input).
 */
export function hasStockToSellSql(alias = 'sl'): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`invalid SQL alias ${alias}`);
  return Prisma.raw(`(NOT ${alias}.tracks_stock OR ${alias}.stock_qty - ${alias}.reserved_qty > 0)`);
}
