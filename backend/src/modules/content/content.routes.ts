/**
 * GET /api/v1/content/home-layout — the PUBLISHED Home page layout (Admin
 * Panel → Home Page Builder / Category Display), or the built-in defaults
 * while nothing is published. Public, like the Home feed itself; drafts are
 * only ever reachable through the admin routes. Revalidated on every
 * request (no-cache + ETag); the server keeps its own copy for a minute and
 * drops it the moment a new layout is published.
 */

import { Router, type Request, type Response } from 'express';
import { asyncHandler, ok } from '../../common/response';
import { getPublishedHomeLayout, getPublishedHomeShelves } from './home-layout.service';
import { getPublicBranding } from './branding.service';

export const contentRouter: Router = Router();

/**
 * GET /api/v1/branding — the published brand assets (Admin Panel → Branding &
 * Identity) every client shows: Admin and Seller Panel, website, customer app.
 * Public and read-only (any website may read it, without credentials — see
 * app.ts); only the dynamic assets, never the native-build icons. Cacheable
 * for a minute; the server's own copy is dropped the moment an admin publishes.
 */
export const brandingRouter: Router = Router();

brandingRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    ok(res, await getPublicBranding());
  }),
);

contentRouter.get(
  '/home-layout',
  asyncHandler(async (_req: Request, res: Response) => {
    // `no-cache`, not `max-age`: an HTTP cache (the phone's, or one in front
    // of the API) must ask again every time — with the ETag that is a cheap
    // 304 — so a section or category removed by a publish can never be
    // served from an older copy. The server's own copy is dropped on publish.
    res.setHeader('Cache-Control', 'no-cache');
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
