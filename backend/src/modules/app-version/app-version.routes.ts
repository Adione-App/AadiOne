import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { APP_VERSION_HEADERS, AppPlatform, Permission, isValidVersion } from '../../shared';
import { badRequest } from '../../common/errors';
import { asyncHandler, ok } from '../../common/response';
import { requirePermission, requireUser } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as service from './app-version.service';

/* -------------------------------------------------------------------------- */
/* Public — the app asks what it must do                                      */
/* -------------------------------------------------------------------------- */

export const appVersionRouter: Router = Router();

/**
 * GET /api/v1/app-version/policy?platform=android&version=1.0.8
 *
 * PUBLIC and never version-gated: an app that must update has to be able to
 * learn that. Platform and version come from the query, else from the app's
 * own X-App-Platform / X-App-Version headers. Returns ONLY what the app needs
 * (AppUpdateCheckDto) — no admin metadata. Not cached by intermediaries: the
 * answer changes the moment an admin saves a policy.
 */
appVersionRouter.get(
  '/policy',
  validate({
    query: z.object({
      platform: z.enum([AppPlatform.ANDROID, AppPlatform.IOS]).optional(),
      version: z.string().trim().max(32).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as { platform?: 'android' | 'ios'; version?: string };
    const headerPlatform = req.header(APP_VERSION_HEADERS.PLATFORM)?.trim().toLowerCase();
    const platform =
      query.platform ?? (headerPlatform === AppPlatform.ANDROID || headerPlatform === AppPlatform.IOS ? headerPlatform : null);
    if (!platform) throw badRequest('platform must be android or ios');
    const version = query.version ?? req.header(APP_VERSION_HEADERS.VERSION)?.trim() ?? null;
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await service.checkForClient(platform, version && isValidVersion(version) ? version : null));
  }),
);

/* -------------------------------------------------------------------------- */
/* Admin — Admin → App Updates                                                */
/* -------------------------------------------------------------------------- */

export const adminAppVersionRouter: Router = Router();

/** GET /admin/app-update-policy — the saved policy (or the built-in default). */
adminAppVersionRouter.get(
  '/app-update-policy',
  requirePermission(Permission.CONFIG_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.getForAdmin());
  }),
);

/**
 * PUT /admin/app-update-policy — replaces the whole policy. Validated in full
 * by the shared rules (versions, minimum <= latest, official store links);
 * the per-field problems come back as error.details[] { field, message }.
 */
adminAppVersionRouter.put(
  '/app-update-policy',
  requirePermission(Permission.CONFIG_WRITE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.updatePolicy(req.body, requireUser(req).id, req.ip ?? null));
  }),
);
