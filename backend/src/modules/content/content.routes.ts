/**
 * GET /api/v1/content/home-layout — the PUBLISHED Home page layout (Admin
 * Panel → Home Page Builder / Category Display), or the built-in defaults
 * while nothing is published. Public, like the Home feed itself; drafts are
 * only ever reachable through the admin routes. Cacheable for a minute.
 */

import { Router, type Request, type Response } from 'express';
import { asyncHandler, ok } from '../../common/response';
import { getPublishedHomeLayout } from './home-layout.service';

export const contentRouter: Router = Router();

contentRouter.get(
  '/home-layout',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    ok(res, await getPublishedHomeLayout());
  }),
);
