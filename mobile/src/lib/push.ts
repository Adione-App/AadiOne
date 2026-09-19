/**
 * Push registration.
 *
 * Without this the whole notification pipeline is inert: the server queues
 * every order update correctly, but with no device token on file there is
 * nowhere to send them.
 *
 * Registration is best-effort. A customer who declines notifications must
 * still be able to shop, so nothing here throws into the caller.
 *
 * WHY `expo-notifications` IS LOADED LAZILY, NOT IMPORTED NORMALLY:
 * as of SDK 53, Android push is removed from Expo Go entirely — and the
 * module throws the instant it is imported there, as a side effect deep
 * inside its own auto-registration code (`DevicePushTokenAutoRegistration.fx`
 * calls `addPushTokenListener` at module scope, unconditionally). That
 * happens during module evaluation, before any of our own code runs, so no
 * try/catch around a function call here can ever catch it — only *not
 * importing the module at all* in Expo Go avoids the crash. Push works
 * normally in a real development or production build.
 */

import { Platform } from "react-native";
import Constants from "expo-constants";
import { isRunningInExpoGo } from "expo";
import { api } from "./api";

type NotificationsModule = typeof import("expo-notifications");

const Notifications: NotificationsModule | null = isRunningInExpoGo()
  ? null
  : (require("expo-notifications") as NotificationsModule);

/** Banner + sound while the app is open, so a live order update is noticed. */
Notifications?.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let registeredToken: string | null = null;

export async function registerForPush(): Promise<void> {
  // Expo Go: push is unavailable by design (see note above) — shopping still
  // works, order updates are just not pushed until a real build is installed.
  if (!Notifications) return;

  try {
    // A simulator has no push service; asking would only produce an error.
    if (!Constants.isDevice) return;

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;

    // Only prompt if we have not been answered before — re-asking someone who
    // already said no is the fastest way to be uninstalled.
    if (status === "undetermined") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return;

    if (Platform.OS === "android") {
      // Android 8+ ignores notifications without a channel.
      await Notifications.setNotificationChannelAsync("orders", {
        name: "Order updates",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    // The backend's FcmNotificationProvider calls Google's FCM v1 API
    // directly with its own service account (see notification.service.ts) —
    // it is NOT going through Expo's push relay. That endpoint needs the
    // device's actual native registration token, not an Expo push token
    // (`ExponentPushToken[...]`, from `getExpoPushTokenAsync`), which Google
    // rejects as an invalid FCM token. `getDevicePushTokenAsync` returns
    // that native token directly, using the app's own `google-services.json`
    // (Android) with no Expo project id involved.
    const token = (await Notifications.getDevicePushTokenAsync()).data;

    // Re-posting the same token on every launch is wasted traffic on a
    // connection where every request costs the customer.
    if (token === registeredToken) return;

    await api.post("/devices", {
      token,
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
      appVersion: Constants.expoConfig?.version ?? "1.0.0",
    });

    registeredToken = token;
  } catch {
    // Silent: notifications are a convenience, not a requirement to shop.
  }
}

export function forgetPushRegistration(): void {
  registeredToken = null;
}
