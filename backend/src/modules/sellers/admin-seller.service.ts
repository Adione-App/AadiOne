/**
 * Seller location and weekly hours — shared by every seller, Aadione included.
 *
 * A seller's coordinates are the origin of every serviceability check, ETA
 * and delivery fee for that seller's products, so moving it silently changes
 * who can order from it. Every change is therefore audited with its before
 * and after. The seller sets it in the Seller Panel (`PATCH /seller/location`);
 * admin can also correct it (`PATCH /admin/sellers/:id/location`), and only
 * admin can change the store's display name there.
 *
 * Nothing caches the seller row, so an update here takes effect on the very
 * next request.
 */

import { prisma } from '../../infra/db/prisma';
import { AppError } from '../../common/errors';
import { ErrorCode, type SellerHoursDto } from '../../shared';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '../../shared/distance';
import * as sellerRepository from './seller.repository';
import { assertServiceState } from '../addresses/service-state';
import { isValidTimeZone } from '../configuration/configuration.service';
import { emitStoreAvailabilityChanged } from '../../realtime/socket';

export interface UpdateSellerLocationInput {
  /** Store display name — admin route only (the seller's schema has no `name`). */
  name?: string;
  latitude: number;
  longitude: number;
  addressLine?: string;
  locality?: string | null;
  city?: string;
  district?: string | null;
  state?: string;
  landmark?: string | null;
  pincode?: string;
  phone?: string;
}

export interface SellerLocationDto {
  id: string;
  name: string;
  /** Shop / building and street. */
  addressLine: string;
  locality: string | null;
  /** Village / city / town. */
  city: string;
  district: string | null;
  state: string;
  pincode: string;
  landmark: string | null;
  phone: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
}

const LOCATION_SELECT = {
  id: true,
  name: true,
  addressLine: true,
  locality: true,
  city: true,
  district: true,
  state: true,
  pincode: true,
  landmark: true,
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
  // Invalid, (0, 0) — what a broken geolocation call produces — swapped, or
  // outside India: any of these would make every distance from this store wrong.
  const problem = coordinateProblem(input.latitude, input.longitude, { requireIndia: true });
  if (problem) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: COORDINATE_PROBLEM_MESSAGE[problem],
      internalMessage: `rejected ${input.latitude},${input.longitude} (${problem})`,
    });
  }

  const before = await getSellerLocation(sellerId);

  // Rajasthan only: the store's resulting state AND point.
  assertServiceState({ state: input.state ?? before.state, latitude: input.latitude, longitude: input.longitude }, 'store');

  // The point, the address and their audit row land together or not at all.
  const saved = await prisma.$transaction(async (tx) => {
    const after = await tx.seller.update({
      where: { id: sellerId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        latitude: input.latitude,
        longitude: input.longitude,
        ...(input.addressLine !== undefined ? { addressLine: input.addressLine } : {}),
        ...(input.locality !== undefined ? { locality: input.locality } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.district !== undefined ? { district: input.district } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.landmark !== undefined ? { landmark: input.landmark } : {}),
        ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
      },
      select: LOCATION_SELECT,
    });

    const renamed = after.name !== before.name;
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'seller.update_location',
        entityType: 'Seller',
        entityId: sellerId,
        before: { latitude: before.latitude, longitude: before.longitude, city: before.city, district: before.district, pincode: before.pincode, ...(renamed ? { name: before.name } : {}) },
        after: { latitude: after.latitude, longitude: after.longitude, city: after.city, district: after.district, pincode: after.pincode, ...(renamed ? { name: after.name } : {}) },
      },
    });
    return after;
  });
  // Who this store delivers to may have changed: open apps ask again.
  if (saved.latitude !== before.latitude || saved.longitude !== before.longitude) emitStoreAvailabilityChanged(sellerId);
  return saved;
}

export interface AdminSellerLocationDto extends SellerLocationDto {
  /** The latest audited change of this store's point / address (seller or admin), if any. */
  lastChange: { at: string; byName: string | null; byRole: string | null } | null;
}

/** GET /admin/sellers/:id/location — the location plus who last changed it and when. */
export async function getAdminSellerLocation(sellerId: string): Promise<AdminSellerLocationDto> {
  const location = await getSellerLocation(sellerId);
  const last = await prisma.auditLog.findFirst({
    where: { entityType: 'Seller', entityId: sellerId, action: 'seller.update_location' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, actor: { select: { fullName: true, role: true } } },
  });
  return {
    ...location,
    lastChange: last ? { at: last.createdAt.toISOString(), byName: last.actor?.fullName ?? null, byRole: last.actor?.role ?? null } : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Opening hours                                                              */
/* -------------------------------------------------------------------------- */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface UpdateSellerHoursInput {
  hours: SellerHoursDto[];
  /**
   * The IANA timezone the hours are read in (admin only — `PUT
   * /admin/sellers/:id/hours`). Absent: unchanged.
   */
  timezone?: string;
}

/**
 * A seller's weekly hours — the seller's own `PUT /seller/hours`, and the
 * admin's `PUT /admin/sellers/:id/hours` (which may also set the timezone).
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

  if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Choose a valid timezone, e.g. Asia/Kolkata.',
      internalMessage: `bad timezone ${input.timezone}`,
    });
  }
  const timezoneChanged = input.timezone !== undefined && input.timezone !== seller.timezone;

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
  // The timezone changes with them: hours read in the wrong zone are wrong hours.
  await prisma.$transaction([
    ...(timezoneChanged ? [prisma.seller.update({ where: { id: seller.id }, data: { timezone: input.timezone } })] : []),
    ...requested.map((entry) =>
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
    prisma.auditLog.create({
      data: {
        actorUserId,
        action: 'seller.update_hours',
        entityType: 'Seller',
        entityId: seller.id,
        before: { hours: before, ...(timezoneChanged ? { timezone: seller.timezone } : {}) },
        after: { hours: requested, ...(timezoneChanged ? { timezone: input.timezone } : {}) },
      },
    }),
  ]);
}
