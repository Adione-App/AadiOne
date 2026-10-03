/**
 * How the seller panel groups its own orders — pure helpers, no I/O.
 *
 * A seller's work ends at READY_FOR_PICKUP (ALLOWED_SELLER_ORDER_TRANSITIONS);
 * what happens next is the PARENT order's delivery leg (READY_FOR_PICKUP ->
 * PICKED_UP -> OUT_FOR_DELIVERY -> DELIVERED). The seller panel reads that
 * leg only to tell "waiting for the rider" apart from "handed over" — it
 * never changes either status machine.
 */

import { OrderStatus, SellerOrderStatus } from '../../shared';
import { getTimeZoneOffsetMinutes, getZonedParts } from '../../shared/datetime';

/** Parent statuses once the rider has collected the goods. */
export const HANDED_OVER_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PICKED_UP,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

export type SellerOrderHandover = 'AWAITING_PICKUP' | 'PICKED_UP' | 'OUT_FOR_DELIVERY' | 'DELIVERED';

/** Where a READY_FOR_PICKUP seller order is in delivery; null for any other status. */
export function handoverOf(status: SellerOrderStatus, orderStatus: OrderStatus): SellerOrderHandover | null {
  if (status !== SellerOrderStatus.READY_FOR_PICKUP) return null;
  switch (orderStatus) {
    case OrderStatus.PICKED_UP:
      return 'PICKED_UP';
    case OrderStatus.OUT_FOR_DELIVERY:
      return 'OUT_FOR_DELIVERY';
    case OrderStatus.DELIVERED:
      return 'DELIVERED';
    default:
      return 'AWAITING_PICKUP';
  }
}

/**
 * The seller panel's grouped views on top of the plain status filter:
 *   READY      ready and still waiting for the rider
 *   COMPLETED  ready and handed over (picked up, on the way or delivered)
 *   CANCELLED  rejected by the seller or cancelled by anyone
 */
export const SELLER_ORDER_STAGES = ['READY', 'COMPLETED', 'CANCELLED'] as const;
export type SellerOrderStage = (typeof SELLER_ORDER_STAGES)[number];

export interface StageFilter {
  status: { in: SellerOrderStatus[] } | SellerOrderStatus;
  /** Extra condition on the parent order's status, if any. */
  orderStatus: { in: OrderStatus[] } | { notIn: OrderStatus[] } | null;
}

export function stageFilter(stage: SellerOrderStage): StageFilter {
  switch (stage) {
    case 'READY':
      return { status: SellerOrderStatus.READY_FOR_PICKUP, orderStatus: { notIn: [...HANDED_OVER_ORDER_STATUSES] } };
    case 'COMPLETED':
      return { status: SellerOrderStatus.READY_FOR_PICKUP, orderStatus: { in: [...HANDED_OVER_ORDER_STATUSES] } };
    case 'CANCELLED':
      return { status: { in: [SellerOrderStatus.REJECTED, SellerOrderStatus.CANCELLED] }, orderStatus: null };
  }
}

/**
 * A calendar day ("YYYY-MM-DD") in `timeZone` as a UTC instant range
 * [start, end). Used for the seller's "today" and the Orders date filter.
 */
export function zonedDayRange(day: string, timeZone: string): { start: Date; end: Date } {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const startOf = (y: number, m: number, d: number): Date => {
    const guess = Date.UTC(y, m - 1, d);
    // The zone's offset at that wall-clock midnight (two passes settle DST edges).
    let instant = guess - getTimeZoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
    instant = guess - getTimeZoneOffsetMinutes(new Date(instant), timeZone) * 60_000;
    return new Date(instant);
  };
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return {
    start: startOf(year, month, date),
    end: startOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

/** Today's calendar date ("YYYY-MM-DD") in `timeZone`. */
export function zonedToday(timeZone: string, now: Date = new Date()): string {
  const p = getZonedParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
