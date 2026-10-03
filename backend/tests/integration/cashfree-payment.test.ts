/**
 * Cashfree — the V2 production payment path, end to end through the real app.
 *
 * The app's payment provider is swapped for a CashfreeProvider talking to an
 * in-memory Cashfree (tests/helpers/fake-cashfree.ts): the provider's real HTTP
 * code, the real webhook signature check, the real settlement path and the
 * real state machine all run; only the network is fake.
 *
 * Covers: amount validation, duplicate payment and duplicate webhook
 * protection, webhook signatures, server-side verification, retry after a
 * failed attempt, no second payment for a paid order, late payment after the
 * hold expired (recorded + refunded, never revived), refund idempotency,
 * manual confirmation refused, and the state machine's actor rules.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infra/payment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infra/payment')>();
  const fake = await import('../helpers/fake-cashfree');
  return {
    ...actual,
    payments: new actual.CashfreeProvider({
      appId: 'cf_test_app_id',
      secretKey: fake.FAKE_CASHFREE_SECRET,
      environment: 'SANDBOX',
      apiVersion: '2026-01-01',
      fetch: fake.sharedFakeCashfree.fetch,
    }),
    requiresManualPaymentConfirmation: () => false,
    allowsManualPaymentConfirmation: () => false,
  };
});

import {
  ActorType,
  ErrorCode,
  NotificationType,
  OrderStatus,
  PaymentMethod,
  UserRole,
  canActorTransition,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { reconcileCheckoutPayments } from '../../src/modules/payments/payment.service';
import { transitionOrder } from '../../src/modules/orders/order-state.service';
import { releaseExpiredReservations } from '../../src/jobs';
import { cashfreeRefundId } from '../../src/infra/payment/cashfree.provider';
import { FAKE_CASHFREE_SECRET, sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9876543210';

interface OnlineOrder {
  token: string;
  userId: string;
  orderId: string;
  listingId: string;
  totalPaise: number;
}

interface Checkout {
  paymentId: string;
  providerOrderId: string;
  publicKey: string;
  cashfree: { paymentSessionId: string; orderId: string; environment: string };
}

interface Refreshed {
  status: OrderStatus;
  paymentStatus: string;
  lastAttemptFailed: boolean;
  payBy: string | null;
  latePaymentRefund: boolean;
}

async function placeOnlineOrder(): Promise<OnlineOrder> {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);

  await api()
    .post('/api/v1/cart/items')
    .set('Authorization', bearer(session.accessToken))
    .send({ sellerListingId: product.storeVariantId, qty: 2 })
    .expect(200);

  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(session.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.ONLINE })
    .expect(201);

  const order = expectSuccess<{ order: { id: string; bill: { totalPaise: number } } }>(res.body).data.order;
  return {
    token: session.accessToken,
    userId: session.userId,
    orderId: order.id,
    listingId: product.storeVariantId,
    totalPaise: order.bill.totalPaise,
  };
}

async function openCheckout(order: OnlineOrder): Promise<Checkout> {
  const res = await api()
    .post('/api/v1/payments/create')
    .set('Authorization', bearer(order.token))
    .set('Idempotency-Key', randomUUID())
    .send({ orderId: order.orderId })
    .expect(200);
  return expectSuccess<Checkout>(res.body).data;
}

async function refresh(order: OnlineOrder, token = order.token) {
  return api()
    .post(`/api/v1/payments/${order.orderId}/refresh`)
    .set('Authorization', bearer(token));
}

async function refreshed(order: OnlineOrder): Promise<Refreshed> {
  const res = await refresh(order);
  expect(res.status).toBe(200);
  return expectSuccess<Refreshed>(res.body).data;
}

async function deliver(webhook: { raw: string; headers: Record<string, string> }) {
  return api().post('/api/v1/payments/webhook').set(webhook.headers).send(webhook.raw);
}

async function listing(order: OnlineOrder) {
  return prisma.sellerListing.findUniqueOrThrow({ where: { id: order.listingId } });
}

async function dbOrder(order: OnlineOrder) {
  return prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
}

/** Makes the stored session look nearly expired, so the next create replaces it. */
async function ageStoredSession(checkout: Checkout): Promise<void> {
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
  const raw = row.rawPayload as { checkout: Record<string, unknown> };
  await prisma.payment.update({
    where: { id: row.id },
    data: {
      rawPayload: { checkout: { ...raw.checkout, expiresAt: new Date(Date.now() + 20_000).toISOString() } },
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(MOBILE);
  await cache.clear();
  cashfree.reset();
});

describe('Cashfree checkout — create', () => {
  it('returns a single-order session for the server total — never a credential', async () => {
    const order = await placeOnlineOrder();
    const res = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(order.token))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.orderId })
      .expect(200);
    const checkout = expectSuccess<Checkout & Record<string, unknown>>(res.body).data;

    expect(checkout.cashfree.paymentSessionId).toMatch(/^session_/);
    expect(checkout.cashfree.orderId).toBe(checkout.providerOrderId);
    expect(checkout.cashfree.environment).toBe('SANDBOX');
    expect(checkout.publicKey).toBe('');
    expect(checkout).not.toHaveProperty('upiIntentUrl');
    expect(JSON.stringify(res.body)).not.toContain(FAKE_CASHFREE_SECRET);
    expect(JSON.stringify(res.body)).not.toContain('cf_test_app_id');

    const gatewayOrder = cashfree.orders.get(checkout.providerOrderId)!;
    expect(gatewayOrder.order_amount * 100).toBe(order.totalPaise);

    // Cashfree gets more than its 15-minute minimum (~16), this order's hold
    // is stretched to ~17, and the Cashfree order stops taking money a minute
    // BEFORE the AdiOne hold ends.
    const hold = (await dbOrder(order)).reservationExpiresAt!.getTime();
    const expiry = Date.parse(gatewayOrder.order_expiry_time);
    expect(expiry - Date.now()).toBeGreaterThan(15 * 60_000);
    expect(hold - Date.now()).toBeGreaterThan(16 * 60_000);
    expect(hold - Date.now()).toBeLessThanOrEqual(17 * 60_000);
    expect(expiry).toBeLessThanOrEqual(hold - 60_000 + 1_000);

    const rows = await prisma.payment.findMany({ where: { orderId: order.orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'cashfree', status: 'CREATED', amountPaise: order.totalPaise });
  });

  it('reopening checkout reuses the same Cashfree order', async () => {
    const order = await placeOnlineOrder();
    const first = await openCheckout(order);
    const second = await openCheckout(order);

    expect(second.providerOrderId).toBe(first.providerOrderId);
    expect(second.cashfree.paymentSessionId).toBe(first.cashfree.paymentSessionId);
    expect(cashfree.orders.size).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it('a late checkout still gets Cashfree’s full window (>15 min) by stretching only this order’s hold — once', async () => {
    const order = await placeOnlineOrder();
    const now = Date.now();
    await prisma.order.update({
      where: { id: order.orderId },
      data: { createdAt: new Date(now - 9 * 60_000), reservationExpiresAt: new Date(now + 90_000) },
    });

    const checkout = await openCheckout(order);
    const expiry = Date.parse(cashfree.orders.get(checkout.providerOrderId)!.order_expiry_time);
    expect(expiry).toBeGreaterThan(now + 15 * 60_000);
    const hold = (await dbOrder(order)).reservationExpiresAt!.getTime();
    expect(hold).toBeGreaterThanOrEqual(expiry + 60_000 - 1_000);

    // Time passes: that checkout is about to lapse and the order is old.
    await ageStoredSession(checkout);
    await prisma.order.update({
      where: { id: order.orderId },
      data: { createdAt: new Date(now - 15 * 60_000), reservationExpiresAt: new Date(now + 60_000) },
    });
    const again = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(order.token))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.orderId });
    expect(again.status).toBe(400);
    expect(expectError(again.body).message).toMatch(/time to pay/i);
  });
});

describe('server-side verification', () => {
  it('confirms nothing until Cashfree itself says the order is paid', async () => {
    const order = await placeOnlineOrder();
    await openCheckout(order);

    const state = await refreshed(order);
    expect(state.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(state.paymentStatus).toBe('PENDING');
    expect(state.payBy).not.toBeNull();
    expect((await listing(order)).reservedQty).toBe(2);
  });

  it('places the order through the SYSTEM path once Cashfree reports it PAID', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');

    const state = await refreshed(order);
    expect(state.status).toBe(OrderStatus.PROCESSING);
    expect(state.paymentStatus).toBe('PAID');

    const offer = await listing(order);
    expect(offer.stockQty).toBe(8);
    expect(offer.reservedQty).toBe(0);

    // Every transition after "Order created" was made by SYSTEM.
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: order.orderId, fromStatus: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => [h.toStatus, h.actorType])).toEqual([
      [OrderStatus.PAYMENT_CONFIRMED, ActorType.SYSTEM],
      [OrderStatus.PROCESSING, ActorType.SYSTEM],
    ]);
  });

  it('a failed or abandoned attempt keeps the order payable, and a retry succeeds', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);

    cashfree.attempt(checkout.providerOrderId, 'FAILED');
    const afterFailure = await refreshed(order);
    expect(afterFailure.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(afterFailure.lastAttemptFailed).toBe(true);

    const dropped = cashfree.attempt(checkout.providerOrderId, 'USER_DROPPED');
    await deliver(cashfree.paymentWebhook('PAYMENT_USER_DROPPED_WEBHOOK', checkout.providerOrderId, dropped)).then((r) =>
      expect(r.status).toBe(200),
    );
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await listing(order)).reservedQty).toBe(2);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    expect(row.status).toBe('CREATED');
    expect(row.failureCode).toBe('PAYMENT_USER_DROPPED');

    // The customer retries in the same checkout and pays.
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    expect((await refreshed(order)).status).toBe(OrderStatus.PROCESSING);
  });

  it("another customer cannot refresh (or learn about) my order", async () => {
    const order = await placeOnlineOrder();
    await openCheckout(order);
    await otpService.clearOtpState('9812345678');
    const attacker = await loginAs('9812345678');

    const res = await refresh(order, attacker.accessToken);
    expect(res.status).toBe(404);
  });

  it('/payments/verify with a forged signature neither confirms nor fails a Cashfree order', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);

    const res = await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(order.token))
      .send({
        orderId: order.orderId,
        providerOrderId: checkout.providerOrderId,
        providerPaymentId: 'forged_payment',
        signature: 'f'.repeat(64),
      })
      .expect(200);
    expect(expectSuccess<{ verified: boolean }>(res.body).data.verified).toBe(false);
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('refuses a capture whose amount differs from the order total', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS', { amountRupees: 1 });

    const res = await refresh(order);
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
    const updated = await dbOrder(order);
    expect(updated.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(updated.paymentStatus).toBe('PENDING');
  });
});

describe('webhook', () => {
  it('rejects a bad signature and records nothing', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const payment = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, payment);

    const res = await deliver({ raw: webhook.raw, headers: { ...webhook.headers, 'x-webhook-signature': 'AAAA' } });
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.WEBHOOK_SIGNATURE_INVALID);
    expect(await prisma.paymentEvent.count()).toBe(0);
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('settles from a signed webhook alone, after re-checking with Cashfree', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const payment = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');

    const res = await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, payment));
    expect(res.status).toBe(200);

    const updated = await dbOrder(order);
    expect(updated.status).toBe(OrderStatus.PROCESSING);
    expect(updated.paymentStatus).toBe('PAID');
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: order.orderId, fromStatus: { not: null } },
    });
    expect(history.map((h) => h.toStatus).sort()).toEqual([OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING].sort());
    expect(history.every((h) => h.actorType === ActorType.PAYMENT_WEBHOOK)).toBe(true);
    const verification = cashfree.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/payments'));
    expect(verification.length).toBeGreaterThan(0);
  });

  it('a correctly signed success webhook is not enough if Cashfree says the order is unpaid', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const invented = {
      cf_payment_id: '999',
      payment_status: 'SUCCESS',
      payment_amount: order.totalPaise / 100,
      payment_group: 'upi',
      payment_message: 'ok',
      payment_time: new Date().toISOString(),
    };

    const res = await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, invented));
    expect(res.status).toBe(200);
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);
    const event = await prisma.paymentEvent.findFirstOrThrow();
    expect(event.error).toContain(ErrorCode.PAYMENT_VERIFICATION_FAILED);
  });

  it('replayed webhooks settle exactly once', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const payment = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, payment);

    for (let i = 0; i < 5; i += 1) expect((await deliver(webhook)).status).toBe(200);
    // …and the app's refresh arriving as well changes nothing.
    await refreshed(order);

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(1);
    expect((await listing(order)).stockQty).toBe(8);
  });
});

describe('no double payment', () => {
  it('an order already paid cannot start another payment', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    await refreshed(order);

    const res = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(order.token))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.orderId });
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_ALREADY_CAPTURED);
    expect(cashfree.orders.size).toBe(1);
  });

  it('a second Cashfree order paid for the same AdiOne order is refunded, not applied', async () => {
    const order = await placeOnlineOrder();
    const first = await openCheckout(order);
    await ageStoredSession(first);
    const second = await openCheckout(order);
    expect(second.providerOrderId).not.toBe(first.providerOrderId);

    // The customer pays both: the old checkout in its final seconds, and the new one.
    const late = cashfree.attempt(first.providerOrderId, 'SUCCESS');
    const paid = cashfree.attempt(second.providerOrderId, 'SUCCESS');
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', second.providerOrderId, paid));
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', first.providerOrderId, late));

    const updated = await dbOrder(order);
    expect(updated.status).toBe(OrderStatus.PROCESSING);
    expect(updated.paymentStatus).toBe('PAID');
    expect((await listing(order)).stockQty).toBe(8);

    const orphan = await prisma.payment.findFirstOrThrow({ where: { providerOrderId: first.providerOrderId } });
    expect(orphan).toMatchObject({ status: 'CAPTURED', failureCode: 'ORPHAN_CAPTURE' });
    const refunds = await prisma.refund.findMany({ where: { paymentId: orphan.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(order.totalPaise);
    expect(cashfree.refunds.size).toBe(1);
    expect([...cashfree.refunds.values()][0]!.order_id).toBe(first.providerOrderId);
  });
});

describe('late payment after the hold expired', () => {
  it('is recorded, never revives the order, and is refunded exactly once', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);

    await prisma.order.update({
      where: { id: order.orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await releaseExpiredReservations()).toBe(1);
    expect((await dbOrder(order)).status).toBe(OrderStatus.PAYMENT_FAILED);
    expect((await listing(order)).reservedQty).toBe(0);

    // The customer's payment lands after the hold ended.
    const payment = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, payment);
    expect((await deliver(webhook)).status).toBe(200);

    let updated = await dbOrder(order);
    expect(updated.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(updated.paymentStatus).toBe('FAILED');
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.orderId } });
    expect(history.some((h) => h.toStatus === OrderStatus.PROCESSING)).toBe(false);
    expect((await listing(order)).stockQty).toBe(10);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    expect(row).toMatchObject({ status: 'CAPTURED', failureCode: 'ORPHAN_CAPTURE', providerPaymentId: payment.cf_payment_id });

    // Every settlement path arriving again changes nothing.
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, payment));
    const state = await refreshed(order);
    expect(state.latePaymentRefund).toBe(true);
    await reconcileCheckoutPayments();

    const refunds = await prisma.refund.findMany({ where: { orderId: order.orderId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amountPaise: order.totalPaise, status: 'PENDING' });
    expect(cashfree.refunds.size).toBe(1);

    const audit = await prisma.auditLog.findMany({ where: { action: 'payment.orphan_capture_refund' } });
    expect(audit).toHaveLength(1);
    expect(
      await prisma.notification.count({ where: { userId: order.userId, type: NotificationType.REFUND_INITIATED } }),
    ).toBe(1);

    // Cashfree completes the refund; its webhook is re-verified and recorded once.
    const cfRefundId = cashfreeRefundId(refunds[0]!.id);
    cashfree.settleRefund(cfRefundId, 'SUCCESS');
    const refundWebhook = cashfree.refundWebhook(cfRefundId);
    expect((await deliver(refundWebhook)).status).toBe(200);
    expect((await deliver(refundWebhook)).status).toBe(200);

    const done = await prisma.refund.findUniqueOrThrow({ where: { id: refunds[0]!.id } });
    expect(done.status).toBe('COMPLETED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } })).status).toBe('REFUNDED');
    updated = await dbOrder(order);
    // The order never used this money: its own status is untouched.
    expect(updated.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(updated.paymentStatus).toBe('FAILED');
    expect(
      await prisma.notification.count({ where: { userId: order.userId, type: NotificationType.REFUND_COMPLETED } }),
    ).toBe(1);
  });
});

describe('manual confirmation is not the Cashfree path', () => {
  it('admin confirm / reject and the customer claim are all refused', async () => {
    const order = await placeOnlineOrder();
    await openCheckout(order);

    await prisma.user.create({
      data: {
        mobile: '0000000001',
        email: 'owner@adione.test',
        fullName: 'Admin',
        passwordHash: await hashPassword('TestAdmin@123'),
        role: UserRole.ADMIN,
      },
    });
    const login = await api()
      .post('/api/v1/auth/admin/login')
      .send({ email: 'owner@adione.test', password: 'TestAdmin@123' })
      .expect(200);
    const admin = expectSuccess<{ tokens: { accessToken: string } }>(login.body).data.tokens.accessToken;

    const mode = await api().get('/api/v1/admin/payment-mode').set('Authorization', bearer(admin)).expect(200);
    expect(expectSuccess(mode.body).data).toEqual({ provider: 'cashfree', manualConfirmation: false });

    const confirm = await api()
      .post(`/api/v1/admin/orders/${order.orderId}/confirm-payment`)
      .set('Authorization', bearer(admin))
      .send({ reference: '123456789012' });
    expect(confirm.status).toBe(400);

    const reject = await api()
      .post(`/api/v1/admin/orders/${order.orderId}/reject-payment`)
      .set('Authorization', bearer(admin))
      .send({ reason: 'not received' });
    expect(reject.status).toBe(400);

    const claim = await api()
      .post('/api/v1/payments/claim')
      .set('Authorization', bearer(order.token))
      .send({ orderId: order.orderId, utr: '123456789012' });
    expect(claim.status).toBe(400);

    const updated = await dbOrder(order);
    expect(updated.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(updated.paymentStatus).toBe('PENDING');
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(0);
  });
});

describe('state machine', () => {
  it('ADMIN still cannot perform the SYSTEM-only placement step; SYSTEM and the webhook can', () => {
    expect(canActorTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING, ActorType.ADMIN)).toBe(false);
    expect(canActorTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING, ActorType.CUSTOMER)).toBe(false);
    expect(canActorTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING, ActorType.SYSTEM)).toBe(true);
    expect(canActorTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING, ActorType.PAYMENT_WEBHOOK)).toBe(true);
  });

  it('nobody can skip payment confirmation or place an order by hand', async () => {
    const order = await placeOnlineOrder();
    await expect(
      transitionOrder({ orderId: order.orderId, toStatus: OrderStatus.PROCESSING, actorType: ActorType.SYSTEM }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATUS_TRANSITION });
    await expect(
      transitionOrder({ orderId: order.orderId, toStatus: OrderStatus.PAYMENT_FAILED, actorType: ActorType.CUSTOMER }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);
  });
});

describe('reconciliation', () => {
  it('settles a payment when neither the app nor the webhook reached us', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    await prisma.payment.update({
      where: { id: checkout.paymentId },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    });

    expect(await reconcileCheckoutPayments()).toBe(1);
    expect((await dbOrder(order)).status).toBe(OrderStatus.PROCESSING);
  });

  it('closes a checkout Cashfree has expired, leaving the order to the release job', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.expire(checkout.providerOrderId);
    await prisma.payment.update({
      where: { id: checkout.paymentId },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    });

    expect(await reconcileCheckoutPayments()).toBe(0);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    expect(row).toMatchObject({ status: 'FAILED', failureCode: 'CHECKOUT_EXPIRED' });
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);
  });
});
