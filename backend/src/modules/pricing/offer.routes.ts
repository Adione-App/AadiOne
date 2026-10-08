import { Router, type Request, type Response } from 'express';
import { asyncHandler, ok } from '../../common/response';
import * as service from './offer.service';

/**
 * Public, like the catalogue: a customer can see today's codes before
 * signing in. Whether a code still works for THEM (per-user limits) is
 * decided when it is applied to a cart.
 */
export const offerRouter: Router = Router();

offerRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.listPublicOffers());
  }),
);
