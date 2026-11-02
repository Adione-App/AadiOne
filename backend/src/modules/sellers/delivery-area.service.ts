/**
 * The delivery area, as admin sees it on a seller's page — and a "would this
 * point be delivered to?" check.
 *
 * ONE source of truth, the same for every seller: the admin-configured
 * location (Configuration PLATFORM_LOCATION — App Settings → Global
 * Availability) with the admin's radius (Configuration MAX_SERVICE_RADIUS_KM),
 * straight line, inclusive — exactly what seller.service.ts
 * `checkServiceability` applies at Home, quote and order placement. A
 * seller's own map point and its old per-seller radius (Seller.maxServiceRadiusKm,
 * kept in the database, no longer applied) never decide delivery.
 *
 * Distances are straight-line (great-circle, Haversine) from the admin
 * location. A 12 km radius is 12 km as the crow flies: the road trip can be
 * longer, which is why the delivery fee and ETA use ROAD_DISTANCE_FACTOR.
 */

import { ConfigKey, ErrorCode } from '../../shared';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '../../shared/distance';
import { AppError } from '../../common/errors';
import * as configService from '../configuration/configuration.service';
import * as sellerRepository from './seller.repository';
import * as sellerService from './seller.service';
import { DELIVERY_RADIUS_LIMIT_KM } from './delivery-radius-limit';

export interface SellerDeliveryAreaDto {
  sellerId: string;
  sellerName: string;
  /** The admin-configured location — the origin of every distance ((0, 0) while not set). */
  latitude: number;
  longitude: number;
  /** The admin location's name (Global Availability), when given. */
  originName: string | null;
  /** False while no admin location is set: nobody can order. */
  areaConfigured: boolean;
  /** Same as `areaConfigured` (kept for older admin panels). */
  storeLocationSet: boolean;
  /** This seller's old own radius — stored, no longer applied. */
  maxServiceRadiusKm: number | null;
  /** MAX_SERVICE_RADIUS_KM — the delivery radius. */
  defaultRadiusKm: number;
  /** What customers are held to right now (= MAX_SERVICE_RADIUS_KM). */
  effectiveRadiusKm: number;
  radiusLimitKm: number;
  /** ROAD_DISTANCE_FACTOR — how the fee and ETA estimate the road trip. */
  roadDistanceFactor: number;
}

export interface DeliveryPointCheckDto {
  /** The admin location the distance is measured from (kept as `store` for older admin panels). */
  store: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  /** Straight-line km, rounded UP to 10 m (the same figure customers see). */
  distanceKm: number;
  effectiveRadiusKm: number;
  /** Inside the admin's delivery area — what checkout requires. */
  deliverable: boolean;
  insideRadius: boolean;
  /** Always true: no state is hardcoded (kept for older admin panels). */
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

const AREA_NOT_SET =
  'No delivery area is set: nobody can order. Set the service location in App Settings → Global Availability.';

export async function getDeliveryArea(sellerId: string): Promise<SellerDeliveryAreaDto> {
  const seller = await loadSeller(sellerId);
  const [origin, { MAX_SERVICE_RADIUS_KM, ROAD_DISTANCE_FACTOR }] = await Promise.all([
    sellerService.deliveryOrigin(),
    configService.getMany([ConfigKey.MAX_SERVICE_RADIUS_KM, ConfigKey.ROAD_DISTANCE_FACTOR]),
  ]);
  return {
    sellerId: seller.id,
    sellerName: seller.name,
    latitude: origin?.latitude ?? 0,
    longitude: origin?.longitude ?? 0,
    originName: origin?.name ?? null,
    areaConfigured: origin !== null,
    storeLocationSet: origin !== null,
    maxServiceRadiusKm: seller.maxServiceRadiusKm,
    defaultRadiusKm: MAX_SERVICE_RADIUS_KM,
    effectiveRadiusKm: MAX_SERVICE_RADIUS_KM,
    radiusLimitKm: DELIVERY_RADIUS_LIMIT_KM,
    roadDistanceFactor: ROAD_DISTANCE_FACTOR,
  };
}

/**
 * A per-seller radius no longer exists: the delivery area is the admin's one
 * area (Global Availability location + its radius). Refused with where to
 * change it instead — never silently stored as if it did something.
 */
export async function setDeliveryRadius(
  sellerId: string,
  _maxServiceRadiusKm: number | null,
  _actorUserId: string,
): Promise<SellerDeliveryAreaDto> {
  await loadSeller(sellerId);
  throw new AppError(ErrorCode.VALIDATION_ERROR, {
    status: 422,
    message:
      'Stores no longer have their own delivery radius. Delivery is decided by the service location and delivery radius in App Settings → Global Availability, the same for every store.',
    internalMessage: `per-seller radius change refused for ${sellerId}`,
  });
}

/**
 * Would an order be delivered to this point? The same rule checkout applies
 * (inside the admin's delivery area), for an admin to verify a real address.
 * The seller does not change the answer.
 */
export async function checkDeliveryPoint(sellerId: string, latitude: number, longitude: number): Promise<DeliveryPointCheckDto> {
  const problem = coordinateProblem(latitude, longitude);
  if (problem) {
    throw new AppError(ErrorCode.INVALID_COORDINATES, {
      message: COORDINATE_PROBLEM_MESSAGE[problem],
      internalMessage: `delivery check: ${latitude},${longitude} (${problem})`,
    });
  }
  await loadSeller(sellerId);
  const origin = await sellerService.deliveryOrigin();
  if (!origin) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { status: 422, message: AREA_NOT_SET });
  }

  const check = await sellerService.checkServiceability(latitude, longitude);
  return {
    store: { latitude: origin.latitude, longitude: origin.longitude },
    destination: { latitude, longitude },
    distanceKm: check.distanceKm,
    effectiveRadiusKm: check.maxRadiusKm,
    deliverable: check.serviceable,
    insideRadius: check.serviceable,
    insideServiceState: true,
    estimatedRoadDistanceKm: Math.round(check.roadDistanceKm * 100) / 100,
    deliveryFeePaise: check.deliveryFeePaise,
    reason: check.serviceable
      ? null
      : `${check.distanceKm} km in a straight line from the service location — beyond the ${check.maxRadiusKm} km delivery radius.`,
  };
}
