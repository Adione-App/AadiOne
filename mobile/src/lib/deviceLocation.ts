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
  suggestionFromPlace,
  type AddressSuggestion,
  type DetectResult,
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

/**
 * Forward geocoding of typed address text with the OS geocoder. The result is
 * the centre of whatever area the text names (a locality, a village, a PIN) —
 * APPROXIMATE, and saved as such (locationSource GEOCODED). Null when it does
 * not resolve: nothing is substituted.
 */
export async function geocodeAddressText(text: string): Promise<{ latitude: number; longitude: number } | null> {
  if (!text.trim()) return null;
  try {
    const [hit] = await Location.geocodeAsync(text);
    return hit ? { latitude: hit.latitude, longitude: hit.longitude } : null;
  } catch {
    return null;
  }
}
