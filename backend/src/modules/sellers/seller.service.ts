/**
 * Serviceability, opening hours and ETA — per seller.
 *
 * THE BACKEND IS THE AUTHORITY. The mobile app may call
 * `checkServiceability` from the shared package to render "3.2 km away", but
 * every decision that gates an order is made here and re-made at order
 * creation. A client's answer is display, never permission.
 *
 * WHERE AADIONE DELIVERS is the admin's list of approved village + PIN code
 * pairs (Configuration DELIVERY_LOCATIONS — addresses/delivery-locations.ts):
 * every saved address, quote and order is checked against it. That list is
 * the eligibility authority.
 *
 * The admin's service location (PLATFORM_LOCATION) and radius
 * (MAX_SERVICE_RADIUS_KM) are kept and used for what a village name cannot
 * give: the DISTANCE that prices the delivery fee and the ETA (straight line
 * from the service location, never from a seller's own map point), and a
 * hint for a bare GPS point whose village is not known yet (Home on an older
 * app, store and restaurant lists). They never refuse an order whose village
 * and PIN are approved. Both are read on every evaluation.
 *
 * "Can I order here?" = an approved, active village + PIN and at least one
 * live seller; checkout then requires every seller in the cart to be open
 * and taking orders (order.service).
 */

import { ConfigKey, ErrorCode, type ServiceabilityResult } from '../../shared';
import {
  checkServiceability as checkServiceabilityPure,
  coordinateProblem,
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
import { checkDeliveryPair } from '../addresses/delivery-locations';
import { deliveryPairMessage } from '../../shared/address';
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
  options: {
    /**
     * Date closures already loaded for a batch of sellers, as
     * `closureKey(sellerId, localDate)` — saves one query per seller
     * (store-availability.ts). Absent: this seller's closure is queried.
     */
    closures?: ReadonlySet<string>;
  } = {},
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
  const closedToday = options.closures
    ? options.closures.has(closureKey(seller.id, localMidnightUtc))
    : await repository.hasClosureOn(seller.id, localMidnightUtc);
  if (closedToday) {
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

/** Key of a SellerClosure in a pre-loaded set: the seller and its local date (UTC midnight). */
export function closureKey(sellerId: string, closedOn: Date): string {
  return `${sellerId}|${closedOn.toISOString().slice(0, 10)}`;
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

/** The admin-configured delivery origin (PLATFORM_LOCATION), or null when not set / unusable. */
export interface DeliveryOrigin {
  latitude: number;
  longitude: number;
  name: string | null;
}

export async function deliveryOrigin(): Promise<DeliveryOrigin | null> {
  const location = await configService.get(ConfigKey.PLATFORM_LOCATION);
  if (!location || typeof location !== 'object' || !('latitude' in location)) return null;
  const { latitude, longitude } = location as { latitude: unknown; longitude: unknown };
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (coordinateProblem(latitude, longitude) !== null) return null;
  const name = (location as { name?: unknown }).name;
  return { latitude, longitude, name: typeof name === 'string' && name.trim() ? name.trim() : null };
}

/**
 * How far is this point from the admin service location (the distance that
 * prices the delivery fee and the ETA), and is it inside the admin radius
 * (a HINT for a point whose village is not known — never an order's
 * eligibility, which is the approved village + PIN)? `configured` false: no
 * service location — distance 0 (the first fee slab), never inside.
 *
 * The `seller` argument is accepted for the existing callers and IGNORED: a
 * seller's own coordinates and radius never take part.
 */
export async function checkServiceability(
  latitude: number,
  longitude: number,
  _seller?: unknown,
): Promise<ServiceabilityCheckResult & { configured: boolean }> {
  if (!isValidCoordinates(latitude, longitude)) {
    throw new AppError(ErrorCode.INVALID_COORDINATES, {
      internalMessage: `invalid coordinates: ${latitude}, ${longitude}`,
    });
  }

  const [origin, { MAX_SERVICE_RADIUS_KM, ROAD_DISTANCE_FACTOR, DELIVERY_FEE_SLABS }] = await Promise.all([
    deliveryOrigin(),
    configService.getMany([ConfigKey.MAX_SERVICE_RADIUS_KM, ConfigKey.ROAD_DISTANCE_FACTOR, ConfigKey.DELIVERY_FEE_SLABS]),
  ]);
  const maxRadiusKm = MAX_SERVICE_RADIUS_KM;

  if (!origin) {
    return {
      configured: false,
      serviceable: false,
      distanceKm: 0,
      maxRadiusKm,
      roadDistanceKm: 0,
      deliveryFeePaise: resolveDeliveryFeePaise(0, DELIVERY_FEE_SLABS),
    };
  }

  const { serviceable, distanceKm } = checkServiceabilityPure(latitude, longitude, origin.latitude, origin.longitude, maxRadiusKm);

  // Straight line decides serviceability (it matches the promise we make);
  // the road factor prices the actual ride.
  const roadDistanceKm = toRoadDistanceKm(distanceKm, ROAD_DISTANCE_FACTOR);

  return {
    configured: true,
    serviceable,
    distanceKm,
    maxRadiusKm,
    roadDistanceKm,
    deliveryFeePaise: resolveDeliveryFeePaise(roadDistanceKm, DELIVERY_FEE_SLABS),
  };
}

/**
 * The delivery pricing for a destination already found eligible (its village
 * + PIN approved — orders/delivery-destination.ts). Never refuses: the
 * distance from the service location only prices the fee and the ETA.
 */
export async function assertServiceable(
  latitude: number,
  longitude: number,
  _seller?: unknown,
): Promise<ServiceabilityCheckResult> {
  return checkServiceability(latitude, longitude);
}

export interface CartDelivery {
  /** The cart seller whose load the ETA counts (distance is the same for every seller). */
  farthest: SellerWithHours;
  check: ServiceabilityCheckResult;
  sellers: SellerWithHours[];
}

/**
 * Checkout's pricing: the destination's eligibility (approved village + PIN)
 * is decided before this (orders/delivery-destination.ts resolveDestination);
 * here the delivery fee and ETA are priced on the distance from the admin
 * service location — the same for every seller in the cart.
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

  const check = await assertServiceable(latitude, longitude);
  return { farthest: sellers[0]!, check, sellers };
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
 * "Here" is serviceable when it is inside the admin-configured delivery area
 * and at least one live seller exists; the distance, fee and ETA are measured
 * from the admin location. With no seller at all (a fresh install) or no
 * configured area the answer is simply "not serviceable" — never a 503.
 *
 * One round trip, because on rural 3G each additional call is a visible pause.
 */
export async function getServiceability(latitude: number, longitude: number): Promise<ServiceabilityResult> {
  return (await evaluateLocation(latitude, longitude)).result;
}

/** The confirmed village and PIN of a location, when known. */
export interface KnownPlace {
  village: string | null;
  pincode: string | null;
}

/** Why no store serves a point (null: at least one does). */
export type LocationOutsideReason = 'OUTSIDE_SERVICE_STATE' | 'NO_ELIGIBLE_STORE' | 'OUTSIDE_RADIUS';

export interface LocationEvaluation {
  result: ServiceabilityResult;
  /** The live sellers that deliver to the point (all of them, when it is eligible). */
  serving: SellerWithHours[];
  outsideReason: LocationOutsideReason | null;
  /** Why not, in words, when the village + PIN decided it (else the generic sentence). */
  outsideMessage?: string;
}

/**
 * `getServiceability` plus WHICH sellers serve the point and, when none
 * does, why — for the location check's status (location-serviceability.ts).
 *
 * With the location's village + PIN (`place` — a saved address or a
 * confirmed live location): the approved pair decides. Without them (a bare
 * GPS point): the admin radius around the service location is the hint.
 * Eligible: every live seller serves the point. Sellers' own map points play
 * no part.
 */
export async function evaluateLocation(latitude: number, longitude: number, place: KnownPlace | null = null): Promise<LocationEvaluation> {
  if (!isValidCoordinates(latitude, longitude)) {
    throw new AppError(ErrorCode.INVALID_COORDINATES, {
      internalMessage: `invalid coordinates: ${latitude}, ${longitude}`,
    });
  }

  const [check, sellers, pair] = await Promise.all([
    checkServiceability(latitude, longitude),
    repository.findLiveSellers(),
    place ? checkDeliveryPair(place.village, place.pincode) : Promise.resolve(null),
  ]);

  // The village + PIN decide when known (an older app's bare point: the radius hint).
  if (pair && pair.verdict !== 'APPROVED') {
    return {
      result: {
        serviceable: false,
        // No distance sentence: the place, not the distance, is the reason.
        distanceKm: 0,
        maxRadiusKm: check.maxRadiusKm,
        etaMinutes: null,
        etaMinMinutes: null,
        etaMaxMinutes: null,
        deliveryFeePaise: null,
        sellerOpen: false,
      },
      serving: [],
      outsideReason: 'OUTSIDE_RADIUS',
      outsideMessage: deliveryPairMessage(pair.verdict, place?.village, place?.pincode),
    };
  }
  const eligible = pair ? true : check.configured && check.serviceable;

  if (!eligible || sellers.length === 0) {
    return {
      result: {
        serviceable: false,
        distanceKm: check.distanceKm,
        maxRadiusKm: check.maxRadiusKm,
        etaMinutes: null,
        etaMinMinutes: null,
        etaMaxMinutes: null,
        deliveryFeePaise: null,
        sellerOpen: false,
      },
      serving: [],
      // A bare point outside the radius hint; no live store at all (or no
      // service location for a bare point).
      outsideReason: !eligible && check.configured ? 'OUTSIDE_RADIUS' : 'NO_ELIGIBLE_STORE',
    };
  }

  const [eta, openStates] = await Promise.all([
    estimateEta({ distanceKm: check.distanceKm, itemCount: 0, sellerId: sellers[0]!.id }),
    Promise.all(sellers.map((seller) => getSellerOpenState(seller))),
  ]);

  return {
    result: {
      serviceable: true,
      distanceKm: check.distanceKm,
      maxRadiusKm: check.maxRadiusKm,
      etaMinutes: eta.etaMinutes,
      etaMinMinutes: eta.etaMinMinutes,
      etaMaxMinutes: eta.etaMaxMinutes,
      deliveryFeePaise: check.deliveryFeePaise,
      sellerOpen: openStates.some((state) => state.isOpen),
    },
    serving: sellers,
    outsideReason: null,
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
