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
import type { AuthResponse, LiveLocationInput, ServiceabilityResult, UserDto } from '@shared';
import { isValidCoordinates } from '@shared/distance';
import { api, ApiRequestError, readRefreshToken, saveRefreshToken, setAccessToken } from './api';
import { refreshFailureKind } from './guestAccess';
import { connectSocket, disconnectSocket } from './socket';
import { forgetPushRegistration, registerForPush } from './push';
import type { GpsStatus } from './currentLocation';

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `loading` — restoring a saved session at launch (the startup screen).
 * `authenticated` — a verified customer session.
 * `anonymous` — a guest: browsing works fully; account actions ask for a
 *   login through lib/authGate.ts. Signing out, an invalid saved session and
 *   an expired one all land here — never on a forced login screen.
 */
interface AuthState {
  user: UserDto | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  /** The last session ended on its own (expired / revoked), not by logging out. */
  sessionExpired: boolean;
  setSession: (result: AuthResponse) => Promise<void>;
  restore: () => Promise<void>;
  logout: () => Promise<void>;
  clear: () => void;
  /** The server refused the session mid-use: signed out, and says so. */
  expire: () => void;
}

/**
 * True when the launch-time restore could not reach the server: the saved
 * session is kept (it may be perfectly valid) and retried when the app
 * returns to the foreground, instead of being thrown away over a bad network.
 */
let restoreInterrupted = false;

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  status: 'loading',
  sessionExpired: false,

  async setSession(result) {
    setAccessToken(result.tokens.accessToken);
    await saveRefreshToken(result.tokens.refreshToken);
    // The socket authenticates with the access token, so it can only be
    // opened once a session exists — and must be reopened after a refresh.
    connectSocket(result.tokens.accessToken);
    // Registers the push token. Without this the server queues every order
    // update correctly and has nowhere to deliver it.
    void registerForPush();
    restoreInterrupted = false;
    set({ user: result.user, status: 'authenticated', sessionExpired: false });
  },

  /**
   * Silent re-login on cold start, so the customer is not asked for an OTP
   * daily. No saved session is not an error: the app opens for browsing as a
   * guest. A session the server refuses is cleared (guest again); one it
   * could not be asked about (offline, 5xx, rate limit) is kept for a retry.
   */
  async restore() {
    const refreshToken = await readRefreshToken();
    if (!refreshToken) {
      restoreInterrupted = false;
      set({ status: 'anonymous' });
      return;
    }
    try {
      const result = await api.post<AuthResponse>('/auth/refresh', { refreshToken });
      setAccessToken(result.tokens.accessToken);
      await saveRefreshToken(result.tokens.refreshToken);
      connectSocket(result.tokens.accessToken);
      void registerForPush();
      restoreInterrupted = false;
      set({ user: result.user, status: 'authenticated', sessionExpired: false });
    } catch (error) {
      setAccessToken(null);
      disconnectSocket();
      const status = error instanceof ApiRequestError ? error.status : 0;
      if (refreshFailureKind(status) === 'rejected') {
        restoreInterrupted = false;
        await saveRefreshToken(null);
        set({ user: null, status: 'anonymous', sessionExpired: true });
      } else {
        restoreInterrupted = true;
        set({ user: null, status: 'anonymous' });
      }
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
    // …nor offer them the previous customer's recipient / address.
    useLocation.getState().forgetPersonalChoice();
    restoreInterrupted = false;
    set({ user: null, status: 'anonymous', sessionExpired: false });
  },

  clear() {
    setAccessToken(null);
    void saveRefreshToken(null);
    disconnectSocket();
    // A shared phone must not keep pushing the previous customer's order
    // updates to whoever logs in next.
    forgetPushRegistration();
    useLocation.getState().forgetPersonalChoice();
    restoreInterrupted = false;
    set({ user: null, status: 'anonymous', sessionExpired: false });
  },

  expire() {
    get().clear();
    set({ sessionExpired: true });
  },
}));

/** Re-tries a launch restore that never reached the server (see `restoreInterrupted`). */
export function retryInterruptedRestore(): void {
  if (restoreInterrupted && useAuth.getState().status === 'anonymous') {
    restoreInterrupted = false;
    void useAuth.getState().restore();
  }
}

/** True for a verified customer session; false for a guest (or while restoring). */
export function useSignedIn(): boolean {
  return useAuth((state) => state.status === 'authenticated');
}

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
  /**
   * The village / town and PIN code this location was CONFIRMED with (a saved
   * address, or a live location whose details the customer confirmed). With
   * them the server decides delivery by the admin-approved pair; without
   * them (a bare GPS point) it can only give a hint.
   */
  village?: string | null;
  pincode?: string | null;
  /**
   * When that fix was taken (epoch ms), GPS only. A GPS location is the
   * phone's CURRENT position only while this is recent — it is read again on
   * launch, on return to the app and before an order (lib/currentLocation.ts).
   */
  fixedAt?: number | null;
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
  /** The live-location details for `location` (GPS only), if confirmed. */
  liveDestination?: LiveLocationInput | null;
  /**
   * The saved address `location` is (ADDRESS only). Without it a restart
   * kept Home on that address's point while checkout fell back to the
   * DEFAULT address — the order could go somewhere other than what was shown
   * and checked.
   */
  selectedAddressId?: string | null;
}

function isValidLiveDestination(value: unknown): value is LiveLocationInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.latitude === 'number' &&
    typeof v.longitude === 'number' &&
    isValidCoordinates(v.latitude, v.longitude) &&
    typeof v.fullName === 'string' &&
    typeof v.mobile === 'string' &&
    typeof v.city === 'string' &&
    typeof v.state === 'string'
  );
}

/** A live destination belongs to exactly this GPS point — never to any other. */
function liveDestinationFor(location: ChosenLocation, live: LiveLocationInput | null | undefined): LiveLocationInput | null {
  if (!live || location.source !== 'GPS') return null;
  return live.latitude === location.latitude && live.longitude === location.longitude ? live : null;
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
  liveDestination: LiveLocationInput | null,
  selectedAddressId: string | null,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      LOCATION_CACHE_KEY,
      JSON.stringify({
        location,
        serviceability,
        liveDestination,
        // Only an ADDRESS point belongs to a saved address.
        selectedAddressId: location.source === 'ADDRESS' ? selectedAddressId : null,
      } satisfies LocationCachePayload),
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
  /**
   * The live location the customer confirmed (point + recipient + address
   * details) — orders go to it directly, without saving an address. Only
   * ever set for the current GPS `location`; choosing anything else clears
   * it, so checkout can never send a stale point.
   */
  liveDestination: LiveLocationInput | null;
  checking: boolean;
  error: string | null;
  /** True once startup hydration from disk has run (whether or not it found anything). */
  hydrated: boolean;
  /**
   * The last attempt to read the phone's current position (lib/currentLocation.ts):
   * 'failed' keeps why (permission, GPS off, timeout, …) — a GPS location
   * from earlier is then NOT the current one.
   */
  gps: GpsStatus;
  setGps: (gps: GpsStatus) => void;
  /**
   * A fresh GPS reading becomes the chosen location: its live destination
   * (null when it cannot be one) replaces any saved-address choice, and the
   * server checks serviceability for it.
   */
  applyCurrentLocation: (location: ChosenLocation, liveDestination: LiveLocationInput | null) => Promise<void>;
  setLocation: (location: ChosenLocation) => Promise<void>;
  selectAddress: (addressId: string | null) => void;
  /** Set BEFORE `setLocation` for the same point (which would otherwise clear it). */
  setLiveDestination: (destination: LiveLocationInput | null) => void;
  /** On logout: drops the recipient / chosen address (memory and disk); keeps the point. */
  forgetPersonalChoice: () => void;
  /** Reads the persisted location/serviceability, if any valid one exists. */
  hydrate: () => Promise<void>;
  /**
   * Silent background re-verification of the CHOSEN location: re-checks
   * serviceability for the same coordinates (the store's own state — open,
   * radius — can change while the customer stays put). It never reads the
   * GPS itself: a fresh reading of the phone's position is taken by
   * lib/locationService.ts (launch, return to the app, before an order),
   * which replaces a GPS point only — never a saved address the customer
   * picked.
   */
  refresh: () => Promise<void>;
}

/** Each serviceability request's number: only the latest one may set the answer. */
let latestCheck = 0;

export const useLocation = create<LocationState>((set, get) => ({
  location: null,
  serviceability: null,
  selectedAddressId: null,
  liveDestination: null,
  checking: false,
  error: null,
  hydrated: false,
  gps: { phase: 'idle', failure: null },

  setGps(gps) {
    set({ gps });
  },

  async applyCurrentLocation(location, liveDestination) {
    // Never a saved address: a GPS point orders to itself (or, without a
    // complete live destination, checkout asks for the details / an address).
    set({ liveDestination, selectedAddressId: null });
    await get().setLocation({ ...location, source: 'GPS' });
  },

  async setLocation(location) {
    const check = ++latestCheck;
    const previous = get().location;
    const samePoint = !!previous && previous.latitude === location.latitude && previous.longitude === location.longitude;
    // A different point must never show the previous point's answer meanwhile;
    // re-checking the same point keeps it while the fresh one loads.
    set({
      location,
      serviceability: samePoint ? get().serviceability : null,
      // Any other point (or a saved address) is not the live destination.
      liveDestination: liveDestinationFor(location, get().liveDestination),
      checking: true,
      error: null,
    });
    try {
      // THE SERVER DECIDES. The app only displays the answer — it never
      // computes serviceability itself and never acts on a cached verdict.
      const place =
        location.village && location.pincode
          ? `&village=${encodeURIComponent(location.village)}&pincode=${encodeURIComponent(location.pincode)}`
          : '';
      const result = await api.get<ServiceabilityResult>(
        `/store/serviceability?lat=${location.latitude}&lng=${location.longitude}${place}`,
      );
      // A slower answer for a location the customer has since changed is stale.
      if (check !== latestCheck) return;
      set({ serviceability: result, checking: false });
      void persistLocationCache(location, result, get().liveDestination, get().selectedAddressId);
    } catch (error) {
      if (check !== latestCheck) return;
      set({
        checking: false,
        error: error instanceof Error ? error.message : 'Could not check your location.',
      });
    }
  },

  selectAddress(addressId) {
    // A saved address replaces the live destination.
    set(addressId ? { selectedAddressId: addressId, liveDestination: null } : { selectedAddressId: null });
    const { location, serviceability } = get();
    if (location && serviceability) void persistLocationCache(location, serviceability, get().liveDestination, get().selectedAddressId);
  },

  setLiveDestination(destination) {
    set(destination ? { liveDestination: destination, selectedAddressId: null } : { liveDestination: null });
  },

  forgetPersonalChoice() {
    set({ liveDestination: null, selectedAddressId: null });
    const { location, serviceability } = get();
    if (location && serviceability) void persistLocationCache(location, serviceability, null, null);
  },

  async hydrate() {
    try {
      const raw = await AsyncStorage.getItem(LOCATION_CACHE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isValidCachedLocation(parsed)) {
          const source = parsed.location.source === 'ADDRESS' ? 'ADDRESS' : 'GPS';
          const fixedAt = parsed.location.fixedAt;
          // Painted for the first frame only; a GPS point is read again at
          // launch, so its old reading time is kept (never refreshed here).
          const location: ChosenLocation = {
            ...parsed.location,
            source,
            fixedAt: source === 'GPS' && typeof fixedAt === 'number' && Number.isFinite(fixedAt) ? fixedAt : null,
          };
          set({
            location,
            serviceability: parsed.serviceability,
            // Restored only when it is complete and for this very point.
            liveDestination: isValidLiveDestination(parsed.liveDestination) ? liveDestinationFor(location, parsed.liveDestination) : null,
            // The saved address this point is — so checkout orders to the same
            // address Home shows (checkout drops it if the address was deleted).
            selectedAddressId:
              location.source === 'ADDRESS' && typeof parsed.selectedAddressId === 'string' && parsed.selectedAddressId
                ? parsed.selectedAddressId
                : null,
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
