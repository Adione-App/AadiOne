/**
 * Pure helpers for the admin marketplace views (admin-marketplace.service.ts):
 * stock classification, refund summaries, mobile masking and audit-log
 * redaction. No I/O — unit-tested on their own.
 */

/* -------------------------------------------------------------------------- */
/* stock                                                                      */
/* -------------------------------------------------------------------------- */

export type StockState = 'IN_STOCK' | 'LOW' | 'OUT';

/**
 * One listing's stock state, with the SAME definitions the seller panel uses
 * (listing-visibility.ts): available = stock − reserved; out = nothing
 * available; low = something available but at or under the threshold.
 */
export function stockState(listing: { stockQty: number; reservedQty: number; lowStockThreshold: number }): {
  availableQty: number;
  state: StockState;
} {
  const availableQty = Math.max(0, listing.stockQty - listing.reservedQty);
  if (availableQty <= 0) return { availableQty, state: 'OUT' };
  if (availableQty <= listing.lowStockThreshold) return { availableQty, state: 'LOW' };
  return { availableQty, state: 'IN_STOCK' };
}

/* -------------------------------------------------------------------------- */
/* payments                                                                   */
/* -------------------------------------------------------------------------- */

export type RefundSummaryState = 'NONE' | 'PENDING' | 'PARTIAL' | 'REFUNDED' | 'FAILED';

/**
 * A payment's refund position from its Refund rows: completed amounts are
 * summed (never estimated); any in-flight refund shows as PENDING first.
 */
export function refundSummary(
  paymentAmountPaise: number,
  refunds: { status: string; amountPaise: number }[],
): { state: RefundSummaryState; refundedPaise: number } {
  if (refunds.length === 0) return { state: 'NONE', refundedPaise: 0 };
  const refundedPaise = refunds.filter((r) => r.status === 'COMPLETED').reduce((sum, r) => sum + r.amountPaise, 0);
  if (refunds.some((r) => r.status === 'PENDING' || r.status === 'PROCESSING')) return { state: 'PENDING', refundedPaise };
  if (refundedPaise === 0) return { state: refunds.some((r) => r.status === 'FAILED') ? 'FAILED' : 'PENDING', refundedPaise };
  return { state: refundedPaise >= paymentAmountPaise ? 'REFUNDED' : 'PARTIAL', refundedPaise };
}

/**
 * What happened to a payment, for people reading the payment history — one
 * answer that combines the gateway's status with its order's status:
 *
 *   PAID                captured (even if the order was cancelled later — the
 *                       refund column then shows where that money went)
 *   PENDING             not finished, and its order is still waiting for it
 *   FAILED              the gateway failed it, or the order's payment failed
 *                       or expired while this attempt was still open
 *   CANCELLED           never completed, and the order was cancelled — or
 *                       paid through another attempt — so it never will be
 *   REFUNDED / PARTIALLY_REFUNDED   as the gateway reports
 *
 * Only PAID is ever money received. The payment row itself is never changed
 * to say this: an attempt left CREATED/PENDING stays that way for the
 * reconciliation sweep, which still checks it for a late capture.
 */
export type PaymentOutcome = 'PAID' | 'PENDING' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';

export function paymentOutcome(paymentStatus: string, orderStatus: string): PaymentOutcome {
  switch (paymentStatus) {
    case 'CAPTURED':
      return 'PAID';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'PARTIALLY_REFUNDED':
      return 'PARTIALLY_REFUNDED';
    case 'FAILED':
      return 'FAILED';
  }
  // CREATED / PENDING / AUTHORIZED — an attempt that never completed.
  if (orderStatus === 'PENDING_PAYMENT') return 'PENDING';
  if (orderStatus === 'PAYMENT_FAILED') return 'FAILED';
  return 'CANCELLED';
}

/** "9876543210" -> "••••••3210" — enough to tell customers apart, no more. */
export function maskMobile(mobile: string | null | undefined): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  return digits.length <= 4 ? '••••' : `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* audit logs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Keys whose values never leave the server in an audit-log view — identity
 * numbers, bank details and anything credential-like — at any depth.
 */
const SENSITIVE_KEY = /(pan|aadhaar|aadhar|account.?number|ifsc|password|passcode|secret|token|otp|signature|api.?key|private|card|cvv|upi.?pin|raw.?payload)/i;

export const REDACTED = '[redacted]';

export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactAuditValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactAuditValue(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/* -------------------------------------------------------------------------- */
/* paging                                                                     */
/* -------------------------------------------------------------------------- */

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paginate<T>(rows: T[], page: number, pageSize: number): Paged<T> {
  const start = (page - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), total: rows.length, page, pageSize };
}
