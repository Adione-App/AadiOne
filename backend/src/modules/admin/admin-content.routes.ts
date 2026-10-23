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
 *   GET    /content/home-layout          CATALOG_READ   published, draft, history
 *   GET    /content/home-layout/preview  CATALOG_READ   the draft as customers would get it
 *   GET    /content/category-options     CATALOG_READ   live categories merged by path
 *   PUT    /content/home-layout/draft    CATALOG_WRITE  save the draft
 *   DELETE /content/home-layout/draft    CATALOG_WRITE  discard it
 *   POST   /content/home-layout/publish  CATALOG_WRITE  draft → next published revision
 *   POST   /content/home-layout/restore/:id  CATALOG_WRITE  an earlier revision → draft
 *   POST   /content/home-layout/background-image  CATALOG_WRITE  process an uploaded image
 *
 * Every image goes through the shared pipeline (uploaded-image.service.ts):
 * validated, resized, stored as WebP; the raw upload is deleted.
 */

import { Router, type Request, type Response } from 'express';
import { BannerActionType, BannerStatus } from '@prisma/client';
import { z } from 'zod';
import {
  BANNER_ASPECT_LIMITS,
  BANNER_BACKGROUNDS,
  BANNER_HEIGHT_LIMITS,
  BANNER_VARIANTS,
  CATEGORY_COLUMN_LIMITS,
  CATEGORY_COUNT_LIMITS,
  CATEGORY_NAME_MAX,
  CATEGORY_PATH_PATTERN,
  CATEGORY_PLACEMENT_KEYS,
  CATEGORY_ROW_LIMITS,
  CATEGORY_STYLE_MAX,
  CATEGORY_TILE_SHAPES,
  CONTENT_COLOR_PRESETS,
  HEX_COLOR_PATTERN,
  HOME_BACKGROUND_TYPES,
  HOME_CARD_COUNT_LIMITS,
  HOME_CARD_GAPS,
  HOME_CARD_HEIGHT_LIMITS,
  HOME_CARD_RADII,
  HOME_GRADIENT_DIRECTIONS,
  HOME_OVERLAY_OPACITY_MAX,
  HOME_SECTION_KEYS,
  HOME_SPACING,
  HOME_TEXT_LIMITS,
  Permission,
  type BannerBackground,
} from '../../shared';
import * as homeLayout from '../content/home-layout.service';
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

/** A banner's presentation: every field optional, numbers within the shared safe limits. */
const bannerLayout = z
  .object({
    variant: z.enum(BANNER_VARIANTS).optional(),
    aspectRatio: z.number().min(BANNER_ASPECT_LIMITS.min).max(BANNER_ASPECT_LIMITS.max).nullable().optional(),
    height: z.number().int().min(BANNER_HEIGHT_LIMITS.min).max(BANNER_HEIGHT_LIMITS.max).nullable().optional(),
    width: z.enum(['full', 'content']).optional(),
    fit: z.enum(['contain', 'cover']).optional(),
    alignX: z.enum(['left', 'center', 'right']).optional(),
    alignY: z.enum(['top', 'center', 'bottom']).optional(),
    radius: z.enum(['none', 'sm', 'md', 'lg']).optional(),
    background: z.enum(BANNER_BACKGROUNDS as [BannerBackground, ...BannerBackground[]]).optional(),
    textTone: z.enum(['dark', 'light']).optional(),
  })
  .strict();

/** ISO date-time (with offset) or null = no limit. */
const scheduleTime = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .transform((value) => (value === null ? null : new Date(value)));

const bannerFields = {
  placement,
  title: text(120),
  subtitle: text(200),
  ctaLabel: text(40),
  actionType: z.nativeEnum(BannerActionType),
  actionValue: text(500),
  displayOrder: z.number().int().min(0).max(10_000),
  isActive: z.boolean(),
  status: z.nativeEnum(BannerStatus),
  startsAt: scheduleTime,
  endsAt: scheduleTime,
  layout: bannerLayout,
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
        ctaLabel: bannerFields.ctaLabel.default(null),
        actionType: bannerFields.actionType.default(BannerActionType.NONE),
        actionValue: bannerFields.actionValue.default(null),
        displayOrder: bannerFields.displayOrder.default(0),
        isActive: bannerFields.isActive.default(true),
        status: bannerFields.status.default(BannerStatus.PUBLISHED),
        startsAt: bannerFields.startsAt.default(null),
        endsAt: bannerFields.endsAt.default(null),
        layout: bannerFields.layout.default({}),
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
        ctaLabel: bannerFields.ctaLabel.optional(),
        actionType: bannerFields.actionType.optional(),
        actionValue: bannerFields.actionValue.optional(),
        displayOrder: bannerFields.displayOrder.optional(),
        isActive: bannerFields.isActive.optional(),
        status: bannerFields.status.optional(),
        startsAt: bannerFields.startsAt.optional(),
        endsAt: bannerFields.endsAt.optional(),
        layout: bannerFields.layout.optional(),
        imageKey: key.optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await banners.updateBanner(req.params['id'] as string, req.body, requireUser(req).id));
  }),
);

/** The order of one placement's banners: every banner of it, listed first to last. */
adminContentRouter.put(
  '/banners/order',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ body: z.object({ placement, ids: z.array(uuid).min(1).max(200) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await banners.reorderBanners(req.body.placement, req.body.ids, requireUser(req).id));
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

/* Home Page Builder and category display (content document "home_layout") --- */

/** A colour: one of the named presets or #RRGGBB — nothing else (no CSS, no code). */
const contentColor = z
  .string()
  .trim()
  .refine((value) => HEX_COLOR_PATTERN.test(value) || value in CONTENT_COLOR_PRESETS, 'Pick a colour from the list or enter #RRGGBB');
const layoutText = (max: number) => z.string().trim().max(max).nullable();
const categoryPath = z.string().trim().regex(CATEGORY_PATH_PATTERN, 'Not a category path');

/** One category placement (CategoryPlacementConfig). */
const categoryPlacementBody = z
  .object({
    mode: z.enum(['auto', 'manual']),
    paths: z.array(categoryPath).max(CATEGORY_COUNT_LIMITS.max),
    maxItems: z.number().int().min(CATEGORY_COUNT_LIMITS.min).max(CATEGORY_COUNT_LIMITS.max),
    columns: z.number().int().min(CATEGORY_COLUMN_LIMITS.min).max(CATEGORY_COLUMN_LIMITS.max).nullable(),
    rows: z.number().int().min(CATEGORY_ROW_LIMITS.min).max(CATEGORY_ROW_LIMITS.max).nullable(),
    layout: z.enum(['grid', 'row']),
    showViewAll: z.boolean(),
    tileShape: z.enum(CATEGORY_TILE_SHAPES),
    imageFit: z.enum(['cover', 'contain']),
    tileBackground: contentColor,
  })
  .strict();

/**
 * The whole layout as the builder saves it. Strict: unknown fields and
 * out-of-range values are refused with a message rather than silently
 * dropped (the service then stores it through resolveHomeLayout).
 */
const homeLayoutBody = z
  .object({
    schema: z.literal(1),
    hero: z
      .object({
        background: z
          .object({
            type: z.enum(HOME_BACKGROUND_TYPES),
            color: contentColor,
            colorTo: contentColor,
            direction: z.enum(HOME_GRADIENT_DIRECTIONS),
            imageUrl: z.string().trim().url().max(500).nullable(),
            overlayColor: contentColor,
            overlayOpacity: z.number().min(0).max(HOME_OVERLAY_OPACITY_MAX),
          })
          .strict(),
        padding: z.enum(HOME_SPACING),
        promo: z.object({ visible: z.boolean() }).strict(),
        cards: z
          .object({
            visible: z.boolean(),
            maxItems: z.number().int().min(HOME_CARD_COUNT_LIMITS.min).max(HOME_CARD_COUNT_LIMITS.max),
            height: z.number().int().min(HOME_CARD_HEIGHT_LIMITS.min).max(HOME_CARD_HEIGHT_LIMITS.max),
            radius: z.enum(HOME_CARD_RADII),
            gap: z.enum(HOME_CARD_GAPS),
          })
          .strict(),
      })
      .strict(),
    sections: z
      .array(
        z
          .object({
            key: z.enum(HOME_SECTION_KEYS),
            visible: z.boolean(),
            title: layoutText(HOME_TEXT_LIMITS.title),
            subtitle: layoutText(HOME_TEXT_LIMITS.subtitle),
            background: contentColor,
            spacing: z.enum(HOME_SPACING),
            maxItems: z.number().int().min(1).max(60).nullable(),
          })
          .strict(),
      )
      .max(HOME_SECTION_KEYS.length)
      .refine((sections) => new Set(sections.map((section) => section.key)).size === sections.length, 'Each section may appear only once'),
    categoryPlacements: z
      .object({
        home_top: categoryPlacementBody,
        home_explore: categoryPlacementBody,
        home_more: categoryPlacementBody,
        categories_page: categoryPlacementBody,
      } satisfies Record<(typeof CATEGORY_PLACEMENT_KEYS)[number], typeof categoryPlacementBody>)
      .strict(),
    categoryStyles: z
      .array(
        z
          .object({
            path: categoryPath,
            displayName: layoutText(CATEGORY_NAME_MAX),
            displayNameHi: layoutText(CATEGORY_NAME_MAX),
            tileBackground: contentColor.nullable(),
            textColor: z.enum(['dark', 'light']).nullable(),
            hidden: z.boolean(),
          })
          .strict(),
      )
      .max(CATEGORY_STYLE_MAX),
  })
  .strict();

adminContentRouter.get(
  '/content/home-layout',
  requirePermission(Permission.CATALOG_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await homeLayout.getAdminHomeLayout());
  }),
);

/** What customers would get if the draft were published now (the published layout when there is no draft). */
adminContentRouter.get(
  '/content/home-layout/preview',
  requirePermission(Permission.CATALOG_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await homeLayout.previewHomeLayout());
  }),
);

adminContentRouter.get(
  '/content/category-options',
  requirePermission(Permission.CATALOG_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await homeLayout.listCategoryOptions());
  }),
);

adminContentRouter.put(
  '/content/home-layout/draft',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ body: z.object({ layout: homeLayoutBody }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await homeLayout.saveHomeLayoutDraft(req.body.layout, requireUser(req).id));
  }),
);

adminContentRouter.delete(
  '/content/home-layout/draft',
  requirePermission(Permission.CATALOG_WRITE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await homeLayout.discardHomeLayoutDraft(requireUser(req).id));
  }),
);

/** `basedOnRevision`: the published revision the admin's screen showed (0 = none) — guards against overwriting a newer publish. */
adminContentRouter.post(
  '/content/home-layout/publish',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ body: z.object({ basedOnRevision: z.number().int().min(0) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await homeLayout.publishHomeLayout(req.body.basedOnRevision, requireUser(req).id));
  }),
);

adminContentRouter.post(
  '/content/home-layout/restore/:id',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await homeLayout.restoreHomeLayoutRevision(req.params['id'] as string, requireUser(req).id));
  }),
);

/** An uploaded background image (POST /uploads/presign, purpose "banner") through the image pipeline. */
adminContentRouter.post(
  '/content/home-layout/background-image',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ body: z.object({ key }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await homeLayout.processBackgroundImage(req.body.key));
  }),
);
