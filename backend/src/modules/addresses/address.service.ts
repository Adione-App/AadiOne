/**
 * Addresses (Phase 7).
 *
 * Serviceability: the address's village / town / city and PIN code must be
 * an ACTIVE admin-approved pair (Configuration DELIVERY_LOCATIONS —
 * delivery-locations.ts). A new address, or an edit that changes the village
 * or PIN, is refused otherwise. The flag is stored on the row and evaluated
 * again whenever addresses are read (a pair the admin disables shows at
 * once) — display only: checkout and order creation check again, and that is
 * the authority. The distance (from the admin service location) only prices
 * the delivery fee and ETA.
 *
 * The point: the app's coordinates when it sends them (GPS, or the typed
 * village placed on the map); otherwise the admin service location stands in
 * as an approximate point (locationSource null) — there is no map step.
 */

import type { Address } from '@prisma/client';
import { ConfigKey, ErrorCode, type AddressDto } from '../../shared';
import { LOCATION_SOURCES, placeChanged, type LocationSource } from '../../shared/location';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import * as configService from '../configuration/configuration.service';
import * as sellerService from '../sellers/seller.service';
import { normalizeServiceState } from './service-state';
import { assertDeliveryPair, checkDeliveryPair } from './delivery-locations';

/** `current`: serviceability evaluated now (address lists); otherwise the row's stored answer. */
export function toAddressDto(address: Address, current?: { isServiceable: boolean; distanceKm: number }): AddressDto {
  return {
    id: address.id,
    label: address.label,
    fullName: address.fullName,
    mobile: address.mobile,
    houseNo: address.houseNo,
    street: address.street,
    area: address.area,
    city: address.city,
    district: address.district,
    state: address.state,
    pincode: address.pincode,
    landmark: address.landmark,
    latitude: address.latitude,
    longitude: address.longitude,
    // Only a recorded, known source; anything else reads as "not recorded".
    locationSource: (LOCATION_SOURCES as readonly string[]).includes(address.locationSource ?? '')
      ? (address.locationSource as LocationSource)
      : null,
    locationAccuracyM: address.locationAccuracyM,
    isDefault: address.isDefault,
    isServiceable: current?.isServiceable ?? address.isServiceable,
    distanceKm: current?.distanceKm ?? address.distanceKm,
    createdAt: address.createdAt.toISOString(),
  };
}

export interface UpsertAddressInput {
  label: string;
  fullName: string;
  mobile: string;
  houseNo?: string | null;
  street?: string | null;
  /** Locality / mohalla / colony — optional ('' when not given). */
  area?: string;
  city: string;
  district?: string | null;
  state: string;
  pincode: string;
  landmark?: string | null;
  /** Optional: without them the admin service location stands in (approximate). */
  latitude?: number;
  longitude?: number;
  locationSource?: LocationSource | null;
  locationAccuracyM?: number | null;
  isDefault?: boolean;
}

export async function listAddresses(userId: string): Promise<AddressDto[]> {
  const addresses = await prisma.address.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  // Against the admin's approved villages as they are NOW (a stored answer
  // may be from before a pair was added or disabled).
  return Promise.all(
    addresses.map(async (address) =>
      toAddressDto(address, await evaluateServiceability(address.city, address.pincode, address.latitude, address.longitude)),
    ),
  );
}

/**
 * Loads an address and proves it belongs to the caller.
 *
 * Every read of someone's address goes through here. Checking ownership in one
 * place is what stops an IDOR — a route guard only proves the caller is logged
 * in, not that this row is theirs.
 */
export async function getOwnedAddress(userId: string, addressId: string): Promise<Address> {
  const address = await prisma.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
  });
  if (!address) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Address not found.' });
  return address;
}

/**
 * Task 7.2 — serviceability is evaluated on every save (and on every read):
 * serviceable when (village, PIN) is an active approved pair. The distance
 * from the admin service location is kept for the fee / ETA display.
 * Checkout checks the address again.
 */
async function evaluateServiceability(
  city: string,
  pincode: string,
  latitude: number,
  longitude: number,
): Promise<{ isServiceable: boolean; distanceKm: number }> {
  const [pair, distanceKm] = await Promise.all([
    checkDeliveryPair(city, pincode),
    sellerService
      .checkServiceability(latitude, longitude)
      .then((check) => check.distanceKm)
      .catch(() => 0),
  ]);
  return { isServiceable: pair.verdict === 'APPROVED', distanceKm };
}

/**
 * The point for an address the app sent without coordinates (a typed address
 * the map could not place): the admin service location, as an approximate
 * point. Refused when even that is not set.
 */
async function fallbackPoint(): Promise<{ latitude: number; longitude: number }> {
  const origin = await sellerService.deliveryOrigin();
  if (!origin) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 422,
      message: 'We could not place this address on the map. Please try again, or use your current location.',
      internalMessage: 'address without coordinates and no PLATFORM_LOCATION to stand in',
    });
  }
  return { latitude: origin.latitude, longitude: origin.longitude };
}

export async function createAddress(
  userId: string,
  input: UpsertAddressInput,
): Promise<AddressDto> {
  const maxAddresses = await configService.get(ConfigKey.MAX_ADDRESSES_PER_USER);
  const count = await prisma.address.count({ where: { userId, deletedAt: null } });

  if (count >= maxAddresses) {
    throw new AppError(ErrorCode.ADDRESS_LIMIT_REACHED, {
      message: `You can save up to ${maxAddresses} addresses.`,
    });
  }

  // "rajasthan" / "राजस्थान" → "Rajasthan"; any other state is kept as given.
  const state = normalizeServiceState(input.state) ?? input.state;

  // Only an active admin-approved village + PIN pair is saved — whatever the
  // app sends — under the admin's own spelling of the village.
  const place = await assertDeliveryPair(input.city, input.pincode);

  const hasPoint = typeof input.latitude === 'number' && typeof input.longitude === 'number';
  const point = hasPoint ? { latitude: input.latitude!, longitude: input.longitude! } : await fallbackPoint();
  const locationSource = hasPoint ? (input.locationSource ?? null) : null;

  const serviceability = await evaluateServiceability(place.village, place.pincode, point.latitude, point.longitude);

  const address = await runInTransaction(async (tx) => {
    // First address is always the default; otherwise honour the request.
    const shouldBeDefault = input.isDefault === true || count === 0;

    if (shouldBeDefault) {
      // The partial unique index enforces one default per user, so the old one
      // must be cleared inside the same transaction.
      await tx.address.updateMany({
        where: { userId, isDefault: true, deletedAt: null },
        data: { isDefault: false },
      });
    }

    return tx.address.create({
      data: {
        userId,
        label: input.label,
        fullName: input.fullName,
        mobile: input.mobile,
        houseNo: input.houseNo ?? null,
        street: input.street ?? null,
        area: input.area ?? '',
        city: place.village,
        district: input.district ?? null,
        state,
        pincode: place.pincode,
        landmark: input.landmark ?? null,
        latitude: point.latitude,
        longitude: point.longitude,
        locationSource,
        // An accuracy only means something for a device fix.
        locationAccuracyM: locationSource === 'GPS' ? (input.locationAccuracyM ?? null) : null,
        isDefault: shouldBeDefault,
        isServiceable: serviceability.isServiceable,
        distanceKm: serviceability.distanceKm,
      },
    });
  });

  return toAddressDto(address);
}

export async function updateAddress(
  userId: string,
  addressId: string,
  input: Partial<UpsertAddressInput>,
): Promise<AddressDto> {
  const existing = await getOwnedAddress(userId, addressId);

  // A changed village or PIN must be an active approved pair (the admin's
  // spelling is stored). An edit that leaves them alone is allowed even for
  // an older address that is not (it stays undeliverable until changed).
  const villageOrPinChanged = input.city !== undefined || input.pincode !== undefined;
  const place = villageOrPinChanged
    ? await assertDeliveryPair(input.city ?? existing.city, input.pincode ?? existing.pincode)
    : { village: existing.city, pincode: existing.pincode };

  const sentPoint = typeof input.latitude === 'number' && typeof input.longitude === 'number';
  // The address now names a different village / district / state / PIN and
  // the app sent no new point (or echoed the old one): the old point belongs
  // to the old place, so it is replaced by the approximate stand-in.
  const placeMoved = placeChanged(existing, {
    city: place.village,
    district: input.district !== undefined ? input.district : existing.district,
    state: input.state ?? existing.state,
    pincode: place.pincode,
  });
  const echoedOldPoint = sentPoint && input.latitude === existing.latitude && input.longitude === existing.longitude;
  const replacePoint = placeMoved && (!sentPoint || echoedOldPoint);
  const point = replacePoint
    ? await fallbackPoint()
    : sentPoint
      ? { latitude: input.latitude!, longitude: input.longitude! }
      : { latitude: existing.latitude, longitude: existing.longitude };
  const latitude = point.latitude;
  const longitude = point.longitude;
  const pinMoved = replacePoint || latitude !== existing.latitude || longitude !== existing.longitude;

  const resultingState = input.state ?? existing.state;
  const state = normalizeServiceState(resultingState) ?? resultingState;
  // A moved point carries its new origin (unrecorded if the client did not say);
  // an unmoved point keeps its own unless the client confirms a new one.
  const locationSource = replacePoint
    ? null
    : pinMoved || input.locationSource !== undefined
      ? (input.locationSource ?? null)
      : existing.locationSource;
  const locationAccuracyM =
    locationSource === 'GPS'
      ? pinMoved || input.locationAccuracyM !== undefined
        ? (input.locationAccuracyM ?? null)
        : existing.locationAccuracyM
      : null;

  // Recomputed on every edit, against the approved villages as they are now
  // — an edited address that keeps a stale "serviceable" flag is how an
  // undeliverable order gets accepted.
  const serviceability = await evaluateServiceability(place.village, place.pincode, latitude, longitude);

  const address = await runInTransaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.address.updateMany({
        where: { userId, isDefault: true, deletedAt: null, id: { not: addressId } },
        data: { isDefault: false },
      });
    }

    return tx.address.update({
      where: { id: addressId },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
        ...(input.houseNo !== undefined ? { houseNo: input.houseNo } : {}),
        ...(input.street !== undefined ? { street: input.street } : {}),
        ...(input.area !== undefined ? { area: input.area } : {}),
        ...(villageOrPinChanged ? { city: place.village } : {}),
        ...(input.district !== undefined ? { district: input.district } : {}),
        ...(input.state !== undefined ? { state } : {}),
        ...(villageOrPinChanged ? { pincode: place.pincode } : {}),
        ...(input.landmark !== undefined ? { landmark: input.landmark } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        latitude,
        longitude,
        locationSource,
        locationAccuracyM,
        isServiceable: serviceability.isServiceable,
        distanceKm: serviceability.distanceKm,
      },
    });
  });

  return toAddressDto(address);
}

/**
 * Soft-deletes an address.
 *
 * Orders snapshot the delivery address at placement, so removing a saved
 * address never rewrites where a past order was sent.
 */
export async function deleteAddress(userId: string, addressId: string): Promise<void> {
  const address = await getOwnedAddress(userId, addressId);

  await runInTransaction(async (tx) => {
    await tx.address.update({
      where: { id: addressId },
      // isDefault is cleared too: the partial unique index counts only live
      // rows, but leaving a deleted row flagged default would confuse the UI.
      data: { deletedAt: new Date(), isDefault: false },
    });

    // Promote the most recent remaining address so the customer is never left
    // with no default and a checkout screen that cannot preselect anything.
    if (address.isDefault) {
      const next = await tx.address.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }
  });
}

export async function setDefaultAddress(
  userId: string,
  addressId: string,
): Promise<AddressDto> {
  await getOwnedAddress(userId, addressId);

  const address = await runInTransaction(async (tx) => {
    await tx.address.updateMany({
      where: { userId, isDefault: true, deletedAt: null },
      data: { isDefault: false },
    });
    return tx.address.update({ where: { id: addressId }, data: { isDefault: true } });
  });

  return toAddressDto(address);
}

/**
 * Refreshes the cached serviceability of every address for a user.
 * Called after the store location or radius changes.
 */
export async function refreshServiceability(userId: string): Promise<void> {
  const addresses = await prisma.address.findMany({ where: { userId, deletedAt: null } });
  for (const address of addresses) {
    const result = await evaluateServiceability(address.city, address.pincode, address.latitude, address.longitude);
    await prisma.address.update({
      where: { id: address.id },
      data: { isServiceable: result.isServiceable, distanceKm: result.distanceKm },
    });
  }
}
