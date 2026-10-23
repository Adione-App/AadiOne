/**
 * App root.
 *
 * Startup flow:
 *
 * 1. Android native splash is kept visually blank.
 * 2. React Native StartupLoading is shown immediately.
 * 3. StartupLoading remains visible for at least 1.5 seconds.
 * 4. After session restore finishes, the shopping tabs open — signed in or
 *    not. Browsing never requires an account (App Store guideline 5.1.1(v)):
 *    a guest gets the same Home, categories, search, products and food menus,
 *    and the login flow (the "Login" modal below) opens only when they start
 *    something that belongs to an account — see lib/authGate.ts.
 */

import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as ExpoSplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { QueryClient, useIsRestoring } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { onSessionExpired } from "@/lib/api";
import { retryInterruptedRestore, useAuth, useLocation } from "@/lib/store";
import { loginClosed } from "@/lib/authGate";
import { isPrivateQueryKey } from "@/lib/guestAccess";
import { forgetPrivateQueries } from "@/lib/queries";
import { useRecentSearches } from "@/lib/recentSearches";
import { useWishlist } from "@/lib/useWishlist";
import { forgetCartAfterSignOut, hydrateCartFromDisk } from "@/lib/useCartActions";
import { selectUpdateRequired, useAppUpdate } from "@/lib/appUpdate";
import { AppUpdatePrompt } from "@/components/AppUpdatePrompt";
import UpdateRequiredScreen from "@/screens/update/UpdateRequiredScreen";

import { StartupLoading } from "@/components/ui";
import { FlyToCartOverlay } from "@/lib/flyToCart";
import { VariantSheetHost } from "@/components/VariantSheet";
import { CartNoticeToast } from "@/components/CartNoticeToast";

import MobileEntryScreen from "@/screens/auth/MobileEntryScreen";
import OtpVerifyScreen from "@/screens/auth/OtpVerifyScreen";

import { MainTabs } from "@/navigation/MainTabs";
import { navigationRef } from "@/navigation/navigationRef";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { installCrashHandlers } from "@/lib/crashReporter";
import type { AuthStackParamList, RootStackParamList } from "@/navigation/types";

/* -------------------------------------------------------------------------- */
/* Keep native splash visible until React Native is ready.                    */
/* -------------------------------------------------------------------------- */

// Crash reports (lib/crashReporter.ts): before anything else can throw.
installCrashHandlers();

void ExpoSplashScreen.preventAutoHideAsync().catch(() => {
  // Native splash may already be hidden. Safe to ignore.
});

/* -------------------------------------------------------------------------- */

const Root = createNativeStackNavigator<RootStackParamList>();
const LoginNav = createNativeStackNavigator<AuthStackParamList>();

/* -------------------------------------------------------------------------- */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },

    mutations: {
      retry: false,
    },
  },
});

/**
 * Persists the whole query cache (Home feed, categories, products, cart, …)
 * to disk, so a returning customer's Home renders from what was on screen
 * last time instead of a blank loading state while the first fetch of a
 * fresh session completes. Every restored query is still exactly as stale as
 * it was before persistence existed — `staleTime`/`refetchOnMount` above
 * decide when it silently refetches, persistence only decides what the very
 * first paint looks like.
 */
const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "adione.rq-cache",
});

/* -------------------------------------------------------------------------- */
/* Login flow                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The existing mobile-number → OTP screens, presented as one modal over the
 * shopping tabs (the "Login" root route) — opened only by lib/authGate.ts.
 * However it goes away (login, back, swipe down, "Not now"), unmounting here
 * tells the gate; anything still waiting for a login is then dropped.
 */
function LoginFlow() {
  useEffect(() => () => loginClosed(), []);

  return (
    <LoginNav.Navigator screenOptions={{ headerShown: false }}>
      <LoginNav.Screen name="MobileEntry" component={MobileEntryScreen} />
      <LoginNav.Screen name="OtpVerify" component={OtpVerifyScreen} />
    </LoginNav.Navigator>
  );
}

/**
 * The query cache restore from disk (see `asyncStoragePersister` above) is a
 * separate async step from auth/location hydration — `useIsRestoring` can
 * only be read by a component rendered INSIDE `PersistQueryClientProvider`,
 * which is why this isn't just inlined into `App`. While it's true, queries
 * are held back from fetching so a real network response can't race a
 * still-loading disk read and overwrite it — so this is also the one moment
 * `MainTabs`/`HomeScreen` must not be allowed to mount yet, or a returning
 * customer would see a flash of "could not load" before the restored Home
 * feed appears a beat later.
 *
 * After startup, signed in or not, the root is always the same tree: the
 * shopping tabs, with the login modal above them when needed. Logging in or
 * out never swaps the tree, so the customer stays on the screen they were on.
 * The location is never asked for up front: it is chosen from Home's location
 * header → SelectLocation; ordering still needs a chosen address the server
 * confirms it delivers to.
 */
function RootNavigator({
  status,
  startupReady,
}: {
  status: "loading" | "authenticated" | "anonymous";
  startupReady: boolean;
}) {
  const isRestoring = useIsRestoring();
  const updateRequired = useAppUpdate(selectUpdateRequired);
  const update = useAppUpdate((state) => state.check);

  // An update the installed version MUST take replaces the whole app — not a
  // modal over it: no navigator is mounted, so there is no screen to go back
  // to, no tab bar and no deep link around it (see UpdateRequiredScreen).
  if (startupReady && updateRequired) {
    return <UpdateRequiredScreen update={update} />;
  }

  return (
    <NavigationContainer ref={navigationRef}>
      {status === "loading" || !startupReady || isRestoring ? (
        <StartupLoading />
      ) : (
        <Root.Navigator screenOptions={{ headerShown: false }}>
          <Root.Screen name="Main" component={MainTabs} />
          <Root.Screen
            name="Login"
            component={LoginFlow}
            // iOS: a card sheet, swipe down to close; Android: slides up,
            // back closes it. Either way the screen beneath stays as it was.
            options={{ presentation: "modal" }}
          />
        </Root.Navigator>
      )}
    </NavigationContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export default function App() {
  const status = useAuth((state) => state.status);
  const restore = useAuth((state) => state.restore);
  const expire = useAuth((state) => state.expire);

  /*
   * This state controls the minimum time for the branded startup screen.
   *
   * We want:
   *
   * Home screen
   *      ↓
   * AadiOne StartupLoading
   *      ↓ at least 1.5 sec
   * Shopping tabs (Home) — signed in or browsing as a guest
   */
  const [startupReady, setStartupReady] = useState(false);

  /* ------------------------------------------------------------------------ */
  /* Signed out: forget the previous customer's data                          */
  /* ------------------------------------------------------------------------ */

  // Logout, an expired session, or a launch without one: the cart, orders,
  // addresses and rewards of whoever was signed in leave memory and disk, so
  // a guest (or the next account on a shared phone) never sees them.
  useEffect(
    () =>
      useAuth.subscribe((state, previous) => {
        if (state.status === "anonymous" && previous.status !== "anonymous") {
          forgetPrivateQueries(queryClient);
          forgetCartAfterSignOut();
        }
      }),
    [],
  );

  /* ------------------------------------------------------------------------ */
  /* Restore authentication session                                           */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    let mounted = true;

    // A session the server refuses mid-use: signed out, browsing continues.
    onSessionExpired(expire);

    const startTime = Date.now();

    const restoreSession = async () => {
      try {
        // Runs alongside auth restore, not after it — reading the location
        // cache is a single local disk read, and there is no reason a
        // returning customer's Home should wait for it to finish before the
        // auth check does. `refresh()` (the actual network re-verification)
        // happens later, once Home mounts — see HomeScreen's own effect.
        //
        // `hydrateCartFromDisk()` is the same kind of local-only read —
        // restoring the last known cart so Product Cards/Mini Cart don't
        // render their empty defaults while the first `/cart` request is
        // still in flight (see useCartActions.ts's own comment on this).
        // It has to finish before `startupReady` flips true below, since
        // that's what gates MainTabs (and therefore every cart-dependent
        // screen) from mounting at all.
        await Promise.all([
          restore(),
          useLocation.getState().hydrate(),
          useRecentSearches.getState().hydrate(),
          useWishlist.getState().hydrate(),
          hydrateCartFromDisk(),
          // The last update answer for this installed version (offline launch).
          useAppUpdate.getState().hydrate(),
        ]);
        // The cart snapshot is read from disk alongside the restore, so it
        // can land after the status already turned guest: drop it again.
        if (useAuth.getState().status !== "authenticated") forgetCartAfterSignOut();
        // Ask the server about this installed version before the app shows,
        // so a required update appears first — but never hold a slow or
        // offline launch for long: the server enforces it on its own too.
        await Promise.race([
          useAppUpdate.getState().refresh({ force: true }),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      } finally {
        if (!mounted) {
          return;
        }

        /*
         * Minimum startup screen duration.
         *
         * If restore finishes very quickly, wait for the remaining time.
         */
        const elapsed = Date.now() - startTime;

        const minimumDuration = 1500;

        const remainingTime = Math.max(0, minimumDuration - elapsed);

        setTimeout(() => {
          if (!mounted) {
            return;
          }

          setStartupReady(true);
        }, remainingTime);
      }
    };

    void restoreSession();

    return () => {
      mounted = false;
    };
  }, [restore, expire]);

  /* ------------------------------------------------------------------------ */
  /* Re-check the update policy whenever the app comes back to the front      */
  /* (e.g. from the Play Store / App Store after "Update Now").               */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      void useAppUpdate.getState().refresh();
      // A saved session the launch could not verify (offline) gets another go.
      retryInterruptedRestore();
    });
    return () => subscription.remove();
  }, []);

  const updateRequired = useAppUpdate(selectUpdateRequired);

  /* ------------------------------------------------------------------------ */
  /* Hide Android native splash                                               */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (status !== "loading") {
      void ExpoSplashScreen.hideAsync().catch(() => {
        // Safe to ignore if already hidden.
      });
    }
  }, [status]);

  /* ------------------------------------------------------------------------ */
  /* App UI                                                                    */
  /* ------------------------------------------------------------------------ */

  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister: asyncStoragePersister,
            // A stale week-old cache still beats a blank screen on a bad
            // connection (see requirement on offline usability) — every
            // restored query re-validates itself the moment it's observed
            // again, per its own staleTime, exactly as if it had never left
            // memory.
            maxAge: 7 * 24 * 60 * 60_000,
            // Bump this whenever a persisted DTO shape changes incompatibly
            // (e.g. HomeFeedDto gaining a required `categoryRails` field), or
            // — as here — whenever what's ALLOWED to be persisted changes.
            // `shouldDehydrateQuery` below only takes effect on the next save;
            // without bumping this, a device that already has an old snapshot
            // on disk (written before cart/orders were excluded) would still
            // restore that stale cart/order data one more time before its next
            // save overwrites it clean. Bumping discards every old snapshot
            // outright, so the exclusion is in effect from the very next
            // launch instead of one session later.
            // v4: addresses, rewards, previous orders, checkout quotes and
            // payment intents stopped being persisted (customer data does not
            // belong in plain-text AsyncStorage) — drop old snapshots holding them.
            buster: "v4",
            // Cart and order data are excluded from disk persistence entirely.
            // Unlike Home/categories/products — read-heavy, low-stakes, fine to
            // paint stale-then-refresh — a week-old cart or order snapshot is
            // an ACTIVE mistake, not just a stale paint: it directly caused a
            // cancelled order's items to reappear as if they were still in the
            // cart on a later app open, and a cancelled order to still read
            // "Ongoing" until something happened to trigger a refetch. These
            // queries hit the network fresh every time they're first observed
            // in a session (see `refetchOnMount: 'always'` on them in
            // queries.ts) — persistence would only reintroduce that staleness
            // window, not help it. Notifications are excluded for the same
            // reason, and because they are one customer's private messages —
            // as is everything else in PRIVATE_QUERY_ROOTS (lib/guestAccess.ts).
            dehydrateOptions: {
              shouldDehydrateQuery: (query) => !isPrivateQueryKey(query.queryKey),
            },
          }}
        >
          <StatusBar style="dark" />
  
          <RootNavigator status={status} startupReady={startupReady} />
  
          {/* Nothing of the app is layered over a required update. */}
          {updateRequired ? null : (
            <>
              {/* Mounted last so it paints above the tab bar/screens — see
                  flyToCart.tsx for why this needs to be a root-level overlay. */}
              <FlyToCartOverlay />
  
              {/* The variant sheet any product card opens (lib/variantSheet.ts). */}
              <VariantSheetHost />
  
              {/* Cart popups, e.g. a quantity limit reached (lib/cartNotice.ts). */}
              <CartNoticeToast />
  
              {/* An optional update: one dismissible prompt (lib/appUpdate.ts). */}
              {startupReady ? <AppUpdatePrompt /> : null}
            </>
          )}
        </PersistQueryClientProvider>
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}
