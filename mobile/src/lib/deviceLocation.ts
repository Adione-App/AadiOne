/**
 * The phone's location, through the shared detection procedure
 * (@shared/location detectLocation):
 *
 *   permission → location services on → ONE fresh fix (never the cached
 *   last-known position) within a timeout → coordinates validated → accuracy
 *   assessed.
 *
 * Reverse geocoding uses the OS geocoder that expo-location wraps (Google on
 * Android, Apple on iOS — no API key, nothing billed to Aadione). Its result
 * is a SUGGESTION of address fields (suggestionFromPlace), never written over
 * what the person typed without them confirming it.
 */

import * as Location from 'expo-location';
import {
  LocationError,
  detectLocation,
  geocodeQueryFor,
  sortGeocodeCandidates,
  suggestionFromPlace,
  type AddressPlaceFields,
  type AddressSuggestion,
  type DetectResult,
  type GeocodeCandidate,
} from '@shared/location';

export function detectDeviceLocation(): Promise<DetectResult> {
  return detectLocation(
    {
      async requestPermission() {
        const { status } = await Location.requestForegroundPermissionsAsync();
        return status === 'granted';
      },
      servicesEnabled: () => Location.hasServicesEnabledAsync(),
      async getPosition() {
        try {
          const position = await Location.getCurrentPositionAsync({
            // A delivery address needs metres, not the kilometres "Balanced" gives indoors.
            accuracy: Location.Accuracy.High,
            mayShowUserSettingsDialog: true,
          });
          return {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyM: position.coords.accuracy ?? null,
          };
        } catch (error) {
          const code = (error as { code?: string } | null)?.code ?? '';
          if (code === 'E_LOCATION_SERVICES_DISABLED') throw new LocationError('SERVICES_DISABLED');
          if (code === 'E_LOCATION_UNAUTHORIZED' || code === 'ERR_LOCATION_UNAUTHORIZED') throw new LocationError('PERMISSION_DENIED');
          throw new LocationError('UNAVAILABLE');
        }
      },
    },
    { timeoutMs: 20_000 },
  );
}

/** Suggested address fields for a point; null when the OS geocoder has nothing (or fails). */
export async function suggestAddressFor(latitude: number, longitude: number): Promise<AddressSuggestion | null> {
  try {
    const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
    return suggestionFromPlace(place ?? null);
  } catch {
    return null;
  }
}

/** At most this many geocoder results are checked (each needs a reverse lookup). */
const MAX_CANDIDATES = 5;

export type FindAddressResult =
  | { status: 'FOUND'; usable: GeocodeCandidate[]; rejected: GeocodeCandidate[] }
  | { status: 'NOT_FOUND' | 'FAILED'; usable: []; rejected: GeocodeCandidate[] };

/**
 * Forward-geocodes a TYPED address with the OS geocoder, from the full
 * structured address (geocodeQueryFor — never the village or PIN alone).
 *
 * Every result is APPROXIMATE: the OS geocoder returns the centre of whatever
 * it matched (a street, a village, sometimes only the PIN area) and says
 * nothing about which — so a found point is saved as GEOCODED with no
 * accuracy, and the customer confirms it. Each result is reverse-geocoded and
 * checked against the typed village / district / state / PIN
 * (sortGeocodeCandidates): a different PIN / district / state is rejected,
 * never offered; several plausible results are all offered for the customer
 * to choose. Nothing found or a failure saves nothing — no default point.
 */
export async function findAddressCandidates(
  address: { houseNo?: string | null; street?: string | null; area?: string | null } & AddressPlaceFields,
): Promise<FindAddressResult> {
  const query = geocodeQueryFor(address);
  if (!query) return { status: 'NOT_FOUND', usable: [], rejected: [] };
  let hits: { latitude: number; longitude: number }[];
  try {
    hits = (await Location.geocodeAsync(query)).slice(0, MAX_CANDIDATES);
  } catch {
    return { status: 'FAILED', usable: [], rejected: [] };
  }
  if (hits.length === 0) return { status: 'NOT_FOUND', usable: [], rejected: [] };
  const withPlaces = await Promise.all(
    hits.map(async (hit) => ({
      latitude: hit.latitude,
      longitude: hit.longitude,
      place: await suggestAddressFor(hit.latitude, hit.longitude),
    })),
  );
  const sorted = sortGeocodeCandidates(address, withPlaces);
  return sorted.usable.length > 0
    ? { status: 'FOUND', usable: sorted.usable, rejected: sorted.rejected }
    : { status: 'NOT_FOUND', usable: [], rejected: sorted.rejected };
}

/** A map preview of a point (Google Maps in the browser / app) — for checking, not editing. */
export function mapPreviewUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}
