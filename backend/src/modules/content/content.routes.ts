/**
 * GET /api/v1/content/home-layout — the PUBLISHED Home page layout (Admin
 * Panel → Home Page Builder / Category Display), or the built-in defaults
 * while nothing is published. Public, like the Home feed itself; drafts are
 * only ever reachable through the admin routes. Cacheable for a minute.
 */

import { Router, type Request, type Response } from 'express';
import { asyncHandler, ok } from '../../common/response';
import { getPublishedHomeLayout, getPublishedHomeShelves } from './home-layout.service';

export const contentRouter: Router = Router();

contentRouter.get(
  '/home-layout',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    ok(res, await getPublishedHomeLayout());
  }),
);

/**
 * GET /api/v1/content/home-shelves — the products of the published layout's
 * product shelves (Home Page Builder), keyed by section id. Resolved live on
 * every request (prices and stock are never cached), so it is not cacheable.
 */
contentRouter.get(
  '/home-shelves',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await getPublishedHomeShelves());
  }),
);
