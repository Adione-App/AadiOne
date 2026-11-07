/**
 * Seller availability — the seller's own Store Open/Closed switch, weekly
 * hours and date closures (`/seller/...`, own seller only), plus admin's
 * view of every seller's effective availability and (SELLER_MANAGE) the same
 * controls for any seller, through the same service and the same rule.
 *
 * The seller body schema accepts `isAcceptingOrders` only: a seller can never
 * change `Seller.isActive` (admin deactivation) through here.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { isValidPincode } from '../../shared/phone';
import { asyncHandler, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './seller-availability.service';
import * as locationService from './admin-seller.service';
import * as disclosureService from './seller-disclosure.service';

/**
 * The customer-care contact a seller publishes (seller-disclosure.service.ts).
 * Empty string / null clears it. Shared with the admin route.
 */
export const customerCareSchema = z
  .object({
    customerCarePhone: z
      .string()
      .trim()
      .max(15)
      .refine((value) => value === '' || /^\+?[0-9][0-9 -]{6,13}$/.test(value), 'Enter a phone number, e.g. +91 98765 43210')
      .nullable()
      .optional(),
    customerCareEmail: z.string().trim().max(160).refine((value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter an email address').nullable().optional(),
  })
  .strict();

const uuid = z.string().uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm.');

const closureSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  reason: z.string().trim().max(200).nullable().optional(),
});

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

for (const path of ['/availability', '/hours', '/closures', '/location', '/disclosure']) {
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
  validate({ body: closureSchema }),
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
/** Shared with the admin correction route (admin-seller.routes.ts). */
export const locationSchema = z
  .object({
    // Validated by the service (shared coordinateProblem: range, (0, 0), swapped, India).
    latitude: z.number(),
    longitude: z.number(),
    addressLine: z.string().trim().min(2).max(300).optional(),
    locality: z.string().trim().max(160).nullable().optional(),
    city: z.string().trim().min(2, 'Enter the village, city or town').max(80).optional(),
    district: z.string().trim().min(2, 'Enter the district').max(80).nullable().optional(),
    state: z.string().trim().min(2).max(80).optional(),
    pincode: z.string().trim().refine(isValidPincode, 'Enter a valid 6-digit PIN code').optional(),
    landmark: z.string().trim().max(160).nullable().optional(),
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

/* admin -------------------------------------------------------------------------- */

/*
 * Reads need SELLER_ONBOARDING_REVIEW; every write needs SELLER_MANAGE. The
 * writes are the seller's own (same service, same validation, same audit
 * actions with the admin as actor, same realtime event): there is one
 * availability rule and one place each input is stored. Admin deactivation
 * (`isActive`) stays on PATCH /admin/sellers/:id/status.
 */

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

const sellerParams = z.object({ sellerId: uuid });

/** The seller's Accepting Orders switch, set by admin (e.g. a shop that phoned in). */
adminAvailabilityRouter.patch(
  '/sellers/:sellerId/availability',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: sellerParams, body: z.object({ isAcceptingOrders: z.boolean() }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const { isAcceptingOrders } = req.body as { isAcceptingOrders: boolean };
    ok(res, await service.setAcceptingOrders(req.params['sellerId'] as string, isAcceptingOrders, requireUser(req).id));
  }),
);

/** Weekly hours, and optionally the IANA timezone they are read in (admin only). */
adminAvailabilityRouter.put(
  '/sellers/:sellerId/hours',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: sellerParams, body: hoursSchema.extend({ timezone: z.string().trim().min(1).max(60).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { hours, timezone } = req.body as z.infer<typeof hoursSchema> & { timezone?: string };
    ok(res, await service.updateHours(req.params['sellerId'] as string, hours, requireUser(req).id, timezone));
  }),
);

adminAvailabilityRouter.post(
  '/sellers/:sellerId/closures',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: sellerParams, body: closureSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.addClosure(req.params['sellerId'] as string, req.body, requireUser(req).id));
  }),
);

adminAvailabilityRouter.delete(
  '/sellers/:sellerId/closures/:id',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: z.object({ sellerId: uuid, id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.removeClosure(req.params['sellerId'] as string, req.params['id'] as string, requireUser(req).id));
  }),
);

/* Seller disclosure (customer-care contact shown to customers) ------------- */

sellerAvailabilityRouter.get(
  '/disclosure',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await disclosureService.getSellerDisclosure(requireSellerId(req)));
  }),
);

sellerAvailabilityRouter.patch(
  '/disclosure',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ body: customerCareSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await disclosureService.updateSellerCustomerCare(requireSellerId(req), req.body, requireUser(req).id));
  }),
);
