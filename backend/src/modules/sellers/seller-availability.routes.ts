/**
 * Seller availability — the seller's own Store Open/Closed switch, weekly
 * hours and date closures (`/seller/...`, own seller only), plus admin's
 * read-only view of every seller's effective availability.
 *
 * The seller body schema accepts `isAcceptingOrders` only: a seller can never
 * change `Seller.isActive` (admin deactivation) through here.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './seller-availability.service';
import * as locationService from './admin-seller.service';

const uuid = z.string().uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm.');

const hoursSchema = z.object({
  hours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        opensAt: time,
        closesAt: time,
        isClosed: z.boolean(),
      }),
    )
    .min(1)
    .max(7),
});

/* seller ---------------------------------------------------------------------- */

export const sellerAvailabilityRouter: Router = Router();

for (const path of ['/availability', '/hours', '/closures', '/location']) {
  sellerAvailabilityRouter.use(path, attachSellerContext);
}

sellerAvailabilityRouter.get(
  '/availability',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getAvailability(requireSellerId(req)));
  }),
);

sellerAvailabilityRouter.patch(
  '/availability',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ body: z.object({ isAcceptingOrders: z.boolean() }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const { isAcceptingOrders } = req.body as { isAcceptingOrders: boolean };
    ok(res, await service.setAcceptingOrders(requireSellerId(req), isAcceptingOrders, requireUser(req).id));
  }),
);

sellerAvailabilityRouter.get(
  '/hours',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    const a = await service.getAvailability(requireSellerId(req));
    ok(res, { timezone: a.timezone, hoursConfigured: a.hoursConfigured, hours: a.hours });
  }),
);

sellerAvailabilityRouter.put(
  '/hours',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ body: hoursSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { hours } = req.body as z.infer<typeof hoursSchema>;
    ok(res, await service.updateHours(requireSellerId(req), hours, requireUser(req).id));
  }),
);

sellerAvailabilityRouter.post(
  '/closures',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({
    body: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
      reason: z.string().trim().max(200).nullable().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.addClosure(requireSellerId(req), req.body, requireUser(req).id));
  }),
);

sellerAvailabilityRouter.delete(
  '/closures/:id',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.removeClosure(requireSellerId(req), req.params['id'] as string, requireUser(req).id));
  }),
);

/**
 * The seller's own location — the origin of every serviceability check, ETA
 * and delivery fee for its products. Address fields are optional; the
 * coordinates are required together. Audited (seller.update_location).
 */
const locationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    addressLine: z.string().trim().min(2).max(300).optional(),
    city: z.string().trim().min(2).max(80).optional(),
    state: z.string().trim().min(2).max(80).optional(),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits.').optional(),
    phone: z.string().trim().min(10).max(15).optional(),
  })
  .strict();

sellerAvailabilityRouter.get(
  '/location',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await locationService.getSellerLocation(requireSellerId(req)));
  }),
);

sellerAvailabilityRouter.patch(
  '/location',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ body: locationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await locationService.updateSellerLocation(requireSellerId(req), req.body, requireUser(req).id));
  }),
);

/* admin (read-only) ------------------------------------------------------------ */

export const adminAvailabilityRouter: Router = Router();

adminAvailabilityRouter.get(
  '/sellers/availability',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await service.listAvailability());
  }),
);

adminAvailabilityRouter.get(
  '/sellers/:sellerId/availability',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getAvailability(req.params['sellerId'] as string));
  }),
);
