/**
 * Rajasthan-only service area — the server's authoritative state check.
 *
 * Aadione operates only in Rajasthan. A delivery destination (saved address
 * or live location) and a seller's store point are eligible only when BOTH:
 *
 *   1. the state given is Rajasthan, and
 *   2. the POINT lies inside Rajasthan's boundary (rajasthan-boundary.ts),
 *      at least BORDER_MARGIN_KM from it.
 *
 * The state text alone is never trusted — the phone's reverse geocoder and
 * whatever a client sends can be wrong or forged — so the coordinates are
 * checked against boundary data held on the server. A point inside the
 * margin cannot be placed reliably (≈111 m simplification plus the source
 * data's own precision) and FAILS SAFE: it is refused, never assumed to be in
 * Rajasthan. The seller radius check still applies on top of this.
 *
 * Existing out-of-state records are never rewritten: they are reported as
 * ineligible and refused for new orders.
 */

import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';
import { RAJASTHAN_BOUNDARY } from './rajasthan-boundary';

export const SERVICE_STATE = 'Rajasthan';

/** Refuse points this close to the boundary: their side cannot be confirmed. */
export const BORDER_MARGIN_KM = 0.5;

/** "Rajasthan" in any case, or its Devanagari name — normalised to the official spelling. */
export function normalizeServiceState(state: string | null | undefined): string | null {
  const text = state?.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.toLowerCase() === 'rajasthan' || text === 'राजस्थान' ? SERVICE_STATE : null;
}

const EARTH_KM_PER_DEG = 111.195;

/** Ray casting on the boundary ring (lng = x, lat = y). */
function insideBoundary(latitude: number, longitude: number): boolean {
  const ring = RAJASTHAN_BOUNDARY;
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!, yi = ring[i + 1]!, xj = ring[j]!, yj = ring[j + 1]!;
    if (yi > latitude !== yj > latitude && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance (km) from the point to the boundary line — local equirectangular projection. */
function distanceToBoundaryKm(latitude: number, longitude: number): number {
  const ring = RAJASTHAN_BOUNDARY;
  const kx = Math.cos((latitude * Math.PI) / 180) * EARTH_KM_PER_DEG;
  const ky = EARTH_KM_PER_DEG;
  const px = longitude * kx;
  const py = latitude * ky;
  let best = Infinity;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const ax = ring[i]! * kx, ay = ring[i + 1]! * ky, bx = ring[i + 2]! * kx, by = ring[i + 3]! * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

export type ServiceStateProblem = 'STATE_NOT_SERVED' | 'OUTSIDE_STATE' | 'NEAR_BORDER';

/** Null when eligible; otherwise why not. Coordinates must already be valid (see coordinateProblem). */
export function serviceStateProblem(input: { state: string | null | undefined; latitude: number; longitude: number }): ServiceStateProblem | null {
  if (!normalizeServiceState(input.state)) return 'STATE_NOT_SERVED';
  if (!insideBoundary(input.latitude, input.longitude)) return 'OUTSIDE_STATE';
  if (distanceToBoundaryKm(input.latitude, input.longitude) < BORDER_MARGIN_KM) return 'NEAR_BORDER';
  return null;
}

/** The point alone (no state text) — for "do we deliver here?" lookups by coordinates. */
export function pointInServiceState(latitude: number, longitude: number): boolean {
  return serviceStateProblem({ state: SERVICE_STATE, latitude, longitude }) === null;
}

const MESSAGE: Record<ServiceStateProblem, Record<'destination' | 'store', string>> = {
  STATE_NOT_SERVED: {
    destination: 'Aadione currently delivers only in Rajasthan. Choose a delivery address in Rajasthan.',
    store: 'Aadione currently operates only in Rajasthan. The store address must be in Rajasthan.',
  },
  OUTSIDE_STATE: {
    destination: 'Aadione currently delivers only in Rajasthan, and this location is outside Rajasthan.',
    store: 'Aadione currently operates only in Rajasthan, and this store location is outside Rajasthan.',
  },
  NEAR_BORDER: {
    destination:
      'Aadione currently delivers only in Rajasthan. This location is too close to the state border for us to confirm it is in Rajasthan.',
    store:
      'Aadione currently operates only in Rajasthan. This store location is too close to the state border to confirm it is in Rajasthan.',
  },
};

/** Throws OUTSIDE_SERVICE_STATE (422) unless the state AND the point are in Rajasthan. */
export function assertServiceState(
  input: { state: string | null | undefined; latitude: number; longitude: number },
  subject: 'destination' | 'store' = 'destination',
): void {
  const problem = serviceStateProblem(input);
  if (problem) {
    const message = MESSAGE[problem][subject];
    throw new AppError(ErrorCode.OUTSIDE_SERVICE_STATE, { message, details: [{ field: 'state', message, reason: problem }] });
  }
}
