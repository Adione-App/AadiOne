/**
 * The browser's geolocation, plugged into the shared detection procedure
 * (@shared/location detectLocation): one fresh, high-accuracy fix
 * (maximumAge 0 — never a cached position), its reported accuracy, and a
 * typed reason when there is none.
 */

import { LocationError, detectLocation, type DetectResult, type LocationDeps } from '@shared/location';

const browserDeps: LocationDeps = {
  async requestPermission() {
    if (!('geolocation' in navigator)) return false;
    try {
      // Not every browser supports querying; an unknown state is asked by getCurrentPosition itself.
      const state = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
      return state?.state !== 'denied';
    } catch {
      return true;
    }
  },
  getPosition: () =>
    new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyM: position.coords.accuracy }),
        (error) =>
          reject(
            new LocationError(
              error.code === error.PERMISSION_DENIED ? 'PERMISSION_DENIED' : error.code === error.TIMEOUT ? 'TIMEOUT' : 'UNAVAILABLE',
            ),
          ),
        { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
      );
    }),
};

export function detectBrowserLocation(): Promise<DetectResult> {
  return detectLocation(browserDeps, { timeoutMs: 25_000 });
}
