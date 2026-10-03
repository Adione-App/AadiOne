/**
 * Thin wrapper over the Cashfree React Native SDK (react-native-cashfree-pg-sdk).
 *
 * The SDK is a native module: it exists only in a native build that includes
 * it (EAS / `expo run`), never in Expo Go or on web. Everything here checks
 * for the native module first and loads the SDK lazily, so a build without it
 * shows a clear message instead of crashing.
 *
 * The SDK's callbacks mean only "the checkout closed". Whether the customer
 * actually paid is decided by the server asking Cashfree
 * (`POST /payments/:orderId/refresh`) — see CashfreeCheckout.tsx.
 */

import { NativeModules, Platform } from "react-native";

import type { CashfreeCheckout } from "./payments";

export interface CashfreeOutcome {
  /** "verify" = Cashfree's success callback; "error" = failed/cancelled. */
  kind: "verify" | "error";
  /** Cashfree's error message for "error" (never shown as proof of anything). */
  message: string | null;
}

export function isCashfreeAvailable(): boolean {
  return Platform.OS !== "web" && Boolean(NativeModules.CashfreePgApi);
}

/**
 * Opens Cashfree's hosted checkout (UPI apps, cards, net banking — whatever is
 * enabled on the Cashfree account) and resolves once it closes. Only one
 * checkout can be open at a time; the SDK keeps a single global callback.
 */
export function openCashfreeCheckout(checkout: CashfreeCheckout): Promise<CashfreeOutcome> {
  if (!isCashfreeAvailable()) {
    return Promise.reject(new Error("CASHFREE_UNAVAILABLE"));
  }

  // Lazy: loading the SDK in a build without its native module must not
  // crash the app at import time.
  const sdk = require("react-native-cashfree-pg-sdk") as typeof import("react-native-cashfree-pg-sdk");
  const contract = require("cashfree-pg-api-contract") as typeof import("cashfree-pg-api-contract");

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
      service.doWebPayment(session);
    } catch (error) {
      service.removeCallback();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
