/**
 * Payment response types the app uses beyond the shared contract.
 *
 * Kept local on purpose: `src/shared` is a copy of the backend's shared types
 * and must stay byte-identical to it, while these describe fields the
 * backend's payment module adds on top (see backend
 * `modules/payments/payment.service.ts` — `CreatePaymentResult`,
 * `PaymentRefreshResult`).
 */

import type { CreatePaymentResponse, OrderStatus } from "@shared";

export type CashfreeEnvironment = "SANDBOX" | "PRODUCTION";

/**
 * What the Cashfree SDK needs to open checkout. `orderId` is CASHFREE's order
 * id, not the AdiOne order id. None of this is a secret: the session pays for
 * this one Cashfree order and nothing else.
 */
export interface CashfreeCheckout {
  paymentSessionId: string;
  orderId: string;
  environment: CashfreeEnvironment;
}

/** `POST /payments/create` — Cashfree mode adds `cashfree`. */
export type CreatePaymentResult = CreatePaymentResponse & {
  cashfree?: CashfreeCheckout;
};

/**
 * Query key of an order's payment session. The Cart seeds it from the
 * `POST /orders` response (which carries the session for an online order),
 * so the payment screen opens Cashfree's checkout without another request.
 */
export const PAYMENT_INTENT_KEY = (orderId: string) => ["payment-intent", orderId] as const;

/**
 * The session the order response carried, when it is a usable Cashfree
 * checkout for THIS order (older servers send none). Pure — unit-tested.
 */
export function sessionFromOrderResponse(payment: CreatePaymentResult | null | undefined): CreatePaymentResult | null {
  if (!payment?.cashfree) return null;
  const { paymentSessionId, orderId: cashfreeOrderId } = payment.cashfree;
  if (!paymentSessionId || !cashfreeOrderId || payment.providerOrderId !== cashfreeOrderId) return null;
  if (!Number.isInteger(payment.amountPaise) || payment.amountPaise <= 0) return null;
  return payment;
}

/**
 * `POST /payments/:orderId/refresh` — the server asked Cashfree itself. This,
 * never the SDK callback, is what decides whether the order is paid.
 */
export interface PaymentRefreshResult {
  orderId: string;
  status: OrderStatus;
  paymentStatus: string;
  totalPaise: number;
  /** The newest attempt failed or was abandoned; the customer may retry. */
  lastAttemptFailed: boolean;
  /**
   * The newest attempt is still in progress at Cashfree (the UPI app or bank
   * has not answered). Show "Payment pending" and keep checking. Absent from
   * older servers.
   */
  attemptPending?: boolean;
  /** Until when payment is accepted, while the order still awaits it. */
  payBy: string | null;
  /** Money arrived after the payment window closed and is being refunded. */
  latePaymentRefund: boolean;
}
