/**
 * Commission routes.
 *
 *   /admin/sellers/:sellerId/commission...   admin management (COMMISSION_MANAGE)
 *   /seller/commission...                    the seller's own, read-only
 *
 * A seller has no write route at all; admin routes sit behind requireAdmin.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './commission-management.service';

const uuid = z.string().uuid();
const rateBody = z.object({ rateBp: z.number().int().min(0).max(10_000) });
const sellerParam = z.object({ sellerId: uuid });

/* admin ------------------------------------------------------------------------ */

export const adminCommissionRouter: Router = Router();

adminCommissionRouter.get(
  '/sellers/:sellerId/commission',
  requirePermission(Permission.COMMISSION_MANAGE),
  validate({ params: sellerParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getCommissionConfig(req.params['sellerId'] as string));
  }),
);

adminCommissionRouter.get(
  '/sellers/:sellerId/commission/history',
  requirePermission(Permission.COMMISSION_MANAGE),
  validate({ params: sellerParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listRuleHistory(req.params['sellerId'] as string));
  }),
);

adminCommissionRouter.put(
  '/sellers/:sellerId/commission/default',
  requirePermission(Permission.COMMISSION_MANAGE),
  validate({ params: sellerParam, body: rateBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.setDefaultCommission(req.params['sellerId'] as string, req.body.rateBp, requireUser(req).id));
  }),
);

for (const kind of ['categories', 'products'] as const) {
  const scopeOf = (req: Request): service.CommissionScope =>
    kind === 'categories'
      ? { kind: 'CATEGORY', categoryId: req.params['targetId'] as string }
      : { kind: 'PRODUCT', productId: req.params['targetId'] as string };
  const params = z.object({ sellerId: uuid, targetId: uuid });

  adminCommissionRouter.put(
    `/sellers/:sellerId/commission/${kind}/:targetId`,
    requirePermission(Permission.COMMISSION_MANAGE),
    validate({ params, body: rateBody }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await service.setRule(req.params['sellerId'] as string, scopeOf(req), req.body.rateBp, requireUser(req).id));
    }),
  );

  adminCommissionRouter.delete(
    `/sellers/:sellerId/commission/${kind}/:targetId`,
    requirePermission(Permission.COMMISSION_MANAGE),
    validate({ params }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await service.removeRule(req.params['sellerId'] as string, scopeOf(req), requireUser(req).id));
    }),
  );
}

/* seller (read-only) ----------------------------------------------------------- */

export const sellerCommissionRouter: Router = Router();

sellerCommissionRouter.use('/commission', attachSellerContext);

sellerCommissionRouter.get(
  '/commission',
  requirePermission(Permission.SELLER_SETTLEMENT_READ),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getSellerCommissionView(requireSellerId(req)));
  }),
);

sellerCommissionRouter.get(
  '/commission/orders',
  requirePermission(Permission.SELLER_SETTLEMENT_READ),
  validate({ query: z.object({ limit: z.coerce.number().int().positive().max(100).default(25) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit } = validatedQuery<{ limit: number }>(req);
    ok(res, await service.listSellerOrderCommissions(requireSellerId(req), limit));
  }),
);
