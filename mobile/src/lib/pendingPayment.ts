/**
 * The app's one payment flow (lib/paymentFlow.ts) wired to the Cashfree SDK,
 * the API and the phone's storage. The Cart starts it the moment the order is
 * placed — no Aadione screen before Cashfree's checkout — and shows what the
 * server says afterwards: the verification screen, the failed-payment sheet,
 * or the confirmed order (components/payment/).
 *
 * The unpaid order is remembered on disk, so an app killed while a UPI app
 * was open picks it up again at the next launch (checked quietly with the
 * server — confirmed if it was paid meanwhile).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { api } from "./api";
import { isCashfreeAvailable, openCashfreeCheckout } from "./cashfree";
import { createPaymentFlow, maskId, type PaymentState, type PendingOrder } from "./paymentFlow";
import { PAYMENT_DIAGNOSTICS, recordDiagnostic, sanitizeDiagnostic } from "./paymentDiagnostics";
import type { CashfreeCheckout, CreatePaymentResult, PaymentRefreshResult } from "./payments";
import { useAuth } from "./store";

const PENDING_KEY = "adione.pending-payment";
/** An unpaid order older than this is long past its payment window: not restored. */
const RESTORE_MAX_AGE_MS = 24 * 60 * 60_000;

interface PaymentStore {
  state: PaymentState;
  /**
   * The outcome belongs to a checkout the customer started in this session,
   * so the Cart may open the confirmed order. A payment found paid after a
   * restart is not announced by a navigation (Home shows the order).
   */
  announce: boolean;
}

export const usePayment = create<PaymentStore>(() => ({ state: { phase: "idle" }, announce: false }));

let queryClient: QueryClient | null = null;
export function setPaymentQueryClient(client: QueryClient): void {
  queryClient = client;
}

function invalidateAfterOutcome(): void {
  if (!queryClient) return;
  // The order list / Home carousel (a confirmed order) and the cart (an
  // unpaid order that ended gives its items back).
  for (const key of [["orders"], ["order"], ["cart"]] as const) {
    void queryClient.invalidateQueries({ queryKey: [...key] });
  }
}

/**
 * One line per payment-launch stage, in every build: release builds print it
 * to logcat (`adb logcat -s ReactNativeJS`), so a device that cannot open
 * Cashfree's checkout shows exactly where and why. Never secrets: a session
 * id is shown only as a prefix and length.
 */
export function logPaymentLaunch(event: string, data: Record<string, unknown> = {}): void {
  try {
    // eslint-disable-next-line no-console
    console.log("[payment-launch]", event, JSON.stringify(sanitizeDiagnostic(data)));
    recordDiagnostic(event, data);
  } catch {
    // diagnostics never break a payment
  }
}

const flow = createPaymentFlow({
  available: isCashfreeAvailable,
  open: (session: CashfreeCheckout) =>
    openCashfreeCheckout(session, { onDiagnostic: logPaymentLaunch, subscribeEvents: PAYMENT_DIAGNOSTICS }),
  // A fresh key per request: the server's per-order lock and reuse of the
  // open Cashfree order are what keep this to one Cashfree order.
  createSession: (orderId) => api.post<CreatePaymentResult>("/payments/create", { orderId }, Crypto.randomUUID()),
  refresh: (orderId) => api.post<PaymentRefreshResult>(`/payments/${orderId}/refresh`),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  persist: (order) => {
    const write = order
      ? AsyncStorage.setItem(PENDING_KEY, JSON.stringify({ ...order, savedAt: Date.now() }))
      : AsyncStorage.removeItem(PENDING_KEY);
    void write.catch(() => undefined);
  },
  log: logPaymentLaunch,
  now: () => Date.now(),
  onChange: (state) => {
    logPaymentLaunch("state", { phase: state.phase, ...("reason" in state ? { reason: state.reason } : {}) });
    usePayment.setState({ state });
    if (state.phase === "paid" || state.phase === "ended") {
      // The detail cached at placement still says "awaiting payment": the
      // confirmation screen must load the server's confirmed order instead.
      queryClient?.removeQueries({ queryKey: ["order", state.orderId] });
      invalidateAfterOutcome();
    }
  },
});

/** Right after the order is placed: Cashfree's checkout opens at once. */
export function startPayment(order: PendingOrder, session: CashfreeCheckout | null): Promise<PaymentState> {
  usePayment.setState({ announce: true });
  logPaymentLaunch("start", {
    orderId: order.orderId,
    amountPaise: order.amountPaise,
    withSession: session !== null,
    cashfreeOrderId: session?.orderId ?? null,
    environment: session?.environment ?? null,
    session: maskId(session?.paymentSessionId),
  });
  return flow.start(order, session);
}

/** "Retry payment" — the SAME order (the same Cashfree order while it is valid). */
export function resumePayment(): Promise<PaymentState> {
  usePayment.setState({ announce: true });
  return flow.resume();
}

/** A quiet check of the unpaid order (return to the app, cart opened). */
export function checkPendingPayment(): Promise<PaymentState> {
  return flow.check();
}

export function isPaymentBusy(): boolean {
  return flow.isBusy();
}

/** The outcome has been shown (confirmed order opened / notice dismissed). */
export function dismissPaymentOutcome(): void {
  flow.dismiss();
}

/** The failed sheet was closed: back to the normal cart (a late success is still picked up). */
export function dismissPaymentFailure(): void {
  flow.dismissFailure();
}

/** Another order replaced this checkout (e.g. cash on delivery), or the customer signed out. */
export function forgetPendingPayment(): void {
  flow.reset();
}

/** At launch (signed in): the unpaid order remembered on disk, checked quietly. */
export async function restorePendingPayment(): Promise<void> {
  if (flow.state().phase !== "idle") return;
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<PendingOrder & { savedAt: number }>;
    const valid =
      typeof saved.orderId === "string" &&
      saved.orderId.length > 0 &&
      Number.isInteger(saved.amountPaise) &&
      (saved.amountPaise as number) > 0 &&
      typeof saved.savedAt === "number" &&
      Date.now() - saved.savedAt < RESTORE_MAX_AGE_MS;
    if (!valid) {
      await AsyncStorage.removeItem(PENDING_KEY);
      return;
    }
    usePayment.setState({ announce: false });
    await flow.restore({ orderId: saved.orderId!, amountPaise: saved.amountPaise! });
  } catch {
    // Unreadable: nothing to restore. The order itself is safe on the server.
  }
}

// A signed-out phone must not keep (or show) the previous customer's unpaid order.
let wasSignedIn = useAuth.getState().status === "authenticated";
useAuth.subscribe((auth) => {
  const signedIn = auth.status === "authenticated";
  if (wasSignedIn && !signedIn) flow.reset();
  wasSignedIn = signedIn;
});
