/**
 * DEVELOPMENT-ONLY timing of "Pay Online" → Cashfree checkout. Each payment
 * launch records when its stages happened; in a dev build every finished
 * launch is printed (Metro console) with the median / p95 of the launches so
 * far. Release builds record nothing and print nothing.
 *
 * Stages, in order:
 *   tap              the Pay Online handler ran
 *   orderRequest     POST /orders sent
 *   orderResponse    POST /orders answered (it carries the Cashfree session)
 *   sessionRequest   POST /payments/create sent (only when the order did not carry one)
 *   sessionReady     the Cashfree session is in hand
 *   sdkReady         the Cashfree SDK module is loaded
 *   checkoutInvoked  doWebPayment() called — Cashfree's checkout is opening
 * "Checkout visible" is not observable: the SDK reports nothing until it closes.
 *
 * The summary logic is pure (tests/paymentTiming.test.ts).
 */

export type PaymentStage =
  | "tap"
  | "orderRequest"
  | "orderResponse"
  | "sessionRequest"
  | "sessionReady"
  | "sdkReady"
  | "checkoutInvoked";

export type LaunchMarks = Partial<Record<PaymentStage, number>>;

declare const __DEV__: boolean | undefined;
const enabled = (): boolean => typeof __DEV__ !== "undefined" && __DEV__ === true;

let current: LaunchMarks | null = null;
const finished: number[] = [];

/** Starts a new launch at the tap. */
export function beginPaymentLaunch(now: number = Date.now()): void {
  if (!enabled()) return;
  current = { tap: now };
}

export function markPaymentStage(stage: PaymentStage, now: number = Date.now()): void {
  if (!enabled() || !current || current[stage] !== undefined) return;
  current[stage] = now;
  if (stage === "checkoutInvoked") {
    const marks = current;
    current = null;
    const summary = summarizeLaunch(marks);
    if (summary.totalMs !== null) finished.push(summary.totalMs);
    // eslint-disable-next-line no-console
    console.log("[payment-timing]", JSON.stringify({ ...summary, sofar: percentiles(finished) }));
  }
}

/** Abandons the launch (an error before checkout opened). */
export function cancelPaymentLaunch(): void {
  current = null;
}

export interface LaunchSummary {
  /** Milliseconds between consecutive recorded stages, keyed "from→to". */
  steps: Record<string, number>;
  /** Tap → checkout invoked, or null when either is missing. */
  totalMs: number | null;
}

const ORDER: PaymentStage[] = ["tap", "orderRequest", "orderResponse", "sessionRequest", "sessionReady", "sdkReady", "checkoutInvoked"];

export function summarizeLaunch(marks: LaunchMarks): LaunchSummary {
  const steps: Record<string, number> = {};
  let previous: PaymentStage | null = null;
  for (const stage of ORDER) {
    const at = marks[stage];
    if (at === undefined) continue;
    if (previous !== null) steps[`${previous}→${stage}`] = at - marks[previous]!;
    previous = stage;
  }
  const total = marks.tap !== undefined && marks.checkoutInvoked !== undefined ? marks.checkoutInvoked - marks.tap : null;
  return { steps, totalMs: total };
}

/** Nearest-rank median and p95 of `values` (null when empty). */
export function percentiles(values: readonly number[]): { n: number; median: number | null; p95: number | null } {
  if (values.length === 0) return { n: 0, median: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  return { n: sorted.length, median: rank(50), p95: rank(95) };
}
