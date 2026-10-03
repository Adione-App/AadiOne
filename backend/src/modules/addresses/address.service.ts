/**
 * Addresses (Phase 7).
 *
 * Serviceability is cached on the row so the address list renders without N
 * distance calculations — but it is ALWAYS recomputed at checkout and again at
 * order creation. The cached flag is display; the live check is authority.
 */

import type { Address } from '@prisma/client';
import { ConfigKey, ErrorCode, type AddressDto } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import * as configService from '../configuration/configuration.service';
import * as sellerService from '../sellers/seller.service';

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
    state: address.state,
    pincode: address.pincode,
    landmark: address.landmark,
    latitude: address.latitude,
    longitude: address.longitude,
    isDefault: address.isDefault,
    isServiceable: address.isServiceable,
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
  state: string;
  pincode: string;
  landmark?: string | null;
  latitude: number;
  longitude: number;
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
): Promise<{ isServiceable: boolean; distanceKm: number }> {
  const result = await sellerService.getServiceability(latitude, longitude);
  return { isServiceable: result.serviceable, distanceKm: result.distanceKm };
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

  const serviceability = await evaluateServiceability(input.latitude, input.longitude);

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
        state: input.state,
        pincode: input.pincode,
        landmark: input.landmark ?? null,
        latitude: input.latitude,
        longitude: input.longitude,
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

  // Recompute whenever the pin moved — an edited address that keeps a stale
  // "serviceable" flag is how an undeliverable order gets accepted.
  const serviceability =
    latitude !== existing.latitude || longitude !== existing.longitude
      ? await evaluateServiceability(latitude, longitude)
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
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
        ...(input.landmark !== undefined ? { landmark: input.landmark } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        latitude,
        longitude,
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
    const result = await evaluateServiceability(address.latitude, address.longitude);
    await prisma.address.update({
      where: { id: address.id },
      data: { isServiceable: result.isServiceable, distanceKm: result.distanceKm },
    });
  }
}
