/**
 * UPI intent provider — pay directly to the shop's VPA.
 *
 * HOW THIS DIFFERS FROM A PAYMENT GATEWAY:
 *
 * A `upi://pay?...` deep link hands the customer to their own UPI app.
 * The money moves directly into the shop's account. There is NO callback,
 * NO webhook and NO provider API that can reliably tell this server that
 * the payment succeeded.
 *
 * Therefore this provider deliberately does NOT automatically verify payment.
 * The customer can return to the app after attempting payment, but the order
 * remains pending until an authorized admin confirms that the money was
 * actually received in the merchant's UPI/bank account.
 */

import { randomUUID } from "node:crypto";

import { env } from "../../config/env";
import { moduleLogger } from "../../common/logger";
import { AppError } from "../../common/errors";
import { ErrorCode } from "../../shared";
import type {
  CreateIntentInput,
  CreateIntentResult,
  PaymentProvider,
  RefundResult,
  VerifyInput,
  VerifyResult,
  WebhookEvent,
} from "./index";

const log = moduleLogger("payment:upi");

/**
 * Builds the NPCI-standard UPI intent URL.
 *
 * pa = payee / merchant VPA
 * pn = payee / merchant name
 * am = amount in RUPEES
 * tr = transaction/reference ID
 * tn = transaction note
 * cu = currency
 *
 * IMPORTANT:
 * `amountPaise` is the internal server amount.
 * UPI requires `am` in rupees, so we convert paise -> rupees here.
 *
 * Example:
 *
 * amountPaise: 25300
 *
 * becomes:
 *
 * am=253.00
 */
export function buildUpiIntentUrl(input: {
  vpa: string;
  payeeName: string;
  amountPaise: number;
  orderNumber: string;
}): string {
  if (!input.vpa || !input.vpa.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "Merchant UPI ID is not configured.",
    });
  }

  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "Invalid payment amount.",
    });
  }

  if (!input.orderNumber || !input.orderNumber.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "Invalid order reference.",
    });
  }

  const params = new URLSearchParams({
    pa: input.vpa.trim(),
    pn: input.payeeName.trim() || "Aadione",

    // UPI requires the amount in rupees, not paise.
    am: (input.amountPaise / 100).toFixed(2),

    // Unique order/reference identifier.
    tr: input.orderNumber.trim(),

    // Human-readable payment note.
    tn: `Aadione Order ${input.orderNumber.trim()}`,

    cu: "INR",
  });

  return `upi://pay?${params.toString()}`;
}

export class UpiIntentProvider implements PaymentProvider {
  readonly name = "upi_intent";

  /**
   * Direct UPI has no gateway public key.
   *
   * This method is retained for compatibility with the existing
   * PaymentProvider interface.
   *
   * The actual merchant UPI ID is now obtained by payment.service.ts from:
   *
   *   ConfigKey.ADIONE_UPI_ID
   *
   * and therefore this method must NOT be used as the source of truth
   * for merchant configuration.
   */
  publicKey(): string {
    return "";
  }

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    /*
     * There is no gateway-side payment order.
     *
     * We therefore create our own internal provider reference.
     */
    const providerOrderId = `upi_${input.orderNumber}_${randomUUID().slice(0, 8)}`;

    log.info(
      {
        orderNumber: input.orderNumber,
        amountPaise: input.amountPaise,
      },
      "upi intent created",
    );

    /*
     * The merchant UPI ID is deliberately NOT read from env.UPI_VPA here.
     *
     * payment.service.ts is responsible for obtaining the configured
     * ADIONE_UPI_ID from ConfigService and constructing the final UPI intent.
     *
     * Returning only the provider reference here keeps this provider
     * independent from business configuration.
     */
    return {
      providerOrderId,
      publicKey: "",
    };
  }

  /**
   * Direct UPI payments cannot be automatically verified.
   *
   * There is no gateway API, webhook or trusted callback available here.
   *
   * Therefore this ALWAYS returns verified=false.
   *
   * The authorized admin must independently check the merchant's actual
   * UPI/bank transaction history and use the admin "Mark Payment Received"
   * action.
   */
  async verify(_input: VerifyInput): Promise<VerifyResult> {
    return {
      verified: false,
      amountPaise: 0,
      status: "PENDING",
      method: "upi",
      failureReason:
        "UPI payments are confirmed by the store, not automatically",
    };
  }

  /**
   * Direct UPI has no trusted webhook.
   *
   * Any request attempting to use this provider as a webhook must therefore
   * be rejected.
   */
  parseWebhook(): WebhookEvent {
    throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
      internalMessage: "the UPI intent provider receives no webhooks",
    });
  }

  /**
   * Direct UPI transfers cannot be refunded through an API.
   *
   * The merchant must refund the customer from the merchant UPI/bank app.
   */
  async refund(): Promise<RefundResult> {
    throw new AppError(ErrorCode.REFUND_FAILED, {
      message:
        "This payment was made directly by UPI. Please refund the customer from your UPI app and mark the order refunded.",
      internalMessage:
        "automatic refunds are impossible for direct UPI transfers",
    });
  }

  /**
   * There is no provider API that can reliably determine the payment state.
   *
   * Always return PENDING until the admin manually confirms receipt.
   */
  async getStatus(): Promise<VerifyResult> {
    return {
      verified: false,
      amountPaise: 0,
      status: "PENDING",
      method: "upi",
    };
  }
}
