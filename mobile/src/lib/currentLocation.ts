/**
 * The customer's CURRENT location — when the phone is asked again, and what
 * a new reading replaces. Pure (the platform calls and the store come in as
 * `CurrentLocationDeps`), so every case is unit-tested
 * (tests/currentLocation.test.ts); lib/locationService.ts wires it to
 * expo-location and the location store.
 *
 * The rule: delivery is decided for where the phone IS, not where it was.
 * Yesterday's GPS point, a point cached at install, or a saved Home never
 * stands in for it.
 *
 *   when      cold start and every return to the foreground (no prompt —
 *             only with permission already granted), "Use current location"
 *             (may prompt), and right before an order to the live location
 *             (`ensureFresh`). Never on a timer, never in the background,
 *             never per render; concurrent requests share ONE reading.
 *   what      a GPS-sourced location only. A saved address the customer
 *             picked stays theirs (its own serviceability is re-checked) —
 *             until they choose "Use current location" again.
 *   moved?    a reading within a few hundred metres (GPS drift) keeps the
 *             same point and the details already confirmed for it; farther
 *             away it is a NEW point, with its own address and its own
 *             serviceability check — the old answer is dropped meanwhile.
 *   failed    the reason is kept (permission off / blocked, GPS off, timed
 *             out, …) and the old point is NOT presented as current: an
 *             order to the live location needs a fresh reading first.
 *
 * Saved addresses are never written here.
 */

import type { LiveLocationInput } from '@shared';
import type { AddressSuggestion, DetectStatus } from '@shared/location';
import { distanceKmExact } from '@shared/distance';
import { buildLiveDestination, isHomeState, liveLocationLabel } from './liveLocation';

/** Why there is no current reading. PERMISSION_BLOCKED: denied and the OS will not ask again (Settings only). */
export type GpsFailure = Exclude<DetectStatus, 'OK'> | 'PERMISSION_BLOCKED';

export interface PermissionState {
  granted: boolean;
  /** False once the person denied it for good (Android "Don't ask again", iOS after the first denial). */
  canAskAgain: boolean;
}

export type DeviceReading =
  | { status: 'OK'; latitude: number; longitude: number; accuracyM: number | null }
  | { status: GpsFailure };

/** The chosen location as the store keeps it (store.ts ChosenLocation). */
export interface CurrentPoint {
  latitude: number;
  longitude: number;
  label: string;
  source: 'GPS' | 'ADDRESS';
  accuracyM?: number | null;
  /** When the reading was taken (epoch ms), GPS only. Absent: never confirmed fresh. */
  fixedAt?: number | null;
}

export interface GpsStatus {
  phase: 'idle' | 'locating' | 'ok' | 'failed';
  failure: GpsFailure | null;
}

export interface CurrentLocationDeps {
  /** Permission as it stands — never shows a dialog. */
  permission(): Promise<PermissionState>;
  /** One fresh reading. `prompt`: may show the permission dialog (only for the customer's own tap). */
  read(options: { prompt: boolean }): Promise<DeviceReading>;
  /** The OS geocoder's address for a point; null when it has none. */
  geocode(latitude: number, longitude: number): Promise<AddressSuggestion | null>;
  /** The signed-in customer, for the recipient of a live destination. */
  user(): { fullName: string | null; mobile: string; mobileVerified: boolean } | null;
  now(): number;
  current(): { location: CurrentPoint | null; liveDestination: LiveLocationInput | null };
  /** Make this the chosen location (and its live destination); the store re-checks serviceability. */
  apply(location: CurrentPoint, liveDestination: LiveLocationInput | null): Promise<void>;
  /** Re-check serviceability of the location already chosen (a saved address). */
  recheck(): Promise<void>;
  setStatus(status: GpsStatus): void;
}

export type RefreshReason = 'launch' | 'resume' | 'user' | 'checkout';

export type RefreshOutcome =
  | { kind: 'UPDATED'; moved: boolean; location: CurrentPoint }
  | { kind: 'SKIPPED'; why: 'ADDRESS_SELECTED' | 'NOT_ASKED_YET' | 'RECENT' }
  | { kind: 'FAILED'; failure: GpsFailure };

/** A reading this old is not "current" for placing an order. */
export const CHECKOUT_FRESH_MS = 2 * 60_000;
/** Coming back to the app within this of the last reading does not ask the GPS again. */
export const RESUME_MIN_INTERVAL_MS = 60_000;
/** Readings closer than this (or than their own accuracy, up to the cap) are the same place. */
export const SAME_PLACE_M = 100;
export const SAME_PLACE_CAP_M = 300;
/** The geocoder may hang on a bad network; the point is used without an address after this. */
export const GEOCODE_TIMEOUT_MS = 8_000;

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  return distanceKmExact(a.latitude, a.longitude, b.latitude, b.longitude) * 1000;
}

/** GPS drift, not a move: within 100 m, or within the readings' own accuracy (at most 300 m). */
export function isSamePlace(
  previous: { latitude: number; longitude: number; accuracyM?: number | null },
  next: { latitude: number; longitude: number; accuracyM?: number | null },
): boolean {
  const tolerance = Math.min(SAME_PLACE_CAP_M, Math.max(SAME_PLACE_M, previous.accuracyM ?? 0, next.accuracyM ?? 0));
  return distanceMeters(previous, next) <= tolerance;
}

export function isFresh(fixedAt: number | null | undefined, now: number, maxAgeMs: number): boolean {
  return typeof fixedAt === 'number' && Number.isFinite(fixedAt) && now - fixedAt >= 0 && now - fixedAt <= maxAgeMs;
}

/** What to tell the customer for each failure — every one leaves a way forward. */
export const GPS_FAILURE_MESSAGE: Record<GpsFailure, string> = {
  PERMISSION_DENIED:
    'Allow location access so we can check whether Aadione delivers where you are. You can also choose a saved address.',
  PERMISSION_BLOCKED:
    'Location access is turned off for Aadione. Open Settings and allow location "While using the app", or choose a saved address.',
  SERVICES_DISABLED: 'Your phone\'s location (GPS) is switched off. Turn it on to check delivery where you are, or choose a saved address.',
  TIMEOUT: 'We could not find your location in time. Move near a window or outdoors and refresh, or choose a saved address.',
  UNAVAILABLE: 'Your phone could not determine its location. Refresh to try again, or choose a saved address.',
  INVALID: 'Your phone returned an invalid location. Refresh to try again, or choose a saved address.',
  TOO_INACCURATE: 'Your phone could only find an approximate location. Refresh outdoors, or choose a saved address.',
};

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createCurrentLocation(deps: CurrentLocationDeps) {
  let inflight: Promise<RefreshOutcome> | null = null;

  async function run(reason: RefreshReason, prompt: boolean): Promise<RefreshOutcome> {
    const { location } = deps.current();

    // A saved address the customer picked is not replaced by the GPS behind
    // their back: its own serviceability is checked again instead.
    if (location?.source === 'ADDRESS' && reason !== 'user') {
      await deps.recheck();
      return { kind: 'SKIPPED', why: 'ADDRESS_SELECTED' };
    }

    if (reason === 'resume' && location && isFresh(location.fixedAt, deps.now(), RESUME_MIN_INTERVAL_MS)) {
      return { kind: 'SKIPPED', why: 'RECENT' };
    }

    if (!prompt) {
      // Never a dialog here. Nothing chosen yet and never asked: the first-launch
      // explanation asks (LocationPermissionIntro). Otherwise a missing
      // permission means the current location is unknown — say so.
      const permission = await deps.permission().catch((): PermissionState => ({ granted: false, canAskAgain: true }));
      if (!permission.granted) {
        if (!location && permission.canAskAgain) return { kind: 'SKIPPED', why: 'NOT_ASKED_YET' };
        const failure: GpsFailure = permission.canAskAgain ? 'PERMISSION_DENIED' : 'PERMISSION_BLOCKED';
        deps.setStatus({ phase: 'failed', failure });
        return { kind: 'FAILED', failure };
      }
    }

    deps.setStatus({ phase: 'locating', failure: null });
    const reading = await deps.read({ prompt }).catch((): DeviceReading => ({ status: 'UNAVAILABLE' }));
    if (reading.status !== 'OK') {
      deps.setStatus({ phase: 'failed', failure: reading.status });
      return { kind: 'FAILED', failure: reading.status };
    }

    const fixedAt = deps.now();
    const fix = { latitude: reading.latitude, longitude: reading.longitude, accuracyM: reading.accuracyM };
    const before = deps.current();
    const previous = before.location;

    // Still here (GPS drift): the same point, now confirmed fresh — and the
    // details already confirmed for it stay.
    if (previous?.source === 'GPS' && isSamePlace(previous, fix)) {
      const confirmed: CurrentPoint = { ...previous, fixedAt };
      await deps.apply(confirmed, before.liveDestination);
      deps.setStatus({ phase: 'ok', failure: null });
      return { kind: 'UPDATED', moved: false, location: confirmed };
    }

    // A new place: its own address, its own serviceability. The recipient the
    // customer confirmed earlier is kept; the address is the new point's.
    const suggestion = await withTimeout(deps.geocode(fix.latitude, fix.longitude), GEOCODE_TIMEOUT_MS, null);
    const built = buildLiveDestination(fix, suggestion, deps.user());
    const earlier = before.liveDestination;
    const destination: LiveLocationInput = {
      ...built,
      fullName: built.fullName || earlier?.fullName || '',
      mobile: built.mobile || earlier?.mobile || '',
    };
    // Outside the state it is still shown — as a place we do not deliver to
    // (the server says so) — but it is never an order destination.
    const live = isHomeState(destination.state) ? destination : null;
    const next: CurrentPoint = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      label: liveLocationLabel(destination),
      source: 'GPS',
      accuracyM: fix.accuracyM,
      fixedAt,
    };
    await deps.apply(next, live);
    deps.setStatus({ phase: 'ok', failure: null });
    return { kind: 'UPDATED', moved: previous !== null, location: next };
  }

  /**
   * One reading at a time: a call while one is running gets that reading's
   * outcome — except the customer's own tap (`prompt`), which asks again
   * when the running one ended without a reading (e.g. a silent launch check
   * that found no permission yet).
   */
  function refresh(reason: RefreshReason, options: { prompt?: boolean } = {}): Promise<RefreshOutcome> {
    const prompt = options.prompt ?? false;
    if (inflight && !prompt) return inflight;
    const started = (inflight
      ? inflight.then((outcome) => (outcome.kind === 'UPDATED' ? outcome : run(reason, prompt)))
      : run(reason, prompt)
    ).finally(() => {
      if (inflight === started) inflight = null;
    });
    inflight = started;
    return started;
  }

  /**
   * Before an order to the live location: the reading must be recent, or a
   * new one is taken. The caller places the order only for an UPDATED,
   * not-moved outcome (or a reading already fresh); a move means the
   * destination changed and the customer must look at it again.
   */
  async function ensureFresh(maxAgeMs: number = CHECKOUT_FRESH_MS): Promise<RefreshOutcome | { kind: 'FRESH' }> {
    const { location } = deps.current();
    if (location?.source === 'GPS' && isFresh(location.fixedAt, deps.now(), maxAgeMs)) return { kind: 'FRESH' };
    return refresh('checkout');
  }

  return { refresh, ensureFresh };
}

export type CurrentLocation = ReturnType<typeof createCurrentLocation>;
