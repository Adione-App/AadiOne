import type { Prisma, Seller, SellerHours } from '@prisma/client';
import { ACTIVE_ORDER_STATUSES } from '../../shared';
import { prisma, type DbClient } from '../../infra/db/prisma';

export type SellerWithHours = Seller & { hours: SellerHours[] };

/**
 * A seller customers can see: not deleted, switched on by admin, onboarding
 * approved — the same "trading" gate orderability uses
 * (cart/orderability.ts). V2 has no special store: every seller, Aadione
 * included, is one of these rows and is found the same way.
 */
export const LIVE_SELLER_WHERE = {
  deletedAt: null,
  isActive: true,
  onboardingStatus: 'APPROVED',
} as const satisfies Prisma.SellerWhereInput;

/** Every live seller, with hours — for serviceability (who can deliver here?). */
export async function findLiveSellers(client: DbClient = prisma): Promise<SellerWithHours[]> {
  return client.seller.findMany({
    where: LIVE_SELLER_WHERE,
    include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
}

/** The given sellers with hours, in no particular order (missing ids are skipped). */
export async function findSellersByIds(
  ids: readonly string[],
  client: DbClient = prisma,
): Promise<SellerWithHours[]> {
  if (ids.length === 0) return [];
  return client.seller.findMany({
    where: { id: { in: [...new Set(ids)] } },
    include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
  });
}

export async function findSellerById(
  id: string,
  client: DbClient = prisma,
): Promise<SellerWithHours | null> {
  return client.seller.findUnique({
    where: { id },
    include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
  });
}

/** True when the seller has an explicit closure recorded for a local date. */
export async function hasClosureOn(
  sellerId: string,
  localDate: Date,
  client: DbClient = prisma,
): Promise<boolean> {
  const closure = await client.sellerClosure.findUnique({
    where: { sellerId_closedOn: { sellerId, closedOn: localDate } },
    select: { id: true },
  });
  return closure !== null;
}

/**
 * Orders the seller is actively working on. Feeds the workload term in the
 * ETA, so a busy shop quotes a longer time instead of a promise it cannot
 * keep. Counts by the PARENT order's aggregate status — see
 * `SellerOrder`-level equivalents in order.service.ts for a single seller's
 * own precise workload once cross-seller ETA is built.
 */
export async function countActiveOrders(
  sellerId: string,
  client: DbClient = prisma,
): Promise<number> {
  return client.sellerOrder.count({
    where: {
      sellerId,
      order: { status: { in: [...ACTIVE_ORDER_STATUSES] } },
    },
  });
}
