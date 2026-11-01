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
  /** Cashfree's error code for "error". */
  code: string | null;
  /** From doWebPayment() to the callback — an instant error means Cashfree refused the launch. */
  elapsedMs: number | null;
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

/** The checkout currently open (the SDK keeps ONE global callback). */
let open: Promise<CashfreeOutcome> | null = null;

export interface CheckoutDiagnostics {
  /** One line per stage (never secrets — the session id is not passed here). */
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
  /** Also relay Cashfree's own SDK event stream (diagnostic builds only). */
  subscribeEvents?: boolean;
}

/** Cashfree's event meta as a plain object (the SDK hands a Map-typed object). */
function plainMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  if (meta instanceof Map) return Object.fromEntries(meta.entries());
  return { ...(meta as Record<string, unknown>) };
}

/**
 * Opens Cashfree's complete hosted checkout for this Cashfree order and
 * resolves once it closes. Only one can be open at a time: the SDK keeps a
 * single global callback, so a second call while one is open gets the open
 * one's outcome instead of replacing its callback. The first callback wins —
 * a duplicate or late callback is ignored.
 */
export function openCashfreeCheckout(checkout: CashfreeCheckout, diagnostics: CheckoutDiagnostics = {}): Promise<CashfreeOutcome> {
  const report = (event: string, data: Record<string, unknown>) => {
    try {
      diagnostics.onDiagnostic?.(event, data);
    } catch {
      // diagnostics never break a payment
    }
  };
  if (!isCashfreeAvailable()) {
    report("sdk_native_module_missing", { platform: Platform.OS });
    return Promise.reject(new Error("CASHFREE_UNAVAILABLE"));
  }
  if (open) {
    report("sdk_already_open", {});
    return open;
  }
  const { sdk, contract } = loadSdk();
  markPaymentStage("sdkReady");

  const started = new Promise<CashfreeOutcome>((resolve, reject) => {
    const service = sdk.CFPaymentGatewayService;
    let settled = false;
    let invokedAt: number | null = null;
    const elapsed = () => (invokedAt === null ? null : Date.now() - invokedAt);
    let subscribed = false;
    const finish = (outcome: CashfreeOutcome) => {
      if (settled) {
        report("sdk_duplicate_callback_ignored", { kind: outcome.kind, code: outcome.code });
        return;
      }
      settled = true;
      service.removeCallback();
      if (subscribed) {
        try {
          service.removeEventSubscriber();
        } catch {
          // best effort
        }
      }
      report("sdk_callback", {
        at: new Date().toISOString(),
        kind: outcome.kind,
        code: outcome.code,
        message: outcome.message,
        elapsedMs: outcome.elapsedMs,
      });
      resolve(outcome);
    };

    try {
      if (diagnostics.subscribeEvents) {
        // Cashfree's own analytics events (checkout opened, payment mode
        // chosen, errors…) — shows whether its UI actually started.
        service.setEventSubscriber({
          onReceivedEvent: (eventName: string, meta: Map<string, string>) =>
            report("cf_event", { name: eventName, meta: plainMeta(meta), sinceInvokeMs: elapsed() }),
        });
        subscribed = true;
      }
      service.setCallback({
        onVerify: () => finish({ kind: "verify", message: null, code: null, elapsedMs: elapsed() }),
        onError: (error) =>
          finish({
            kind: "error",
            message: error?.getMessage?.() ?? null,
            code: error?.getCode?.() ?? null,
            elapsedMs: elapsed(),
          }),
      });

      const session = new contract.CFSession(
        checkout.paymentSessionId,
        checkout.orderId,
        checkout.environment === "PRODUCTION"
          ? contract.CFEnvironment.PRODUCTION
          : contract.CFEnvironment.SANDBOX,
      );
      invokedAt = Date.now();
      report("sdk_invoke", {
        at: new Date(invokedAt).toISOString(),
        cashfreeOrderId: checkout.orderId,
        environment: session.environment,
        sessionPresent: checkout.paymentSessionId.length > 0,
        sessionLength: checkout.paymentSessionId.length,
      });
      service.doWebPayment(session);
      report("sdk_invoke_returned", { afterMs: elapsed() });
      markPaymentStage("checkoutInvoked");
    } catch (error) {
      settled = true;
      service.removeCallback();
      report("sdk_threw", { message: error instanceof Error ? error.message : String(error), afterMs: elapsed() });
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }).finally(() => {
    if (open === started) open = null;
  });
  open = started;
  return started;
}
