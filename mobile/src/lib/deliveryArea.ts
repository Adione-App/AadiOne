/**
 * The "how far" sentence for a location the app does not deliver to — pure,
 * so it is unit-tested (tests/deliveryArea.test.ts).
 *
 * The server decides serviceability (GET /store/serviceability: the nearest
 * store's straight-line distance and that store's radius). Distance is only
 * mentioned when it IS the reason: a point inside the radius can still be
 * refused (outside Rajasthan, a PIN code not served), and then the generic
 * sentence is all that is true.
 */

import type { ServiceabilityResult, ServiceabilityStatus } from "@shared";
import { GPS_FAILURE_MESSAGE, isFresh, type GpsFailure, type GpsStatus } from "./currentLocation";

interface DeliveryAreaFacts {
  serviceable: boolean;
  /** Straight-line km to the nearest store (already rounded up by the server). */
  distanceKm: number;
  /** That store's delivery radius in km. */
  maxRadiusKm: number;
}

/** One decimal, rounded up — a shown distance never understates the real one. */
export function formatKm(km: number): string {
  const rounded = Math.ceil(km * 10 - 1e-9) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "The nearest store is about 14.3 km away — stores deliver up to 12 km." or null. */
export function outOfAreaDetail(facts: DeliveryAreaFacts | null | undefined): string | null {
  if (!facts || facts.serviceable) return null;
  const { distanceKm, maxRadiusKm } = facts;
  if (!Number.isFinite(distanceKm) || !Number.isFinite(maxRadiusKm) || maxRadiusKm <= 0) return null;
  if (distanceKm <= maxRadiusKm) return null;
  return `The nearest store is about ${formatKm(distanceKm)} km away — stores deliver up to ${formatKm(maxRadiusKm)} km (straight line).`;
}

/* -------------------------------------------------------------------------- */
/* Delivery status for the chosen location — one state per reason            */
/* -------------------------------------------------------------------------- */

/** The server's sentence for a location outside every service area (location-serviceability.service.ts). */
export const NOT_DELIVERING_MESSAGE =
  "Sorry! Aadione is currently not delivering to your location. We are working to expand our service area.";

export type DeliveryAction =
  /** Ask the GPS again (no dialog). */
  | "REFRESH"
  /** Ask for the permission (the system dialog — only while the OS still allows asking). */
  | "ALLOW_LOCATION"
  /** Permission denied for good: the app's settings. */
  | "OPEN_SETTINGS"
  /** Location services off: the system's turn-on dialog (Android) / Settings (iOS). */
  | "ENABLE_GPS"
  | "CHOOSE_ADDRESS"
  /** The serviceability request itself failed (network / server): ask again. */
  | "RETRY_CHECK";

export type DeliveryState =
  | "NO_LOCATION"
  | "LOCATING"
  | "CHECKING"
  | "AVAILABLE"
  | Exclude<ServiceabilityStatus, "AVAILABLE">
  | "GPS_FAILED"
  | "CHECK_FAILED";

export interface DeliveryView {
  state: DeliveryState;
  /** Ordering to this location is possible now (display only — the server checks again). */
  canOrder: boolean;
  title: string | null;
  message: string | null;
  actions: DeliveryAction[];
  /** GPS = the phone's current location; ADDRESS = a saved address the customer picked. */
  source: "GPS" | "ADDRESS" | null;
  gpsFailure?: GpsFailure;
}

export interface DeliveryInputs {
  location: { source: "GPS" | "ADDRESS"; fixedAt?: number | null } | null;
  serviceability: ServiceabilityResult | null;
  checking: boolean;
  error: string | null;
  gps: GpsStatus;
  now: number;
}

/** A reading this recent stays on screen while a newer one is being taken (no flicker on resume). */
export const SHOWN_WHILE_REFRESHING_MS = 10 * 60_000;

const OUTSIDE: ReadonlySet<ServiceabilityStatus> = new Set(["OUTSIDE_RADIUS", "OUTSIDE_SERVICE_STATE", "NO_ELIGIBLE_STORE"]);

const GPS_FAILURE_VIEW: Record<GpsFailure, { title: string; actions: DeliveryAction[] }> = {
  PERMISSION_DENIED: { title: "Allow location access", actions: ["ALLOW_LOCATION", "CHOOSE_ADDRESS"] },
  PERMISSION_BLOCKED: { title: "Location access is off", actions: ["OPEN_SETTINGS", "CHOOSE_ADDRESS"] },
  SERVICES_DISABLED: { title: "Location (GPS) is off", actions: ["ENABLE_GPS", "CHOOSE_ADDRESS"] },
  TIMEOUT: { title: "Couldn't find your location", actions: ["REFRESH", "CHOOSE_ADDRESS"] },
  UNAVAILABLE: { title: "Couldn't find your location", actions: ["REFRESH", "CHOOSE_ADDRESS"] },
  INVALID: { title: "Couldn't find your location", actions: ["REFRESH", "CHOOSE_ADDRESS"] },
  TOO_INACCURATE: { title: "Couldn't find your exact location", actions: ["REFRESH", "CHOOSE_ADDRESS"] },
};

/** The status of an answer, also for an older server that does not send one. */
export function serviceabilityStatusOf(result: ServiceabilityResult): ServiceabilityStatus {
  if (result.status) return result.status;
  if (!result.serviceable) return "OUTSIDE_RADIUS";
  return result.sellerOpen ? "AVAILABLE" : "STORE_CLOSED";
}

/**
 * What Home and Cart show for the chosen location. A GPS location counts as
 * the CURRENT one only after a reading this session: before it, while it is
 * taken, and when it failed, an earlier point's answer is never shown as if
 * it were where the phone is now.
 */
export function deliveryView(input: DeliveryInputs): DeliveryView {
  const { location, serviceability, checking, error, gps, now } = input;
  const source = location?.source ?? null;
  const base = { canOrder: false, title: null, message: null, actions: [] as DeliveryAction[], source };

  if (source !== "ADDRESS" && gps.phase === "failed" && gps.failure) {
    const view = GPS_FAILURE_VIEW[gps.failure];
    return { ...base, state: "GPS_FAILED", title: view.title, message: GPS_FAILURE_MESSAGE[gps.failure], actions: view.actions, gpsFailure: gps.failure };
  }

  if (!location) return { ...base, state: gps.phase === "locating" ? "LOCATING" : "NO_LOCATION" };

  if (source === "GPS" && gps.phase !== "ok") {
    const recent = gps.phase === "locating" && isFresh(location.fixedAt, now, SHOWN_WHILE_REFRESHING_MS);
    if (!recent) return { ...base, state: "LOCATING" };
  }

  if (!serviceability) {
    if (error && !checking) {
      return {
        ...base,
        state: "CHECK_FAILED",
        title: "Couldn't check delivery",
        message: "We couldn't check delivery for this location. Check your internet connection and try again.",
        actions: ["RETRY_CHECK"],
      };
    }
    return { ...base, state: "CHECKING" };
  }

  const status = serviceabilityStatusOf(serviceability);
  if (status === "AVAILABLE") return { ...base, state: "AVAILABLE", canOrder: true };

  if (OUTSIDE.has(status)) {
    return {
      ...base,
      state: status as DeliveryState,
      title: source === "ADDRESS" ? "We don't deliver to this address" : "Service unavailable in this area",
      message: [serviceability.message || NOT_DELIVERING_MESSAGE, status === "OUTSIDE_RADIUS" ? outOfAreaDetail(serviceability) : null]
        .filter(Boolean)
        .join(" "),
      actions: source === "GPS" ? ["REFRESH", "CHOOSE_ADDRESS"] : ["CHOOSE_ADDRESS"],
    };
  }

  const titles: Record<"STORE_CLOSED" | "STORE_NOT_ACCEPTING" | "ORDERING_DISABLED", [string, string]> = {
    STORE_CLOSED: ["Stores near you are closed", "Every store near you is closed right now. You can keep browsing — ordering opens when a store opens."],
    STORE_NOT_ACCEPTING: ["Stores near you aren't taking orders", "Stores near you are not taking orders right now. You can keep browsing."],
    ORDERING_DISABLED: ["Ordering is paused", "Ordering is paused right now. You can keep browsing and adding items to your cart."],
  };
  const [title, fallback] = titles[status as keyof typeof titles];
  return { ...base, state: status as DeliveryState, title, message: serviceability.message || fallback };
}

/** The one-line status above the location in Home's header. */
export function deliveryHeadline(view: DeliveryView): { text: string; tone: "ok" | "danger" | "muted" } {
  switch (view.state) {
    case "AVAILABLE":
      return { text: view.source === "ADDRESS" ? "Delivery available · Saved address" : "Delivery available · Current location", tone: "ok" };
    case "LOCATING":
      return { text: "Finding your current location…", tone: "muted" };
    case "OUTSIDE_RADIUS":
    case "OUTSIDE_SERVICE_STATE":
    case "NO_ELIGIBLE_STORE":
      return { text: "Service unavailable in this area", tone: "danger" };
    case "GPS_FAILED":
      return { text: "Current location unavailable", tone: "danger" };
    default:
      return { text: view.source === "ADDRESS" ? "Delivering to saved address" : "Delivering to", tone: "muted" };
  }
}
