/**
 * Task 16.3 — end-to-end order lifecycle.
 *
 * Walks the whole business, not a single endpoint: customer registers,
 * browses, adds to cart, adds an address, checks out, pays; the seller
 * accepts, prepares, packs, a rider is assigned and delivers; money and stock
 * end up where they should.
 *
 * This is the test that would catch a break BETWEEN modules — a state
 * transition that forgets to commit stock, an admin action that skips the
 * refund, a delivery OTP that never gets verified. The per-module tests each
 * pass while the journey is broken.
 *
 * V2: the per-seller portion of the journey (accept/prepare/ready/reject)
 * lives on SellerOrder now, not on the parent Order — this suite only ever
 * seeds one platform seller, so it drives that single SellerOrder through
 * the admin's cross-seller override (`/admin/seller-orders/:id/status`).
 * The parent Order only ever transitions for payment and the delivery leg
 * (PICKED_UP -> OUT_FOR_DELIVERY -> DELIVERED), which is now an explicit
 * three-step hop rather than one straight to OUT_FOR_DELIVERY.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  OrderStatus,
  PaymentMethod,
  SellerOrderStatus,
  UserRole,
  type AdminOrderSummaryDto,
  type CursorPage,
  type OrderDetailDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { hashPassword } from '../../src/common/crypto';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { MockPaymentProvider } from '../../src/infra/payment';
import { FAR, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const CUSTOMER_MOBILE = '9876543210';
const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: {
      mobile: '0000000001',
      email: ADMIN.email,
      fullName: 'Store Owner',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });

  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

/** Drives the PARENT order's own board — payment settling and the delivery
 * leg only; per-seller accept/prepare/ready/reject is `advanceSellerOrder`. */
async function advance(
  adminToken: string,
  orderId: string,
  toStatus: OrderStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await api()
    .patch(`/api/v1/admin/orders/${orderId}/status`)
    .set('Authorization', bearer(adminToken))
    .send({ toStatus, ...extra })
    .expect(204);
}

/** Drives the seller's own side of the board for every SellerOrder under a
 * (single-seller, in this suite) parent order — admin's cross-seller
 * override, since there is no seller-panel login here. */
async function advanceSellerOrders(
  adminToken: string,
  orderId: string,
  toStatus: SellerOrderStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sellerOrders = await prisma.sellerOrder.findMany({ where: { orderId } });
  for (const sellerOrder of sellerOrders) {
    await api()
      .patch(`/api/v1/admin/seller-orders/${sellerOrder.id}/status`)
      .set('Authorization', bearer(adminToken))
      .send({ toStatus, ...extra })
      .expect(204);
  }
}

async function orderStatus(orderId: string): Promise<OrderStatus> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return order.status;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(CUSTOMER_MOBILE);
  await cache.clear();
});

describe('E2E — online payment, delivered', () => {
  it('runs the full journey from registration to delivery', async () => {
    /* --- setup ---------------------------------------------------------- */
    const storeId = await seedStore();
    const product = await seedProduct(storeId, {
      name: 'Aashirvaad Atta',
      pricePaise: 24900,
      mrpPaise: 28500,
      stockQty: 10,
    });
    const adminToken = await loginAdmin();

    /* --- 1. customer registers ------------------------------------------ */
    const customer = await loginAs(CUSTOMER_MOBILE);
    expect(customer.accessToken).toBeTruthy();

    /* --- 2. browses ------------------------------------------------------ */
    const catalogue = await api().get('/api/v1/products?inStock=true').expect(200);
    const items = expectSuccess<CursorPage<{ id: string }>>(catalogue.body).data.items;
    expect(items.length).toBeGreaterThan(0);

    /* --- 3. adds to cart ------------------------------------------------- */
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(customer.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 2 })
      .expect(200);

    /* --- 4. adds an address ---------------------------------------------- */
    const addressId = await seedAddress(customer.userId);

    /* --- 5. reviews the server's bill ------------------------------------ */
    const quoted = await api()
      .post('/api/v1/checkout/quote')
      .set('Authorization', bearer(customer.accessToken))
      .send({ addressId })
      .expect(200);

    const quote = expectSuccess<{
      bill: { totalPaise: number };
      codAllowed: boolean;
      etaMinutes: number;
    }>(quoted.body).data;

    expect(quote.bill.totalPaise).toBeGreaterThan(0);
    expect(quote.etaMinutes).toBeGreaterThan(0);

    /* --- 6. places the order --------------------------------------------- */
    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      // The total the customer saw, sent as a safety check.
      .send({
        addressId,
        paymentMethod: PaymentMethod.ONLINE,
        expectedTotalPaise: quote.bill.totalPaise,
      })
      .expect(201);

    const order = expectSuccess<{ order: OrderDetailDto; requiresPayment: boolean }>(placed.body)
      .data;

    expect(order.requiresPayment).toBe(true);
    expect(order.order.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Stock is HELD, not sold, while payment is outstanding.
    let offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(10);
    expect(offer.reservedQty).toBe(2);

    /* --- 7. pays ---------------------------------------------------------- */
    const intent = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.order.id })
      .expect(200);

    const providerOrderId = expectSuccess<{ providerOrderId: string }>(intent.body).data
      .providerOrderId;
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;

    await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(customer.accessToken))
      .send({
        orderId: order.order.id,
        providerOrderId,
        providerPaymentId,
        signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId),
      })
      .expect(200);

    // PAYMENT_CONFIRMED is transient — the customer never rests there.
    expect(await orderStatus(order.order.id)).toBe(OrderStatus.PROCESSING);

    // Reservation converted into a sale.
    offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(8);
    expect(offer.reservedQty).toBe(0);

    /* --- 8. the order appears on the store's board ------------------------ */
    const board = await api()
      .get('/api/v1/admin/orders?tab=PROCESSING')
      .set('Authorization', bearer(adminToken))
      .expect(200);

    const newOrders = expectSuccess<CursorPage<AdminOrderSummaryDto>>(board.body).data.items;
    expect(newOrders).toHaveLength(1);
    expect(newOrders[0]!.orderNumber).toBe(order.order.orderNumber);
    expect(newOrders[0]!.paymentStatus).toBe('PAID');

    /* --- 9. the seller works the order (V2: per-seller, not per-order) --- */
    await advanceSellerOrders(adminToken, order.order.id, SellerOrderStatus.ACCEPTED);
    await advanceSellerOrders(adminToken, order.order.id, SellerOrderStatus.PREPARING);
    await advanceSellerOrders(adminToken, order.order.id, SellerOrderStatus.READY_FOR_PICKUP);

    // Every (here: the only) SellerOrder is ready, so the parent order is
    // recomputed straight to READY_FOR_PICKUP without anyone choosing it
    // directly.
    expect(await orderStatus(order.order.id)).toBe(OrderStatus.READY_FOR_PICKUP);

    /* --- 10. dispatch requires a rider ------------------------------------ */
    const withoutRider = await api()
      .patch(`/api/v1/admin/orders/${order.order.id}/status`)
      .set('Authorization', bearer(adminToken))
      .send({ toStatus: OrderStatus.PICKED_UP });

    // Nobody would be holding the parcel — refused rather than silently allowed.
    expect(withoutRider.status).toBe(422);
    expect(expectError(withoutRider.body).code).toBe(ErrorCode.DELIVERY_AGENT_REQUIRED);

    const createdAgent = await api()
      .post('/api/v1/admin/delivery-agents')
      .set('Authorization', bearer(adminToken))
      .send({ name: 'Ramesh Kumar', mobile: '9876500001', vehicleNumber: 'RJ23 AB 1234' })
      .expect(201);

    const agentId = expectSuccess<{ id: string }>(createdAgent.body).data.id;

    await api()
      .post(`/api/v1/admin/orders/${order.order.id}/assign`)
      .set('Authorization', bearer(adminToken))
      .send({ agentId })
      .expect(200);

    // READY_FOR_PICKUP -> PICKED_UP -> OUT_FOR_DELIVERY: an explicit hop now,
    // not a single jump straight to OUT_FOR_DELIVERY.
    await advance(adminToken, order.order.id, OrderStatus.PICKED_UP);
    await advance(adminToken, order.order.id, OrderStatus.OUT_FOR_DELIVERY);
    await advance(adminToken, order.order.id, OrderStatus.DELIVERED);

    /* --- 11. the customer sees the finished journey ------------------------ */
    const tracked = await api()
      .get(`/api/v1/orders/${order.order.id}`)
      .set('Authorization', bearer(customer.accessToken))
      .expect(200);

    const detail = expectSuccess<OrderDetailDto>(tracked.body).data;
    expect(detail.status).toBe(OrderStatus.DELIVERED);
    expect(detail.bucket).toBe('DELIVERED');
    expect(detail.deliveryAgent).toBeNull(); // only shown while out for delivery
    // Every one of the five customer-facing steps is complete.
    expect(detail.timeline.every((step) => step.status === 'COMPLETED')).toBe(true);

    /* --- 12. history is intact -------------------------------------------- */
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: order.order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((row) => row.toStatus)).toEqual([
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.PROCESSING,
      // Recomputed the instant the SellerOrder reached READY_FOR_PICKUP —
      // no PREPARING/ACCEPTED entries here, those live on
      // SellerOrderStatusHistory instead (#7).
      OrderStatus.READY_FOR_PICKUP,
      OrderStatus.PICKED_UP,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED,
    ]);

    // The customer was notified at every meaningful step.
    const notifications = await prisma.notification.findMany({
      where: { orderId: order.order.id },
    });
    expect(notifications.length).toBeGreaterThanOrEqual(5);
  });
});

describe('E2E — cash on delivery', () => {
  it('delivers without the delivery OTP and records the cash', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 20000, stockQty: 5 });
    const adminToken = await loginAdmin();
    const customer = await loginAs(CUSTOMER_MOBILE);
    const addressId = await seedAddress(customer.userId);

    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(customer.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 1 })
      .expect(200);

    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.COD })
      .expect(201);

    const order = expectSuccess<{ order: OrderDetailDto }>(placed.body).data.order;

    // COD skips the payment gate entirely and stock leaves immediately.
    expect(order.status).toBe(OrderStatus.PROCESSING);
    // Still issued to the customer; delivery no longer depends on it.
    expect(order.deliveryOtp).toMatch(/^\d{4}$/);

    const agent = await api()
      .post('/api/v1/admin/delivery-agents')
      .set('Authorization', bearer(adminToken))
      .send({ name: 'Suresh Meena', mobile: '9876500002' })
      .expect(201);

    await advanceSellerOrders(adminToken, order.id, SellerOrderStatus.ACCEPTED);
    await advanceSellerOrders(adminToken, order.id, SellerOrderStatus.PREPARING);
    await advanceSellerOrders(adminToken, order.id, SellerOrderStatus.READY_FOR_PICKUP);
    await api()
      .post(`/api/v1/admin/orders/${order.id}/assign`)
      .set('Authorization', bearer(adminToken))
      .send({ agentId: expectSuccess<{ id: string }>(agent.body).data.id })
      .expect(200);
    await advance(adminToken, order.id, OrderStatus.PICKED_UP);
    await advance(adminToken, order.id, OrderStatus.OUT_FOR_DELIVERY);

    /* the OTP is optional — but one that IS entered must match */
    const wrongOtp = await api()
      .patch(`/api/v1/admin/orders/${order.id}/status`)
      .set('Authorization', bearer(adminToken))
      .send({ toStatus: OrderStatus.DELIVERED, deliveryOtp: '0000' });

    expect(wrongOtp.status).toBe(400);
    expect(expectError(wrongOtp.body).code).toBe(ErrorCode.DELIVERY_OTP_INVALID);
    expect(await orderStatus(order.id)).toBe(OrderStatus.OUT_FOR_DELIVERY);

    // No deliveryOtp field at all.
    await advance(adminToken, order.id, OrderStatus.DELIVERED, {
      cashCollectedPaise: order.bill.totalPaise,
    });

    const settled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(settled.status).toBe(OrderStatus.DELIVERED);
    // COD money lands only on delivery.
    expect(settled.paymentStatus).toBe('PAID');

    // Cash is recorded against the rider, so day-end reconciliation works.
    const task = await prisma.deliveryTask.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(task.cashCollectedPaise).toBe(order.bill.totalPaise);
    expect(task.status).toBe('DELIVERED');
  });
});

describe('E2E — rejection paths', () => {
  it('refuses an order to an address outside the delivery area', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, {});
    const customer = await loginAs(CUSTOMER_MOBILE);
    const farAddressId = await seedAddress(customer.userId, FAR);

    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(customer.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 1 })
      .expect(200);

    const res = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId: farAddressId, paymentMethod: PaymentMethod.COD });

    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
    expect(await prisma.order.count()).toBe(0);
  });

  it('refunds a paid order when the seller rejects it', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 20000, stockQty: 5 });
    const adminToken = await loginAdmin();
    const customer = await loginAs(CUSTOMER_MOBILE);
    const addressId = await seedAddress(customer.userId);

    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(customer.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 2 })
      .expect(200);

    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.ONLINE })
      .expect(201);

    const orderId = expectSuccess<{ order: { id: string } }>(placed.body).data.order.id;

    const intent = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId })
      .expect(200);

    const providerOrderId = expectSuccess<{ providerOrderId: string }>(intent.body).data
      .providerOrderId;
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;

    await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(customer.accessToken))
      .send({
        orderId,
        providerOrderId,
        providerPaymentId,
        signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId),
      })
      .expect(200);

    /* the seller cannot fulfil it — rejecting its SellerOrder is now the
     * per-seller action; there is no order-level REJECTED status in V2. */
    await advanceSellerOrders(adminToken, orderId, SellerOrderStatus.REJECTED, {
      reason: 'Out of stock at counter',
    });

    // Money returned WITHOUT anyone remembering to press a refund button.
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
    expect(refund.status).toBe('COMPLETED');

    const settled = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(settled.paymentStatus).toBe('REFUNDED');
    // Every SellerOrder under this single-seller order was rejected, so the
    // parent has nothing left to fulfil.
    expect(settled.status).toBe(OrderStatus.CANCELLED);

    // And the goods went back on the shelf.
    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(5);
    expect(offer.reservedQty).toBe(0);
  });
});
