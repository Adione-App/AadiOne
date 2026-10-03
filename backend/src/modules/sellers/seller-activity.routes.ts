/**
 * Seller panel — recent activity (seller-activity.service.ts). Mounted at
 * `/seller`. Seller callers only: an admin request without a seller context
 * is refused by `requireSellerId`.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './seller-activity.service';

export const sellerActivityRouter: Router = Router();

sellerActivityRouter.use('/activity', attachSellerContext);

sellerActivityRouter.get(
  '/activity',
  requirePermission(Permission.SELLER_ORDER_READ_OWN),
  validate({ query: z.object({ limit: z.coerce.number().int().positive().max(50).default(20) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit } = validatedQuery<{ limit: number }>(req);
    ok(res, await service.listSellerActivity(requireSellerId(req), requireUser(req).id, limit));
  }),
);
