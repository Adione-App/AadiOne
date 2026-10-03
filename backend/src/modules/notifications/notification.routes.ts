/**
 * Notification feeds. Three audiences, one set of endpoints each:
 *
 *   /notifications          the caller's CUSTOMER feed (any signed-in user)
 *   /seller/notifications   the caller's SELLER feed, for the seller the
 *                           request acts as (attachSellerContext) — a user
 *                           staffing two sellers sees each feed separately
 *   /admin/notifications    the caller's ADMIN feed (admin router's guards)
 *
 * Every read/write is scoped to (req.user, audience[, req.sellerId]) — a
 * notification id belonging to anyone/anything else is NOT_FOUND.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { NotificationAudience, PAGINATION_MAX_LIMIT } from '../../shared';
import { asyncHandler, noContent, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { authenticate, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './notification.service';

const listQuery = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(20),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/** Mounts list / unread-count / read / read-all on `router` under `prefix`. */
function mountFeed(router: Router, prefix: string, scopeOf: (req: Request) => service.FeedScope): void {
  const base = prefix === '/' ? '' : prefix;
  router.get(
    prefix,
    validate({ query: listQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const q = validatedQuery<{ cursor?: string; limit: number; unreadOnly: boolean }>(req);
      okCursorPage(res, await service.listFeed(scopeOf(req), { cursor: q.cursor ?? null, limit: q.limit, unreadOnly: q.unreadOnly }));
    }),
  );
  router.get(
    `${base}/unread-count`,
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await service.unreadCount(scopeOf(req)));
    }),
  );
  router.post(
    `${base}/read-all`,
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await service.markAllRead(scopeOf(req)));
    }),
  );
  router.post(
    `${base}/:id/read`,
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req: Request, res: Response) => {
      await service.markRead(scopeOf(req), req.params['id'] as string);
      noContent(res);
    }),
  );
}

/* customer ---------------------------------------------------------------------- */

export const notificationRouter: Router = Router();
notificationRouter.use(authenticate);
mountFeed(notificationRouter, '/', (req) => ({ userId: requireUser(req).id, audience: NotificationAudience.CUSTOMER }));

/* seller (mounted in the /seller chain) --------------------------------------------- */

export const sellerNotificationRouter: Router = Router();
sellerNotificationRouter.use('/notifications', attachSellerContext);
mountFeed(sellerNotificationRouter, '/notifications', (req) => ({
  userId: requireUser(req).id,
  audience: NotificationAudience.SELLER,
  sellerId: requireSellerId(req),
}));

/* admin (mounted in the /admin router, behind authenticate + requireAdmin) ----------- */

export const adminNotificationRouter: Router = Router();
mountFeed(adminNotificationRouter, '/notifications', (req) => ({ userId: requireUser(req).id, audience: NotificationAudience.ADMIN }));

/* devices ------------------------------------------------------------------------------ */

export const deviceRouter: Router = Router();
deviceRouter.use(authenticate);

/** Registers a push token. Upserted on the token so a reinstall moves it. */
deviceRouter.post(
  '/',
  validate({
    body: z.object({
      token: z.string().trim().min(10).max(400),
      platform: z.enum(['ANDROID', 'IOS', 'WEB']),
      appVersion: z.string().trim().max(20).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      token: string;
      platform: 'ANDROID' | 'IOS' | 'WEB';
      appVersion?: string;
    };
    await service.registerDevice({ userId: requireUser(req).id, ...body });
    noContent(res);
  }),
);
