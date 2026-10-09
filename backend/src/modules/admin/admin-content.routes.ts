/**
 * Admin-managed storefront content — image uploads, category images and
 * banners. Mounted under /admin (authenticate + requireAdmin): a customer-app
 * (OTP) session is a CUSTOMER session, so it never reaches these routes, and
 * neither does a seller. Every route reuses an existing permission:
 *
 *   POST   /uploads/presign              CATALOG_WRITE  upload target (admin/<purpose>/…)
 *   PUT    /uploads/direct               CATALOG_WRITE  local storage only
 *   PUT    /categories/:id/image         CATALOG_WRITE  set the merged category's image
 *   DELETE /categories/:id/image         CATALOG_WRITE  remove it
 *   GET    /banners                      CATALOG_READ   every banner, optional ?placement
 *   POST   /banners                      CATALOG_WRITE
 *   PATCH  /banners/:id                  CATALOG_WRITE  fields and/or a new image
 *   DELETE /banners/:id                  CATALOG_WRITE
 *
 * Every image goes through the shared pipeline (uploaded-image.service.ts):
 * validated, resized, stored as WebP; the raw upload is deleted.
 */

import { Router, type Request, type Response } from 'express';
import { BannerActionType } from '@prisma/client';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, created, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { imageBody } from '../catalog/seller-catalog.routes';
import * as categoryImages from '../catalog/admin-category-image.service';
import * as banners from '../banners/banner.service';
import { ADMIN_UPLOAD_PURPOSES, createAdminUploadTarget, putAdminUpload } from './admin-upload.service';

export const adminContentRouter: Router = Router();

const uuid = z.string().uuid();
const key = z.string().trim().min(1).max(400);
const placement = z.string().trim().min(1).max(60).regex(banners.PLACEMENT_PATTERN, 'Use a slug such as home_top, food or category:<id>');
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value ? value : null));

/* Uploads ------------------------------------------------------------------ */

adminContentRouter.post(
  '/uploads/presign',
  requirePermission(Permission.CATALOG_WRITE),
  validate({
    body: z
      .object({
        fileName: z.string().trim().min(1).max(200),
        contentType: z.string().trim().min(1).max(100),
        purpose: z.enum(ADMIN_UPLOAD_PURPOSES),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await createAdminUploadTarget(req.body));
  }),
);

/** Local development upload target; production PUTs straight to object storage. */
adminContentRouter.put(
  '/uploads/direct',
  requirePermission(Permission.CATALOG_WRITE),
  imageBody,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await putAdminUpload(String(req.query['key'] ?? ''), req.body, req.header('content-type') ?? ''));
  }),
);

/* Category images (top categories, subcategories, food menus/sections) ------ */

adminContentRouter.put(
  '/categories/:id/image',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: z.object({ id: uuid }), body: z.object({ key }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await categoryImages.setCategoryImage(req.params['id'] as string, req.body.key, requireUser(req).id));
  }),
);

adminContentRouter.delete(
  '/categories/:id/image',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await categoryImages.removeCategoryImage(req.params['id'] as string, requireUser(req).id));
  }),
);

/* Banners ------------------------------------------------------------------ */

const bannerFields = {
  placement,
  title: text(120),
  subtitle: text(200),
  actionType: z.nativeEnum(BannerActionType),
  actionValue: text(120),
  displayOrder: z.number().int().min(0).max(10_000),
  isActive: z.boolean(),
};

adminContentRouter.get(
  '/banners',
  requirePermission(Permission.CATALOG_READ),
  validate({ query: z.object({ placement: placement.optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await banners.listBanners(validatedQuery<{ placement?: string }>(req).placement));
  }),
);

adminContentRouter.post(
  '/banners',
  requirePermission(Permission.CATALOG_WRITE),
  validate({
    body: z
      .object({
        ...bannerFields,
        title: bannerFields.title.default(null),
        subtitle: bannerFields.subtitle.default(null),
        actionType: bannerFields.actionType.default(BannerActionType.NONE),
        actionValue: bannerFields.actionValue.default(null),
        displayOrder: bannerFields.displayOrder.default(0),
        isActive: bannerFields.isActive.default(true),
        imageKey: key,
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await banners.createBanner(req.body, requireUser(req).id));
  }),
);

adminContentRouter.patch(
  '/banners/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({
    params: z.object({ id: uuid }),
    body: z
      .object({
        placement: bannerFields.placement.optional(),
        title: bannerFields.title.optional(),
        subtitle: bannerFields.subtitle.optional(),
        actionType: bannerFields.actionType.optional(),
        actionValue: bannerFields.actionValue.optional(),
        displayOrder: bannerFields.displayOrder.optional(),
        isActive: bannerFields.isActive.optional(),
        imageKey: key.optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await banners.updateBanner(req.params['id'] as string, req.body, requireUser(req).id));
  }),
);

adminContentRouter.delete(
  '/banners/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await banners.deleteBanner(req.params['id'] as string, requireUser(req).id));
  }),
);
