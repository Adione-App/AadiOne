/**
 * Restaurant routes (V2 food module) — three audiences, three routers:
 *
 *   restaurantRouter        /restaurants              public, customer-facing
 *   sellerRestaurantRouter  /seller/menu-sections     a restaurant's own menu
 *   adminRestaurantRouter   /admin/restaurants        cross-restaurant view
 *
 * A restaurant's profile (cuisine / veg-only / prep time) is managed through
 * seller onboarding (`PUT /seller/onboarding/restaurant-profile`), and its
 * menu items through the existing seller catalog + approval + listing routes.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, created, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './restaurant.service';

const uuid = z.string().uuid();

/* customer ------------------------------------------------------------------ */

export const restaurantRouter: Router = Router();

restaurantRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.listRestaurants());
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
      name: z.string().trim().min(2).max(120),
      displayOrder: z.number().int().min(0).max(10_000).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createMenuSection(requireSellerId(req), req.body));
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

adminRestaurantRouter.get(
  '/restaurants/:sellerId',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getRestaurantForAdmin(req.params['sellerId'] as string));
  }),
);
