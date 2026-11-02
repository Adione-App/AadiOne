/**
 * Pay Online → Cashfree's checkout → back (src/lib/paymentFlow.ts) — run with
 * `npm run test:unit`. A fake Cashfree SDK and a fake server; no device.
 *
 * Only the server's answer decides: verifying → paid / failed (sheet) /
 * pending (neutral). The SDK's callback, a timeout, an app return or a
 * network error never makes a payment "failed" or "paid".
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

/** An older server's answer (no `outcome`): the verdict is derived the same way. */
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
/** The server's explicit verdicts. */
const outcome = (value: NonNullable<PaymentRefreshResult["outcome"]>, o: Partial<PaymentRefreshResult> = {}) => unpaid({ outcome: value, ...o });

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
    sessionOrders: [] as string[],
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
      (async (orderId: string) => {
        log.sessions += 1;
        log.sessionOrders.push(orderId);
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
const reasonOf = (state: PaymentState) => ("reason" in state ? state.reason : null);
async function until(flow: { state(): PaymentState }, phase: PaymentState["phase"]) {
  for (let i = 0; i < 20 && flow.state().phase !== phase; i += 1) await settle();
}

describe("Pay Online opens Cashfree's checkout directly", () => {
  it("with the session from the order: no extra request, no Aadione screen before it — opening → paying, Cashfree opened once", async () => {
    const { flow, log } = harness({ closes: [{ kind: "verify", message: null }], answers: [PAID] });
    await flow.start(ORDER, SESSION);
    assert.deepEqual(log.opens, [SESSION]);
    assert.equal(log.sessions, 0);
    assert.deepEqual(phases(log.states).slice(0, 3), ["opening", "paying", "verifying"]);
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

  it("repeated taps: a second start / retry while the first is open does nothing — one checkout", async () => {
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

describe("back from the checkout: verifying, then only the server's answer", () => {
  it("the verification screen comes first, whatever the SDK said", async () => {
    for (const closed of [{ kind: "verify", message: null }, { kind: "error", message: "payment cancelled" }] as CheckoutClosed[]) {
      const { flow, log } = harness({ closes: [closed], answers: [PAID] });
      await flow.start(ORDER, SESSION);
      assert.equal(phases(log.states)[2], "verifying");
      assert.equal(MESSAGES.VERIFYING, "Please wait while your payment is being verified.");
    }
  });

  it("verified success: 'paid' only after the server says so; nothing left to watch", async () => {
    const { flow, log } = harness({ closes: [{ kind: "verify", message: null }], answers: [PAID] });
    const state = await flow.start(ORDER, SESSION);
    assert.deepEqual(state, { phase: "paid", orderId: ORDER.orderId });
    assert.equal(log.persisted.at(-1), null);
  });

  it("the SDK's success callback alone never confirms: the server not seeing it yet is 'confirming' (pending), never paid", async () => {
    const answers = [...Array(VERIFY_ATTEMPTS).fill(unpaid()), unpaid(), PAID];
    const { flow, log } = harness({ closes: [{ kind: "verify", message: null }], answers });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "pending");
    assert.equal(reasonOf(state), "CONFIRMING");
    assert.ok(!phases(log.states).includes("failed"));
    // A delayed webhook: the quiet checks pick up the confirmation.
    await until(flow, "paid");
    assert.equal(flow.state().phase, "paid");
    assert.ok(log.refreshes > VERIFY_ATTEMPTS);
  });

  it("UPI Back without paying (Cashfree: no payment, none in progress — asked twice): the failed sheet; the order is still watched for a restart", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: "payment cancelled" }], answers: [outcome("NOT_PAID")] });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "failed");
    assert.equal(reasonOf(state), "NOT_PAID");
    assert.equal(state.phase === "failed" && state.message, MESSAGES.FAILED);
    assert.equal(log.refreshes, 2); // never failed on a single answer
    assert.notEqual(log.persisted.at(-1), null);
  });

  it("Cashfree checkout cancelled / insufficient balance / bank declined (server: newest attempt FAILED): the failed sheet", async () => {
    for (const answer of [outcome("FAILED"), unpaid({ lastAttemptFailed: true })]) {
      const { flow } = harness({ closes: [{ kind: "error", message: "failed" }], answers: [answer] });
      const state = await flow.start(ORDER, SESSION);
      assert.equal(state.phase, "failed");
      assert.equal(reasonOf(state), "FAILED");
    }
  });

  it("the failure message promises no refund — nothing was taken", () => {
    assert.equal(MESSAGES.FAILED, "Your payment could not be completed. Your cart is safe. You can try again or choose another payment method.");
    assert.doesNotMatch(MESSAGES.FAILED, /refund/i);
  });

  it("a cancellation callback for a payment that DID go through: confirmed, never failed", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: "user cancelled" }], answers: [unpaid(), PAID] });
    assert.equal((await flow.start(ORDER, SESSION)).phase, "paid");
    assert.ok(!phases(log.states).includes("failed"));
  });

  it("pending at the bank: neutral 'pending' — never the failed sheet, never paid — checked quietly until it settles", async () => {
    const { flow, log } = harness({
      closes: [{ kind: "error", message: null }],
      answers: [outcome("PENDING"), outcome("PENDING"), outcome("PENDING"), PAID],
    });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "pending");
    assert.equal(reasonOf(state), "PENDING");
    await until(flow, "paid");
    assert.equal(flow.state().phase, "paid");
    assert.ok(!phases(log.states).includes("failed"));
  });

  it("the server cannot be reached (network loss): pending CHECK_FAILED — never failed, never paid — and it keeps asking", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: null }], answers: [new Error("offline"), new Error("offline"), new Error("offline"), PAID] });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "pending");
    assert.equal(reasonOf(state), "CHECK_FAILED");
    await until(flow, "paid");
    assert.equal(flow.state().phase, "paid");
    assert.ok(!phases(log.states).includes("failed"));
  });

  it("the checkout's time ran out / replaced: 'ended' (no order, nothing charged); a late payment says it is refunded", async () => {
    const closed = harness({ closes: [{ kind: "error", message: null }], answers: [unpaid({ status: "CANCELLED" as PaymentRefreshResult["status"] })] });
    const a = await closed.flow.start(ORDER, SESSION);
    assert.deepEqual(a, { phase: "ended", orderId: ORDER.orderId, reason: "CLOSED", message: MESSAGES.CLOSED });
    assert.equal(closed.log.persisted.at(-1), null);
    const late = harness({ closes: [{ kind: "verify", message: null }], answers: [outcome("LATE_REFUND", { status: "CANCELLED" as PaymentRefreshResult["status"] })] });
    assert.equal(reasonOf(await late.flow.start(ORDER, SESSION)), "LATE_REFUND");
  });
});

describe("the failed sheet", () => {
  it("Retry payment: the SAME order through Cashfree again (POST /payments/create for it) — no new order", async () => {
    const { flow, log } = harness({
      closes: [{ kind: "error", message: "failed" }, { kind: "verify", message: null }],
      answers: [outcome("FAILED"), PAID],
    });
    await flow.start(ORDER, SESSION);
    assert.equal(flow.state().phase, "failed");
    const state = await flow.resume();
    assert.deepEqual(log.sessionOrders, [ORDER.orderId]);
    assert.equal(log.opens.length, 2);
    assert.equal(state.phase, "paid");
  });

  it("Close / Try another payment method: back to the normal cart (idle) — the order is still watched, and a late success is still shown", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: "failed" }], answers: [outcome("FAILED"), PAID] });
    await flow.start(ORDER, SESSION);
    flow.dismissFailure();
    assert.equal(flow.state().phase, "idle");
    assert.deepEqual(flow.watched(), ORDER);
    assert.notEqual(log.persisted.at(-1), null);
    // Later (back in the app / cart opened): the bank confirmed after all.
    assert.equal((await flow.check()).phase, "paid");
    assert.equal(flow.watched(), null);
  });

  it("after Close, a quiet check never brings the failed sheet back — only a settled outcome shows", async () => {
    const { flow } = harness({ closes: [{ kind: "error", message: "failed" }], answers: [outcome("FAILED")] });
    await flow.start(ORDER, SESSION);
    flow.dismissFailure();
    assert.equal((await flow.check()).phase, "idle");
    assert.equal((await flow.check()).phase, "idle");
  });

  it("Retry after Close (Pay Online again) still pays the same order", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: "failed" }, { kind: "verify", message: null }], answers: [outcome("FAILED"), PAID] });
    await flow.start(ORDER, SESSION);
    flow.dismissFailure();
    assert.equal((await flow.resume()).phase, "paid");
    assert.deepEqual(log.sessionOrders, [ORDER.orderId]);
  });

  it("a quiet check while the sheet is up: a success replaces it; anything else leaves it", async () => {
    const paid = harness({ closes: [{ kind: "error", message: "failed" }], answers: [outcome("FAILED"), PAID] });
    await paid.flow.start(ORDER, SESSION);
    assert.equal((await paid.flow.check()).phase, "paid");
    const still = harness({ closes: [{ kind: "error", message: "failed" }], answers: [outcome("FAILED"), new Error("offline")] });
    await still.flow.start(ORDER, SESSION);
    assert.equal((await still.flow.check()).phase, "failed");
  });
});

describe("recovery and lifecycle", () => {
  it("late webhook success: the next quiet check (resume / cart opened) finds the order paid", async () => {
    const { flow } = harness({ closes: [{ kind: "error", message: null }], answers: [outcome("PENDING"), outcome("PENDING"), PAID] });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "pending");
    // Whichever asks first — the background check or the quiet one — finds it paid.
    assert.equal((await flow.check()).phase, "paid");
  });

  it("app killed while the UPI app was open: after a restart the remembered order is checked and confirmed", async () => {
    const { flow } = harness({ answers: [PAID] });
    assert.equal((await flow.restore(ORDER)).phase, "paid");
  });

  it("after a restart, still pending: the neutral pending state (checked quietly)", async () => {
    const { flow } = harness({ answers: [outcome("PENDING")] });
    const state = await flow.restore(ORDER);
    assert.equal(state.phase, "pending");
  });

  it("after a restart, not paid: nothing is shown (the cart is simply as it was); the order stays watched; retry still pays it", async () => {
    const { flow, log } = harness({ answers: [outcome("NOT_PAID"), PAID], closes: [{ kind: "verify", message: null }] });
    assert.equal((await flow.restore(ORDER)).phase, "idle");
    assert.deepEqual(flow.watched(), ORDER);
    assert.equal((await flow.resume()).phase, "paid");
    assert.deepEqual(log.sessionOrders, [ORDER.orderId]);
  });

  it("after a restart, the checkout's time ran out: forgotten quietly", async () => {
    const { flow, log } = harness({ answers: [unpaid({ status: "CANCELLED" as PaymentRefreshResult["status"] })] });
    assert.equal((await flow.restore(ORDER)).phase, "idle");
    assert.equal(flow.watched(), null);
    assert.equal(log.persisted.at(-1), null);
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
    const { flow, log } = harness({ closes: [{ kind: "error", message: null }], answers: [outcome("PENDING")] });
    await flow.start(ORDER, SESSION);
    for (let i = 0; i < 200; i += 1) await settle();
    assert.ok(log.refreshes <= 2 + BACKGROUND_POLL_LIMIT);
  });

  it("sign-out / another order replaced the checkout: forgotten", async () => {
    const { flow, log } = harness({ closes: [{ kind: "error", message: null }], answers: [outcome("FAILED")] });
    await flow.start(ORDER, SESSION);
    flow.reset();
    assert.equal(flow.state().phase, "idle");
    assert.equal(flow.watched(), null);
    assert.equal(log.persisted.at(-1), null);
  });
});

describe("launching Cashfree — a launch that fails is never a failed payment", () => {
  const apiError = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });

  it("a NEW order with a valid session opens Cashfree first — no status check, no verifying before it", async () => {
    const { flow, log, release } = harness({ holdOpen: true, answers: [PAID] });
    const started = flow.start(ORDER, SESSION);
    await settle();
    assert.equal(log.opens.length, 1);
    assert.equal(log.refreshes, 0);
    assert.deepEqual(phases(log.states), ["opening", "paying"]);
    release({ kind: "verify", message: null, code: null, elapsedMs: 40_000 });
    assert.equal((await started).phase, "paid");
  });

  it("the SDK throws before showing anything: launch_failed (SDK) — no verifying, no failed sheet, no status call", async () => {
    const { flow, log } = harness({ openImpl: async () => { throw new Error("Session is invalid"); } });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(state.phase, "launch_failed");
    assert.equal(reasonOf(state), "SDK");
    assert.match(state.phase === "launch_failed" ? state.detail : "", /Session is invalid/);
    assert.equal(log.refreshes, 0);
    assert.ok(!phases(log.states).includes("verifying"));
    assert.ok(!phases(log.states).includes("failed"));
  });

  it("Cashfree refuses the session at once (onError in 300 ms): launch_failed (GATEWAY_REJECTED) with Cashfree's message and code", async () => {
    const { flow, log } = harness({
      openImpl: async () => ({ kind: "error", message: "payment_session_id is invalid", code: "request_failed", elapsedMs: 300 }),
      answers: [unpaid()],
    });
    const state = await flow.start(ORDER, SESSION);
    assert.equal(reasonOf(state), "GATEWAY_REJECTED");
    assert.equal(state.phase === "launch_failed" ? state.detail : "", "Cashfree: payment_session_id is invalid (request_failed)");
    assert.ok(!phases(log.states).includes("failed"));
    assert.ok(!phases(log.states).includes("verifying"));
  });

  it("an instant refusal for an order that turns out paid (another route) shows it paid", async () => {
    const { flow } = harness({ openImpl: async () => ({ kind: "error", message: "invalid", code: "x", elapsedMs: 100 }), answers: [PAID] });
    assert.equal((await flow.start(ORDER, SESSION)).phase, "paid");
  });

  it("a quick close that IS a cancellation, or an error after the customer was in the checkout, is verified with the server", async () => {
    const cancelled = harness({ openImpl: async () => ({ kind: "error", message: "payment cancelled by user", code: "action_cancelled", elapsedMs: 900 }), answers: [outcome("NOT_PAID")] });
    const a = await cancelled.flow.start(ORDER, SESSION);
    assert.ok(phases(cancelled.log.states).includes("verifying"));
    assert.equal(a.phase, "failed");
    const later = harness({ openImpl: async () => ({ kind: "error", message: "failed", code: "payment_failed", elapsedMs: 45_000 }), answers: [outcome("PENDING")] });
    assert.equal((await later.flow.start(ORDER, SESSION)).phase, "pending");
  });

  it("the server cannot create a session: launch_failed (SESSION) with the server's reason — Cashfree not called", async () => {
    const { flow, log } = harness({ createSession: async () => { throw apiError("Payments are temporarily unavailable", "PAYMENT_FAILED", 502); } });
    const state = await flow.start(ORDER, null);
    assert.equal(reasonOf(state), "SESSION");
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
      assert.equal(reasonOf(state), "SESSION");
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
    assert.deepEqual(log.sessionOrders, [ORDER.orderId]);
    assert.equal(log.opens.length, 2);
    assert.equal(again.phase, "paid");
  });

  it("a quiet check keeps a failed launch as it is — it never turns into a failed payment", async () => {
    const { flow } = harness({ openImpl: async () => { throw new Error("boom"); }, answers: [outcome("NOT_PAID")] });
    await flow.start(ORDER, SESSION);
    assert.equal((await flow.check()).phase, "launch_failed");
  });
});

describe("only the server decides", () => {
  it("the explicit outcome is used as sent; an older server's answer is derived the same way", () => {
    for (const value of ["PAID", "PENDING", "FAILED", "NOT_PAID", "CLOSED", "LATE_REFUND"] as const) {
      assert.equal(verdictOf(outcome(value)), value);
    }
    assert.equal(verdictOf(PAID), "PAID");
    assert.equal(verdictOf(unpaid({ paymentStatus: "PARTIALLY_REFUNDED", status: "PROCESSING" as PaymentRefreshResult["status"] })), "PAID");
    assert.equal(verdictOf(unpaid({ status: "CANCELLED" as PaymentRefreshResult["status"] })), "CLOSED");
    assert.equal(verdictOf(unpaid({ attemptPending: true })), "PENDING");
    assert.equal(verdictOf(unpaid({ lastAttemptFailed: true })), "FAILED");
    assert.equal(verdictOf(unpaid()), "NOT_PAID");
  });
});
