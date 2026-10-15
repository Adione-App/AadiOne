/**
 * Payment & refund security regressions (audit 2026-10-15).
 *
 * Same harness as cashfree-payment.test.ts: the app's provider is a real
 * CashfreeProvider talking to an in-memory Cashfree (tests/helpers/
 * fake-cashfree.ts), so the provider's HTTP code, the settlement path and the
 * state machine all run for real; only the network is fake.
 *
 * Each block pins one finding:
 *   1. an admin cannot mark an unpaid order paid through the generic status
 *      endpoint (or any other caller without a captured payment);
 *   2. a captured payment whose placement has not finished can never be
 *      stranded by a cancel / failure — it is placed, then refundable;
 *   3. an AMBIGUOUS refund error (timeout, lost response, 5xx) never marks a
 *      refund FAILED, so the same money is never re-opened for a second refund;
 *   4. admin refunds are permission-checked, idempotent under concurrency and
 *      audited with the acting admin;
 *   5. protected fields in requests are ignored (mass assignment);
 *   6. another customer's order cannot be paid, read or cancelled;
 *   7. two concurrent checkouts of ONE cart create one order;
 *   8. a gateway timeout during verification changes nothing, and
 *      reconciliation settles the payment later.
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

import { ActorType, ErrorCode, OrderStatus, PaymentMethod, SellerOrderStatus, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { reconcileCheckoutPayments } from '../../src/modules/payments/payment.service';
import { transitionOrder } from '../../src/modules/orders/order-state.service';
import { releaseExpiredReservations } from '../../src/jobs';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9876543210';
const OTHER_MOBILE = '9876543211';

interface OnlineOrder {
  token: string;
  userId: string;
  orderId: string;
  listingId: string;
  addressId: string;
  totalPaise: number;
}

async function placeOnlineOrder(mobile = MOBILE): Promise<OnlineOrder> {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
  const session = await loginAs(mobile);
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
    addressId,
    totalPaise: order.bill.totalPaise,
  };
}

async function openCheckout(order: OnlineOrder): Promise<{ paymentId: string; providerOrderId: string }> {
  const res = await api()
    .post('/api/v1/payments/create')
    .set('Authorization', bearer(order.token))
    .set('Idempotency-Key', randomUUID())
    .send({ orderId: order.orderId })
    .expect(200);
  return expectSuccess<{ paymentId: string; providerOrderId: string }>(res.body).data;
}

/** Pays through Cashfree and settles via the app's refresh — a PROCESSING, PAID order. */
async function placePaidOrder(): Promise<OnlineOrder> {
  const order = await placeOnlineOrder();
  const checkout = await openCheckout(order);
  cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
  await api()
    .post(`/api/v1/payments/${order.orderId}/refresh`)
    .set('Authorization', bearer(order.token))
    .expect(200);
  const placed = await dbOrder(order);
  expect(placed).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
  return order;
}

async function dbOrder(order: OnlineOrder) {
  return prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
}

async function listing(order: OnlineOrder) {
  return prisma.sellerListing.findUniqueOrThrow({ where: { id: order.listingId } });
}

async function cancelAsCustomer(order: OnlineOrder, token = order.token) {
  return api()
    .post(`/api/v1/orders/${order.orderId}/cancel`)
    .set('Authorization', bearer(token))
    .send({ reason: 'Changed my mind' });
}

let adminSeq = 0;
async function adminToken(role: UserRole): Promise<{ token: string; userId: string }> {
  adminSeq += 1;
  const email = `admin${adminSeq}@adione.test`;
  const user = await prisma.user.create({
    data: {
      mobile: `00000000${String(adminSeq).padStart(2, '0')}`,
      email,
      fullName: `Panel ${role}`,
      passwordHash: await hashPassword('TestAdmin@123'),
      role,
    },
  });
  const login = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return {
    token: expectSuccess<{ tokens: { accessToken: string } }>(login.body).data.tokens.accessToken,
    userId: user.id,
  };
}

/** Sum of every refund Cashfree actually holds for this test, in paise. */
function gatewayRefundedPaise(): number {
  return [...cashfree.refunds.values()].reduce((sum, r) => sum + Math.round(r.refund_amount * 100), 0);
}

/** Lets the reconciliation sweep pick these refunds up (it skips the newest ones). */
async function ageRefunds(orderId: string, minutes: number): Promise<void> {
  await prisma.refund.updateMany({
    where: { orderId },
    data: { createdAt: new Date(Date.now() - minutes * 60_000) },
  });
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(MOBILE);
  await otpService.clearOtpState(OTHER_MOBILE);
  await cache.clear();
  cashfree.reset();
});

/* -------------------------------------------------------------------------- */
/* 1. No payment confirmation without a captured payment                       */
/* -------------------------------------------------------------------------- */

describe('admin cannot mark an unpaid order paid', () => {
  it.each([UserRole.STAFF, UserRole.ADMIN])(
    '%s: PATCH /admin/orders/:id/status cannot confirm payment, fail it or place the order',
    async (role) => {
      const order = await placeOnlineOrder();
      await openCheckout(order);
      const { token } = await adminToken(role);

      for (const toStatus of [
        OrderStatus.PAYMENT_CONFIRMED,
        OrderStatus.PROCESSING,
        OrderStatus.PAYMENT_FAILED,
        OrderStatus.REFUNDED,
      ]) {
        const res = await api()
          .patch(`/api/v1/admin/orders/${order.orderId}/status`)
          .set('Authorization', bearer(token))
          .send({ toStatus, reason: 'forcing it' });
        expect(res.status, `${role} -> ${toStatus}`).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }

      const after = await dbOrder(order);
      expect(after.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(after.paymentStatus).toBe('PENDING');
      // Stock is still only HELD — never committed as sold.
      const offer = await listing(order);
      expect(offer.stockQty).toBe(10);
      expect(offer.reservedQty).toBe(2);
      // Sellers were never told about an unpaid order.
      expect(await prisma.notification.count({ where: { type: 'SELLER_NEW_ORDER' } })).toBe(0);
    },
  );

  it('no caller — not even SYSTEM — can confirm an online order that has no captured payment', async () => {
    const order = await placeOnlineOrder();
    await openCheckout(order);

    for (const actorType of [ActorType.ADMIN, ActorType.SYSTEM, ActorType.PAYMENT_WEBHOOK]) {
      await expect(
        transitionOrder({ orderId: order.orderId, toStatus: OrderStatus.PAYMENT_CONFIRMED, actorType }),
      ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_VERIFICATION_FAILED });
    }
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Captured but not yet placed: never stranded                              */
/* -------------------------------------------------------------------------- */

describe('a captured payment whose placement has not finished', () => {
  /**
   * The exact state settleCapture commits before it places the order: the
   * payment row is CAPTURED, the order is still PENDING_PAYMENT / PENDING.
   * (Placement runs next — or, if it failed, reconciliation retries it.)
   */
  async function capturedButUnplaced(): Promise<OnlineOrder> {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const paid = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    await prisma.payment.update({
      where: { id: checkout.paymentId },
      data: {
        status: 'CAPTURED',
        providerPaymentId: paid.cf_payment_id,
        method: 'upi',
        capturedAt: new Date(),
      },
    });
    return order;
  }

  it('cannot be cancelled by the customer — the money is placed instead, and is then refundable', async () => {
    const order = await capturedButUnplaced();

    const cancel = await cancelAsCustomer(order);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe(ErrorCode.PAYMENT_ALREADY_CAPTURED);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT });

    // Reconciliation places the paid order.
    expect(await reconcileCheckoutPayments()).toBeGreaterThanOrEqual(1);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });

    // Now a cancellation refunds every paisa — nothing is stranded.
    expect((await cancelAsCustomer(order)).status).toBe(200);
    const refunds = await prisma.refund.findMany({ where: { orderId: order.orderId } });
    expect(refunds.reduce((sum, r) => sum + r.amountPaise, 0)).toBe(order.totalPaise);
    expect(gatewayRefundedPaise()).toBe(order.totalPaise);
  });

  it('cannot be failed by the system, and the release job leaves it alone', async () => {
    const order = await capturedButUnplaced();

    await expect(
      transitionOrder({ orderId: order.orderId, toStatus: OrderStatus.PAYMENT_FAILED, actorType: ActorType.SYSTEM }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_ALREADY_CAPTURED });
    await expect(
      transitionOrder({ orderId: order.orderId, toStatus: OrderStatus.CANCELLED, actorType: ActorType.SYSTEM }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_ALREADY_CAPTURED });

    await prisma.order.update({
      where: { id: order.orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await releaseExpiredReservations()).toBe(0);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT });
    expect((await listing(order)).reservedQty).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Ambiguous refund errors                                                  */
/* -------------------------------------------------------------------------- */

describe('refund errors', () => {
  it('a refund Cashfree processed but whose response was lost stays live — the ledger matches the gateway and nothing is refunded twice', async () => {
    const order = await placePaidOrder();

    // The FIRST refund call (this seller's portion) reaches Cashfree, which
    // creates the refund — but the response never comes back.
    cashfree.loseNextResponse = true;
    expect((await cancelAsCustomer(order)).status).toBe(200);

    const ledger = await prisma.refund.findMany({ where: { orderId: order.orderId }, orderBy: { createdAt: 'asc' } });
    expect(ledger.map((r) => r.status)).not.toContain('FAILED');
    const live = ledger.reduce((sum, r) => sum + r.amountPaise, 0);
    // What the gateway holds is exactly what the ledger says — never more
    // than was captured.
    expect(gatewayRefundedPaise()).toBe(live);
    expect(gatewayRefundedPaise()).toBeLessThanOrEqual(order.totalPaise);
    expect(cashfree.refunds.size).toBe(ledger.length);

    // Reconciliation re-reads each refund from Cashfree; once Cashfree
    // completes them the order is fully refunded — once.
    for (const refund of cashfree.refunds.values()) cashfree.settleRefund(refund.refund_id, 'SUCCESS');
    await ageRefunds(order.orderId, 3);
    await reconcileCheckoutPayments();

    const settled = await prisma.refund.findMany({ where: { orderId: order.orderId } });
    expect(settled.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(settled.reduce((sum, r) => sum + r.amountPaise, 0)).toBe(order.totalPaise);
    expect(gatewayRefundedPaise()).toBe(order.totalPaise);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.REFUNDED, paymentStatus: 'REFUNDED' });
  });

  it('a coupon order refunds only what the customer paid — through a lost response and reconciliation, exactly the captured total', async () => {
    await prisma.coupon.create({ data: { code: 'SAVE50', type: 'FLAT', discountValue: 5000, usageLimitPerUser: 10 } });
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
    const session = await loginAs(MOBILE);
    const addressId = await seedAddress(session.userId);
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(session.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 2 })
      .expect(200);
    const placedRes = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.ONLINE, couponCode: 'SAVE50' })
      .expect(201);
    const orderId = expectSuccess<{ order: { id: string } }>(placedRes.body).data.order.id;
    const order: OnlineOrder = { token: session.accessToken, userId: session.userId, orderId, listingId: product.storeVariantId, addressId, totalPaise: 0 };
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    await api().post(`/api/v1/payments/${orderId}/refresh`).set('Authorization', bearer(session.accessToken)).expect(200);
    const paid = await dbOrder(order);
    expect(paid).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID', couponDiscountPaise: 5000 });

    cashfree.loseNextResponse = true; // the seller-portion refund reaches Cashfree; its answer is lost
    expect((await cancelAsCustomer(order)).status).toBe(200);

    const sellerOrder = await prisma.sellerOrder.findFirstOrThrow({ where: { orderId } });
    expect(sellerOrder.couponDiscountPaise).toBe(5000);
    const portion = await prisma.refund.findFirstOrThrow({ where: { sellerOrderId: sellerOrder.id } });
    // ₹400 of items - the ₹50 coupon: the customer paid ₹350 for them, so ₹350 comes back.
    expect(portion).toMatchObject({ amountPaise: 35000, status: 'PENDING' });
    expect(gatewayRefundedPaise()).toBe((await prisma.refund.findMany({ where: { orderId } })).reduce((s, r) => s + r.amountPaise, 0));

    for (const refund of cashfree.refunds.values()) cashfree.settleRefund(refund.refund_id, 'SUCCESS');
    await ageRefunds(orderId, 3);
    await reconcileCheckoutPayments();
    await reconcileCheckoutPayments(); // a second sweep changes nothing

    const refunds = await prisma.refund.findMany({ where: { orderId } });
    expect(refunds.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(refunds.reduce((s, r) => s + r.amountPaise, 0)).toBe(paid.totalPaise);
    expect(gatewayRefundedPaise()).toBe(paid.totalPaise);
    expect(cashfree.refunds.size).toBe(refunds.length);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.REFUNDED, paymentStatus: 'REFUNDED' });
  });

  it('a refund call that failed in transit (5xx) stays PENDING until Cashfree confirms it does not exist', async () => {
    const order = await placePaidOrder();

    cashfree.failNext = { status: 503, code: 'service_unavailable', message: 'temporarily unavailable' };
    expect((await cancelAsCustomer(order)).status).toBe(200);

    const sellerOrder = await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.orderId } });
    const portion = await prisma.refund.findFirstOrThrow({ where: { sellerOrderId: sellerOrder.id } });
    expect(portion.status).toBe('PENDING');
    // The remainder refund did not re-take this portion's money.
    const ledgerTotal = (await prisma.refund.findMany({ where: { orderId: order.orderId } })).reduce(
      (sum, r) => sum + r.amountPaise,
      0,
    );
    expect(ledgerTotal).toBe(order.totalPaise);
    expect(gatewayRefundedPaise()).toBe(order.totalPaise - portion.amountPaise);

    // A young refund Cashfree does not know yet is left alone ...
    await ageRefunds(order.orderId, 3);
    await reconcileCheckoutPayments();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: portion.id } })).status).toBe('PENDING');

    // ... and only once it is clearly not coming is it FAILED (re-openable).
    await ageRefunds(order.orderId, 11);
    await reconcileCheckoutPayments();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: portion.id } })).status).toBe('FAILED');
  });

  it('a refund Cashfree definitively refuses (4xx) is FAILED straight away', async () => {
    const order = await placePaidOrder();

    cashfree.failNext = { status: 400, code: 'refund_amount_invalid', message: 'invalid refund amount' };
    expect((await cancelAsCustomer(order)).status).toBe(200);

    const sellerOrder = await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.orderId } });
    const portion = await prisma.refund.findFirstOrThrow({ where: { sellerOrderId: sellerOrder.id } });
    expect(portion.status).toBe('FAILED');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Admin refunds: permission, idempotency, audit                            */
/* -------------------------------------------------------------------------- */

describe('admin refund', () => {
  /** A cancelled, still-PAID order — what is left when automatic refunds could not run. */
  async function cancelledUnrefundedOrder(): Promise<OnlineOrder> {
    const order = await placePaidOrder();
    await prisma.sellerOrder.updateMany({
      where: { orderId: order.orderId },
      data: { status: SellerOrderStatus.CANCELLED, cancelledAt: new Date() },
    });
    await prisma.order.update({
      where: { id: order.orderId },
      data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
    });
    return order;
  }

  it('is refused to customers and to staff without the refund permission', async () => {
    const order = await cancelledUnrefundedOrder();
    const staff = await adminToken(UserRole.STAFF);

    const asCustomer = await api()
      .post(`/api/v1/admin/orders/${order.orderId}/refund`)
      .set('Authorization', bearer(order.token))
      .send({ reason: 'give me my money' });
    expect(asCustomer.status).toBe(403);

    const asStaff = await api()
      .post(`/api/v1/admin/orders/${order.orderId}/refund`)
      .set('Authorization', bearer(staff.token))
      .send({ reason: 'refund it' });
    expect(asStaff.status).toBe(403);

    expect(await prisma.refund.count()).toBe(0);
    expect(cashfree.refunds.size).toBe(0);
  });

  it('two concurrent refund requests refund once, and the acting admin is audited', async () => {
    const order = await cancelledUnrefundedOrder();
    const admin = await adminToken(UserRole.ADMIN);

    const send = () =>
      api()
        .post(`/api/v1/admin/orders/${order.orderId}/refund`)
        .set('Authorization', bearer(admin.token))
        .send({ reason: 'Customer called — refund' });
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(expectSuccess<{ refundId: string }>(first.body).data.refundId).toBe(
      expectSuccess<{ refundId: string }>(second.body).data.refundId,
    );

    const refunds = await prisma.refund.findMany({ where: { orderId: order.orderId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(order.totalPaise);
    expect(cashfree.refunds.size).toBe(1);

    const audit = await prisma.auditLog.findMany({ where: { action: 'payment.refund', entityId: order.orderId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: admin.userId, entityType: 'Order' });
    expect(audit[0]!.after).toMatchObject({ refundId: refunds[0]!.id, amountPaise: order.totalPaise });
  });
});

describe('automatic refunds on cancellation', () => {
  it('audit the seller-portion and the remaining-fees refund, attributed to whoever cancelled', async () => {
    const order = await placePaidOrder();
    expect((await cancelAsCustomer(order)).status).toBe(200);

    const refunds = await prisma.refund.findMany({ where: { orderId: order.orderId } });
    const audit = await prisma.auditLog.findMany({
      where: { entityId: order.orderId, action: { startsWith: 'payment.refund' } },
      orderBy: { createdAt: 'asc' },
    });
    const sellerOrder = await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.orderId } });
    const portion = refunds.find((r) => r.sellerOrderId === sellerOrder.id)!;
    const remainder = refunds.find((r) => r.sellerOrderId === null)!;

    expect(audit.map((a) => a.action)).toEqual(['payment.refund_seller_portion', 'payment.refund_remainder']);
    expect(audit.every((a) => a.actorUserId === order.userId)).toBe(true);
    expect(audit[0]!.after).toMatchObject({ refundId: portion.id, sellerOrderId: sellerOrder.id, amountPaise: portion.amountPaise });
    expect(audit[1]!.after).toMatchObject({ refundId: remainder.id, sellerOrderId: null, amountPaise: remainder.amountPaise });
    // One audit row per refund — no refund moves money unrecorded.
    expect(audit).toHaveLength(refunds.length);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Mass assignment                                                          */
/* -------------------------------------------------------------------------- */

describe('client-supplied payment state is ignored', () => {
  it('an order request cannot set its own status, payment status, amounts or refund state', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
    const session = await loginAs(MOBILE);
    const addressId = await seedAddress(session.userId);
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(session.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 2, unitPricePaise: 1 })
      .expect(200);

    const res = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({
        addressId,
        paymentMethod: PaymentMethod.ONLINE,
        status: OrderStatus.PROCESSING,
        paymentStatus: 'PAID',
        refundStatus: 'COMPLETED',
        totalPaise: 100,
        deliveryFeePaise: 0,
        platformFeePaise: 0,
        transactionId: 'pay_forged',
      })
      .expect(201);
    const created = expectSuccess<{ order: { id: string; bill: { totalPaise: number; itemsSubtotalPaise: number } } }>(
      res.body,
    ).data.order;

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.id } });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.paymentStatus).toBe('PENDING');
    expect(order.itemsSubtotalPaise).toBe(40000);
    expect(order.totalPaise).toBe(created.bill.totalPaise);
    expect(order.totalPaise).toBeGreaterThanOrEqual(40000);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);

    // The payment request cannot name its own amount either.
    const pay = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.id, amountPaise: 100, currency: 'USD' })
      .expect(200);
    const providerOrderId = expectSuccess<{ providerOrderId: string }>(pay.body).data.providerOrderId;
    expect(Math.round(cashfree.orders.get(providerOrderId)!.order_amount * 100)).toBe(order.totalPaise);
    expect(cashfree.orders.get(providerOrderId)!.order_currency).toBe('INR');
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Cross-customer access (IDOR)                                             */
/* -------------------------------------------------------------------------- */

describe("another customer's order", () => {
  it('cannot be paid for, verified, claimed, read or cancelled by someone else', async () => {
    const order = await placeOnlineOrder();
    await openCheckout(order);
    const intruder = await loginAs(OTHER_MOBILE);
    const auth = bearer(intruder.accessToken);

    const attempts = await Promise.all([
      api().post('/api/v1/payments/create').set('Authorization', auth).set('Idempotency-Key', randomUUID()).send({ orderId: order.orderId }),
      api().post(`/api/v1/payments/${order.orderId}/refresh`).set('Authorization', auth),
      api()
        .post('/api/v1/payments/verify')
        .set('Authorization', auth)
        .send({ orderId: order.orderId, providerOrderId: 'cf_order_x', providerPaymentId: 'cf_pay_x', signature: 'x'.repeat(32) }),
      api().post('/api/v1/payments/claim').set('Authorization', auth).send({ orderId: order.orderId, utr: '123456789012' }),
      api().get(`/api/v1/orders/${order.orderId}`).set('Authorization', auth),
      cancelAsCustomer(order, intruder.accessToken),
    ]);
    for (const res of attempts) expect(res.status).toBe(404);

    const status = await api().get(`/api/v1/payments/${order.orderId}/status`).set('Authorization', auth).expect(200);
    expect(status.body.data).toBeNull();

    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Concurrent checkouts of one cart                                         */
/* -------------------------------------------------------------------------- */

describe('one cart, two simultaneous checkouts', () => {
  it('creates exactly one order (different idempotency keys)', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
    const session = await loginAs(MOBILE);
    const addressId = await seedAddress(session.userId);
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(session.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 2 })
      .expect(200);

    const place = () =>
      api()
        .post('/api/v1/orders')
        .set('Authorization', bearer(session.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ addressId, paymentMethod: PaymentMethod.COD });
    const results = await Promise.all([place(), place()]);

    expect(results.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(await prisma.order.count({ where: { userId: session.userId } })).toBe(1);
    const offer = await prisma.sellerListing.findUniqueOrThrow({ where: { id: product.storeVariantId } });
    expect(offer.stockQty).toBe(8);
    expect(offer.reservedQty).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Per-user rate limit on payment routes                                    */
/* -------------------------------------------------------------------------- */

describe('payment routes are rate-limited per customer', () => {
  it('the 61st call in a minute is refused for that customer only; the gateway webhook is not limited', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order); // call 1
    const status = (token: string) =>
      api().get(`/api/v1/payments/${order.orderId}/status`).set('Authorization', bearer(token));

    for (let i = 2; i <= 60; i += 1) expect((await status(order.token)).status).toBe(200);
    const limited = await status(order.token);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe(ErrorCode.RATE_LIMITED);

    const other = await loginAs(OTHER_MOBILE);
    expect((await status(other.accessToken)).status).toBe(200);

    // The gateway's webhook still settles the order.
    const paid = cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    const hook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, paid);
    expect((await api().post('/api/v1/payments/webhook').set(hook.headers).send(hook.raw)).status).toBe(200);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Amount mismatch is recorded for admins                                  */
/* -------------------------------------------------------------------------- */

describe('a capture for the wrong amount', () => {
  it('is never applied, and is recorded once in the audit log however often it arrives', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    const paid = cashfree.attempt(checkout.providerOrderId, 'SUCCESS', { amountRupees: 1 });

    for (let i = 0; i < 2; i += 1) {
      const res = await api().post(`/api/v1/payments/${order.orderId}/refresh`).set('Authorization', bearer(order.token));
      expect(res.body.error.code).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
    }
    const hook = cashfree.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', checkout.providerOrderId, paid);
    expect((await api().post('/api/v1/payments/webhook').set(hook.headers).send(hook.raw)).status).toBe(200);
    await prisma.payment.update({ where: { id: checkout.paymentId }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    await reconcileCheckoutPayments();

    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });
    const audit = await prisma.auditLog.findMany({ where: { action: 'payment.amount_mismatch', entityId: order.orderId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({
      providerOrderId: checkout.providerOrderId,
      providerPaymentId: paid.cf_payment_id,
      expectedPaise: order.totalPaise,
      capturedPaise: 100,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Gateway timeout during verification                                      */
/* -------------------------------------------------------------------------- */

describe('gateway unreachable while verifying', () => {
  it('changes nothing, and reconciliation settles the payment later', async () => {
    const order = await placeOnlineOrder();
    const checkout = await openCheckout(order);
    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');

    cashfree.failNext = { status: 503, code: 'service_unavailable', message: 'temporarily unavailable' };
    const res = await api().post(`/api/v1/payments/${order.orderId}/refresh`).set('Authorization', bearer(order.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain('x-client-secret');
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentStatus: 'PENDING' });

    await prisma.payment.update({
      where: { id: checkout.paymentId },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    });
    expect(await reconcileCheckoutPayments()).toBe(1);
    expect(await dbOrder(order)).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
  });
});
