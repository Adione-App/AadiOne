import type { Request, Response } from 'express';
import { ok } from '../../common/response';
import { validatedQuery } from '../../middleware/validate';
import * as sellerService from './seller.service';
import type { ServiceabilityQuery } from './seller.validation';

/**
 * GET /store/serviceability?lat=&lng=
 *
 * Called on app open and whenever the customer changes location. Answers
 * "does any seller deliver here, and how far is the nearest" and drives the
 * "Sorry, we don't deliver here" screen. (The path keeps its historical
 * `/store` prefix for the shipped app; there is no single store behind it.)
 */
export async function getServiceability(req: Request, res: Response): Promise<void> {
  const { lat, lng } = validatedQuery<ServiceabilityQuery>(req);
  ok(res, await sellerService.getServiceability(lat, lng));
}
