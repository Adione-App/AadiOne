/**
 * Seller self-service catalog submission — mounted at `/seller`, alongside
 * `seller-order.routes.ts`. Creating a product and submitting it for review
 * are deliberately separate steps (matching `SubmitProductApprovalBatchRequest`'s
 * own `productIds: string[]` shape in shared/dto.ts): a seller may create
 * several products before bundling any of them into one batch.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ErrorCode, Permission, ProductStatus, UnitType } from '../../shared';
import { AppError } from '../../common/errors';
import { MAX_IMAGE_BYTES } from '../../infra/storage';
import * as imageService from './seller-image.service';
import { asyncHandler, created, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './product-approval.service';
import * as listingService from './seller-listing.service';
import * as variantService from './product-variant.service';
import * as productService from './seller-product.service';
import * as sellerCategoryService from './seller-category.service';
import * as subcategoryService from './seller-subcategory.service';
import { createSellerListing } from '../sellers/admin-seller-catalog.service';

const uuid = z.string().uuid();

const createProductSchema = z.object({
  categoryId: uuid,
  name: z.string().trim().min(2).max(200),
  nameHi: z.string().trim().max(200).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  // Optional HERE only: a marketplace product must have SKU, variant, unit,
  // MRP and opening stock (product-approval.service enforces it by seller
  // type); a restaurant/cafe FOOD item has none of them — just a price.
  sku: z.string().trim().min(2).max(60).optional(),
  variantName: z.string().trim().min(1).max(80).optional(),
  unit: z.nativeEnum(UnitType).optional(),
  unitValue: z.number().positive().optional(),
  // A product is created COMPLETE: the seller's own price and opening stock
  // are part of it from the start (same limits as the listing routes).
  mrpPaise: z.number().int().positive().optional(),
  // Required for a simple item (the service checks); with `variants`, per variant.
  pricePaise: z.number().int().positive().optional(),
  stockQty: z.number().int().min(0).max(100_000).optional(),
  // Food items only: veg / non-veg and whether it is on the menu right now.
  diet: z.enum(['VEG', 'NON_VEG']).nullable().optional(),
  isAvailable: z.boolean().optional(),
});

/** Optional options / variants (product-variant.service): generic groups, one row per sellable variant. */
const optionGroupsSchema = z.array(z.object({ name: z.string().max(40), values: z.array(z.string().max(40)).min(1).max(30) }).strict()).max(3);
const variantSchema = z
  .object({
    id: uuid.optional(),
    optionValues: z.record(z.string().max(40), z.string().max(40)).optional(),
    variantName: z.string().trim().max(80).optional(),
    sku: z.string().trim().min(2).max(60).optional(),
    unit: z.nativeEnum(UnitType).optional(),
    unitValue: z.number().positive().optional(),
    pricePaise: z.number().int().positive(),
    mrpPaise: z.number().int().positive().optional(),
    stockQty: z.number().int().min(0).max(100_000).optional(),
    isAvailable: z.boolean().optional(),
  })
  .strict();
const variantSetSchema = z.object({ optionGroups: optionGroupsSchema, variants: z.array(variantSchema).min(1).max(100) }).strict();

const createProductBodySchema = createProductSchema
  .extend({ optionGroups: optionGroupsSchema.optional(), variants: z.array(variantSchema.omit({ id: true })).min(1).max(100).optional() })
  .refine((v) => v.mrpPaise === undefined || v.pricePaise === undefined || v.pricePaise <= v.mrpPaise, {
    message: 'Selling price cannot be higher than MRP.',
    path: ['pricePaise'],
  });

/**
 * Correcting an own product: the creation fields only, each optional. Strict,
 * so anything else (approvalStatus, sellerId, status, prices…) is a 400
 * rather than silently dropped.
 */
const updateProductSchema = createProductSchema
  .omit({ isAvailable: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

/** Empty body = "Submit for Approval": every complete, never-submitted product. */
const submitBatchSchema = z
  .object({
    productIds: z.array(uuid).min(1).max(1000).optional(),
  })
  .strict();

export const sellerCatalogRouter: Router = Router();

sellerCatalogRouter.use(attachSellerContext);

/** Own products only — every one this seller created, submitted or not. */
sellerCatalogRouter.get(
  '/products',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await productService.listOwnProducts(requireSellerId(req)));
  }),
);

sellerCatalogRouter.get(
  '/products/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await productService.getOwnProduct(requireSellerId(req), req.params['id'] as string));
  }),
);

/** Show/hide the own product (any approval stage — it changes no content). */
sellerCatalogRouter.patch(
  '/products/:id/status',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ status: z.enum([ProductStatus.ACTIVE, ProductStatus.INACTIVE]) }).strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { status } = req.body as { status: typeof ProductStatus.ACTIVE | typeof ProductStatus.INACTIVE };
    ok(res, await service.setOwnProductStatus(requireSellerId(req), req.params['id'] as string, status, requireUser(req).id));
  }),
);

/* The seller's own categories: top categories + subcategories -------------- */

sellerCatalogRouter.get(
  '/categories',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await sellerCategoryService.listSellerCatalogCategories(requireSellerId(req)));
  }),
);

const categoryName = z.string().trim().min(2).max(120);
const createTopCategorySchema = z
  .object({
    name: categoryName,
    nameHi: z.string().trim().max(120).nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
const updateTopCategorySchema = z
  .object({
    name: categoryName.optional(),
    nameHi: z.string().trim().max(120).nullable().optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

sellerCatalogRouter.post(
  '/categories',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ body: createTopCategorySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await sellerCategoryService.createOwnTopCategory(requireSellerId(req), req.body, requireUser(req).id));
  }),
);

sellerCatalogRouter.patch(
  '/categories/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: updateTopCategorySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await sellerCategoryService.updateOwnTopCategory(requireSellerId(req), req.params['id'] as string, req.body, requireUser(req).id),
    );
  }),
);

/** Refused (409) while any product is linked — see deleteOwnTopCategory. */
sellerCatalogRouter.delete(
  '/categories/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await sellerCategoryService.deleteOwnTopCategory(requireSellerId(req), req.params['id'] as string, requireUser(req).id));
  }),
);

sellerCatalogRouter.post(
  '/categories/:id/image',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: z.object({ key: z.string().trim().min(1).max(400) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.body as { key: string };
    ok(
      res,
      await sellerCategoryService.setOwnTopCategoryImage(requireSellerId(req), req.params['id'] as string, key, requireUser(req).id),
    );
  }),
);

const subcategoryName = categoryName;
const createSubcategorySchema = z
  .object({
    parentId: uuid,
    name: subcategoryName,
    nameHi: z.string().trim().max(120).nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
const updateSubcategorySchema = z
  .object({
    name: subcategoryName.optional(),
    nameHi: z.string().trim().max(120).nullable().optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

sellerCatalogRouter.get(
  '/subcategories',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await subcategoryService.listOwnSubcategories(requireSellerId(req)));
  }),
);

sellerCatalogRouter.post(
  '/subcategories',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ body: createSubcategorySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await subcategoryService.createOwnSubcategory(requireSellerId(req), req.body, requireUser(req).id));
  }),
);

sellerCatalogRouter.patch(
  '/subcategories/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: updateSubcategorySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await subcategoryService.updateOwnSubcategory(requireSellerId(req), req.params['id'] as string, req.body, requireUser(req).id),
    );
  }),
);

/** Refused (409) while any product is linked — see deleteOwnSubcategory. */
sellerCatalogRouter.delete(
  '/subcategories/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await subcategoryService.deleteOwnSubcategory(requireSellerId(req), req.params['id'] as string, requireUser(req).id));
  }),
);

sellerCatalogRouter.post(
  '/subcategories/:id/image',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: z.object({ key: z.string().trim().min(1).max(400) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.body as { key: string };
    ok(
      res,
      await subcategoryService.setOwnSubcategoryImage(requireSellerId(req), req.params['id'] as string, key, requireUser(req).id),
    );
  }),
);

sellerCatalogRouter.post(
  '/products',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ body: createProductBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await service.createSellerProduct(requireSellerId(req), req.body, requireUser(req).id),
    );
  }),
);

/**
 * The product's whole option / variant set: add, edit, remove and reorder
 * variants and option groups in one call (product-variant.service). New
 * variants of an approved product wait for review; the product stays live.
 */
sellerCatalogRouter.put(
  '/products/:id/variants',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: variantSetSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await variantService.syncProductVariants(requireSellerId(req), req.params['id'] as string, req.body, requireUser(req).id);
    ok(res, await productService.getOwnProduct(requireSellerId(req), req.params['id'] as string));
  }),
);

/** Restaurant / cafe food items only — soft delete (see deleteOwnFoodItem). */
sellerCatalogRouter.delete(
  '/products/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.deleteOwnFoodItem(requireSellerId(req), req.params['id'] as string, requireUser(req).id));
  }),
);

/** Only while the product is not approved and not under review (see the service). */
sellerCatalogRouter.patch(
  '/products/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: updateProductSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await service.updateSellerProduct(requireSellerId(req), req.params['id'] as string, req.body, requireUser(req).id),
    );
  }),
);

sellerCatalogRouter.post(
  '/approval-batches',
  requirePermission(Permission.PRODUCT_APPROVAL_SUBMIT),
  validate({ body: submitBatchSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { productIds } = (req.body ?? {}) as { productIds?: string[] };
    created(
      res,
      await service.submitApprovalBatch(requireSellerId(req), productIds, requireUser(req).id),
    );
  }),
);

sellerCatalogRouter.get(
  '/approval-batches',
  requirePermission(Permission.PRODUCT_APPROVAL_SUBMIT),
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
      await service.listApprovalBatches(requireSellerId(req), {
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
  }),
);

sellerCatalogRouter.get(
  '/approval-batches/:id',
  requirePermission(Permission.PRODUCT_APPROVAL_SUBMIT),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getApprovalBatchDetail(req.params['id'] as string, requireSellerId(req)));
  }),
);

/* Own product images — same storage flow as the admin catalogue. ----------- */

const presignSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(100),
  })
  .strict();

const attachImageSchema = z
  .object({
    key: z.string().trim().min(1).max(400),
    altText: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

/** The image body, same limit as the admin route; over it is a clean 413. */
const rawImage = express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES });
function imageBody(req: Request, res: Response, next: NextFunction): void {
  rawImage(req, res, (error?: unknown) => {
    if (error && (error as { type?: string }).type === 'entity.too.large') {
      next(new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'Images must be 5 MB or smaller.' }));
      return;
    }
    next(error as Error | undefined);
  });
}

sellerCatalogRouter.post(
  '/uploads/presign',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ body: presignSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await imageService.createSellerUploadTarget(requireSellerId(req), req.body));
  }),
);

/** Local development upload target; production PUTs straight to object storage. */
sellerCatalogRouter.put(
  '/uploads/direct',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  imageBody,
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await imageService.putSellerUpload(
        requireSellerId(req),
        String(req.query['key'] ?? ''),
        req.body,
        req.header('content-type') ?? '',
      ),
    );
  }),
);

sellerCatalogRouter.post(
  '/products/:id/images',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: attachImageSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await imageService.attachSellerImage(requireSellerId(req), req.params['id'] as string, req.body, requireUser(req).id),
    );
  }),
);

/** Replace one image's file in place (same position; a replaced main image stays main). */
sellerCatalogRouter.patch(
  '/products/:id/images/:imageId',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid, imageId: uuid }), body: attachImageSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await imageService.replaceSellerImage(
        requireSellerId(req),
        req.params['id'] as string,
        req.params['imageId'] as string,
        req.body,
        requireUser(req).id,
      ),
    );
  }),
);

/** Gallery order — the first id becomes the PRIMARY image. */
sellerCatalogRouter.put(
  '/products/:id/images/order',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ imageIds: z.array(uuid).min(1).max(imageService.MAX_SELLER_PRODUCT_IMAGES) }).strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { imageIds } = req.body as { imageIds: string[] };
    ok(
      res,
      await imageService.reorderSellerImages(requireSellerId(req), req.params['id'] as string, imageIds, requireUser(req).id),
    );
  }),
);

sellerCatalogRouter.delete(
  '/products/:id/images/:imageId',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid, imageId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await imageService.removeSellerImage(
        requireSellerId(req),
        req.params['id'] as string,
        req.params['imageId'] as string,
        requireUser(req).id,
      ),
    );
  }),
);

/* Own listings — price/stock/availability are seller-controlled (#11). ------ */

const createListingSchema = z
  .object({
    variantId: uuid,
    mrpPaise: z.number().int().positive(),
    pricePaise: z.number().int().positive(),
    stockQty: z.number().int().min(0).max(100_000).optional(),
    isAvailable: z.boolean().optional(),
  })
  .refine((v) => v.pricePaise <= v.mrpPaise, { message: 'Selling price cannot be higher than MRP.', path: ['pricePaise'] });

const updateListingSchema = z
  .object({
    mrpPaise: z.number().int().positive().optional(),
    pricePaise: z.number().int().positive().optional(),
    stockQty: z.number().int().min(0).max(100_000).optional(),
    isAvailable: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

sellerCatalogRouter.get(
  '/listings',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await listingService.listOwnListings(requireSellerId(req)));
  }),
);

sellerCatalogRouter.post(
  '/listings',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ body: createListingSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await createSellerListing(requireSellerId(req), req.body, requireUser(req).id),
    );
  }),
);

sellerCatalogRouter.patch(
  '/listings/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }), body: updateListingSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await listingService.updateOwnListing(requireSellerId(req), req.params['id'] as string, req.body, requireUser(req).id),
    );
  }),
);

/** Stock +/- (relative, row-locked; never below reserved or zero). */
sellerCatalogRouter.post(
  '/listings/:id/stock-adjust',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({
    params: z.object({ id: uuid }),
    body: z
      .object({
        delta: z.number().int().min(-100_000).max(100_000),
        note: z.string().trim().max(200).nullable().optional(),
      })
      .strict()
      .refine((v) => v.delta !== 0, { message: 'Nothing to change.', path: ['delta'] }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { delta, note } = req.body as { delta: number; note?: string | null };
    ok(
      res,
      await listingService.adjustOwnStock(requireSellerId(req), req.params['id'] as string, delta, requireUser(req).id, note ?? null),
    );
  }),
);

/** One own listing with its inventory figures and whether customers can buy it. */
sellerCatalogRouter.get(
  '/listings/:id',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await listingService.getOwnListing(requireSellerId(req), req.params['id'] as string));
  }),
);

/** Recent stock movements of an own listing (StockLedger: who, when, why). */
sellerCatalogRouter.get(
  '/listings/:id/stock-movements',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await listingService.listOwnStockMovements(requireSellerId(req), req.params['id'] as string));
  }),
);
