/**
 * App root.
 *
 * Navigation is driven by auth state rather than by imperative navigate calls,
 * so a session expiring mid-flow lands the customer on login instead of on a
 * screen that silently fails every request.
 */

import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { onSessionExpired } from "@/lib/api";
import { useAuth, useLocation } from "@/lib/store";
import { StartupLoading } from "@/components/ui";
import SplashScreen from "@/screens/auth/SplashScreen";
import MobileEntryScreen from "@/screens/auth/MobileEntryScreen";
import OtpVerifyScreen from "@/screens/auth/OtpVerifyScreen";
import LocationScreen from "@/screens/location/LocationScreen";
import { MainTabs } from "@/navigation/MainTabs";
import type { AuthStackParamList } from "@/navigation/types";

const Stack = createNativeStackNavigator<AuthStackParamList>();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retries are handled in the API client, which knows the difference
      // between "offline" and "server error" — Query would retry both.
      retry: false,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

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

function MainFlow() {
  const serviceability = useLocation((state) => state.serviceability);
  const [locationDone, setLocationDone] = useState(false);

  // Location is asked for AFTER login, not before: a customer who has not yet
  // decided to use the app should not be met with a system permission dialog.
  if (!locationDone && !serviceability) {
    return <LocationScreen onReady={() => setLocationDone(true)} />;
  }

  return <MainTabs />;
}

export default function App() {
  const status = useAuth((state) => state.status);
  const restore = useAuth((state) => state.restore);
  const clear = useAuth((state) => state.clear);

  useEffect(() => {
    onSessionExpired(clear);
    void restore();
  }, [restore, clear]);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        <NavigationContainer>
          {status === "loading" ? (
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
