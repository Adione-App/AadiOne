/**
 * The installed app's identity and the official stores.
 *
 * The version is the NATIVE one the store installed (expo-application:
 * Android versionName / iOS CFBundleShortVersionString), never a constant in
 * the JS bundle — after an update from the store this changes, and that is
 * how the app knows the update really happened. OTA updates are disabled for
 * this app (app.json), so the JS bundle and the binary always match.
 */

import { Linking, Platform } from "react-native";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { APP_STORE_HOSTS, APP_VERSION_HEADERS, isAppPlatform, isValidVersion, type AppPlatform } from "@shared";

export interface InstalledApp {
  /** android | ios; null on web (no version policy there). */
  platform: AppPlatform | null;
  /** Installed marketing version, e.g. 1.0.8; null if it cannot be read. */
  version: string | null;
  /** Native build: Android versionCode / iOS buildNumber. */
  build: string | null;
  /** Package / bundle id, e.g. in.adione.app. */
  applicationId: string | null;
}

function readInstalledApp(): InstalledApp {
  const platform = isAppPlatform(Platform.OS) ? Platform.OS : null;
  // Native first; the app config only stands in where there is no native
  // module (Expo Go during development).
  const nativeVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? null;
  return {
    platform,
    version: isValidVersion(nativeVersion) ? nativeVersion : null,
    build: Application.nativeBuildVersion ?? null,
    applicationId: Application.applicationId ?? null,
  };
}

/** Read once: the installed binary cannot change while this JS runs. */
export const installedApp: InstalledApp = readInstalledApp();

/** Sent on every API call so the server can enforce the minimum version. */
export function appVersionHeaders(): Record<string, string> {
  if (!installedApp.platform) return {};
  return {
    [APP_VERSION_HEADERS.PLATFORM]: installedApp.platform,
    ...(installedApp.version ? { [APP_VERSION_HEADERS.VERSION]: installedApp.version } : {}),
    ...(installedApp.build && /^\d{1,10}$/.test(installedApp.build) ? { [APP_VERSION_HEADERS.BUILD]: installedApp.build } : {}),
  };
}

/** "https://host/..." -> host (lower-case); null otherwise. Plain parsing: React Native's URL is incomplete. */
function httpsHost(url: string): string | null {
  const match = /^https:\/\/([^/?#:@]+)(?:[/?#]|$)/i.exec(url.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** An official https store listing for this platform, else null (never an untrusted link). */
export function officialStoreUrl(platform: AppPlatform, url: string | null | undefined): string | null {
  if (url) {
    const host = httpsHost(url);
    if (host && APP_STORE_HOSTS[platform].includes(host)) return url.trim();
  }
  // Android: this app's own Play listing is known from its package id.
  if (platform === "android" && installedApp.applicationId) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(installedApp.applicationId)}`;
  }
  return null;
}

/**
 * Opens the store app at this app's listing, falling back to the same listing
 * on the web. Resolves false only when neither could be opened. Opening the
 * store is NOT an update: the app re-checks its installed version when it is
 * back in the foreground.
 */
export async function openStoreListing(platform: AppPlatform, storeUrl: string | null | undefined): Promise<boolean> {
  const web = officialStoreUrl(platform, storeUrl);
  if (!web) return false;

  const native =
    platform === "android"
      ? (() => {
          const id = /[?&]id=([^&#]+)/.exec(web)?.[1];
          return id ? `market://details?id=${id}` : null;
        })()
      : web.replace(/^https:/, "itms-apps:");

  for (const target of native ? [native, web] : [web]) {
    try {
      await Linking.openURL(target);
      return true;
    } catch {
      // Store app missing or refused — try the web listing next.
    }
  }
  return false;
}
