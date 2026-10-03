/**
 * Seller location and weekly hours — shared by every seller, Aadione included.
 *
 * A seller's coordinates are the origin of every serviceability check, ETA
 * and delivery fee for that seller's products, so moving it silently changes
 * who can order from it. Every change is therefore audited with its before
 * and after. The seller sets it in the Seller Panel (`PATCH /seller/location`);
 * admin can also correct it on the seller's record (`PATCH /admin/sellers/:id`).
 *
 * Nothing caches the seller row, so an update here takes effect on the very
 * next request.
 */

import { prisma } from '../../infra/db/prisma';
import { AppError } from '../../common/errors';
import { ErrorCode, type SellerHoursDto } from '../../shared';
import { isValidCoordinates } from '../../shared/distance';
import * as sellerRepository from './seller.repository';

export interface UpdateSellerLocationInput {
  latitude: number;
  longitude: number;
  addressLine?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
}

export interface SellerLocationDto {
  id: string;
  name: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  phone: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
}

const LOCATION_SELECT = {
  id: true,
  name: true,
  addressLine: true,
  city: true,
  state: true,
  pincode: true,
  phone: true,
  latitude: true,
  longitude: true,
  timezone: true,
} as const;

export async function getSellerLocation(sellerId: string): Promise<SellerLocationDto> {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, deletedAt: null }, select: LOCATION_SELECT });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return seller;
}

export async function updateSellerLocation(
  sellerId: string,
  input: UpdateSellerLocationInput,
  actorUserId: string,
): Promise<SellerLocationDto> {
  if (!isValidCoordinates(input.latitude, input.longitude)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Those coordinates are not valid.',
      internalMessage: `rejected ${input.latitude},${input.longitude}`,
    });
  }

  // 0,0 is in the Atlantic. It is what a broken geolocation call produces, and
  // silently accepting it would make the whole town unserviceable.
  if (input.latitude === 0 && input.longitude === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Those coordinates look wrong (0, 0). Please set the location again.',
    });
  }

  const before = await getSellerLocation(sellerId);

  const after = await prisma.seller.update({
    where: { id: sellerId },
    data: {
      latitude: input.latitude,
      longitude: input.longitude,
      ...(input.addressLine !== undefined ? { addressLine: input.addressLine } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
    },
    select: LOCATION_SELECT,
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'seller.update_location',
      entityType: 'Seller',
      entityId: sellerId,
      before: { latitude: before.latitude, longitude: before.longitude, city: before.city, pincode: before.pincode },
      after: { latitude: after.latitude, longitude: after.longitude, city: after.city, pincode: after.pincode },
    },
  });

  return after;
}

/* -------------------------------------------------------------------------- */
/* Opening hours                                                              */
/* -------------------------------------------------------------------------- */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface UpdateSellerHoursInput {
  hours: SellerHoursDto[];
}

/**
 * A seller's weekly hours — the seller's own `PUT /seller/hours`.
 *
 * Partial by design: "apply these hours to every day" and "Sunday is now
 * closed" are the same call with a different number of entries, and a day the
 * operator did not touch is left exactly as it was.
 */
export async function saveWeeklyHours(
  sellerId: string,
  input: UpdateSellerHoursInput,
  actorUserId: string,
): Promise<void> {
  const seller = await sellerRepository.findSellerById(sellerId);
  if (!seller || seller.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

  const seen = new Set<number>();
  for (const entry of input.hours) {
    if (seen.has(entry.dayOfWeek)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Each day can only be set once.',
        internalMessage: `duplicate dayOfWeek ${entry.dayOfWeek}`,
      });
    }
    seen.add(entry.dayOfWeek);

    if (!TIME_PATTERN.test(entry.opensAt) || !TIME_PATTERN.test(entry.closesAt)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Opening and closing times must be in 24-hour HH:mm form.',
        internalMessage: `bad window ${entry.opensAt}-${entry.closesAt}`,
      });
    }

    // No further checks on the window itself: equal times mean "open 24 hours"
    // to `isWithinWindow`, and a closing time earlier than the opening time is
    // a window across midnight (08:00–01:00), which it already handles. Both
    // are things a real shop does, so neither is an error.
  }

  const before = seller.hours.map((h) => ({
    dayOfWeek: h.dayOfWeek,
    opensAt: h.opensAt,
    closesAt: h.closesAt,
    isClosed: h.isClosed,
  }));

  // Same projection as `before`, so the audit entry's two halves are directly
  // comparable and nothing beyond the four columns can ride along.
  const requested = input.hours.map((h) => ({
    dayOfWeek: h.dayOfWeek,
    opensAt: h.opensAt,
    closesAt: h.closesAt,
    isClosed: h.isClosed,
  }));

  // One transaction: a half-applied week would leave the shop open on days the
  // operator had just closed.
  await prisma.$transaction(
    requested.map((entry) =>
      prisma.sellerHours.upsert({
        where: { sellerId_dayOfWeek: { sellerId: seller.id, dayOfWeek: entry.dayOfWeek } },
        create: {
          sellerId: seller.id,
          dayOfWeek: entry.dayOfWeek,
          opensAt: entry.opensAt,
          closesAt: entry.closesAt,
          isClosed: entry.isClosed,
        },
        update: {
          opensAt: entry.opensAt,
          closesAt: entry.closesAt,
          isClosed: entry.isClosed,
        },
      }),
    ),
  );

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'seller.update_hours',
      entityType: 'Seller',
      entityId: seller.id,
      before: { hours: before },
      after: { hours: requested },
    },
  });
}
