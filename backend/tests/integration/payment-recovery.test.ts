/**
 * Payment recovery after Cashfree's checkout closes — what the server says
 * for every way a customer comes back, and that nothing here can confirm,
 * fail or duplicate anything on the app's word:
 *
 *   - back from a UPI app without paying / checkout closed: still payable,
 *     not failed, not cancelled; the SAME Cashfree order is reused;
 *   - an attempt still pending at the bank: pending, never confirmed;
 *   - a definitive failure: payable again, the customer told once;
 *   - success that arrives late (bank answer, then webhook): confirmed
 *     automatically, exactly once — duplicate refreshes and webhooks change
 *     nothing, no refund is created;
 *   - the cart: an unpaid order's lines come back when it ends unpaid
 *     (customer cancel, payment window expired) — once; a paid order's never.
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
import { releaseExpiredReservations } from '../../src/jobs';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9400000931';

interface Refreshed {
  status: OrderStatus;
  paymentStatus: string;
  lastAttemptFailed: boolean;
  attemptPending?: boolean;
  latePaymentRefund: boolean;
}

async function placedOnline() {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, stockQty: 10 });
  await otpService.clearOtpState(MOBILE);
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);
  const auth = { Authorization: bearer(session.accessToken) };
  await api().post('/api/v1/cart/items').set(auth).send({ sellerListingId: product.storeVariantId, qty: 2 }).expect(200);
  const res = await api()
    .post('/api/v1/orders')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.ONLINE, openPayment: true })
    .expect(201);
  const body = expectSuccess<{ order: { id: string }; payment?: { providerOrderId: string } }>(res.body).data;
  expect(body.payment?.providerOrderId).toBeTruthy();
  return {
    auth,
    userId: session.userId,
    orderId: body.order.id,
    cfOrderId: body.payment!.providerOrderId,
    listingId: product.storeVariantId,
  };
}

type Placed = Awaited<ReturnType<typeof placedOnline>>;

const refresh = async (o: Placed) =>
  expectSuccess<Refreshed>((await api().post(`/api/v1/payments/${o.orderId}/refresh`).set(o.auth).expect(200)).body).data;

const reopen = async (o: Placed) =>
  expectSuccess<{ providerOrderId: string }>(
    (await api().post('/api/v1/payments/create').set(o.auth).set('Idempotency-Key', randomUUID()).send({ orderId: o.orderId }).expect(200)).body,
  ).data;

const deliver = (webhook: { raw: string; headers: Record<string, string> }) =>
  api().post('/api/v1/payments/webhook').set(webhook.headers).send(webhook.raw);

const cartLines = async (userId: string) =>
  prisma.cartItem.findMany({ where: { cart: { userId, status: 'ACTIVE' } }, select: { sellerListingId: true, qty: true } });

const cashfreeOrderCreates = () => cashfree.requests.filter((r) => r.method === 'POST' && r.path === '/orders').length;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
});

describe('coming back from Cashfreeʼs checkout without paying', () => {
  it('back from a UPI app with nothing paid: still payable — not failed, not cancelled, nothing confirmed; the same Cashfree order is reused', async () => {
    const o = await placedOnline();
    const back = await refresh(o);
    expect(back).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING', lastAttemptFailed: false, latePaymentRefund: false });
    expect(back.attemptPending ?? false).toBe(false);
    // Continue payment: the same Cashfree order, no second one.
    expect((await reopen(o)).providerOrderId).toBe(o.cfOrderId);
    expect(cashfreeOrderCreates()).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'SELLER_NEW_ORDER' } })).toBe(0);
  });

  it('checkout closed after an abandoned attempt (USER_DROPPED): the order stays payable, nothing is failed or refunded', async () => {
    const o = await placedOnline();
    cashfree.attempt(o.cfOrderId, 'USER_DROPPED');
    const back = await refresh(o);
    expect(back.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(back.paymentStatus).not.toBe('PAID');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await reopen(o)).providerOrderId).toBe(o.cfOrderId);
    expect(await prisma.refund.count()).toBe(0);
  });
});

describe('pending, failure and late success', () => {
  it('an attempt pending at the bank is pending — never confirmed; the bank answers later and the webhook confirms it once', async () => {
    const o = await placedOnline();
    const pending = cashfree.attempt(o.cfOrderId, 'PENDING');
    const first = await refresh(o);
    expect(first.attemptPending).toBe(true);
    expect(first.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(first.paymentStatus).not.toBe('PAID');

    // The UPI app finishes after the customer is back; the webhook arrives late.
    const paid = cashfree.finish(o.cfOrderId, pending.cf_payment_id, 'SUCCESS');
    expect((await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, paid))).status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.paymentStatus).toBe('PAID');
    expect(order.status).not.toBe(OrderStatus.PENDING_PAYMENT);
    // The app's next check (resume / reopen) sees the confirmed order.
    expect((await refresh(o)).paymentStatus).toBe('PAID');
  });

  it('a definitive failure: payable again (same Cashfree order), the customer told once, the order not failed', async () => {
    const o = await placedOnline();
    cashfree.attempt(o.cfOrderId, 'FAILED');
    const back = await refresh(o);
    expect(back).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, lastAttemptFailed: true });
    await refresh(o);
    expect(await prisma.notification.count({ where: { dedupeKey: `order:${o.orderId}:payment-attempt-failed` } })).toBe(1);
    expect((await reopen(o)).providerOrderId).toBe(o.cfOrderId);
  });

  it('an SDK "success" is not payment: with nothing paid at Cashfree the order stays unconfirmed', async () => {
    const o = await placedOnline();
    // The app reports nothing to the server but asks it to check; Cashfree has no payment.
    const back = await refresh(o);
    expect(back.paymentStatus).not.toBe('PAID');
    expect(back.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('duplicate callbacks: concurrent refreshes and repeated webhooks confirm once — one captured payment, no refund, each notice once', async () => {
    const o = await placedOnline();
    const paid = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, paid);
    const results = await Promise.all([refresh(o), refresh(o), refresh(o), deliver(webhook), deliver(webhook)]);
    for (const r of results.slice(3) as { status: number }[]) expect(r.status).toBe(200);
    expect((await refresh(o)).paymentStatus).toBe('PAID');

    expect(await prisma.payment.count({ where: { orderId: o.orderId, status: 'CAPTURED' } })).toBe(1);
    expect(await prisma.refund.count()).toBe(0);
    expect(await prisma.order.count()).toBe(1);
    // Each lifecycle step recorded once, each notice sent once.
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId: o.orderId }, select: { toStatus: true } });
    expect(new Set(history.map((h) => h.toStatus)).size).toBe(history.length);
    const notices = await prisma.notification.findMany({ where: { orderId: o.orderId }, select: { type: true, userId: true } });
    expect(notices.length).toBeGreaterThan(0);
    expect(new Set(notices.map((n) => `${n.type}|${n.userId}`)).size).toBe(notices.length);
  });
});

describe('the cart is used up only by a paid order', () => {
  it('placing takes the lines out (reserved on the unpaid order); cancelling the unpaid order puts them back — once', async () => {
    const o = await placedOnline();
    expect(await cartLines(o.userId)).toEqual([]);
    await api().post(`/api/v1/orders/${o.orderId}/cancel`).set(o.auth).send({ reason: 'Changed my mind' }).expect(200);
    expect(await cartLines(o.userId)).toEqual([{ sellerListingId: o.listingId, qty: 2 }]);
    // A second cancel is refused / a no-op: never doubled.
    await api().post(`/api/v1/orders/${o.orderId}/cancel`).set(o.auth).send({ reason: 'Again' });
    expect(await cartLines(o.userId)).toEqual([{ sellerListingId: o.listingId, qty: 2 }]);
  });

  it('the payment window expiring puts the lines back — once, however often the job runs', async () => {
    const o = await placedOnline();
    await prisma.order.update({ where: { id: o.orderId }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await releaseExpiredReservations();
    await releaseExpiredReservations();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(await cartLines(o.userId)).toEqual([{ sellerListingId: o.listingId, qty: 2 }]);
  });

  it('a paid order never gives its lines back', async () => {
    const o = await placedOnline();
    cashfree.attempt(o.cfOrderId, 'SUCCESS');
    expect((await refresh(o)).paymentStatus).toBe('PAID');
    await releaseExpiredReservations();
    expect(await cartLines(o.userId)).toEqual([]);
  });
});
