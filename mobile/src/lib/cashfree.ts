/**
 * Thin wrapper over the Cashfree React Native SDK (react-native-cashfree-pg-sdk).
 *
 * The SDK is a native module: it exists only in a native build that includes
 * it (EAS / `expo run`), never in Expo Go or on web. Everything here checks
 * for the native module first and loads the SDK lazily, so a build without it
 * shows a clear message instead of crashing.
 *
 * Two ways to pay, both on the SAME server-created Cashfree order (amount,
 * merchant and order reference all come from Cashfree, never from the phone):
 *   - `openCashfreeUpiApp`: opens ONE UPI app the customer picked (Paytm,
 *     PhonePe, Google Pay…) straight away — Cashfree's UPI intent flow;
 *   - `openCashfreeCheckout`: Cashfree's hosted checkout (UPI apps, UPI ID,
 *     cards, net banking — whatever is enabled on the Cashfree account).
 *
 * The SDK's callbacks mean only "the checkout closed". Whether the customer
 * actually paid is decided by the server asking Cashfree
 * (`POST /payments/:orderId/refresh`) — see CashfreeCheckout.tsx.
 */

import { NativeModules, Platform } from "react-native";

import type { CashfreeCheckout } from "./payments";
import upiCatalogue from "./upi-apps.json";

export interface CashfreeOutcome {
  /** "verify" = Cashfree's success callback; "error" = failed/cancelled. */
  kind: "verify" | "error";
  /** Cashfree's error message for "error" (never shown as proof of anything). */
  message: string | null;
}

/** A UPI app installed on this phone that Cashfree can open directly. */
export interface UpiAppOption {
  /** Android package — what Cashfree's UPI intent opens. */
  packageName: string;
  name: string;
  /** Brand colour / initials from our catalogue (upi-apps.json); null tint for others. */
  tint: string | null;
  initials: string;
}

/** How long the installed-app lookup may take before checkout falls back to the hosted page. */
const UPI_LOOKUP_TIMEOUT_MS = 4_000;

type Sdk = typeof import("react-native-cashfree-pg-sdk");
type Contract = typeof import("cashfree-pg-api-contract");

export function isCashfreeAvailable(): boolean {
  return Platform.OS !== "web" && Boolean(NativeModules.CashfreePgApi);
}

/**
 * Direct UPI-app payment is offered on Android only: it is where Cashfree's
 * UPI intent takes an app's package. iOS keeps the hosted checkout, which
 * lists the UPI apps itself.
 */
export function supportsDirectUpiApps(): boolean {
  return Platform.OS === "android" && isCashfreeAvailable();
}

// Lazy: loading the SDK in a build without its native module must not crash
// the app at import time.
function loadSdk(): { sdk: Sdk; contract: Contract } {
  return {
    sdk: require("react-native-cashfree-pg-sdk") as Sdk,
    contract: require("cashfree-pg-api-contract") as Contract,
  };
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)).toUpperCase();
}

/**
 * The UPI apps installed on this phone, our known ones first (Google Pay,
 * PhonePe, Paytm, BHIM — the catalogue's order), then any other app that
 * handles `upi://pay`. Never throws: [] when there are none, on iOS, without
 * the SDK, or when the lookup fails or hangs — the screen then offers the
 * hosted checkout instead.
 */
export async function listInstalledUpiApps(): Promise<UpiAppOption[]> {
  if (!supportsDirectUpiApps()) return [];
  try {
    const { sdk } = loadSdk();
    const raw = await Promise.race([
      sdk.CFPaymentGatewayService.getInstalledUpiApps(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("UPI_LOOKUP_TIMEOUT")), UPI_LOOKUP_TIMEOUT_MS)),
    ]);
    // Android answers with a JSON string: [{ appName, appPackage }].
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const apps: UpiAppOption[] = [];
    for (const entry of parsed) {
      const packageName = typeof entry?.appPackage === "string" ? entry.appPackage.trim() : "";
      if (!packageName || seen.has(packageName)) continue;
      seen.add(packageName);
      const known = upiCatalogue.find((app) => app.androidPackage === packageName);
      const name = known?.name ?? (typeof entry?.appName === "string" && entry.appName.trim() ? entry.appName.trim() : packageName);
      apps.push({ packageName, name, tint: known?.tint ?? null, initials: known?.initials ?? initialsOf(name) });
    }
    const rank = (app: UpiAppOption) => {
      const index = upiCatalogue.findIndex((known) => known.androidPackage === app.packageName);
      return index === -1 ? upiCatalogue.length : index;
    };
    return apps.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Runs one Cashfree payment UI and resolves once it closes. Only one can be
 * open at a time; the SDK keeps a single global callback.
 */
function runCashfree(
  checkout: CashfreeCheckout,
  start: (sdk: Sdk, contract: Contract, session: InstanceType<Contract["CFSession"]>) => void,
): Promise<CashfreeOutcome> {
  if (!isCashfreeAvailable()) {
    return Promise.reject(new Error("CASHFREE_UNAVAILABLE"));
  }
  const { sdk, contract } = loadSdk();

  return new Promise<CashfreeOutcome>((resolve, reject) => {
    const service = sdk.CFPaymentGatewayService;
    const finish = (outcome: CashfreeOutcome) => {
      service.removeCallback();
      resolve(outcome);
    };

    try {
      service.setCallback({
        onVerify: () => finish({ kind: "verify", message: null }),
        onError: (error) => finish({ kind: "error", message: error?.getMessage?.() ?? null }),
      });

      const session = new contract.CFSession(
        checkout.paymentSessionId,
        checkout.orderId,
        checkout.environment === "PRODUCTION"
          ? contract.CFEnvironment.PRODUCTION
          : contract.CFEnvironment.SANDBOX,
      );
      start(sdk, contract, session);
    } catch (error) {
      service.removeCallback();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Opens Cashfree's hosted checkout (UPI apps, cards, net banking — whatever is
 * enabled on the Cashfree account) and resolves once it closes.
 */
export function openCashfreeCheckout(checkout: CashfreeCheckout): Promise<CashfreeOutcome> {
  return runCashfree(checkout, (sdk, _contract, session) => sdk.CFPaymentGatewayService.doWebPayment(session));
}

/**
 * Opens the chosen UPI app directly (Cashfree UPI intent) for this Cashfree
 * order: the app shows Cashfree's merchant, the order's exact amount and its
 * reference — none of it set by the phone. Resolves when the customer is back;
 * an app that cannot be opened ends with an "error" outcome. Either way the
 * server decides whether anything was paid.
 */
export function openCashfreeUpiApp(checkout: CashfreeCheckout, packageName: string): Promise<CashfreeOutcome> {
  return runCashfree(checkout, (sdk, contract, session) =>
    sdk.CFPaymentGatewayService.makePayment(
      new contract.CFUPIPayment(session, new contract.CFUPI(contract.UPIMode.INTENT, packageName)),
    ),
  );
}
