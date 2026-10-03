/**
 * Seller self-service earnings/settlement views — mounted at `/seller`,
 * alongside seller-order/seller-catalog/seller-onboarding. Read-only: a
 * seller never creates or pays its own settlement (that's
 * `SETTLEMENT_MANAGE`, admin-only — see admin-order.routes.ts).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './seller-settlement.service';

const uuid = z.string().uuid();

export const sellerSettlementRouter: Router = Router();

sellerSettlementRouter.use(attachSellerContext);

sellerSettlementRouter.get(
  '/earnings',
  requirePermission(Permission.SELLER_SETTLEMENT_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const sellerId = requireSellerId(req);
    ok(res, await service.getEarningsSummary(sellerId, sellerId));
  }),
);

/** Today's sales and earnings (orders placed today, seller's timezone). */
sellerSettlementRouter.get(
  '/earnings/today',
  requirePermission(Permission.SELLER_SETTLEMENT_READ),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getTodayEarnings(requireSellerId(req)));
  }),
);

sellerSettlementRouter.get(
  '/settlements',
  requirePermission(Permission.SELLER_SETTLEMENT_READ),
  validate({
    query: z.object({
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().int().positive().max(100).default(25),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{ cursor?: string; limit: number }>(req);
    okCursorPage(
      res,
      await service.listSettlements(requireSellerId(req), { cursor: query.cursor ?? null, limit: query.limit }),
    );
  }),
);

sellerSettlementRouter.get(
  '/settlements/:id',
  requirePermission(Permission.SELLER_SETTLEMENT_READ),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getSettlementDetail(req.params['id'] as string, requireSellerId(req)));
  }),
);
