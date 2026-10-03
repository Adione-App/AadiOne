/**
 * Cashfree Payments (PG API) — hosted checkout driven by the mobile SDK.
 *
 * FLOW
 *   1. The server creates a Cashfree order for the AdiOne order's server-computed
 *      total and hands the app ONLY the single-order `payment_session_id`.
 *   2. The app opens Cashfree's checkout with that session. Its callback
 *      (`onVerify` / `onError`) is a hint, never proof.
 *   3. The server confirms by asking Cashfree directly (`fetchOrder`), from the
 *      app's refresh call, the signed webhook, or the reconciliation job —
 *      whichever arrives first settles; the others are no-ops.
 *
 * Plain `fetch`, no Cashfree SDK: four endpoints do not justify a dependency,
 * and it keeps the credentials inside this one file's request headers.
 *
 * Sources (official docs, checked 2026-09-30):
 *   orders      https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
 *   payments    https://www.cashfree.com/docs/api-reference/payments/latest/payments/get-payments-for-an-order
 *   refunds     https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create
 *   webhooks    https://www.cashfree.com/docs/api-reference/payments/latest/payments/webhooks
 *   signature   https://www.cashfree.com/docs/payments/online/webhooks/overview
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError } from "../../common/errors";
import { moduleLogger } from "../../common/logger";
import { ErrorCode } from "../../shared";
import type {
  CreateIntentInput,
  CreateIntentResult,
  PaymentProvider,
  ProviderOrderStatus,
  RefundInput,
  RefundResult,
  VerifyInput,
  VerifyResult,
  WebhookEvent,
} from "./index";

const log = moduleLogger("payment:cashfree");

export type CashfreeEnvironment = "SANDBOX" | "PRODUCTION";

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  environment: CashfreeEnvironment;
  apiVersion: string;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const BASE_URL: Record<CashfreeEnvironment, string> = {
  SANDBOX: "https://sandbox.cashfree.com/pg",
  PRODUCTION: "https://api.cashfree.com/pg",
};

/**
 * Cashfree refuses an `order_expiry_time` that is not MORE than 15 minutes
 * away. The Create Order docs say 5, but the API enforces 15 — verified
 * against Sandbox on 2026-09-30 with API versions 2025-01-01 and 2026-01-01:
 * a ~9-minute expiry is rejected with 400 order_expiry_time_invalid,
 * "Expiry time should be more than 15 min and less than 30 days".
 *
 * payment.service's checkout adds its own headroom on top of this, so the
 * expiry actually requested is ~16 minutes.
 */
export const CASHFREE_MIN_EXPIRY_MS = 15 * 60_000;

/** Cashfree `order_id`: 3–45 of [A-Za-z0-9_-]. */
const ORDER_ID_MAX = 45;

type CashfreePaymentStatus =
  | "SUCCESS"
  | "NOT_ATTEMPTED"
  | "FAILED"
  | "USER_DROPPED"
  | "VOID"
  | "CANCELLED"
  | "PENDING";

const ATTEMPT_ENDED_BADLY = new Set(["FAILED", "USER_DROPPED", "CANCELLED", "VOID"]);

interface CashfreeOrder {
  cf_order_id?: string | number;
  order_id: string;
  order_amount: number;
  order_currency?: string;
  order_status: string;
  order_expiry_time?: string;
  payment_session_id?: string;
  order_tags?: Record<string, string> | null;
}

interface CashfreePayment {
  cf_payment_id: string | number;
  order_id?: string;
  payment_status: CashfreePaymentStatus | string;
  payment_amount: number;
  payment_currency?: string;
  payment_message?: string | null;
  payment_group?: string | null;
  payment_time?: string | null;
}

interface CashfreeRefund {
  cf_refund_id?: string | number;
  refund_id: string;
  order_id?: string;
  refund_amount?: number;
  refund_status: string;
}

/** paise (integer) -> rupees with at most two decimals, as Cashfree expects. */
export function paiseToRupees(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

/** Cashfree amounts are rupees with up to two decimals; round, never truncate. */
export function rupeesToPaise(rupees: unknown): number {
  const value = typeof rupees === "string" ? Number(rupees) : rupees;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/**
 * ISO 8601 with an explicit +05:30 offset and no milliseconds — the exact form
 * the docs show (`2021-07-02T10:20:12+05:30`), rather than trusting that a `Z`
 * with milliseconds is accepted too.
 */
export function toCashfreeTime(date: Date): string {
  const ist = new Date(date.getTime() + 330 * 60_000);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
}

/**
 * AdiOne order numbers are reused across environments (V1, V2, sandbox), and a
 * Cashfree order id is unique per merchant forever — so each checkout gets a
 * random suffix. A second checkout for the same AdiOne order (the first one
 * expired) likewise needs a fresh id.
 */
export function cashfreeOrderId(orderNumber: string): string {
  const base = orderNumber.replace(/[^A-Za-z0-9_-]/g, "").slice(0, ORDER_ID_MAX - 9);
  return `${base}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Indian mobile -> the 10 digits Cashfree's `customer_phone` requires. */
function tenDigitPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-10);
}

/** Refund ids must be alphanumeric, 3–40 characters: a UUID minus hyphens. */
export function cashfreeRefundId(refundId: string): string {
  return refundId.replace(/-/g, "");
}

/** Inverse of `cashfreeRefundId`, for mapping a refund webhook back to our row. */
export function refundIdFromCashfree(value: string): string | null {
  if (!/^[0-9a-f]{32}$/i.test(value)) return null;
  const v = value.toLowerCase();
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}

function mapRefundStatus(status: string): RefundResult["status"] {
  switch (status) {
    case "SUCCESS":
      return "COMPLETED";
    case "CANCELLED":
    case "REJECTED":
    case "FAILED":
      return "FAILED";
    case "PENDING":
    case "PENDING_APPROVAL":
    case "ONHOLD":
    default:
      return "PENDING";
  }
}

function mapOrderStatus(status: string): ProviderOrderStatus["orderStatus"] {
  return status === "ACTIVE" ||
    status === "PAID" ||
    status === "EXPIRED" ||
    status === "TERMINATED"
    ? status
    : "OTHER";
}

export class CashfreeProvider implements PaymentProvider {
  readonly name = "cashfree";
  readonly minCheckoutWindowMs = CASHFREE_MIN_EXPIRY_MS;
  readonly environment: CashfreeEnvironment;
  private readonly baseUrl: string;
  private readonly http: typeof fetch;

  constructor(private readonly config: CashfreeConfig) {
    this.environment = config.environment;
    this.baseUrl = BASE_URL[config.environment];
    this.http = config.fetch ?? fetch;
  }

  /** Nothing client-side needs a Cashfree key — the session id is enough. */
  publicKey(): string {
    return "";
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "x-client-id": this.config.appId,
          "x-client-secret": this.config.secretKey,
          "x-api-version": this.config.apiVersion,
          "x-request-id": requestId,
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        internalMessage: `cashfree ${method} ${path} unreachable: ${String(error)}`,
      });
    }

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // Cashfree's error body is { message, code, type }. Never log headers:
      // they carry the secret.
      const code = typeof json["code"] === "string" ? json["code"] : "unknown";
      const message = typeof json["message"] === "string" ? json["message"] : "";
      throw new CashfreeApiError(response.status, code, message, `${method} ${path}`, requestId);
    }
    return json as T;
  }

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
      // Cashfree's minimum order_amount is ₹1.
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: "Invalid payment amount.",
        internalMessage: `cashfree createIntent refused amountPaise=${input.amountPaise}`,
      });
    }

    const phone = tenDigitPhone(input.customer.contact);
    const customerId = (input.customer.id ?? input.orderId).replace(/-/g, "").slice(0, 50);
    const name = input.customer.name?.trim() ?? "";
    const email = input.customer.email?.trim() ?? "";
    const orderId = cashfreeOrderId(input.orderNumber);

    const order = await this.call<CashfreeOrder>(
      "POST",
      "/orders",
      {
        order_id: orderId,
        // The amount ALWAYS comes from the order total the server computed.
        order_amount: paiseToRupees(input.amountPaise),
        order_currency: input.currency,
        customer_details: {
          customer_id: customerId,
          customer_phone: phone,
          ...(name.length >= 3 ? { customer_name: name.slice(0, 100) } : {}),
          ...(email.length >= 3 && email.length <= 100 ? { customer_email: email } : {}),
        },
        ...(input.expiresAt ? { order_expiry_time: toCashfreeTime(input.expiresAt) } : {}),
        order_note: `AdiOne order ${input.orderNumber}`.slice(0, 200),
        // Lets anyone looking at the Cashfree dashboard find the AdiOne order.
        order_tags: {
          adione_order_id: input.orderId,
          adione_order_number: input.orderNumber,
        },
      },
      // Retrying the same create can never mint a second Cashfree order.
      orderId,
    );

    if (!order.payment_session_id) {
      throw new AppError(ErrorCode.PAYMENT_FAILED, {
        internalMessage: `cashfree created order ${order.order_id} without a payment_session_id`,
      });
    }
    if (rupeesToPaise(order.order_amount) !== input.amountPaise) {
      throw new AppError(ErrorCode.PAYMENT_AMOUNT_MISMATCH, {
        internalMessage: `cashfree order ${order.order_id} amount ${order.order_amount} != ${input.amountPaise} paise`,
      });
    }

    return {
      providerOrderId: order.order_id,
      publicKey: "",
      checkout: {
        paymentSessionId: order.payment_session_id,
        environment: this.environment,
        expiresAt: order.order_expiry_time ?? (input.expiresAt?.toISOString() ?? null),
      },
    };
  }

  /**
   * The server-side source of truth: Cashfree's own view of the order and its
   * payment attempts. PAID requires BOTH the order to be PAID and a SUCCESS
   * payment — a SUCCESS attempt on a non-PAID order is not trusted.
   */
  async fetchOrder(providerOrderId: string): Promise<ProviderOrderStatus> {
    const path = `/orders/${encodeURIComponent(providerOrderId)}`;
    const order = await this.call<CashfreeOrder>("GET", path);
    const attempts = await this.call<CashfreePayment[]>("GET", `${path}/payments`);
    const list = Array.isArray(attempts) ? attempts : [];

    const success = list.find((p) => p.payment_status === "SUCCESS");
    // Only when the NEWEST attempt ended badly — a customer retrying right
    // now (PENDING) has not failed.
    const newest = [...list].sort((a, b) =>
      String(b.payment_time ?? "").localeCompare(String(a.payment_time ?? "")),
    )[0];
    const lastFailure =
      newest && ATTEMPT_ENDED_BADLY.has(String(newest.payment_status)) ? newest : undefined;

    const orderStatus = mapOrderStatus(order.order_status);
    return {
      providerOrderId: order.order_id,
      orderStatus,
      amountPaise: rupeesToPaise(order.order_amount),
      adioneOrderId: order.order_tags?.["adione_order_id"] ?? null,
      captured:
        orderStatus === "PAID" && success
          ? {
              providerPaymentId: String(success.cf_payment_id),
              amountPaise: rupeesToPaise(success.payment_amount),
              method: success.payment_group ?? null,
            }
          : null,
      lastFailure: lastFailure
        ? {
            providerPaymentId: String(lastFailure.cf_payment_id),
            status: String(lastFailure.payment_status),
            reason: lastFailure.payment_message ?? null,
          }
        : null,
    };
  }

  /**
   * Cashfree's SDK returns no signature to check — there is nothing to verify
   * client-side. Verification is `fetchOrder`, i.e. asking Cashfree.
   */
  async verify(input: VerifyInput): Promise<VerifyResult> {
    const status = await this.fetchOrder(input.providerOrderId);
    const captured = status.captured;
    return {
      verified: captured !== null,
      amountPaise: captured?.amountPaise ?? 0,
      status: captured ? "CAPTURED" : "PENDING",
      method: captured?.method ?? null,
      failureReason: status.lastFailure?.reason ?? null,
    };
  }

  /** Cashfree payments are looked up by ORDER, never by payment id alone. */
  async getStatus(providerPaymentId: string): Promise<VerifyResult> {
    throw new AppError(ErrorCode.INTERNAL_ERROR, {
      internalMessage: `cashfree getStatus(${providerPaymentId}) is unsupported — use fetchOrder(providerOrderId)`,
    });
  }

  /**
   * Signature = base64(HMAC-SHA256(secret key, x-webhook-timestamp + raw body)).
   * It MUST be computed over the raw bytes: re-serialising the parsed JSON can
   * change decimal formatting (`10.10` -> `10.1`) and break the signature.
   *
   * No timestamp-age window: a replayed event is harmless (the event id makes
   * it a no-op, and settlement re-queries Cashfree regardless), whereas a
   * window would reject Cashfree's own delayed retries.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookEvent {
    const signature = headers["x-webhook-signature"] ?? "";
    const timestamp = headers["x-webhook-timestamp"] ?? "";
    const expected = createHmac("sha256", this.config.secretKey)
      .update(timestamp)
      .update(rawBody)
      .digest("base64");
    const signatureValid =
      signature.length > 0 &&
      timestamp.length > 0 &&
      expected.length === signature.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(signature));

    const payload = JSON.parse(rawBody.toString("utf8")) as {
      type?: string;
      data?: {
        order?: { order_id?: string; order_amount?: number };
        payment?: Partial<CashfreePayment>;
        refund?: Partial<CashfreeRefund> & { cf_payment_id?: string | number };
      };
    };
    const type = String(payload.type ?? "unknown");
    const order = payload.data?.order;
    const payment = payload.data?.payment;
    const refund = payload.data?.refund;

    if (refund && /REFUND/.test(type)) {
      const cfRefundId = refund.cf_refund_id !== undefined ? String(refund.cf_refund_id) : null;
      const refundStatus = String(refund.refund_status ?? "UNKNOWN");
      return {
        eventId: `${type}:${cfRefundId ?? refund.refund_id ?? randomUUID()}:${refundStatus}`,
        type,
        signatureValid,
        providerOrderId: refund.order_id ?? null,
        providerPaymentId: refund.cf_payment_id !== undefined ? String(refund.cf_payment_id) : null,
        amountPaise: refund.refund_amount !== undefined ? rupeesToPaise(refund.refund_amount) : null,
        status: "REFUND_UPDATE",
        refund: {
          refundId: refund.refund_id ? refundIdFromCashfree(refund.refund_id) : null,
          providerRefundId: cfRefundId,
          status: mapRefundStatus(refundStatus),
        },
        payload,
      };
    }

    const cfPaymentId =
      payment?.cf_payment_id !== undefined ? String(payment.cf_payment_id) : null;
    const paymentStatus = String(payment?.payment_status ?? "");

    return {
      // One event per (type, attempt): Cashfree's retries of the same event
      // collapse onto this id, so it is processed at most once.
      eventId: `${type}:${cfPaymentId ?? order?.order_id ?? randomUUID()}`,
      type,
      signatureValid,
      providerOrderId: order?.order_id ?? null,
      providerPaymentId: cfPaymentId,
      amountPaise: payment?.payment_amount !== undefined ? rupeesToPaise(payment.payment_amount) : null,
      status:
        type === "PAYMENT_SUCCESS_WEBHOOK" && paymentStatus === "SUCCESS"
          ? "CAPTURED"
          : type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK"
            ? "ATTEMPT_FAILED"
            : "OTHER",
      failureReason: payment?.payment_message ?? null,
      payload,
    };
  }

  /**
   * `refund_id` is our Refund row id, so a retry of the same refund is refused
   * by Cashfree (409) instead of paying out twice; on that conflict the
   * existing refund is read back and returned.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    if (!input.providerOrderId || !input.refundId) {
      throw new AppError(ErrorCode.REFUND_FAILED, {
        internalMessage: "cashfree refund needs the provider order id and our refund id",
      });
    }
    const refundId = cashfreeRefundId(input.refundId);
    const path = `/orders/${encodeURIComponent(input.providerOrderId)}/refunds`;
    try {
      const refund = await this.call<CashfreeRefund>(
        "POST",
        path,
        {
          refund_amount: paiseToRupees(input.amountPaise),
          refund_id: refundId,
          refund_note: input.reason.trim().slice(0, 100).padEnd(3, "."),
        },
        refundId,
      );
      return {
        providerRefundId: String(refund.cf_refund_id ?? refundId),
        status: mapRefundStatus(refund.refund_status),
      };
    } catch (error) {
      if (error instanceof CashfreeApiError && error.httpStatus === 409) {
        log.warn({ refundId: input.refundId }, "cashfree refund already exists — reading it back");
        return this.getRefund(input.providerOrderId, input.refundId);
      }
      throw error;
    }
  }

  async getRefund(providerOrderId: string, refundId: string): Promise<RefundResult> {
    const refund = await this.call<CashfreeRefund>(
      "GET",
      `/orders/${encodeURIComponent(providerOrderId)}/refunds/${cashfreeRefundId(refundId)}`,
    );
    return {
      providerRefundId: String(refund.cf_refund_id ?? cashfreeRefundId(refundId)),
      status: mapRefundStatus(refund.refund_status),
    };
  }
}

/**
 * A non-2xx Cashfree response. Carries no credentials. `httpStatus` is
 * Cashfree's status; the AppError's own `status` stays ours (402).
 */
export class CashfreeApiError extends AppError {
  constructor(
    readonly httpStatus: number,
    readonly cashfreeCode: string,
    cashfreeMessage: string,
    endpoint: string,
    requestId: string,
  ) {
    super(ErrorCode.PAYMENT_FAILED, {
      internalMessage: `cashfree ${endpoint} ${httpStatus} ${cashfreeCode}: ${cashfreeMessage} (x-request-id ${requestId})`,
    });
  }
}
