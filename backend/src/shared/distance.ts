/**
 * Distance, serviceability and ETA — the three reusable functions required by
 * the spec (§57) and specified in PRD §15.
 *
 * These are pure functions with no I/O so they can be shared by the server and
 * both clients. The SERVER remains the sole authority: clients may call these
 * to *display* "3.2 km away", but the server recomputes and decides at every
 * meaningful step (app open, address save, checkout, order creation).
 */

import type { DeliveryFeeSlab } from './config-keys';

/** Mean Earth radius in km (IUGG). */
const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export function isValidLatitude(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidLongitude(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

export function isValidCoordinates(lat: number, lng: number): boolean {
  return isValidLatitude(lat) && isValidLongitude(lng);
}

/** A generous box around India (incl. A&N, Lakshadweep, the north-east). */
export const INDIA_BOUNDS = { minLat: 6.0, maxLat: 37.6, minLng: 68.0, maxLng: 97.5 } as const;

export function isInIndia(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= INDIA_BOUNDS.minLat &&
    lat <= INDIA_BOUNDS.maxLat &&
    lng >= INDIA_BOUNDS.minLng &&
    lng <= INDIA_BOUNDS.maxLng
  );
}

export type CoordinateProblem = 'MISSING' | 'SWAPPED' | 'OUT_OF_RANGE' | 'NULL_ISLAND' | 'OUTSIDE_INDIA';

/** What is wrong with a latitude / longitude pair — null when usable. */
export function coordinateProblem(
  lat: unknown,
  lng: unknown,
  options: {
    /** Saved addresses and store locations must be in India (every address here is an Indian one). */
    requireIndia?: boolean;
  } = {},
): CoordinateProblem | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return 'MISSING';
  // Latitude and longitude passed the wrong way round: only in India is the
  // swapped pair unmistakable (India's longitudes are not valid latitudes there).
  if (!isInIndia(lat, lng) && isInIndia(lng, lat)) return 'SWAPPED';
  if (!isValidCoordinates(lat, lng)) return 'OUT_OF_RANGE';
  // (0, 0) is what a failed geolocation call produces, never a real address.
  if (lat === 0 && lng === 0) return 'NULL_ISLAND';
  if (options.requireIndia && !isInIndia(lat, lng)) return 'OUTSIDE_INDIA';
  return null;
}

export const COORDINATE_PROBLEM_MESSAGE: Record<CoordinateProblem, string> = {
  MISSING: 'The location is missing. Set it again.',
  SWAPPED: 'Latitude and longitude look swapped. Enter the latitude first (about 8 to 37 in India), then the longitude (about 68 to 97).',
  OUT_OF_RANGE: 'That location is not valid: latitude must be between -90 and 90 and longitude between -180 and 180.',
  NULL_ISLAND: 'That location (0, 0) is not a real address. Set the location again.',
  OUTSIDE_INDIA: 'That location is outside India. Check the latitude and longitude.',
};

export const metresToKm = (metres: number): number => metres / 1000;
export const kmToMetres = (km: number): number => km * 1000;

/**
 * Great-circle (straight-line) distance in kilometres, unrounded — the value
 * every decision (radius, slabs) must be taken on.
 */
export function distanceKmExact(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Rounds a distance UP to 10 m: a reported distance never understates the real one. */
export function roundUpKm(km: number): number {
  // The epsilon (1e-6 of a 10 m step, ~0.01 mm) keeps float noise such as
  // 2.0000000001 from becoming 2.01.
  // max(0, …): a zero distance stays +0, never -0.
  return Math.max(0, Math.ceil(km * 100 - 1e-6)) / 100;
}

/**
 * Great-circle (straight-line) distance in kilometres, rounded to 2 decimals.
 *
 * Haversine is used rather than a routing API because it needs no network
 * call, no API key and no rate limit, and because the serviceability promise
 * we make to customers ("we deliver up to 10 km from our store") is itself a
 * straight-line statement.
 */
export function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  return Math.round(distanceKmExact(lat1, lng1, lat2, lng2) * 100) / 100;
}

export interface ServiceabilityCheck {
  serviceable: boolean;
  distanceKm: number;
}

/**
 * The signature required by the spec.
 *
 * `maxRadiusKm` is supplied by the caller from Configuration
 * (`MAX_SERVICE_RADIUS_KM`) — it is never defaulted here, so there is no way
 * for a stale hardcoded radius to creep in.
 */
export function checkServiceability(
  userLatitude: number,
  userLongitude: number,
  storeLatitude: number,
  storeLongitude: number,
  maxRadiusKm: number,
): ServiceabilityCheck {
  // Decide on the EXACT distance (rounding first let 10.004 km pass a 10 km
  // radius), and report it rounded UP, so the shown distance and the decision
  // always agree: inside the radius never shows more than the radius, outside
  // never shows less.
  const exactKm = distanceKmExact(userLatitude, userLongitude, storeLatitude, storeLongitude);
  return { serviceable: exactKm <= maxRadiusKm, distanceKm: roundUpKm(exactKm) };
}

/**
 * Converts straight-line distance to an estimate of the actual ride.
 *
 * Roads are not straight. Applying this factor to ETA and delivery fee — but
 * NOT to the serviceability boundary — is deliberate: a customer 9.8 km away
 * in a straight line is inside our promise, but is a ~13 km ride and must be
 * priced and promised accordingly.
 */
export function toRoadDistanceKm(straightLineKm: number, roadDistanceFactor: number): number {
  return Math.round(straightLineKm * roadDistanceFactor * 100) / 100;
}

export interface EtaInput {
  distanceKm: number;
  itemCount: number;
  /** Orders currently between STORE_ACCEPTED and OUT_FOR_DELIVERY. */
  activeOrderCount: number;
  roadDistanceFactor: number;
  basePreparationMinutes: number;
  perItemPickSeconds: number;
  avgDeliverySpeedKmph: number;
  ordersPerRiderBatch: number;
  batchDelayMinutes: number;
  etaBufferMinutes: number;
}

export interface EtaResult {
  etaMinutes: number;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  breakdown: {
    preparationMinutes: number;
    travelMinutes: number;
    workloadMinutes: number;
    bufferMinutes: number;
    roadDistanceKm: number;
  };
}

/**
 * Estimated delivery time.
 *
 *   prep    = base + (items x perItemPickSeconds)
 *   travel  = roadKm / speed
 *   load    = ceil(activeOrders / batchSize) x batchDelay
 *   eta     = prep + travel + load + buffer
 *
 * Displayed as a 10-minute band rounded to the nearest 5 ("20–25 mins"),
 * because a single precise number invites a complaint when it slips by 90
 * seconds.
 */
export function estimateDeliveryTime(input: EtaInput): EtaResult {
  const roadDistanceKm = toRoadDistanceKm(input.distanceKm, input.roadDistanceFactor);

  const preparationMinutes =
    input.basePreparationMinutes + (input.itemCount * input.perItemPickSeconds) / 60;

  const travelMinutes =
    input.avgDeliverySpeedKmph > 0 ? (roadDistanceKm / input.avgDeliverySpeedKmph) * 60 : 0;

  const workloadMinutes =
    input.ordersPerRiderBatch > 0
      ? Math.floor(input.activeOrderCount / input.ordersPerRiderBatch) * input.batchDelayMinutes
      : 0;

  const raw = preparationMinutes + travelMinutes + workloadMinutes + input.etaBufferMinutes;
  const etaMinutes = Math.max(5, Math.round(raw / 5) * 5);

  return {
    etaMinutes,
    etaMinMinutes: Math.max(5, etaMinutes - 5),
    etaMaxMinutes: etaMinutes + 5,
    breakdown: {
      preparationMinutes: Math.round(preparationMinutes * 10) / 10,
      travelMinutes: Math.round(travelMinutes * 10) / 10,
      workloadMinutes,
      bufferMinutes: input.etaBufferMinutes,
      roadDistanceKm,
    },
  };
}

/**
 * Delivery fee for a distance, from the configured slabs.
 * The first slab whose `maxKm` covers the road distance wins; beyond the last
 * slab the last slab's fee applies (the address would not be serviceable
 * anyway, so this is only a safety net).
 */
export function resolveDeliveryFeePaise(
  roadDistanceKm: number,
  slabs: readonly DeliveryFeeSlab[],
): number {
  if (slabs.length === 0) return 0;
  const sorted = [...slabs].sort((a, b) => a.maxKm - b.maxKm);
  const match = sorted.find((slab) => roadDistanceKm <= slab.maxKm);
  return (match ?? sorted[sorted.length - 1]!).feePaise;
}

/**
 * "3.2 km" / "800 m" — a STRAIGHT-LINE distance for display. Under 1 km it is
 * shown to 10 m (GPS and pins are not metre-accurate); from 1 km to 0.1 km.
 * Use formatStraightLineDistance where the reader could mistake it for a ride.
 */
export function formatDistance(distanceKm: number): string {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return '—';
  if (distanceKm < 0.01) return 'under 10 m';
  if (distanceKm < 1) return `${Math.round((distanceKm * 1000) / 10) * 10} m`;
  return `${distanceKm.toFixed(1)} km`;
}

/** "3.2 km (straight line)" — not the road distance a rider travels. */
export function formatStraightLineDistance(distanceKm: number): string {
  return `${formatDistance(distanceKm)} (straight line)`;
}

/** "20–25 mins" — the ETA band. */
export function formatEtaRange(minMinutes: number, maxMinutes: number): string {
  if (minMinutes === maxMinutes) return `${minMinutes} mins`;
  return `${minMinutes}–${maxMinutes} mins`;
}
