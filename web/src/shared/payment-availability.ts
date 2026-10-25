/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * The two global payment switches (Admin Panel → Configuration → Payments):
 * PAYMENT_ONLINE_ENABLED and PAYMENT_COD_ENABLED, both ON unless an admin
 * turns one off.
 *
 * They decide whether a NEW order may be placed with a method, and whether a
 * NEW online payment may be started. They never touch what already
 * happened: orders placed, payments in flight (their verification, webhooks
 * and reconciliation), refunds and settlements carry on as before.
 *
 * The server enforces them (orders and payments); the app reads them from
 * the checkout quote to fade the unavailable option and explain it. Pure —
 * the backend, the Admin Panel and the app share it.
 */

import { PaymentMethod } from './enums';
import { ErrorCode } from './errors';

export interface PaymentSwitches {
  onlinePaymentEnabled: boolean;
  codEnabled: boolean;
}

/** What customers are told — the same words on the server and in the app. */
export const PAYMENT_UNAVAILABLE_MESSAGES = {
  ONLINE: 'Online payment is currently unavailable. Please select Cash on Delivery to continue.',
  COD: 'Cash on Delivery is currently unavailable. Please select Online Payment to continue.',
  ALL: 'Payments are temporarily unavailable. Please try again later.',
} as const;

/** Why `method` cannot be used for a new order / payment right now, or null when it can. */
export function paymentMethodBlock(method: PaymentMethod, switches: PaymentSwitches): { code: ErrorCode; message: string } | null {
  if (!switches.onlinePaymentEnabled && !switches.codEnabled) {
    return { code: ErrorCode.PAYMENTS_UNAVAILABLE, message: PAYMENT_UNAVAILABLE_MESSAGES.ALL };
  }
  if (method === PaymentMethod.ONLINE && !switches.onlinePaymentEnabled) {
    return { code: ErrorCode.ONLINE_PAYMENT_DISABLED, message: PAYMENT_UNAVAILABLE_MESSAGES.ONLINE };
  }
  if (method === PaymentMethod.COD && !switches.codEnabled) {
    return { code: ErrorCode.COD_DISABLED, message: PAYMENT_UNAVAILABLE_MESSAGES.COD };
  }
  return null;
}

/** The error codes a client treats as "this payment method is switched off right now". */
export const PAYMENT_SWITCH_ERROR_CODES: readonly ErrorCode[] = [
  ErrorCode.ONLINE_PAYMENT_DISABLED,
  ErrorCode.COD_DISABLED,
  ErrorCode.PAYMENTS_UNAVAILABLE,
];
