import type { Request, Response } from 'express';
import { ok } from '../../common/response';
import { validatedQuery } from '../../middleware/validate';
import { getLocationServiceability } from './location-serviceability.service';
import { listActiveDeliveryLocations } from '../addresses/delivery-locations';
import type { ServiceabilityQuery } from './seller.validation';

/**
 * GET /store/serviceability?lat=&lng=
 *
 * Called on app open and whenever the customer changes location. Answers
 * "does any seller deliver here, and how far is the nearest" and drives the
 * "Sorry, we don't deliver here" screen — with one status per reason
 * (location-serviceability.service.ts). (The path keeps its historical
 * `/store` prefix for the shipped app; there is no single store behind it.)
 */
export async function getServiceability(req: Request, res: Response): Promise<void> {
  const { lat, lng, village, pincode } = validatedQuery<ServiceabilityQuery>(req);
  const place = village || pincode ? { village: village ?? null, pincode: pincode ?? null } : null;
  ok(res, await getLocationServiceability(lat, lng, new Date(), place));
}

/**
 * GET /store/delivery-locations — the admin-approved villages and each one's
 * PIN codes (active pairs only), for the app's address dropdowns. Public: a
 * guest's live location is matched against it too.
 */
export async function getDeliveryLocations(_req: Request, res: Response): Promise<void> {
  ok(res, await listActiveDeliveryLocations());
}
