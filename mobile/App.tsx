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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";

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
  /* FCM Push Notification Token                                              */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    const registerForPushNotifications = async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();

        if (status !== "granted") {
          console.log("Notification permission denied");
          return;
        }

        const token = await Notifications.getDevicePushTokenAsync();

        console.log("FCM TOKEN:", token.data);
      } catch (error) {
        console.error("FCM token error:", error);
      }
    };

    void registerForPushNotifications();
  }, []);

  /* ------------------------------------------------------------------------ */
  /* Restore authentication session                                           */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    let mounted = true;

    onSessionExpired(clear);

    const startTime = Date.now();

    const restoreSession = async () => {
      try {
        await restore();
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
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />

        <NavigationContainer>
          {status === "loading" || !startupReady ? (
            <StartupLoading />
          ) : status === "authenticated" ? (
            <MainFlow />
          ) : (
            <AuthStack />
          )}
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
