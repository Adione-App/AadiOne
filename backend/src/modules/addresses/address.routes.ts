import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { normalizeIndianMobile, isValidPincode } from '../../shared/phone';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '../../shared/distance';
import { LOCATION_SOURCES } from '../../shared/location';
import { asyncHandler, created, noContent, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { authenticate, requirePermission, requireUser } from '../../middleware/auth';
import * as service from './address.service';

const uuid = z.string().uuid();

const mobile = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeIndianMobile(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid 10-digit mobile number',
      });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * Address fields match the mockup exactly.
 *
 * `area` and `landmark` carry more weight than street or house number in this
 * market — "Near Shiv Mandir, Main Road" often IS the whole address, and it is
 * what the rider actually navigates by. So `area` is required while house
 * number and street are not.
 */
const addressFields = z.object({
  label: z.string().trim().min(1).max(30).default('Home'),
  fullName: z.string().trim().min(2, 'Enter the recipient name').max(120),
  mobile,
  houseNo: z.string().trim().max(80).nullable().optional(),
  street: z.string().trim().max(160).nullable().optional(),
  // Optional: the village / town + PIN pair is what places an address; a
  // locality / mohalla / colony helps the rider when the customer knows one.
  area: z.string().trim().max(160).optional(),
  city: z.string().trim().min(2, 'Enter the village, city or town').max(80),
  // Optional at the API so older app versions keep working; the current
  // forms require it.
  district: z.string().trim().min(2, 'Enter the district').max(80).nullable().optional(),
  state: z.string().trim().min(2, 'Choose the state').max(80),
  pincode: z
    .string()
    .trim()
    .refine(isValidPincode, 'Enter a valid 6-digit PIN code'),
  landmark: z.string().trim().max(160).nullable().optional(),
  // Optional: a typed address the map could not place is saved with the admin
  // service location as an approximate point (address.service fallbackPoint).
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  locationSource: z.enum(LOCATION_SOURCES).nullable().optional(),
  locationAccuracyM: z.number().finite().nonnegative().max(100_000).nullable().optional(),
  isDefault: z.boolean().optional(),
});

/** Coordinates: present together, valid, not (0, 0), not swapped, in India. */
function checkCoordinates(body: { latitude?: number; longitude?: number }, ctx: z.RefinementCtx): void {
  if (body.latitude === undefined && body.longitude === undefined) return;
  const problem = coordinateProblem(body.latitude, body.longitude, { requireIndia: true });
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['latitude'], message: COORDINATE_PROBLEM_MESSAGE[problem] });
}

const addressBody = addressFields.superRefine(checkCoordinates);

/**
 * An edit that changes where the address is may come without coordinates:
 * the old point then never stays attached to the new place — the server
 * replaces it with the approximate stand-in (address.service updateAddress).
 */
const addressPatchBody = addressFields.partial().superRefine(checkCoordinates);

export const addressRouter: Router = Router();

addressRouter.use(authenticate, requirePermission(Permission.ADDRESS_MANAGE));

addressRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listAddresses(requireUser(req).id));
  }),
);

addressRouter.post(
  '/',
  validate({ body: addressBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await service.createAddress(requireUser(req).id, req.body));
  }),
);

addressRouter.patch(
  '/:id',
  validate({ params: z.object({ id: uuid }), body: addressPatchBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await service.updateAddress(requireUser(req).id, req.params['id'] as string, req.body),
    );
  }),
);

addressRouter.delete(
  '/:id',
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.deleteAddress(requireUser(req).id, req.params['id'] as string);
    noContent(res);
  }),
);

addressRouter.post(
  '/:id/default',
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.setDefaultAddress(requireUser(req).id, req.params['id'] as string));
  }),
);
