/**
 * Admin catalogue endpoints (Task 4.4).
 *
 * Mounted under /api/v1/admin, which is already gated by `authenticate` +
 * `requireAdmin`; each route additionally declares the specific permission it
 * needs, so adding a STAFF role later is a permission-map change rather than a
 * route rewrite.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { z } from 'zod';
import {
  CodPolicy,
  PAGINATION_MAX_LIMIT,
  Permission,
  ProductStatus,
  UnitType,
  CatalogVertical,
} from '../../shared';
import { asyncHandler, created, noContent, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { MAX_IMAGE_BYTES } from '../../infra/storage';
import * as service from './admin-catalog.service';

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const categoryBody = z.object({
  name: z.string().trim().min(2).max(120),
  nameHi: z.string().trim().max(120).nullable().optional(),
  parentId: uuid.nullable().optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  vertical: z.nativeEnum(CatalogVertical).optional(),
  allowCod: z.nativeEnum(CodPolicy).optional(),
});

const productBody = z.object({
  name: z.string().trim().min(2).max(200),
  nameHi: z.string().trim().max(200).nullable().optional(),
  categoryId: uuid,
  brandId: uuid.nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  descriptionHi: z.string().max(4000).nullable().optional(),
  searchKeywords: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  // Basis points: 5% GST is 500. Capped at 100% to catch a percent/bp mix-up.
  taxRateBp: z.number().int().min(0).max(10000).optional(),
  hsnCode: z.string().trim().max(20).nullable().optional(),
  allowCod: z.nativeEnum(CodPolicy).optional(),
  status: z.nativeEnum(ProductStatus).optional(),
  attributes: z.record(z.unknown()).optional(),
  isDailyEssential: z.boolean().optional(),
  popularityScore: z.number().int().min(0).max(10000).optional(),
});

const variantBody = z.object({
  productId: uuid,
  sku: z.string().trim().min(2).max(60),
  variantName: z.string().trim().min(1).max(80),
  unit: z.nativeEnum(UnitType),
  unitValue: z.number().positive(),
  isDefault: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
  allowCod: z.nativeEnum(CodPolicy).optional(),
  mrpPaise: z.number().int().positive(),
  pricePaise: z.number().int().positive(),
  stockQty: z.number().int().min(0).optional(),
  maxQtyPerOrder: z.number().int().positive().max(1000).optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
});

export const adminCatalogRouter: Router = Router();

/* categories --------------------------------------------------------------- */

adminCatalogRouter.post(
  '/categories',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ body: categoryBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createCategory(req.body, requireUser(req).id));
  }),
);

adminCatalogRouter.patch(
  '/categories/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: idParams, body: categoryBody.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.updateCategory(req.params['id'] as string, req.body, requireUser(req).id);
    noContent(res);
  }),
);

adminCatalogRouter.delete(
  '/categories/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.deleteCategory(req.params['id'] as string, requireUser(req).id);
    noContent(res);
  }),
);

adminCatalogRouter.post(
  '/categories/:id/image',
  requirePermission(Permission.CATALOG_WRITE),
  validate({
    params: idParams,
    body: z.object({ key: z.string().trim().min(1).max(400) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await service.attachCategoryImage(
        { categoryId: req.params['id'] as string, key: req.body.key },
        requireUser(req).id,
      ),
    );
  }),
);

/* products ----------------------------------------------------------------- */

adminCatalogRouter.get(
  '/products',
  requirePermission(Permission.CATALOG_READ),
  validate({
    query: z.object({
      categoryId: uuid.optional(),
      limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(100),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{ categoryId?: string; limit: number }>(req);
    okCursorPage(
      res,
      await service.listProductsForAdmin({
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        limit: query.limit,
      }),
    );
  }),
);

adminCatalogRouter.post(
  '/products',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ body: productBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createProduct(req.body, requireUser(req).id));
  }),
);

adminCatalogRouter.patch(
  '/products/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: idParams, body: productBody.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.updateProduct(req.params['id'] as string, req.body, requireUser(req).id);
    noContent(res);
  }),
);

adminCatalogRouter.delete(
  '/products/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.deleteProduct(req.params['id'] as string, requireUser(req).id);
    noContent(res);
  }),
);

/* variants ----------------------------------------------------------------- */

adminCatalogRouter.post(
  '/variants',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ body: variantBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createVariant(req.body, requireUser(req).id));
  }),
);

adminCatalogRouter.delete(
  '/variants/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.deleteVariant(req.params['id'] as string, requireUser(req).id);
    noContent(res);
  }),
);

/* images ------------------------------------------------------------------- */

adminCatalogRouter.post(
  '/uploads/presign',
  requirePermission(Permission.CATALOG_WRITE),
  validate({
    body: z.object({
      fileName: z.string().trim().min(1).max(200),
      contentType: z.string().trim().min(1).max(100),
      folder: z.enum(['products', 'categories']).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.createUploadTarget(req.body));
  }),
);

/**
 * Local development upload target. In production the presigned URL points at
 * object storage and this route is never called.
 */
adminCatalogRouter.put(
  '/uploads/direct',
  requirePermission(Permission.CATALOG_WRITE),
  express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
  asyncHandler(async (req: Request, res: Response) => {
    const key = String(req.query['key'] ?? '');
    ok(
      res,
      await service.putDirect(
        key,
        req.body as Buffer,
        req.header('content-type') ?? 'image/jpeg',
      ),
    );
  }),
);

adminCatalogRouter.post(
  '/product-images',
  requirePermission(Permission.CATALOG_WRITE),
  validate({
    body: z.object({
      productId: uuid,
      variantId: uuid.nullable().optional(),
      key: z.string().trim().min(1).max(400),
      altText: z.string().trim().max(200).nullable().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.attachProductImage(req.body, requireUser(req).id));
  }),
);

adminCatalogRouter.delete(
  '/product-images/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.removeProductImage(req.params['id'] as string, requireUser(req).id);
    noContent(res);
  }),
);
