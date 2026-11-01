/**
 * The app's one current-location controller (lib/currentLocation.ts) wired
 * to expo-location and the location store. Everything that wants the phone's
 * position now — launch, return to the app, "Use current location", checkout
 * — goes through here, so concurrent requests share one GPS reading.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createCurrentLocation, type RefreshReason } from './currentLocation';
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
/* First launch: the explanation before the system's permission dialog        */
/* -------------------------------------------------------------------------- */

const INTRO_SHOWN_KEY = 'adione.location-intro-shown';

/** True once the explanation has been shown on this install (it is shown once, ever). */
export async function locationIntroShown(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(INTRO_SHOWN_KEY)) === '1';
  } catch {
    // Unreadable storage: never nag — treat it as shown.
    return true;
  }
}

export async function markLocationIntroShown(): Promise<void> {
  try {
    await AsyncStorage.setItem(INTRO_SHOWN_KEY, '1');
  } catch {
    // Best effort.
  }
}

/** Should the first-launch explanation appear now? Never asked, nothing chosen, not shown before. */
export async function shouldShowLocationIntro(): Promise<boolean> {
  if (useLocation.getState().location) return false;
  if (await locationIntroShown()) return false;
  try {
    const permission = await getLocationPermission();
    return !permission.granted && permission.canAskAgain;
  } catch {
    return false;
  }
}
