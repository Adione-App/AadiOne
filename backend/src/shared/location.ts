/**
 * Device location — one shared decision procedure for every "use my current
 * location" in the apps (customer app, seller panel), with no platform code:
 * the caller passes in its platform's calls (expo-location, the browser's
 * geolocation) as `LocationDeps`. Pure enough to unit-test every outcome.
 *
 * What it refuses to do — each of these produced wrong distances before:
 *   - substitute a cached / last-known / previous position for a fresh fix;
 *   - accept a fix without looking at the accuracy the device reports;
 *   - wait forever on a GPS that never answers;
 *   - turn a failure into (0, 0) or a city centre.
 *
 * A fix is a POINT WITH AN ERROR RADIUS, not an exact location: the caller
 * shows the accuracy and asks the person to confirm it.
 */

import { coordinateProblem } from './distance';
import { isValidPincode } from './phone';

/** Where a saved point came from (Address.locationSource). */
export const LOCATION_SOURCES = ['GPS', 'MAP_PIN', 'GEOCODED'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/** Accuracy radius bands (metres) for a device fix. */
export const FIX_ACCURACY = {
  /** Good enough for a doorstep. */
  GOOD_M: 50,
  /** Usable; the person should still check the point. */
  USABLE_M: 200,
  /** Beyond this the fix is not used at all: ask for the address / pin instead. */
  MAX_M: 1000,
} as const;

export type FixQuality = 'GOOD' | 'FAIR' | 'POOR';

export interface DeviceFix {
  latitude: number;
  longitude: number;
  /** The device's reported accuracy radius in metres; null when it reports none. */
  accuracyM: number | null;
}

export type FixAssessment =
  | { ok: true; quality: FixQuality; accuracyM: number | null }
  | { ok: false; reason: 'INVALID_COORDINATES' | 'TOO_INACCURATE'; accuracyM: number | null };

/** Is this fix usable, and how much can it be trusted? */
export function assessFix(fix: DeviceFix): FixAssessment {
  const accuracyM = typeof fix.accuracyM === 'number' && Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0 ? fix.accuracyM : null;
  if (coordinateProblem(fix.latitude, fix.longitude) !== null) return { ok: false, reason: 'INVALID_COORDINATES', accuracyM };
  if (accuracyM !== null && accuracyM > FIX_ACCURACY.MAX_M) return { ok: false, reason: 'TOO_INACCURATE', accuracyM };
  // No reported accuracy: usable, but never presented as precise.
  const quality: FixQuality =
    accuracyM === null || accuracyM > FIX_ACCURACY.USABLE_M ? 'POOR' : accuracyM > FIX_ACCURACY.GOOD_M ? 'FAIR' : 'GOOD';
  return { ok: true, quality, accuracyM };
}

/** The platform's location calls. */
export interface LocationDeps {
  /** Ask for (or confirm) foreground location permission. true = granted. */
  requestPermission: () => Promise<boolean>;
  /** Device location services switched on. Optional (the browser cannot tell). */
  servicesEnabled?: () => Promise<boolean>;
  /** A FRESH position from the OS — never a cached / last-known one. */
  getPosition: () => Promise<DeviceFix>;
}

export type DetectStatus =
  | 'OK'
  | 'PERMISSION_DENIED'
  | 'SERVICES_DISABLED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'INVALID'
  | 'TOO_INACCURATE';

export type DetectResult =
  | { status: 'OK'; latitude: number; longitude: number; accuracyM: number | null; quality: FixQuality }
  | { status: Exclude<DetectStatus, 'OK'>; accuracyM?: number | null };

export const DEFAULT_LOCATE_TIMEOUT_MS = 20_000;

/** Thrown by a platform's getPosition when it knows WHY there is no fix. */
export class LocationError extends Error {
  constructor(readonly status: 'PERMISSION_DENIED' | 'SERVICES_DISABLED' | 'TIMEOUT' | 'UNAVAILABLE') {
    super(status);
    this.name = 'LocationError';
  }
}

/** Permission → services → one fresh fix within `timeoutMs` → validated and assessed. */
export async function detectLocation(deps: LocationDeps, options: { timeoutMs?: number } = {}): Promise<DetectResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCATE_TIMEOUT_MS;
  try {
    if (!(await deps.requestPermission())) return { status: 'PERMISSION_DENIED' };
  } catch {
    return { status: 'PERMISSION_DENIED' };
  }
  if (deps.servicesEnabled) {
    try {
      if (!(await deps.servicesEnabled())) return { status: 'SERVICES_DISABLED' };
    } catch {
      // Unknown: let the position request itself decide.
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
  });
  let fix: DeviceFix | 'TIMEOUT';
  try {
    fix = await Promise.race([deps.getPosition(), timedOut]);
  } catch (error) {
    return { status: error instanceof LocationError ? error.status : 'UNAVAILABLE' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (fix === 'TIMEOUT') return { status: 'TIMEOUT' };

  const assessed = assessFix(fix);
  if (!assessed.ok) return { status: assessed.reason === 'TOO_INACCURATE' ? 'TOO_INACCURATE' : 'INVALID', accuracyM: assessed.accuracyM };
  return { status: 'OK', latitude: fix.latitude, longitude: fix.longitude, accuracyM: assessed.accuracyM, quality: assessed.quality };
}

/** What to tell the person for each failed detection — every one leaves a way forward. */
export const DETECT_MESSAGE: Record<Exclude<DetectStatus, 'OK'>, string> = {
  PERMISSION_DENIED: 'Location permission is off. Allow it in your settings and try again, or enter the address yourself.',
  SERVICES_DISABLED: 'Location (GPS) is switched off on this device. Turn it on and try again, or enter the address yourself.',
  TIMEOUT: 'Your location could not be found in time. Move near a window or outdoors and try again, or enter the address yourself.',
  UNAVAILABLE: 'Your device could not determine its location. Try again, or enter the address yourself.',
  INVALID: 'Your device returned an invalid location. Try again, or enter the address yourself.',
  TOO_INACCURATE: 'Your device could only find an approximate location (more than 1 km off). Try again outdoors, or enter the address yourself.',
};

/** "Accurate to about 20 m" — never more precise than the device claims. */
export function describeAccuracy(accuracyM: number | null): string {
  if (accuracyM === null) return 'Accuracy unknown — check the location before using it.';
  if (accuracyM < 1000) return `Accurate to about ${Math.max(5, Math.round(accuracyM / 5) * 5)} m`;
  return `Accurate to about ${(accuracyM / 1000).toFixed(1)} km`;
}

/* -------------------------------------------------------------------------- */
/* Reverse geocoding → structured Indian address                              */
/* -------------------------------------------------------------------------- */

/**
 * A reverse-geocoder result (the shape of expo-location's
 * LocationGeocodedAddress; every field may be missing).
 *
 * In India the OS geocoders fill: `subregion` = the DISTRICT, `region` = the
 * state, `city` = the city / town / village, `district` = the sub-locality
 * (neighbourhood / colony), `street`, `streetNumber`, `postalCode`. Reading
 * `district` as the district was the old bug that put the locality there.
 */
export interface GeocodedPlace {
  name?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  district?: string | null;
  subregion?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  isoCountryCode?: string | null;
}

export interface AddressSuggestion {
  houseNo: string | null;
  street: string | null;
  /** Locality / mohalla / colony. */
  area: string | null;
  /** Village / city / town. */
  city: string | null;
  district: string | null;
  state: string | null;
  /** Only a valid 6-digit Indian PIN — otherwise null for the person to fill. */
  pincode: string | null;
}

const clean = (value: string | null | undefined): string | null => {
  const text = value?.trim().replace(/\s+/g, ' ');
  return text ? text : null;
};
const sameText = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Suggested address fields for a reverse-geocoded point — suggestions only, for the person to confirm. */
export function suggestionFromPlace(place: GeocodedPlace | null | undefined): AddressSuggestion | null {
  if (!place) return null;
  const city = clean(place.city);
  const district = clean(place.subregion);
  const locality = clean(place.district);
  const street = clean(place.street);
  const pincode = clean(place.postalCode);
  const suggestion: AddressSuggestion = {
    houseNo: clean(place.streetNumber),
    street,
    // A sub-locality equal to the city / district says nothing more.
    area: locality && !sameText(locality, city) && !sameText(locality, district) ? locality : null,
    city,
    district,
    state: clean(place.region),
    pincode: pincode && isValidPincode(pincode) ? pincode : null,
  };
  return Object.values(suggestion).some(Boolean) ? suggestion : null;
}

/** "Shastri Nagar, Sikar 332001" for a location bar — locality, place, PIN. */
export function suggestionLabel(suggestion: AddressSuggestion | null, fallback = 'Current location'): string {
  if (!suggestion) return fallback;
  const label = [suggestion.area, suggestion.city ?? suggestion.district, suggestion.pincode].filter(Boolean).join(', ');
  return label || fallback;
}
