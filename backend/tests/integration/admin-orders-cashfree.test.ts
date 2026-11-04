/**
 * Admin Orders / Dashboard / Payments with Cashfree — what the order board
 * shows of the payment flow, end to end through the real app (Cashfree's
 * network faked, tests/helpers/fake-cashfree.ts, like cashfree-payment.test.ts):
 *
 *   - an open Cashfree checkout is an order row (PENDING_PAYMENT, holding its
 *     stock) but not an order to work on: no actionable tab, no dashboard
 *     count, no recent-orders row — Payments shows it as Pending (it is stored
 *     CREATED, which the raw PENDING filter used to miss);
 *   - a verified success webhook moves it to Processing everywhere;
 *   - an expired (PAYMENT_FAILED) or never-placed cancelled checkout is not a
 *     cancelled order; a genuine cancellation is; nothing is ever deleted;
 *   - the paid-but-not-placed warning: only a verified, non-orphan capture
 *     still unplaced after PAID_NOT_PLACED_AFTER_MINUTES, cleared by the
 *     reconciliation that places it;
 *   - the Payment Pending tab and the manual controls still work for the
 *     legacy direct-UPI mode; Payments stays ORDER_REFUND-only (Staff 403).
 *
 * The web panel's tab rules: web/tests/adminOrders.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ manual: false }));

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
    // Toggled by the direct-UPI compatibility case only.
    allowsManualPaymentConfirmation: () => mode.manual,
  };
});

import {
  OrderStatus,
  PaymentMethod,
  UserRole,
  type AdminDashboardDto,
  type AdminOrderSummaryDto,
  type AdminPaidNotPlacedDto,
  type CursorPage,
} from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { reconcileCheckoutPayments } from '../../src/modules/payments/payment.service';
import { releaseExpiredReservations } from '../../src/jobs';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { PAID_NOT_PLACED_AFTER_MINUTES } from '../../src/modules/admin/admin-order.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const TABS = ['PAYMENT_PENDING', 'PROCESSING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'] as const;

let panelSeq = 0;
async function panelUser(role: UserRole): Promise<string> {
  panelSeq += 1;
  const email = `ops${panelSeq}@adione.test`;
  await prisma.user.create({
    data: { mobile: `00000003${String(panelSeq).padStart(2, '0')}`, email, fullName: 'Ops', passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const get = (token: string, path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token));
async function board(token: string, query: string): Promise<string[]> {
  const page = expectSuccess<CursorPage<AdminOrderSummaryDto>>((await get(token, `/admin/orders?${query}`).expect(200)).body).data;
  return page.items.map((order) => order.id);
}
async function tabsListing(token: string, orderId: string): Promise<string[]> {
  const found: string[] = [];
  for (const tab of TABS) if ((await board(token, `tab=${tab}&limit=50`)).includes(orderId)) found.push(tab);
  return found;
}
const dashboard = async (token: string) => expectSuccess<AdminDashboardDto>((await get(token, '/admin/dashboard').expect(200)).body).data;
async function payments(token: string, query: string) {
  return expectSuccess<{ items: { id: string; status: string; outcome: string; order: { id: string } }[] }>(
    (await get(token, `/admin/payments?${query}&pageSize=100`).expect(200)).body,
  ).data.items;
}
const anomalies = async (token: string) => expectSuccess<AdminPaidNotPlacedDto>((await get(token, '/admin/payment-anomalies').expect(200)).body).data;
/** The marketplace-local day (Asia/Kolkata) an order was created on — the dashboard's date filter, never "now" (a run across midnight). */
async function dayOf(orderId: string): Promise<string> {
  const { createdAt } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { createdAt: true } });
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(createdAt);
}

let listingId: string;
let mobileSeq = 0;

/** One customer's order of 1 unit (₹200); ONLINE also opens its Cashfree checkout. */
async function placeOrder(method: PaymentMethod) {
  mobileSeq += 1;
  const mobile = `98765002${String(mobileSeq).padStart(2, '0')}`;
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  const addressId = await seedAddress(session.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: listingId, qty: 1 }).expect(200);
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
      (
        await api()
          .post('/api/v1/payments/create')
          .set('Authorization', bearer(session.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ orderId })
          .expect(200)
      ).body,
    ).data;
  }
  return { orderId, token: session.accessToken, checkout };
}

async function expireUnpaid(orderId: string) {
  await prisma.order.update({ where: { id: orderId }, data: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
  await releaseExpiredReservations();
  expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PAYMENT_FAILED);
}

beforeEach(async () => {
  await truncateAll();
  invalidateCategoryCache();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  const storeId = await seedStore();
  listingId = (await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 50 })).storeVariantId;
});

afterEach(() => {
  mode.manual = false;
});

/* -------------------------------------------------------------------------- */

describe('Cashfree checkouts on the admin order board', () => {
  it('an open Cashfree checkout is in no actionable tab or count; Payments shows it as Pending (stored CREATED)', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);

    // Kept as an order row (stock held), reachable only by the compatibility tab.
    expect(await tabsListing(admin, order.orderId)).toEqual(['PAYMENT_PENDING']);
    expect(await board(admin, `date=${await dayOf(order.orderId)}&placedOnly=true&limit=50`)).not.toContain(order.orderId);
    expect(await dashboard(admin)).toMatchObject({ pendingOrderCount: 0, actionableOrders: { processing: 0, readyForPickup: 0, outForDelivery: 0 } });

    // Payments: the Cashfree checkout is CREATED — "Pending" (outcome) finds it, the raw PENDING status did not.
    const pending = await payments(admin, 'outcome=PENDING');
    expect(pending.map((p) => [p.id, p.status, p.outcome])).toEqual([[order.checkout!.paymentId, 'CREATED', 'PENDING']]);
    expect(await payments(admin, 'status=PENDING')).toEqual([]);
  });

  it('a verified success webhook moves it to Processing: tab, dashboard and Payments agree', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);
    const attempt = cashfree.attempt(order.checkout!.providerOrderId, 'SUCCESS');
    const webhook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', order.checkout!.providerOrderId, attempt);
    await api().post('/api/v1/payments/webhook').set(webhook.headers).send(webhook.raw).expect(200);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe(OrderStatus.PROCESSING);
    expect(await tabsListing(admin, order.orderId)).toEqual(['PROCESSING']);
    expect(await dashboard(admin)).toMatchObject({ pendingOrderCount: 1, actionableOrders: { processing: 1 } });
    expect(await board(admin, `date=${await dayOf(order.orderId)}&placedOnly=true&limit=50`)).toContain(order.orderId);
    expect((await payments(admin, 'outcome=PAID')).map((p) => p.order.id)).toEqual([order.orderId]);
    expect(await payments(admin, 'outcome=PENDING')).toEqual([]);
    expect(await anomalies(admin)).toMatchObject({ total: 0 });
  });

  it('an expired, never-paid checkout is in no order tab (not Cancelled); Payments keeps it as Failed, nothing deleted', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);
    await expireUnpaid(order.orderId);

    expect(await tabsListing(admin, order.orderId)).toEqual([]);
    expect(await board(admin, `date=${await dayOf(order.orderId)}&placedOnly=true&limit=50`)).not.toContain(order.orderId);
    expect((await payments(admin, 'outcome=FAILED')).map((p) => p.order.id)).toEqual([order.orderId]);
    // The order and its payment attempt are both still there for reconciliation and audit.
    expect(await prisma.order.count({ where: { id: order.orderId } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(1);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.orderId, toStatus: OrderStatus.PAYMENT_FAILED } })).toBe(1);
  });

  it('a genuine cancellation stays in Cancelled; an unpaid checkout cancelled before payment does not', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const placed = await placeOrder(PaymentMethod.COD);
    await api().post(`/api/v1/orders/${placed.orderId}/cancel`).set('Authorization', bearer(placed.token)).send({ reason: 'Ordered by mistake' }).expect(200);
    const unpaid = await placeOrder(PaymentMethod.ONLINE);
    await api().post(`/api/v1/orders/${unpaid.orderId}/cancel`).set('Authorization', bearer(unpaid.token)).send({ reason: 'Changed my mind' }).expect(200);

    const cancelledPlaced = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    const cancelledUnpaid = await prisma.order.findUniqueOrThrow({ where: { id: unpaid.orderId } });
    expect([cancelledPlaced.status, cancelledPlaced.placedAt !== null]).toEqual([OrderStatus.CANCELLED, true]);
    expect([cancelledUnpaid.status, cancelledUnpaid.placedAt]).toEqual([OrderStatus.CANCELLED, null]);

    const cancelledTab = await board(admin, 'tab=CANCELLED&limit=50');
    expect(cancelledTab).toContain(placed.orderId);
    expect(cancelledTab).not.toContain(unpaid.orderId);
    expect(await board(admin, `date=${await dayOf(placed.orderId)}&placedOnly=true&limit=50`)).toEqual([placed.orderId]);
    // The abandoned checkout is still on record, as a cancelled payment attempt.
    expect((await payments(admin, 'outcome=CANCELLED')).map((p) => p.order.id)).toEqual([unpaid.orderId]);
  });

  it('dashboard: "orders in progress" counts placed orders per tab only; the recent list has no unpaid or failed checkout', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const cod = await placeOrder(PaymentMethod.COD);
    const open = await placeOrder(PaymentMethod.ONLINE);
    const failed = await placeOrder(PaymentMethod.ONLINE);
    await expireUnpaid(failed.orderId);

    expect(await dashboard(admin)).toMatchObject({
      pendingOrderCount: 1,
      actionableOrders: { processing: 1, readyForPickup: 0, outForDelivery: 0 },
    });
    expect(await board(admin, `date=${await dayOf(cod.orderId)}&placedOnly=true&limit=50`)).toEqual([cod.orderId]);
    // Without placedOnly the API still returns every order, as before.
    expect((await board(admin, `date=${await dayOf(cod.orderId)}&limit=50`)).sort()).toEqual([cod.orderId, open.orderId, failed.orderId].sort());
  });
});

describe('paid but not placed', () => {
  async function capture(paymentId: string, minutesAgo: number, orphan = false) {
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'CAPTURED',
        providerPaymentId: `cf_pay_${randomUUID().slice(0, 8)}`,
        capturedAt: new Date(Date.now() - minutesAgo * 60_000),
        ...(orphan ? { failureCode: 'ORPHAN_CAPTURE', failureReason: 'Duplicate payment — refunded automatically.' } : {}),
      },
    });
  }

  it(`warns only after ${PAID_NOT_PLACED_AFTER_MINUTES} minutes, never for an orphan capture, and clears once reconciliation places the order`, async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const stuck = await placeOrder(PaymentMethod.ONLINE);
    const fresh = await placeOrder(PaymentMethod.ONLINE);
    const orphan = await placeOrder(PaymentMethod.ONLINE);
    await capture(stuck.checkout!.paymentId, PAID_NOT_PLACED_AFTER_MINUTES + 5);
    await capture(fresh.checkout!.paymentId, 2);
    await capture(orphan.checkout!.paymentId, PAID_NOT_PLACED_AFTER_MINUTES + 5, true);

    const warning = await anomalies(admin);
    expect(warning.afterMinutes).toBe(PAID_NOT_PLACED_AFTER_MINUTES);
    const stuckPayment = await prisma.payment.findUniqueOrThrow({ where: { id: stuck.checkout!.paymentId } });
    expect(warning.items.map((item) => [item.orderId, item.orderStatus, item.paymentId, item.amountPaise])).toEqual([
      [stuck.orderId, OrderStatus.PENDING_PAYMENT, stuckPayment.id, stuckPayment.amountPaise],
    ]);
    expect(warning.items[0]!.minutesSinceCapture).toBeGreaterThanOrEqual(PAID_NOT_PLACED_AFTER_MINUTES);
    expect(warning.total).toBe(1);

    // Reconciliation (unchanged) places the paid orders; the warning clears by itself.
    await reconcileCheckoutPayments();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: stuck.orderId } })).status).toBe(OrderStatus.PROCESSING);
    expect(await anomalies(admin)).toMatchObject({ total: 0, items: [] });
  });

  it('a paid order stuck half-placed (PAYMENT_CONFIRMED) is warned about too', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);
    await capture(order.checkout!.paymentId, PAID_NOT_PLACED_AFTER_MINUTES + 1);
    await prisma.order.update({ where: { id: order.orderId }, data: { status: OrderStatus.PAYMENT_CONFIRMED } });
    expect((await anomalies(admin)).items.map((item) => [item.orderId, item.orderStatus])).toEqual([[order.orderId, OrderStatus.PAYMENT_CONFIRMED]]);
  });
});

describe('permissions and the direct-UPI mode', () => {
  it('Staff works the orders and sees the warning, but cannot open Payments; Admin can (no permission changed)', async () => {
    const staff = await panelUser(UserRole.STAFF);
    const admin = await panelUser(UserRole.ADMIN);
    await get(staff, '/admin/orders?tab=PROCESSING').expect(200);
    await get(staff, '/admin/payment-anomalies').expect(200);
    await get(staff, '/admin/payment-mode').expect(200);
    await get(staff, '/admin/payments').expect(403);
    await get(admin, '/admin/payments').expect(200);
    await get(admin, '/admin/payment-anomalies').expect(200);
  });

  it('with Cashfree the panel is told there are no manual controls; in direct-UPI mode it is, and Payment Pending still lists unpaid orders', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const order = await placeOrder(PaymentMethod.ONLINE);
    expect(expectSuccess<{ manualConfirmation: boolean }>((await get(admin, '/admin/payment-mode').expect(200)).body).data.manualConfirmation).toBe(false);

    mode.manual = true;
    expect(expectSuccess<{ manualConfirmation: boolean }>((await get(admin, '/admin/payment-mode').expect(200)).body).data.manualConfirmation).toBe(true);
    expect(await board(admin, 'tab=PAYMENT_PENDING&limit=50')).toEqual([order.orderId]);
  });
});
