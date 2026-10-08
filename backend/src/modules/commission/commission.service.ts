/**
 * Commission resolution (V2).
 *
 * Same shape as the CodPolicy INHERIT chain (see shared/cod.ts): most
 * specific wins. product > category > seller default. Resolved once, at
 * order creation, and the result is SNAPSHOTTED onto SellerOrder
 * (commissionBp/commissionPaise) — never recomputed later even if the
 * matching rule subsequently changes, so a past order's payout math stays
 * explainable (the same principle as OrderItem's own price snapshot).
 */

import type { Tx } from '../../infra/db/prisma';
import { prisma } from '../../infra/db/prisma';

export interface CommissionResolutionInput {
  sellerId: string;
  /** The product's own (leaf) category — ancestors are NOT walked; a
   * category-level commission rule applies to the exact category it names,
   * unlike CodPolicy's leaf-to-root walk. Sellers/admins set the rule on
   * whichever level (a parent category included) should govern. */
  categoryId: string;
  productId: string;
}

/**
 * Resolves the commission rate (basis points) for one line, at order time.
 *
 * Precedence: an ACTIVE rule scoped to this exact `productId` wins; else an
 * ACTIVE rule scoped to this exact `categoryId`; else the seller's own
 * `defaultCommissionBp`.
 */
export async function resolveCommissionBp(
  input: CommissionResolutionInput,
  client: Tx | typeof prisma = prisma,
): Promise<number> {
  const productRule = await client.commissionRule.findFirst({
    where: { sellerId: input.sellerId, productId: input.productId, isActive: true },
    select: { rateBp: true },
  });
  if (productRule) return productRule.rateBp;

  const categoryRule = await client.commissionRule.findFirst({
    where: { sellerId: input.sellerId, categoryId: input.categoryId, isActive: true },
    select: { rateBp: true },
  });
  if (categoryRule) return categoryRule.rateBp;

  const seller = await client.seller.findUniqueOrThrow({
    where: { id: input.sellerId },
    select: { defaultCommissionBp: true },
  });
  return seller.defaultCommissionBp;
}

/**
 * Same precedence as `resolveCommissionBp` (product > category > seller
 * default), batched: exactly 2 queries total for however many lines are
 * being priced, instead of up to 3 SEQUENTIAL queries PER LINE.
 *
 * Safe to batch because nothing here is locked or written by the order
 * transaction that calls it — `CommissionRule`/`Seller.defaultCommissionBp`
 * are read-only inputs to this resolution, so there is no isolation reason
 * they need to be looked up one line at a time. This is why
 * order.service.ts's `placeOrder` (the only caller) can call this once,
 * inside the SAME transaction/lock scope it already runs in, and cut what
 * was the dominant per-item cost in a multi-seller checkout down to a
 * constant two round trips regardless of cart size.
 *
 * `sellerDefaultBpBySellerId` is supplied by the caller rather than queried
 * here because `placeOrder` already has every involved seller's row loaded
 * (from the cart's own `include`) by the time this runs — querying it again
 * would be the exact per-line cost this function exists to avoid. A seller
 * id present in a request but absent from that map is a caller bug (the
 * seller row that item's SellerOrder belongs to must already be loaded),
 * so it throws rather than silently defaulting to 0.
 */
export async function resolveCommissionBpBatch(
  requests: readonly CommissionResolutionInput[],
  sellerDefaultBpBySellerId: ReadonlyMap<string, number>,
  client: Tx | typeof prisma = prisma,
): Promise<number[]> {
  if (requests.length === 0) return [];

  const sellerIds = [...new Set(requests.map((r) => r.sellerId))];
  const productIds = [...new Set(requests.map((r) => r.productId))];
  const categoryIds = [...new Set(requests.map((r) => r.categoryId))];

  // Independent reads — together (inside a transaction Prisma still runs
  // them one at a time on its single connection, so this is safe there too).
  const [productRules, categoryRules] = await Promise.all([
    client.commissionRule.findMany({
      where: { sellerId: { in: sellerIds }, productId: { in: productIds }, isActive: true },
      select: { sellerId: true, productId: true, rateBp: true },
    }),
    client.commissionRule.findMany({
      where: { sellerId: { in: sellerIds }, categoryId: { in: categoryIds }, isActive: true },
      select: { sellerId: true, categoryId: true, rateBp: true },
    }),
  ]);

  // Safe to key on (sellerId, productId)/(sellerId, categoryId) alone: the
  // schema's own partial unique indexes guarantee at most one ACTIVE rule
  // per pair (see CommissionRule's own doc comment), so neither map can have
  // a colliding, ambiguous entry.
  const productRuleBySellerAndProduct = new Map(
    productRules.map((r) => [`${r.sellerId}:${r.productId}`, r.rateBp]),
  );
  const categoryRuleBySellerAndCategory = new Map(
    categoryRules.map((r) => [`${r.sellerId}:${r.categoryId}`, r.rateBp]),
  );

  return requests.map((request) => {
    const byProduct = productRuleBySellerAndProduct.get(`${request.sellerId}:${request.productId}`);
    if (byProduct !== undefined) return byProduct;

    const byCategory = categoryRuleBySellerAndCategory.get(
      `${request.sellerId}:${request.categoryId}`,
    );
    if (byCategory !== undefined) return byCategory;

    const sellerDefault = sellerDefaultBpBySellerId.get(request.sellerId);
    if (sellerDefault === undefined) {
      throw new Error(
        `resolveCommissionBpBatch: no defaultCommissionBp supplied for seller ${request.sellerId}`,
      );
    }
    return sellerDefault;
  });
}

/** Paise, rounded down — commission is a cost to the seller, never rounded in their favour. */
export function commissionPaiseFor(subtotalPaise: number, rateBp: number): number {
  return Math.floor((subtotalPaise * rateBp) / 10_000);
}

// Rule management (create/replace/deactivate with one-active-rule-per-scope
// guarantees) lives in commission-management.service.ts.
