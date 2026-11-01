/**
 * Pay Online → Cashfree's checkout → back (src/lib/paymentFlow.ts) — run with
 * `npm run test:unit`. A fake Cashfree SDK and a fake server; no device.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BACKGROUND_POLL_LIMIT,
  MESSAGES,
  VERIFY_ATTEMPTS,
  createPaymentFlow,
  verdictOf,
  type CheckoutClosed,
  type PaymentState,
  type PendingOrder,
} from "../src/lib/paymentFlow.ts";
import type { CashfreeCheckout, CreatePaymentResult, PaymentRefreshResult } from "../src/lib/payments.ts";

const ORDER: PendingOrder = { orderId: "order-1", amountPaise: 40_000 };
const SESSION: CashfreeCheckout = { paymentSessionId: "session_abc", orderId: "cf_order_1", environment: "SANDBOX" };

const unpaid = (o: Partial<PaymentRefreshResult> = {}): PaymentRefreshResult => ({
  orderId: ORDER.orderId,
  status: "PENDING_PAYMENT" as PaymentRefreshResult["status"],
  paymentStatus: "PENDING",
  totalPaise: ORDER.amountPaise,
  lastAttemptFailed: false,
  attemptPending: false,
  payBy: null,
  latePaymentRefund: false,
  ...o,
});
const PAID = unpaid({ status: "PROCESSING" as PaymentRefreshResult["status"], paymentStatus: "PAID" });

function harness(options: {
  available?: boolean;
  closes?: CheckoutClosed[];
  answers?: (PaymentRefreshResult | Error)[];
  createSession?: () => Promise<CreatePaymentResult>;
  /** Hold the checkout open until released. */
  holdOpen?: boolean;
  /** Custom SDK behaviour (throws, instant refusal, …). */
  openImpl?: (session: CashfreeCheckout) => Promise<CheckoutClosed>;
}) {
  const answers = [...(options.answers ?? [])];
  const closes = [...(options.closes ?? [])];
  const log = {
    opens: [] as CashfreeCheckout[],
    sessions: 0,
    refreshes: 0,
    persisted: [] as (PendingOrder | null)[],
    states: [] as PaymentState[],
    sleeps: 0,
  };
  let release: (closed: CheckoutClosed) => void = () => undefined;
  const flow = createPaymentFlow({
    available: () => options.available ?? true,
    open: (session) => {
      log.opens.push(session);
      if (options.openImpl) return options.openImpl(session);
      if (options.holdOpen) return new Promise((resolve) => (release = resolve));
      return Promise.resolve(closes.shift() ?? { kind: "error", message: null });
    },
    createSession:
      options.createSession ??
      (async () => {
        log.sessions += 1;
        return { cashfree: SESSION, amountPaise: ORDER.amountPaise } as unknown as CreatePaymentResult;
      }),
    refresh: async () => {
      log.refreshes += 1;
      const next = answers.length > 1 ? answers.shift()! : answers[0];
      if (!next) return unpaid();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async () => {
      log.sleeps += 1;
    },
    persist: (order) => log.persisted.push(order),
    onChange: (state) => log.states.push(state),
  });
  return { flow, log, release: (closed: CheckoutClosed) => release(closed) };
}

const phases = (states: PaymentState[]) => states.map((s) => s.phase);
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Pay Online opens Cashfree's checkout directly", () => {
  it("with the session from the order: no extra request, no screen — opening → paying, Cashfree opened once", async () => {
    const { flow, log } = harness({ closes: [{ kind: "verify", message: null }], answers: [PAID] });
    await flow.start(ORDER, SESSION);
    assert.deepEqual(log.opens, [SESSION]);
    assert.equal(log.sessions, 0);
    assert.deepEqual(phases(log.states).slice(0, 3), ["opening", "paying", "checking"]);
    assert.deepEqual(log.persisted[0], ORDER); // remembered for an app restart
  });

  it("without a session (older server / opened later): asks the server once, then opens", async () => {
    const { flow, log } = harness({ closes: [{ kind: "verify", message: null }], answers: [PAID] });
    await flow.start(ORDER, null);
    assert.equal(log.sessions, 1);
    assert.equal(log.opens.length, 1);
  });

  it("a build without the SDK: a calm message, nothing opened", async () => {
    const { flow, log } = harness({ available: false });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "unavailable");
    assert.equal(log.opens.length, 0);
  });

  it("double tap: a second start while the first is open does nothing", async () => {
    const { flow, log, release } = harness({ holdOpen: true, answers: [PAID] });
    const first = flow.start(ORDER, SESSION);
    await settle();
    await flow.start(ORDER, SESSION);
    await flow.resume();
    assert.equal(log.opens.length, 1);
    release({ kind: "verify", message: null });
    assert.equal((await first).phase, "paid");
  });
});

describe("every way back from the checkout", () => {
  it("verified success: confirmed only by the server — 'paid', nothing pending remembered", async () => {
    const { flow, log } = harness({ closes: [{ kind: "verify", message: null }], answers: [PAID] });
    const state = await flow.start(ORDER, SESSION);
    assert.deepEqual(state, { phase: "paid", orderId: ORDER.orderId });
    assert.equal(log.persisted.at(-1), null);
  });

  it("SDK success while the webhook is still on its way: 'confirming', checked again quietly — never confirmed by the SDK", async () => {
    const answers = [...Array(VERIFY_ATTEMPTS).fill(unpaid()), unpaid(), PAID];
    const { flow, log } = harness({ closes: [{ kind: "verify", message: null }], answers });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "waiting");
    assert.equal(state.phase === "waiting" && state.reason, "CONFIRMING");
    assert.equal(state.phase === "waiting" && state.message, MESSAGES.CONFIRMING);
    // The background check picks up the late confirmation.
    for (let i = 0; i < 10 && flow.state().phase !== "paid"; i += 1) await settle();
    assert.equal(flow.state().phase, "paid");
    assert.ok(log.refreshes > VERIFY_ATTEMPTS);
  });

  it("back from PhonePe / Google Pay without paying: 'Payment wasn't completed…' — not failed, not cancelled, still payable", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: "payment cancelled" }], answers: [unpaid()] });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "waiting");
    assert.equal(state.phase === "waiting" && state.reason, "NOT_COMPLETED");
    assert.equal(state.phase === "waiting" && state.message, "Payment wasn't completed. You can continue when you're ready.");
    assert.notEqual(log.persisted.at(-1), null); // still pending: recoverable after a restart
  });

  it("Back / closing Cashfree's checkout is reconciled with the server — a payment that did go through is confirmed", async () => {
    const { flow } = harness({ closes: [{ kind: "error", message: "user cancelled" }], answers: [unpaid(), PAID] });
    assert.equal((await flow.start(ORDER, SESSION)).phase, "paid");
  });

  it("pending at the bank: 'PENDING' with the no-need-to-pay-again message, checked quietly until it settles", async () => {
    const { flow } = harness({
      closes: [{ kind: "error", message: null }],
      answers: [unpaid({ attemptPending: true }), unpaid({ attemptPending: true }), unpaid({ attemptPending: true }), PAID],
    });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase === "waiting" && state.reason, "PENDING");
    for (let i = 0; i < 10 && flow.state().phase !== "paid"; i += 1) await settle();
    assert.equal(flow.state().phase, "paid");
  });

  it("definitive failure (server-verified): a calm 'didn't go through' — never a red failure, order still payable", async () => {
    const { flow } = harness({ closes: [{ kind: "error", message: "failed" }], answers: [unpaid({ lastAttemptFailed: true })] });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase === "waiting" && state.reason, "FAILED");
    assert.equal(state.phase === "waiting" && state.message, MESSAGES.FAILED);
  });

  it("the server cannot be reached on return: 'couldn't check' — never 'failed', never 'paid'", async () => {
    const { flow } = harness({ closes: [{ kind: "error", message: null }], answers: [new Error("offline")] });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase === "waiting" && state.reason, "CHECK_FAILED");
  });

  it("payment window closed / order cancelled: 'ended' with its reason; a late payment says it is refunded", async () => {
    const closed = harness({ closes: [{ kind: "error", message: null }], answers: [unpaid({ status: "PAYMENT_FAILED" as PaymentRefreshResult["status"] })] });
    const a = await closed.flow.start(ORDER, SESSION);
    assert.deepEqual(a, { phase: "ended", orderId: ORDER.orderId, reason: "CLOSED", message: MESSAGES.CLOSED });
    assert.equal(closed.log.persisted.at(-1), null);
    const late = harness({ closes: [{ kind: "verify", message: null }], answers: [unpaid({ status: "PAYMENT_FAILED" as PaymentRefreshResult["status"], latePaymentRefund: true })] });
    assert.equal(((await late.flow.start(ORDER, SESSION)) as { reason: string }).reason, "LATE_REFUND");
  });
});

describe("recovery", () => {
  it("Continue payment reuses the server's current session (the same Cashfree order) — no new order", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: null }, { kind: "verify", message: null }], answers: [unpaid(), unpaid(), PAID] });
    await flow.start(ORDER, SESSION);
    assert.equal(flow.state().phase, "waiting");
    const state = await flow.resume();
    assert.equal(log.sessions, 1); // POST /payments/create — the server reuses the open Cashfree order
    assert.equal(log.opens.length, 2);
    assert.equal(state.phase, "paid");
  });

  it("late webhook success: the next quiet check (resume / cart opened) finds the order paid", async () => {
    const { flow } = harness({ closes: [{ kind: "error", message: null }], answers: [unpaid(), unpaid(), PAID] });
    await flow.start(ORDER, SESSION);
    assert.equal(flow.state().phase, "waiting");
    assert.equal((await flow.check()).phase, "paid");
  });

  it("app killed while the UPI app was open: after a restart the remembered order is checked and confirmed", async () => {
    const { flow } = harness({ answers: [PAID] });
    assert.equal((await flow.restore(ORDER)).phase, "paid");
  });

  it("after a restart with the payment still unpaid: a calm waiting state, payable", async () => {
    const { flow } = harness({ answers: [unpaid()] });
    const state = await flow.restore(ORDER);
    assert.equal(state.phase === "waiting" && state.reason, "NOT_COMPLETED");
  });

  it("a quiet check never runs while a checkout is open (that one reconciles itself)", async () => {
    const { flow, log, release } = harness({ holdOpen: true, answers: [PAID] });
    const started = flow.start(ORDER, SESSION);
    await settle();
    await flow.check();
    assert.equal(log.refreshes, 0);
    release({ kind: "verify", message: null });
    await started;
    assert.equal(log.refreshes, 1);
  });

  it("background checks stop after a few minutes — never an endless loop", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: null }], answers: [unpaid({ attemptPending: true })] });
    await flow.start(ORDER, SESSION);
    for (let i = 0; i < 200; i += 1) await settle();
    assert.ok(log.refreshes <= 2 + BACKGROUND_POLL_LIMIT);
  });

  it("sign-out / cancel forgets the pending order", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: null }], answers: [unpaid()] });
    await flow.start(ORDER, SESSION);
    flow.reset();
    assert.equal(flow.state().phase, "idle");
    assert.equal(log.persisted.at(-1), null);
  });
});

describe("launching Cashfree — a launch that fails is never 'payment not completed'", () => {
  const apiError = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });

  it("a NEW order with a valid session opens Cashfree first — no status check, no checking/waiting state before it", async () => {
    const { flow, log, release } = harness({ holdOpen: true, answers: [PAID] });
    const started = flow.start(ORDER, SESSION);
    await settle();
    assert.equal(log.opens.length, 1);
    assert.equal(log.refreshes, 0);
    assert.deepEqual(phases(log.states), ["opening", "paying"]);
    release({ kind: "verify", message: null, code: null, elapsedMs: 40_000 });
    assert.equal((await started).phase, "paid");
  });

  it("the SDK throws before showing anything: launch_failed (SDK) with its error — no 'checking', no 'wasn't completed', no status call", async () => {
    const { flow, log } = harness({ openImpl: async () => { throw new Error("Session is invalid"); } });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "launch_failed");
    assert.equal(state.phase === "launch_failed" && state.reason, "SDK");
    assert.match(state.phase === "launch_failed" ? state.detail : "", /Session is invalid/);
    assert.equal(log.refreshes, 0);
    assert.ok(!phases(log.states).includes("checking"));
    assert.ok(!phases(log.states).includes("waiting"));
  });

  it("Cashfree refuses the session at once (onError in 300 ms): launch_failed (GATEWAY_REJECTED) with Cashfree's message and code", async () => {
    const { flow, log } = harness({
      openImpl: async () => ({ kind: "error", message: "payment_session_id is invalid", code: "request_failed", elapsedMs: 300 }),
      answers: [unpaid()],
    });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase === "launch_failed" && state.reason, "GATEWAY_REJECTED");
    assert.equal(state.phase === "launch_failed" ? state.detail : "", "Cashfree: payment_session_id is invalid (request_failed)");
    assert.ok(!phases(log.states).includes("waiting"));
    assert.ok(!phases(log.states).includes("checking"));
  });

  it("an instant refusal for an order that turns out paid (another route) shows it paid", async () => {
    const { flow } = harness({ openImpl: async () => ({ kind: "error", message: "invalid", code: "x", elapsedMs: 100 }), answers: [PAID] });
    assert.equal((await flow.start(ORDER, SESSION)).phase, "paid");
  });

  it("a quick close that IS a cancellation, or an error after the customer was in the checkout, goes to the server (customer came back)", async () => {
    const cancelled = harness({ openImpl: async () => ({ kind: "error", message: "payment cancelled by user", code: "action_cancelled", elapsedMs: 900 }), answers: [unpaid()] });
    assert.equal(((await cancelled.flow.start(ORDER, SESSION)) as { reason?: string }).reason, "NOT_COMPLETED");
    const later = harness({ openImpl: async () => ({ kind: "error", message: "failed", code: "payment_failed", elapsedMs: 45_000 }), answers: [unpaid()] });
    assert.equal(((await later.flow.start(ORDER, SESSION)) as { reason?: string }).reason, "NOT_COMPLETED");
  });

  it("the server cannot create a session: launch_failed (SESSION) with the server's reason — no reconciliation, Cashfree not called", async () => {
    const { flow, log } = harness({ createSession: async () => { throw apiError("Payments are temporarily unavailable", "PAYMENT_FAILED", 502); } });
    const state = await flow.start(ORDER, null);
    assert.equal(state.phase === "launch_failed" && state.reason, "SESSION");
    assert.equal(state.phase === "launch_failed" ? state.detail : "", "Server: Payments are temporarily unavailable (PAYMENT_FAILED)");
    assert.equal(log.opens.length, 0);
    assert.equal(log.refreshes, 0);
  });

  it("the server refuses because the order closed (store closed before payment): shown as ended, in the server's words", async () => {
    const { flow } = harness({
      createSession: async () => { throw apiError("The store closed. Your order was cancelled before any payment.", "SELLER_CLOSED", 422); },
      answers: [unpaid({ status: "CANCELLED" as PaymentRefreshResult["status"] })],
    });
    const state = await flow.start(ORDER, null);
    assert.equal(state.phase, "ended");
    assert.equal(state.phase === "ended" && state.message, "The store closed. Your order was cancelled before any payment.");
  });

  it("an incomplete session (missing id / unknown environment) never reaches the SDK", async () => {
    for (const bad of [
      { ...SESSION, paymentSessionId: "" },
      { ...SESSION, orderId: "  " },
      { ...SESSION, environment: "TEST" as CashfreeCheckout["environment"] },
    ]) {
      const { flow, log } = harness({});
      const state = await flow.start(ORDER, bad);
      assert.equal(state.phase === "launch_failed" && state.reason, "SESSION");
      assert.equal(log.opens.length, 0);
    }
  });

  it("Try again after a failed launch gets the server's session for the SAME order and opens Cashfree", async () => {
    let first = true;
    const { flow, log } = harness({
      openImpl: async () => {
        if (first) { first = false; return { kind: "error", message: "invalid", code: "request_failed", elapsedMs: 200 }; }
        return { kind: "verify", message: null, code: null, elapsedMs: 30_000 };
      },
      answers: [unpaid(), PAID],
    });
    assert.equal((await flow.start(ORDER, SESSION)).phase, "launch_failed");
    const again = await flow.resume();
    assert.equal(log.sessions, 1); // POST /payments/create for the same order — never a new order
    assert.equal(log.opens.length, 2);
    assert.equal(again.phase, "paid");
  });

  it("a quiet check (resume / cart opened) keeps a failed launch as it is — it never turns into 'wasn't completed'", async () => {
    const { flow } = harness({ openImpl: async () => { throw new Error("boom"); }, answers: [unpaid()] });
    await flow.start(ORDER, SESSION);
    assert.equal((await flow.check()).phase, "launch_failed");
  });
});

describe("only the server decides", () => {
  it("PAID / PARTIALLY_REFUNDED are paid; a non-pending order without payment is closed; everything else is unpaid", () => {
    assert.equal(verdictOf(PAID).kind, "PAID");
    assert.equal(verdictOf(unpaid({ paymentStatus: "PARTIALLY_REFUNDED", status: "PROCESSING" as PaymentRefreshResult["status"] })).kind, "PAID");
    assert.equal(verdictOf(unpaid({ status: "CANCELLED" as PaymentRefreshResult["status"] })).kind, "CLOSED");
    assert.deepEqual(verdictOf(unpaid({ lastAttemptFailed: true })), { kind: "UNPAID", pending: false, failed: true });
  });
});
