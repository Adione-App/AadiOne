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
  area: z.string().trim().min(2, 'Enter your locality, mohalla or colony').max(160),
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
  latitude: z.number(),
  longitude: z.number(),
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

/** Parts of the address that say WHERE it is. */
const LOCATION_TEXT_FIELDS = ['houseNo', 'street', 'area', 'city', 'district', 'state', 'pincode'] as const;

/**
 * An edit that changes where the address is must send the matching
 * coordinates too — otherwise the old point (and its serviceability) would
 * silently stay attached to a different address. The apps always send both.
 */
const addressPatchBody = addressFields.partial().superRefine((body, ctx) => {
  checkCoordinates(body, ctx);
  const movesText = LOCATION_TEXT_FIELDS.some((key) => body[key] !== undefined);
  if (movesText && (body.latitude === undefined || body.longitude === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['latitude'],
      message: 'When you change the address, confirm its location on the map too.',
    });
  }
});

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
