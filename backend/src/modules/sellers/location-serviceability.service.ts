/**
 * "Can I order HERE, now?" — the answer behind GET /store/serviceability for
 * the customer's current location (or a saved address they picked).
 *
 * THE SERVER DECIDES, from the point alone (nothing the app says about
 * distance or eligibility is read), with the existing sources of truth only:
 *
 *   delivery area       with the location's village + PIN (a saved address
 *                       or a confirmed live location): an ACTIVE admin-
 *                       approved pair (Configuration DELIVERY_LOCATIONS).
 *                       A bare GPS point (village unknown): the admin radius
 *                       around the service location, as a hint only
 *                       (seller.service `evaluateLocation`).
 *   store open / taking orders
 *                       each serving seller's availability (store-availability.ts)
 *   app-wide ordering   ORDERING_ENABLED, pauses, holidays, hours
 *                       (platform-availability via store-availability.ts)
 *
 * Sellers' own map points play no part, and no state is hardcoded. A PIN
 * code match alone never makes a point serviceable.
 *
 * The answer is DISPLAY: quote and order placement check the radius, every
 * cart seller's availability and app-wide ordering again for the exact
 * destination the order uses (order.service).
 */

import type { ServiceabilityResult, ServiceabilityStatus } from '../../shared';
import { evaluateLocation, type KnownPlace } from './seller.service';
import { orderingState, storeStatuses } from './store-availability';

/** The one sentence for a location Aadione does not deliver to (all three "outside" reasons). */
export const NOT_DELIVERING_MESSAGE =
  'Sorry! Aadione is currently not delivering to your location. We are working to expand our service area.';

const SCHEDULE_CLOSED = new Set(['CLOSURE', 'CLOSED_TODAY', 'OUTSIDE_HOURS']);

export async function getLocationServiceability(
  latitude: number,
  longitude: number,
  now: Date = new Date(),
  place: KnownPlace | null = null,
): Promise<ServiceabilityResult> {
  const { result, serving, outsideReason, outsideMessage } = await evaluateLocation(latitude, longitude, place);

  if (outsideReason) {
    return { ...result, status: outsideReason, message: outsideMessage ?? NOT_DELIVERING_MESSAGE, canOrder: false };
  }

  // In range. App-wide ordering first: while it is off nobody can order,
  // whichever store is open.
  const [ordering, statuses] = await Promise.all([orderingState(), storeStatuses(serving, now)]);
  if (!ordering.enabled) {
    return { ...result, status: 'ORDERING_DISABLED', message: ordering.message, canOrder: false };
  }

  const states = serving.map((seller) => statuses.get(seller.id)).filter((s) => s !== undefined);
  if (states.some((state) => state.acceptingOrders)) {
    return { ...result, status: 'AVAILABLE', message: null, canOrder: true };
  }

  // Nobody near is taking orders. Closed by the clock (hours, a closure day)
  // when any of them is — it reopens on its own; otherwise they are switched
  // off (by the seller), with no reopening time to promise.
  const scheduled = states.filter((state) => state.closedReason !== null && SCHEDULE_CLOSED.has(state.closedReason));
  const status: ServiceabilityStatus = scheduled.length > 0 ? 'STORE_CLOSED' : 'STORE_NOT_ACCEPTING';
  const nextOpen = scheduled.map((state) => state.nextOpenText).find((text) => !!text) ?? null;
  const message =
    status === 'STORE_CLOSED'
      ? `Stores near you are closed right now.${nextOpen ? ` ${nextOpen}.` : ''} You can keep browsing.`
      : 'Stores near you are not taking orders right now. You can keep browsing.';
  return { ...result, status, message, canOrder: false };
}
