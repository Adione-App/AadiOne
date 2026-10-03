/**
 * Admin marketplace views (admin-marketplace.service.ts). Mounted under
 * /admin (authenticate + requireAdmin). Every route reuses an existing
 * permission, so no role gains access it did not already have:
 *
 *   GET   /marketplace/products                 CATALOG_READ
 *   PATCH /products/:productId/moderation       SELLER_MANAGE   (as the per-seller moderation)
 *   GET   /marketplace/inventory                INVENTORY_READ
 *   GET   /marketplace/inventory/:id/history    INVENTORY_READ
 *   GET   /payments, /refunds                   ORDER_REFUND    (admins, not STAFF)
 *   GET   /audit-logs                           CONFIG_WRITE    (admins, not STAFF)
 *   GET   /commission/overview                  COMMISSION_MANAGE
 *   GET   /sellers/:sellerId/activity           SELLER_ONBOARDING_REVIEW (as the Sellers page)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PAGINATION_MAX_LIMIT, Permission } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { listSellerActivity } from '../sellers/seller-activity.service';
import * as service from './admin-marketplace.service';

const uuid = z.string().uuid();
const page = z.coerce.number().int().positive().max(10_000).default(1);
const pageSize = z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(25);
const q = z.string().trim().min(1).max(80).optional();

export const adminMarketplaceRouter: Router = Router();

/** Read-only catalogue explorer: sellers' own categories merged by name, every product with its seller. */
adminMarketplaceRouter.get(
  '/marketplace/catalogue',
  requirePermission(Permission.CATALOG_READ),
  validate({ query: z.object({ q, sellerId: uuid.optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getMarketplaceCatalogue(validatedQuery<{ q?: string; sellerId?: string }>(req)));
  }),
);

adminMarketplaceRouter.get(
  '/marketplace/products',
  requirePermission(Permission.CATALOG_READ),
  validate({
    query: z.object({
      q,
      sellerId: uuid.optional(),
      approval: z.enum(['APPROVED', 'PENDING', 'REJECTED']).optional(),
      visibility: z.enum(['BUYABLE', 'NOT_BUYABLE', 'DISABLED']).optional(),
      stock: z.enum(['LOW', 'OUT']).optional(),
      page,
      pageSize,
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listMarketplaceProducts(validatedQuery<service.MarketplaceProductQuery>(req)));
  }),
);

adminMarketplaceRouter.patch(
  '/products/:productId/moderation',
  requirePermission(Permission.SELLER_MANAGE),
  validate({
    params: z.object({ productId: uuid }),
    body: z.object({ action: z.enum(['DISABLE', 'ENABLE']), reason: z.string().trim().max(300).optional() }).strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { action: 'DISABLE' | 'ENABLE'; reason?: string };
    ok(res, await service.moderateProduct(req.params['productId'] as string, body, requireUser(req).id));
  }),
);

adminMarketplaceRouter.get(
  '/marketplace/inventory',
  requirePermission(Permission.INVENTORY_READ),
  validate({
    query: z.object({ q, sellerId: uuid.optional(), stock: z.enum(['IN', 'LOW', 'OUT', 'OFF']).optional(), page, pageSize }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listMarketplaceInventory(validatedQuery(req)));
  }),
);

adminMarketplaceRouter.get(
  '/marketplace/inventory/:listingId/history',
  requirePermission(Permission.INVENTORY_READ),
  validate({ params: z.object({ listingId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listingStockHistory(req.params['listingId'] as string));
  }),
);

adminMarketplaceRouter.get(
  '/payments',
  requirePermission(Permission.ORDER_REFUND),
  validate({
    query: z.object({
      q,
      status: z.enum(['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']).optional(),
      page,
      pageSize,
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listPayments(validatedQuery(req)));
  }),
);

adminMarketplaceRouter.get(
  '/refunds',
  requirePermission(Permission.ORDER_REFUND),
  validate({
    query: z.object({ q, status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(), page, pageSize }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listRefunds(validatedQuery(req)));
  }),
);

adminMarketplaceRouter.get(
  '/audit-logs',
  requirePermission(Permission.CONFIG_WRITE),
  validate({
    query: z.object({
      entityType: z.string().trim().min(1).max(60).optional(),
      action: z.string().trim().min(1).max(80).optional(),
      q,
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      page,
      pageSize,
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listAuditLogs(validatedQuery(req)));
  }),
);

adminMarketplaceRouter.get(
  '/commission/overview',
  requirePermission(Permission.COMMISSION_MANAGE),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.getCommissionOverview());
  }),
);

adminMarketplaceRouter.get(
  '/sellers/:sellerId/activity',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({
    params: z.object({ sellerId: uuid }),
    query: z.object({ limit: z.coerce.number().int().positive().max(50).default(30) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit } = validatedQuery<{ limit: number }>(req);
    ok(res, await listSellerActivity(req.params['sellerId'] as string, requireUser(req).id, limit));
  }),
);
