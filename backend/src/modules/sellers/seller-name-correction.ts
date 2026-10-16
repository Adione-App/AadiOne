/**
 * Controlled correction of a misspelled seller display name (there is no
 * admin or seller screen that renames an approved seller). Used by
 * scripts/correct-seller-name.ts.
 *
 * The corrections are a reviewed, committed allow-list keyed by the seller's
 * exact CODE — no free-text names on the command line (Windows `npm run`
 * splits arguments on spaces and drops quotes), and nothing else can be
 * renamed by accident.
 *
 * What it changes, for that one seller only, and only from the exact old text:
 *   - `sellers.name` (the name customers, admin and the seller see);
 *   - the seller's OWN categories (for a restaurant: menus / sections) whose
 *     name is exactly the old text — e.g. a menu named after the restaurant.
 *     Only the label changes: id, slug, path, parent, items and order stay.
 * What it never touches: the seller code, id, type, products, listings,
 * prices, orders, staff, images, the KYC profile's registered business name
 * (a legal record), notifications and audit history (records of the past).
 *
 * Dry run unless `apply`; idempotent (a re-run finds the new name and changes
 * nothing); one audit row per applied correction.
 */

import { prisma, runInTransaction } from '../../infra/db/prisma';

export const SELLER_NAME_CORRECTIONS: Readonly<Record<string, { from: string; to: string }>> = {
  // Requested 2026-10-17: "Kichen" is a misspelling of "Kitchen".
  NEPALIKICHEN: { from: 'Nepali Kichen', to: 'Nepali Kitchen' },
};

export interface SellerNameCorrectionOutcome {
  code: string;
  status: 'WOULD_CHANGE' | 'CHANGED' | 'ALREADY_DONE' | 'NOT_FOUND' | 'UNEXPECTED_NAME' | 'NO_CORRECTION';
  detail: string;
  sellerName: string | null;
  /** Seller-owned categories carrying the old (or, when done, the new) name. */
  categories: { id: string; name: string; depth: number }[];
}

export async function correctSellerName(code: string, options: { apply: boolean }): Promise<SellerNameCorrectionOutcome> {
  const correction = SELLER_NAME_CORRECTIONS[code];
  if (!correction) {
    return { code, status: 'NO_CORRECTION', detail: 'No reviewed correction exists for this seller code.', sellerName: null, categories: [] };
  }
  const seller = await prisma.seller.findUnique({ where: { code }, select: { id: true, name: true, deletedAt: true } });
  if (!seller || seller.deletedAt) {
    return { code, status: 'NOT_FOUND', detail: 'No live seller has this exact code.', sellerName: null, categories: [] };
  }

  const misnamed = await prisma.category.findMany({
    where: { sellerId: seller.id, deletedAt: null, name: correction.from },
    select: { id: true, name: true, depth: true },
    orderBy: { depth: 'asc' },
  });
  const short = (rows: typeof misnamed) => rows.map((c) => ({ ...c, id: `${c.id.slice(0, 8)}…` }));

  if (seller.name === correction.to && misnamed.length === 0) {
    const corrected = await prisma.category.findMany({
      where: { sellerId: seller.id, deletedAt: null, name: correction.to },
      select: { id: true, name: true, depth: true },
    });
    return { code, status: 'ALREADY_DONE', detail: `Already "${correction.to}".`, sellerName: seller.name, categories: short(corrected) };
  }
  if (seller.name !== correction.from && seller.name !== correction.to) {
    return {
      code,
      status: 'UNEXPECTED_NAME',
      detail: `Expected the name "${correction.from}", found "${seller.name}" — nothing changed.`,
      sellerName: seller.name,
      categories: short(misnamed),
    };
  }
  if (!options.apply) {
    return {
      code,
      status: 'WOULD_CHANGE',
      detail: `Would rename "${correction.from}" -> "${correction.to}" (seller${seller.name === correction.from ? '' : ': already done'}; ${misnamed.length} category label(s)).`,
      sellerName: seller.name,
      categories: short(misnamed),
    };
  }

  await runInTransaction(async (tx) => {
    const renamedSeller = await tx.seller.updateMany({
      where: { id: seller.id, name: correction.from, deletedAt: null },
      data: { name: correction.to },
    });
    const renamedCategories = await tx.category.updateMany({
      where: { id: { in: misnamed.map((c) => c.id) }, sellerId: seller.id, name: correction.from },
      data: { name: correction.to },
    });
    if (renamedSeller.count + renamedCategories.count > 0) {
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: 'seller.name_correction',
          entityType: 'Seller',
          entityId: seller.id,
          before: { name: correction.from },
          after: {
            code,
            name: correction.to,
            sellerRenamed: renamedSeller.count === 1,
            categoryIds: misnamed.map((c) => c.id),
          },
        },
      });
    }
  });

  const after = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id }, select: { name: true } });
  return {
    code,
    status: 'CHANGED',
    detail: `Renamed "${correction.from}" -> "${correction.to}".`,
    sellerName: after.name,
    categories: short(misnamed).map((c) => ({ ...c, name: correction.to })),
  };
}
