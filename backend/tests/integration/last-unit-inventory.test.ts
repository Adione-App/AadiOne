/**
 * The online-payment stock lifecycle, at the LAST unit (stock = 1):
 *
 *   placing an online order HOLDS the unit (reserved_qty) — it is never
 *   sold until Cashfree's own answer confirms the payment; the hold is
 *   released when the order ends unpaid (cancelled, or the payment window
 *   runs out — jobs/releaseExpiredReservations), and a payment that arrives
 *   after that is refunded, never applied to stock that is gone.
 *
 * The bug this file pins: the customer's OWN hold made their own cart say
 * "OUT OF STOCK" after they came back from Cashfree without paying, cut
 * their quantities down, and refused "Retry payment" — although nothing was
 * sold (orders/own-checkout-holds.ts). Every other customer still sees the
 * held unit as taken.
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

// The real inventory functions, observable — so one test can make the stock
// commit fail once, mid-confirmation, and prove the whole step rolls back.
vi.mock('../../src/modules/inventory/inventory.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/inventory/inventory.service')>();
  return { ...actual, commitReservation: vi.fn(actual.commitReservation) };
});

import { ConfigKey, ErrorCode, NotificationType, OrderStatus, PaymentMethod, type CartDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import * as inventoryService from '../../src/modules/inventory/inventory.service';
import { reconcilePayments, releaseExpiredReservations } from '../../src/jobs';
import { trackedAvailableQtyFor } from '../../src/modules/inventory/stock-rules';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE_A = '9400000971';
const MOBILE_B = '9400000972';

interface Placed {
  order: { id: string; status: OrderStatus };
  payment?: { providerOrderId: string };
}

async function customer(mobile: string) {
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  const addressId = await seedAddress(session.userId);
  const auth = { Authorization: bearer(session.accessToken) };
  const add = (sellerListingId: string, qty: number) => api().post('/api/v1/cart/items').set(auth).send({ sellerListingId, qty });
  const place = (method: PaymentMethod = PaymentMethod.ONLINE) =>
    api()
      .post('/api/v1/orders')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: method, ...(method === PaymentMethod.ONLINE ? { openPayment: true } : {}) });
  const placeOnline = async () => {
    const body = expectSuccess<Placed>((await place().expect(201)).body).data;
    return { orderId: body.order.id, cfOrderId: body.payment!.providerOrderId };
  };
  const cart = async () => expectSuccess<CartDto>((await api().get('/api/v1/cart').set(auth).expect(200)).body).data;
  const refresh = async (orderId: string) =>
    expectSuccess<{ status: OrderStatus; outcome: string }>((await api().post(`/api/v1/payments/${orderId}/refresh`).set(auth).expect(200)).body).data;
  return { userId: session.userId, auth, add, place, placeOnline, cart, refresh };
}

async function lastUnit(stockQty = 1) {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, stockQty });
  return { storeId, listingId: product.storeVariantId };
}

const listing = (id: string) => prisma.sellerListing.findUniqueOrThrow({ where: { id }, select: { stockQty: true, reservedQty: true } });
const ledger = (sellerListingId: string, reason: string) =>
  prisma.stockLedger.count({ where: { sellerListingId, reason: reason as never } });
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const deliver = (webhook: { raw: string; headers: Record<string, string> }) =>
  api().post('/api/v1/payments/webhook').set(webhook.headers).send(webhook.raw).expect(200);
/** The payment window ran out (the gateway order and the AdiOne hold both ended). */
async function runOutOfTime(orderId: string, cfOrderId: string) {
  cashfree.expire(cfOrderId);
  await prisma.order.update({ where: { id: orderId }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  // The catalogue's in-process category cache outlives the truncate above.
  invalidateCategoryCache();
  cashfree.reset();
  vi.mocked(inventoryService.commitReservation).mockClear();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
});

describe('1–2. the last unit in the cart, and opening the online payment', () => {
  it('the last unit can be added; opening Cashfree HOLDS it (stock unchanged) — nothing is sold', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    expect((await a.add(listingId, 1)).status).toBe(200);
    const line = (await a.cart()).items[0]!;
    expect(line).toMatchObject({ available: true, availableQty: 1, qty: 1 });

    await a.placeOnline();
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
    expect(await ledger(listingId, 'ORDER_RESERVE')).toBe(1);
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(0);
  });
});

describe('6 & 16. back from Cashfree without paying: the customer\'s own cart (THE REPORTED BUG)', () => {
  it.each([
    ['closed the checkout (no attempt)', null],
    ['user dropped', 'USER_DROPPED' as const],
    ['payment failed', 'FAILED' as const],
  ])('%s: still available to them, quantity untouched, checkout (retry) allowed', async (_name, attempt) => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    if (attempt) cashfree.attempt(o.cfOrderId, attempt);
    expect((await a.refresh(o.orderId)).status).toBe(OrderStatus.PENDING_PAYMENT);

    const cart = await a.cart();
    expect(cart.items[0]).toMatchObject({ available: true, inStock: true, availableQty: 1, qty: 1, unavailableReason: null });
    expect(cart.availableCheckoutEnabled).toBe(true);
    expect(cart.changes).toEqual([]);
    // Nothing was sold or released behind the scenes.
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
  });

  it('a partial hold never cuts the customer\'s own quantity (stock 3, 2 being paid for)', async () => {
    const { listingId } = await lastUnit(3);
    const a = await customer(MOBILE_A);
    await a.add(listingId, 2);
    const o = await a.placeOnline();
    await a.refresh(o.orderId);
    const cart = await a.cart();
    expect(cart.items[0]).toMatchObject({ qty: 2, availableQty: 3, available: true });
    expect(cart.changes).toEqual([]);
    expect((await prisma.cartItem.findFirstOrThrow({})).qty).toBe(2);
    // …and may still add the third unit (the hold is theirs).
    expect((await a.add(listingId, 1)).status).toBe(200);
  });

  it('everyone else still sees the held unit as taken — and cannot add it', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    const b = await customer(MOBILE_B);
    await a.add(listingId, 1);
    await a.placeOnline();
    const res = await b.add(listingId, 1);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(expectError(res.body).code).toBe(ErrorCode.ITEM_OUT_OF_STOCK);
  });
});

describe('3. success through the verified webhook', () => {
  it('commits the held unit exactly once and confirms the order', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    const paid = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, paid));
    expect((await order(o.orderId)).status).toBe(OrderStatus.PROCESSING);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(1);
  });

  it('a success the gateway does not confirm (forged / not-yet-paid order) commits nothing', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    // A correctly signed SUCCESS notice, but Cashfree's own order says unpaid.
    const fakeNotice = { ...cashfree.attempt(o.cfOrderId, 'PENDING'), payment_status: 'SUCCESS' as const };
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, fakeNotice));
    expect((await order(o.orderId)).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(0);
  });
});

describe('4, 5 & 7. the unit goes back on sale when the order ends unpaid', () => {
  it('4. a failed payment: the hold lasts only until the payment window ends, then the unit is released', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    const failed = cashfree.attempt(o.cfOrderId, 'FAILED');
    await deliver(cashfree.paymentWebhook('PAYMENT_FAILED_WEBHOOK', o.cfOrderId, failed));
    // One failed attempt is not the end: the same Cashfree checkout can still be paid.
    expect((await order(o.orderId)).status).toBe(OrderStatus.PENDING_PAYMENT);
    await runOutOfTime(o.orderId, o.cfOrderId);
    await releaseExpiredReservations();
    expect((await order(o.orderId)).status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_RELEASE')).toBe(1);
    // Never announced as an order.
    expect(await prisma.notification.count({ where: { type: { in: [NotificationType.ORDER_PLACED, NotificationType.PAYMENT_SUCCESS] } } })).toBe(0);
  });

  it('5. the customer cancels the unpaid checkout: released at once, the cart keeps the line (available)', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    cashfree.attempt(o.cfOrderId, 'USER_DROPPED');
    await api().post(`/api/v1/orders/${o.orderId}/cancel`).set(a.auth).send({ reason: 'Changed my mind' }).expect(200);
    expect((await order(o.orderId)).status).toBe(OrderStatus.CANCELLED);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 0 });
    expect((await a.cart()).items[0]).toMatchObject({ available: true, qty: 1 });
  });

  it('7. the payment window runs out: released by the worker, another customer can then buy the unit', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    const b = await customer(MOBILE_B);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    expect((await b.add(listingId, 1)).status).toBeGreaterThanOrEqual(400);
    await runOutOfTime(o.orderId, o.cfOrderId);
    await releaseExpiredReservations();
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 0 });
    expect((await b.add(listingId, 1)).status).toBe(200);
    const bCod = expectSuccess<Placed>((await b.place(PaymentMethod.COD).expect(201)).body).data;
    expect(bCod.order.status).toBe(OrderStatus.PROCESSING);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
  });
});

describe('8. retry after a failed attempt', () => {
  it('Pay Online again reuses the same order and hold; the retry\'s success commits once', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const first = await a.placeOnline();
    cashfree.attempt(first.cfOrderId, 'FAILED');
    await a.refresh(first.orderId);
    // Was refused before the fix: the cart had marked the held line unavailable.
    const again = await a.placeOnline();
    expect(again.orderId).toBe(first.orderId);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
    cashfree.attempt(again.cfOrderId, 'SUCCESS');
    await a.refresh(again.orderId);
    expect((await order(first.orderId)).status).toBe(OrderStatus.PROCESSING);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(1);
    expect(await prisma.order.count()).toBe(1);
  });

  it('retry with a changed cart replaces the checkout: old hold released, ONE new hold', async () => {
    const { listingId } = await lastUnit(3);
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const first = await a.placeOnline();
    cashfree.attempt(first.cfOrderId, 'USER_DROPPED');
    expect((await a.add(listingId, 1)).status).toBe(200);
    const second = await a.placeOnline();
    expect(second.orderId).not.toBe(first.orderId);
    expect((await order(first.orderId)).status).toBe(OrderStatus.CANCELLED);
    expect(await listing(listingId)).toEqual({ stockQty: 3, reservedQty: 2 });
  });
});

describe('9–11. duplicate and out-of-order webhooks', () => {
  it('9. the success webhook twice (plus the app\'s refresh): stock deducted once', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    const paid = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, paid);
    await Promise.all([deliver(webhook), deliver(webhook), a.refresh(o.orderId)]);
    await deliver(webhook);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: o.orderId, status: 'CAPTURED' } })).toBe(1);
  });

  it('10. the failure webhook twice: nothing moves, the customer is told once', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    const failed = cashfree.attempt(o.cfOrderId, 'FAILED');
    const webhook = cashfree.paymentWebhook('PAYMENT_FAILED_WEBHOOK', o.cfOrderId, failed);
    await deliver(webhook);
    await deliver(webhook);
    expect((await order(o.orderId)).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
    expect(await ledger(listingId, 'ORDER_RELEASE')).toBe(0);
    expect(await prisma.notification.count({ where: { userId: a.userId, type: NotificationType.PAYMENT_FAILED } })).toBe(1);
  });

  it('11. an older attempt\'s failure arriving after the newer attempt was paid changes nothing', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    const oldAttempt = cashfree.attempt(o.cfOrderId, 'FAILED');
    const newAttempt = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, newAttempt));
    await deliver(cashfree.paymentWebhook('PAYMENT_FAILED_WEBHOOK', o.cfOrderId, oldAttempt));
    await deliver(cashfree.paymentWebhook('PAYMENT_USER_DROPPED_WEBHOOK', o.cfOrderId, { ...oldAttempt, payment_status: 'USER_DROPPED' }));
    const after = await order(o.orderId);
    expect(after).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(1);
    expect(await ledger(listingId, 'ORDER_RELEASE')).toBe(0);
  });
});

describe('12. a success that arrives after the hold expired', () => {
  it('the unit already sold to someone else is never sold twice: the late payment is refunded', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    const b = await customer(MOBILE_B);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    await runOutOfTime(o.orderId, o.cfOrderId);
    await releaseExpiredReservations();
    await b.add(listingId, 1);
    await b.place(PaymentMethod.COD).expect(201);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });

    const late = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, late));
    expect((await order(o.orderId)).status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(1); // B's only
    expect(await prisma.refund.count({ where: { orderId: o.orderId } })).toBe(1);
    // The same late notice again: still one refund.
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, late));
    expect(await prisma.refund.count({ where: { orderId: o.orderId } })).toBe(1);
  });
});

describe('13. two customers, one unit', () => {
  it('both have it in the cart and pay at the same moment: exactly one hold succeeds', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    const b = await customer(MOBILE_B);
    await a.add(listingId, 1);
    await b.add(listingId, 1);
    const [ra, rb] = await Promise.all([a.place(), b.place()]);
    expect([ra.status, rb.status].filter((s) => s === 201)).toHaveLength(1);
    expect(await prisma.order.count({ where: { status: OrderStatus.PENDING_PAYMENT } })).toBe(1);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });

    // The loser's cart shows it taken; the winner's shows it theirs.
    const [winner, loser] = ra.status === 201 ? [a, b] : [b, a];
    expect((await winner.cart()).items[0]).toMatchObject({ available: true });
    expect((await loser.cart()).items[0]).toMatchObject({ available: false });

    // The winner's payment fails and the window ends: the other one can buy it.
    const winnerOrder = (await prisma.order.findFirstOrThrow({ where: { status: OrderStatus.PENDING_PAYMENT } })).id;
    const cfOrderId = (await prisma.payment.findFirstOrThrow({ where: { orderId: winnerOrder } })).providerOrderId!;
    cashfree.attempt(cfOrderId, 'FAILED');
    await runOutOfTime(winnerOrder, cfOrderId);
    await releaseExpiredReservations();
    expect((await loser.cart()).items[0]).toMatchObject({ available: true });
    expect((await loser.place()).status).toBe(201);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
  });
});

describe('14. cash on delivery', () => {
  it('sold at placement (one commit, no payment window); the release job never touches it', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const cod = expectSuccess<Placed>((await a.place(PaymentMethod.COD).expect(201)).body).data;
    expect(cod.order.status).toBe(OrderStatus.PROCESSING);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(1);
    await prisma.order.update({ where: { id: cod.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await releaseExpiredReservations();
    expect((await order(cod.order.id)).status).toBe(OrderStatus.PROCESSING);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
  });
});

describe('15. multi-seller orders', () => {
  async function secondStore(): Promise<string> {
    const first = await prisma.seller.findFirstOrThrow({ where: { code: 'TEST' }, include: { hours: true } });
    const { id: _id, code: _code, createdAt: _created, updatedAt: _updated, hours, ...fields } = first;
    const second = await prisma.seller.create({ data: { ...fields, code: 'TEST2', name: 'Second Store', isPlatformOwned: false } });
    await prisma.sellerHours.createMany({
      data: hours.map(({ id: _hid, sellerId: _sid, ...h }) => ({ ...h, sellerId: second.id })),
    });
    return second.id;
  }

  it('each seller\'s last unit is held, then committed once on success / released on expiry', async () => {
    const { listingId: first } = await lastUnit();
    const secondId = await secondStore();
    const second = (await seedProduct(secondId, { pricePaise: 15000, stockQty: 1 })).storeVariantId;
    const a = await customer(MOBILE_A);
    await a.add(first, 1);
    await a.add(second, 1);

    const unpaid = await a.placeOnline();
    expect(await prisma.sellerOrder.count({ where: { orderId: unpaid.orderId } })).toBe(2);
    expect(await listing(first)).toEqual({ stockQty: 1, reservedQty: 1 });
    expect(await listing(second)).toEqual({ stockQty: 1, reservedQty: 1 });
    // Back without paying: both lines still the customer's — and marked as
    // held for them, so both sellers' product cards show it too.
    await a.refresh(unpaid.orderId);
    const held = (await a.cart()).items;
    expect(held.every((item) => item.available)).toBe(true);
    expect(held.map((item) => item.heldForYouQty)).toEqual([1, 1]);
    await runOutOfTime(unpaid.orderId, unpaid.cfOrderId);
    await releaseExpiredReservations();
    expect(await listing(first)).toEqual({ stockQty: 1, reservedQty: 0 });
    expect(await listing(second)).toEqual({ stockQty: 1, reservedQty: 0 });

    const paidCheckout = await a.placeOnline();
    cashfree.attempt(paidCheckout.cfOrderId, 'SUCCESS');
    await a.refresh(paidCheckout.orderId);
    expect(await listing(first)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await listing(second)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(first, 'ORDER_COMMIT')).toBe(1);
    expect(await ledger(second, 'ORDER_COMMIT')).toBe(1);
  });
});

describe('17. the release worker: restarts and overlapping runs', () => {
  it('runs that overlap or repeat (a restart, two instances) release a hold exactly once', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    await runOutOfTime(o.orderId, o.cfOrderId);
    await Promise.all([releaseExpiredReservations(), releaseExpiredReservations()]);
    await releaseExpiredReservations();
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_RELEASE')).toBe(1);
    expect((await order(o.orderId)).status).toBe(OrderStatus.PAYMENT_FAILED);
  });

  it('a hold whose payment is already captured is never released, even past its time', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    vi.mocked(inventoryService.commitReservation).mockRejectedValueOnce(new Error('placement interrupted'));
    const paid = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, paid));
    await prisma.order.update({ where: { id: o.orderId }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await releaseExpiredReservations();
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
    expect((await order(o.orderId)).status).toBe(OrderStatus.PENDING_PAYMENT);
  });
});

describe('18. a failure in the middle of confirming the payment', () => {
  it('rolls the confirmation back whole (no half-sold stock); reconciliation then finishes it once', async () => {
    const { listingId } = await lastUnit();
    const a = await customer(MOBILE_A);
    await a.add(listingId, 1);
    const o = await a.placeOnline();
    vi.mocked(inventoryService.commitReservation).mockRejectedValueOnce(new Error('database blip'));
    const paid = cashfree.attempt(o.cfOrderId, 'SUCCESS');
    await deliver(cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', o.cfOrderId, paid));

    // Rolled back: still held, not sold, not confirmed — but the money is recorded.
    expect((await order(o.orderId)).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await listing(listingId)).toEqual({ stockQty: 1, reservedQty: 1 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(0);
    expect(await prisma.payment.count({ where: { orderId: o.orderId, status: 'CAPTURED' } })).toBe(1);

    await reconcilePayments();
    await reconcilePayments();
    expect((await order(o.orderId)).status).toBe(OrderStatus.PROCESSING);
    expect(await listing(listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
    expect(await ledger(listingId, 'ORDER_COMMIT')).toBe(1);
  });
});

describe("product cards: the customer's own hold vs the shared catalogue", () => {
  const NAME = 'Holdtest Tomato';
  async function product(stockQty: number) {
    const storeId = await seedStore();
    const seeded = await seedProduct(storeId, { name: NAME, pricePaise: 20000, stockQty });
    return { storeId, productId: seeded.productId, categoryId: seeded.categoryId, listingId: seeded.storeVariantId };
  }
  type Availability = { inStock: boolean; availableQty: number };
  /** The product's availability on every catalogue surface, as one caller sees it. */
  async function catalogue(p: Awaited<ReturnType<typeof product>>, auth: Record<string, string> = {}) {
    const pick = (items: { id: string; defaultVariant: Availability | null }[]) => {
      const v = items.find((item) => item.id === p.productId)?.defaultVariant;
      return v ? { inStock: v.inStock, availableQty: v.availableQty } : null;
    };
    const get = async (path: string) => {
      const res = await api().get(path).set(auth);
      if (res.status !== 200) throw new Error(`${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      return expectSuccess<any>(res.body).data;
    };
    const detail = await get(`/api/v1/products/${p.productId}`);
    return {
      category: pick((await get(`/api/v1/products?categoryId=${p.categoryId}`)).items),
      store: pick((await get(`/api/v1/products?sellerId=${p.storeId}`)).items),
      search: pick((await get(`/api/v1/products/search?q=${encodeURIComponent('Holdtest')}`)).items),
      detail: { inStock: detail.variants[0].inStock, availableQty: detail.variants[0].availableQty },
    };
  }
  const everywhere = (value: Availability) => ({ category: value, store: value, search: value, detail: value });

  it("stock 1, A holds it: A's cart says it is held for A; the catalogue says taken — for A, B and a guest alike", async () => {
    const p = await product(1);
    const a = await customer(MOBILE_A);
    const b = await customer(MOBILE_B);
    await a.add(p.listingId, 1);
    await b.add(p.listingId, 1);
    const o = await a.placeOnline();
    await a.refresh(o.orderId);

    expect((await a.cart()).items[0]).toMatchObject({ heldForYouQty: 1, availableQty: 1, inStock: true });
    expect((await b.cart()).items[0]).toMatchObject({ heldForYouQty: 0, inStock: false, available: false });
    // Never personalised: identical whoever asks — nothing customer-specific
    // can reach a shared cache.
    const taken = everywhere({ inStock: false, availableQty: 0 });
    expect(await catalogue(p)).toEqual(taken);
    expect(await catalogue(p, a.auth)).toEqual(taken);
    expect(await catalogue(p, b.auth)).toEqual(taken);
  });

  it('stock 5, A holds 2: A may have 5 in all (3 more than the 2 held); B, like the catalogue, 3', async () => {
    const p = await product(5);
    const a = await customer(MOBILE_A);
    const b = await customer(MOBILE_B);
    await a.add(p.listingId, 2);
    await a.placeOnline();
    expect((await a.cart()).items[0]).toMatchObject({ qty: 2, heldForYouQty: 2, availableQty: 5 });
    expect(await catalogue(p, a.auth)).toEqual(everywhere({ inStock: true, availableQty: 3 }));
    expect(await catalogue(p, b.auth)).toEqual(everywhere({ inStock: true, availableQty: 3 }));
    expect(expectError((await b.add(p.listingId, 4)).body).code).toBe(ErrorCode.INSUFFICIENT_STOCK);
    expect((await b.add(p.listingId, 3)).status).toBe(200);
    expect((await a.add(p.listingId, 3)).status).toBe(200); // 5 in A's cart: their 2 + the 3 left
  });

  it('a retry keeps ONE hold; a successful payment sells it once and nothing is held any more', async () => {
    const p = await product(1);
    const a = await customer(MOBILE_A);
    await a.add(p.listingId, 1);
    const first = await a.placeOnline();
    cashfree.attempt(first.cfOrderId, 'FAILED');
    await a.refresh(first.orderId);
    const again = await a.placeOnline();
    expect((await a.cart()).items[0]).toMatchObject({ heldForYouQty: 1, availableQty: 1 });
    cashfree.attempt(again.cfOrderId, 'SUCCESS');
    await a.refresh(again.orderId);
    expect((await a.cart()).items).toEqual([]);
    expect(await catalogue(p, a.auth)).toEqual(everywhere({ inStock: false, availableQty: 0 }));
    expect(await listing(p.listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
  });

  it.each([
    ['the customer cancels', 'cancel'],
    ['the payment window runs out', 'expire'],
  ])('%s: nothing is held any more — A and B both see the unit available', async (_name, how) => {
    const p = await product(1);
    const a = await customer(MOBILE_A);
    const b = await customer(MOBILE_B);
    await a.add(p.listingId, 1);
    const o = await a.placeOnline();
    if (how === 'cancel') {
      await api().post(`/api/v1/orders/${o.orderId}/cancel`).set(a.auth).send({ reason: 'Changed my mind' }).expect(200);
    } else {
      await runOutOfTime(o.orderId, o.cfOrderId);
      await releaseExpiredReservations();
    }
    expect((await a.cart()).items[0]).toMatchObject({ heldForYouQty: 0, availableQty: 1, inStock: true });
    const free = everywhere({ inStock: true, availableQty: 1 });
    expect(await catalogue(p, a.auth)).toEqual(free);
    expect(await catalogue(p, b.auth)).toEqual(free);
    expect(await catalogue(p)).toEqual(free);
  });

  it('a made-to-order item (no stock count) is never "held": its availability is not adjusted', async () => {
    const p = await product(1);
    await prisma.sellerListing.update({ where: { id: p.listingId }, data: { tracksStock: false, stockQty: 0 } });
    const a = await customer(MOBILE_A);
    await a.add(p.listingId, 2);
    await a.placeOnline();
    expect((await a.cart()).items[0]).toMatchObject({ heldForYouQty: 0, qty: 2 });
    expect(await listing(p.listingId)).toEqual({ stockQty: 0, reservedQty: 0 });
  });
});

describe('the availability rule', () => {
  const tracked = (stockQty: number, reservedQty: number) => ({ tracksStock: true, stockQty, reservedQty });
  it('adds back only the customer\'s own hold, never more than the stock', () => {
    expect(trackedAvailableQtyFor(tracked(1, 1), 1)).toBe(1); // their own last unit
    expect(trackedAvailableQtyFor(tracked(1, 1), 0)).toBe(0); // someone else's hold
    expect(trackedAvailableQtyFor(tracked(3, 2), 2)).toBe(3);
    expect(trackedAvailableQtyFor(tracked(3, 3), 1)).toBe(1); // 2 held by others
    expect(trackedAvailableQtyFor(tracked(2, 1), 5)).toBe(2); // a stale bigger number cannot exceed stock
    expect(trackedAvailableQtyFor(tracked(5, 0), 0)).toBe(5);
    expect(trackedAvailableQtyFor({ tracksStock: false, stockQty: 0, reservedQty: 0 }, 3)).toBeNull();
  });
});
