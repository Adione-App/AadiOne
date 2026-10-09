/**
 * Bulk product import — Seller Panel routes, mounted under /seller (after
 * authenticate + requireSellerOrAdmin + the ACTIVE-seller lifecycle gate).
 * Every route needs SELLER_CATALOG_MANAGE — the same permission as "Add
 * Product" — and works on the caller's OWN seller only (attachSellerContext).
 *
 *   GET    /imports/template.csv               header-only CSV template
 *   POST   /imports                            multipart file (+ archive), mode   -> 202, analysis starts
 *   POST   /imports/images                     multipart archive | images[]        -> 202 (images-only)
 *   GET    /imports                            history, newest first (?page, ?pageSize)
 *   GET    /imports/:id                        status, progress, summary
 *   GET    /imports/:id/rows                   preview / results (?filter, ?page, ?pageSize)
 *   GET    /imports/:id/images                 archive files by status (?status)
 *   PATCH  /imports/:id/rows/:rowId            exclude / main image / assign SKU (preview only)
 *   POST   /imports/:id/mode                   switch CREATE / UPDATE (preview only)
 *   POST   /imports/:id/confirm                start the import (idempotent)
 *   POST   /imports/:id/cancel                 drop the preview
 *   POST   /imports/:id/retry                  re-run rows that failed to save
 *   POST   /imports/:id/submit-for-approval    the created products as one approval batch
 *   GET    /imports/:id/error-report.csv       rejected rows + reasons
 *
 * Admins get read-only access through adminProductImportRouter.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ProductImportKind, ProductImportMode, ProductImportRowStatus } from '@prisma/client';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, created, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import { byUser, rateLimit } from '../../middleware/rateLimit';
import * as service from './import.service';
import { discardUploads, importUpload, readImportFiles } from './import-upload';

const uuid = z.string().uuid();
const page = z.coerce.number().int().min(1).max(10_000).default(1);
const ROW_FILTERS = ['ALL', 'READY', 'ISSUES', 'WARNINGS', ...Object.values(ProductImportRowStatus)] as const;

/** Uploads are the expensive call: 20 per hour per user. */
const importUploadLimit = rateLimit({ scope: 'product-import:upload', limit: 20, windowSeconds: 3600, identify: byUser });

/** Refused uploads never leave temp files behind. */
function withUploadCleanup(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      await discardUploads(req);
      next(error);
    }
  };
}

export const sellerProductImportRouter: Router = Router();
sellerProductImportRouter.use('/imports', attachSellerContext, requirePermission(Permission.SELLER_CATALOG_MANAGE));

sellerProductImportRouter.get('/imports/template.csv', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="aadione-product-import-template.csv"');
  res.send(service.templateCsv());
});

sellerProductImportRouter.post(
  '/imports',
  importUploadLimit,
  importUpload,
  withUploadCleanup(async (req, res) => {
    const sellerId = requireSellerId(req);
    await service.assertSellerMayImport(sellerId);
    const mode = z.nativeEnum(ProductImportMode).catch(ProductImportMode.CREATE).parse((req.body as Record<string, unknown>)?.['mode']);
    const files = await readImportFiles(req, 'PRODUCTS');
    created(res, await service.startImport({ sellerId, userId: requireUser(req).id, kind: ProductImportKind.PRODUCTS, mode, files }));
  }),
);

sellerProductImportRouter.post(
  '/imports/images',
  importUploadLimit,
  importUpload,
  withUploadCleanup(async (req, res) => {
    const sellerId = requireSellerId(req);
    await service.assertSellerMayImport(sellerId);
    const files = await readImportFiles(req, 'IMAGES');
    created(res, await service.startImport({ sellerId, userId: requireUser(req).id, kind: ProductImportKind.IMAGES, mode: ProductImportMode.UPDATE, files }));
  }),
);

sellerProductImportRouter.get(
  '/imports',
  validate({ query: z.object({ page, pageSize: z.coerce.number().int().min(1).max(50).default(20) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = validatedQuery<{ page: number; pageSize: number }>(req);
    ok(res, await service.listImports(requireSellerId(req), q.page, q.pageSize));
  }),
);

sellerProductImportRouter.get(
  '/imports/:id',
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getImport(req.params['id'] as string, requireSellerId(req)));
  }),
);

const rowsQuery = z.object({ filter: z.enum(ROW_FILTERS).default('ALL'), page, pageSize: z.coerce.number().int().min(1).max(100).default(50) });

sellerProductImportRouter.get(
  '/imports/:id/rows',
  validate({ params: z.object({ id: uuid }), query: rowsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = validatedQuery<z.infer<typeof rowsQuery>>(req);
    ok(res, await service.listRows(req.params['id'] as string, requireSellerId(req), q.filter, q.page, q.pageSize));
  }),
);

const imagesQuery = z.object({ status: z.enum(['UNUSED', 'INVALID', 'DUPLICATE_NAME', 'READY']).default('UNUSED') });

sellerProductImportRouter.get(
  '/imports/:id/images',
  validate({ params: z.object({ id: uuid }), query: imagesQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listImages(req.params['id'] as string, requireSellerId(req), validatedQuery<z.infer<typeof imagesQuery>>(req).status));
  }),
);

sellerProductImportRouter.patch(
  '/imports/:id/rows/:rowId',
  validate({
    params: z.object({ id: uuid, rowId: uuid }),
    body: z
      .object({
        excluded: z.boolean().nullable().optional(),
        primaryImage: z.string().trim().min(1).max(255).nullable().optional(),
        sku: z.string().trim().min(2).max(60).nullable().optional(),
        makePrimary: z.boolean().nullable().optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.decideRow(req.params['id'] as string, requireSellerId(req), req.params['rowId'] as string, req.body));
  }),
);

sellerProductImportRouter.post(
  '/imports/:id/mode',
  validate({ params: z.object({ id: uuid }), body: z.object({ mode: z.nativeEnum(ProductImportMode) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.changeMode(req.params['id'] as string, requireSellerId(req), req.body.mode));
  }),
);

sellerProductImportRouter.post(
  '/imports/:id/confirm',
  validate({ params: z.object({ id: uuid }), body: z.object({ mode: z.nativeEnum(ProductImportMode) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.confirmImport(req.params['id'] as string, requireSellerId(req), req.body.mode, requireUser(req).id));
  }),
);

sellerProductImportRouter.post(
  '/imports/:id/cancel',
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.cancelImport(req.params['id'] as string, requireSellerId(req), requireUser(req).id));
  }),
);

sellerProductImportRouter.post(
  '/imports/:id/retry',
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.retryFailedRows(req.params['id'] as string, requireSellerId(req), requireUser(req).id));
  }),
);

sellerProductImportRouter.post(
  '/imports/:id/submit-for-approval',
  requirePermission(Permission.PRODUCT_APPROVAL_SUBMIT),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.submitImportedForApproval(req.params['id'] as string, requireSellerId(req), requireUser(req).id));
  }),
);

sellerProductImportRouter.get(
  '/imports/:id/error-report.csv',
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.streamErrorReport(req.params['id'] as string, requireSellerId(req), res);
  }),
);

/* -------------------------------------------------------------------------- */
/* Admin — read only (mounted in admin.routes.ts behind requireAdmin)          */
/* -------------------------------------------------------------------------- */

export const adminProductImportRouter: Router = Router();

adminProductImportRouter.get(
  '/sellers/:sellerId/product-imports',
  requirePermission(Permission.CATALOG_READ),
  validate({ params: z.object({ sellerId: uuid }), query: z.object({ page, pageSize: z.coerce.number().int().min(1).max(50).default(20) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = validatedQuery<{ page: number; pageSize: number }>(req);
    ok(res, await service.listImports(req.params['sellerId'] as string, q.page, q.pageSize));
  }),
);

adminProductImportRouter.get(
  '/product-imports/:id',
  requirePermission(Permission.CATALOG_READ),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getImport(req.params['id'] as string, null));
  }),
);

adminProductImportRouter.get(
  '/product-imports/:id/rows',
  requirePermission(Permission.CATALOG_READ),
  validate({ params: z.object({ id: uuid }), query: rowsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = validatedQuery<z.infer<typeof rowsQuery>>(req);
    ok(res, await service.listRows(req.params['id'] as string, null, q.filter, q.page, q.pageSize));
  }),
);

adminProductImportRouter.get(
  '/product-imports/:id/error-report.csv',
  requirePermission(Permission.CATALOG_READ),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.streamErrorReport(req.params['id'] as string, null, res);
  }),
);
