/**
 * Where an order is delivered — the ONE place checkout and order placement
 * turn a request into a destination, so the quote and the order can never
 * disagree about it.
 *
 *   SAVED_ADDRESS  `addressId` — loaded through getOwnedAddress, so another
 *                  customer's address is a 404, never a delivery target.
 *   LIVE_LOCATION  `liveLocation` — a GPS point plus the recipient and the
 *                  address details the customer confirmed, for this order
 *                  only. Nothing is saved as an address. Coordinates are
 *                  validated here (not (0, 0), not swapped, in range, in
 *                  India); serviceability is then decided by the SAME seller
 *                  radius check as a saved address (seller.service).
 *
 * Nothing the client says about distance, eligibility or stores is read:
 * only the point and the text.
 */

import { z } from 'zod';
import { ConfigKey, DeliveryMode, ErrorCode, type LiveLocationInput } from '../../shared';
import { pincodeAllowed } from '../../shared/location';
import * as configService from '../configuration/configuration.service';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '../../shared/distance';
import { isValidPincode, normalizeIndianMobile } from '../../shared/phone';
import { AppError } from '../../common/errors';
import * as addressService from '../addresses/address.service';
import { assertServiceState, normalizeServiceState } from '../addresses/service-state';

/** Blank text → null, so "not given" has one representation. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));

const mobile = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeIndianMobile(value);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid 10-digit mobile number' });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * Required: the point, who receives it, and the village / city / town and
 * state. House / street, locality, district and PIN are optional — a
 * customer at a field or a new house may not know them, and the GPS point is
 * what the rider navigates to. A PIN that IS given must be valid.
 */
export const liveLocationSchema = z
  .object({
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    accuracyM: z.number().finite().nonnegative().max(100_000).nullable().optional(),
    fullName: z.string().trim().min(2, 'Enter the recipient name').max(120),
    mobile,
    houseNo: optionalText(80),
    street: optionalText(160),
    area: optionalText(160),
    city: z.string().trim().min(2, 'Enter the village, city or town').max(80),
    district: optionalText(80),
    state: z.string().trim().min(2, 'Enter the state').max(80),
    pincode: optionalText(6).refine((value) => value === null || isValidPincode(value), 'Enter a valid 6-digit PIN code'),
  })
  .superRefine((body, ctx) => {
    const problem = coordinateProblem(body.latitude, body.longitude, { requireIndia: true });
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['latitude'], message: COORDINATE_PROBLEM_MESSAGE[problem] });
  });

/** Exactly one of a saved address or a live location. */
export const deliveryDestinationFields = {
  addressId: z.string().uuid().optional(),
  liveLocation: liveLocationSchema.optional(),
};

export function requireOneDestination(body: { addressId?: unknown; liveLocation?: unknown }, ctx: z.RefinementCtx): void {
  const count = (body.addressId !== undefined ? 1 : 0) + (body.liveLocation !== undefined ? 1 : 0);
  if (count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['addressId'],
      message: 'Choose one delivery destination: a saved address or your current location.',
    });
  }
}

export type DestinationInput = { addressId: string } | { liveLocation: LiveLocationInput };

/** Picks the destination out of a validated request body. */
export function destinationFrom(body: { addressId?: string; liveLocation?: LiveLocationInput }): DestinationInput {
  if (body.liveLocation) return { liveLocation: body.liveLocation };
  if (body.addressId) return { addressId: body.addressId };
  throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose a delivery address or your current location.' });
}

/** What the order snapshot is written from, whichever mode it came from. */
export interface DeliveryDestination {
  mode: DeliveryMode;
  /** The saved address (SAVED_ADDRESS); always null for LIVE_LOCATION. */
  addressId: string | null;
  /** The saved address's label at order time; null for LIVE_LOCATION. */
  label: string | null;
  fullName: string;
  mobile: string;
  houseNo: string | null;
  street: string | null;
  area: string | null;
  landmark: string | null;
  city: string;
  district: string | null;
  state: string;
  /** '' when a live-location customer did not know it. */
  pincode: string;
  latitude: number;
  longitude: number;
  /** LIVE_LOCATION only — the device's accuracy radius. */
  accuracyM: number | null;
}

/**
 * The destination for a quote or an order — ALWAYS in Rajasthan (state AND
 * point, see service-state.ts). An older saved address outside Rajasthan is
 * refused here, and left exactly as it is.
 */
export async function resolveDestination(userId: string, input: DestinationInput): Promise<DeliveryDestination> {
  const destination = await readDestination(userId, input);
  assertServiceState(destination, 'destination');
  // The admin's approved PIN list (empty = none). It only rules a PIN out; a
  // live GPS point without a PIN is decided by its distance alone.
  if (destination.pincode) {
    const approved = await configService.get(ConfigKey.SERVICEABLE_PINCODES);
    if (!pincodeAllowed(destination.pincode, approved)) {
      throw new AppError(ErrorCode.OUT_OF_SERVICE_AREA, {
        message: `Sorry, we do not deliver to PIN code ${destination.pincode} yet.`,
      });
    }
  }
  return destination;
}

async function readDestination(userId: string, input: DestinationInput): Promise<DeliveryDestination> {
  if ('addressId' in input) {
    const address = await addressService.getOwnedAddress(userId, input.addressId);
    return {
      mode: DeliveryMode.SAVED_ADDRESS,
      addressId: address.id,
      label: address.label,
      fullName: address.fullName,
      mobile: address.mobile,
      houseNo: address.houseNo,
      street: address.street,
      area: address.area,
      landmark: address.landmark,
      city: address.city,
      district: address.district,
      state: address.state,
      pincode: address.pincode,
      latitude: address.latitude,
      longitude: address.longitude,
      accuracyM: null,
    };
  }

  // Re-validated here as well as at the route: this function is the gate
  // for anything that calls the order service directly.
  const parsed = liveLocationSchema.safeParse(input.liveLocation);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: parsed.error.issues[0]?.message ?? 'Check the delivery location details.',
    });
  }
  const live = parsed.data;
  return {
    mode: DeliveryMode.LIVE_LOCATION,
    addressId: null,
    label: null,
    fullName: live.fullName,
    mobile: live.mobile,
    houseNo: live.houseNo,
    street: live.street,
    area: live.area,
    landmark: null,
    city: live.city,
    district: live.district,
    // "rajasthan" / "राजस्थान" → "Rajasthan"; anything else is refused by the caller.
    state: normalizeServiceState(live.state) ?? live.state,
    pincode: live.pincode ?? '',
    latitude: live.latitude,
    longitude: live.longitude,
    accuracyM: live.accuracyM ?? null,
  };
}
