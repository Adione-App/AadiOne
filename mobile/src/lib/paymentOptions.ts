/**
 * The checkout's two payment buttons (Cart → "Pay Cash" / "Pay Online"):
 * which one can place an order right now, and what to tell the customer when
 * they tap one that cannot.
 *
 * The source is the checkout quote (POST /checkout/quote) — the server reads
 * the admin's global switches (Configuration → Payments) and this order's COD
 * eligibility at that moment. No quote (loading, failed) = neither button
 * can place an order: a method is never offered before the server said so.
 * A quote from an older server has no switch fields: both count as on, as
 * they were. The server refuses a switched-off method anyway
 * (ONLINE_PAYMENT_DISABLED / COD_DISABLED / PAYMENTS_UNAVAILABLE), so a
 * stale quote can never place an order with it.
 *
 * Pure (no React Native) — `npm run test:unit` covers it.
 */

import { PAYMENT_UNAVAILABLE_MESSAGES, type CheckoutQuoteResponse } from "@shared";

export interface PaymentOptionState {
  /** It can place an order (tap = place / confirm). */
  available: boolean;
  /** Shown when the customer taps it while unavailable; null = nothing to explain (e.g. still loading). */
  message: string | null;
}

export interface CheckoutPaymentState {
  online: PaymentOptionState;
  cod: PaymentOptionState;
  /** Shown above the buttons while no method is available at all; null otherwise. */
  banner: string | null;
}

type QuoteFields = Pick<CheckoutQuoteResponse, "codAllowed" | "codBlockedReason" | "onlinePaymentEnabled" | "codEnabled">;

export function checkoutPaymentState(quote: QuoteFields | null | undefined): CheckoutPaymentState {
  if (!quote) {
    return { online: { available: false, message: null }, cod: { available: false, message: null }, banner: null };
  }
  const onlineOn = quote.onlinePaymentEnabled !== false;
  const codOn = quote.codEnabled !== false;

  if (!onlineOn && !codOn) {
    const message = PAYMENT_UNAVAILABLE_MESSAGES.ALL;
    return { online: { available: false, message }, cod: { available: false, message }, banner: message };
  }

  const cod: PaymentOptionState = !codOn
    ? { available: false, message: PAYMENT_UNAVAILABLE_MESSAGES.COD }
    : quote.codAllowed
      ? { available: true, message: null }
      : { available: false, message: quote.codBlockedReason ?? "Cash on Delivery is not available for this order." };

  // Online off: point the customer to Cash on Delivery — unless COD cannot
  // take this order either, then say why instead of sending them to it.
  const online: PaymentOptionState = onlineOn
    ? { available: true, message: null }
    : {
        available: false,
        message: cod.available ? PAYMENT_UNAVAILABLE_MESSAGES.ONLINE : `Online payment is currently unavailable. ${cod.message ?? ""}`.trim(),
      };

  return {
    online,
    cod,
    banner: !online.available && !cod.available ? online.message : null,
  };
}
