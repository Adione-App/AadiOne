/**
 * Seller Panel — acceptance of the Seller Terms and Seller Privacy Policy
 * (seller-legal-consent.service.ts). Mounted in the /seller chain; reachable
 * in every lifecycle stage (seller-lifecycle-rules.ts), so applicants and
 * onboarding sellers accept too. Never cached.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../common/response';
import { requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import { validate } from '../../middleware/validate';
import * as consent from './seller-legal-consent.service';

export const sellerLegalRouter: Router = Router();

sellerLegalRouter.use('/legal', attachSellerContext);

sellerLegalRouter.get(
  '/legal/consent',
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await consent.getSellerConsentStatus(requireUser(req).id, requireSellerId(req)));
  }),
);

sellerLegalRouter.post(
  '/legal/consent',
  validate({ body: z.object({ termsVersion: z.number().int().positive(), privacyVersion: z.number().int().positive() }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await consent.acceptSellerLegal(requireUser(req).id, requireSellerId(req), req.body));
  }),
);
