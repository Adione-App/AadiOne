/**
 * How many units of ONE variant (seller listing) a cart may hold — the same
 * two rules the server applies on every add / quantity change (backend
 * cart.service.ts), checked here only to answer a tap instantly:
 *
 *   - the listing's per-order limit (`maxQtyPerOrder`, already resolved to
 *     the configured default by the server) → QTY_LIMIT_EXCEEDED there;
 *   - the stock left (`availableQty` = stock − reserved) → INSUFFICIENT_STOCK.
 *
 * Limits are per variant: the server has no product-level limit shared by
 * several sizes, so neither does this. The server stays the final authority
 * — its refusal is shown with the same popup (useCartActions.ts).
 */

export interface QuantityLimit {
  max: number;
  /** Which rule sets `max` — decides the message. */
  reason: "stock" | "order";
}

export function quantityLimitOf(item: { availableQty: number; maxQtyPerOrder: number }): QuantityLimit {
  const stock = Math.max(0, Math.floor(item.availableQty));
  const order = item.maxQtyPerOrder > 0 ? item.maxQtyPerOrder : Number.POSITIVE_INFINITY;
  return stock < order ? { max: stock, reason: "stock" } : { max: order, reason: "order" };
}

const units = (n: number) => (n === 1 ? "unit" : "units");

export function quantityLimitMessage(limit: QuantityLimit): string {
  if (limit.reason === "stock") {
    return limit.max <= 0 ? "This item is out of stock right now." : `Only ${limit.max} ${units(limit.max)} available right now.`;
  }
  return `You can add up to ${limit.max} ${units(limit.max)} of this item per order.`;
}
