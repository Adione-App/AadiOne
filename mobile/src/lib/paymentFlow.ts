/**
 * "Pay Online" from the cart — Cashfree's checkout opens straight away (no
 * Aadione screen before it), and when the customer is back the SERVER is
 * asked what happened. Pure (the SDK, the API and the clock come in as
 * `PaymentFlowDeps`), so every way back is unit-tested
 * (tests/paymentFlow.test.ts); lib/pendingPayment.ts wires it to the app.
 *
 * Only the server's answer (`POST /payments/:id/refresh`, which asks Cashfree
 * itself, as does the webhook) decides — never the SDK's callback:
 *
 *   verifying     back from the checkout: "Please wait while your payment is
 *                 being verified" while the server is asked;
 *   paid          the server verified the payment: the order is confirmed
 *                 (the server takes the paid lines out of the cart then —
 *                 never before);
 *   failed        the server says the newest attempt failed / was cancelled,
 *                 or that nothing was paid and nothing is in progress after
 *                 the checkout closed (asked twice): the failed-payment
 *                 sheet. The cart was never touched; retrying pays for the
 *                 SAME order (no second order);
 *   pending       the bank / UPI app has not answered, Cashfree's success
 *                 callback is not yet confirmed, or the server could not be
 *                 asked: NEVER "failed", never "paid" — checked again
 *                 quietly; a delayed webhook is picked up by those checks;
 *   ended         the order no longer awaits payment (its time ran out /
 *                 replaced), or a late payment is being refunded.
 *
 * A timeout, an app return, a UPI app's "cancelled", a missing callback or a
 * network error is never evidence of failure. One checkout at a time; a
 * callback after the checkout closed is ignored (lib/cashfree.ts).
 */

import type { CashfreeCheckout, CreatePaymentResult, PaymentRefreshResult } from "./payments";

export interface PendingOrder {
  orderId: string;
  /** The server's amount for the order — never computed on the phone. */
  amountPaise: number;
}

export type CheckoutClosed = {
  kind: "verify" | "error";
  message: string | null;
  /** Cashfree's error code (onError), when it gave one. */
  code?: string | null;
  /** Milliseconds from doWebPayment() to the callback — tells a refused launch from a customer who came back. */
  elapsedMs?: number | null;
};

/** Why Cashfree's checkout could not be shown at all (no payment could have started). */
export type LaunchFailure =
  /** The server gave no usable Cashfree session (POST /payments/create failed, or an incomplete session). */
  | "SESSION"
  /** The Cashfree SDK threw before showing anything (native module missing, invalid session). */
  | "SDK"
  /** Cashfree refused the session at once (its onError arrived before anyone could have paid). */
  | "GATEWAY_REJECTED";

/** Why the payment is not settled yet — never a failure. */
export type PendingReason =
  /** The bank / UPI app is still answering. */
  | "PENDING"
  /** Cashfree's success callback, but the server has not seen the payment yet. */
  | "CONFIRMING"
  /** The server could not be asked (network). */
  | "CHECK_FAILED";

/** Why the failed-payment sheet is shown — both server-verified. */
export type FailedReason =
  /** Cashfree says the newest attempt failed / was cancelled / declined. */
  | "FAILED"
  /** The checkout closed, and Cashfree has no payment and none in progress. */
  | "NOT_PAID";

export type PaymentState =
  | { phase: "idle" }
  /** Getting the session / opening Cashfree's checkout (the Pay button's spinner — no screen). */
  | { phase: "opening"; order: PendingOrder }
  /** Cashfree's checkout (or a UPI app it opened) is open. */
  | { phase: "paying"; order: PendingOrder }
  /** Back from the checkout: the server is being asked ("Please wait while your payment is being verified"). */
  | { phase: "verifying"; order: PendingOrder }
  /** Not settled yet — neither failed nor paid; checked again quietly. */
  | { phase: "pending"; order: PendingOrder; reason: PendingReason; message: string }
  /** The server says it was not paid: the failed-payment sheet (cart untouched, retry pays the same order). */
  | { phase: "failed"; order: PendingOrder; reason: FailedReason; message: string }
  /** Paid and confirmed by the server. */
  | { phase: "paid"; orderId: string }
  /** The order can no longer be paid (time ran out / replaced), or a late payment is being refunded. */
  | { phase: "ended"; orderId: string; reason: "CLOSED" | "LATE_REFUND"; message: string }
  /** This build cannot open Cashfree's checkout. */
  | { phase: "unavailable"; order: PendingOrder; message: string }
  /**
   * Cashfree's checkout could not be opened — never "payment failed":
   * nothing was paid. `detail` is the actual error (server or Cashfree),
   * shown small so it can be reported.
   */
  | { phase: "launch_failed"; order: PendingOrder; reason: LaunchFailure; message: string; detail: string };

export interface PaymentFlowDeps {
  available(): boolean;
  /** Opens Cashfree's checkout; resolves when it closes. */
  open(session: CashfreeCheckout): Promise<CheckoutClosed>;
  /** `POST /payments/create` — the server reuses the open Cashfree order while it is valid. */
  createSession(orderId: string): Promise<CreatePaymentResult>;
  /** `POST /payments/:orderId/refresh` — the server asks Cashfree. */
  refresh(orderId: string): Promise<PaymentRefreshResult>;
  sleep(ms: number): Promise<void>;
  /** Remembers the unpaid order across restarts (null = nothing to watch). */
  persist(order: PendingOrder | null): void;
  onChange(state: PaymentState): void;
  /** Diagnostics for every launch stage (logcat in release builds). Never given secrets. */
  log?(event: string, data: Record<string, unknown>): void;
  /** Clock for launch timing. */
  now?(): number;
}

export const MESSAGES = {
  VERIFYING: "Please wait while your payment is being verified.",
  FAILED: "Your payment could not be completed. Your cart is safe. You can try again or choose another payment method.",
  PENDING:
    "Your bank is still confirming this payment. Please don't pay again — if money was deducted, your order is confirmed automatically. Your cart is safe.",
  CONFIRMING: "We're confirming your payment with Cashfree. Your order is confirmed automatically once it's verified. Your cart is safe.",
  CHECK_FAILED:
    "We couldn't reach the server to verify your payment. Please check your internet connection. If money was deducted, your order is confirmed automatically. Your cart is safe.",
  CLOSED: "The payment time for this checkout ended, so no order was placed and nothing was charged. Your cart is unchanged.",
  LATE_REFUND:
    "Your payment arrived after the payment time ended, so this order wasn't placed. The money is being refunded to the same account (usually 3–5 working days).",
  UNAVAILABLE: "Online payment isn't available in this version of the app. Please update Aadione, or pay by cash on delivery.",
  LAUNCH_FAILED: "We couldn't open Cashfree's secure checkout, so no payment was started. Please try again.",
} as const;

/** An onError sooner than this after doWebPayment() means Cashfree refused the launch — nobody pays that fast. */
export const QUICK_REFUSAL_MS = 2_500;

/** Cashfree error codes / messages that mean the customer closed or cancelled the checkout. */
export function isCancellation(closed: Pick<CheckoutClosed, "code" | "message">): boolean {
  const text = `${closed.code ?? ""} ${closed.message ?? ""}`.toLowerCase();
  return /cancel|dropped/.test(text);
}

/** A session the native SDK can open: all three fields present and a known environment. */
export function validCheckout(session: CashfreeCheckout | null | undefined): session is CashfreeCheckout {
  return (
    !!session &&
    typeof session.paymentSessionId === "string" &&
    session.paymentSessionId.trim().length > 0 &&
    typeof session.orderId === "string" &&
    session.orderId.trim().length > 0 &&
    (session.environment === "PRODUCTION" || session.environment === "SANDBOX")
  );
}

/** "session_ab…(118)" — enough to correlate, never the whole id. */
export const maskId = (id: string | null | undefined) => (id ? `${id.slice(0, 10)}…(${id.length})` : null);

function describeError(error: unknown): { message: string; code: string | null; status: number | null } {
  const e = (error ?? {}) as { message?: unknown; code?: unknown; status?: unknown };
  return {
    message: typeof e.message === "string" && e.message ? e.message : String(error),
    code: typeof e.code === "string" ? e.code : null,
    status: typeof e.status === "number" ? e.status : null,
  };
}

/** Right after the checkout closes with Cashfree's success callback: a UPI payment can take seconds to settle. */
export const VERIFY_ATTEMPTS = 6;
export const VERIFY_INTERVAL_MS = 2_500;
/** Closed without success: one check now and one shortly after (a UPI app may still be finishing). */
export const CLOSED_ATTEMPTS = 2;
export const CLOSED_INTERVAL_MS = 2_000;
/** Pending / confirming: quiet background checks for a few minutes. */
export const BACKGROUND_POLL_MS = 5_000;
export const BACKGROUND_POLL_LIMIT = 36;

/** The server's verdict (`outcome`; derived the same way for an older server that does not send it). */
export type Verdict = "PAID" | "PENDING" | "FAILED" | "NOT_PAID" | "CLOSED" | "LATE_REFUND";

export function verdictOf(result: PaymentRefreshResult): Verdict {
  if (result.outcome) return result.outcome;
  // Paid only when the server says so (or the order has moved past payment
  // because it was paid). An SDK callback never enters this.
  if (result.paymentStatus === "PAID" || result.paymentStatus === "PARTIALLY_REFUNDED") return "PAID";
  if (result.latePaymentRefund) return "LATE_REFUND";
  if (result.status !== "PENDING_PAYMENT") return "CLOSED";
  if (result.attemptPending === true) return "PENDING";
  if (result.lastAttemptFailed) return "FAILED";
  return "NOT_PAID";
}

/** Verdicts after which asking again right away cannot change the answer. */
const SETTLED: ReadonlySet<Verdict> = new Set(["PAID", "CLOSED", "LATE_REFUND", "FAILED"]);

export function createPaymentFlow(deps: PaymentFlowDeps) {
  let state: PaymentState = { phase: "idle" };
  /**
   * The unpaid order still watched quietly after the failed sheet was closed
   * (or after a restart): a late success is picked up and shown; nothing
   * else is shown for it.
   */
  let watched: PendingOrder | null = null;
  /** Bumped by every new start / retry / check — older loops stop. */
  let generation = 0;
  let busy = false;

  const set = (next: PaymentState) => {
    state = next;
    deps.onChange(next);
  };

  function settleFinal(next: PaymentState): void {
    watched = null;
    deps.persist(null);
    set(next);
  }

  /** One server answer applied; `poll` = keep checking quietly. */
  function apply(order: PendingOrder, result: PaymentRefreshResult, closedWith: CheckoutClosed["kind"] | null): { poll: boolean } {
    const verdict = verdictOf(result);
    if (verdict === "PAID") {
      settleFinal({ phase: "paid", orderId: order.orderId });
      return { poll: false };
    }
    if (verdict === "LATE_REFUND" || verdict === "CLOSED") {
      settleFinal({ phase: "ended", orderId: order.orderId, reason: verdict, message: MESSAGES[verdict] });
      return { poll: false };
    }
    if (verdict === "PENDING") {
      set({ phase: "pending", order, reason: "PENDING", message: MESSAGES.PENDING });
      return { poll: true };
    }
    if (verdict === "NOT_PAID" && closedWith === "verify") {
      // Cashfree said success; the server has not seen it yet (webhook late).
      set({ phase: "pending", order, reason: "CONFIRMING", message: MESSAGES.CONFIRMING });
      return { poll: true };
    }
    set({ phase: "failed", order, reason: verdict === "FAILED" ? "FAILED" : "NOT_PAID", message: MESSAGES.FAILED });
    return { poll: false };
  }

  async function ask(orderId: string): Promise<PaymentRefreshResult | null> {
    try {
      return await deps.refresh(orderId);
    } catch {
      return null;
    }
  }

  /** Quiet background checks while a payment is pending / being confirmed. */
  async function poll(order: PendingOrder, closedWith: CheckoutClosed["kind"] | null, mine: number): Promise<void> {
    for (let i = 0; i < BACKGROUND_POLL_LIMIT; i += 1) {
      await deps.sleep(BACKGROUND_POLL_MS);
      // A newer start / retry / check bumped the generation: this loop is stale.
      if (mine !== generation) return;
      const result = await ask(order.orderId);
      if (mine !== generation) return;
      if (!result) continue;
      if (!apply(order, result, closedWith).poll) return;
    }
  }

  /** Back from the checkout: "verifying" while the server is asked, briefly, then its answer. */
  async function reconcile(order: PendingOrder, closedWith: CheckoutClosed["kind"] | null, mine: number): Promise<void> {
    set({ phase: "verifying", order });
    const attempts = closedWith === "verify" ? VERIFY_ATTEMPTS : CLOSED_ATTEMPTS;
    const interval = closedWith === "verify" ? VERIFY_INTERVAL_MS : CLOSED_INTERVAL_MS;
    let last: PaymentRefreshResult | null = null;
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await deps.sleep(interval);
      if (mine !== generation) return;
      last = (await ask(order.orderId)) ?? last;
      if (mine !== generation) return;
      if (last && SETTLED.has(verdictOf(last))) break;
    }
    if (!last) {
      // Unknown — never "failed": checked again quietly.
      set({ phase: "pending", order, reason: "CHECK_FAILED", message: MESSAGES.CHECK_FAILED });
      void poll(order, closedWith, mine);
      return;
    }
    if (apply(order, last, closedWith).poll) void poll(order, closedWith, mine);
  }

  const log = (event: string, data: Record<string, unknown>) => {
    try {
      deps.log?.(event, data);
    } catch {
      // diagnostics never break a payment
    }
  };

  function launchFailed(order: PendingOrder, reason: LaunchFailure, detail: string, message: string = MESSAGES.LAUNCH_FAILED): void {
    log("launch_failed", { orderId: order.orderId, reason, detail });
    set({ phase: "launch_failed", order, reason, message, detail });
  }

  /** Server codes after which the order itself may have changed (paid / closed) — asked about, quietly. */
  const ORDER_MAY_HAVE_CHANGED = new Set(["PAYMENT_ALREADY_CAPTURED", "VALIDATION_ERROR", "SELLER_CLOSED", "ORDERING_PAUSED"]);

  async function openWith(order: PendingOrder, session: CashfreeCheckout | null, mine: number): Promise<void> {
    if (!deps.available()) {
      log("sdk_unavailable", { orderId: order.orderId });
      set({ phase: "unavailable", order, message: MESSAGES.UNAVAILABLE });
      return;
    }
    set({ phase: "opening", order });
    let checkout = session;
    if (!checkout) {
      log("session_request", { orderId: order.orderId });
      try {
        const created = await deps.createSession(order.orderId);
        checkout = created.cashfree ?? null;
        if (Number.isInteger(created.amountPaise) && created.amountPaise > 0) order = { ...order, amountPaise: created.amountPaise };
      } catch (error) {
        const e = describeError(error);
        log("session_error", { orderId: order.orderId, ...e });
        if (mine !== generation) return;
        if (e.code && ORDER_MAY_HAVE_CHANGED.has(e.code)) {
          // Already paid meanwhile, the time ran out, or a store closed and
          // the unpaid order was cancelled: the server's state decides.
          const result = await ask(order.orderId);
          if (mine !== generation) return;
          const verdict = result ? verdictOf(result) : null;
          if (result && (verdict === "PAID" || verdict === "CLOSED" || verdict === "LATE_REFUND")) {
            apply(order, result, null);
            if (state.phase === "ended" && state.reason === "CLOSED" && e.status !== null && e.status >= 400 && e.status < 500) {
              set({ ...state, message: e.message });
            }
            return;
          }
        }
        // Nothing was opened, so nothing can have been paid: say what failed.
        launchFailed(order, "SESSION", `Server: ${e.message}${e.code ? ` (${e.code})` : ""}`, e.status !== null && e.status < 500 ? e.message : MESSAGES.LAUNCH_FAILED);
        return;
      }
    }
    if (mine !== generation) return;
    const received = checkout as Partial<CashfreeCheckout> | null;
    if (!validCheckout(checkout)) {
      launchFailed(order, "SESSION", `Server: incomplete Cashfree session (${JSON.stringify({ hasSession: !!received?.paymentSessionId, hasOrder: !!received?.orderId, environment: received?.environment ?? null })})`);
      return;
    }

    set({ phase: "paying", order });
    log("sdk_open", { orderId: order.orderId, cashfreeOrderId: checkout.orderId, environment: checkout.environment, session: maskId(checkout.paymentSessionId) });
    let closed: CheckoutClosed;
    try {
      closed = await deps.open(checkout);
    } catch (error) {
      // The SDK threw before showing anything: nothing was paid.
      const e = describeError(error);
      if (mine !== generation) return;
      launchFailed(order, "SDK", `Cashfree SDK: ${e.message}`);
      return;
    }
    log("sdk_closed", { orderId: order.orderId, kind: closed.kind, code: closed.code ?? null, message: closed.message, elapsedMs: closed.elapsedMs ?? null });
    if (mine !== generation) return;

    // Cashfree refused the session at once (invalid / expired session, app not
    // allowed for this account, environment mismatch…): its checkout never
    // became payable. Shown as what it is — with Cashfree's own reason — and
    // never as a failed payment. One quiet server check still runs in case
    // the order was paid by another route.
    if (
      closed.kind === "error" &&
      typeof closed.elapsedMs === "number" &&
      closed.elapsedMs < QUICK_REFUSAL_MS &&
      !isCancellation(closed)
    ) {
      launchFailed(order, "GATEWAY_REJECTED", `Cashfree: ${closed.message ?? "error"}${closed.code ? ` (${closed.code})` : ""}`);
      const result = await ask(order.orderId);
      if (mine === generation && result && verdictOf(result) === "PAID") apply(order, result, null);
      return;
    }

    // The customer was in Cashfree's checkout and came back: ask the server.
    await reconcile(order, closed.kind, mine);
  }

  /**
   * Right after the order is placed: open Cashfree's checkout with the
   * session that came with the order (or ask for one). No screen in between.
   */
  async function start(order: PendingOrder, session: CashfreeCheckout | null): Promise<PaymentState> {
    if (busy) return state;
    busy = true;
    const mine = ++generation;
    watched = null;
    deps.persist(order);
    try {
      await openWith(order, session, mine);
    } finally {
      busy = false;
    }
    return state;
  }

  /** The unpaid order the flow knows about (on screen, or watched quietly). */
  function pendingOrder(): PendingOrder | null {
    return "order" in state ? state.order : watched;
  }

  /**
   * "Retry payment" — the SAME order: the server's current session (the same
   * Cashfree order while it is valid). Never a new order.
   */
  async function resume(): Promise<PaymentState> {
    const order = pendingOrder();
    if (!order || busy) return state;
    busy = true;
    const mine = ++generation;
    watched = null;
    try {
      await openWith(order, null, mine);
    } finally {
      busy = false;
    }
    return state;
  }

  /**
   * A quiet check of the unpaid order — on return to the app, opening the
   * cart, or after a restart. Never while a checkout is starting or open:
   * that one reconciles itself when it closes. A success always wins (also
   * over a failed sheet); nothing is ever turned into "failed" by it.
   */
  async function check(order: PendingOrder | null = pendingOrder()): Promise<PaymentState> {
    if (!order || busy) return state;
    const mine = ++generation;
    const before = state.phase;
    const result = await ask(order.orderId);
    if (mine !== generation || busy) return state;
    const verdict = result ? verdictOf(result) : null;

    // On screen as failed, or no longer on screen (sheet closed / restart):
    // only a settled outcome is shown — a success (or a refund) above all.
    // A launch that failed stays as it is unless the order turned out paid.
    if (before === "failed" || before === "idle" || before === "launch_failed") {
      if (!result) return state;
      if (verdict === "PAID" || verdict === "LATE_REFUND") apply(order, result, null);
      else if (verdict === "CLOSED") {
        if (before === "failed") apply(order, result, null);
        else {
          watched = null;
          deps.persist(null);
        }
      } else if (verdict === "PENDING" && before !== "launch_failed") {
        if (apply(order, result, null).poll) void poll(order, null, mine);
      }
      return state;
    }

    if (!result) {
      // Unknown: keep what the customer was told; never claim a failure.
      if (state.phase !== "pending") set({ phase: "pending", order, reason: "CHECK_FAILED", message: MESSAGES.CHECK_FAILED });
      return state;
    }
    // A success callback the server has not seen yet stays "confirming".
    const closedWith = state.phase === "pending" && state.reason === "CONFIRMING" ? "verify" : null;
    if (apply(order, result, closedWith).poll) void poll(order, closedWith, mine);
    return state;
  }

  /** After a restart: the unpaid order remembered on disk, checked quietly (nothing shown unless it settled). */
  function restore(order: PendingOrder): Promise<PaymentState> {
    if (state.phase !== "idle") return Promise.resolve(state);
    watched = order;
    return check(order);
  }

  /**
   * The failed sheet's Close / "Try another payment method": back to the
   * normal cart. The order is still watched quietly (a late success is
   * shown); the next checkout reuses it or replaces it on the server.
   */
  function dismissFailure(): void {
    if (state.phase !== "failed") return;
    watched = state.order;
    generation += 1;
    set({ phase: "idle" });
  }

  /** The customer has seen the outcome (confirmed order opened, ended notice dismissed). */
  function dismiss(): void {
    if (state.phase === "paid" || state.phase === "ended") {
      generation += 1;
      set({ phase: "idle" });
    }
  }

  /** Forget everything (sign-out, or another order replaced this checkout). */
  function reset(): void {
    generation += 1;
    watched = null;
    deps.persist(null);
    set({ phase: "idle" });
  }

  return {
    start,
    resume,
    check,
    restore,
    dismissFailure,
    dismiss,
    reset,
    state: () => state,
    watched: () => watched,
    isBusy: () => busy,
  };
}

export type PaymentFlow = ReturnType<typeof createPaymentFlow>;
