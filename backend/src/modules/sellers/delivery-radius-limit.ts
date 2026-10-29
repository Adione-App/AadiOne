/**
 * The largest delivery radius anyone may configure, in kilometres — for the
 * app-wide MAX_SERVICE_RADIUS_KM and for a seller's own override alike.
 *
 * Aadione delivers hyperlocally (about 10–12 km). The limit only stops a slip
 * of the keyboard (120 for 12) from opening a whole district to one shop; it
 * is not a business rule, which stays the configured radius itself.
 *
 * A leaf module so the configuration service can use it without importing
 * the seller services (which import configuration).
 */
export const DELIVERY_RADIUS_LIMIT_KM = 50;

/** A usable radius: a finite number of km above zero and within the limit. */
export function isValidDeliveryRadiusKm(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= DELIVERY_RADIUS_LIMIT_KM;
}
