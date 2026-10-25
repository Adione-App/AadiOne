/**
 * Payments (Phase 9).
 *
 * Three paths converge on ONE idempotent handler (PRD §14.4):
 *
 *   FAST      client calls /payments/verify after the PSP sheet closes
 *   TRUTH     the PSP's signed webhook arrives
 *   RECONCILE a job sweeps payments left pending and asks the provider
 *
 * Whichever arrives first wins; the others are no-ops. That is what survives
 * the real failure modes — the app killed mid-payment, the webhook arriving
 * before the client returns, the phone losing network after paying, or the
 * provider retrying a webhook five times.
 *
 * A CLIENT-REPORTED SUCCESS NEVER CONFIRMS A PAYMENT ON ITS OWN. `/verify`
 * re-queries the provider server-side.
 */

import {
  ActorType,
  ConfigKey,
  ErrorCode,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Permission,
  RefundStatus,
  SellerOrderStatus,
  canTransition,
  paymentMethodBlock,
  type CreatePaymentResponse,
  type VerifyPaymentResponse,
} from "../../shared";
import type { Order, User } from "@prisma/client";
import { AppError } from "../../common/errors";
import { env } from "../../config/env";
import { prisma, runInTransaction, type Tx } from "../../infra/db/prisma";
import {
  allowsManualPaymentConfirmation,
  buildUpiIntentUrl,
  CashfreeApiError,
  payments as provider,
  requiresManualPaymentConfirmation,
} from "../../infra/payment";
import type {
  CheckoutSession,
  ProviderOrderStatus,
  RefundResult,
  WebhookEvent,
} from "../../infra/payment";
import { moduleLogger } from "../../common/logger";
import { randomUUID } from "node:crypto";
import { cache } from "../../infra/cache";
import { CacheKey } from "../../infra/cache/types";
import * as configService from "../configuration/configuration.service";
import * as notificationService from "../notifications/notification.service";
import { customerPaidPaise } from "../orders/coupon-allocation";
import {
  confirmPaymentAndPlace,
  transitionOrder,
} from "../orders/order-state.service";

const log = moduleLogger("payments");

/* -------------------------------------------------------------------------- */
/* Task 9.2 — create                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The shared response plus, for a hosted-checkout gateway (Cashfree), the
 * three values the app hands to the gateway's SDK. Declared here rather than
 * in `shared/` so the shared contract (and every copy of it) is unchanged.
 */
export interface CreatePaymentResult extends CreatePaymentResponse {
  cashfree?: {
    paymentSessionId: string;
    /** Cashfree's order id (= `providerOrderId`), NOT the AdiOne order id. */
    orderId: string;
    environment: CheckoutSession["environment"];
  };
}

/**
 * A captured payment that did not pay for its order — it arrived after the
 * order stopped awaiting payment (hold expired, cancelled), or the order was
 * already paid by another payment. It is recorded, never applied, and
 * refunded automatically. Stored in `payments.failure_code`.
 */
const ORPHAN_CAPTURE = "ORPHAN_CAPTURE";

/**
 * `payments.failure_reason` prefix of an ORPHAN capture whose amount did not
 * match its order (see `settleCapture`). Stable: `refreshPayment` recognises
 * the case by it to keep telling the app what happened.
 */
const AMOUNT_MISMATCH_REASON = "Amount mismatch";

/** What the customer is told about a wrong-amount capture: it is being refunded, and they may pay again. */
function amountMismatchError(): AppError {
  return new AppError(ErrorCode.PAYMENT_AMOUNT_MISMATCH, {
    message:
      "The amount charged did not match this order, so the payment was not accepted and is being refunded automatically. You can pay again.",
  });
}

/**
 * A captured payment that can be neither applied nor refunded automatically
 * (wrong currency, or a gateway order tagged for another order): alert the
 * admins who can refund, once per provider payment. The audit row written
 * next to it carries the details. Never throws.
 */
async function alertManualPaymentReview(
  order: Pick<Order, "id" | "orderNumber">,
  input: { providerPaymentId: string; amountPaise: number },
  reason: string,
): Promise<void> {
  await notificationService.notifyAdmins(Permission.ORDER_REFUND, {
    type: NotificationType.ADMIN_REFUND_FAILED,
    dedupeKey: `payment-review:${provider.name}:${input.providerPaymentId}`,
    orderId: order.id,
    context: { orderNumber: order.orderNumber, amountPaise: input.amountPaise, reason },
  });
}

/**
 * A checkout replaced moments ago (a new Cashfree order was opened because
 * the old one was about to expire) can still have been paid in its final
 * seconds. The app's refresh AND reconciliation both re-check such a row for
 * this long — the same condition, so neither can miss what the other sees.
 */
const SUPERSEDED_RECHECK_MS = 15 * 60_000;

function recentlySupersededCheckout() {
  return {
    status: PaymentStatus.FAILED,
    failureCode: "CHECKOUT_SUPERSEDED",
    updatedAt: { gt: new Date(Date.now() - SUPERSEDED_RECHECK_MS) },
  };
}

/** Payment row statuses that mean money was actually taken. */
const MONEY_TAKEN: PaymentStatus[] = [
  PaymentStatus.CAPTURED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/**
 * The AdiOne hold outlives the gateway order by this much, so a payment made
 * in the gateway's final second still lands on a live order instead of being
 * refunded as late.
 */
const CHECKOUT_GRACE_MS = 60_000;

/** Headroom over the gateway's minimum window, for request latency. */
const CHECKOUT_SAFETY_MS = 60_000;

/** Reopening the sheet reuses the session only while this much time is left. */
const CHECKOUT_REUSE_MIN_MS = 60_000;

export interface CheckoutExpiryPlan {
  /** When the gateway order stops accepting payment (epoch ms). */
  gatewayExpiresAt: number;
  /** The AdiOne hold to stretch THIS order to (epoch ms), or null to keep it. */
  extendedHoldTo: number | null;
}

/**
 * The gateway order's expiry and, when needed, this order's stretched hold.
 * Pure — the arithmetic `createCheckoutSession` applies.
 *
 * INVARIANT: gatewayExpiresAt <= (resulting hold) - CHECKOUT_GRACE_MS — the
 * gateway stops taking money a minute BEFORE AdiOne releases the stock, so a
 * payment can never land on an order whose stock is already back on sale.
 *
 * Normally the gateway order simply ends a minute before the existing hold.
 * When the gateway needs longer than that (Cashfree insists on more than 15
 * minutes, the hold is 10), the gateway gets its minimum plus
 * CHECKOUT_SAFETY_MS and only this order's hold is stretched to cover it —
 * bounded by the original hold plus one such window, so the stretch happens
 * once and reopening checkout can never hold stock indefinitely. Returns null
 * when that bound is passed (the time to pay has run out).
 */
export function planCheckoutExpiry(input: {
  now: number;
  holdEndsAt: number;
  orderCreatedAt: number;
  holdMinutes: number;
  gatewayMinWindowMs: number;
}): CheckoutExpiryPlan | null {
  const minWindowMs = input.gatewayMinWindowMs + CHECKOUT_SAFETY_MS;
  const withinHold = input.holdEndsAt - CHECKOUT_GRACE_MS;
  if (withinHold >= input.now + minWindowMs) {
    return { gatewayExpiresAt: withinHold, extendedHoldTo: null };
  }
  const gatewayExpiresAt = input.now + minWindowMs;
  const extendedHoldTo = gatewayExpiresAt + CHECKOUT_GRACE_MS;
  // The original hold plus one minimum window (+1 min for clock skew between
  // the order's createdAt and its reservation timestamp).
  const ceiling =
    input.orderCreatedAt + input.holdMinutes * 60_000 + minWindowMs + CHECKOUT_GRACE_MS + 60_000;
  if (extendedHoldTo > ceiling) return null;
  return { gatewayExpiresAt, extendedHoldTo };
}

/** The customer's own ONLINE order, still awaiting payment — or the reason it cannot be paid. */
async function loadPayableOrder(userId: string, orderId: string): Promise<Order & { user: User }> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: { user: true },
  });

  if (!order)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });

  if (order.paymentMethod !== PaymentMethod.ONLINE) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This order is Cash on Delivery.",
    });
  }
  if (order.paymentStatus === OrderPaymentStatus.PAID) {
    throw new AppError(ErrorCode.PAYMENT_ALREADY_CAPTURED);
  }
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This order is no longer awaiting payment.",
    });
  }
  return order;
}

export async function createPayment(
  userId: string,
  orderId: string,
): Promise<CreatePaymentResult> {
  const order = await loadPayableOrder(userId, orderId);

  if (provider.fetchOrder) {
    // Checked again UNDER the lock: while this request waited, the order may
    // have been paid, cancelled or expired, and its hold may have changed.
    return withPaymentInitLock(order.id, async () =>
      createCheckoutSession(await loadPayableOrder(userId, orderId)),
    );
  }

  // Reuse an existing intent when the customer reopens the payment sheet —
  // creating a second provider order per tap would clutter reconciliation.
  const existing = await prisma.payment.findFirst({
    where: {
      orderId,
      status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
    },
    orderBy: { createdAt: "desc" },
  });

  // Reopening the payment sheet must return the SAME provider order, not mint
  // a new one. Creating a fresh intent per tap would leave orphaned provider
  // orders and make reconciliation ambiguous about which one the customer paid.
  let providerOrderId = existing?.providerOrderId ?? null;

  if (!providerOrderId) {
    // A new payment intent: refused while Online Payment is off.
    await assertNewOnlinePaymentAllowed();
    const intent = await provider.createIntent({
      orderId: order.id,
      orderNumber: order.orderNumber,
      // The amount ALWAYS comes from the order the server computed.
      amountPaise: order.totalPaise,
      currency: "INR",
      customer: {
        name: order.user.fullName,
        email: order.user.email,
        contact: order.deliveryMobile,
      },
    });
    providerOrderId = intent.providerOrderId;

    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: provider.name,
        providerOrderId,
        amountPaise: order.totalPaise,
        currency: "INR",
        status: PaymentStatus.CREATED,
      },
    });
  }

  const upiId = await configService.get(ConfigKey.ADIONE_UPI_ID);

  if (!upiId || !upiId.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "Merchant UPI ID is not configured.",
    });
  }

  // For direct UPI the "intent" is a deep link the phone hands to the
  // customer's UPI app. There is no gateway sheet and no callback.
  const upiIntentUrl = requiresManualPaymentConfirmation()
    ? buildUpiIntentUrl({
        vpa: upiId.trim(),
        payeeName: env.UPI_PAYEE_NAME,
        // Always the server's total, never a client figure.
        amountPaise: order.totalPaise,
        orderNumber: order.orderNumber,
      })
    : null;

  return {
    paymentId: existing?.id ?? providerOrderId,
    provider: provider.name,
    providerOrderId,

    // Kept for compatibility with the existing response contract.
    // It now represents the configured merchant UPI ID.
    publicKey: upiId.trim(),

    amountPaise: order.totalPaise,
    currency: "INR",

    prefill: {
      name: order.user.fullName,
      email: order.user.email,
      contact: order.deliveryMobile,
    },

    ...(upiIntentUrl
      ? {
          upiIntentUrl,
          upiVpa: upiId.trim(),
          requiresManualConfirmation: true,
        }
      : {}),
  };
}
/* -------------------------------------------------------------------------- */
/* Hosted checkout (Cashfree)                                                 */
/* -------------------------------------------------------------------------- */

function readCheckout(rawPayload: unknown): CheckoutSession | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const checkout = (rawPayload as { checkout?: Partial<CheckoutSession> }).checkout;
  if (!checkout?.paymentSessionId || !checkout.environment) return null;
  return {
    paymentSessionId: checkout.paymentSessionId,
    environment: checkout.environment,
    expiresAt: checkout.expiresAt ?? null,
  };
}

function checkoutResponse(
  order: Order & { user: User },
  paymentId: string,
  providerOrderId: string,
  session: CheckoutSession,
): CreatePaymentResult {
  return {
    paymentId,
    provider: provider.name,
    providerOrderId,
    // Nothing client-side needs a gateway key: the session id is enough.
    publicKey: "",
    amountPaise: order.totalPaise,
    currency: "INR",
    prefill: {
      name: order.user.fullName,
      email: order.user.email,
      contact: order.deliveryMobile,
    },
    cashfree: {
      paymentSessionId: session.paymentSessionId,
      orderId: providerOrderId,
      environment: session.environment,
    },
  };
}

/**
 * Opens (or reopens) the gateway checkout for an order awaiting payment.
 *
 * EXPIRY (see `planCheckoutExpiry`). The gateway order must stop taking money
 * BEFORE the AdiOne hold ends (by `CHECKOUT_GRACE_MS`), so the stock a payment
 * pays for is still held when it lands. The general hold stays 10 minutes
 * (PAYMENT_HOLD_MINUTES — COD, direct UPI and mock orders are unaffected), but
 * Cashfree only accepts an expiry more than 15 minutes away: opening a
 * Cashfree checkout therefore asks Cashfree for ~16 minutes and stretches THIS
 * order's hold to ~17 — once, before the Cashfree order exists, so the
 * gateway can never outlive the hold.
 */
/**
 * How long one initiation may hold the lock. The slowest path inside it makes
 * two gateway calls (fetchOrder, then createIntent), each aborted after 15 s
 * with no retry (cashfree.provider), plus a few database round trips — about
 * 35 s at worst. 60 s covers that with margin; a holder that dies frees the
 * order by itself after this.
 */
export const PAYMENT_INIT_LOCK_SECONDS = 60;
/**
 * How long a second request waits for the first. Kept well under the lock
 * lifetime AND under the app's 30 s timeout for this call, so a waiter that
 * then reuses the first request's checkout still answers in time; past it the
 * customer gets a clear "try again" instead of a hung request.
 */
export const PAYMENT_INIT_WAIT_MS = 10_000;
const PAYMENT_INIT_POLL_MS = 200;
const PAYMENT_INIT_RETRY_AFTER_SECONDS = 5;

/**
 * One payment initiation per ORDER at a time. Two "Pay" requests for the same
 * order at once (a double tap, a retry after a lost response, two devices)
 * would otherwise both find no open checkout and each open its OWN gateway
 * order — and the customer could pay both. The second request waits here for
 * the first, then finds and reuses the checkout it opened.
 *
 * A short-lived lock in the shared cache (Redis in production, so it holds
 * across instances), not a database transaction: the gateway call must never
 * hold a database connection or row lock (runInTransaction's rule).
 *
 *   - Owned: the lock holds a random token, and release is an atomic
 *     compare-and-delete — a holder that overran its lifetime can never remove
 *     the lock another request has since taken.
 *   - Fail closed: if the cache cannot be reached, no checkout is opened
 *     ("try again"), rather than risking two payable gateway orders. The
 *     duplicate-capture refund in settleCapture stays the last backstop.
 *
 * Exported for tests.
 */
export async function withPaymentInitLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const key = CacheKey.paymentInit(orderId);
  const token = randomUUID();
  const deadline = Date.now() + PAYMENT_INIT_WAIT_MS;
  try {
    while (!(await cache.setIfAbsent(key, token, PAYMENT_INIT_LOCK_SECONDS))) {
      if (Date.now() >= deadline) {
        throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
          message: "Your payment is still being prepared. Please try again in a moment.",
          internalMessage: `payment initiation lock busy for order ${orderId}`,
          retryAfterSeconds: PAYMENT_INIT_RETRY_AFTER_SECONDS,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, PAYMENT_INIT_POLL_MS));
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    log.warn({ err: error, orderId }, "payment initiation lock unavailable — checkout not opened");
    throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
      message: "We couldn't start the payment just now. Please try again in a moment.",
      internalMessage: `payment initiation lock unavailable for order ${orderId}`,
      retryAfterSeconds: PAYMENT_INIT_RETRY_AFTER_SECONDS,
    });
  }

  try {
    return await fn();
  } finally {
    const released = await cache.deleteIfEquals(key, token).catch((error: unknown) => {
      // The lock expires by itself; the result of the work stands.
      log.warn({ err: error, orderId }, "payment initiation lock could not be released");
      return null;
    });
    if (released === false) {
      log.warn({ orderId, lockSeconds: PAYMENT_INIT_LOCK_SECONDS }, "payment initiation outlived its lock");
    }
  }
}

/**
 * Starting a NEW online payment (a new gateway order / payment intent) needs
 * Online Payment switched on (Admin → Configuration → Payments). Everything
 * about a payment that already exists — reopening its still-valid checkout,
 * verifying it, webhooks, refreshing, reconciliation, refunds — is never
 * gated, so switching the method off cannot strand or double-charge a
 * customer who has already started paying.
 */
async function assertNewOnlinePaymentAllowed(): Promise<void> {
  const config = await configService.getMany([ConfigKey.PAYMENT_ONLINE_ENABLED, ConfigKey.PAYMENT_COD_ENABLED]);
  const block = paymentMethodBlock(PaymentMethod.ONLINE, {
    onlinePaymentEnabled: config.PAYMENT_ONLINE_ENABLED,
    codEnabled: config.PAYMENT_COD_ENABLED,
  });
  if (block) throw new AppError(block.code, { message: block.message });
}

async function createCheckoutSession(
  order: Order & { user: User },
): Promise<CreatePaymentResult> {
  const now = Date.now();
  const holdEndsAt = order.reservationExpiresAt?.getTime() ?? 0;
  if (holdEndsAt <= now) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "The time to pay for this order has run out. Please place the order again.",
    });
  }

  const open = await prisma.payment.findFirst({
    where: {
      orderId: order.id,
      provider: provider.name,
      providerOrderId: { not: null },
      status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
    },
    orderBy: { createdAt: "desc" },
  });

  // Reopening the sheet returns the SAME gateway order while it can still be
  // paid — a new order per tap would let one AdiOne order be paid twice.
  const openSession = open ? readCheckout(open.rawPayload) : null;
  if (
    open?.providerOrderId &&
    openSession &&
    (openSession.expiresAt === null ||
      Date.parse(openSession.expiresAt) - now > CHECKOUT_REUSE_MIN_MS)
  ) {
    return checkoutResponse(order, open.id, open.providerOrderId, openSession);
  }

  if (open?.providerOrderId) {
    // The old gateway order is (nearly) expired. Before replacing it, make
    // sure the customer has not in fact already paid it.
    const status = await provider.fetchOrder!(open.providerOrderId);
    if (status.captured) {
      await settleCapture({
        orderId: order.id,
        providerPaymentId: status.captured.providerPaymentId,
        providerOrderId: open.providerOrderId,
        amountPaise: status.captured.amountPaise,
        currency: status.captured.currency,
        gatewayOrderTag: status.adioneOrderId,
        method: status.captured.method,
        actorType: ActorType.SYSTEM,
        rawPayload: { verifiedBy: "fetchOrder", source: "create" },
      });
      throw new AppError(ErrorCode.PAYMENT_ALREADY_CAPTURED);
    }
    // Replacing it starts a new payment: refused while Online Payment is off
    // (the expired checkout is left as it is).
    await assertNewOnlinePaymentAllowed();
    await prisma.payment.updateMany({
      where: { id: open.id, status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] } },
      data: {
        status: PaymentStatus.FAILED,
        failureCode: "CHECKOUT_SUPERSEDED",
        failureReason: "The checkout expired and a new one was opened.",
      },
    });
  }

  // No reusable checkout: opening one is a new payment.
  await assertNewOnlinePaymentAllowed();

  const plan = planCheckoutExpiry({
    now,
    holdEndsAt,
    orderCreatedAt: order.createdAt.getTime(),
    holdMinutes: await configService.get(ConfigKey.PAYMENT_HOLD_MINUTES),
    gatewayMinWindowMs: provider.minCheckoutWindowMs ?? 0,
  });
  if (!plan) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "The time to pay for this order has run out. Please place the order again.",
      internalMessage: `checkout hold ceiling reached for order ${order.id}`,
    });
  }
  const gatewayExpiresAt = plan.gatewayExpiresAt;

  if (plan.extendedHoldTo !== null) {
    const extendedHold = plan.extendedHoldTo;
    // Only this order, only while it is still awaiting payment, only forward.
    // Stretched BEFORE the gateway order is created: if this fails, no
    // gateway order exists that could outlive the hold.
    const extended = await prisma.order.updateMany({
      where: {
        id: order.id,
        status: OrderStatus.PENDING_PAYMENT,
        reservationExpiresAt: { gt: new Date(), lt: new Date(extendedHold) },
      },
      data: { reservationExpiresAt: new Date(extendedHold) },
    });
    if (extended.count === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: "This order is no longer awaiting payment.",
      });
    }
    log.info(
      { orderId: order.id, reservationExpiresAt: new Date(extendedHold).toISOString() },
      "payment hold extended to fit the gateway's minimum checkout window",
    );
  }

  const intent = await provider.createIntent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    // The amount ALWAYS comes from the order the server computed.
    amountPaise: order.totalPaise,
    currency: "INR",
    customer: {
      id: order.userId,
      name: order.user.fullName,
      email: order.user.email,
      contact: order.deliveryMobile,
    },
    expiresAt: new Date(gatewayExpiresAt),
  });

  if (!intent.checkout) {
    throw new AppError(ErrorCode.PAYMENT_FAILED, {
      internalMessage: `${provider.name} returned no checkout session for order ${order.id}`,
    });
  }

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: provider.name,
      providerOrderId: intent.providerOrderId,
      amountPaise: order.totalPaise,
      currency: "INR",
      status: PaymentStatus.CREATED,
      // The session id pays for this one gateway order only; it is kept so
      // reopening the sheet reuses it rather than minting another order.
      rawPayload: { checkout: intent.checkout } as never,
    },
  });

  log.info(
    { orderId: order.id, paymentId: payment.id, providerOrderId: intent.providerOrderId },
    "gateway checkout opened",
  );

  return checkoutResponse(order, payment.id, intent.providerOrderId, intent.checkout);
}

/* -------------------------------------------------------------------------- */
/* UPI: the customer claims, the store confirms                               */
/* -------------------------------------------------------------------------- */

/**
 * Legacy/dev only. Refuses the manual UPI path whenever a real gateway settles
 * payments — with Cashfree the ONLY way an order becomes paid is server-side
 * verification with Cashfree, never a claim or an admin's say-so.
 */
async function assertManualPaymentPath(orderId: string): Promise<void> {
  const gatewayPayment = allowsManualPaymentConfirmation()
    ? await prisma.payment.findFirst({
        where: { orderId, provider: "cashfree" },
        select: { id: true },
      })
    : null;
  if (!allowsManualPaymentConfirmation() || gatewayPayment) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message:
        "Online payments are confirmed automatically by the payment gateway. Manual payment confirmation is not available.",
      internalMessage: `manual payment path refused for order ${orderId} (provider ${provider.name})`,
    });
  }
}

/**
 * Records the customer's claim that they have paid by UPI.
 *
 * THIS DOES NOT CONFIRM THE ORDER. Nothing here can verify that money moved —
 * accepting the claim would let anyone tap a button and receive goods. It
 * records the claim (with the UTR if given), extends the stock hold so a
 * genuine payment is not cancelled while the shop is busy, and puts the order
 * in front of the store to verify against its own UPI app.
 */
export async function claimUpiPayment(
  userId: string,
  input: { orderId: string; utr?: string | null },
): Promise<{ status: "AWAITING_CONFIRMATION" }> {
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, userId },
  });
  if (!order)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });

  if (order.paymentStatus === OrderPaymentStatus.PAID) {
    throw new AppError(ErrorCode.PAYMENT_ALREADY_CAPTURED);
  }
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This order is no longer awaiting payment.",
    });
  }

  // A claim also stretches the stock hold 4x — never available once a
  // gateway confirms payments by itself.
  await assertManualPaymentPath(order.id);

  const holdMinutes = await configService.get(ConfigKey.PAYMENT_HOLD_MINUTES);

  await runInTransaction(async (tx) => {
    await tx.payment.updateMany({
      where: {
        orderId: order.id,
        status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
      },
      data: {
        status: PaymentStatus.PENDING,
        method: "upi",
        // The UTR is the customer's receipt number. It is what the shopkeeper
        // matches against their UPI app — the whole point of asking for it.
        rawPayload: {
          claimedAt: new Date().toISOString(),
          utr: input.utr ?? null,
        } as never,
      },
    });

    // A manual check takes longer than an automatic one. Without this the
    // release job would cancel orders the customer genuinely paid for.
    await tx.order.update({
      where: { id: order.id },
      data: {
        reservationExpiresAt: new Date(Date.now() + holdMinutes * 4 * 60_000),
      },
    });
  });

  log.info(
    {
      orderId: order.id,
      orderNumber: order.orderNumber,
      utr: input.utr ?? null,
    },
    "customer claimed a UPI payment — awaiting store confirmation",
  );

  return { status: "AWAITING_CONFIRMATION" };
}

/**
 * The store confirms it can see the money in its UPI app.
 *
 * This is the verification step for direct UPI — a human looked at the bank
 * app. It is deliberately an ADMIN action: no customer input can reach it.
 */

export async function confirmPaymentManually(
  orderId: string,
  actorUserId: string,
  reference?: string | null,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: "Order not found.",
    });
  }

  if (order.paymentMethod !== PaymentMethod.ONLINE) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This order is not an online UPI order.",
    });
  }

  // Legacy direct-UPI / dev path only — never for a gateway-paid order.
  await assertManualPaymentPath(order.id);

  // Idempotent: already paid means there is nothing more to do.
  if (order.paymentStatus === OrderPaymentStatus.PAID) {
    return;
  }

  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This order is not awaiting payment.",
    });
  }

  if (!Number.isInteger(order.totalPaise) || order.totalPaise <= 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "Invalid order amount.",
    });
  }

  const payment = await prisma.payment.findFirst({
    where: {
      orderId: order.id,
      status: {
        in: [PaymentStatus.CREATED, PaymentStatus.PENDING],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  /*
   * The admin has independently checked the merchant UPI/bank account.
   * Only now is the payment marked captured.
   */
  await runInTransaction(async (tx) => {
    /*
     * Lock the order so two admin clicks cannot confirm it twice.
     */
    const [lockedOrder] = await tx.$queryRaw<
      { id: string; status: OrderStatus; payment_status: OrderPaymentStatus }[]
    >`
      SELECT
        id,
        status,
        payment_status
      FROM orders
      WHERE id = ${order.id}::uuid
      FOR UPDATE
    `;

    if (!lockedOrder) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: "Order not found.",
      });
    }

    if (lockedOrder.payment_status === OrderPaymentStatus.PAID) {
      return;
    }

    if (lockedOrder.status !== OrderStatus.PENDING_PAYMENT) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: "This order is not awaiting payment.",
      });
    }

    if (payment) {
      await tx.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          status: PaymentStatus.CAPTURED,
          providerPaymentId:
            reference?.trim() ||
            payment.providerPaymentId ||
            `manual_${order.orderNumber}`,
          method: "upi",
          capturedAt: new Date(),
          rawPayload: {
            ...(typeof payment.rawPayload === "object" &&
            payment.rawPayload !== null
              ? payment.rawPayload
              : {}),
            manuallyConfirmed: true,
            confirmedBy: actorUserId,
            confirmedAt: new Date().toISOString(),
            utr: reference?.trim() || null,
          } as never,
        },
      });
    } else {
      await tx.payment.create({
        data: {
          orderId: order.id,
          provider: "manual_upi",
          providerOrderId: null,
          providerPaymentId: reference?.trim() || `manual_${order.orderNumber}`,
          amountPaise: order.totalPaise,
          currency: "INR",
          status: PaymentStatus.CAPTURED,
          method: "upi",
          capturedAt: new Date(),
          rawPayload: {
            manuallyConfirmed: true,
            confirmedBy: actorUserId,
            confirmedAt: new Date().toISOString(),
            utr: reference?.trim() || null,
          } as never,
        },
      });
    }

    await tx.order.update({
      where: {
        id: order.id,
      },
      data: {
        paymentStatus: OrderPaymentStatus.PAID,
      },
    });
  });

  /*
   * Move the order through the normal payment-confirmation path.
   *
   * This:
   * - commits reserved stock
   * - changes PENDING_PAYMENT -> PAYMENT_CONFIRMED
   * - preserves the existing order state machine
   */
  await confirmPaymentAndPlace(order.id, ActorType.ADMIN);

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: "payment.confirm_manual",
      entityType: "Order",
      entityId: order.id,
      after: {
        reference: reference?.trim() || null,
        amountPaise: order.totalPaise,
        paymentMethod: order.paymentMethod,
      },
    },
  });

  log.info(
    {
      orderId: order.id,
      orderNumber: order.orderNumber,
      actorUserId,
      reference: reference ?? null,
      amountPaise: order.totalPaise,
    },
    "UPI payment manually confirmed by admin",
  );
}

/**
 * Admin manually rejects a direct UPI payment after checking the
 * merchant UPI/bank account and determining that the payment was not received.
 *
 * This is deliberately different from "Keep Pending":
 * - Keep Pending does nothing.
 * - This action explicitly marks the payment as failed.
 */
export async function rejectManualUpiPayment(
  orderId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const cleanReason = reason.trim();

  if (!cleanReason) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "A reason is required when marking payment as failed.",
    });
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: "Order not found.",
    });
  }

  if (order.paymentMethod !== PaymentMethod.ONLINE) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This order is not an online UPI order.",
    });
  }

  // Legacy direct-UPI / dev path only. A gateway order must never be failed
  // by hand: the customer may still complete (or have completed) the payment.
  await assertManualPaymentPath(order.id);

  /*
   * Idempotent: if it is already failed, there is nothing more to do.
   */
  if (order.status === OrderStatus.PAYMENT_FAILED) {
    return;
  }

  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This order is not awaiting payment.",
    });
  }

  await runInTransaction(async (tx) => {
    /*
     * Lock the order so two admin actions cannot race.
     */
    const [lockedOrder] = await tx.$queryRaw<
      { id: string; status: OrderStatus; payment_status: OrderPaymentStatus }[]
    >`
      SELECT
        id,
        status,
        payment_status
      FROM orders
      WHERE id = ${order.id}::uuid
      FOR UPDATE
    `;

    if (!lockedOrder) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: "Order not found.",
      });
    }

    if (lockedOrder.status === OrderStatus.PAYMENT_FAILED) {
      return;
    }

    if (lockedOrder.status !== OrderStatus.PENDING_PAYMENT) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: "This order is not awaiting payment.",
      });
    }

    /*
     * Mark any outstanding payment intent as failed.
     */
    await tx.payment.updateMany({
      where: {
        orderId: order.id,
        status: {
          in: [PaymentStatus.CREATED, PaymentStatus.PENDING],
        },
      },
      data: {
        status: PaymentStatus.FAILED,
        failureReason: cleanReason,
        rawPayload: {
          manuallyRejected: true,
          rejectedBy: actorUserId,
          rejectedAt: new Date().toISOString(),
          reason: cleanReason,
        } as never,
      },
    });
  });

  /*
   * Use the normal state-machine path so stock reservation cleanup
   * and other PAYMENT_FAILED side effects still happen.
   */
  await transitionOrder({
    orderId: order.id,
    toStatus: OrderStatus.PAYMENT_FAILED,
    actorType: ActorType.ADMIN,
    reason: cleanReason,
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: "payment.reject_manual",
      entityType: "Order",
      entityId: order.id,
      after: {
        reason: cleanReason,
        amountPaise: order.totalPaise,
        paymentMethod: order.paymentMethod,
      },
    },
  });

  log.info(
    {
      orderId: order.id,
      orderNumber: order.orderNumber,
      actorUserId,
      reason: cleanReason,
      amountPaise: order.totalPaise,
    },
    "UPI payment manually rejected by admin",
  );
}

/* -------------------------------------------------------------------------- */
/* The single convergent handler                                              */
/* -------------------------------------------------------------------------- */

interface SettlementInput {
  orderId: string;
  providerPaymentId: string;
  providerOrderId: string | null;
  amountPaise: number;
  method: string | null;
  actorType: ActorType;
  rawPayload?: unknown;
  /** The gateway's currency for the money taken, when it reports one. Only INR is applied. */
  currency?: string | null;
  /** The AdiOne order id the gateway order was tagged with at creation, when known. */
  gatewayOrderTag?: string | null;
}

/**
 * A capture whose amount differs from the order total is never applied —
 * but the customer may have been charged, so it must not live only in a log
 * line. Recorded once per provider payment (the webhook, the app's refresh
 * and reconciliation all re-arrive here) in the audit log, where the admin
 * activity view shows it. Never throws: the refusal itself must still happen.
 */
async function recordAmountMismatch(
  orderId: string,
  expectedPaise: number,
  input: SettlementInput,
  action: "payment.amount_mismatch" | "payment.reference_mismatch" = "payment.amount_mismatch",
): Promise<void> {
  try {
    const seen = await prisma.auditLog.findFirst({
      where: {
        action,
        entityId: orderId,
        after: { path: ["providerPaymentId"], equals: input.providerPaymentId },
      },
      select: { id: true },
    });
    if (seen) return;
    await prisma.auditLog.create({
      data: {
        actorUserId: null,
        action,
        entityType: "Order",
        entityId: orderId,
        after: {
          provider: provider.name,
          providerOrderId: input.providerOrderId,
          providerPaymentId: input.providerPaymentId,
          expectedPaise,
          capturedPaise: input.amountPaise,
          currency: input.currency ?? null,
          gatewayOrderTag: input.gatewayOrderTag ?? null,
          source: input.actorType,
        },
      },
    });
  } catch (error) {
    log.error({ err: error, orderId }, "could not record the payment amount mismatch");
  }
}

/**
 * Records a successful capture and advances the order.
 *
 * Idempotent by construction:
 *   - `UNIQUE (provider, provider_payment_id)` makes a second capture row
 *     impossible at the storage layer;
 *   - `transitionOrder` treats an already-applied transition as a no-op.
 *
 * Money that cannot pay for the order — it arrived after the order stopped
 * awaiting payment (the hold expired, the customer cancelled) or the order is
 * already paid by another payment — is an ORPHAN capture: recorded, NEVER
 * applied (an expired order is not revived and does not move to PROCESSING),
 * and refunded automatically. The apply-or-orphan decision is taken under the
 * order's row lock, so two captures racing for one order cannot both apply.
 */
async function settleCapture(input: SettlementInput): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: input.orderId },
  });

  // Reference cross-check. The gateway order carries the AdiOne order id it
  // was opened for (its tag); money taken on a gateway order opened for a
  // different order is never applied to this one.
  if (input.gatewayOrderTag && input.gatewayOrderTag !== order.id) {
    log.error(
      {
        orderId: order.id,
        gatewayOrderTag: input.gatewayOrderTag,
        providerOrderId: input.providerOrderId,
        providerPaymentId: input.providerPaymentId,
      },
      "PAYMENT REFERENCE MISMATCH — not confirming",
    );
    await recordAmountMismatch(order.id, order.totalPaise, input, "payment.reference_mismatch");
    // Whose money this is is unclear, so nothing is refunded automatically.
    await alertManualPaymentReview(
      order,
      input,
      `needs a MANUAL review — Cashfree order ${input.providerOrderId} is tagged for a different Aadione order`,
    );
    throw new AppError(ErrorCode.PAYMENT_VERIFICATION_FAILED, {
      internalMessage: `gateway order ${input.providerOrderId} is tagged for order ${input.gatewayOrderTag}, not ${order.id}`,
    });
  }

  // Currency cross-check. Money in any currency but INR is never applied, and
  // never auto-refunded either (the refund API takes the ORDER's currency, so
  // the amount would be wrong): an admin refunds it by hand.
  const currencyOk = input.currency === undefined || input.currency === null || input.currency === "INR";
  if (!currencyOk) {
    log.error(
      {
        orderId: order.id,
        expected: order.totalPaise,
        received: input.amountPaise,
        currency: input.currency ?? null,
        providerPaymentId: input.providerPaymentId,
      },
      "PAYMENT CURRENCY MISMATCH — not confirming, manual refund needed",
    );
    await recordAmountMismatch(order.id, order.totalPaise, input);
    await alertManualPaymentReview(order, input, `needs a MANUAL refund — the customer was charged in ${input.currency}, not INR`);
    throw new AppError(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
  }

  // Amount cross-check. A mismatch means the customer was charged something
  // other than the order total — never applied (the order is not paid, nothing
  // is fulfilled). The money is recorded as an orphan capture of the amount
  // ACTUALLY taken and refunded automatically below, through the same locked,
  // idempotent refund as a late or duplicate payment; the customer can pay the
  // correct amount on a fresh checkout.
  const amountMismatch = input.amountPaise !== order.totalPaise;
  if (amountMismatch) {
    log.error(
      {
        orderId: order.id,
        expected: order.totalPaise,
        received: input.amountPaise,
        providerPaymentId: input.providerPaymentId,
      },
      "PAYMENT AMOUNT MISMATCH — not confirming, refunding automatically",
    );
    await recordAmountMismatch(order.id, order.totalPaise, input);
  }

  const outcome = await runInTransaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      { status: OrderStatus; payment_status: OrderPaymentStatus }[]
    >`SELECT status, payment_status FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;
    if (!locked) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });
    }

    // This exact provider payment is already recorded — a replayed webhook,
    // or verify and webhook both arriving.
    const recorded = await tx.payment.findFirst({
      where: { provider: provider.name, providerPaymentId: input.providerPaymentId },
    });
    if (recorded && MONEY_TAKEN.includes(recorded.status)) {
      return {
        paymentId: recorded.id,
        orphanReason:
          recorded.failureCode === ORPHAN_CAPTURE
            ? (recorded.failureReason ?? "Payment could not be applied to the order.")
            : null,
        orderStatus: locked.status,
      };
    }

    const paidBy = await tx.payment.findFirst({
      where: {
        orderId: order.id,
        status: { in: MONEY_TAKEN },
        OR: [{ failureCode: null }, { failureCode: { not: ORPHAN_CAPTURE } }],
      },
      select: { id: true },
    });
    const alreadyPaid = Boolean(paidBy) || locked.payment_status === OrderPaymentStatus.PAID;
    const payable = !amountMismatch && locked.status === OrderStatus.PENDING_PAYMENT && !alreadyPaid;
    const orphanReason = payable
      ? null
      : amountMismatch
        ? `${AMOUNT_MISMATCH_REASON} — ${input.amountPaise} paise were charged, the order total is ${order.totalPaise}. Refunded automatically.`
        : alreadyPaid
          ? "Duplicate payment — the order was already paid. Refunded automatically."
          : `Payment arrived after the order became ${locked.status}. Refunded automatically.`;

    // The row this capture belongs to: the gateway order it was made
    // against, else the newest open intent. Never one that already holds
    // a different captured payment.
    let target =
      recorded ??
      (input.providerOrderId
        ? await tx.payment.findFirst({
            where: { provider: provider.name, providerOrderId: input.providerOrderId },
            orderBy: { createdAt: "desc" },
          })
        : null) ??
      (await tx.payment.findFirst({
        where: {
          orderId: order.id,
          status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
        },
        orderBy: { createdAt: "desc" },
      }));
    if (target && (target.orderId !== order.id || MONEY_TAKEN.includes(target.status))) {
      target = null;
    }

    const capture = {
      providerPaymentId: input.providerPaymentId,
      status: PaymentStatus.CAPTURED,
      method: input.method,
      capturedAt: new Date(),
      rawPayload: (input.rawPayload ?? null) as never,
      failureCode: payable ? null : ORPHAN_CAPTURE,
      failureReason: orphanReason,
      // What the gateway ACTUALLY took — equal to the order total except for an
      // amount mismatch, whose refund (refundOrphanCapture) must return exactly
      // this, not the total the intent was opened for.
      amountPaise: input.amountPaise,
    };

    const saved = target
      ? await tx.payment.update({
          where: { id: target.id },
          data: {
            ...capture,
            providerOrderId: input.providerOrderId ?? target.providerOrderId,
          },
        })
      : // A capture for a payment we never recorded an intent for — record
        // it rather than dropping the money on the floor.
        await tx.payment.create({
          data: {
            ...capture,
            orderId: order.id,
            provider: provider.name,
            providerOrderId: input.providerOrderId,
          },
        });

    if (payable) {
      // Keep the release job away while the order is placed below: expiring
      // a paid order would strand the customer's money.
      await tx.order.update({
        where: { id: order.id },
        data: { reservationExpiresAt: new Date(Date.now() + 10 * 60_000) },
      });
    }

    return { paymentId: saved.id, orphanReason, orderStatus: locked.status };
  });

  if (outcome.orphanReason) {
    log.warn(
      { orderId: order.id, paymentId: outcome.paymentId, orderStatus: outcome.orderStatus },
      "captured payment cannot be applied to its order — refunding automatically",
    );
    await refundOrphanCapture(outcome.paymentId, outcome.orphanReason);
    // The caller (the app's refresh, the webhook record, reconciliation) is
    // told the payment did not pay for the order.
    if (amountMismatch) throw amountMismatchError();
    return;
  }
  // Belt and braces: a mismatched capture can never reach placement.
  if (amountMismatch) throw amountMismatchError();

  if (outcome.orderStatus === OrderStatus.PENDING_PAYMENT) {
    // Commits the stock reservation and places the order, in one transaction.
    await confirmPaymentAndPlace(order.id, input.actorType);
  }
}

/**
 * Records one failed or abandoned gateway attempt WITHOUT failing the order:
 * the customer can retry until the AdiOne hold expires, and the release job
 * alone ends an unpaid order. Leaves the checkout session in place.
 */
async function recordAttemptFailure(
  paymentId: string,
  attempt: { status: string; reason: string | null },
  source: "webhook" | "refresh" | "reconcile",
): Promise<void> {
  await prisma.payment.updateMany({
    where: { id: paymentId, status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] } },
    data: {
      failureCode: attempt.status.slice(0, 80),
      failureReason: attempt.reason ? attempt.reason.slice(0, 300) : null,
    },
  });
  log.info(
    { paymentId, attemptStatus: attempt.status, source },
    "payment attempt failed — order stays PENDING_PAYMENT for a retry",
  );
}

/** Closes a gateway order that can no longer be paid (expired/terminated). */
async function closeDeadCheckout(paymentId: string, status: ProviderOrderStatus): Promise<void> {
  await prisma.payment.updateMany({
    where: { id: paymentId, status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] } },
    data: {
      status: PaymentStatus.FAILED,
      failureCode: `CHECKOUT_${status.orderStatus}`,
      failureReason: status.lastFailure?.reason?.slice(0, 300) ?? "The checkout ended without a payment.",
    },
  });
}

async function settleFailure(
  orderId: string,
  reason: string,
  actorType: ActorType,
): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
  });
  if (order.status !== OrderStatus.PENDING_PAYMENT) return;

  await prisma.payment.updateMany({
    where: {
      orderId,
      status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
    },
    data: { status: PaymentStatus.FAILED, failureReason: reason },
  });

  // Releases the stock reservation via the state machine's side effects.
  await transitionOrder({
    orderId,
    toStatus: OrderStatus.PAYMENT_FAILED,
    actorType,
    reason,
  });
}

/* -------------------------------------------------------------------------- */
/* Task 9.2 — verify (fast path)                                              */
/* -------------------------------------------------------------------------- */

export async function verifyPayment(
  userId: string,
  input: {
    orderId: string;
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  },
): Promise<VerifyPaymentResponse> {
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, userId },
  });
  if (!order)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });

  // Hosted checkout (Cashfree) returns no client signature: verification is
  // asking the gateway about the order, and an unpaid answer never fails it.
  if (provider.fetchOrder) {
    const refreshed = await refreshPayment(userId, order.id);
    return {
      verified: refreshed.paymentStatus === OrderPaymentStatus.PAID,
      orderStatus: refreshed.status,
      paymentStatus: refreshed.paymentStatus,
    };
  }

  // The client's word is a HINT. This asks the provider directly.
  const result = await provider.verify({
    providerOrderId: input.providerOrderId,
    providerPaymentId: input.providerPaymentId,
    signature: input.signature,
  });

  if (!result.verified) {
    log.warn(
      { orderId: order.id, reason: result.failureReason },
      "payment verification failed",
    );
    await settleFailure(
      order.id,
      result.failureReason ?? "verification failed",
      ActorType.SYSTEM,
    );
    throw new AppError(ErrorCode.PAYMENT_VERIFICATION_FAILED);
  }

  await settleCapture({
    orderId: order.id,
    providerPaymentId: input.providerPaymentId,
    providerOrderId: input.providerOrderId,
    amountPaise: result.amountPaise,
    method: result.method,
    actorType: ActorType.SYSTEM,
  });

  const updated = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
  });
  return {
    verified: true,
    orderStatus: updated.status,
    paymentStatus: updated.paymentStatus,
  };
}

/* -------------------------------------------------------------------------- */
/* Task 9.2 — webhook (truth path)                                            */
/* -------------------------------------------------------------------------- */

export async function handleWebhook(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): Promise<{ received: true }> {
  let event: WebhookEvent;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch (error) {
    throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, {
      internalMessage: `unparseable webhook: ${String(error)}`,
    });
  }

  if (!event.signatureValid) {
    log.error({ eventId: event.eventId }, "webhook signature invalid");
    throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID);
  }

  // Replay guard. Providers retry aggressively; the unique index turns every
  // retry into a cheap no-op instead of a double-settlement.
  const existing = await prisma.paymentEvent.findUnique({
    where: {
      provider_eventId: { provider: provider.name, eventId: event.eventId },
    },
  });
  if (existing?.processedAt) {
    log.info(
      { eventId: event.eventId },
      "webhook already processed — ignoring replay",
    );
    return { received: true };
  }

  const record = await prisma.paymentEvent.upsert({
    where: {
      provider_eventId: { provider: provider.name, eventId: event.eventId },
    },
    create: {
      provider: provider.name,
      eventId: event.eventId,
      eventType: event.type,
      signatureValid: true,
      payload: event.payload as never,
    },
    update: {},
  });

  try {
    const payment = event.providerOrderId
      ? await prisma.payment.findFirst({
          where: {
            provider: provider.name,
            providerOrderId: event.providerOrderId,
          },
        })
      : null;

    if (!payment) {
      log.warn(
        { eventId: event.eventId },
        "webhook for an unknown payment — recorded only",
      );
    } else if (event.status === "CAPTURED" && event.providerPaymentId && provider.fetchOrder) {
      // Even a correctly signed webhook is only a notice: settle on the
      // gateway's own answer about the order, amount included.
      const status = await provider.fetchOrder(payment.providerOrderId ?? event.providerOrderId!);
      if (!status.captured) {
        throw new AppError(ErrorCode.PAYMENT_VERIFICATION_FAILED, {
          internalMessage: `webhook reported a capture but ${provider.name} order ${status.providerOrderId} is ${status.orderStatus}`,
        });
      }
      await settleCapture({
        orderId: payment.orderId,
        providerPaymentId: status.captured.providerPaymentId,
        providerOrderId: status.providerOrderId,
        amountPaise: status.captured.amountPaise,
        currency: status.captured.currency,
        gatewayOrderTag: status.adioneOrderId,
        method: status.captured.method,
        actorType: ActorType.PAYMENT_WEBHOOK,
        rawPayload: event.payload,
      });
    } else if (event.status === "CAPTURED" && event.providerPaymentId) {
      await settleCapture({
        orderId: payment.orderId,
        providerPaymentId: event.providerPaymentId,
        providerOrderId: event.providerOrderId,
        amountPaise: event.amountPaise ?? payment.amountPaise,
        method: null,
        actorType: ActorType.PAYMENT_WEBHOOK,
        rawPayload: event.payload,
      });
    } else if (event.status === "ATTEMPT_FAILED") {
      // One failed/abandoned attempt — NOT the order's end (see
      // recordAttemptFailure).
      await recordAttemptFailure(
        payment.id,
        { status: event.type.replace(/_WEBHOOK$/, ""), reason: event.failureReason ?? null },
        "webhook",
      );
    } else if (event.status === "REFUND_UPDATE" && event.refund) {
      await handleRefundEvent(event.refund);
    } else if (event.status === "FAILED") {
      await settleFailure(
        payment.orderId,
        "payment failed at gateway",
        ActorType.PAYMENT_WEBHOOK,
      );
    }

    await prisma.paymentEvent.update({
      where: { id: record.id },
      data: { processedAt: new Date() },
    });
  } catch (error) {
    // Record the failure and return 200 anyway: a 500 makes the provider retry
    // forever, and the reconciliation job will pick this up regardless.
    //
    // The stable error CODE is stored, not just the prose message — this row
    // is what someone triages an unsettled payment from, and grepping for
    // PAYMENT_AMOUNT_MISMATCH must work.
    const reason = AppError.is(error)
      ? `${error.code}: ${error.internalMessage ?? error.message}`
      : String(error);

    await prisma.paymentEvent.update({
      where: { id: record.id },
      data: { error: reason.slice(0, 500) },
    });
    log.error(
      { err: error, eventId: event.eventId },
      "webhook processing failed",
    );
  }

  return { received: true };
}

/* -------------------------------------------------------------------------- */
/* Task 9.3 — refunds                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Refund bookkeeping shared by the whole-order and the per-SellerOrder paths.
 *
 * INVARIANTS (both paths):
 *   - A Refund row is RESERVED before the provider is called, inside a
 *     transaction holding the captured Payment's row lock, after re-checking
 *     for an existing live (PENDING/PROCESSING/COMPLETED) refund — so two
 *     concurrent attempts can never both reserve, and the sum of live refunds
 *     can never exceed what was captured.
 *   - A row is marked FAILED ONLY when the provider call itself failed. If
 *     the provider refunded but recording its answer failed, the row stays
 *     PENDING: a live row keeps blocking any second refund of the same money,
 *     whereas FAILED would re-open it.
 *   - Order.paymentStatus is recomputed from the COMPLETED refunds actually
 *     recorded against the payment (under the same lock), never set blindly:
 *     PAID -> PARTIALLY_REFUNDED -> REFUNDED only once everything captured
 *     has been returned.
 */
const LIVE_REFUND_STATUSES = [
  RefundStatus.PENDING,
  RefundStatus.PROCESSING,
  RefundStatus.COMPLETED,
];

/**
 * The audit row for a refund reservation, written in the SAME transaction as
 * the Refund row: every refund that can move money names who triggered it
 * (null = the system) and exactly which payment, portion and amount.
 */
async function auditRefundReservation(
  tx: Tx,
  entry: {
    action: string;
    actorUserId: string | null;
    orderId: string;
    refundId: string;
    paymentId: string;
    sellerOrderId: string | null;
    amountPaise: number;
    reason: string;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: "Order",
      entityId: entry.orderId,
      after: {
        refundId: entry.refundId,
        paymentId: entry.paymentId,
        sellerOrderId: entry.sellerOrderId,
        amountPaise: entry.amountPaise,
        reason: entry.reason,
      },
    },
  });
}

/** The payment that paid for the order — never an orphan capture. */
async function lockCapturedPayment(tx: Tx, orderId: string) {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments
    WHERE order_id = ${orderId}::uuid AND status = 'CAPTURED'
      AND (failure_code IS NULL OR failure_code <> ${ORPHAN_CAPTURE})
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE`;
  return locked ? tx.payment.findUniqueOrThrow({ where: { id: locked.id } }) : null;
}

async function liveRefundedPaise(tx: Tx, paymentId: string): Promise<number> {
  const agg = await tx.refund.aggregate({
    where: { paymentId, status: { in: LIVE_REFUND_STATUSES } },
    _sum: { amountPaise: true },
  });
  return agg._sum.amountPaise ?? 0;
}

/** Re-derives Payment/Order refund state from COMPLETED refunds. Caller holds the payment lock. */
async function syncRefundState(tx: Tx, orderId: string, paymentId: string): Promise<OrderPaymentStatus> {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const agg = await tx.refund.aggregate({
    where: { paymentId, status: RefundStatus.COMPLETED },
    _sum: { amountPaise: true },
  });
  const completed = agg._sum.amountPaise ?? 0;
  if (completed <= 0) return OrderPaymentStatus.PAID;

  const fully = completed >= payment.amountPaise;
  if (fully) {
    await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.REFUNDED } });
  }
  // A partially refunded Payment stays CAPTURED on purpose: every refund
  // path looks up "the captured payment" to refund the next portion from.
  const paymentStatus = fully ? OrderPaymentStatus.REFUNDED : OrderPaymentStatus.PARTIALLY_REFUNDED;
  await tx.order.update({ where: { id: orderId }, data: { paymentStatus } });
  return paymentStatus;
}

interface ReservedRefund {
  refundId: string;
  orderId: string;
  paymentId: string;
  providerPaymentId: string;
  providerOrderId: string | null;
  amountPaise: number;
}

/**
 * Records a provider's answer for one refund, under the payment's lock.
 * Terminal refunds (COMPLETED/FAILED) never move again, so a stale or replayed
 * refund webhook cannot undo a recorded outcome. An orphan capture's refund
 * moves only its own payment row — the order never used that money.
 */
async function applyRefundResult(
  refundId: string,
  result: RefundResult,
): Promise<{ changed: boolean; orderPaymentStatus: OrderPaymentStatus | null }> {
  return runInTransaction(async (tx) => {
    const { paymentId, orderId } = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
      select: { paymentId: true, orderId: true },
    });
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (current.status === RefundStatus.COMPLETED || current.status === RefundStatus.FAILED) {
      return { changed: false, orderPaymentStatus: null };
    }
    if (current.status === result.status && current.providerRefundId === result.providerRefundId) {
      return { changed: false, orderPaymentStatus: null };
    }

    await tx.refund.update({
      where: { id: refundId },
      data: {
        providerRefundId: result.providerRefundId,
        status: result.status as RefundStatus,
        ...(result.status === "COMPLETED" ? { completedAt: new Date() } : {}),
        ...(result.status === "FAILED" ? { failureReason: "Provider reported the refund as failed." } : {}),
      },
    });

    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.failureCode === ORPHAN_CAPTURE) {
      const done = await tx.refund.aggregate({
        where: { paymentId, status: RefundStatus.COMPLETED },
        _sum: { amountPaise: true },
      });
      if ((done._sum.amountPaise ?? 0) >= payment.amountPaise) {
        await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.REFUNDED } });
      }
      return { changed: true, orderPaymentStatus: null };
    }
    return { changed: true, orderPaymentStatus: await syncRefundState(tx, orderId, paymentId) };
  });
}

/**
 * True only when the provider definitively REFUSED a refund call, i.e. no
 * refund exists. Anything else — unreachable, timed out, 5xx, rate-limited —
 * says nothing about whether the provider acted, so it is not a failure.
 * A provider that cannot re-read refunds can never resolve an unknown outcome,
 * so for it every error stays a failure (the previous behaviour).
 */
function isDefinitiveRefundRejection(error: unknown): boolean {
  if (!provider.getRefund) return true;
  if (error instanceof CashfreeApiError) {
    const status = error.httpStatus;
    return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
  }
  // Refused before any call was made (missing provider ids, and the like).
  return AppError.is(error) && error.code === ErrorCode.REFUND_FAILED;
}

/** How long an unknown refund must have existed before "not found" at the provider is believed. */
const UNKNOWN_REFUND_GRACE_MS = 10 * 60_000;

/**
 * The provider has no record of a refund we reserved long ago: its call never
 * reached the provider. Only now is it FAILED — and so open to a retry.
 */
async function failRefundUnknownToProvider(refundId: string): Promise<void> {
  const failed = await runInTransaction(async (tx) => {
    const { paymentId } = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { paymentId: true } });
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const changed = await tx.refund.updateMany({
      where: { id: refundId, status: { in: [RefundStatus.PENDING, RefundStatus.PROCESSING] } },
      data: { status: RefundStatus.FAILED, failureReason: "The payment provider has no record of this refund." },
    });
    return changed.count > 0;
  });
  if (!failed) return;
  log.warn({ refundId }, "refund unknown to the provider after the grace period — marked FAILED");
  await announceRefund(refundId, "FAILED");
}

/**
 * Calls the provider for an already-reserved Refund row and records the
 * outcome. Returns the final refund status, or throws only when the provider
 * itself refused (the row is then FAILED). An unknown outcome (see
 * `isDefinitiveRefundRejection`) returns PENDING.
 */
async function executeReservedRefund(
  reserved: ReservedRefund,
  reason: string,
): Promise<{ status: RefundStatus; orderPaymentStatus: OrderPaymentStatus | null }> {
  let result: Awaited<ReturnType<typeof provider.refund>>;
  try {
    result = await provider.refund({
      providerPaymentId: reserved.providerPaymentId,
      providerOrderId: reserved.providerOrderId,
      // Our row id doubles as the provider's idempotency key (Cashfree's
      // refund_id): a retried call can never refund twice.
      refundId: reserved.refundId,
      amountPaise: reserved.amountPaise,
      reason,
    });
  } catch (error) {
    if (!isDefinitiveRefundRejection(error)) {
      // A timeout, a dropped connection or a 5xx: the provider may well have
      // refunded. FAILED would re-open this money for a second refund (the
      // remainder refund, an admin retry) while the gateway already paid it
      // out. The row stays PENDING — still blocking any second refund — and
      // reconciliation re-reads it from the provider by this same id.
      log.error(
        { err: error, refundId: reserved.refundId, orderId: reserved.orderId },
        "refund outcome unknown — left PENDING for reconciliation, do NOT re-refund",
      );
      return { status: RefundStatus.PENDING, orderPaymentStatus: null };
    }
    await prisma.refund.update({
      where: { id: reserved.refundId },
      data: { status: RefundStatus.FAILED, failureReason: String(error).slice(0, 300) },
    });
    await announceRefund(reserved.refundId, "FAILED");
    throw error;
  }

  try {
    const { orderPaymentStatus } = await applyRefundResult(reserved.refundId, result);
    await announceRefund(reserved.refundId, result.status);
    return { status: result.status as RefundStatus, orderPaymentStatus };
  } catch (error) {
    // The provider HAS moved the money. Leave the row PENDING so it keeps
    // blocking a duplicate refund; reconciliation must record the outcome.
    log.error(
      { err: error, refundId: reserved.refundId, providerRefundId: result.providerRefundId, orderId: reserved.orderId },
      "provider refunded but the result could not be recorded — reconcile manually, do NOT re-refund",
    );
    await announceRefund(reserved.refundId, "RECONCILE");
    return { status: RefundStatus.PENDING, orderPaymentStatus: null };
  }
}

/**
 * Announces a refund outcome — AFTER it is recorded, never affecting it.
 * Keyed by the refund id, so a retried refund path cannot notify twice.
 *   COMPLETED            -> customer; plus the seller whose portion it was
 *   PENDING/PROCESSING   -> customer ("refund started")
 *   FAILED / RECONCILE   -> admins who can act on refunds (ORDER_REFUND)
 */
async function announceRefund(
  refundId: string,
  outcome: "COMPLETED" | "PENDING" | "PROCESSING" | "FAILED" | "RECONCILE",
): Promise<void> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: {
      amountPaise: true,
      sellerOrderId: true,
      sellerOrder: { select: { sellerId: true } },
      order: { select: { id: true, userId: true, orderNumber: true } },
    },
  });
  if (!refund) return;
  const context = { orderNumber: refund.order.orderNumber, amountPaise: refund.amountPaise };

  if (outcome === "COMPLETED" || outcome === "PENDING" || outcome === "PROCESSING") {
    const completed = outcome === "COMPLETED";
    await notificationService.notify({
      userId: refund.order.userId,
      type: completed ? NotificationType.REFUND_COMPLETED : NotificationType.REFUND_INITIATED,
      dedupeKey: `refund:${refundId}:${completed ? "COMPLETED" : "INITIATED"}`,
      orderId: refund.order.id,
      context,
    });
    if (completed && refund.sellerOrder) {
      await notificationService.notifySeller(refund.sellerOrder.sellerId, {
        type: NotificationType.SELLER_REFUND_ISSUED,
        dedupeKey: `refund:${refundId}:seller`,
        orderId: refund.order.id,
        context,
      });
    }
    return;
  }

  await notificationService.notifyAdmins(Permission.ORDER_REFUND, {
    type: NotificationType.ADMIN_REFUND_FAILED,
    dedupeKey: `refund:${refundId}:${outcome}`,
    orderId: refund.order.id,
    context: {
      ...context,
      reason: outcome === "RECONCILE" ? "was refunded by the provider but could not be recorded" : "failed at the provider",
    },
  });
}

/**
 * Full-order refund (admin action, and the auto-refund for an order cancelled
 * as a whole). Only for an order whose state machine allows REFUNDED — i.e.
 * a cancelled order. A DELIVERED order is refused BEFORE any money moves:
 * previously the refund went out and only the follow-up transition was
 * refused, leaving a DELIVERED/PAID order whose money was gone and whose
 * seller would still be settled for it. V2 has no post-delivery
 * return/clawback flow; see seller-settlement.service.ts.
 */
export async function refundOrder(
  orderId: string,
  reason: string,
  actorUserId: string | null,
): Promise<{ refundId: string; status: RefundStatus }> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
  });

  if (order.paymentMethod === PaymentMethod.COD) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message:
        "Cash on Delivery orders are settled in cash — no online refund is possible.",
    });
  }
  if (!canTransition(order.status, OrderStatus.REFUNDED)) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message:
        order.status === OrderStatus.DELIVERED
          ? "A delivered order cannot be fully refunded — there is no post-delivery return flow yet."
          : `Only a cancelled order can be fully refunded (this order is ${order.status}). Cancel it instead — each seller's portion is refunded automatically.`,
      internalMessage: `refundOrder refused before any money moved: ${order.status} -> REFUNDED is not a legal transition`,
    });
  }
  if (order.paymentStatus !== OrderPaymentStatus.PAID) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message:
        order.paymentStatus === OrderPaymentStatus.PARTIALLY_REFUNDED ||
        order.paymentStatus === OrderPaymentStatus.REFUNDED
          ? "This order has already been refunded (fully or per seller)."
          : "This order has not been paid, so there is nothing to refund.",
    });
  }

  const reservation = await runInTransaction(async (tx) => {
    const payment = await lockCapturedPayment(tx, orderId);
    if (!payment?.providerPaymentId) {
      throw new AppError(ErrorCode.REFUND_FAILED, {
        internalMessage: `no captured payment for order ${orderId}`,
      });
    }
    const existing = await tx.refund.findFirst({
      where: { orderId, status: { in: LIVE_REFUND_STATUSES } },
    });
    if (existing) return { existing };

    const amountPaise = Math.min(order.totalPaise, payment.amountPaise - (await liveRefundedPaise(tx, payment.id)));
    if (amountPaise <= 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: "Nothing is left to refund on this order.",
      });
    }
    const refund = await tx.refund.create({
      data: { paymentId: payment.id, orderId, amountPaise, status: RefundStatus.PENDING, reason },
    });
    // Who moved the money, recorded with the reservation itself. Null for
    // the automatic refund of a cancelled paid order (refundIfPaid).
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: actorUserId ? "payment.refund" : "payment.refund_auto",
        entityType: "Order",
        entityId: orderId,
        after: {
          refundId: refund.id,
          paymentId: payment.id,
          amountPaise,
          reason,
        },
      },
    });
    return {
      reserved: {
        refundId: refund.id,
        orderId,
        paymentId: payment.id,
        providerPaymentId: payment.providerPaymentId,
        providerOrderId: payment.providerOrderId,
        amountPaise,
      } satisfies ReservedRefund,
    };
  });

  if ("existing" in reservation && reservation.existing) {
    return { refundId: reservation.existing.id, status: reservation.existing.status };
  }
  const reserved = (reservation as { reserved: ReservedRefund }).reserved;

  try {
    const outcome = await executeReservedRefund(reserved, reason);
    if (outcome.orderPaymentStatus === OrderPaymentStatus.REFUNDED) {
      await transitionOrder({
        orderId,
        toStatus: OrderStatus.REFUNDED,
        actorType: ActorType.SYSTEM,
        actorUserId,
        reason,
      }).catch((error) =>
        log.warn({ err: error, orderId }, "refund transition skipped"),
      );
    }
    log.info(
      { orderId, refundId: reserved.refundId, amountPaise: reserved.amountPaise, status: outcome.status },
      "refund issued",
    );
    return { refundId: reserved.refundId, status: outcome.status };
  } catch (error) {
    log.error({ err: error, orderId }, "refund failed — needs manual action");
    throw new AppError(ErrorCode.REFUND_FAILED);
  }
}

/** Auto-refund on cancellation or rejection of a paid order. */
export async function refundIfPaid(
  orderId: string,
  reason: string,
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  if (order.paymentMethod !== PaymentMethod.ONLINE) return;
  if (order.paymentStatus !== OrderPaymentStatus.PAID) return;

  // No acting admin: this is the system's automatic refund, not the customer's.
  await refundOrder(orderId, reason, null).catch((error) =>
    log.error(
      { err: error, orderId },
      "auto-refund failed — needs manual action",
    ),
  );
}

/** Once the parcel has left the shop the order is being fulfilled, not cancelled. */
const FULFILMENT_STARTED: readonly OrderStatus[] = [
  OrderStatus.PICKED_UP,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

export interface FinalOrderRefundInput {
  paymentMethod: string;
  orderStatus: OrderStatus;
  sellerOrderStatuses: readonly SellerOrderStatus[];
  /** The captured payment's amount. */
  capturedPaise: number;
  /** Sum of LIVE (PENDING/PROCESSING/COMPLETED) refunds against that payment. */
  liveRefundedPaise: number;
  /** A live refund with no seller order (a whole-order refund) already exists. */
  hasLiveOrderLevelRefund: boolean;
}

/**
 * Approved policy (2026-09-30): once EVERY seller portion of a paid online
 * order is cancelled or rejected, nothing will be delivered, so everything
 * still captured goes back — including the delivery and platform fees that no
 * seller portion covers. Returns that remaining amount, or 0 when no final
 * refund is due. A partial cancellation (another portion still active) is
 * always 0: those fees still pay for a delivery.
 *
 * Never more than what remains captured after every live refund, so it can
 * never refund the same money twice.
 */
export function finalOrderRefundPaise(input: FinalOrderRefundInput): number {
  if (input.paymentMethod !== PaymentMethod.ONLINE) return 0;
  if (FULFILMENT_STARTED.includes(input.orderStatus)) return 0;
  if (input.sellerOrderStatuses.length === 0) return 0;
  const allCancelled = input.sellerOrderStatuses.every(
    (status) => status === SellerOrderStatus.CANCELLED || status === SellerOrderStatus.REJECTED,
  );
  if (!allCancelled || input.hasLiveOrderLevelRefund) return 0;
  return Math.max(0, input.capturedPaise - input.liveRefundedPaise);
}

const FINAL_REFUND_REASON =
  "Every seller portion was cancelled — refunding the remaining amount (delivery/platform fees).";

/**
 * Issues the final order-level refund of `finalOrderRefundPaise` — through
 * the same reserve-under-lock -> provider -> record path as every other
 * refund, so its idempotency guarantees are the existing ones: the captured
 * payment is locked while the amount is computed and the Refund row reserved,
 * and a retry finds either a live order-level refund or nothing left
 * captured. A refund the provider REFUSED (FAILED) is not live, so a later
 * call may try again. The order moves to REFUNDED only once the money is
 * actually back (executeReservedRefund -> syncRefundState), via the normal
 * SYSTEM transition — or later, when an asynchronous refund completes.
 */
async function refundRemainderIfAllSellerOrdersCancelled(
  orderId: string,
  actorUserId: string | null,
): Promise<void> {
  const reserved = await runInTransaction(async (tx): Promise<ReservedRefund | null> => {
    const payment = await lockCapturedPayment(tx, orderId);
    if (!payment?.providerPaymentId) return null;

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paymentMethod: true, status: true, sellerOrders: { select: { status: true } } },
    });
    const orderLevelRefund = await tx.refund.findFirst({
      where: { paymentId: payment.id, sellerOrderId: null, status: { in: LIVE_REFUND_STATUSES } },
      select: { id: true },
    });
    const amountPaise = finalOrderRefundPaise({
      paymentMethod: order.paymentMethod,
      orderStatus: order.status,
      sellerOrderStatuses: order.sellerOrders.map((so) => so.status),
      capturedPaise: payment.amountPaise,
      liveRefundedPaise: await liveRefundedPaise(tx, payment.id),
      hasLiveOrderLevelRefund: orderLevelRefund !== null,
    });
    if (amountPaise <= 0) return null;

    const refund = await tx.refund.create({
      data: { paymentId: payment.id, orderId, amountPaise, status: RefundStatus.PENDING, reason: FINAL_REFUND_REASON },
    });
    await auditRefundReservation(tx, {
      action: "payment.refund_remainder",
      actorUserId,
      orderId,
      refundId: refund.id,
      paymentId: payment.id,
      sellerOrderId: null,
      amountPaise,
      reason: FINAL_REFUND_REASON,
    });
    return {
      refundId: refund.id,
      orderId,
      paymentId: payment.id,
      providerPaymentId: payment.providerPaymentId,
      providerOrderId: payment.providerOrderId,
      amountPaise,
    };
  });
  if (!reserved) return;

  try {
    const outcome = await executeReservedRefund(reserved, FINAL_REFUND_REASON);
    if (outcome.orderPaymentStatus === OrderPaymentStatus.REFUNDED) {
      await transitionOrder({
        orderId,
        toStatus: OrderStatus.REFUNDED,
        actorType: ActorType.SYSTEM,
        reason: FINAL_REFUND_REASON,
      }).catch((error) => log.warn({ err: error, orderId }, "refund transition skipped"));
    }
    log.info(
      { orderId, refundId: reserved.refundId, amountPaise: reserved.amountPaise, status: outcome.status },
      "final order-level refund issued — every seller portion cancelled",
    );
  } catch (error) {
    // executeReservedRefund already marked the row FAILED and told the admins.
    log.error({ err: error, orderId }, "final order-level refund failed — needs manual action");
  }
}

/**
 * Partial refund for ONE cancelled/rejected SellerOrder (#10/#19) — exactly
 * what the customer PAID for that seller's portion: its tax-inclusive
 * subtotal minus its share of the Aadione-funded coupon (coupon-allocation.ts),
 * the same figure `order-state.service.ts` decremented from
 * `currentPayablePaise` when the SellerOrder was cancelled. A coupon is never
 * refunded as cash: the customer never paid it. Never touches any other
 * seller's portion or its coupon share.
 *
 * Runs whenever the order's money is still (at least partly) held: PAID, or
 * PARTIALLY_REFUNDED because an EARLIER sibling portion was already refunded
 * — that sibling's refund is exactly why this portion is still owed. Each
 * SellerOrder is refunded at most once (live-refund check under the payment
 * lock), and never beyond what remains captured. Delivery/platform fees are
 * not part of any seller portion: they come back only when THIS was the last
 * active portion (see `refundRemainderIfAllSellerOrdersCancelled`).
 *
 * Called once per actual CANCELLED/REJECTED transition (a repeated cancel is
 * a no-op transition and dispatches nothing).
 */
export async function refundSellerOrderIfPaid(
  sellerOrderId: string,
  reason: string,
  // Whoever cancelled or rejected the portion (customer, seller staff, admin); null for the system.
  actorUserId: string | null = null,
): Promise<void> {
  const sellerOrder = await prisma.sellerOrder.findUnique({
    where: { id: sellerOrderId },
    include: { order: true },
  });
  if (!sellerOrder) return;
  const { order } = sellerOrder;
  if (order.paymentMethod !== PaymentMethod.ONLINE) return;
  if (
    order.paymentStatus !== OrderPaymentStatus.PAID &&
    order.paymentStatus !== OrderPaymentStatus.PARTIALLY_REFUNDED
  ) {
    return;
  }
  if (sellerOrder.status !== SellerOrderStatus.CANCELLED && sellerOrder.status !== SellerOrderStatus.REJECTED) return;
  const paidForPortion = customerPaidPaise(sellerOrder.subtotalPaise, sellerOrder.couponDiscountPaise);

  // A portion the coupon paid for entirely took no money — nothing to refund
  // for it, though the remaining fees may still be due below.
  const reserved = paidForPortion <= 0 ? null : await runInTransaction(async (tx): Promise<ReservedRefund | null> => {
    const payment = await lockCapturedPayment(tx, order.id);
    if (!payment?.providerPaymentId) {
      log.error({ orderId: order.id, sellerOrderId }, "cannot issue partial refund — no captured payment found");
      return null;
    }
    const existing = await tx.refund.findFirst({
      where: { sellerOrderId, status: { in: LIVE_REFUND_STATUSES } },
    });
    if (existing) return null;

    const remaining = payment.amountPaise - (await liveRefundedPaise(tx, payment.id));
    const amountPaise = Math.min(paidForPortion, remaining);
    if (amountPaise <= 0) {
      log.error(
        { orderId: order.id, sellerOrderId, remaining },
        "partial refund skipped — nothing left captured on this payment",
      );
      return null;
    }
    if (amountPaise < paidForPortion) {
      log.warn(
        { orderId: order.id, sellerOrderId, paidForPortion, amountPaise },
        "partial refund capped at the amount still captured",
      );
    }
    const refund = await tx.refund.create({
      data: {
        paymentId: payment.id,
        orderId: order.id,
        sellerOrderId,
        amountPaise,
        status: RefundStatus.PENDING,
        reason,
      },
    });
    await auditRefundReservation(tx, {
      action: "payment.refund_seller_portion",
      actorUserId,
      orderId: order.id,
      refundId: refund.id,
      paymentId: payment.id,
      sellerOrderId,
      amountPaise,
      reason,
    });
    return {
      refundId: refund.id,
      orderId: order.id,
      paymentId: payment.id,
      providerPaymentId: payment.providerPaymentId,
      providerOrderId: payment.providerOrderId,
      amountPaise,
    };
  });
  if (reserved) {
    try {
      const outcome = await executeReservedRefund(reserved, reason);
      if (outcome.orderPaymentStatus === OrderPaymentStatus.REFUNDED) {
        // Everything captured is back (no fees were charged) — a fully
        // cancelled order can now rest at REFUNDED, same as refundOrder.
        await transitionOrder({
          orderId: order.id,
          toStatus: OrderStatus.REFUNDED,
          actorType: ActorType.SYSTEM,
          reason,
        }).catch((error) => log.warn({ err: error, orderId: order.id }, "refund transition skipped"));
      }
      log.info(
        { orderId: order.id, sellerOrderId, refundId: reserved.refundId, amountPaise: reserved.amountPaise, status: outcome.status },
        "partial (seller-order) refund issued",
      );
    } catch (error) {
      log.error(
        { err: error, orderId: order.id, sellerOrderId },
        "partial refund failed — needs manual action",
      );
    }
  }

  // If that was the LAST active portion, whatever is still captured (the
  // delivery/platform fees) goes back too — a no-op otherwise.
  await refundRemainderIfAllSellerOrdersCancelled(order.id, actorUserId);
}

/**
 * Refunds an ORPHAN capture (see `settleCapture`) in full. Idempotent: the
 * payment is locked, and while any live refund exists for it nothing new is
 * reserved — a replayed webhook, a refresh and the reconciliation job can all
 * arrive here for the same money and only one refund is ever issued. Only a
 * refund the provider REFUSED (FAILED) is retried by a later call.
 */
async function refundOrphanCapture(paymentId: string, reason: string): Promise<void> {
  const reserved = await runInTransaction(async (tx): Promise<ReservedRefund | null> => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM payments WHERE id = ${paymentId}::uuid AND status = 'CAPTURED' FOR UPDATE`;
    if (!locked) return null;
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    // Never the payment an order was actually placed with.
    if (payment.failureCode !== ORPHAN_CAPTURE || !payment.providerPaymentId) return null;

    const live = await tx.refund.findFirst({
      where: { paymentId, status: { in: LIVE_REFUND_STATUSES } },
      select: { id: true },
    });
    if (live) return null;

    const amountPaise = payment.amountPaise - (await liveRefundedPaise(tx, paymentId));
    if (amountPaise <= 0) return null;

    const refund = await tx.refund.create({
      data: { paymentId, orderId: payment.orderId, amountPaise, status: RefundStatus.PENDING, reason },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        action: "payment.orphan_capture_refund",
        entityType: "Order",
        entityId: payment.orderId,
        after: {
          paymentId,
          refundId: refund.id,
          provider: payment.provider,
          providerOrderId: payment.providerOrderId,
          providerPaymentId: payment.providerPaymentId,
          amountPaise,
          reason,
        },
      },
    });
    return {
      refundId: refund.id,
      orderId: payment.orderId,
      paymentId,
      providerPaymentId: payment.providerPaymentId,
      providerOrderId: payment.providerOrderId,
      amountPaise,
    };
  });
  if (!reserved) return;

  try {
    // Announces REFUND_INITIATED / REFUND_COMPLETED to the customer, or the
    // failure to refund admins, keyed by the refund id.
    const outcome = await executeReservedRefund(reserved, reason);
    log.warn(
      { orderId: reserved.orderId, paymentId, refundId: reserved.refundId, amountPaise: reserved.amountPaise, status: outcome.status },
      "orphan capture refunded",
    );
  } catch (error) {
    log.error(
      { err: error, orderId: reserved.orderId, paymentId, refundId: reserved.refundId },
      "orphan capture refund failed — needs manual action",
    );
  }
}

/** Applies a refund status change and everything that follows from it. */
async function recordRefundUpdate(refundId: string, result: RefundResult): Promise<void> {
  const { changed, orderPaymentStatus } = await applyRefundResult(refundId, result);
  if (!changed) return;
  await announceRefund(refundId, result.status);
  if (orderPaymentStatus === OrderPaymentStatus.REFUNDED) {
    const refund = await prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      select: { orderId: true, reason: true },
    });
    await transitionOrder({
      orderId: refund.orderId,
      toStatus: OrderStatus.REFUNDED,
      actorType: ActorType.SYSTEM,
      reason: refund.reason ?? "Refund completed.",
    }).catch((error) =>
      log.warn({ err: error, orderId: refund.orderId }, "refund transition skipped"),
    );
  }
}

/**
 * A refund webhook. Like a payment webhook it is only a notice: the refund is
 * re-read from the gateway before anything is recorded.
 */
async function handleRefundEvent(update: NonNullable<WebhookEvent["refund"]>): Promise<void> {
  const refund = update.refundId
    ? await prisma.refund.findUnique({ where: { id: update.refundId }, include: { payment: true } })
    : update.providerRefundId
      ? await prisma.refund.findUnique({
          where: { providerRefundId: update.providerRefundId },
          include: { payment: true },
        })
      : null;

  if (!refund || refund.payment.provider !== provider.name || !refund.payment.providerOrderId) {
    log.warn({ refundId: update.refundId }, "refund webhook for an unknown refund — recorded only");
    return;
  }
  if (!provider.getRefund) {
    log.warn({ refundId: refund.id }, "provider cannot re-read refunds — webhook recorded only");
    return;
  }
  const verified = await provider.getRefund(refund.payment.providerOrderId, refund.id);
  await recordRefundUpdate(refund.id, verified);
}

/* -------------------------------------------------------------------------- */
/* Hosted checkout — server-side verification (Cashfree)                      */
/* -------------------------------------------------------------------------- */

export interface PaymentRefreshResult {
  orderId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  totalPaise: number;
  /** The newest attempt failed or was abandoned; the customer may retry. */
  lastAttemptFailed: boolean;
  /**
   * The newest attempt is still in progress at the gateway (the UPI app or
   * the bank has not answered yet). The app shows "Payment pending" and keeps
   * checking rather than inviting a second payment.
   */
  attemptPending: boolean;
  /** Until when payment is accepted, while the order awaits it. */
  payBy: string | null;
  /** Money arrived after the order stopped awaiting it and is being refunded. */
  latePaymentRefund: boolean;
}

/**
 * The app's "I'm back from the gateway" call. The gateway SDK's callback says
 * only that the sheet closed; this asks Cashfree, server-side, what actually
 * happened, and settles through the same path as the webhook. Also catches a
 * payment made in the last seconds before the hold expired (-> refunded).
 */
export async function refreshPayment(
  userId: string,
  orderId: string,
): Promise<PaymentRefreshResult> {
  const order = await prisma.order.findFirst({ where: { id: orderId, userId } });
  if (!order)
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Order not found." });

  let lastAttemptFailed = false;
  let attemptPending = false;

  if (
    provider.fetchOrder &&
    order.paymentMethod === PaymentMethod.ONLINE &&
    order.paymentStatus !== OrderPaymentStatus.PAID
  ) {
    const rows = await prisma.payment.findMany({
      where: {
        orderId: order.id,
        provider: provider.name,
        providerOrderId: { not: null },
        OR: [
          { status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] } },
          // A checkout replaced moments ago can still have been paid in its
          // final seconds (reconciliation checks the same rows).
          recentlySupersededCheckout(),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 2,
    });

    for (const [index, row] of rows.entries()) {
      const status = await provider.fetchOrder(row.providerOrderId!);
      if (status.captured) {
        await settleCapture({
          orderId: order.id,
          providerPaymentId: status.captured.providerPaymentId,
          providerOrderId: status.providerOrderId,
          amountPaise: status.captured.amountPaise,
          currency: status.captured.currency,
          gatewayOrderTag: status.adioneOrderId,
          method: status.captured.method,
          actorType: ActorType.SYSTEM,
          rawPayload: { verifiedBy: "fetchOrder", source: "refresh" },
        });
        lastAttemptFailed = false;
        attemptPending = false;
        break;
      }
      if (index === 0 && status.attemptPending) attemptPending = true;
      if (row.status === PaymentStatus.FAILED) continue;
      if (status.orderStatus === "EXPIRED" || status.orderStatus === "TERMINATED") {
        await closeDeadCheckout(row.id, status);
      } else if (index === 0 && status.lastFailure) {
        lastAttemptFailed = true;
        await recordAttemptFailure(row.id, status.lastFailure, "refresh");
      }
    }
  }

  const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

  // The newest attempt was a wrong-amount capture, already being refunded
  // (recorded by an earlier call, the webhook or reconciliation): keep saying
  // so until the customer opens a new checkout.
  if (updated.status === OrderStatus.PENDING_PAYMENT) {
    const newest = await prisma.payment.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: "desc" },
      select: { failureCode: true, failureReason: true },
    });
    if (newest?.failureCode === ORPHAN_CAPTURE && newest.failureReason?.startsWith(AMOUNT_MISMATCH_REASON)) {
      throw amountMismatchError();
    }
  }

  // "Late" = money that arrived after the order stopped awaiting payment. A
  // refund of a wrong-amount capture on an order that is still payable is not.
  const lateRefund =
    updated.status === OrderStatus.PENDING_PAYMENT
      ? null
      : await prisma.refund.findFirst({
          where: { orderId: order.id, payment: { failureCode: ORPHAN_CAPTURE } },
          select: { id: true },
        });

  return {
    orderId: updated.id,
    status: updated.status,
    paymentStatus: updated.paymentStatus,
    totalPaise: updated.totalPaise,
    lastAttemptFailed,
    attemptPending: attemptPending && updated.status === OrderStatus.PENDING_PAYMENT,
    payBy:
      updated.status === OrderStatus.PENDING_PAYMENT && updated.reservationExpiresAt
        ? updated.reservationExpiresAt.toISOString()
        : null,
    latePaymentRefund: lateRefund !== null,
  };
}

/**
 * Reconciliation for hosted-checkout gateways — the path that settles a
 * payment when neither the app's refresh nor the webhook reached us. Runs
 * from the reconcile job. Does nothing for any other provider.
 *
 *   1. open checkouts older than 2 minutes -> ask the gateway: settle a
 *      capture (late ones are refunded), close expired ones;
 *   2. orders still PENDING_PAYMENT although their gateway payment was
 *      recorded (placement failed midway) -> place them;
 *   3. refunds still pending -> re-read them from the gateway.
 */
export async function reconcileCheckoutPayments(): Promise<number> {
  const fetchOrder = provider.fetchOrder?.bind(provider);
  if (!fetchOrder) return 0;
  const cutoff = new Date(Date.now() - 2 * 60_000);
  let settled = 0;

  const open = await prisma.payment.findMany({
    where: {
      provider: provider.name,
      providerOrderId: { not: null },
      OR: [
        { status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] }, createdAt: { lt: cutoff } },
        // A checkout replaced moments ago may have been paid in its final
        // seconds — the same rows the app's refresh re-checks, so a lost
        // webhook plus an app that never comes back cannot strand that money.
        recentlySupersededCheckout(),
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });
  for (const row of open) {
    // A replaced checkout is never re-stamped: its re-check window is measured
    // from when it was replaced and must not slide forward.
    const superseded = row.status === PaymentStatus.FAILED;
    try {
      const status = await fetchOrder(row.providerOrderId!);
      if (status.captured) {
        await settleCapture({
          orderId: row.orderId,
          providerPaymentId: status.captured.providerPaymentId,
          providerOrderId: status.providerOrderId,
          amountPaise: status.captured.amountPaise,
          currency: status.captured.currency,
          gatewayOrderTag: status.adioneOrderId,
          method: status.captured.method,
          actorType: ActorType.SYSTEM,
          rawPayload: { verifiedBy: "fetchOrder", source: "reconcile" },
        });
        settled += 1;
        log.warn({ paymentId: row.id }, "payment settled by reconciliation");
      } else if (superseded) {
        // Not paid (yet); already closed on our side — nothing to change.
      } else if (status.orderStatus === "EXPIRED" || status.orderStatus === "TERMINATED") {
        await closeDeadCheckout(row.id, status);
      } else {
        // Touch the row so the oldest-first sweep moves on to the others.
        await prisma.payment.update({ where: { id: row.id }, data: { updatedAt: new Date() } });
      }
    } catch (error) {
      log.error({ err: error, paymentId: row.id }, "checkout reconciliation failed");
      // A row that keeps failing (gateway error, a capture that cannot be
      // applied) moves to the back of the oldest-first sweep, so it can never
      // hold the head of every batch. Only if it is still open: a capture
      // recorded meanwhile must not be touched, and a replaced checkout keeps
      // its window.
      if (!superseded) {
        await prisma.payment
          .updateMany({
            where: { id: row.id, status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] } },
            data: { updatedAt: new Date() },
          })
          .catch((touchError: unknown) => log.error({ err: touchError, paymentId: row.id }, "could not re-queue the payment row"));
      }
    }
  }

  const unplaced = await prisma.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      payments: {
        some: {
          provider: provider.name,
          status: PaymentStatus.CAPTURED,
          OR: [{ failureCode: null }, { failureCode: { not: ORPHAN_CAPTURE } }],
        },
      },
    },
    select: { id: true },
    take: 10,
  });
  for (const order of unplaced) {
    try {
      await confirmPaymentAndPlace(order.id, ActorType.SYSTEM);
      settled += 1;
      log.warn({ orderId: order.id }, "paid order placed by reconciliation");
    } catch (error) {
      log.error({ err: error, orderId: order.id }, "placing a paid order failed");
    }
  }

  if (provider.getRefund) {
    const refunds = await prisma.refund.findMany({
      where: {
        status: { in: [RefundStatus.PENDING, RefundStatus.PROCESSING] },
        createdAt: { lt: cutoff },
        payment: { provider: provider.name, providerOrderId: { not: null } },
      },
      include: { payment: { select: { providerOrderId: true } } },
      orderBy: { updatedAt: "asc" },
      take: 25,
    });
    for (const refund of refunds) {
      try {
        let current: RefundResult;
        try {
          current = await provider.getRefund(refund.payment.providerOrderId!, refund.id);
        } catch (error) {
          // A refund whose call never reached the provider (see
          // executeReservedRefund) — FAILED only once it is clearly not
          // coming; a young one may still be in flight.
          if (
            error instanceof CashfreeApiError &&
            error.httpStatus === 404 &&
            Date.now() - refund.createdAt.getTime() > UNKNOWN_REFUND_GRACE_MS
          ) {
            await failRefundUnknownToProvider(refund.id);
            continue;
          }
          throw error;
        }
        await recordRefundUpdate(refund.id, current);
      } catch (error) {
        log.error({ err: error, refundId: refund.id }, "refund reconciliation failed");
      }
    }
  }

  return settled;
}

export const NOTIFICATION_ON_REFUND = NotificationType.REFUND_INITIATED;
