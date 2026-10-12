/**
 * GET /seller/lifecycle — the signed-in seller's place in the two-gate
 * lifecycle. The one seller endpoint open in EVERY lifecycle state (see
 * seller-lifecycle-rules.ts), so the panel can always say what happens next.
 * Scoped to `req.sellerId`, never a client-supplied id.
 *
 * POST /seller/lifecycle/application — a rejected applicant corrects its
 * application and sends it back to Gate 1 (open only in APPLICATION_REJECTED;
 * see seller-lifecycle-rules.ts).
 */

import { Router, type Request, type Response } from 'express';
import { Permission, type SellerApplicationResubmitRequest } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { requirePermission, requireUser } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { sellerSignupSchema } from '../auth/auth.validation';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as lifecycleService from './seller-lifecycle.service';

export const sellerLifecycleRouter: Router = Router();

sellerLifecycleRouter.get(
  '/lifecycle',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  attachSellerContext,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await lifecycleService.getSellerLifecycle(requireSellerId(req)));
  }),
);

/** The application fields a rejected applicant may correct — the same rules as signup. */
const resubmitApplicationSchema = sellerSignupSchema.pick({ businessName: true, fullName: true, sellerType: true }).strict();

sellerLifecycleRouter.post(
  '/lifecycle/application',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  attachSellerContext,
  validate({ body: resubmitApplicationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await lifecycleService.resubmitApplication(requireSellerId(req), req.body as SellerApplicationResubmitRequest, requireUser(req).id));
  }),
);
