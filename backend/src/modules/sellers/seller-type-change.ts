/**
 * Controlled seller-type change for an existing seller (there is no admin
 * screen for it: a type is chosen at creation, or on resubmitting a rejected
 * application). Used by scripts/change-seller-type.ts.
 *
 * Narrow by construction:
 *   - one seller, found by its exact code, and only while its CURRENT type is
 *     the expected one — so a re-run, or a run against the wrong seller,
 *     changes nothing;
 *   - only `sellers.seller_type` is written (and its audit row); the seller
 *     row, code, products, listings, categories / menus, orders, hours,
 *     restaurant profile and images are never touched;
 *   - food <-> non-food moves are refused: a food seller's category tree IS
 *     its menu, a marketplace seller's is its catalogue, so such a move needs
 *     a deliberate catalogue decision, not a type flip. CAFE <-> RESTAURANT
 *     (both food: menus, no stock) and non-food <-> non-food are allowed;
 *   - dry run unless `apply` is set; the outcome reports the before/after
 *     counts so nothing removed or duplicated goes unnoticed.
 */

import { isFoodSellerType, SellerType } from '../../shared';
import { prisma, runInTransaction } from '../../infra/db/prisma';

export interface SellerTypeChange {
  code: string;
  from: SellerType;
  to: SellerType;
}

export interface SellerTypeChangeOutcome {
  code: string;
  status: 'WOULD_CHANGE' | 'CHANGED' | 'ALREADY_DONE' | 'NOT_FOUND' | 'UNEXPECTED_TYPE' | 'REFUSED';
  currentType: SellerType | null;
  detail: string;
  counts?: { listings: number; categories: number; sellerOrders: number; products: number };
}

async function countsFor(sellerId: string) {
  const [listings, categories, sellerOrders, products] = await Promise.all([
    prisma.sellerListing.count({ where: { sellerId } }),
    prisma.category.count({ where: { sellerId } }),
    prisma.sellerOrder.count({ where: { sellerId } }),
    prisma.product.count({ where: { category: { sellerId } } }),
  ]);
  return { listings, categories, sellerOrders, products };
}

export async function changeSellerType(
  change: SellerTypeChange,
  options: { apply: boolean; reason: string },
): Promise<SellerTypeChangeOutcome> {
  const base = { code: change.code };
  if (isFoodSellerType(change.from) !== isFoodSellerType(change.to)) {
    return {
      ...base,
      status: 'REFUSED',
      currentType: null,
      detail: `${change.from} -> ${change.to} crosses food / non-food: the seller's category tree would change meaning (menu vs catalogue).`,
    };
  }

  const seller = await prisma.seller.findUnique({ where: { code: change.code }, select: { id: true, sellerType: true, deletedAt: true } });
  if (!seller || seller.deletedAt) return { ...base, status: 'NOT_FOUND', currentType: null, detail: 'No live seller has this exact code.' };
  const counts = await countsFor(seller.id);
  if (seller.sellerType === change.to) {
    return { ...base, status: 'ALREADY_DONE', currentType: seller.sellerType, detail: `Already ${change.to}.`, counts };
  }
  if (seller.sellerType !== change.from) {
    return {
      ...base,
      status: 'UNEXPECTED_TYPE',
      currentType: seller.sellerType,
      detail: `Expected ${change.from}, found ${seller.sellerType} — nothing changed.`,
      counts,
    };
  }
  if (!options.apply) {
    return { ...base, status: 'WOULD_CHANGE', currentType: seller.sellerType, detail: `Would change ${change.from} -> ${change.to}.`, counts };
  }

  const changed = await runInTransaction(async (tx) => {
    const { count } = await tx.seller.updateMany({
      where: { id: seller.id, sellerType: change.from, deletedAt: null },
      data: { sellerType: change.to },
    });
    if (count === 1) {
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: 'seller.type_change',
          entityType: 'Seller',
          entityId: seller.id,
          before: { sellerType: change.from },
          after: { sellerType: change.to, code: change.code, reason: options.reason },
        },
      });
    }
    return count === 1;
  });
  const after = await countsFor(seller.id);
  return changed
    ? { ...base, status: 'CHANGED', currentType: change.to, detail: `Changed ${change.from} -> ${change.to}.`, counts: after }
    : { ...base, status: 'UNEXPECTED_TYPE', currentType: null, detail: 'The type changed concurrently — nothing written.', counts: after };
}
