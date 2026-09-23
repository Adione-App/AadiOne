/** Admin Referrals board — read-only. See referral.service.ts's file header
 * for why there is deliberately no "manually issue reward" endpoint here. */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { Permission } from '../../shared';
import { asyncHandler, ok, okOffsetPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';

import * as service from './referral.service';

export const adminReferralRouter: Router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

adminReferralRouter.get(
  '/referrals',
  // Referrals are fundamentally coupon-reward records — reusing the existing
  // (already-declared, previously-unused) coupon permission rather than
  // introducing a new one for this single read-only board.
  requirePermission(Permission.COUPON_READ),
  validate({ query: listQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = validatedQuery<z.infer<typeof listQuery>>(req);
    const result = await service.listForAdmin(page, limit);
    okOffsetPage(res, result);
  }),
);

adminReferralRouter.get(
  '/referrals/stats',
  requirePermission(Permission.COUPON_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await service.getAdminStats();
    ok(res, result);
  }),
);
