import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { asyncHandler, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { authenticate, requireUser } from '../../middleware/auth';
import { referralApplyPerUser } from '../../middleware/rateLimit';

import * as service from './referral.service';

export const referralRouter: Router = Router();

referralRouter.use(authenticate);

/* -------------------------------------------------------------------------- */
/* APPLY REFERRAL CODE — first-time signup only (mobile calls this once,      */
/* right after account creation, before the referral-code step is dismissed). */
/* -------------------------------------------------------------------------- */

referralRouter.post(
  '/apply',
  referralApplyPerUser,
  validate({
    body: z.object({
      code: z.string().trim().min(2).max(16),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.body as { code: string };
    await service.applyReferralCode(requireUser(req).id, code);
    ok(res, { applied: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* MY REFERRAL SUMMARY — code, stats, history (Rewards page's Refer & Earn    */
/* section).                                                                  */
/* -------------------------------------------------------------------------- */

referralRouter.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await service.getMySummary(requireUser(req).id);
    ok(res, result);
  }),
);

export const rewardsRouter: Router = Router();

rewardsRouter.use(authenticate);

/* -------------------------------------------------------------------------- */
/* MY COUPONS — Rewards page's Available/Used/Expired tabs.                   */
/* -------------------------------------------------------------------------- */

rewardsRouter.get(
  '/coupons',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await service.getMyCoupons(requireUser(req).id);
    ok(res, result);
  }),
);
