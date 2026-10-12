/**
 * Client state (Zustand).
 *
 * ONLY client state lives here — tokens, the chosen address, serviceability.
 * Server state (products, cart, orders) belongs to TanStack Query, because
 * caching, retries and stale-while-revalidate on a bad network are the hard
 * part and are exactly what it exists to solve.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AuthResponse, ServiceabilityResult, UserDto } from '@shared';
import { isValidCoordinates } from '@shared/distance';
import { api, readRefreshToken, saveRefreshToken, setAccessToken } from './api';
import { connectSocket, disconnectSocket } from './socket';
import { forgetPushRegistration, registerForPush } from './push';

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

interface AuthState {
  user: UserDto | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  setSession: (result: AuthResponse) => Promise<void>;
  restore: () => Promise<void>;
  logout: () => Promise<void>;
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'loading',

  async setSession(result) {
    setAccessToken(result.tokens.accessToken);
    await saveRefreshToken(result.tokens.refreshToken);
    // The socket authenticates with the access token, so it can only be
    // opened once a session exists — and must be reopened after a refresh.
    connectSocket(result.tokens.accessToken);
    // Registers the push token. Without this the server queues every order
    // update correctly and has nowhere to deliver it.
    void registerForPush();
    set({ user: result.user, status: 'authenticated' });
  },

  /** Silent re-login on cold start, so the customer is not asked for an OTP daily. */
  async restore() {
    const refreshToken = await readRefreshToken();
    if (!refreshToken) {
      set({ status: 'anonymous' });
      return;
    }
    try {
      const result = await api.post<AuthResponse>('/auth/refresh', { refreshToken });
      setAccessToken(result.tokens.accessToken);
      await saveRefreshToken(result.tokens.refreshToken);
      connectSocket(result.tokens.accessToken);
      void registerForPush();
      set({ user: result.user, status: 'authenticated' });
    } catch {
      setAccessToken(null);
      await saveRefreshToken(null);
      disconnectSocket();
      set({ user: null, status: 'anonymous' });
    }
  },

  async logout() {
    const refreshToken = await readRefreshToken();
    // Revoked server-side — clearing the device alone leaves the session live.
    await api.post('/auth/logout', { refreshToken }).catch(() => undefined);
    setAccessToken(null);
    await saveRefreshToken(null);
    disconnectSocket();
    // A shared phone must not keep pushing the previous customer's order
    // updates to whoever logs in next.
    forgetPushRegistration();
    set({ user: null, status: 'anonymous' });
  },

  clear() {
    setAccessToken(null);
    void saveRefreshToken(null);
    disconnectSocket();
    // A shared phone must not keep pushing the previous customer's order
    // updates to whoever logs in next.
    forgetPushRegistration();
    set({ user: null, status: 'anonymous' });
  },
}));

/* -------------------------------------------------------------------------- */
/* Location & serviceability                                                  */
/* -------------------------------------------------------------------------- */

export interface ChosenLocation {
  latitude: number;
  longitude: number;
  label: string;
  /**
   * GPS: a fresh device fix the customer confirmed. ADDRESS: a saved address
   * they picked. A chosen location is never replaced behind their back — only
   * by their own next choice.
   */
  source: 'GPS' | 'ADDRESS';
  /** The fix's reported accuracy radius (metres), GPS only. */
  accuracyM?: number | null;
}

/**
 * Persisted so a returning customer's Home renders from this immediately
 * instead of waiting on a fresh GPS fix + serviceability round trip on every
 * cold start. `refresh()` always re-verifies against the server in the
 * background straight after — this cache is only ever used to paint the
 * first frame, never as a substitute for the server's answer.
 */
const LOCATION_CACHE_KEY = 'adione.location-cache';

interface LocationCachePayload {
  location: ChosenLocation;
  serviceability: ServiceabilityResult;
}

function isValidCachedLocation(value: unknown): value is LocationCachePayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const loc = v.location as Record<string, unknown> | undefined;
  const svc = v.serviceability as Record<string, unknown> | undefined;
  return (
    !!loc &&
    typeof loc.latitude === 'number' &&
    typeof loc.longitude === 'number' &&
    typeof loc.label === 'string' &&
    isValidCoordinates(loc.latitude, loc.longitude) &&
    !(loc.latitude === 0 && loc.longitude === 0) &&
    !!svc &&
    typeof svc.serviceable === 'boolean' &&
    typeof svc.distanceKm === 'number'
  );
}

async function persistLocationCache(
  location: ChosenLocation,
  serviceability: ServiceabilityResult,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      LOCATION_CACHE_KEY,
      JSON.stringify({ location, serviceability } satisfies LocationCachePayload),
    );
  } catch {
    // Best-effort — a failed write just means the next cold start falls back
    // to the normal first-time flow instead of starting instantly.
  }
}

interface LocationState {
  location: ChosenLocation | null;
  serviceability: ServiceabilityResult | null;
  /** Which saved address the customer is ordering to. */
  selectedAddressId: string | null;
  checking: boolean;
  error: string | null;
  /** True once startup hydration from disk has run (whether or not it found anything). */
  hydrated: boolean;
  setLocation: (location: ChosenLocation) => Promise<void>;
  selectAddress: (addressId: string | null) => void;
  /** Reads the persisted location/serviceability, if any valid one exists. */
  hydrate: () => Promise<void>;
  /**
   * Silent background re-verification of the CHOSEN location: re-checks
   * serviceability for the same coordinates (the store's own state — open,
   * radius — can change while the customer stays put). It never swaps in the
   * device's current position: that used to replace a saved address or a
   * confirmed point with a minutes-old, unchecked GPS reading.
   */
  refresh: () => Promise<void>;
}

/** Each serviceability request's number: only the latest one may set the answer. */
let latestCheck = 0;

export const useLocation = create<LocationState>((set, get) => ({
  location: null,
  serviceability: null,
  selectedAddressId: null,
  checking: false,
  error: null,
  hydrated: false,

  async setLocation(location) {
    const check = ++latestCheck;
    const previous = get().location;
    const samePoint = !!previous && previous.latitude === location.latitude && previous.longitude === location.longitude;
    // A different point must never show the previous point's answer meanwhile;
    // re-checking the same point keeps it while the fresh one loads.
    set({ location, serviceability: samePoint ? get().serviceability : null, checking: true, error: null });
    try {
      // THE SERVER DECIDES. The app only displays the answer — it never
      // computes serviceability itself and never acts on a cached verdict.
      const result = await api.get<ServiceabilityResult>(
        `/store/serviceability?lat=${location.latitude}&lng=${location.longitude}`,
      );
      // A slower answer for a location the customer has since changed is stale.
      if (check !== latestCheck) return;
      set({ serviceability: result, checking: false });
      void persistLocationCache(location, result);
    } catch (error) {
      if (check !== latestCheck) return;
      set({
        checking: false,
        error: error instanceof Error ? error.message : 'Could not check your location.',
      });
    }
  },

  selectAddress(addressId) {
    set({ selectedAddressId: addressId });
  },

  async hydrate() {
    try {
      const raw = await AsyncStorage.getItem(LOCATION_CACHE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isValidCachedLocation(parsed)) {
          set({
            location: { ...parsed.location, source: parsed.location.source === 'ADDRESS' ? 'ADDRESS' : 'GPS' },
            serviceability: parsed.serviceability,
          });
        }
      }
    } catch {
      // Corrupt/unreadable cache — fall through to the normal first-time flow.
    } finally {
      set({ hydrated: true });
    }
  },

  async refresh() {
    const { location } = get();
    if (!location) return;
    // The same coordinates, re-verified — never replaced (see the interface).
    await get().setLocation(location);
  },
}));

/* -------------------------------------------------------------------------- */
/* App preferences                                                            */
/* -------------------------------------------------------------------------- */

interface PreferenceState {
  language: 'en' | 'hi';
  hasSeenOnboarding: boolean;
  setLanguage: (language: 'en' | 'hi') => void;
  completeOnboarding: () => void;
}

export const usePreferences = create<PreferenceState>((set) => ({
  language: 'en',
  hasSeenOnboarding: false,
  setLanguage: (language) => set({ language }),
  completeOnboarding: () => set({ hasSeenOnboarding: true }),
}));
