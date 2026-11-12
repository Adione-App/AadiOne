/**
 * Push notifications reaching the phone (lib/push.ts, the Android Gradle
 * config, App.tsx / navigation/navigationRef.ts) — run with `npm run test:unit`.
 * The server side: backend tests/integration/push-delivery.test.ts.
 *
 * No build before this ever registered a push token:
 *   - `Constants.isDevice` was removed from expo-constants (SDK 51); always
 *     undefined, it made registration return on every phone;
 *   - EAS builds the committed android/ as-is, which never applied the Google
 *     Services Gradle plugin, so Firebase never started in the app.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { orderIdFromPushData } from "../src/lib/notifications.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const ORDER = "3f2c9a51-7b1e-4d2a-9c3b-0e5f6a7b8c9d";

describe("registration", () => {
  const push = read("src/lib/push.ts");
  const register = push.slice(push.indexOf("export async function registerForPush"), push.indexOf("export function openOrdersFromPushTaps"));

  it("no longer depends on the removed Constants.isDevice", () => {
    assert.doesNotMatch(push, /!Constants\.isDevice/);
  });

  it("registers on Android only — FCM v1 cannot use an iOS (APNs) token", () => {
    assert.match(register, /if \(Platform\.OS !== "android"\) return;/);
  });

  it("creates the order channel before asking for permission, then sends the native FCM token (not an Expo token)", () => {
    const channel = register.indexOf("setNotificationChannelAsync(ORDERS_CHANNEL_ID");
    assert.ok(channel > 0 && channel < register.indexOf("getPermissionsAsync()"));
    assert.ok(register.indexOf("requestPermissionsAsync()") < register.indexOf("getDevicePushTokenAsync()"));
    assert.doesNotMatch(push, /getExpoPushTokenAsync\(/);
  });

  it("uses the same channel id the server puts in every push", () => {
    assert.match(push, /export const ORDERS_CHANNEL_ID = "orders";/);
    const server = readFileSync(path.join(ROOT, "../backend/src/modules/notifications/notification.service.ts"), "utf8");
    assert.match(server, /export const ANDROID_CHANNEL_ID = 'orders';/);
    assert.match(server, /notification: \{ channel_id: ANDROID_CHANNEL_ID \}/);
  });
});

describe("Firebase in the Android build", () => {
  it("applies the Google Services Gradle plugin (as Expo prebuild would)", () => {
    assert.match(read("android/build.gradle"), /classpath\('com\.google\.gms:google-services:4\.4\.4'\)/);
    assert.match(read("android/app/build.gradle"), /\napply plugin: 'com\.google\.gms\.google-services'\n$/);
  });

  it("google-services.json is for this app's package", () => {
    const services = JSON.parse(read("android/app/google-services.json")) as {
      client: { client_info: { android_client_info: { package_name: string } } }[];
    };
    const app = JSON.parse(read("app.json")) as { expo: { android: { package: string; googleServicesFile: string } } };
    const gradle = read("android/app/build.gradle");
    assert.equal(app.expo.android.googleServicesFile, "./android/app/google-services.json");
    assert.ok(services.client.some((c) => c.client_info.android_client_info.package_name === app.expo.android.package));
    assert.match(gradle, new RegExp(`applicationId '${app.expo.android.package.replace(/\./g, "\\.")}'`));
  });
});

describe("tapping a push", () => {
  it("opens the order a customer push is about", () => {
    assert.equal(orderIdFromPushData({ orderId: ORDER, type: "ORDER_DELIVERED", audience: "CUSTOMER" }), ORDER);
    assert.equal(orderIdFromPushData({ orderId: ORDER }), ORDER);
  });

  it("opens nothing for a push without an order, for another feed, or with unexpected data", () => {
    assert.equal(orderIdFromPushData({ orderId: "", type: "BACK_IN_STOCK", audience: "CUSTOMER" }), null);
    assert.equal(orderIdFromPushData({ orderId: ORDER, audience: "SELLER" }), null);
    assert.equal(orderIdFromPushData({ orderId: ORDER, audience: "ADMIN" }), null);
    assert.equal(orderIdFromPushData({ orderId: "../../account" }), null);
    assert.equal(orderIdFromPushData({ orderId: 42 }), null);
    assert.equal(orderIdFromPushData(null), null);
    assert.equal(orderIdFromPushData("orderId"), null);
  });

  it("is wired once the signed-in tabs are up — including the tap that launched the app", () => {
    const app = read("App.tsx");
    assert.match(app, /const ordersOpenable = status === "authenticated" && startupReady && !isRestoring && !updateRequired;/);
    assert.match(app, /openOrdersFromPushTaps\(navigateToOrderTracking\)/);
    const push = read("src/lib/push.ts");
    assert.match(push, /addNotificationResponseReceivedListener\(handle\)/);
    assert.match(push, /handle\(N\.getLastNotificationResponse\(\)\)/);
    assert.match(push, /if \(handledTaps\.has\(key\)\) return;/);
  });

  it("lands on the Home tab's Order Tracking with Home underneath", () => {
    const nav = read("src/navigation/navigationRef.ts");
    assert.match(nav, /"Main", \{\n\s+screen: "Home",\n\s+params: \{ screen: "OrderTracking", params: \{ orderId \}, initial: false \},/);
    assert.match(read("src/navigation/stacks.tsx"), /<CatalogStack\.Screen name="OrderTracking">/);
  });
});
