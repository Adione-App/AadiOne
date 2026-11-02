/**
 * The app's one current-location controller (lib/currentLocation.ts) wired
 * to expo-location and the location store. Everything that wants the phone's
 * position now — launch, return to the app, "Use current location", checkout
 * — goes through here, so concurrent requests share one GPS reading.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createCurrentLocation, type RefreshReason } from './currentLocation';
import { createFirstLaunchLocation } from './firstLaunchLocation';
import { getLocationPermission, readDeviceLocation, suggestAddressFor } from './deviceLocation';
import { useAuth, useLocation } from './store';

const controller = createCurrentLocation({
  permission: getLocationPermission,
  read: readDeviceLocation,
  geocode: suggestAddressFor,
  user: () => {
    const user = useAuth.getState().user;
    return user ? { fullName: user.fullName ?? null, mobile: user.mobile, mobileVerified: user.mobileVerified } : null;
  },
  now: () => Date.now(),
  current: () => {
    const { location, liveDestination } = useLocation.getState();
    return { location, liveDestination };
  },
  apply: (location, liveDestination) => useLocation.getState().applyCurrentLocation(location, liveDestination),
  recheck: () => useLocation.getState().refresh(),
  setStatus: (gps) => useLocation.getState().setGps(gps),
});

export function refreshCurrentLocation(reason: RefreshReason, options: { prompt?: boolean } = {}) {
  return controller.refresh(reason, options);
}

export function ensureFreshCurrentLocation() {
  return controller.ensureFresh();
}

/* -------------------------------------------------------------------------- */
/* First launch: the system's location dialog, asked directly, once           */
/* -------------------------------------------------------------------------- */

// The key the earlier explanation screen used: installs that already saw it
// were asked then, and are not asked again.
const ASKED_KEY = 'adione.location-intro-shown';

const firstLaunch = createFirstLaunchLocation({
  async asked() {
    try {
      return (await AsyncStorage.getItem(ASKED_KEY)) === '1';
    } catch {
      // Unreadable storage: never risk asking twice — treat it as asked.
      return true;
    }
  },
  async markAsked() {
    await AsyncStorage.setItem(ASKED_KEY, '1');
  },
  permission: getLocationPermission,
  hasLocation: () => useLocation.getState().location !== null,
  // Android's own dialog (while using the app / only this time / don't
  // allow, precise or approximate), then a fresh reading and the server's
  // serviceability check for it.
  request: () => controller.refresh('launch', { prompt: true }),
});

/** First launch only: the system's location dialog, with no screen of Aadione's before or after it. */
export function requestLocationOnFirstLaunch() {
  return firstLaunch.run();
}
