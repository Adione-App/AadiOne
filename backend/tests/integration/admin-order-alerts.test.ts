/**
 * Admin "NEW ORDER" alerts (badge + popups), end to end through the real app
 * with Cashfree's network faked (tests/helpers/fake-cashfree.ts):
 *
 *   - announced only when an order becomes real: COD at placement, ONLINE
 *     only after the payment is verified (webhook or reconciliation) — never
 *     an unpaid, failed or expired checkout;
 *   - exactly one alert per admin per order, and one realtime event, however
 *     many webhooks / reconciliation runs / paths reach it;
 *   - the summary carries the real figures: COD vs online, payment status,
 *     first item, subtotal vs total;
 *   - read state per admin, persisted; customers and sellers have no access.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => ({ newOrders: [] as string[] }));

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
vi.mock('../../src/realtime/socket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/socket')>();
  return {
    ...actual,
    emitNewOrder: (event: { orderId: string }) => {
      emitted.newOrders.push(event.orderId);
      actual.emitNewOrder(event as never);
    },
  };
});

import { OrderStatus, PaymentMethod, UserRole, type AdminOrderAlertsDto } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { reconcileCheckoutPayments } from '../../src/modules/payments/payment.service';
import { releaseExpiredReservations } from '../../src/jobs';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

let panelSeq = 0;
async function panelUser(role: UserRole): Promise<string> {
  panelSeq += 1;
  const email = `alerts${panelSeq}@adione.test`;
  await prisma.user.create({
    data: { mobile: `00000004${String(panelSeq).padStart(2, '0')}`, email, fullName: 'Ops', passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const alerts = async (token: string) =>
  expectSuccess<AdminOrderAlertsDto>((await api().get('/api/v1/admin/order-alerts').set('Authorization', bearer(token)).expect(200)).body).data;
const markRead = (token: string, orderId: string) => api().post(`/api/v1/admin/order-alerts/${orderId}/read`).set('Authorization', bearer(token));
const deliver = (webhook: { raw: string; headers: Record<string, string> }) => api().post('/api/v1/payments/webhook').set(webhook.headers).send(webhook.raw);

let listingId: string;
let mobileSeq = 0;

/** One customer's order of 2 × ₹200; ONLINE also opens its Cashfree checkout. */
async function placeOrder(method: PaymentMethod) {
  mobileSeq += 1;
  const mobile = `98765004${String(mobileSeq).padStart(2, '0')}`;
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  const addressId = await seedAddress(session.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: listingId, qty: 2 }).expect(200);
  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(session.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: method })
    .expect(201);
  const orderId = expectSuccess<{ order: { id: string } }>(res.body).data.order.id;
  let checkout: { paymentId: string; providerOrderId: string } | null = null;
  if (method === PaymentMethod.ONLINE) {
    checkout = expectSuccess<{ paymentId: string; providerOrderId: string }>(
      (await api().post('/api/v1/payments/create').set('Authorization', bearer(session.accessToken)).set('Idempotency-Key', randomUUID()).send({ orderId }).expect(200)).body,
    ).data;
  }
  return { orderId, token: session.accessToken, checkout };
}

beforeEach(async () => {
  await truncateAll();
  invalidateCategoryCache();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  emitted.newOrders.length = 0;
  const storeId = await seedStore();
  listingId = (await seedProduct(storeId, { name: 'Fresh Mogri', pricePaise: 20000, mrpPaise: 24000, stockQty: 50 })).storeVariantId;
});

describe('when an order is announced', () => {
  it('a COD order: once, at placement, to every admin and staff — with its real figures', async () => {
    const [adminA, adminB, staff] = [await panelUser(UserRole.ADMIN), await panelUser(UserRole.ADMIN), await panelUser(UserRole.STAFF)];
    const order = await placeOrder(PaymentMethod.COD);
    for (const token of [adminA, adminB, staff]) {
      const list = await alerts(token);
      expect(list.unread).toBe(1);
      expect(list.items[0]).toMatchObject({
        orderId: order.orderId,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        firstItem: { productName: 'Fresh Mogri', qty: 2 },
        unitCount: 2,
        lineCount: 1,
        sellerCount: 1,
        itemsSubtotalPaise: 40000,
      });
      const a = list.items[0]!;
      // Subtotal is the items; the total is what the customer pays (items + delivery + fees − discount).
      expect(a.totalPaise).toBe(a.itemsSubtotalPaise + a.deliveryFeePaise + a.platformFeePaise + a.taxPaise - a.discountPaise);
    }
    expect(emitted.newOrders).toEqual([order.orderId]);
    expect((await prisma.notification.findFirstOrThrow({ where: { orderId: order.orderId, audience: 'ADMIN' } })).title).toMatch(/^New order /);
    expect((await prisma.notification.findFirstOrThrow({ where: { orderId: order.orderId, audience: 'ADMIN' } })).body).toMatch(/COD \(Cash on Delivery\)/);
  });

  it('an online order: nothing while unpaid or after a failed attempt; once after the verified success — however many webhooks', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);
    expect(await alerts(admin)).toMatchObject({ unread: 0, items: [] });

    const failed = cashfree.attempt(order.checkout!.providerOrderId, 'FAILED');
    await deliver(cashfree.paymentWebhook('PAYMENT_FAILED_WEBHOOK', order.checkout!.providerOrderId, failed)).expect(200);
    expect((await alerts(admin)).unread).toBe(0);

    const paid = cashfree.attempt(order.checkout!.providerOrderId, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', order.checkout!.providerOrderId, paid);
    await deliver(webhook).expect(200);
    await deliver(webhook).expect(200); // replay
    await reconcileCheckoutPayments(); // and a reconciliation run on top
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe(OrderStatus.PROCESSING);
    const list = await alerts(admin);
    expect(list.unread).toBe(1);
    expect(list.items[0]).toMatchObject({ orderId: order.orderId, paymentMethod: 'ONLINE', paymentStatus: 'PAID' });
    expect(emitted.newOrders).toEqual([order.orderId]);
    expect(await prisma.notification.count({ where: { orderId: order.orderId, audience: 'ADMIN' } })).toBe(1);
  });

  it('an online order placed by reconciliation (no webhook ever arrived) is announced once', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);
    cashfree.attempt(order.checkout!.providerOrderId, 'SUCCESS');
    // Reconciliation looks at checkouts older than 2 minutes.
    await prisma.payment.update({ where: { id: order.checkout!.paymentId }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    await reconcileCheckoutPayments();
    await reconcileCheckoutPayments();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe(OrderStatus.PROCESSING);
    expect((await alerts(admin)).items.map((a) => a.orderId)).toEqual([order.orderId]);
    expect(emitted.newOrders).toEqual([order.orderId]);
  });

  it('an unpaid checkout that expires is never announced', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);
    await prisma.order.update({ where: { id: order.orderId }, data: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
    await releaseExpiredReservations();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(await alerts(admin)).toMatchObject({ unread: 0, items: [] });
    expect(emitted.newOrders).toEqual([]);
  });

  it('several orders arriving together: one alert each, newest first, counts add up', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const placed = await Promise.all([placeOrder(PaymentMethod.COD), placeOrder(PaymentMethod.COD), placeOrder(PaymentMethod.COD)]);
    const list = await alerts(admin);
    expect(list.unread).toBe(3);
    expect(new Set(list.items.map((a) => a.orderId))).toEqual(new Set(placed.map((p) => p.orderId)));
    expect(new Set(emitted.newOrders)).toEqual(new Set(placed.map((p) => p.orderId)));
    expect(emitted.newOrders).toHaveLength(3);
  });
});

describe('read state', () => {
  it('opening an order reads it for that admin only — persisted, idempotent; an unknown order is 404', async () => {
    const [adminA, adminB] = [await panelUser(UserRole.ADMIN), await panelUser(UserRole.ADMIN)];
    const first = await placeOrder(PaymentMethod.COD);
    const second = await placeOrder(PaymentMethod.COD);

    const after = expectSuccess<{ unread: number }>((await markRead(adminA, first.orderId).expect(200)).body).data;
    expect(after.unread).toBe(1);
    await markRead(adminA, first.orderId).expect(200); // again: no change
    expect((await alerts(adminA)).items.map((a) => a.orderId)).toEqual([second.orderId]);
    // B still has both.
    expect((await alerts(adminB)).unread).toBe(2);
    // Persisted (a fresh read, as after a reload or a new login).
    const row = await prisma.notification.findFirstOrThrow({ where: { orderId: first.orderId, audience: 'ADMIN', readAt: { not: null } } });
    expect(row.readAt).toBeInstanceOf(Date);
    await markRead(adminA, randomUUID()).expect(404);
  });

  it('customers and sellers cannot reach the alerts', async () => {
    const order = await placeOrder(PaymentMethod.COD);
    await api().get('/api/v1/admin/order-alerts').set('Authorization', bearer(order.token)).expect(403);
    await markRead(order.token, order.orderId).expect(403);
    await api().get('/api/v1/admin/order-alerts').expect(401);
  });
});
