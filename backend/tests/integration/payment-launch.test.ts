/**
 * "Pay Online" → Cashfree checkout in ONE round trip: POST /orders for an
 * online order sent with `openPayment: true` (the app) returns the Cashfree
 * session with the order, through exactly
 * the same checkout path as POST /payments/create (lock, server amount,
 * reuse of an open Cashfree order).
 *
 *   - the session is for the right Cashfree order and the server's amount;
 *     exactly one Cashfree order, reused by any later /payments/create;
 *   - repeated taps (the same idempotency key) and concurrent payment starts
 *     never open a second Cashfree order;
 *   - a session that cannot be opened never fails the order: the app opens
 *     it with /payments/create, as before;
 *   - the order is NOT confirmed by any of this — only verified payment does;
 *   - COD is untouched.
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

import { ConfigKey, OrderStatus, PaymentMethod } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9400000811';

interface PlacedBody {
  order: { id: string; status: string; paymentStatus: string; bill: { totalPaise: number } };
  requiresPayment: boolean;
  payment?: {
    paymentId: string;
    providerOrderId: string;
    amountPaise: number;
    publicKey: string;
    cashfree?: { paymentSessionId: string; orderId: string; environment: string };
  };
}

async function cartReady(method: PaymentMethod = PaymentMethod.ONLINE) {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, stockQty: 10 });
  await otpService.clearOtpState(MOBILE);
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: product.storeVariantId, qty: 2 }).expect(200);
  // The app asks for the session with the order (`openPayment`); `legacy` is an older app.
  const place = (key: string = randomUUID(), legacy = false) =>
    api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', key)
      .send({ addressId, paymentMethod: method, ...(legacy ? {} : { openPayment: true }) });
  return { token: session.accessToken, place };
}

const cashfreeOrderCreates = () => cashfree.requests.filter((r) => r.method === 'POST' && r.path === '/orders').length;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
});

describe('the Cashfree session comes with the online order', () => {
  it('for the right Cashfree order and the server’s amount — one Cashfree order, reused by /payments/create; nothing confirmed', async () => {
    const { token, place } = await cartReady();
    const res = await place().expect(201);
    const body = expectSuccess<PlacedBody>(res.body).data;

    expect(body.requiresPayment).toBe(true);
    expect(body.payment?.cashfree).toBeDefined();
    const payment = body.payment!;
    // The server's amount, the order it belongs to, nothing secret.
    expect(payment.amountPaise).toBe(body.order.bill.totalPaise);
    expect(payment.cashfree!.orderId).toBe(payment.providerOrderId);
    expect(payment.publicKey).toBe('');
    expect(JSON.stringify(payment)).not.toContain('cf_test_secret');
    const rows = await prisma.payment.findMany({ where: { orderId: body.order.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: payment.paymentId, providerOrderId: payment.providerOrderId, amountPaise: body.order.bill.totalPaise, status: 'CREATED' });
    const gatewayOrder = cashfree.orders.get(payment.providerOrderId)!;
    expect(Math.round(gatewayOrder.order_amount * 100)).toBe(body.order.bill.totalPaise);
    expect(cashfreeOrderCreates()).toBe(1);

    // Never confirmed by opening a checkout: still awaiting payment, sellers not told.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: body.order.id } });
    expect([order.status, order.paymentStatus]).toEqual([OrderStatus.PENDING_PAYMENT, 'PENDING']);
    expect(await prisma.notification.count({ where: { type: 'SELLER_NEW_ORDER' } })).toBe(0);

    // An older app (or a retry) asking /payments/create gets the SAME Cashfree order.
    const again = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: body.order.id })
      .expect(200);
    expect(expectSuccess<{ cashfree: { paymentSessionId: string; orderId: string } }>(again.body).data.cashfree).toEqual(
      expect.objectContaining({ paymentSessionId: payment.cashfree!.paymentSessionId, orderId: payment.providerOrderId }),
    );
    expect(cashfreeOrderCreates()).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: body.order.id } })).toBe(1);
  });

  it('repeated taps (the same idempotency key, even at once) give one order and one Cashfree order', async () => {
    const { place } = await cartReady();
    const key = randomUUID();
    const results = await Promise.all([place(key), place(key), place(key)]);
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    const sessions = new Set(ok.map((r) => expectSuccess<PlacedBody>(r.body).data.payment?.cashfree?.paymentSessionId));
    expect(sessions.size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    expect(cashfreeOrderCreates()).toBe(1);
    // A later replay of the same key returns the same order and session.
    const replay = expectSuccess<PlacedBody>((await place(key).expect(201)).body).data;
    expect(replay.payment?.cashfree?.paymentSessionId).toBe([...sessions][0]);
    expect(cashfreeOrderCreates()).toBe(1);
  });

  it('a session that cannot be opened never fails the order; the app opens it with /payments/create — concurrent starts make one Cashfree order', async () => {
    const { token, place } = await cartReady();
    // Cashfree refuses the first order creation.
    cashfree.failNext = { status: 500, code: 'internal_error', message: 'temporarily unavailable' };
    const res = await place().expect(201);
    const body = expectSuccess<PlacedBody>(res.body).data;
    expect(body.requiresPayment).toBe(true);
    expect(body.payment).toBeUndefined();
    expect(await prisma.payment.count({ where: { orderId: body.order.id } })).toBe(0);

    // Three starts at once (two taps and a retry): one Cashfree order.
    const starts = await Promise.all(
      [0, 1, 2].map(() =>
        api().post('/api/v1/payments/create').set('Authorization', bearer(token)).set('Idempotency-Key', randomUUID()).send({ orderId: body.order.id }),
      ),
    );
    for (const s of starts) expect(s.status).toBe(200);
    const ids = new Set(starts.map((s) => expectSuccess<{ providerOrderId: string }>(s.body).data.providerOrderId));
    expect(ids.size).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: body.order.id, status: 'CREATED' } })).toBe(1);
  });

  it('an order without openPayment (older apps) is exactly as before: no session, no Cashfree call until /payments/create', async () => {
    const { token, place } = await cartReady();
    const body = expectSuccess<PlacedBody>((await place(randomUUID(), true).expect(201)).body).data;
    expect(body.requiresPayment).toBe(true);
    expect(body.payment).toBeUndefined();
    expect(cashfreeOrderCreates()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    await api().post('/api/v1/payments/create').set('Authorization', bearer(token)).set('Idempotency-Key', randomUUID()).send({ orderId: body.order.id }).expect(200);
    expect(cashfreeOrderCreates()).toBe(1);
  });

  it('Cash on Delivery is unchanged: no session, no Cashfree call', async () => {
    const { place } = await cartReady(PaymentMethod.COD);
    const body = expectSuccess<PlacedBody>((await place().expect(201)).body).data;
    expect(body.requiresPayment).toBe(false);
    expect(body.payment).toBeUndefined();
    expect(cashfree.requests).toEqual([]);
  });

  it('online payment switched off: the order is refused before anything is created (unchanged)', async () => {
    const { place } = await cartReady();
    await configService.set({ key: ConfigKey.PAYMENT_ONLINE_ENABLED, value: false as never });
    const res = await place();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.order.count()).toBe(0);
    expect(cashfreeOrderCreates()).toBe(0);
  });
});
