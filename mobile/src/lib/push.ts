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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "./api";
import { orderIdFromPushData } from "./notifications";

type NotificationsModule = typeof import("expo-notifications");
type NotificationResponse = import("expo-notifications").NotificationResponse;

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

/** The Android channel order updates are shown on — the server's pushes name it. */
export const ORDERS_CHANNEL_ID = "orders";

let registeredToken: string | null = null;

/**
 * The token this phone last registered for the signed-in account, kept on
 * disk so that signing out after a restart can still tell the server which
 * token to detach (POST /auth/logout { deviceToken }). Not secret: a push
 * token only lets a server send to this app.
 */
const TOKEN_KEY = "adione.push-token";

/** This phone's registered push token, if any (memory first, then disk). */
export async function currentPushToken(): Promise<string | null> {
  if (registeredToken) return registeredToken;
  try {
    return await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function postToken(token: string): Promise<void> {
  await api.post("/devices", {
    token,
    platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
    appVersion: Constants.expoConfig?.version ?? "1.0.0",
  });
  registeredToken = token;
  await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => undefined);
}

/**
 * Firebase can rotate a token at any time. While signed in, the new one is
 * registered at once (the server moves pushes to it); signed out, it is not
 * sent anywhere — the next sign-in registers it.
 */
let tokenListening = false;
let isSignedIn: () => boolean = () => false;

export function followTokenChanges(signedIn: () => boolean): void {
  isSignedIn = signedIn;
  if (!Notifications || tokenListening) return;
  tokenListening = true;
  Notifications.addPushTokenListener((event) => {
    const token = typeof event.data === "string" ? event.data : null;
    if (!token || token === registeredToken || !isSignedIn()) return;
    void postToken(token).catch(() => undefined);
  });
}

export async function registerForPush(): Promise<void> {
  // Expo Go: push is unavailable by design (see note above) — shopping still
  // works, order updates are just not pushed until a real build is installed.
  if (!Notifications) return;

  // Android only. The server sends through FCM v1, which accepts only an FCM
  // registration token — on iOS `getDevicePushTokenAsync` returns an APNs
  // token instead, which FCM rejects, so iOS (no Firebase iOS SDK) is not
  // asked for permission it could not use.
  // (No emulator check: `Constants.isDevice` no longer exists — it was always
  // undefined, which made this return on every phone. An emulator without
  // Google Play simply fails to fetch a token below, caught like any failure.)
  if (Platform.OS !== "android") return;

  try {
    // Android 8+ ignores notifications without a channel. Created before the
    // permission prompt (Expo's guidance for Android 13+); the server names
    // this same id in every push (notification.service.ts, ANDROID_CHANNEL_ID),
    // so order updates arrive as "Order updates" with a heads-up banner.
    await Notifications.setNotificationChannelAsync(ORDERS_CHANNEL_ID, {
      name: "Order updates",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;

    // Only prompt if we have not been answered before — re-asking someone who
    // already said no is the fastest way to be uninstalled.
    if (status === "undetermined") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return;

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

    await postToken(token);
  } catch {
    // Silent: notifications are a convenience, not a requirement to shop.
  }
}

/**
 * Tapping a push about an order opens that order — including the tap that
 * started the app from closed (`getLastNotificationResponse`, read once the
 * caller subscribes). Each tap is acted on once, however often this is
 * re-subscribed (sign-out and in again). Returns the unsubscribe.
 */
const handledTaps = new Set<string>();

export function openOrdersFromPushTaps(openOrder: (orderId: string) => void): () => void {
  const N = Notifications;
  if (!N) return () => undefined;
  const handle = (response: NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== N.DEFAULT_ACTION_IDENTIFIER) return;
    const { request, date } = response.notification;
    const key = `${request.identifier}:${date}`;
    if (handledTaps.has(key)) return;
    handledTaps.add(key);
    const orderId = orderIdFromPushData(request.content.data);
    if (orderId) openOrder(orderId);
  };
  const subscription = N.addNotificationResponseReceivedListener(handle);
  try {
    handle(N.getLastNotificationResponse());
  } catch {
    // No launch tap to read: nothing to open.
  }
  return () => subscription.remove();
}

/** Signed out: this phone no longer has a token registered for an account. */
export function forgetPushRegistration(): void {
  registeredToken = null;
  void AsyncStorage.removeItem(TOKEN_KEY).catch(() => undefined);
}
