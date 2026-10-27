/**
 * What the Cart screen shows and sends about which lines can be ordered —
 * pure, so it is unit-tested (tests/cartAvailability.test.ts). The server
 * decides availability (CartItemDto.available); this only reads it.
 *
 *   available !== false            orderable (an older server sends no flag)
 *   available false, no reason     still being checked (e.g. a cart restored
 *                                  from the phone before the server answered)
 *                                  — never treated as orderable
 *   available false + reason       unavailable: kept, greyed, left out
 */

import type { CartItemDto } from "@shared";

type Line = Pick<CartItemDto, "available" | "unavailableReason">;

export function isOrderableLine(item: Line): boolean {
  return item.available !== false;
}

export function isCheckingLine(item: Line): boolean {
  return item.available === false && item.unavailableReason === null;
}

/** The red (or, while checking, neutral) label under an unavailable line; null when orderable. */
export function unavailableLabel(item: Line): string | null {
  if (isOrderableLine(item)) return null;
  if (isCheckingLine(item)) return "Checking availability…";
  switch (item.unavailableReason) {
    case "STORE_CLOSED":
      return "STORE CLOSED — UNAVAILABLE RIGHT NOW";
    case "OUT_OF_STOCK":
      return "OUT OF STOCK — UNAVAILABLE RIGHT NOW";
    default:
      return "UNAVAILABLE RIGHT NOW";
  }
}

/**
 * The notice above a mixed cart: what the order will include. Null when every
 * line can be ordered, when none can (the checkout bar explains that), or
 * while lines are still being checked.
 */
export function partialOrderNotice(items: readonly Line[]): string | null {
  const unavailable = items.filter((item) => !isOrderableLine(item) && !isCheckingLine(item)).length;
  const orderable = items.filter(isOrderableLine).length;
  if (unavailable === 0 || orderable === 0) return null;
  const word = (n: number) => (n === 1 ? "item" : "items");
  return `${unavailable} ${word(unavailable)} can't be ordered right now and will stay in your cart. Your order will include the other ${orderable} ${word(orderable)} — the bill below is for those only.`;
}

/** The lines an order is placed for: exactly the orderable ones (sent as `expectedItems`). */
export function orderedLines<T extends Line & { sellerListingId: string | null; unitPricePaise: number }>(
  items: readonly T[],
): { sellerListingId: string; unitPricePaise: number }[] {
  return items.flatMap((item) =>
    item.sellerListingId && isOrderableLine(item)
      ? [{ sellerListingId: item.sellerListingId, unitPricePaise: item.unitPricePaise }]
      : [],
  );
}
