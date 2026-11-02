/**
 * An unpaid online checkout is not an order (orders/cart-retention.ts,
 * orders/open-checkout.ts):
 *
 *   - placing it leaves the cart exactly as it is; only a payment the server
 *     verified with Cashfree takes the ordered quantities out;
 *   - every way back without paying (UPI Back, checkout closed, insufficient
 *     balance, bank declined, still pending) leaves the cart untouched, and
 *     the refresh answer says which it is (`outcome`) — never failed while
 *     pending;
 *   - Pay Online again for the same cart REUSES the unpaid order; another
 *     payment method or a changed cart REPLACES it — never two orders;
 *     a payment still in progress refuses a new checkout;
 *   - it never shows as an order (Home, My Orders, "order placed" notice);
 *     cash on delivery is unchanged.
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

import { ConfigKey, ErrorCode, NotificationType, OrderStatus, PaymentMethod, type OrderSummaryDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { releaseExpiredReservations } from '../../src/jobs';
import { isSameCheckout, type OpenCheckoutShape } from '../../src/modules/orders/open-checkout';
import { paymentOutcomeOf } from '../../src/modules/payments/payment.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9400000961';

interface Refreshed {
  status: OrderStatus;
  paymentStatus: string;
  attemptPending: boolean;
  lastAttemptFailed: boolean;
  outcome: string;
}

interface Placed {
  order: { id: string; status: OrderStatus };
  payment?: { providerOrderId: string };
}

async function setup(options: { stockQty?: number } = {}) {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, stockQty: options.stockQty ?? 50 });
  await otpService.clearOtpState(MOBILE);
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);
  const auth = { Authorization: bearer(session.accessToken) };
  const listingId = product.storeVariantId;
  const add = (qty: number) => api().post('/api/v1/cart/items').set(auth).send({ sellerListingId: listingId, qty }).expect(200);
  const place = (method: PaymentMethod = PaymentMethod.ONLINE, key: string = randomUUID()) =>
    api()
      .post('/api/v1/orders')
      .set(auth)
      .set('Idempotency-Key', key)
      .send({ addressId, paymentMethod: method, ...(method === PaymentMethod.ONLINE ? { openPayment: true } : {}) });
  const placeOnline = async () => {
    const body = expectSuccess<Placed>((await place().expect(201)).body).data;
    return { orderId: body.order.id, cfOrderId: body.payment!.providerOrderId };
  };
  const refresh = async (orderId: string) =>
    expectSuccess<Refreshed>((await api().post(`/api/v1/payments/${orderId}/refresh`).set(auth).expect(200)).body).data;
  const lines = async () =>
    (await prisma.cartItem.findMany({ where: { cart: { userId: session.userId, status: 'ACTIVE' } } })).map((l) => [l.sellerListingId, l.qty]);
  const stock = async () => (await prisma.sellerListing.findUniqueOrThrow({ where: { id: listingId } })).reservedQty;
  return { auth, userId: session.userId, listingId, add, place, placeOnline, refresh, lines, stock };
}

const deliver = (webhook: { raw: string; headers: Record<string, string> }) =>
  api().post('/api/v1/payments/webhook').set(webhook.headers).send(webhook.raw);
const cashfreeOrderCreates = () => cashfree.requests.filter((r) => r.method === 'POST' && r.path === '/orders').length;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
});

describe('the cart is cleared only after a verified payment', () => {
  it('placing an online order leaves the cart as it is; the verified payment takes the lines out', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    expect(await t.lines()).toEqual([[t.listingId, 2]]);
    // Back with nothing paid: still the same cart.
    expect((await t.refresh(o.orderId)).outcome).toBe('NOT_PAID');
    expect(await t.lines()).toEqual([[t.listingId, 2]]);
    cashfree.attempt(o.cfOrderId, 'SUCCESS');
    const paid = await t.refresh(o.orderId);
    expect(paid).toMatchObject({ paymentStatus: 'PAID', outcome: 'PAID', status: OrderStatus.PROCESSING });
    expect(await t.lines()).toEqual([]);
  });

  it('a delayed webhook confirms the payment later — and only then is the cart used up', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    const pending = cashfree.attempt(o.cfOrderId, 'PENDING');
    expect((await t.refresh(o.orderId)).outcome).toBe('PENDING');
    expect(await t.lines()).toEqual([[t.listingId, 2]]);
    cashfree.finish(o.cfOrderId, pending.cf_payment_id, 'SUCCESS');
    expect((await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, { ...pending, payment_status: 'SUCCESS' }))).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).paymentStatus).toBe('PAID');
    expect(await t.lines()).toEqual([]);
  });

  it('lines the customer added after the checkout keep the difference when the payment succeeds', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    await t.add(3); // now 5 in the cart; 2 of them are being paid for
    cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await t.refresh(o.orderId);
    expect(await t.lines()).toEqual([[t.listingId, 3]]);
  });

  it('confirmed twice (refresh + webhook): the lines are taken out once', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    const paid = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await t.add(1); // 3 in the cart
    await Promise.all([t.refresh(o.orderId), deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, paid)), t.refresh(o.orderId)]);
    expect(await t.lines()).toEqual([[t.listingId, 1]]);
  });
});

describe('every way back without paying leaves the cart untouched, with the server-verified outcome', () => {
  it.each([
    ['UPI Back / user dropped', 'USER_DROPPED' as const, 'FAILED'],
    ['insufficient balance / bank declined', 'FAILED' as const, 'FAILED'],
    ['still pending at the bank', 'PENDING' as const, 'PENDING'],
  ])('%s', async (_name, attempt, outcome) => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    cashfree.attempt(o.cfOrderId, attempt);
    const back = await t.refresh(o.orderId);
    expect(back.outcome).toBe(outcome);
    expect(back.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(back.paymentStatus).not.toBe('PAID');
    expect(await t.lines()).toEqual([[t.listingId, 2]]);
  });

  it('Cashfree checkout closed with no attempt at all: NOT_PAID (nothing paid, nothing in progress)', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    expect((await t.refresh(o.orderId)).outcome).toBe('NOT_PAID');
  });

  it('the payment time running out ends the checkout; the cart is still exactly as it was (never doubled)', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    await prisma.order.update({ where: { id: o.orderId }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await releaseExpiredReservations();
    expect(await t.lines()).toEqual([[t.listingId, 2]]);
    expect(await t.stock()).toBe(0); // the hold was released
  });
});

describe('retry and another payment method never make a second order', () => {
  it('Pay Online again for the same cart (a new key) reuses the unpaid order and its Cashfree order', async () => {
    const t = await setup();
    await t.add(2);
    const first = await t.placeOnline();
    cashfree.attempt(first.cfOrderId, 'FAILED');
    const again = expectSuccess<Placed>((await t.place().expect(201)).body).data;
    expect(again.order.id).toBe(first.orderId);
    expect(again.payment?.providerOrderId).toBe(first.cfOrderId);
    expect(await prisma.order.count()).toBe(1);
    expect(cashfreeOrderCreates()).toBe(1);
    expect(await t.stock()).toBe(2); // one hold, not two
  });

  it('cash on delivery instead: the unpaid checkout is replaced (cancelled, hold released) and ONE order is placed', async () => {
    const t = await setup();
    await t.add(2);
    const unpaid = await t.placeOnline();
    cashfree.attempt(unpaid.cfOrderId, 'FAILED');
    const cod = expectSuccess<Placed>((await t.place(PaymentMethod.COD).expect(201)).body).data;
    expect(cod.order.id).not.toBe(unpaid.orderId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unpaid.orderId } })).status).toBe(OrderStatus.CANCELLED);
    expect(await prisma.order.count({ where: { status: { not: OrderStatus.CANCELLED } } })).toBe(1);
    // Cash on delivery is placed: its lines leave the cart now (unchanged behaviour).
    expect(await t.lines()).toEqual([]);
  });

  it('the cart changed before paying: the new checkout replaces the old one (one live order, the new quantities)', async () => {
    const t = await setup();
    await t.add(2);
    const old = await t.placeOnline();
    await t.add(1);
    const fresh = await t.placeOnline();
    expect(fresh.orderId).not.toBe(old.orderId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: old.orderId } })).status).toBe(OrderStatus.CANCELLED);
    const items = await prisma.orderItem.findMany({ where: { sellerOrder: { orderId: fresh.orderId } } });
    expect(items.map((i) => i.qty)).toEqual([3]);
    expect(await t.stock()).toBe(3);
  });

  it('a payment still in progress refuses a new checkout (it could charge twice) — nothing created, nothing cancelled', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    cashfree.attempt(o.cfOrderId, 'PENDING');
    for (const method of [PaymentMethod.ONLINE, PaymentMethod.COD]) {
      const res = await t.place(method);
      expect(res.status).toBe(409);
      expect(expectError(res.body).code).toBe(ErrorCode.ORDER_IN_PROGRESS);
    }
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('paid meanwhile (webhook not here yet): a new checkout confirms THAT order and is refused', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    cashfree.attempt(o.cfOrderId, 'SUCCESS');
    const res = await t.place(PaymentMethod.COD);
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_ALREADY_CAPTURED);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).paymentStatus).toBe('PAID');
    expect(await prisma.order.count()).toBe(1);
    expect(await t.lines()).toEqual([]);
  });

  it('repeated taps (several keys at once) for the same cart: one order, the cart untouched', async () => {
    const t = await setup();
    await t.add(2);
    const results = await Promise.all([t.place(), t.place(), t.place()]);
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => expectSuccess<Placed>(r.body).data.order.id));
    expect(ids.size).toBe(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await prisma.order.count()).toBe(1);
    expect(await t.lines()).toEqual([[t.listingId, 2]]);
  });
});

describe('an unpaid checkout is not an order', () => {
  it('not on Home, not in My Orders, no "order placed" notice — until the payment is verified', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    const activeRes = await api().get('/api/v1/orders/active').set(t.auth).expect(200);
    expect(expectSuccess<{ items: OrderSummaryDto[] }>(activeRes.body).data.items).toEqual([]);
    const list = await api().get('/api/v1/orders').set(t.auth).expect(200);
    expect(expectSuccess<{ items: OrderSummaryDto[] }>(list.body).data.items).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: t.userId, type: NotificationType.ORDER_PLACED } })).toBe(0);

    cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await t.refresh(o.orderId);
    const listed = await api().get('/api/v1/orders').set(t.auth).expect(200);
    expect(expectSuccess<{ items: OrderSummaryDto[] }>(listed.body).data.items.map((i) => i.id)).toEqual([o.orderId]);
    expect(await prisma.notification.count({ where: { userId: t.userId, type: NotificationType.PAYMENT_SUCCESS } })).toBe(1);
  });

  it('a checkout that ended unpaid stays out of My Orders (its record is kept)', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    await api().post(`/api/v1/orders/${o.orderId}/cancel`).set(t.auth).send({ reason: 'Changed my mind' }).expect(200);
    const list = await api().get('/api/v1/orders').set(t.auth).expect(200);
    expect(expectSuccess<{ items: OrderSummaryDto[] }>(list.body).data.items).toEqual([]);
    expect(await prisma.order.count()).toBe(1);
  });
});

describe('cash on delivery is unchanged', () => {
  it('placed at once: lines leave the cart, "order placed" is sent, it shows on Home', async () => {
    const t = await setup();
    await t.add(2);
    const cod = expectSuccess<Placed>((await t.place(PaymentMethod.COD).expect(201)).body).data;
    expect(cod.order.status).toBe(OrderStatus.PROCESSING);
    expect(await t.lines()).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: t.userId, type: NotificationType.ORDER_PLACED } })).toBe(1);
    const activeRes = await api().get('/api/v1/orders/active').set(t.auth).expect(200);
    expect(expectSuccess<{ items: OrderSummaryDto[] }>(activeRes.body).data.items.map((i) => i.id)).toEqual([cod.order.id]);
  });
});

describe('orders placed before this change (lines already out of the cart)', () => {
  it('still get their lines back when they end unpaid — once', async () => {
    const t = await setup();
    await t.add(2);
    const o = await t.placeOnline();
    // Simulate an order of the previous version: no mark, lines taken out at creation.
    await prisma.orderStatusHistory.updateMany({ where: { orderId: o.orderId, fromStatus: null }, data: { metadata: null as never } });
    await prisma.cartItem.deleteMany({ where: { cart: { userId: t.userId } } });
    await prisma.order.update({ where: { id: o.orderId }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await releaseExpiredReservations();
    await releaseExpiredReservations();
    expect(await t.lines()).toEqual([[t.listingId, 2]]);
  });
});

describe('pure rules', () => {
  const order = (o: Partial<OpenCheckoutShape> = {}): OpenCheckoutShape => ({
    totalPaise: 42000,
    couponCode: null,
    addressId: 'addr-1',
    deliveryMode: 'SAVED_ADDRESS',
    deliveryLatitude: 25,
    deliveryLongitude: 74,
    reservationExpiresAt: new Date(Date.now() + 10 * 60_000),
    sellerOrders: [{ sellerId: 's1', items: [{ variantId: 'v1', qty: 2 }] }],
    ...o,
  });
  const request = {
    paymentMethod: PaymentMethod.ONLINE,
    destination: { mode: 'SAVED_ADDRESS' as const, addressId: 'addr-1', latitude: 25, longitude: 74 },
    lines: [{ sellerId: 's1', variantId: 'v1', qty: 2 }],
    couponCode: null,
    expectedTotalPaise: 42000,
  };

  it('isSameCheckout: only the same lines, destination, coupon, total and online payment — with time left', () => {
    expect(isSameCheckout(order(), request)).toBe(true);
    expect(isSameCheckout(order(), { ...request, paymentMethod: PaymentMethod.COD })).toBe(false);
    expect(isSameCheckout(order(), { ...request, lines: [{ sellerId: 's1', variantId: 'v1', qty: 3 }] })).toBe(false);
    expect(isSameCheckout(order(), { ...request, destination: { ...request.destination, addressId: 'addr-2' } })).toBe(false);
    expect(isSameCheckout(order(), { ...request, couponCode: 'SAVE10' })).toBe(false);
    expect(isSameCheckout(order(), { ...request, expectedTotalPaise: 41000 })).toBe(false);
    expect(isSameCheckout(order({ reservationExpiresAt: new Date(Date.now() + 30_000) }), request)).toBe(false);
  });

  it('paymentOutcomeOf: paid wins; pending is never failed', () => {
    const base = { status: 'PENDING_PAYMENT' as never, paymentStatus: 'PENDING' as never, attemptPending: false, lastAttemptFailed: false, latePaymentRefund: false };
    expect(paymentOutcomeOf({ ...base, paymentStatus: 'PAID' as never, lastAttemptFailed: true })).toBe('PAID');
    expect(paymentOutcomeOf({ ...base, attemptPending: true, lastAttemptFailed: true })).toBe('PENDING');
    expect(paymentOutcomeOf({ ...base, lastAttemptFailed: true })).toBe('FAILED');
    expect(paymentOutcomeOf(base)).toBe('NOT_PAID');
    expect(paymentOutcomeOf({ ...base, status: 'CANCELLED' as never })).toBe('CLOSED');
    expect(paymentOutcomeOf({ ...base, status: 'CANCELLED' as never, latePaymentRefund: true })).toBe('LATE_REFUND');
  });
});
