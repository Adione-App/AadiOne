/**
 * The "how far" sentence for a location the app does not deliver to — pure,
 * so it is unit-tested (tests/deliveryArea.test.ts).
 *
 * The server decides serviceability (GET /store/serviceability: the nearest
 * store's straight-line distance and that store's radius). Distance is only
 * mentioned when it IS the reason: a point inside the radius can still be
 * refused (outside Rajasthan, a PIN code not served), and then the generic
 * sentence is all that is true.
 */

interface DeliveryAreaFacts {
  serviceable: boolean;
  /** Straight-line km to the nearest store (already rounded up by the server). */
  distanceKm: number;
  /** That store's delivery radius in km. */
  maxRadiusKm: number;
}

/** One decimal, rounded up — a shown distance never understates the real one. */
export function formatKm(km: number): string {
  const rounded = Math.ceil(km * 10 - 1e-9) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "The nearest store is about 14.3 km away — stores deliver up to 12 km." or null. */
export function outOfAreaDetail(facts: DeliveryAreaFacts | null | undefined): string | null {
  if (!facts || facts.serviceable) return null;
  const { distanceKm, maxRadiusKm } = facts;
  if (!Number.isFinite(distanceKm) || !Number.isFinite(maxRadiusKm) || maxRadiusKm <= 0) return null;
  if (distanceKm <= maxRadiusKm) return null;
  return `The nearest store is about ${formatKm(distanceKm)} km away — stores deliver up to ${formatKm(maxRadiusKm)} km (straight line).`;
}
