import { Router } from 'express';
import { asyncHandler } from '../../common/response';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import * as controller from './catalog.controller';
import {
  categoryParamsSchema,
  listCategoriesQuerySchema,
  listProductsQuerySchema,
  productParamsSchema,
  railParamsSchema,
  railQuerySchema,
  searchQuerySchema,
  variantParamsSchema,
} from './catalog.validation';

/**
 * Catalogue reads are PUBLIC.
 *
 * Browsing must work before login and outside the delivery area: serviceability
 * gates *ordering*, not *looking*. Forcing a customer to register before they
 * can see whether the shop stocks what they want is the fastest way to lose
 * them, and an out-of-area visitor who can browse is a demand signal for the
 * next store (PRD §4.3).
 */
export const catalogRouter: Router = Router();

catalogRouter.get(
  '/categories',
  validate({ query: listCategoriesQuerySchema }),
  asyncHandler(controller.listCategories),
);

catalogRouter.get(
  '/categories/:id/subcategories',
  validate({ params: categoryParamsSchema }),
  asyncHandler(controller.listSubcategories),
);

// `/products/search` MUST be registered before `/products/:id`, or Express
// matches "search" as an id and the route 404s on an invalid uuid.
catalogRouter.get(
  '/products/search',
  validate({ query: searchQuerySchema }),
  asyncHandler(controller.searchProducts),
);

catalogRouter.get(
  '/products',
  validate({ query: listProductsQuerySchema }),
  asyncHandler(controller.listProducts),
);

// Registered before `/products/:id` for the same reason as `/products/search`
// above — Express matches by path shape only, but keeping the fixed segments
// together here avoids ever having to reason about it again.
catalogRouter.get(
  '/products/rail/:key',
  validate({ params: railParamsSchema, query: railQuerySchema }),
  asyncHandler(controller.listRailProducts),
);

catalogRouter.get(
  '/products/:id',
  validate({ params: productParamsSchema }),
  asyncHandler(controller.getProduct),
);

catalogRouter.get(
  '/products/:id/related',
  validate({ params: productParamsSchema }),
  asyncHandler(controller.getRelated),
);

catalogRouter.get('/home', asyncHandler(controller.getHomeFeed));

/**
 * POST /products/:variantId/notify-me
 *
 * Back-in-stock subscription for the out-of-stock screen. Requires auth —
 * there is nobody to notify otherwise.
 */
catalogRouter.post(
  '/products/:variantId/notify-me',
  authenticate,
  validate({ params: variantParamsSchema }),
  asyncHandler(controller.notifyMe),
);
