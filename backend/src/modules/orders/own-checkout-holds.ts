/**
 * What a customer's OWN unpaid online checkout holds, per seller listing.
 *
 * An unpaid online order reserves its units (`seller_listings.reserved_qty`)
 * and — since cart-retention.ts — keeps its lines in the cart until the
 * payment is verified. Every cart / checkout availability check reads
 * `stock − reserved`, which counted the customer's own hold against them:
 * pay online for the last unit, come back from Cashfree without paying,
 * and the cart said "OUT OF STOCK", cut quantities down to what was left
 * after the hold, and refused "Retry payment" — although nothing was sold
 * and the unit was waiting for exactly this customer.
 *
 * These holds are what inventory/stock-rules.ts `trackedAvailableQtyFor`
 * adds back for the customer's own decisions. Exactly the units that are
 * in `reserved_qty` for them:
 *
 *   - status PENDING_PAYMENT, paid online: the reservation is still held
 *     (any other status has committed or released it — order-state.service);
 *   - its lines stayed in the cart (cart-retention.ts): an older order whose
 *     lines left the cart at placement is not the cart's business;
 *   - tracked listings only: a made-to-order food line reserves nothing
 *     (reserveStock skips it), so it holds nothing here either — its
 *     availability is never adjusted, on the cart or on a product card.
 *
 * One round trip, so a cart read does not wait on an extra query chain.
 */

import { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../infra/db/prisma';

/** sellerListingId -> units this customer's own unpaid checkout holds. */
export type OwnCheckoutHolds = ReadonlyMap<string, number>;

export const NO_HOLDS: OwnCheckoutHolds = new Map();

export async function ownCheckoutHolds(
  userId: string,
  client: DbClient = prisma,
  sellerListingIds?: readonly string[],
): Promise<OwnCheckoutHolds> {
  if (sellerListingIds && sellerListingIds.length === 0) return NO_HOLDS;
  const listingFilter = sellerListingIds
    ? Prisma.sql`AND oi.seller_listing_id IN (${Prisma.join(sellerListingIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;

  const rows = await client.$queryRaw<{ seller_listing_id: string; qty: number }[]>`
    SELECT oi.seller_listing_id, SUM(oi.qty)::int AS qty
    FROM orders o
    JOIN seller_orders so ON so.order_id = o.id
    JOIN order_items oi ON oi.seller_order_id = so.id
    JOIN seller_listings sl ON sl.id = oi.seller_listing_id AND sl.tracks_stock
    WHERE o.user_id = ${userId}::uuid
      AND o.status = 'PENDING_PAYMENT'
      AND o."paymentMethod" = 'ONLINE'
      AND oi.seller_listing_id IS NOT NULL
      ${listingFilter}
      AND EXISTS (
        SELECT 1 FROM order_status_history h
        WHERE h.order_id = o.id AND h.from_status IS NULL AND h.metadata ->> 'cartRetained' = 'true'
      )
    GROUP BY oi.seller_listing_id`;

  if (rows.length === 0) return NO_HOLDS;
  return new Map(rows.map((row) => [row.seller_listing_id, Number(row.qty)]));
}

/** Units of one listing the customer's own checkout holds (0 when none). */
export function heldFor(holds: OwnCheckoutHolds, sellerListingId: string): number {
  return holds.get(sellerListingId) ?? 0;
}
