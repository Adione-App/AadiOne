/**
 * Store availability for customers — two INDEPENDENT layers, one source of
 * truth each:
 *
 *   1. App-wide ordering — platform/platform-availability.ts: the master
 *      switch (ORDERING_ENABLED), the emergency closure, pauses, holidays and
 *      the app-wide weekly hours, in that order. Closed: customers keep
 *      browsing and filling their cart, but no order and no payment start is
 *      accepted. It never changes any store's own state.
 *   2. Each seller's availability — seller.service.ts's
 *      `evaluateSellerAvailability`, unchanged: deleted / admin-inactive
 *      (`Seller.isActive`, admin only) > the seller's own switch
 *      (`isAcceptingOrders`, seller only) > date closure > weekly hours, in the
 *      seller's own timezone. An admin deactivation therefore always wins: the
 *      seller's switch cannot reopen a store the admin closed.
 *
 * This module only reads them — for many sellers at once (catalogue, Home,
 * cart) without a query per seller — and turns them into what a customer is
 * shown. Nothing here is cached: every call reads the current state.
 */

import { ErrorCode, type PlatformClosedReason } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { getZonedParts } from '../../shared/datetime';
import { getPlatformAvailability } from '../platform/platform-availability.service';
import {
  closureKey,
  evaluateSellerAvailability,
  sellerClosedMessage,
  type AvailabilityClosedReason,
  type SellerWithHours,
} from './seller.service';

/* -------------------------------------------------------------------------- */
/* Layer 1 — app-wide ordering                                               */
/* -------------------------------------------------------------------------- */

export const DEFAULT_ORDERING_PAUSED_MESSAGE =
  'Ordering is paused right now. You can keep browsing and adding items to your cart.';

export interface OrderingState {
  enabled: boolean;
  /** What Home and Cart show while closed (with the reopening time when known); null while open. */
  message: string | null;
  /** Why, when closed (GLOBAL_DISABLED, HOLIDAY_CLOSURE, OUTSIDE_OPERATING_HOURS, …). */
  reasonCode: PlatformClosedReason | null;
}

/** App-wide ordering right now — the one global rule (platform-availability.ts). */
export async function orderingState(): Promise<OrderingState> {
  const availability = await getPlatformAvailability();
  if (availability.acceptingOrders) return { enabled: true, message: null, reasonCode: null };
  return { enabled: false, message: availability.message ?? DEFAULT_ORDERING_PAUSED_MESSAGE, reasonCode: availability.reasonCode };
}

/** Refuses any new order or payment start while the app is not taking orders. */
export async function assertOrderingEnabled(): Promise<void> {
  const state = await orderingState();
  if (state.enabled) return;
  throw new AppError(ErrorCode.ORDERING_PAUSED, {
    message: state.message ?? DEFAULT_ORDERING_PAUSED_MESSAGE,
    internalMessage: `app-wide ordering closed: ${state.reasonCode}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Layer 2 — sellers, in batches                                             */
/* -------------------------------------------------------------------------- */

export interface StoreStatus {
  /** An order from this seller may be placed right now. */
  acceptingOrders: boolean;
  closedReason: AvailabilityClosedReason | null;
  /** The sentence a customer sees while it is not accepting orders; null while it is. */
  message: string | null;
  nextOpenText: string | null;
}

/**
 * Every given seller's status, evaluated by THE rule with its date closures
 * loaded in one query. Duplicates are fine (each seller is evaluated once).
 */
export async function storeStatuses(
  sellers: Iterable<SellerWithHours>,
  now: Date = new Date(),
): Promise<Map<string, StoreStatus>> {
  const unique = [...new Map([...sellers].map((seller) => [seller.id, seller])).values()];
  if (unique.length === 0) return new Map();

  // Each seller's "today" is its own local date; asking for the closures of
  // every date any of them is on covers all of them.
  const localDates = [
    ...new Set(
      unique.map((seller) => {
        const parts = getZonedParts(now, seller.timezone);
        return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toISOString();
      }),
    ),
  ].map((iso) => new Date(iso));
  const closureRows = await prisma.sellerClosure.findMany({
    where: { sellerId: { in: unique.map((seller) => seller.id) }, closedOn: { in: localDates } },
    select: { sellerId: true, closedOn: true },
  });
  const closures = new Set(closureRows.map((row) => closureKey(row.sellerId, row.closedOn)));

  const evaluated = await Promise.all(
    unique.map(async (seller) => {
      const availability = await evaluateSellerAvailability(seller, now, { closures });
      const status: StoreStatus = {
        acceptingOrders: availability.acceptingOrders,
        closedReason: availability.closedReason,
        message: availability.acceptingOrders ? null : sellerClosedMessage(seller.name, availability),
        nextOpenText: availability.nextOpenText,
      };
      return [seller.id, status] as const;
    }),
  );
  return new Map(evaluated);
}

/** Every not-deleted seller's status (the catalogue's sellers are among them). */
export async function allStoreStatuses(now: Date = new Date()): Promise<Map<string, StoreStatus>> {
  const sellers = await prisma.seller.findMany({
    where: { deletedAt: null },
    include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
  });
  return storeStatuses(sellers, now);
}

/** Ids of the sellers taking orders right now — Home only shows their products. */
export function acceptingSellerIds(statuses: ReadonlyMap<string, StoreStatus>): string[] {
  return [...statuses].filter(([, status]) => status.acceptingOrders).map(([sellerId]) => sellerId);
}

/** A seller missing from a status map (deleted meanwhile) is treated as closed — never as open. */
export function statusOf(statuses: ReadonlyMap<string, StoreStatus>, sellerId: string): StoreStatus {
  return (
    statuses.get(sellerId) ?? {
      acceptingOrders: false,
      closedReason: 'SELLER_DELETED',
      message: 'This store is not available right now.',
      nextOpenText: null,
    }
  );
}
