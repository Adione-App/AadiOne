/**
 * Payment confirmation → active orders, end to end (real app + database, an
 * in-memory Cashfree — tests/helpers/fake-cashfree.ts; only the network is
 * fake):
 *
 *   - GET /orders/active: every placed order of the customer on its way — COD
 *     from placement, online only once Cashfree's capture is verified; never
 *     an unpaid, failed, cancelled or delivered one; never someone else's;
 *   - confirmation from the webhook alone (app closed), exactly once under
 *     concurrent deliveries — one capture, one stock commit, one notice;
 *   - a paid order whose placement stopped half-way is finished by the next
 *     webhook / refresh / reconciliation, never twice;
 *   - a failed or abandoned attempt tells the customer once (also with the app
 *     closed) and never after the money is in; a Cashfree outage confirms
 *     nothing.
 * (Signatures, amount / currency / reference checks, duplicate and late
 * payments, forged app callbacks: tests/integration/cashfree-payment.test.ts.)
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

import { NotificationType, OrderStatus, PaymentMethod, type OrderSummaryDto } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { reconcileCheckoutPayments } from '../../src/modules/payments/payment.service';
import { releaseExpiredReservations } from '../../src/jobs';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

interface Customer {
  token: string;
  userId: string;
  addressId: string;
}

let storeId: string;

async function customer(mobile: string): Promise<Customer> {
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  return { token: session.accessToken, userId: session.userId, addressId: await seedAddress(session.userId) };
}

/** One product (₹200 × 2) in the cart, then an order with that payment method. */
async function placeOrder(who: Customer, method: PaymentMethod): Promise<{ orderId: string; listingId: string }> {
  const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
  await api().post('/api/v1/cart/items').set('Authorization', bearer(who.token)).send({ sellerListingId: product.storeVariantId, qty: 2 }).expect(200);
  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(who.token))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId: who.addressId, paymentMethod: method })
    .expect(201);
  return { orderId: expectSuccess<{ order: { id: string } }>(res.body).data.order.id, listingId: product.storeVariantId };
}

async function openCheckout(who: Customer, orderId: string): Promise<string> {
  const res = await api()
    .post('/api/v1/payments/create')
    .set('Authorization', bearer(who.token))
    .set('Idempotency-Key', randomUUID())
    .send({ orderId })
    .expect(200);
  return expectSuccess<{ providerOrderId: string }>(res.body).data.providerOrderId;
}

const deliver = (webhook: { raw: string; headers: Record<string, string> }) =>
  api().post('/api/v1/payments/webhook').set(webhook.headers).send(webhook.raw);

async function active(who: Customer): Promise<OrderSummaryDto[]> {
  const res = await api().get('/api/v1/orders/active').set('Authorization', bearer(who.token)).expect(200);
  return expectSuccess<{ items: OrderSummaryDto[] }>(res.body).data.items;
}

const notices = (userId: string, type: NotificationType) => prisma.notification.findMany({ where: { userId, type } });
const stockOf = async (listingId: string) => (await prisma.sellerListing.findUniqueOrThrow({ where: { id: listingId } })).stockQty;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  storeId = await seedStore();
});

/* -------------------------------------------------------------------------- */

describe('GET /orders/active', () => {
  it('an online order is not active while its payment is initiated or pending — only once Cashfree confirms it', async () => {
    const me = await customer('9400006001');
    const { orderId } = await placeOrder(me, PaymentMethod.ONLINE);
    expect(await active(me)).toEqual([]); // initiated

    const cfOrder = await openCheckout(me, orderId);
    const pending = cashfree.attempt(cfOrder, 'PENDING');
    await api().post(`/api/v1/payments/${orderId}/refresh`).set('Authorization', bearer(me.token)).expect(200);
    expect(await active(me)).toEqual([]); // pending / being verified
    // Still kept (My Orders, retry, reconciliation) — just not an active order.
    const listed = await api().get('/api/v1/orders').set('Authorization', bearer(me.token)).expect(200);
    expect(expectSuccess<{ items: OrderSummaryDto[] }>(listed.body).data.items[0]).toMatchObject({ id: orderId, status: OrderStatus.PENDING_PAYMENT });

    cashfree.finish(cfOrder, pending.cf_payment_id, 'SUCCESS');
    expect((await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', cfOrder, { ...pending, payment_status: 'SUCCESS' }))).status).toBe(200);
    expect(await active(me)).toMatchObject([{ id: orderId, status: OrderStatus.PROCESSING, paymentStatus: 'PAID' }]);
  });

  it('returns every active order of the customer — COD at once, paid online — newest placed first; never another customer\'s', async () => {
    const me = await customer('9400006002');
    const other = await customer('9400006003');
    const a = await placeOrder(me, PaymentMethod.COD);
    const b = await placeOrder(me, PaymentMethod.ONLINE);
    const cfOrder = await openCheckout(me, b.orderId);
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', cfOrder, cashfree.attempt(cfOrder, 'SUCCESS')));
    const c = await placeOrder(me, PaymentMethod.COD);
    await placeOrder(other, PaymentMethod.COD);

    const mine = await active(me);
    expect(mine.map((o) => o.id)).toEqual([c.orderId, b.orderId, a.orderId]);
    expect(mine.every((o) => o.status === OrderStatus.PROCESSING)).toBe(true);
    expect((await active(other)).map((o) => o.id)).not.toContain(a.orderId);
    expect((await active(other))).toHaveLength(1);
    expect((await api().get('/api/v1/orders/active')).status).toBe(401);

    // One order moving on leaves the others in place, each with its own status.
    await prisma.order.update({ where: { id: b.orderId }, data: { status: OrderStatus.OUT_FOR_DELIVERY } });
    const after = await active(me);
    expect(after).toHaveLength(3);
    expect(after.find((o) => o.id === b.orderId)?.status).toBe(OrderStatus.OUT_FOR_DELIVERY);
    expect(after.find((o) => o.id === a.orderId)?.status).toBe(OrderStatus.PROCESSING);
  });

  it('excludes delivered, cancelled and payment-failed orders', async () => {
    const me = await customer('9400006004');
    const delivered = await placeOrder(me, PaymentMethod.COD);
    const cancelled = await placeOrder(me, PaymentMethod.COD);
    const unpaid = await placeOrder(me, PaymentMethod.ONLINE);
    const kept = await placeOrder(me, PaymentMethod.COD);

    await prisma.order.update({ where: { id: delivered.orderId }, data: { status: OrderStatus.DELIVERED } });
    await api().post(`/api/v1/orders/${cancelled.orderId}/cancel`).set('Authorization', bearer(me.token)).send({ reason: 'Ordered by mistake' }).expect(200);
    // The unpaid order's hold runs out: PAYMENT_FAILED.
    await prisma.order.update({ where: { id: unpaid.orderId }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await releaseExpiredReservations();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unpaid.orderId } })).status).toBe(OrderStatus.PAYMENT_FAILED);

    expect((await active(me)).map((o) => o.id)).toEqual([kept.orderId]);
  });

  it('COD: active from placement, without any Cashfree call', async () => {
    const me = await customer('9400006005');
    const { orderId } = await placeOrder(me, PaymentMethod.COD);
    expect(await active(me)).toMatchObject([{ id: orderId, paymentMethod: PaymentMethod.COD, status: OrderStatus.PROCESSING }]);
    expect(cashfree.requests).toHaveLength(0);
  });
});

describe('confirmation is exactly once', () => {
  it('concurrent success webhooks (and an app refresh) place the order once: one capture, one stock commit, one notice', async () => {
    const me = await customer('9400006006');
    const { orderId, listingId } = await placeOrder(me, PaymentMethod.ONLINE);
    const cfOrder = await openCheckout(me, orderId);
    const payment = cashfree.attempt(cfOrder, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', cfOrder, payment);

    const results = await Promise.all([
      deliver(webhook),
      deliver(webhook),
      deliver(webhook),
      api().post(`/api/v1/payments/${orderId}/refresh`).set('Authorization', bearer(me.token)),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);

    expect(await prisma.payment.count({ where: { orderId, status: 'CAPTURED' } })).toBe(1);
    expect(await stockOf(listingId)).toBe(8);
    expect(await notices(me.userId, NotificationType.PAYMENT_SUCCESS)).toHaveLength(1);
    expect((await active(me)).map((o) => o.id)).toEqual([orderId]);
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId, toStatus: OrderStatus.PROCESSING } });
    expect(history).toHaveLength(1);
  });

  it('a paid order whose placement stopped half-way is finished by the next webhook or by reconciliation — never twice', async () => {
    const me = await customer('9400006007');
    const { orderId, listingId } = await placeOrder(me, PaymentMethod.ONLINE);
    const cfOrder = await openCheckout(me, orderId);
    const payment = cashfree.attempt(cfOrder, 'SUCCESS');
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', cfOrder, payment));
    expect(await stockOf(listingId)).toBe(8);

    // A crash between the two placement steps (paid + stock committed, not yet PROCESSING).
    await prisma.$executeRaw`UPDATE orders SET status = 'PAYMENT_CONFIRMED', updated_at = now() - interval '5 minutes' WHERE id = ${orderId}::uuid`;
    expect(await active(me)).toMatchObject([{ id: orderId, status: OrderStatus.PAYMENT_CONFIRMED }]);

    // The app's refresh (or a webhook retry) resumes it…
    await api().post(`/api/v1/payments/${orderId}/refresh`).set('Authorization', bearer(me.token)).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PROCESSING);

    // …and with nobody asking, reconciliation does.
    await prisma.$executeRaw`UPDATE orders SET status = 'PAYMENT_CONFIRMED', updated_at = now() - interval '5 minutes' WHERE id = ${orderId}::uuid`;
    await reconcileCheckoutPayments();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PROCESSING);

    // Stock was committed once, the customer told once.
    expect(await stockOf(listingId)).toBe(8);
    expect(await notices(me.userId, NotificationType.PAYMENT_SUCCESS)).toHaveLength(1);
    expect(await prisma.payment.count({ where: { orderId, status: 'CAPTURED' } })).toBe(1);
  });

  it('Cashfree unreachable when the success webhook arrives: nothing is confirmed; reconciliation places it later', async () => {
    const me = await customer('9400006008');
    const { orderId } = await placeOrder(me, PaymentMethod.ONLINE);
    const cfOrder = await openCheckout(me, orderId);
    const payment = cashfree.attempt(cfOrder, 'SUCCESS');

    cashfree.failNext = { status: 503, code: 'service_unavailable', message: 'Service unavailable' };
    expect((await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', cfOrder, payment))).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await active(me)).toEqual([]);
    expect(await notices(me.userId, NotificationType.PAYMENT_SUCCESS)).toHaveLength(0);
    expect((await prisma.paymentEvent.findFirstOrThrow()).error).toBeTruthy();

    // The app was closed; the gateway answers again a little later.
    await prisma.payment.updateMany({ where: { orderId }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    await reconcileCheckoutPayments();
    expect(await active(me)).toMatchObject([{ id: orderId, status: OrderStatus.PROCESSING }]);
    expect(await notices(me.userId, NotificationType.PAYMENT_SUCCESS)).toHaveLength(1);
  });
});

describe('failed and abandoned payments', () => {
  it('a failed attempt (app closed): one "payment failed" notice, no active order; a retry that succeeds places it', async () => {
    const me = await customer('9400006009');
    const { orderId } = await placeOrder(me, PaymentMethod.ONLINE);
    const cfOrder = await openCheckout(me, orderId);

    const failed = cashfree.attempt(cfOrder, 'FAILED');
    const webhook = cashfree.paymentWebhook('PAYMENT_FAILED_WEBHOOK', cfOrder, failed);
    await deliver(webhook);
    await deliver(webhook); // replay
    await deliver(cashfree.paymentWebhook('PAYMENT_FAILED_WEBHOOK', cfOrder, cashfree.attempt(cfOrder, 'FAILED'))); // a second failed attempt

    const failedNotices = await notices(me.userId, NotificationType.PAYMENT_FAILED);
    expect(failedNotices).toHaveLength(1);
    expect(failedNotices[0]).toMatchObject({ title: 'Payment failed', orderId });
    expect(failedNotices[0]!.body).toContain('try again');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await active(me)).toEqual([]);

    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', cfOrder, cashfree.attempt(cfOrder, 'SUCCESS')));
    expect(await active(me)).toMatchObject([{ id: orderId, status: OrderStatus.PROCESSING }]);
    expect(await notices(me.userId, NotificationType.PAYMENT_SUCCESS)).toHaveLength(1);
  });

  it('a cancelled payment (user dropped) is told as "not completed"', async () => {
    const me = await customer('9400006010');
    const { orderId } = await placeOrder(me, PaymentMethod.ONLINE);
    const cfOrder = await openCheckout(me, orderId);
    await deliver(cashfree.paymentWebhook('PAYMENT_USER_DROPPED_WEBHOOK', cfOrder, cashfree.attempt(cfOrder, 'USER_DROPPED')));
    const [notice] = await notices(me.userId, NotificationType.PAYMENT_FAILED);
    expect(notice).toMatchObject({ title: 'Payment not completed', orderId });
    expect(await active(me)).toEqual([]);
  });

  it('a failure arriving after the verified success never overwrites it and sends no failure notice', async () => {
    const me = await customer('9400006011');
    const { orderId } = await placeOrder(me, PaymentMethod.ONLINE);
    const cfOrder = await openCheckout(me, orderId);
    const failedEarlier = cashfree.attempt(cfOrder, 'FAILED');
    const succeeded = cashfree.attempt(cfOrder, 'SUCCESS');

    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', cfOrder, succeeded));
    await deliver(cashfree.paymentWebhook('PAYMENT_FAILED_WEBHOOK', cfOrder, failedEarlier)); // out of order, late

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
    expect(await notices(me.userId, NotificationType.PAYMENT_FAILED)).toHaveLength(0);
    expect(await active(me)).toMatchObject([{ id: orderId }]);
  });
});
