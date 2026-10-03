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
  /** Until when payment is accepted, while the order still awaits it. */
  payBy: string | null;
  /** Money arrived after the payment window closed and is being refunded. */
  latePaymentRefund: boolean;
}
