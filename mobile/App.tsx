/**
 * App root.
 *
 * Navigation is driven by auth state rather than by imperative navigate calls.
 *
 * Startup flow:
 *
 * 1. Android native splash is kept visually blank.
 * 2. React Native StartupLoading is shown immediately.
 * 3. StartupLoading remains visible for at least 1.5 seconds.
 * 4. After auth restore finishes, the normal app flow continues.
 */

import { useEffect, useState } from "react";
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
import { useAuth, useLocation } from "@/lib/store";

import { StartupLoading } from "@/components/ui";

import SplashScreen from "@/screens/auth/SplashScreen";
import MobileEntryScreen from "@/screens/auth/MobileEntryScreen";
import OtpVerifyScreen from "@/screens/auth/OtpVerifyScreen";
import LocationScreen from "@/screens/location/LocationScreen";

import { MainTabs } from "@/navigation/MainTabs";
import type { AuthStackParamList } from "@/navigation/types";

/* -------------------------------------------------------------------------- */
/* Keep native splash visible until React Native is ready.                    */
/* -------------------------------------------------------------------------- */

void ExpoSplashScreen.preventAutoHideAsync().catch(() => {
  // Native splash may already be hidden. Safe to ignore.
});

/* -------------------------------------------------------------------------- */

const Stack = createNativeStackNavigator<AuthStackParamList>();

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
/* Auth Stack                                                                 */
/* -------------------------------------------------------------------------- */

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Splash">
        {({ navigation }) => (
          <SplashScreen
            onGetStarted={() => navigation.navigate("MobileEntry")}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="MobileEntry" component={MobileEntryScreen} />

      <Stack.Screen name="OtpVerify" component={OtpVerifyScreen} />
    </Stack.Navigator>
  );
}

/* -------------------------------------------------------------------------- */
/* Main Flow                                                                  */
/* -------------------------------------------------------------------------- */

function MainFlow() {
  const serviceability = useLocation((state) => state.serviceability);

  const [locationDone, setLocationDone] = useState(false);

  if (!locationDone && !serviceability) {
    return <LocationScreen onReady={() => setLocationDone(true)} />;
  }

  return <MainTabs />;
}

/**
 * The query cache restore from disk (see `asyncStoragePersister` above) is a
 * separate async step from auth/location hydration — `useIsRestoring` can
 * only be read by a component rendered INSIDE `PersistQueryClientProvider`,
 * which is why this isn't just inlined into `App`. While it's true, queries
 * are held back from fetching so a real network response can't race a
 * still-loading disk read and overwrite it — so this is also the one moment
 * `MainFlow`/`HomeScreen` must not be allowed to mount yet, or a returning
 * customer would see a flash of "could not load" before the restored Home
 * feed appears a beat later.
 */
function RootNavigator({
  status,
  startupReady,
}: {
  status: "loading" | "authenticated" | "anonymous";
  startupReady: boolean;
}) {
  const isRestoring = useIsRestoring();

  return (
    <NavigationContainer>
      {status === "loading" || !startupReady || isRestoring ? (
        <StartupLoading />
      ) : status === "authenticated" ? (
        <MainFlow />
      ) : (
        <AuthStack />
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
  const clear = useAuth((state) => state.clear);

  /*
   * This state controls the minimum time for the branded startup screen.
   *
   * We want:
   *
   * Home screen
   *      ↓
   * AadiOne StartupLoading
   *      ↓ at least 1.5 sec
   * Auth / Get Started screen
   */
  const [startupReady, setStartupReady] = useState(false);

  /* ------------------------------------------------------------------------ */
  /* Restore authentication session                                           */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    let mounted = true;

    onSessionExpired(clear);

    const startTime = Date.now();

    const restoreSession = async () => {
      try {
        // Runs alongside auth restore, not after it — reading the location
        // cache is a single local disk read, and there is no reason a
        // returning customer's Home should wait for it to finish before the
        // auth check does. `refresh()` (the actual network re-verification)
        // happens later, once Home mounts — see HomeScreen's own effect.
        await Promise.all([restore(), useLocation.getState().hydrate()]);
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
  }, [restore, clear]);

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
          // (e.g. HomeFeedDto gaining a required `categoryRails` field) — it
          // invalidates every previously persisted cache instead of letting
          // an old shape get restored into code that now assumes the new
          // one, which crashes on render rather than just refetching.
          buster: "v2",
        }}
      >
        <StatusBar style="dark" />

        <RootNavigator status={status} startupReady={startupReady} />
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}
