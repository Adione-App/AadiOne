/**
 * Addresses (Phase 7).
 *
 * Serviceability is cached on the row so the address list renders without N
 * distance calculations — but it is ALWAYS recomputed at checkout and again at
 * order creation. The cached flag is display; the live check is authority.
 */

import type { Address } from '@prisma/client';
import { ConfigKey, ErrorCode, type AddressDto } from '../../shared';
import { LOCATION_SOURCES, type LocationSource } from '../../shared/location';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import * as configService from '../configuration/configuration.service';
import * as sellerService from '../sellers/seller.service';
import { assertServiceState, normalizeServiceState, serviceStateProblem } from './service-state';

export function toAddressDto(address: Address): AddressDto {
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
    // The cached radius answer AND Rajasthan-only, evaluated on read: an
    // older out-of-state address (cached before the rule) is never offered as
    // deliverable — and its row is left exactly as it is.
    isServiceable:
      address.isServiceable &&
      serviceStateProblem({ state: address.state, latitude: address.latitude, longitude: address.longitude }) === null,
    distanceKm: address.distanceKm,
    createdAt: address.createdAt.toISOString(),
  };
}

export interface UpsertAddressInput {
  label: string;
  fullName: string;
  mobile: string;
  houseNo?: string | null;
  street?: string | null;
  area: string;
  city: string;
  district?: string | null;
  state: string;
  pincode: string;
  landmark?: string | null;
  latitude: number;
  longitude: number;
  locationSource?: LocationSource | null;
  locationAccuracyM?: number | null;
  isDefault?: boolean;
}

export async function listAddresses(userId: string): Promise<AddressDto[]> {
  const addresses = await prisma.address.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  return addresses.map(toAddressDto);
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
 * Task 7.2 — serviceability is evaluated on every save: serviceable when at
 * least one live seller delivers there (distance to the nearest such seller).
 * Checkout re-checks every cart seller against the address.
 */
async function evaluateServiceability(
  latitude: number,
  longitude: number,
  state: string,
): Promise<{ isServiceable: boolean; distanceKm: number }> {
  const result = await sellerService.getServiceability(latitude, longitude);
  // getServiceability already refuses a point outside Rajasthan; the state
  // TEXT counts too, so an older out-of-state address never shows as deliverable.
  const inState = serviceStateProblem({ state, latitude, longitude }) === null;
  return { isServiceable: result.serviceable && inState, distanceKm: result.distanceKm };
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

  // Rajasthan only — the state AND the point. Unlike being beyond a seller's
  // radius (saved below, ordering blocked), an address outside Rajasthan can
  // never be delivered to, so it is not stored at all.
  assertServiceState(input, 'destination');
  const state = normalizeServiceState(input.state) ?? input.state;

  const serviceability = await evaluateServiceability(input.latitude, input.longitude, state);

  // An out-of-area address is SAVED rather than rejected: the customer may be
  // adding their parents' address for later, and refusing to store it teaches
  // them the app is broken. Ordering to it is what gets blocked.
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
        area: input.area,
        city: input.city,
        district: input.district ?? null,
        state,
        pincode: input.pincode,
        landmark: input.landmark ?? null,
        latitude: input.latitude,
        longitude: input.longitude,
        locationSource: input.locationSource ?? null,
        // An accuracy only means something for a device fix.
        locationAccuracyM: input.locationSource === 'GPS' ? (input.locationAccuracyM ?? null) : null,
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

  const latitude = input.latitude ?? existing.latitude;
  const longitude = input.longitude ?? existing.longitude;
  const pinMoved = latitude !== existing.latitude || longitude !== existing.longitude;

  // The address as it would be after this edit must be in Rajasthan. An older
  // out-of-state address is refused with a clear reason — never quietly
  // rewritten as Rajasthan; the customer can delete it or add a new one.
  const resultingState = input.state ?? existing.state;
  assertServiceState({ state: resultingState, latitude, longitude }, 'destination');
  const state = normalizeServiceState(resultingState) ?? resultingState;
  // A moved point carries its new origin (unrecorded if the client did not say);
  // an unmoved point keeps its own unless the client confirms a new one.
  const locationSource = pinMoved || input.locationSource !== undefined ? (input.locationSource ?? null) : existing.locationSource;
  const locationAccuracyM =
    locationSource === 'GPS'
      ? pinMoved || input.locationAccuracyM !== undefined
        ? (input.locationAccuracyM ?? null)
        : existing.locationAccuracyM
      : null;

  // Recompute whenever the pin moved — an edited address that keeps a stale
  // "serviceable" flag is how an undeliverable order gets accepted.
  const serviceability =
    pinMoved || state !== existing.state
      ? await evaluateServiceability(latitude, longitude, state)
      : { isServiceable: existing.isServiceable, distanceKm: existing.distanceKm ?? 0 };

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
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.district !== undefined ? { district: input.district } : {}),
        ...(input.state !== undefined ? { state } : {}),
        ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
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
    const result = await evaluateServiceability(address.latitude, address.longitude, address.state);
    await prisma.address.update({
      where: { id: address.id },
      data: { isServiceable: result.isServiceable, distanceKm: result.distanceKm },
    });
  }
}
