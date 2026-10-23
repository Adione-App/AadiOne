/**
 * Crash reports from the app, until a crash-reporting service (e.g. Sentry)
 * is set up.
 *
 * What is caught:
 *   - a render error anywhere in the app (AppErrorBoundary — the app shows a
 *     recovery screen instead of going blank);
 *   - an uncaught JavaScript error (React Native's global handler);
 *   - an unhandled promise rejection (release builds, Hermes).
 *
 * Each becomes ONE short report to POST /client-errors (server log, module
 * `client-errors`): error name, message, stack, the current screen, app
 * version / build / platform and the X-Request-Id of the last API call, so
 * the server log of that call can be found. No account id, phone, address,
 * token or request body is ever sent; the server redacts again.
 *
 * Best effort by design: never throws, never retries, at most a few reports
 * per app session. NOT covered: native (Java/Kotlin/ObjC) crashes — those need
 * a native SDK.
 */

import { Platform } from "react-native";
import { API_BASE_URL, lastApiRequestId } from "./api";
import { installedApp } from "./appVersion";
import { navigationRef } from "@/navigation/navigationRef";

type CrashSource = "error-boundary" | "global-handler" | "unhandled-rejection";

const MAX_REPORTS_PER_SESSION = 10;
const REPORT_TIMEOUT_MS = 5_000;
let reportsSent = 0;

function currentScreen(): string | undefined {
  try {
    const name = navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : undefined;
    return name ? name.replace(/[^A-Za-z0-9_ -]/g, "").slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

export function reportCrash(error: unknown, source: CrashSource, fatal: boolean, componentStack?: string | null): void {
  try {
    if (reportsSent >= MAX_REPORTS_PER_SESSION) return;
    reportsSent += 1;
    const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error value thrown");
    const screen = currentScreen();
    const requestId = lastApiRequestId();
    const platform = Platform.OS === "android" || Platform.OS === "ios" || Platform.OS === "web" ? Platform.OS : undefined;
    const body = {
      source,
      fatal,
      name: (err.name || "Error").slice(0, 100),
      message: (err.message || "Unknown error").slice(0, 1500),
      ...(err.stack ? { stack: err.stack.slice(0, 12_000) } : {}),
      ...(componentStack ? { componentStack: componentStack.slice(0, 6_000) } : {}),
      ...(screen ? { screen } : {}),
      ...(installedApp.version ? { appVersion: installedApp.version } : {}),
      ...(installedApp.build ? { build: installedApp.build.slice(0, 20) } : {}),
      ...(platform ? { platform } : {}),
      ...(requestId && /^[A-Za-z0-9-]{1,64}$/.test(requestId) ? { lastRequestId: requestId } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    void fetch(`${API_BASE_URL}/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  } catch {
    // Reporting must never become a second crash.
  }
}

interface GlobalErrorUtils {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

let installed = false;

/** Hooks React Native's global error handler (and, in release builds, unhandled rejections). Idempotent. */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as {
    ErrorUtils?: GlobalErrorUtils;
    HermesInternal?: { enablePromiseRejectionTracker?: (options: unknown) => void };
  };
  const previous = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    reportCrash(error, "global-handler", Boolean(isFatal));
    previous?.(error, isFatal); // React Native's own behaviour is unchanged
  });
  // Development keeps React Native's own rejection warnings; release builds report.
  // (Guarded: this runs at startup and must never throw, even where __DEV__ is not defined.)
  if (typeof __DEV__ === "undefined" || !__DEV__) {
    g.HermesInternal?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id: number, rejection: unknown) => reportCrash(rejection, "unhandled-rejection", false),
      onHandled: () => undefined,
    });
  }
}
