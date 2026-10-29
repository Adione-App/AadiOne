/**
 * A seller's delivery area, for admin: the radius it delivers within and a
 * "would this point be delivered to?" check.
 *
 * ONE source of truth. The radius a customer is held to is
 * `Seller.maxServiceRadiusKm ?? MAX_SERVICE_RADIUS_KM` — exactly what
 * seller.service.ts `checkServiceability` applies at Home, quote and order
 * placement. This module only reads and writes the per-seller override and
 * runs that same check; it never decides serviceability on its own.
 *
 * Distances are straight-line (great-circle, Haversine) from the seller's own
 * map point. A 12 km radius is 12 km as the crow flies: the road trip can be
 * longer, which is why the delivery fee and ETA use ROAD_DISTANCE_FACTOR.
 */

import { ConfigKey, ErrorCode } from '../../shared';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '../../shared/distance';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { emitStoreAvailabilityChanged } from '../../realtime/socket';
import * as configService from '../configuration/configuration.service';
import { pointInServiceState } from '../addresses/service-state';
import * as sellerRepository from './seller.repository';
import * as sellerService from './seller.service';
import { DELIVERY_RADIUS_LIMIT_KM, isValidDeliveryRadiusKm } from './delivery-radius-limit';

export interface SellerDeliveryAreaDto {
  sellerId: string;
  sellerName: string;
  /** The store's map point — the origin of every distance. */
  latitude: number;
  longitude: number;
  /** False while the store has no usable point (never set, or (0, 0)). */
  storeLocationSet: boolean;
  /** This seller's own radius; null = the app-wide default applies. */
  maxServiceRadiusKm: number | null;
  /** MAX_SERVICE_RADIUS_KM — the app-wide default. */
  defaultRadiusKm: number;
  /** What customers are held to right now. */
  effectiveRadiusKm: number;
  radiusLimitKm: number;
  /** ROAD_DISTANCE_FACTOR — how the fee and ETA estimate the road trip. */
  roadDistanceFactor: number;
}

export interface DeliveryPointCheckDto {
  store: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  /** Straight-line km, rounded UP to 10 m (the same figure customers see). */
  distanceKm: number;
  effectiveRadiusKm: number;
  /** Inside the radius AND inside the service state — what checkout requires. */
  deliverable: boolean;
  insideRadius: boolean;
  insideServiceState: boolean;
  /** Straight line × ROAD_DISTANCE_FACTOR — an estimate, not a route. */
  estimatedRoadDistanceKm: number;
  deliveryFeePaise: number;
  /** Why not, in words, when not deliverable. */
  reason: string | null;
}

async function loadSeller(sellerId: string) {
  const seller = await sellerRepository.findSellerById(sellerId);
  if (!seller || seller.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return seller;
}

const hasPoint = (latitude: number, longitude: number): boolean => coordinateProblem(latitude, longitude) === null;

export async function getDeliveryArea(sellerId: string): Promise<SellerDeliveryAreaDto> {
  const seller = await loadSeller(sellerId);
  const { MAX_SERVICE_RADIUS_KM, ROAD_DISTANCE_FACTOR } = await configService.getMany([
    ConfigKey.MAX_SERVICE_RADIUS_KM,
    ConfigKey.ROAD_DISTANCE_FACTOR,
  ]);
  return {
    sellerId: seller.id,
    sellerName: seller.name,
    latitude: seller.latitude,
    longitude: seller.longitude,
    storeLocationSet: hasPoint(seller.latitude, seller.longitude),
    maxServiceRadiusKm: seller.maxServiceRadiusKm,
    defaultRadiusKm: MAX_SERVICE_RADIUS_KM,
    effectiveRadiusKm: seller.maxServiceRadiusKm ?? MAX_SERVICE_RADIUS_KM,
    radiusLimitKm: DELIVERY_RADIUS_LIMIT_KM,
    roadDistanceFactor: ROAD_DISTANCE_FACTOR,
  };
}

/**
 * Sets (a number of km) or clears (null — back to the app-wide default) this
 * seller's radius. Audited; takes effect on the very next request (nothing
 * caches the seller row).
 */
export async function setDeliveryRadius(
  sellerId: string,
  maxServiceRadiusKm: number | null,
  actorUserId: string,
): Promise<SellerDeliveryAreaDto> {
  if (maxServiceRadiusKm !== null && !isValidDeliveryRadiusKm(maxServiceRadiusKm)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `The delivery radius must be more than 0 and at most ${DELIVERY_RADIUS_LIMIT_KM} km.`,
      internalMessage: `bad radius ${maxServiceRadiusKm}`,
    });
  }
  const seller = await loadSeller(sellerId);
  if (seller.maxServiceRadiusKm !== maxServiceRadiusKm) {
    await prisma.$transaction([
      prisma.seller.update({ where: { id: sellerId }, data: { maxServiceRadiusKm } }),
      prisma.auditLog.create({
        data: {
          actorUserId,
          action: 'seller.update_delivery_radius',
          entityType: 'Seller',
          entityId: sellerId,
          before: { maxServiceRadiusKm: seller.maxServiceRadiusKm },
          after: { maxServiceRadiusKm },
        },
      }),
    ]);
    // Who can order from this store just changed: open apps re-check.
    emitStoreAvailabilityChanged(sellerId);
  }
  return getDeliveryArea(sellerId);
}

/**
 * Would an order from this seller be delivered to this point? The same rule
 * checkout applies (radius from the store's point + the service state), for
 * an admin to verify a store's pin and radius against a real address.
 */
export async function checkDeliveryPoint(sellerId: string, latitude: number, longitude: number): Promise<DeliveryPointCheckDto> {
  const problem = coordinateProblem(latitude, longitude);
  if (problem) {
    throw new AppError(ErrorCode.INVALID_COORDINATES, {
      message: COORDINATE_PROBLEM_MESSAGE[problem],
      internalMessage: `delivery check: ${latitude},${longitude} (${problem})`,
    });
  }
  const seller = await loadSeller(sellerId);
  if (!hasPoint(seller.latitude, seller.longitude)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 422,
      message: `${seller.name} has no store location yet, so no distance can be measured. Set its map point first.`,
    });
  }

  const check = await sellerService.checkServiceability(latitude, longitude, seller);
  const insideServiceState = pointInServiceState(latitude, longitude);
  const reason = !check.serviceable
    ? `${check.distanceKm} km in a straight line — beyond this store's ${check.maxRadiusKm} km radius.`
    : !insideServiceState
      ? 'Outside Rajasthan (or too near its border to confirm) — Aadione delivers only in Rajasthan.'
      : null;

  return {
    store: { latitude: seller.latitude, longitude: seller.longitude },
    destination: { latitude, longitude },
    distanceKm: check.distanceKm,
    effectiveRadiusKm: check.maxRadiusKm,
    deliverable: check.serviceable && insideServiceState,
    insideRadius: check.serviceable,
    insideServiceState,
    estimatedRoadDistanceKm: Math.round(check.roadDistanceKm * 100) / 100,
    deliveryFeePaise: check.deliveryFeePaise,
    reason,
  };
}
