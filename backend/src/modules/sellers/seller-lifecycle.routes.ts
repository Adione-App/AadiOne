/**
 * GET /seller/lifecycle — the signed-in seller's place in the two-gate
 * lifecycle. The one seller endpoint open in EVERY lifecycle state (see
 * seller-lifecycle-rules.ts), so the panel can always say what happens next.
 * Scoped to `req.sellerId`, never a client-supplied id.
 */

import { Router, type Request, type Response } from 'express';
import { Permission } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { requirePermission } from '../../middleware/auth';
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
