/**
 * Admin Financial Overview — read-only. Every route needs SETTLEMENT_READ
 * (Admin and Super Admin; Staff cannot see commission or seller payouts) on
 * top of the admin router's own sign-in check. Sellers and customers have no
 * route to any of this.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { sendDocumentFile } from '../sellers/document-response';
import { FINANCE_PERIODS, type FinancePeriod } from './finance-period';
import * as service from './finance-overview.service';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const filterQuery = z.object({
  period: z.enum(FINANCE_PERIODS).default('THIS_MONTH'),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  sellerId: z.string().uuid().optional(),
});
type FilterQuery = { period: FinancePeriod; from?: string; to?: string; sellerId?: string };

export const adminFinanceRouter: Router = Router();

/** GET /admin/finance/overview — every card, breakdown and chart of the selected view. */
adminFinanceRouter.get(
  '/finance/overview',
  requirePermission(Permission.SETTLEMENT_READ),
  validate({ query: filterQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getFinancialOverview(await service.resolveFilter(validatedQuery<FilterQuery>(req))));
  }),
);

/** GET /admin/finance/orders — the same figures per delivered order, paginated. */
adminFinanceRouter.get(
  '/finance/orders',
  requirePermission(Permission.SETTLEMENT_READ),
  validate({
    query: filterQuery.extend({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<FilterQuery & { page: number; pageSize: number }>(req);
    ok(res, await service.listFinanceOrders(await service.resolveFilter(query), query.page, query.pageSize));
  }),
);

/** GET /admin/finance/overview.pdf — the selected view as a PDF (same calculation). */
adminFinanceRouter.get(
  '/finance/overview.pdf',
  requirePermission(Permission.SETTLEMENT_READ),
  validate({ query: filterQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    sendDocumentFile(res, await service.financeReportPdfFile(await service.resolveFilter(validatedQuery<FilterQuery>(req))), 'attachment');
  }),
);

/** GET /admin/finance/sellers — the seller filter's options (every seller, any status). */
adminFinanceRouter.get(
  '/finance/sellers',
  requirePermission(Permission.SETTLEMENT_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.listFinanceSellers());
  }),
);
