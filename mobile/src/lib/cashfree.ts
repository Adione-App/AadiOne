/**
 * Thin wrapper over the Cashfree React Native SDK (react-native-cashfree-pg-sdk).
 *
 * The SDK is a native module: it exists only in a native build that includes
 * it (EAS / `expo run`), never in Expo Go or on web. Everything here checks
 * for the native module first and loads the SDK lazily, so a build without it
 * shows a clear message instead of crashing.
 *
 * One way to pay: Cashfree's complete hosted checkout (`doWebPayment`) on the
 * server-created Cashfree order — UPI apps, UPI ID, cards, wallets, net
 * banking, whatever is enabled on the Cashfree account. Amount, merchant and
 * order reference all come from Cashfree, never from the phone.
 *
 * The SDK's callbacks mean only "the checkout closed". Whether the customer
 * actually paid is decided by the server asking Cashfree
 * (`POST /payments/:orderId/refresh`) — see CashfreeCheckout.tsx.
 */

import { NativeModules, Platform } from "react-native";

import type { CashfreeCheckout } from "./payments";
import { markPaymentStage } from "./paymentTiming";

export interface CashfreeOutcome {
  /** "verify" = Cashfree's success callback; "error" = failed/cancelled. */
  kind: "verify" | "error";
  /** Cashfree's error message for "error" (never shown as proof of anything). */
  message: string | null;
}

type Sdk = typeof import("react-native-cashfree-pg-sdk");
type Contract = typeof import("cashfree-pg-api-contract");

export function isCashfreeAvailable(): boolean {
  return Platform.OS !== "web" && Boolean(NativeModules.CashfreePgApi);
}

let loaded: { sdk: Sdk; contract: Contract } | null = null;

// Lazy: loading the SDK in a build without its native module must not crash
// the app at import time. Loaded once, then reused.
function loadSdk(): { sdk: Sdk; contract: Contract } {
  if (!loaded) {
    loaded = {
      sdk: require("react-native-cashfree-pg-sdk") as Sdk,
      contract: require("cashfree-pg-api-contract") as Contract,
    };
  }
  return loaded;
}

/**
 * Loads the SDK's JavaScript ahead of the tap (the Cart screen calls this),
 * so opening the checkout does not wait for it. Never throws; does nothing
 * without the native module. Opens nothing and contacts no one.
 */
export function preloadCashfreeSdk(): void {
  if (!isCashfreeAvailable()) return;
  try {
    loadSdk();
  } catch {
    // Opening the checkout reports the problem if it is real.
  }
}

/**
 * Opens Cashfree's complete hosted checkout for this Cashfree order and
 * resolves once it closes. Only one can be open at a time: the SDK keeps a
 * single global callback.
 */
export function openCashfreeCheckout(checkout: CashfreeCheckout): Promise<CashfreeOutcome> {
  if (!isCashfreeAvailable()) {
    return Promise.reject(new Error("CASHFREE_UNAVAILABLE"));
  }
  const { sdk, contract } = loadSdk();
  markPaymentStage("sdkReady");

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
      markPaymentStage("checkoutInvoked");
    } catch (error) {
      service.removeCallback();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
