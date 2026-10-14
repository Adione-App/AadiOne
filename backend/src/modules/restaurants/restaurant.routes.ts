/**
 * Restaurant routes (V2 food module) — three audiences, three routers:
 *
 *   restaurantRouter        /restaurants              public, customer-facing
 *   sellerRestaurantRouter  /seller/menu-sections     a restaurant's / cafe's menu
 *                                                     sections: list, create, reorder
 *
 * A food seller's MENU is its own category tree: menus are top categories and
 * menu sections are subcategories, so renaming, hiding and deleting them (and
 * creating menus) go through the ordinary /seller/categories and
 * /seller/subcategories routes with the same ownership and delete rules.
 *   adminRestaurantRouter   /admin/restaurants        cross-restaurant view
 *
 * A restaurant's profile (cuisine / veg-only / prep time) is managed through
 * seller onboarding (`PUT /seller/onboarding/restaurant-profile`), and its
 * menu items through the existing seller catalog + approval + listing routes.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { refineQueryCoordinates } from '../../common/coordinates';
import { asyncHandler, created, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './restaurant.service';
import * as branding from './restaurant-branding.service';

const uuid = z.string().uuid();
const sectionName = z.string().trim().min(2).max(120);

/* customer ------------------------------------------------------------------ */

export const restaurantRouter: Router = Router();

restaurantRouter.get(
  '/',
  validate({
    query: z
      .object({
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        // Food list filters: pure-veg / serves non-veg, restaurant / cafe.
        diet: z.enum(['VEG', 'NON_VEG']).optional(),
        type: z.enum(['RESTAURANT', 'CAFE']).optional(),
      })
      .refine((q) => (q.lat === undefined) === (q.lng === undefined), { message: 'Send both lat and lng, or neither.' })
      .superRefine(refineQueryCoordinates),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { lat, lng, diet, type } = validatedQuery<{ lat?: number; lng?: number; diet?: 'VEG' | 'NON_VEG'; type?: 'RESTAURANT' | 'CAFE' }>(req);
    ok(
      res,
      await service.listRestaurants(lat !== undefined && lng !== undefined ? { lat, lng } : null, {
        ...(diet ? { diet } : {}),
        ...(type ? { type } : {}),
      }),
    );
  }),
);

restaurantRouter.get(
  '/:sellerId',
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getRestaurantMenu(req.params['sellerId'] as string));
  }),
);

/* seller (restaurant) -------------------------------------------------------- */

export const sellerRestaurantRouter: Router = Router();

sellerRestaurantRouter.use('/menu-sections', attachSellerContext);

sellerRestaurantRouter.get(
  '/menu-sections',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listMenuSections(requireSellerId(req)));
  }),
);

sellerRestaurantRouter.post(
  '/menu-sections',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({
    body: z.object({
      name: sectionName,
      menuId: uuid.optional(),
      displayOrder: z.number().int().min(0).max(10_000).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createMenuSection(requireSellerId(req), req.body, requireUser(req).id));
  }),
);

sellerRestaurantRouter.put(
  '/menu-sections/order',
  requirePermission(Permission.SELLER_CATALOG_MANAGE),
  validate({ body: z.object({ menuId: uuid, ids: z.array(uuid).min(1).max(500) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.reorderMenuSections(requireSellerId(req), req.body.menuId, req.body.ids, requireUser(req).id));
  }),
);

/* admin ----------------------------------------------------------------------- */

export const adminRestaurantRouter: Router = Router();

adminRestaurantRouter.get(
  '/restaurants',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.listRestaurantsForAdmin());
  }),
);

/**
 * Admin-managed restaurant branding (logo / cover photo) — uploaded through
 * POST /admin/uploads/presign { purpose: 'restaurant' }, then attached here.
 */
const imageParams = z.object({ sellerId: uuid, kind: z.enum(['logo', 'cover']) });

adminRestaurantRouter.put(
  '/restaurants/:sellerId/images/:kind',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: imageParams, body: z.object({ key: z.string().trim().min(1).max(400) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const { sellerId, kind } = req.params as { sellerId: string; kind: 'logo' | 'cover' };
    ok(res, await branding.setRestaurantImage(sellerId, kind, req.body.key, requireUser(req).id));
  }),
);

adminRestaurantRouter.delete(
  '/restaurants/:sellerId/images/:kind',
  requirePermission(Permission.CATALOG_WRITE),
  validate({ params: imageParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const { sellerId, kind } = req.params as { sellerId: string; kind: 'logo' | 'cover' };
    ok(res, await branding.removeRestaurantImage(sellerId, kind, requireUser(req).id));
  }),
);

adminRestaurantRouter.get(
  '/restaurants/:sellerId',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getRestaurantForAdmin(req.params['sellerId'] as string));
  }),
);
