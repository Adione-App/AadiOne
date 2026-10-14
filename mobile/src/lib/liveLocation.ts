/**
 * Live-location delivery (order to the GPS point the customer is at, without
 * saving an address): the state rules and display text shared by the
 * delivery-details form, Select Location and checkout.
 *
 * STATE. Aadione operates only in Rajasthan. A live point's state is never
 * silently rewritten:
 *   - the geocoder named a state → that state; anything but Rajasthan is
 *     refused in the app with a clear message;
 *   - it named none, and the point is inside Rajasthan's bounding box →
 *     Rajasthan (provisionally);
 *   - it named none, and the point is outside that box → no state: refused.
 * The SERVER is the authority: it checks the point against Rajasthan's
 * actual boundary (backend service-state.ts) and the seller radius, whatever
 * the app sends. This file only spares the customer a doomed attempt.
 */

import { INDIAN_STATES } from '@shared/address';
import type { LiveLocationInput } from '@shared';

export const HOME_STATE = 'Rajasthan';

/** Generous outline of Rajasthan — only used to avoid asserting "Rajasthan" for a point clearly elsewhere. */
const RAJASTHAN_BOUNDS = { minLat: 23.0, maxLat: 30.2, minLng: 69.4, maxLng: 78.3 } as const;

export function isPlausiblyInRajasthan(latitude: number, longitude: number): boolean {
  return (
    latitude >= RAJASTHAN_BOUNDS.minLat &&
    latitude <= RAJASTHAN_BOUNDS.maxLat &&
    longitude >= RAJASTHAN_BOUNDS.minLng &&
    longitude <= RAJASTHAN_BOUNDS.maxLng
  );
}

/** Device geocoders may answer in Hindi; only the home state is mapped (others keep their own text). */
const STATE_ALIASES: Record<string, string> = { राजस्थान: HOME_STATE };

/** The geocoder's state as the official name when it is one, else its own text; null when absent. */
export function stateFromGeocoder(state: string | null | undefined): string | null {
  const text = state?.trim();
  if (!text) return null;
  const alias = STATE_ALIASES[text];
  if (alias) return alias;
  return INDIAN_STATES.find((name) => name.toLowerCase() === text.toLowerCase()) ?? text;
}

export const isHomeState = (state: string) => state.trim().toLowerCase() === HOME_STATE.toLowerCase();

/** A live point's state per the rules above; '' when it cannot be placed in Rajasthan. */
export function liveState(geocodedState: string | null | undefined, latitude: number, longitude: number): string {
  return stateFromGeocoder(geocodedState) ?? (isPlausiblyInRajasthan(latitude, longitude) ? HOME_STATE : '');
}

/** Short header label for Home / Select Location: "Shastri Nagar, Sikar". */
export function liveLocationLabel(destination: Pick<LiveLocationInput, 'area' | 'city'>): string {
  return [destination.area, destination.city].filter((part) => part && part.trim()).join(', ') || 'Current location';
}

/** True when `live` is the destination for exactly this chosen GPS point. */
export function isActiveLiveDestination(
  live: LiveLocationInput | null,
  location: { latitude: number; longitude: number; source: string } | null,
): live is LiveLocationInput {
  return !!live && !!location && location.source === 'GPS' && live.latitude === location.latitude && live.longitude === location.longitude;
}
