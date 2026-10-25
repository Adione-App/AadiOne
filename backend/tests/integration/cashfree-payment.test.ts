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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  ConfigKey,
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
import { CacheKey } from '../../src/infra/cache/types';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import {
  PAYMENT_INIT_LOCK_SECONDS,
  PAYMENT_INIT_WAIT_MS,
  reconcileCheckoutPayments,
  withPaymentInitLock,
} from '../../src/modules/payments/payment.service';
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
  attemptPending: boolean;
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

  it('simultaneous Pay requests for one order (double tap, two devices) open ONE Cashfree order — never two payable checkouts', async () => {
    const order = await placeOnlineOrder();
    const checkouts = await Promise.all([openCheckout(order), openCheckout(order), openCheckout(order)]);

    expect(new Set(checkouts.map((c) => c.providerOrderId)).size).toBe(1);
    expect(new Set(checkouts.map((c) => c.cashfree.paymentSessionId)).size).toBe(1);
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

describe('payment initiation lock — one checkout per order at a time', () => {
  /** Starts a Pay request now (supertest is lazy) and returns its pending response. */
  const startPay = (order: OnlineOrder) =>
    Promise.resolve(
      api()
        .post('/api/v1/payments/create')
        .set('Authorization', bearer(order.token))
        .set('Idempotency-Key', randomUUID())
        .send({ orderId: order.orderId }),
    );
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const createOrderCalls = () => cashfree.requests.filter((r) => r.method === 'POST' && r.path === '/orders').length;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a second Pay while the first is still talking to Cashfree waits, then reuses the first checkout', async () => {
    const order = await placeOnlineOrder();
    const slow = cashfree.holdNext('POST', '/orders');
    const first = startPay(order);
    await slow.reached;

    const second = startPay(order);
    await pause(400); // the second request is now waiting on the lock
    slow.release();

    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(expectSuccess<Checkout>(b.body).data.providerOrderId).toBe(expectSuccess<Checkout>(a.body).data.providerOrderId);
    expect(createOrderCalls()).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it('busy lock: after waiting, a clear 503 "try again" with Retry-After — no Cashfree order, and the holder keeps its lock', async () => {
    const order = await placeOnlineOrder();
    const key = CacheKey.paymentInit(order.orderId);
    await cache.set(key, 'held-by-another-instance', PAYMENT_INIT_LOCK_SECONDS);

    vi.useFakeTimers({ toFake: ['Date'] }); // the clock moves only when the test says so
    const pending = startPay(order);
    await pause(400);
    vi.setSystemTime(Date.now() + PAYMENT_INIT_WAIT_MS + 1_000);
    const res = await pending;

    expect(res.status).toBe(503);
    expect(expectError(res.body).code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(expectError(res.body).message).toMatch(/still being prepared/i);
    expect(res.headers['retry-after']).toBe('5');
    expect(createOrderCalls()).toBe(0);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(0);
    expect(await cache.get(key)).toBe('held-by-another-instance');
  });

  it('cache unavailable: no checkout is opened (fails closed) and the customer is told to try again; the retry works', async () => {
    const order = await placeOnlineOrder();
    vi.spyOn(cache, 'setIfAbsent').mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    const res = await startPay(order);
    expect(res.status).toBe(503);
    expect(expectError(res.body).message).toMatch(/couldn.t start the payment/i);
    expect(res.headers['retry-after']).toBe('5');
    expect(createOrderCalls()).toBe(0);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(0);

    const retry = await openCheckout(order);
    expect(cashfree.orders.has(retry.providerOrderId)).toBe(true);
    expect(createOrderCalls()).toBe(1);
  });

  it('a lock that cannot be released does not fail the payment — it simply expires', async () => {
    const order = await placeOnlineOrder();
    vi.spyOn(cache, 'deleteIfEquals').mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    const checkout = await openCheckout(order);
    expect(cashfree.orders.has(checkout.providerOrderId)).toBe(true);
    expect(await cache.get(CacheKey.paymentInit(order.orderId))).not.toBeNull();
    expect(await cache.ttl(CacheKey.paymentInit(order.orderId))).toBeLessThanOrEqual(PAYMENT_INIT_LOCK_SECONDS);
  });

  it('slow Cashfree near its timeouts (two 15 s calls): the lock outlives the worst case, so a late second Pay never opens a second order', async () => {
    const order = await placeOnlineOrder();
    const slow = cashfree.holdNext('POST', '/orders');
    const first = startPay(order);
    await slow.reached;

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    vi.setSystemTime(start + 31_000); // fetchOrder + createIntent both at their 15 s limit
    const late = startPay(order);
    await pause(400);
    vi.setSystemTime(start + 31_000 + PAYMENT_INIT_WAIT_MS + 1_000); // still inside the 60 s lock
    const lateRes = await late;
    expect(lateRes.status).toBe(503);
    expect(createOrderCalls()).toBe(1);

    slow.release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    const opened = expectSuccess<Checkout>(firstRes.body).data;

    const again = await openCheckout(order); // the customer taps again: the SAME checkout
    expect(again.providerOrderId).toBe(opened.providerOrderId);
    expect(createOrderCalls()).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it('lock expiry and release race: a holder that outlived its lock never deletes the lock another request took since', async () => {
    const orderId = randomUUID();
    const key = CacheKey.paymentInit(orderId);

    let ownToken: string | null = null;

    await withPaymentInitLock(orderId, async () => {
      ownToken = await cache.get(key);
      expect(ownToken).not.toBeNull();
      // This holder is still working when its lock runs out. Expiry is
      // simulated by removing the key, exactly what a TTL expiry does, so the
      // test behaves the same on the in-memory cache and on real Redis (whose
      // TTL runs on the server's clock, which a test cannot move). Another
      // request then takes the order's lock.
      await cache.delete(key);
      expect(await cache.setIfAbsent(key, 'second-holder', PAYMENT_INIT_LOCK_SECONDS)).toBe(true);
    });

    // The first holder's own release (its `finally`) left the newer lock alone…
    expect(ownToken).not.toBe('second-holder');
    expect(await cache.get(key)).toBe('second-holder');
    // …and a later stale release with the first holder's token is refused as well.
    expect(await cache.deleteIfEquals(key, ownToken!)).toBe(false);
    expect(await cache.get(key)).toBe('second-holder');
    await cache.delete(key);
  });

  it('a normal run releases its own lock, also when the work fails', async () => {
    const orderId = randomUUID();
    const key = CacheKey.paymentInit(orderId);

    await withPaymentInitLock(orderId, async () => expect(await cache.get(key)).not.toBeNull());
    expect(await cache.get(key)).toBeNull();

    await expect(withPaymentInitLock(orderId, async () => { throw new Error('gateway refused'); })).rejects.toThrow('gateway refused');
    expect(await cache.get(key)).toBeNull();
  });

  it('order cancelled while a Pay request waits for the lock: the waiter re-checks and refuses instead of reusing or opening a checkout', async () => {
    const order = await placeOnlineOrder();
    const slow = cashfree.holdNext('POST', '/orders');
    const first = startPay(order);
    await slow.reached;

    const waiter = startPay(order);
    await pause(400);
    await prisma.order.update({ where: { id: order.orderId }, data: { status: OrderStatus.CANCELLED } });
    slow.release();

    const [, res] = await Promise.all([first, waiter]);
    expect(res.status).toBe(400);
    expect(expectError(res.body).message).toMatch(/no longer awaiting payment/i);
    expect(createOrderCalls()).toBe(1);
  });

  it('order paid while a Pay request waits for the lock: the waiter answers "already paid" instead of handing out a checkout', async () => {
    const order = await placeOnlineOrder();
    const slow = cashfree.holdNext('POST', '/orders');
    const first = startPay(order);
    await slow.reached;

    const waiter = startPay(order);
    await pause(400);
    await prisma.order.update({ where: { id: order.orderId }, data: { paymentStatus: 'PAID' } });
    slow.release();

    const [, res] = await Promise.all([first, waiter]);
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_ALREADY_CAPTURED);
    expect(createOrderCalls()).toBe(1);
  });
});

describe('Online Payment switched off (Admin → Configuration → Payments)', () => {
  const switchOff = () => configService.set({ key: ConfigKey.PAYMENT_ONLINE_ENABLED, value: false });

  it('a checkout opened before the switch reopens unchanged, and Cashfree verification still confirms the order', async () => {
    const order = await placeOnlineOrder();
    const first = await openCheckout(order);
    await switchOff();
    const again = await openCheckout(order);
    expect(again.providerOrderId).toBe(first.providerOrderId);
    expect(cashfree.orders.size).toBe(1);
    cashfree.attempt(first.providerOrderId, 'SUCCESS');
    expect((await refreshed(order)).status).toBe(OrderStatus.PROCESSING);
  });

  it('a signed success webhook still settles a payment started before the switch', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    await switchOff();
    const paid = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    expect((await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, paid))).status).toBe(200);
    expect((await dbOrder(order)).status).toBe(OrderStatus.PROCESSING);
  });

  it('no new Cashfree order is opened: neither a first checkout nor a replacement for an expired one', async () => {
    const order = await placeOnlineOrder();
    await switchOff();
    const refused = await api().post('/api/v1/payments/create').set('Authorization', bearer(order.token)).set('Idempotency-Key', randomUUID()).send({ orderId: order.orderId });
    expect(refused.status).toBe(409);
    expect(expectError(refused.body).code).toBe(ErrorCode.ONLINE_PAYMENT_DISABLED);
    expect(cashfree.orders.size).toBe(0);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(0);

    // Back on, a checkout opens; it ages; with the switch off again it is not replaced (and stays as it was).
    await configService.set({ key: ConfigKey.PAYMENT_ONLINE_ENABLED, value: true });
    const checkout = await openCheckout(order);
    await ageStoredSession(checkout);
    await switchOff();
    const replace = await api().post('/api/v1/payments/create').set('Authorization', bearer(order.token)).set('Idempotency-Key', randomUUID()).send({ orderId: order.orderId });
    expect(expectError(replace.body).code).toBe(ErrorCode.ONLINE_PAYMENT_DISABLED);
    expect(cashfree.orders.size).toBe(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } })).status).toBe('CREATED');
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

/* -------------------------------------------------------------------------- */
/* UPI app payments — what the app sees after the customer's UPI app returns   */
/* -------------------------------------------------------------------------- */

describe('UPI app payment outcomes — only Cashfree’s own answer counts', () => {
  const history = (order: OnlineOrder) =>
    prisma.orderStatusHistory.findMany({ where: { orderId: order.orderId, fromStatus: { not: null } } });
  const audits = (order: OnlineOrder, action: string) =>
    prisma.auditLog.findMany({ where: { action, entityId: order.orderId } });

  it('a pending UPI payment keeps the order unpaid and reports "pending", not "failed"', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'PENDING');

    const state = await refreshed(order);
    expect(state).toMatchObject({
      status: OrderStatus.PENDING_PAYMENT,
      paymentStatus: 'PENDING',
      attemptPending: true,
      lastAttemptFailed: false,
      latePaymentRefund: false,
    });
    expect(state.payBy).not.toBeNull();
    // Nothing placed, nothing announced to sellers, stock still only held.
    expect(await history(order)).toHaveLength(0);
    expect((await listing(order)).reservedQty).toBe(2);
    expect((await listing(order)).stockQty).toBe(10);
  });

  it('a delayed success (pending first, Cashfree says SUCCESS later) is placed exactly once', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const pending = cashfree.attempt(checkout.providerOrderId, 'PENDING');
    expect((await refreshed(order)).attemptPending).toBe(true);

    // The bank answers after the customer is already back in the app.
    cashfree.finish(checkout.providerOrderId, pending.cf_payment_id, 'SUCCESS');
    const state = await refreshed(order);
    expect(state).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID', attemptPending: false });

    // The success webhook arriving afterwards changes nothing.
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, pending)).then((r) =>
      expect(r.status).toBe(200),
    );
    expect((await refreshed(order)).status).toBe(OrderStatus.PROCESSING);
    const rows = await prisma.payment.findMany({ where: { orderId: order.orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CAPTURED', providerPaymentId: pending.cf_payment_id, failureCode: null });
    expect(await history(order)).toHaveLength(2);
    expect((await listing(order)).stockQty).toBe(8);
  });

  it('a pending attempt that finally fails leaves the order payable for a retry', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const pending = cashfree.attempt(checkout.providerOrderId, 'PENDING');
    cashfree.finish(checkout.providerOrderId, pending.cf_payment_id, 'FAILED');

    expect(await refreshed(order)).toMatchObject({
      status: OrderStatus.PENDING_PAYMENT,
      lastAttemptFailed: true,
      attemptPending: false,
    });
    expect((await listing(order)).reservedQty).toBe(2);
  });

  it('app closed after paying: no refresh, no webhook — reconciliation places it, and the app later sees it paid', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const paid = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    // The customer paid in their UPI app and the phone never came back to AdiOne.
    await prisma.payment.update({
      where: { id: checkout.paymentId },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    });
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);

    expect(await reconcileCheckoutPayments()).toBe(1);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });

    // Reopened app, a late webhook and another sweep: all no-ops.
    expect((await refreshed(order)).status).toBe(OrderStatus.PROCESSING);
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, paid)).then((r) =>
      expect(r.status).toBe(200),
    );
    expect(await reconcileCheckoutPayments()).toBe(0);
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(1);
    expect(await history(order)).toHaveLength(2);
    expect(await prisma.refund.count({ where: { orderId: order.orderId } })).toBe(0);
    expect((await listing(order)).stockQty).toBe(8);
  });

  it('retrying after a failed attempt reuses the same Cashfree order — one order, one payment, one charge', async () => {
    const order = await placeOnlineOrder();
    const first = await openCheckout(order);
    cashfree.attempt(first.providerOrderId, 'FAILED');
    expect((await refreshed(order)).lastAttemptFailed).toBe(true);

    // "Try again" in the app: a new create call (new idempotency key).
    const retry = await openCheckout(order);
    expect(retry.providerOrderId).toBe(first.providerOrderId);
    expect(retry.cashfree.paymentSessionId).toBe(first.cashfree.paymentSessionId);
    cashfree.attempt(retry.providerOrderId, 'SUCCESS');
    expect((await refreshed(order)).status).toBe(OrderStatus.PROCESSING);

    // A further "Pay" after success is refused, not charged again.
    const again = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(order.token))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.orderId });
    expect(expectError(again.body).code).toBe(ErrorCode.PAYMENT_ALREADY_CAPTURED);

    expect(await prisma.order.count({ where: { userId: order.userId } })).toBe(1);
    expect(cashfree.orders.size).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(1);
  });

  it('a forged "success" from the app (callback, verify, repeated refreshes) confirms nothing while Cashfree is unpaid', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'PENDING');

    const verify = await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(order.token))
      .send({
        orderId: order.orderId,
        providerOrderId: checkout.providerOrderId,
        providerPaymentId: '5999999999',
        signature: 'S'.repeat(64),
        // Extra client-claimed fields are ignored (and stripped by validation).
        status: 'SUCCESS',
        amountPaise: order.totalPaise,
      })
      .expect(200);
    expect(expectSuccess<{ verified: boolean }>(verify.body).data.verified).toBe(false);
    for (let i = 0; i < 3; i += 1) expect((await refreshed(order)).status).toBe(OrderStatus.PENDING_PAYMENT);

    // A "success webhook" not signed by Cashfree is refused outright.
    const forged = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, {
      ...cashfree.orders.get(checkout.providerOrderId)!.payments[0]!,
      payment_status: 'SUCCESS',
    });
    const res = await api()
      .post('/api/v1/payments/webhook')
      .set({ ...forged.headers, 'x-webhook-signature': 'Zm9yZ2Vk' })
      .send(forged.raw);
    expect(res.status).toBe(400);

    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(0);
    expect(await history(order)).toHaveLength(0);
  });

  it('an answer about a different Cashfree order (wrong transaction reference) is never applied', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    cashfree.orderViewOverrides.set(checkout.providerOrderId, { order_id: 'AD999_someoneelse' });

    const res = await refresh(order);
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_VERIFICATION_FAILED);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(0);
  });

  it('a paid Cashfree order tagged for a DIFFERENT AdiOne order is refused and audited once', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    cashfree.orderViewOverrides.set(checkout.providerOrderId, {
      order_tags: { adione_order_id: randomUUID(), adione_order_number: 'AD000OTHER' },
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await refresh(order);
      expect(res.status).toBe(400);
      expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_VERIFICATION_FAILED);
    }
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(0);
    expect(await audits(order, 'payment.reference_mismatch')).toHaveLength(1);
  });

  it('the exact amount in the wrong currency is refused like a wrong amount', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS', { currency: 'USD' });

    const res = await refresh(order);
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    const [audit] = await audits(order, 'payment.amount_mismatch');
    expect(audit?.after).toMatchObject({ currency: 'USD', expectedPaise: order.totalPaise, capturedPaise: order.totalPaise });
  });

  it('₹220 payable: a capture of ₹219.99 or ₹220.01 is refused; exactly ₹220 is accepted', async () => {
    const order = await placeOnlineOrder();
    // Make the server-computed total exactly ₹220 before the checkout opens.
    await prisma.order.update({ where: { id: order.orderId }, data: { totalPaise: 22000 } });
    // Each try below gets its own Cashfree order (the previous one closed).
    const closeOpenCheckouts = () =>
      prisma.payment.updateMany({
        where: { orderId: order.orderId, status: { in: ['CREATED', 'PENDING'] } },
        data: { status: 'FAILED', failureCode: 'TEST_CLOSED' },
      });

    for (const rupees of [219.99, 220.01]) {
      const checkout = await openCheckout(order);
      expect(cashfree.orders.get(checkout.providerOrderId)!.order_amount).toBe(220);
      cashfree.attempt(checkout.providerOrderId, 'SUCCESS', { amountRupees: rupees });
      const res = await refresh(order);
      expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
      expect((await dbOrder(order)).paymentStatus).toBe('PENDING');
      await closeOpenCheckouts();
    }

    const final = await openCheckout(order);
    cashfree.attempt(final.providerOrderId, 'SUCCESS', { amountRupees: 220 });
    expect((await refreshed(order)).paymentStatus).toBe('PAID');
  });
});

/* -------------------------------------------------------------------------- */
/* Mismatched captures, replaced checkouts and reconciliation robustness       */
/* -------------------------------------------------------------------------- */

describe('captured payments that cannot pay for the order', () => {
  const history = (order: OnlineOrder) =>
    prisma.orderStatusHistory.findMany({ where: { orderId: order.orderId, fromStatus: { not: null } } });
  const audits = (order: OnlineOrder, action: string) =>
    prisma.auditLog.findMany({ where: { action, entityId: order.orderId } });
  const seedRefundAdmin = () =>
    prisma.user.create({ data: { mobile: '0000000009', email: 'refunds@adione.test', fullName: 'Refund Admin', role: UserRole.SUPER_ADMIN } });
  const adminAlerts = (adminId: string) =>
    prisma.notification.findMany({ where: { userId: adminId, type: NotificationType.ADMIN_REFUND_FAILED } });

  it('a wrong-amount capture is never applied, is refunded exactly once (the amount actually taken), and the customer can pay again', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const paid = cashfree.attempt(checkout.providerOrderId, 'SUCCESS', { amountRupees: 1 });

    // The app's refresh (twice), the success webhook (twice — a duplicate delivery) and reconciliation all see it.
    for (let i = 0; i < 2; i += 1) {
      const res = await refresh(order);
      expect(res.status).toBe(400);
      expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
      expect(expectError(res.body).message).toMatch(/refunded automatically/);
    }
    const hook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, paid);
    for (let i = 0; i < 2; i += 1) expect((await deliver(hook)).status).toBe(200);
    await prisma.payment.update({ where: { id: checkout.paymentId }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    expect(await reconcileCheckoutPayments()).toBe(0);

    // Not paid, nothing placed or announced, stock still only held.
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    expect(await history(order)).toHaveLength(0);
    expect(await listing(order)).toMatchObject({ reservedQty: 2, stockQty: 10 });

    // Recorded as an orphan of what was ACTUALLY taken, refunded once for exactly that.
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    expect(row).toMatchObject({ status: 'CAPTURED', failureCode: 'ORPHAN_CAPTURE', amountPaise: 100, providerPaymentId: paid.cf_payment_id });
    expect(row.failureReason).toMatch(/^Amount mismatch/);
    const refunds = await prisma.refund.findMany({ where: { orderId: order.orderId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amountPaise: 100, paymentId: checkout.paymentId });
    expect(cashfree.refunds.size).toBe(1);
    expect([...cashfree.refunds.values()][0]).toMatchObject({ refund_amount: 1, order_id: checkout.providerOrderId });
    expect(await audits(order, 'payment.amount_mismatch')).toHaveLength(1);
    expect(await audits(order, 'payment.orphan_capture_refund')).toHaveLength(1);

    // Cashfree completes the refund: the payment is REFUNDED, the order is still simply unpaid.
    cashfree.settleRefund(cashfreeRefundId(refunds[0]!.id), 'SUCCESS');
    expect((await deliver(cashfree.refundWebhook(cashfreeRefundId(refunds[0]!.id)))).status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } })).status).toBe('REFUNDED');
    expect((await dbOrder(order)).paymentStatus).toBe('PENDING');

    // The customer pays the right amount on a fresh checkout — not reported as a "late payment".
    const again = await openCheckout(order);
    expect(again.providerOrderId).not.toBe(checkout.providerOrderId);
    expect(await refreshed(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, latePaymentRefund: false });
    cashfree.attempt(again.providerOrderId, 'SUCCESS');
    expect(await refreshed(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
    expect(await prisma.refund.count({ where: { orderId: order.orderId } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED', failureCode: null } })).toBe(1);
  });

  it('a capture in the wrong currency is never applied nor auto-refunded — admins are alerted once for a manual refund', async () => {
    const admin = await seedRefundAdmin();
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS', { currency: 'USD' });

    for (let i = 0; i < 2; i += 1) expect(expectError((await refresh(order)).body).code).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
    await prisma.payment.update({ where: { id: checkout.paymentId }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    await reconcileCheckoutPayments();

    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    expect(await prisma.refund.count({ where: { orderId: order.orderId } })).toBe(0);
    expect(cashfree.refunds.size).toBe(0);
    const alerts = await adminAlerts(admin.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toMatch(/MANUAL refund .* USD/);
    expect(await audits(order, 'payment.amount_mismatch')).toHaveLength(1);
  });

  it('a capture on a Cashfree order tagged for another order alerts admins once for manual review, and refunds nothing', async () => {
    const admin = await seedRefundAdmin();
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    cashfree.orderViewOverrides.set(checkout.providerOrderId, {
      order_tags: { adione_order_id: randomUUID(), adione_order_number: 'AD000OTHER' },
    });

    for (let i = 0; i < 2; i += 1) expect(expectError((await refresh(order)).body).code).toBe(ErrorCode.PAYMENT_VERIFICATION_FAILED);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    expect(cashfree.refunds.size).toBe(0);
    const alerts = await adminAlerts(admin.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toMatch(/MANUAL review/);
  });
});

describe('reconciliation — replaced checkouts and rows that keep failing', () => {
  const rowOf = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });

  async function replacedCheckout(order: OnlineOrder): Promise<{ first: Checkout; second: Checkout }> {
    const first = await openCheckout(order);
    await ageStoredSession(first);
    const second = await openCheckout(order);
    expect(second.providerOrderId).not.toBe(first.providerOrderId);
    expect(await rowOf(first.paymentId)).toMatchObject({ status: 'FAILED', failureCode: 'CHECKOUT_SUPERSEDED' });
    return { first, second };
  }

  it('settles a payment made on a just-replaced checkout when no webhook arrives and the app never checks', async () => {
    const order = await placeOnlineOrder();
    const { first, second } = await replacedCheckout(order);
    // Paid in the old checkout's final seconds; the webhook is lost; the phone never comes back.
    cashfree.attempt(first.providerOrderId, 'SUCCESS');

    expect(await reconcileCheckoutPayments()).toBe(1);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
    expect(await rowOf(first.paymentId)).toMatchObject({ status: 'CAPTURED', failureCode: null });
    expect((await rowOf(second.paymentId)).status).toBe('CREATED');

    // Idempotent: further sweeps, a late webhook and the app's refresh change nothing.
    expect(await reconcileCheckoutPayments()).toBe(0);
    const paid = cashfree.orders.get(first.providerOrderId)!.payments[0]!;
    expect((await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', first.providerOrderId, paid))).status).toBe(200);
    expect((await refreshed(order)).status).toBe(OrderStatus.PROCESSING);
    expect(await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } })).toBe(1);
    expect(await prisma.refund.count({ where: { orderId: order.orderId } })).toBe(0);
    expect(
      await prisma.orderStatusHistory.count({ where: { orderId: order.orderId, toStatus: OrderStatus.PAYMENT_CONFIRMED } }),
    ).toBe(1);
  });

  it('both the replaced and the new checkout paid: one is applied, the other refunded exactly once', async () => {
    const order = await placeOnlineOrder();
    const { first, second } = await replacedCheckout(order);
    cashfree.attempt(first.providerOrderId, 'SUCCESS');
    cashfree.attempt(second.providerOrderId, 'SUCCESS');
    await prisma.payment.update({ where: { id: second.paymentId }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });

    await reconcileCheckoutPayments();
    await reconcileCheckoutPayments();

    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
    const captured = await prisma.payment.findMany({ where: { orderId: order.orderId, status: 'CAPTURED' } });
    expect(captured).toHaveLength(2);
    expect(captured.filter((p) => p.failureCode === null)).toHaveLength(1);
    expect(captured.filter((p) => p.failureCode === 'ORPHAN_CAPTURE')).toHaveLength(1);
    expect(await prisma.refund.count({ where: { orderId: order.orderId } })).toBe(1);
    expect(cashfree.refunds.size).toBe(1);
  });

  it('an unpaid replaced checkout is re-checked only within its window, which never slides forward', async () => {
    const order = await placeOnlineOrder();
    const { first } = await replacedCheckout(order);
    const before = (await rowOf(first.paymentId)).updatedAt.getTime();
    const asked = () => cashfree.requests.filter((r) => r.method === 'GET' && r.path === `/orders/${first.providerOrderId}`).length;

    const askedBefore = asked();
    await reconcileCheckoutPayments();
    expect(asked()).toBe(askedBefore + 1); // re-checked
    expect((await rowOf(first.paymentId)).updatedAt.getTime()).toBe(before); // not re-stamped
    expect(await rowOf(first.paymentId)).toMatchObject({ status: 'FAILED', failureCode: 'CHECKOUT_SUPERSEDED' });

    // Past the window it is no longer asked about.
    await prisma.$executeRaw`UPDATE payments SET updated_at = now() - interval '16 minutes' WHERE id = ${first.paymentId}::uuid`;
    const askedLater = asked();
    await reconcileCheckoutPayments();
    expect(asked()).toBe(askedLater);
  });

  it('a row whose check fails is moved to the back of the queue, then settled on a later sweep', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    const old = new Date(Date.now() - 3 * 60_000);
    await prisma.$executeRaw`UPDATE payments SET created_at = ${old}, updated_at = ${old} WHERE id = ${checkout.paymentId}::uuid`;

    cashfree.failNext = { status: 500, code: 'internal_error', message: 'Cashfree is down' };
    expect(await reconcileCheckoutPayments()).toBe(0);
    const touched = await rowOf(checkout.paymentId);
    expect(touched.status).toBe('CREATED');
    expect(touched.updatedAt.getTime()).toBeGreaterThan(old.getTime() + 60_000);
    expect((await dbOrder(order)).status).toBe(OrderStatus.PENDING_PAYMENT);

    expect(await reconcileCheckoutPayments()).toBe(1);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
  });
});
