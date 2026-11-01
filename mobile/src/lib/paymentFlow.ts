/**
 * "Pay Online" from the cart — Cashfree's checkout opens straight away (no
 * Aadione payment screen before or after it), and when the customer is back
 * the SERVER is asked, quietly, what happened. Pure (the SDK, the API and the
 * clock come in as `PaymentFlowDeps`), so every way back is unit-tested
 * (tests/paymentFlow.test.ts); lib/pendingPayment.ts wires it to the app.
 *
 *   paid          only the server's answer (`POST /payments/:id/refresh` —
 *                 which asks Cashfree itself, as does the webhook) is
 *                 payment. The SDK's success callback never is.
 *   back without paying / checkout closed
 *                 never "failed": the order stays payable and unconfirmed,
 *                 and the customer can continue when ready (the server reuses
 *                 the same Cashfree order — no second order, no second
 *                 payment). Nothing is cancelled.
 *   pending       the bank has not answered: checked again quietly; paying
 *                 again asks first (it could charge twice).
 *   failed        only when Cashfree says the attempt failed — still a calm
 *                 message: the order can be paid again.
 *   late success  a payment confirmed after the customer was told "not
 *                 completed" (webhook, bank answer) is picked up by the next
 *                 check — on return to the app, the background checks, or
 *                 opening the cart — and shown as the confirmed order.
 *
 * One checkout at a time; a second tap while one is starting or open does
 * nothing. A callback after the checkout closed is ignored (lib/cashfree.ts).
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

export type NotCompletedReason =
  /** Back without paying, checkout closed, nothing in progress. */
  | "NOT_COMPLETED"
  /** The bank is still answering. */
  | "PENDING"
  /** Cashfree's success callback, but the server has not seen the payment yet. */
  | "CONFIRMING"
  /** Cashfree says the attempt failed (no money taken for it). */
  | "FAILED"
  /** The server could not be asked (network). */
  | "CHECK_FAILED";

export type PaymentState =
  | { phase: "idle" }
  /** Getting the session / opening Cashfree's checkout. */
  | { phase: "opening"; order: PendingOrder }
  /** Cashfree's checkout (or a UPI app it opened) is open. */
  | { phase: "paying"; order: PendingOrder }
  /** Quietly asking the server what happened (a subtle indicator, never a screen). */
  | { phase: "checking"; order: PendingOrder }
  /** Not paid yet — the order can be paid when the customer is ready. */
  | { phase: "waiting"; order: PendingOrder; reason: NotCompletedReason; message: string }
  /** Paid and confirmed by the server. */
  | { phase: "paid"; orderId: string }
  /** The order can no longer be paid (window closed / cancelled), or a late payment is being refunded. */
  | { phase: "ended"; orderId: string; reason: "CLOSED" | "LATE_REFUND"; message: string }
  /** This build cannot open Cashfree's checkout. */
  | { phase: "unavailable"; order: PendingOrder; message: string }
  /**
   * Cashfree's checkout could not be opened — never shown as "payment not
   * completed": nothing was paid. `detail` is the actual error (server or
   * Cashfree), shown small so it can be reported.
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
  /** Remembers the unpaid order across restarts (null = nothing pending). */
  persist(order: PendingOrder | null): void;
  onChange(state: PaymentState): void;
  /** Diagnostics for every launch stage (logcat in release builds). Never given secrets. */
  log?(event: string, data: Record<string, unknown>): void;
  /** Clock for launch timing. */
  now?(): number;
}

export const MESSAGES = {
  NOT_COMPLETED: "Payment wasn't completed. You can continue when you're ready.",
  PENDING:
    "Your bank is still processing a payment for this order. If money was deducted, the order is confirmed automatically — there's no need to pay again.",
  CONFIRMING: "We're confirming your payment with Cashfree. Your order is confirmed automatically once it's verified.",
  FAILED: "The last payment attempt didn't go through, and no money was taken for it. You can continue when you're ready.",
  CHECK_FAILED: "We couldn't check your payment just now. If money was deducted, your order is confirmed automatically.",
  CLOSED: "The payment time for this order ended, so it wasn't placed. Its items are back in your cart.",
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

type Verdict =
  | { kind: "PAID" }
  | { kind: "CLOSED" }
  | { kind: "LATE_REFUND" }
  | { kind: "UNPAID"; pending: boolean; failed: boolean };

/** The server's answer, in the only terms that matter here. */
export function verdictOf(result: PaymentRefreshResult): Verdict {
  // Paid only when the server says so (or the order has moved past payment
  // because it was paid). An SDK callback never enters this.
  if (result.paymentStatus === "PAID" || result.paymentStatus === "PARTIALLY_REFUNDED") return { kind: "PAID" };
  if (result.latePaymentRefund) return { kind: "LATE_REFUND" };
  if (result.status !== "PENDING_PAYMENT") return { kind: "CLOSED" };
  return { kind: "UNPAID", pending: result.attemptPending === true, failed: result.lastAttemptFailed };
}

export function createPaymentFlow(deps: PaymentFlowDeps) {
  let state: PaymentState = { phase: "idle" };
  /** Bumped by every new start / continue / reset — older loops stop. */
  let generation = 0;
  let busy = false;

  const set = (next: PaymentState) => {
    state = next;
    deps.onChange(next);
  };

  /** One server answer applied; returns true when it is final (nothing more to check). */
  function apply(order: PendingOrder, result: PaymentRefreshResult, closedWith: CheckoutClosed["kind"] | null): { final: boolean; poll: boolean } {
    const verdict = verdictOf(result);
    if (verdict.kind === "PAID") {
      deps.persist(null);
      set({ phase: "paid", orderId: order.orderId });
      return { final: true, poll: false };
    }
    if (verdict.kind === "LATE_REFUND" || verdict.kind === "CLOSED") {
      deps.persist(null);
      set({ phase: "ended", orderId: order.orderId, reason: verdict.kind, message: MESSAGES[verdict.kind] });
      return { final: true, poll: false };
    }
    if (verdict.pending) {
      set({ phase: "waiting", order, reason: "PENDING", message: MESSAGES.PENDING });
      return { final: false, poll: true };
    }
    if (verdict.failed) {
      set({ phase: "waiting", order, reason: "FAILED", message: MESSAGES.FAILED });
      return { final: false, poll: false };
    }
    if (closedWith === "verify") {
      // Cashfree said success; the server has not seen it yet (webhook late).
      set({ phase: "waiting", order, reason: "CONFIRMING", message: MESSAGES.CONFIRMING });
      return { final: false, poll: true };
    }
    set({ phase: "waiting", order, reason: "NOT_COMPLETED", message: MESSAGES.NOT_COMPLETED });
    return { final: false, poll: false };
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
      // A newer start / continue / check bumped the generation: this loop is stale.
      if (mine !== generation) return;
      const result = await ask(order.orderId);
      if (mine !== generation) return;
      if (!result) continue;
      const step = apply(order, result, closedWith);
      if (!step.poll) return;
    }
  }

  /** After the checkout closed: ask the server, briefly, then settle into a calm state. */
  async function reconcile(order: PendingOrder, closedWith: CheckoutClosed["kind"] | null, mine: number): Promise<void> {
    set({ phase: "checking", order });
    const attempts = closedWith === "verify" ? VERIFY_ATTEMPTS : CLOSED_ATTEMPTS;
    const interval = closedWith === "verify" ? VERIFY_INTERVAL_MS : CLOSED_INTERVAL_MS;
    let last: PaymentRefreshResult | null = null;
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await deps.sleep(interval);
      if (mine !== generation) return;
      last = (await ask(order.orderId)) ?? last;
      if (mine !== generation) return;
      if (last) {
        const verdict = verdictOf(last);
        if (verdict.kind !== "UNPAID" || verdict.failed) break;
      }
    }
    if (!last) {
      set({ phase: "waiting", order, reason: "CHECK_FAILED", message: MESSAGES.CHECK_FAILED });
      return;
    }
    const step = apply(order, last, closedWith);
    if (step.poll) void poll(order, closedWith, mine);
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
          // Already paid meanwhile, the window closed, or a store closed and
          // the unpaid order was cancelled: the server's state decides.
          const result = await ask(order.orderId);
          if (mine !== generation) return;
          const verdict = result ? verdictOf(result) : null;
          if (result && verdict && verdict.kind !== "UNPAID") {
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
    // never as "payment not completed". One quiet server check still runs in
    // case the order was paid by another route.
    if (
      closed.kind === "error" &&
      typeof closed.elapsedMs === "number" &&
      closed.elapsedMs < QUICK_REFUSAL_MS &&
      !isCancellation(closed)
    ) {
      launchFailed(order, "GATEWAY_REJECTED", `Cashfree: ${closed.message ?? "error"}${closed.code ? ` (${closed.code})` : ""}`);
      const result = await ask(order.orderId);
      if (mine === generation && result && verdictOf(result).kind === "PAID") apply(order, result, null);
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
    deps.persist(order);
    try {
      await openWith(order, session, mine);
    } finally {
      busy = false;
    }
    return state;
  }

  /** "Continue payment" for the unpaid order: the server's current session (the same Cashfree order while valid). */
  async function resume(): Promise<PaymentState> {
    const order = pendingOrder();
    if (!order || busy) return state;
    busy = true;
    const mine = ++generation;
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
   * that one reconciles itself when it closes.
   */
  async function check(order: PendingOrder | null = pendingOrder()): Promise<PaymentState> {
    if (!order || busy) return state;
    // A launch that failed is not "waiting for a payment": nothing was opened.
    // Only a confirmed payment (another route) changes what is shown.
    if (state.phase === "launch_failed") {
      const mineCheck = ++generation;
      const result = await ask(order.orderId);
      if (mineCheck === generation && !busy && result && verdictOf(result).kind !== "UNPAID") apply(order, result, null);
      return state;
    }
    const mine = ++generation;
    const result = await ask(order.orderId);
    if (mine !== generation || busy) return state;
    if (!result) {
      // Unknown: keep what the customer was told; never claim a failure.
      if (state.phase !== "waiting") set({ phase: "waiting", order, reason: "CHECK_FAILED", message: MESSAGES.CHECK_FAILED });
      return state;
    }
    // A success callback the server has not seen yet stays "confirming".
    const closedWith = state.phase === "waiting" && state.reason === "CONFIRMING" ? "verify" : null;
    const step = apply(order, result, closedWith);
    if (step.poll) void poll(order, closedWith, mine);
    return state;
  }

  /** The unpaid order the flow knows about (after a restart: restored by `restore`). */
  function pendingOrder(): PendingOrder | null {
    return "order" in state ? state.order : null;
  }

  /** After a restart: the unpaid order remembered on disk, checked quietly. */
  function restore(order: PendingOrder): Promise<PaymentState> {
    if (state.phase === "idle") set({ phase: "waiting", order, reason: "NOT_COMPLETED", message: MESSAGES.NOT_COMPLETED });
    return check(order);
  }

  /** The customer has seen the outcome (confirmed order opened, ended notice dismissed). */
  function dismiss(): void {
    if (state.phase === "paid" || state.phase === "ended") {
      generation += 1;
      set({ phase: "idle" });
    }
  }

  /** Forget everything (sign-out, or the order was cancelled by the customer). */
  function reset(): void {
    generation += 1;
    deps.persist(null);
    set({ phase: "idle" });
  }

  return { start, resume, check, restore, dismiss, reset, state: () => state, isBusy: () => busy };
}

export type PaymentFlow = ReturnType<typeof createPaymentFlow>;
