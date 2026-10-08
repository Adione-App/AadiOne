/**
 * Serviceability, opening hours and ETA — per seller.
 *
 * THE BACKEND IS THE AUTHORITY. The mobile app may call
 * `checkServiceability` from the shared package to render "3.2 km away", but
 * every decision that gates an order is made here and re-made at order
 * creation. A client's answer is display, never permission.
 *
 * `MAX_SERVICE_RADIUS_KM` is read from Configuration on every evaluation, so
 * changing the radius in the admin panel takes effect without a redeploy and
 * without a literal `10` anywhere in this file.
 *
 * There is no special "platform store": every distance is measured from the
 * seller's OWN location (Seller.latitude/longitude, set by the seller in the
 * Seller Panel or by admin). "Can I order here?" means "does at least one live
 * seller deliver here"; checkout then requires EVERY seller in the cart to
 * deliver to the address.
 */

import { ConfigKey, ErrorCode, type ServiceabilityResult } from '../../shared';
import {
  checkServiceability as checkServiceabilityPure,
  estimateDeliveryTime,
  isValidCoordinates,
  resolveDeliveryFeePaise,
  toRoadDistanceKm,
  type EtaResult,
} from '../../shared/distance';
import {
  formatTime12h,
  getZonedParts,
  isWithinWindow,
  minutesSinceMidnight,
  parseTimeToMinutes,
} from '../../shared/datetime';
import { AppError } from '../../common/errors';
import * as configService from '../configuration/configuration.service';
import * as repository from './seller.repository';
import type { SellerWithHours } from './seller.repository';

export type { SellerWithHours };

/* -------------------------------------------------------------------------- */
/* Task 3.3 — opening hours                                                   */
/* -------------------------------------------------------------------------- */

export interface SellerOpenState {
  /** False whenever the seller is paused, closed for the day, or out of hours. */
  isOpen: boolean;
  /** Today's window in local time, null when closed all day. */
  todayOpensAt: string | null;
  todayClosesAt: string | null;
  /** Human-readable next opening, for the "Store Closed" screen. */
  nextOpenText: string | null;
}

export type AvailabilityClosedReason =
  | 'SELLER_DELETED'
  | 'SELLER_INACTIVE'
  | 'MANUALLY_CLOSED'
  | 'CLOSURE'
  | 'CLOSED_TODAY'
  | 'OUTSIDE_HOURS';

export interface SellerAvailability {
  /** Open under the full priority chain below. */
  isOpen: boolean;
  closedReason: AvailabilityClosedReason | null;
  /**
   * Whether an order may be placed right now: `isOpen`, or — for a closure
   * or out-of-hours state only — `ALLOW_ORDERS_WHEN_CLOSED` (the seller's own
   * override, else the global value) is on. Never overrides deletion, admin
   * deactivation or the seller's own OFF switch.
   */
  acceptingOrders: boolean;
  isActive: boolean;
  isAcceptingOrders: boolean;
  /** False when the seller has never saved a weekly schedule. */
  hoursConfigured: boolean;
  todayOpensAt: string | null;
  todayClosesAt: string | null;
  nextOpenText: string | null;
}

/**
 * THE seller availability rule, in the seller's own timezone. Priority:
 *
 *   1. deleted / admin-inactive (`isActive`)         -> CLOSED
 *   2. seller's own switch OFF (`isAcceptingOrders`) -> CLOSED, indefinitely:
 *      nothing resets it; it stays OFF across days until switched ON
 *   3. a SellerClosure on today's local date         -> CLOSED
 *   4. weekly SellerHours                            -> OPEN inside, CLOSED outside
 *      (a configured schedule with no row for today = closed today).
 *      A seller with NO weekly schedule saved has no hour restriction — that
 *      preserves how every seller without hours behaved before hours were
 *      enforced per seller.
 *
 * Onboarding approval is NOT part of availability — it is an orderability
 * rule (cart/orderability.ts).
 */
export async function evaluateSellerAvailability(
  seller: SellerWithHours,
  now: Date = new Date(),
): Promise<SellerAvailability> {
  const base = {
    isActive: seller.isActive,
    isAcceptingOrders: seller.isAcceptingOrders,
    hoursConfigured: seller.hours.length > 0,
    todayOpensAt: null as string | null,
    todayClosesAt: null as string | null,
    nextOpenText: null as string | null,
  };
  const closed = (reason: AvailabilityClosedReason): SellerAvailability => ({
    ...base,
    isOpen: false,
    closedReason: reason,
    acceptingOrders: false,
  });

  if (seller.deletedAt) return closed('SELLER_DELETED');
  if (!seller.isActive) return closed('SELLER_INACTIVE');
  // No `nextOpenText`: a manually closed seller is not on a timetable.
  if (!seller.isAcceptingOrders) return closed('MANUALLY_CLOSED');

  const parts = getZonedParts(now, seller.timezone);
  const nowMinutes = minutesSinceMidnight(parts);
  const allowWhenClosed = await configService.get(ConfigKey.ALLOW_ORDERS_WHEN_CLOSED, seller.id);
  const scheduleClosed = (
    reason: AvailabilityClosedReason,
    extra: Partial<typeof base> = {},
  ): SellerAvailability => ({
    ...base,
    ...extra,
    isOpen: false,
    closedReason: reason,
    acceptingOrders: allowWhenClosed,
  });

  const localMidnightUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (await repository.hasClosureOn(seller.id, localMidnightUtc)) {
    return scheduleClosed('CLOSURE', { nextOpenText: describeNextOpening(seller, parts.weekday) });
  }

  if (!base.hoursConfigured) {
    return { ...base, isOpen: true, closedReason: null, acceptingOrders: true };
  }

  const today = seller.hours.find((h) => h.dayOfWeek === parts.weekday);
  if (!today || today.isClosed) {
    return scheduleClosed('CLOSED_TODAY', { nextOpenText: describeNextOpening(seller, parts.weekday) });
  }

  const window = { todayOpensAt: today.opensAt, todayClosesAt: today.closesAt };
  if (isWithinWindow(nowMinutes, parseTimeToMinutes(today.opensAt), parseTimeToMinutes(today.closesAt))) {
    return { ...base, ...window, isOpen: true, closedReason: null, acceptingOrders: true };
  }
  return scheduleClosed('OUTSIDE_HOURS', {
    ...window,
    nextOpenText:
      nowMinutes < parseTimeToMinutes(today.opensAt)
        ? `Opens today at ${formatTime12h(today.opensAt)}`
        : describeNextOpening(seller, parts.weekday),
  });
}

/** Customer-facing sentence for a seller that cannot take an order now. */
export function sellerClosedMessage(sellerName: string, availability: SellerAvailability): string {
  switch (availability.closedReason) {
    case 'CLOSURE':
      return `${sellerName} is closed today.${availability.nextOpenText ? ` ${availability.nextOpenText}.` : ''}`;
    case 'CLOSED_TODAY':
    case 'OUTSIDE_HOURS':
      return `${sellerName} is closed right now.${availability.nextOpenText ? ` ${availability.nextOpenText}.` : ''}`;
    default:
      return `${sellerName} is not taking orders right now.`;
  }
}

/**
 * Evaluates opening hours in the SELLER's timezone — a view over
 * `evaluateSellerAvailability`, kept for the existing store/restaurant DTOs.
 *
 * Doing this in server UTC would close a Rajasthan shop at 16:30 local — the
 * kind of bug that silently costs a day of orders (PRD §2.2 M6).
 */
export async function getSellerOpenState(
  seller: SellerWithHours,
  now: Date = new Date(),
): Promise<SellerOpenState> {
  const availability = await evaluateSellerAvailability(seller, now);
  return {
    isOpen: availability.isOpen,
    todayOpensAt: availability.todayOpensAt,
    todayClosesAt: availability.todayClosesAt,
    nextOpenText: availability.nextOpenText,
  };
}

function describeNextOpening(seller: SellerWithHours, fromWeekday: number): string | null {
  // Look ahead a week for the next day the seller actually trades.
  for (let offset = 1; offset <= 7; offset += 1) {
    const weekday = (fromWeekday + offset) % 7;
    const hours = seller.hours.find((h) => h.dayOfWeek === weekday && !h.isClosed);
    if (!hours) continue;
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      weekday
    ];
    return offset === 1
      ? `Opens tomorrow at ${formatTime12h(hours.opensAt)}`
      : `Opens ${dayName} at ${formatTime12h(hours.opensAt)}`;
  }
  return null;
}

/**
 * Gate used before accepting an order FROM THIS SELLER (checkout calls it
 * for every seller in the cart).
 *
 * `ALLOW_ORDERS_WHEN_CLOSED` exists because a shop may want to take orders
 * overnight for morning delivery; it is configuration, not a code branch —
 * and it never overrides the seller's own OFF switch or admin deactivation.
 */
export async function assertSellerAcceptingOrders(
  seller: SellerWithHours,
  now: Date = new Date(),
): Promise<void> {
  const availability = await evaluateSellerAvailability(seller, now);
  if (availability.acceptingOrders) return;
  throw new AppError(ErrorCode.SELLER_CLOSED, {
    message: sellerClosedMessage(seller.name, availability),
    internalMessage: `seller ${seller.id} not accepting orders at ${now.toISOString()}: ${availability.closedReason}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Task 3.1 — serviceability                                                  */
/* -------------------------------------------------------------------------- */

export interface ServiceabilityCheckResult {
  serviceable: boolean;
  distanceKm: number;
  maxRadiusKm: number;
  roadDistanceKm: number;
  deliveryFeePaise: number;
}

/**
 * The reusable check required by the spec, wired to configuration.
 *
 * A per-seller `maxServiceRadiusKm` overrides the global config when set.
 */
export async function checkServiceability(
  latitude: number,
  longitude: number,
  seller: SellerWithHours,
): Promise<ServiceabilityCheckResult> {
  if (!isValidCoordinates(latitude, longitude)) {
    throw new AppError(ErrorCode.INVALID_COORDINATES, {
      internalMessage: `invalid coordinates: ${latitude}, ${longitude}`,
    });
  }

  const { MAX_SERVICE_RADIUS_KM, ROAD_DISTANCE_FACTOR, DELIVERY_FEE_SLABS } =
    await configService.getMany([
      ConfigKey.MAX_SERVICE_RADIUS_KM,
      ConfigKey.ROAD_DISTANCE_FACTOR,
      ConfigKey.DELIVERY_FEE_SLABS,
    ]);

  const maxRadiusKm = seller.maxServiceRadiusKm ?? MAX_SERVICE_RADIUS_KM;

  const { serviceable, distanceKm } = checkServiceabilityPure(
    latitude,
    longitude,
    seller.latitude,
    seller.longitude,
    maxRadiusKm,
  );

  // Straight line decides serviceability (it matches the promise we make);
  // the road factor prices the actual ride.
  const roadDistanceKm = toRoadDistanceKm(distanceKm, ROAD_DISTANCE_FACTOR);

  return {
    serviceable,
    distanceKm,
    maxRadiusKm,
    roadDistanceKm,
    deliveryFeePaise: resolveDeliveryFeePaise(roadDistanceKm, DELIVERY_FEE_SLABS),
  };
}

/** Throws unless the coordinates are inside THIS seller's delivery area. */
export async function assertServiceable(
  latitude: number,
  longitude: number,
  seller: SellerWithHours,
): Promise<ServiceabilityCheckResult> {
  const result = await checkServiceability(latitude, longitude, seller);
  if (!result.serviceable) {
    throw new AppError(ErrorCode.OUT_OF_SERVICE_AREA, {
      message: `Sorry, ${seller.name} does not deliver to this location yet. It delivers up to ${result.maxRadiusKm} km from its store.`,
      internalMessage: `seller ${seller.id}: distance ${result.distanceKm}km exceeds ${result.maxRadiusKm}km`,
    });
  }
  return result;
}

export interface CartDelivery {
  /** The seller farthest from the address — it sets the delivery fee and ETA. */
  farthest: SellerWithHours;
  check: ServiceabilityCheckResult;
  sellers: SellerWithHours[];
}

/**
 * Checkout's rule: EVERY seller in the cart must deliver to the address. The
 * delivery fee and ETA are priced on the farthest of them (one run that has to
 * reach the farthest pickup). Throws OUT_OF_SERVICE_AREA naming the seller
 * that does not deliver there.
 */
export async function assertSellersServe(
  latitude: number,
  longitude: number,
  sellerIds: readonly string[],
): Promise<CartDelivery> {
  return assertLoadedSellersServe(latitude, longitude, await repository.findSellersByIds(sellerIds));
}

/** `assertSellersServe` for sellers the caller already loaded (with hours), e.g. with the cart. */
export async function assertLoadedSellersServe(
  latitude: number,
  longitude: number,
  loaded: readonly SellerWithHours[],
): Promise<CartDelivery> {
  const sellers = [...new Map(loaded.map((seller) => [seller.id, seller])).values()];
  if (sellers.length === 0) throw new AppError(ErrorCode.CART_EMPTY);

  let farthest: { seller: SellerWithHours; check: ServiceabilityCheckResult } | null = null;
  for (const seller of sellers) {
    const check = await assertServiceable(latitude, longitude, seller);
    if (!farthest || check.distanceKm > farthest.check.distanceKm) farthest = { seller, check };
  }
  return { farthest: farthest!.seller, check: farthest!.check, sellers };
}

/* -------------------------------------------------------------------------- */
/* Task 3.1 / 8.5 — ETA                                                       */
/* -------------------------------------------------------------------------- */

export async function estimateEta(input: {
  distanceKm: number;
  itemCount: number;
  sellerId: string;
}): Promise<EtaResult> {
  const config = await configService.getMany([
    ConfigKey.ROAD_DISTANCE_FACTOR,
    ConfigKey.BASE_PREPARATION_MINUTES,
    ConfigKey.PER_ITEM_PICK_SECONDS,
    ConfigKey.AVG_DELIVERY_SPEED_KMPH,
    ConfigKey.ORDERS_PER_RIDER_BATCH,
    ConfigKey.BATCH_DELAY_MINUTES,
    ConfigKey.ETA_BUFFER_MINUTES,
  ]);

  const activeOrderCount = await repository.countActiveOrders(input.sellerId);

  return estimateDeliveryTime({
    distanceKm: input.distanceKm,
    itemCount: input.itemCount,
    activeOrderCount,
    roadDistanceFactor: config.ROAD_DISTANCE_FACTOR,
    basePreparationMinutes: config.BASE_PREPARATION_MINUTES,
    perItemPickSeconds: config.PER_ITEM_PICK_SECONDS,
    avgDeliverySpeedKmph: config.AVG_DELIVERY_SPEED_KMPH,
    ordersPerRiderBatch: config.ORDERS_PER_RIDER_BATCH,
    batchDelayMinutes: config.BATCH_DELAY_MINUTES,
    etaBufferMinutes: config.ETA_BUFFER_MINUTES,
  });
}

/* -------------------------------------------------------------------------- */
/* Task 3.2 — the endpoint's payload                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything the app needs on open: may I order here, how far am I, how long
 * will it take, what will delivery cost, and is anyone open.
 *
 * "Here" is serviceable when at least one live seller delivers to it; the
 * distance, fee and ETA are those of the NEAREST such seller. With no seller
 * at all (a fresh install) the answer is simply "not serviceable" — never a
 * 503, there is no special store whose absence breaks the app.
 *
 * One round trip, because on rural 3G each additional call is a visible pause.
 */
export async function getServiceability(latitude: number, longitude: number): Promise<ServiceabilityResult> {
  if (!isValidCoordinates(latitude, longitude)) {
    throw new AppError(ErrorCode.INVALID_COORDINATES, {
      internalMessage: `invalid coordinates: ${latitude}, ${longitude}`,
    });
  }

  const sellers = await repository.findLiveSellers();
  const checks = await Promise.all(
    sellers.map(async (seller) => ({ seller, check: await checkServiceability(latitude, longitude, seller) })),
  );
  const byDistance = [...checks].sort((a, b) => a.check.distanceKm - b.check.distanceKm);
  const serving = byDistance.filter((entry) => entry.check.serviceable);
  const nearest = serving[0] ?? byDistance[0] ?? null;

  if (!nearest || serving.length === 0) {
    const { MAX_SERVICE_RADIUS_KM } = await configService.getMany([ConfigKey.MAX_SERVICE_RADIUS_KM]);
    return {
      serviceable: false,
      distanceKm: nearest?.check.distanceKm ?? 0,
      maxRadiusKm: nearest?.check.maxRadiusKm ?? MAX_SERVICE_RADIUS_KM,
      etaMinutes: null,
      etaMinMinutes: null,
      etaMaxMinutes: null,
      deliveryFeePaise: null,
      sellerOpen: false,
    };
  }

  const [eta, openStates] = await Promise.all([
    estimateEta({ distanceKm: nearest.check.distanceKm, itemCount: 0, sellerId: nearest.seller.id }),
    Promise.all(serving.map((entry) => getSellerOpenState(entry.seller))),
  ]);

  return {
    serviceable: true,
    distanceKm: nearest.check.distanceKm,
    maxRadiusKm: nearest.check.maxRadiusKm,
    etaMinutes: eta.etaMinutes,
    etaMinMinutes: eta.etaMinMinutes,
    etaMaxMinutes: eta.etaMaxMinutes,
    deliveryFeePaise: nearest.check.deliveryFeePaise,
    sellerOpen: openStates.some((state) => state.isOpen),
  };
}

/** A cart's serviceability: always serviceable, so the ETA is always known. */
export type CartServiceabilityResult = ServiceabilityResult & {
  etaMinutes: number;
  etaMinMinutes: number;
  etaMaxMinutes: number;
};

/**
 * The same answer for ONE cart: priced on the farthest cart seller, "open"
 * only when every cart seller is open right now.
 */
export async function cartServiceability(
  delivery: CartDelivery,
  itemCount: number,
): Promise<CartServiceabilityResult> {
  const [eta, openStates] = await Promise.all([
    estimateEta({ distanceKm: delivery.check.distanceKm, itemCount, sellerId: delivery.farthest.id }),
    Promise.all(delivery.sellers.map((seller) => getSellerOpenState(seller))),
  ]);
  return {
    serviceable: true,
    distanceKm: delivery.check.distanceKm,
    maxRadiusKm: delivery.check.maxRadiusKm,
    etaMinutes: eta.etaMinutes,
    etaMinMinutes: eta.etaMinMinutes,
    etaMaxMinutes: eta.etaMaxMinutes,
    deliveryFeePaise: delivery.check.deliveryFeePaise,
    sellerOpen: openStates.every((state) => state.isOpen),
  };
}
