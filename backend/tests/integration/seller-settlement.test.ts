/**
 * Seller earnings + settlement — commission/gross/net figures reused
 * verbatim from the immutable OrderItem/SellerOrder snapshot (tax-inclusive
 * subtotal, never subtotal + tax), settlement eligibility (delivered + paid,
 * excluding cancelled/rejected portions), duplicate/idempotency protection,
 * and the PENDING -> PROCESSING -> PAID state machine.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, PaymentMethod, SellerOrderStatus, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { MockPaymentProvider } from '../../src/infra/payment';
import * as paymentsInfra from '../../src/infra/payment';
import * as paymentService from '../../src/modules/payments/payment.service';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';
import { SETTLEMENT_CLOSE_LAG_MS } from '../../src/modules/sellers/seller-settlement.service';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };
const PAST_START = '2020-01-01T00:00:00.000Z';

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: {
      mobile: '0000000001',
      email: ADMIN.email,
      fullName: 'Admin',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSellerWithOwner(mobile: string, name: string, defaultCommissionBp = 0): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      isPlatformOwned: false,
      addressLine: 'Test Address',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      defaultCommissionBp,
      // Customers can only order from a live seller (cart/orderability.ts).
      onboardingStatus: 'APPROVED',
    },
  });
  const user = await prisma.user.create({
    data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER },
  });
  await prisma.sellerStaff.create({
    data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true },
  });
  return seller.id;
}

async function loginSeller(mobile: string): Promise<string> {
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  return session.accessToken;
}

async function addListing(adminToken: string, sellerId: string, variantId: string, pricePaise: number, stockQty = 50) {
  const res = await api()
    .post(`/api/v1/admin/sellers/${sellerId}/listings`)
    .set('Authorization', bearer(adminToken))
    .send({ variantId, mrpPaise: pricePaise + 100, pricePaise, stockQty })
    .expect(201);
  return expectSuccess<{ id: string }>(res.body).data.id;
}

async function advanceSellerOrderToReady(adminToken: string, sellerOrderId: string) {
  for (const status of [SellerOrderStatus.ACCEPTED, SellerOrderStatus.PREPARING, SellerOrderStatus.READY_FOR_PICKUP]) {
    await api()
      .patch(`/api/v1/admin/seller-orders/${sellerOrderId}/status`)
      .set('Authorization', bearer(adminToken))
      .send({ toStatus: status })
      .expect(204);
  }
}

async function deliverParentOrder(adminToken: string, orderId: string, opts: { deliveryOtp?: string } = {}) {
  const agent = await api()
    .post('/api/v1/admin/delivery-agents')
    .set('Authorization', bearer(adminToken))
    .send({ name: `Rider ${randomUUID().slice(0, 6)}`, mobile: `98765${Math.floor(10000 + Math.random() * 89999)}` })
    .expect(201);
  const agentId = expectSuccess<{ id: string }>(agent.body).data.id;

  await api()
    .post(`/api/v1/admin/orders/${orderId}/assign`)
    .set('Authorization', bearer(adminToken))
    .send({ agentId })
    .expect(200);

  for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
    await api().patch(`/api/v1/admin/orders/${orderId}/status`).set('Authorization', bearer(adminToken)).send({ toStatus }).expect(204);
  }
  await api()
    .patch(`/api/v1/admin/orders/${orderId}/status`)
    .set('Authorization', bearer(adminToken))
    .send({ toStatus: 'DELIVERED', ...(opts.deliveryOtp ? { deliveryOtp: opts.deliveryOtp } : {}) })
    .expect(204);
}

interface PlacedOrder {
  orderId: string;
  sellerOrders: { id: string; sellerId: string }[];
  deliveryOtp: string | null;
}

async function placeMixedOrder(
  customerToken: string,
  addressId: string,
  items: { listingId: string; qty: number }[],
  paymentMethod: PaymentMethod,
): Promise<PlacedOrder> {
  for (const item of items) {
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(customerToken))
      .send({ sellerListingId: item.listingId, qty: item.qty })
      .expect(200);
  }

  const placed = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(customerToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod })
    .expect(201);
  const order = expectSuccess<{ order: { id: string; deliveryOtp: string | null; sellerOrders: { id: string; sellerId: string }[] } }>(
    placed.body,
  ).data.order;

  if (paymentMethod === PaymentMethod.ONLINE) {
    const intent = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(customerToken))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.id })
      .expect(200);
    const providerOrderId = expectSuccess<{ providerOrderId: string }>(intent.body).data.providerOrderId;
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;
    await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(customerToken))
      .send({
        orderId: order.id,
        providerOrderId,
        providerPaymentId,
        signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId),
      })
      .expect(200);
  }

  return { orderId: order.id, sellerOrders: order.sellerOrders, deliveryOtp: order.deliveryOtp };
}

const CUSTOMER_MOBILE = '9400000001';

async function customerAndAddress() {
  await otpService.clearOtpState(CUSTOMER_MOBILE);
  const customer = await loginAs(CUSTOMER_MOBILE);
  const addressId = await seedAddress(customer.userId);
  return { token: customer.accessToken, addressId };
}

/**
 * A settlement period must end SETTLEMENT_CLOSE_LAG_MS in the past. Rather
 * than sleeping (or backdating financial rows), move only `Date.now()` —
 * which the settlement service reads — past that lag. `new Date()` (used
 * for deliveredAt) and DB defaults are unaffected.
 */
function moveClockPastCloseLag(): void {
  const realNow = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(realNow + SETTLEMENT_CLOSE_LAG_MS + 1_000);
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface EarningsSummary {
  sellerId: string;
  grossSalesPaise: number;
  commissionPaise: number;
  cancelledAmountPaise: number;
  refundedAmountPaise: number;
  netPayablePaise: number;
  notYetEligiblePaise: number;
  pendingSettlementPaise: number;
  inSettlementPaise: number;
  settledAmountPaise: number;
}

interface EarningsRow {
  sellerOrderId: string;
  grossPaise: number;
  commissionPaise: number;
  finalPayablePaise: number;
}

interface SettlementDetail {
  id: string;
  sellerId: string;
  periodStart: string;
  periodEnd: string;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  status: string;
  paidAt: string | null;
  sellerOrders: EarningsRow[];
}

async function sellerEarnings(adminToken: string, sellerId: string): Promise<EarningsSummary> {
  const res = await api().get(`/api/v1/admin/sellers/${sellerId}/earnings`).set('Authorization', bearer(adminToken)).expect(200);
  return expectSuccess<EarningsSummary>(res.body).data;
}

const createSettlement = (token: string, sellerId: string, body: object = {}) =>
  api().post(`/api/v1/admin/sellers/${sellerId}/settlements`).set('Authorization', bearer(token)).send(body);

/** One single-seller order, placed, fulfilled and delivered. */
async function deliveredSeller(mobile: string, name: string, pricePaise: number, method: PaymentMethod = PaymentMethod.COD) {
  const adminToken = await loginAdmin();
  const platformSellerId = await seedStore();
  const sellerId = await seedSellerWithOwner(mobile, name);
  const product = await seedProduct(platformSellerId, { pricePaise, stockQty: 10 });
  const listingId = await addListing(adminToken, sellerId, product.variantId, pricePaise);
  const { token, addressId } = await customerAndAddress();
  const placed = await placeMixedOrder(token, addressId, [{ listingId, qty: 1 }], method);
  for (const so of placed.sellerOrders) await advanceSellerOrderToReady(adminToken, so.id);
  await deliverParentOrder(
    adminToken,
    placed.orderId,
    method === PaymentMethod.COD ? { deliveryOtp: placed.deliveryOtp! } : {},
  );
  return { adminToken, sellerId, placed };
}

/** A paid ONLINE order with exactly one (non-platform) seller portion, not yet acted on. */
async function paidSingleSellerOrder(mobile: string, name: string, pricePaise: number) {
  const adminToken = await loginAdmin();
  const platformSellerId = await seedStore();
  const sellerId = await seedSellerWithOwner(mobile, name);
  const product = await seedProduct(platformSellerId, { pricePaise, stockQty: 10 });
  const listingId = await addListing(adminToken, sellerId, product.variantId, pricePaise);
  const { token, addressId } = await customerAndAddress();
  const placed = await placeMixedOrder(token, addressId, [{ listingId, qty: 1 }], PaymentMethod.ONLINE);
  expect(placed.sellerOrders).toHaveLength(1);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
  expect([order.status, order.paymentStatus]).toEqual(['PROCESSING', 'PAID']);
  expect(order.deliveryFeePaise + order.platformFeePaise - order.couponDiscountPaise).toBeGreaterThan(0);
  return { adminToken, sellerId, placed };
}

describe('earnings + commission reuse', () => {
  it('a delivered, paid mixed-seller order gives each seller only its own tax-inclusive portion', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const platformProduct = await seedProduct(platformSellerId, { pricePaise: 2000, stockQty: 20 });

    const qaSellerId = await seedSellerWithOwner('9400000010', 'Settlement Seller QA', 500); // 5%
    // 5% GST INSIDE the price: 238 of the 5000 is tax, extracted, never added on top.
    const qaProduct = await seedProduct(platformSellerId, { pricePaise: 5000, stockQty: 20, taxRateBp: 500 });
    const qaListingId = await addListing(adminToken, qaSellerId, qaProduct.variantId, 5000);

    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(
      token,
      addressId,
      [
        { listingId: platformProduct.storeVariantId, qty: 2 }, // 4000
        { listingId: qaListingId, qty: 1 }, // 5000
      ],
      PaymentMethod.ONLINE,
    );
    expect(placed.sellerOrders).toHaveLength(2);
    expect(await prisma.payment.count({ where: { orderId: placed.orderId, status: 'CAPTURED' } })).toBe(1);

    for (const so of placed.sellerOrders) await advanceSellerOrderToReady(adminToken, so.id);
    await deliverParentOrder(adminToken, placed.orderId);

    const qaSo = placed.sellerOrders.find((s) => s.sellerId === qaSellerId)!;
    const dbQaSo = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: qaSo.id } });
    expect(dbQaSo.taxPaise).toBe(238);
    expect(dbQaSo.subtotalPaise).toBe(5000);
    expect(dbQaSo.commissionPaise).toBe(250);
    const qaItems = await prisma.orderItem.findMany({ where: { sellerOrderId: qaSo.id } });
    expect(qaItems.reduce((s, i) => s + i.commissionPaise, 0)).toBe(dbQaSo.commissionPaise);

    // Changing the commission configuration AFTER the order must not change it.
    await prisma.seller.update({ where: { id: qaSellerId }, data: { defaultCommissionBp: 2000 } });

    const qaRes = await api()
      .get('/api/v1/seller/earnings')
      .set('Authorization', bearer(await loginSeller('9400000010')))
      .expect(200);
    const qa = expectSuccess<EarningsSummary>(qaRes.body).data;
    expect(qa.grossSalesPaise).toBe(5000); // NOT 5000 + 238
    expect(qa.commissionPaise).toBe(250);
    expect(qa.netPayablePaise).toBe(4750);
    expect(qa.pendingSettlementPaise).toBe(4750);
    expect(qa.notYetEligiblePaise + qa.pendingSettlementPaise + qa.inSettlementPaise + qa.settledAmountPaise).toBe(
      qa.netPayablePaise,
    );

    const platform = await sellerEarnings(adminToken, platformSellerId);
    expect(platform.grossSalesPaise).toBe(4000);
    expect(platform.commissionPaise).toBe(0);
    expect(platform.pendingSettlementPaise).toBe(4000);

    moveClockPastCloseLag();
    const created = await createSettlement(adminToken, qaSellerId).expect(201);
    const settlement = expectSuccess<SettlementDetail>(created.body).data;
    expect(settlement.grossSalesPaise).toBe(5000);
    expect(settlement.commissionPaise).toBe(250);
    expect(settlement.netPayablePaise).toBe(4750);
    expect(settlement.sellerOrders.map((r) => r.sellerOrderId)).toEqual([qaSo.id]);
  });

  it('admin sees every seller in the cross-seller earnings view', async () => {
    const { adminToken, sellerId } = await deliveredSeller('9400000014', 'Cross Seller View', 1800);
    const res = await api().get('/api/v1/admin/earnings').set('Authorization', bearer(adminToken)).expect(200);
    const rows = expectSuccess<EarningsSummary[]>(res.body).data;
    expect(rows.find((r) => r.sellerId === sellerId)?.pendingSettlementPaise).toBe(1800);
  });
});

describe('authorization', () => {
  it('customer -> seller earnings is 403', async () => {
    await otpService.clearOtpState('9400000013');
    const customer = await loginAs('9400000013');
    const res = await api().get('/api/v1/seller/earnings').set('Authorization', bearer(customer.accessToken));
    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });

  it("seller A cannot reach seller B's earnings, via admin routes or X-Seller-Id", async () => {
    const sellerAId = await seedSellerWithOwner('9400000011', 'Earnings Seller A');
    const sellerBId = await seedSellerWithOwner('9400000012', 'Earnings Seller B');
    const tokenA = await loginSeller('9400000011');

    expect((await api().get(`/api/v1/admin/sellers/${sellerBId}/earnings`).set('Authorization', bearer(tokenA))).status).toBe(403);
    expect((await api().get('/api/v1/admin/earnings').set('Authorization', bearer(tokenA))).status).toBe(403);

    const viaHeader = await api()
      .get('/api/v1/seller/earnings')
      .set('Authorization', bearer(tokenA))
      .set('X-Seller-Id', sellerBId)
      .expect(200);
    expect(expectSuccess<EarningsSummary>(viaHeader.body).data.sellerId).toBe(sellerAId);
  });

  it('seller -> admin settlement endpoints are 403', async () => {
    const { sellerId, adminToken } = await deliveredSeller('9400000042', 'NoManage Seller', 1000);
    moveClockPastCloseLag();
    const created = await createSettlement(adminToken, sellerId).expect(201);
    const settlementId = expectSuccess<{ id: string }>(created.body).data.id;
    const token = await loginSeller('9400000042');

    const attempts = [
      api().post(`/api/v1/admin/sellers/${sellerId}/settlements`).send({}),
      api().get(`/api/v1/admin/sellers/${sellerId}/settlements/eligible`),
      api().get('/api/v1/admin/settlements'),
      api().get(`/api/v1/admin/settlements/${settlementId}`),
      api().patch(`/api/v1/admin/settlements/${settlementId}/status`).send({ status: 'PROCESSING' }),
    ];
    for (const attempt of attempts) {
      expect((await attempt.set('Authorization', bearer(token))).status).toBe(403);
    }
  });
});

describe('settlement eligibility', () => {
  it('excludes an order that has not been delivered yet, even if paid', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const qaSellerId = await seedSellerWithOwner('9400000020', 'Undelivered Seller');
    const product = await seedProduct(platformSellerId, { pricePaise: 3000, stockQty: 10 });
    const listingId = await addListing(adminToken, qaSellerId, product.variantId, 3000);

    const { token, addressId } = await customerAndAddress();
    await placeMixedOrder(token, addressId, [{ listingId, qty: 1 }], PaymentMethod.ONLINE);

    moveClockPastCloseLag();
    const preview = await api()
      .get(`/api/v1/admin/sellers/${qaSellerId}/settlements/eligible`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    expect(expectSuccess<{ sellerOrders: unknown[] }>(preview.body).data.sellerOrders).toHaveLength(0);
    const earnings = await sellerEarnings(adminToken, qaSellerId);
    expect(earnings.notYetEligiblePaise).toBe(3000);
    expect(earnings.pendingSettlementPaise).toBe(0);
  });

  it('does not mistake an undelivered COD order for a captured online payment', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const qaSellerId = await seedSellerWithOwner('9400000021', 'COD Undelivered Seller');
    const product = await seedProduct(platformSellerId, { pricePaise: 2500, stockQty: 10 });
    const listingId = await addListing(adminToken, qaSellerId, product.variantId, 2500);

    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(token, addressId, [{ listingId, qty: 1 }], PaymentMethod.COD);
    for (const so of placed.sellerOrders) await advanceSellerOrderToReady(adminToken, so.id);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.paymentStatus).toBe('PENDING');
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(0);

    moveClockPastCloseLag();
    expect((await createSettlement(adminToken, qaSellerId)).status).toBe(400);
    expect(await prisma.sellerSettlement.count()).toBe(0);
  });

  it('includes a delivered COD order once paymentStatus becomes PAID at delivery', async () => {
    const { adminToken, sellerId, placed } = await deliveredSeller('9400000022', 'COD Delivered Seller', 2500);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.paymentStatus).toBe('PAID');

    moveClockPastCloseLag();
    const preview = await api()
      .get(`/api/v1/admin/sellers/${sellerId}/settlements/eligible`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    const data = expectSuccess<{ sellerOrders: EarningsRow[]; netPayablePaise: number }>(preview.body).data;
    expect(data.sellerOrders.map((s) => s.sellerOrderId)).toEqual([placed.sellerOrders[0]!.id]);
    expect(data.netPayablePaise).toBe(2500);
  });

  it('refuses a period that has not closed yet (it would strand later deliveries)', async () => {
    const { adminToken, sellerId } = await deliveredSeller('9400000023', 'Future Period Seller', 1500);
    const res = await createSettlement(adminToken, sellerId, {
      periodStart: PAST_START,
      periodEnd: '2035-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(await prisma.sellerSettlement.count()).toBe(0);
  });
});

describe('unpaid online order whose payment expires', () => {
  it('is never shown to or actionable by the seller; on expiry its seller order ends CANCELLED and stock is released', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const sellerId = await seedSellerWithOwner('9400000090', 'Expiry Seller', 1000);
    const product = await seedProduct(platformSellerId, { pricePaise: 2600, stockQty: 10 });
    const listingId = await addListing(adminToken, sellerId, product.variantId, 2600);
    const sellerToken = await loginSeller('9400000090');

    // Place an ONLINE order and never pay it.
    const { token, addressId } = await customerAndAddress();
    await api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId: listingId, qty: 1 }).expect(200);
    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.ONLINE })
      .expect(201);
    const order = expectSuccess<{ order: { id: string; status: string; sellerOrders: { id: string }[] } }>(placed.body).data.order;
    expect(order.status).toBe('PENDING_PAYMENT');
    const soId = order.sellerOrders[0]!.id;
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: listingId } })).reservedQty).toBe(1);

    // While unpaid: invisible to the seller, and nobody can act on it.
    const list = await api().get('/api/v1/seller/orders').set('Authorization', bearer(sellerToken)).expect(200);
    expect(expectSuccess<{ items: { id: string }[] }>(list.body).data.items.map((r) => r.id)).not.toContain(soId);
    expect((await api().get(`/api/v1/seller/orders/${soId}`).set('Authorization', bearer(sellerToken))).status).toBe(404);
    expect((await api().patch(`/api/v1/seller/orders/${soId}/status`).set('Authorization', bearer(sellerToken)).send({ toStatus: 'ACCEPTED' })).status).toBe(404);
    const adminAccept = await api().patch(`/api/v1/admin/seller-orders/${soId}/status`).set('Authorization', bearer(adminToken)).send({ toStatus: 'ACCEPTED' });
    expect(adminAccept.status).toBe(409);
    expect(expectError(adminAccept.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);

    // The normal expiry mechanism: the hold runs out, the release job fails the order.
    await prisma.order.update({ where: { id: order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1_000) } });
    const { releaseExpiredReservations } = await import('../../src/jobs');
    expect(await releaseExpiredReservations()).toBe(1);

    const parent = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([parent.status, parent.paymentStatus]).toEqual(['PAYMENT_FAILED', 'FAILED']);
    const so = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: soId } });
    expect(so.status).toBe(SellerOrderStatus.CANCELLED);
    expect(so.cancellationReason).toBe('Payment was not completed in time');
    const history = await prisma.sellerOrderStatusHistory.findMany({ where: { sellerOrderId: soId } });
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.actorType])).toEqual([['NEW', 'CANCELLED', 'SYSTEM']]);
    const offer = await prisma.sellerListing.findUniqueOrThrow({ where: { id: listingId } });
    expect([offer.stockQty, offer.reservedQty]).toEqual([50, 0]);

    // The seller was never told about it — not at placement, not on expiry.
    expect(await prisma.notification.count({ where: { orderId: order.id, audience: 'SELLER' } })).toBe(0);
    // Still invisible, still not actionable, and never counted as a sale.
    expect((await api().get(`/api/v1/seller/orders/${soId}`).set('Authorization', bearer(sellerToken))).status).toBe(404);
    expect((await api().patch(`/api/v1/admin/seller-orders/${soId}/status`).set('Authorization', bearer(adminToken)).send({ toStatus: 'ACCEPTED' })).status).toBe(409);
    const earnings = await sellerEarnings(adminToken, sellerId);
    expect([earnings.grossSalesPaise, earnings.cancelledAmountPaise, earnings.notYetEligiblePaise]).toEqual([0, 0, 0]);
  });
});

describe('partial cancellation / refund impact', () => {
  it('excludes the cancelled+refunded seller portion while the sibling stays fully payable', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const platformProduct = await seedProduct(platformSellerId, { pricePaise: 1500, stockQty: 20 });
    const qaSellerId = await seedSellerWithOwner('9400000030', 'Partial Refund Seller', 1000);
    const qaProduct = await seedProduct(platformSellerId, { pricePaise: 4200, stockQty: 20, taxRateBp: 500 });
    const qaListingId = await addListing(adminToken, qaSellerId, qaProduct.variantId, 4200);

    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(
      token,
      addressId,
      [
        { listingId: platformProduct.storeVariantId, qty: 1 },
        { listingId: qaListingId, qty: 1 },
      ],
      PaymentMethod.ONLINE,
    );
    const before = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    const qaSo = placed.sellerOrders.find((s) => s.sellerId === qaSellerId)!;
    const platformSo = placed.sellerOrders.find((s) => s.sellerId === platformSellerId)!;

    await api()
      .patch(`/api/v1/admin/seller-orders/${qaSo.id}/status`)
      .set('Authorization', bearer(adminToken))
      .send({ toStatus: 'CANCELLED', reason: 'QA dev-test cancellation' })
      .expect(204);

    // Refund and payable adjustment are the tax-INCLUSIVE subtotal — never
    // subtotal + tax (4200 + 200 would over-refund).
    const refunds = await prisma.refund.findMany({ where: { sellerOrderId: qaSo.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe('COMPLETED');
    expect(refunds[0]!.amountPaise).toBe(4200);
    const afterCancel = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(afterCancel.currentPayablePaise).toBe(before.currentPayablePaise - 4200);
    expect(afterCancel.paymentStatus).toBe('PARTIALLY_REFUNDED');

    await advanceSellerOrderToReady(adminToken, platformSo.id);
    await deliverParentOrder(adminToken, placed.orderId);

    const qa = await sellerEarnings(adminToken, qaSellerId);
    expect(qa.grossSalesPaise).toBe(0);
    expect(qa.cancelledAmountPaise).toBe(4200);
    expect(qa.refundedAmountPaise).toBe(4200);
    expect(qa.netPayablePaise).toBe(0);
    expect(qa.pendingSettlementPaise).toBe(0);

    const platform = await sellerEarnings(adminToken, platformSellerId);
    expect(platform.grossSalesPaise).toBe(1500);
    expect(platform.pendingSettlementPaise).toBe(1500);

    moveClockPastCloseLag();
    expect((await createSettlement(adminToken, qaSellerId)).status).toBe(400); // nothing payable
    const platformCreate = await createSettlement(adminToken, platformSellerId).expect(201);
    expect(expectSuccess<SettlementDetail>(platformCreate.body).data.netPayablePaise).toBe(1500);
  });

  it('refuses to cancel a seller portion once the parent is delivered', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const product = await seedProduct(platformSellerId, { pricePaise: 1100, stockQty: 10 });
    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(
      token,
      addressId,
      [{ listingId: product.storeVariantId, qty: 1 }],
      PaymentMethod.ONLINE,
    );
    const soId = placed.sellerOrders[0]!.id;
    await advanceSellerOrderToReady(adminToken, soId);
    await deliverParentOrder(adminToken, placed.orderId);

    const res = await api()
      .patch(`/api/v1/admin/seller-orders/${soId}/status`)
      .set('Authorization', bearer(adminToken))
      .send({ toStatus: 'CANCELLED', reason: 'too late' });
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    expect(await prisma.refund.count({ where: { sellerOrderId: soId } })).toBe(0);
    expect((await prisma.sellerOrder.findUniqueOrThrow({ where: { id: soId } })).status).toBe('READY_FOR_PICKUP');
  });
});

describe('settlement creation + duplicate protection', () => {
  it('creates once; exact replay returns the same row; default retry and overlaps are refused', async () => {
    const { adminToken, sellerId } = await deliveredSeller('9400000040', 'Create Settlement Seller', 3300);
    moveClockPastCloseLag();

    const first = await createSettlement(adminToken, sellerId).expect(201);
    const settlement = expectSuccess<SettlementDetail>(first.body).data;
    expect(settlement.grossSalesPaise).toBe(3300);
    expect(settlement.status).toBe('PENDING');

    // Same explicit period again -> idempotent replay, 200, same id.
    const replay = await createSettlement(adminToken, sellerId, {
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
    }).expect(200);
    expect(expectSuccess<{ id: string }>(replay.body).data.id).toBe(settlement.id);

    // Default-body retry -> the seller's 24h cycle has not elapsed.
    expect((await createSettlement(adminToken, sellerId)).status).toBe(409);

    // Any overlapping period -> 409.
    const overlap = await createSettlement(adminToken, sellerId, { periodStart: PAST_START, periodEnd: settlement.periodEnd });
    expect(overlap.status).toBe(409);

    expect(await prisma.sellerSettlement.count({ where: { sellerId } })).toBe(1);
    const earnings = await sellerEarnings(adminToken, sellerId);
    expect(earnings.pendingSettlementPaise).toBe(0);
    expect(earnings.inSettlementPaise).toBe(3300);
  });

  it('concurrent create requests produce exactly one settlement', async () => {
    const { adminToken, sellerId } = await deliveredSeller('9400000043', 'Concurrent Settlement Seller', 2100);
    moveClockPastCloseLag();
    const results = await Promise.all(Array.from({ length: 4 }, () => createSettlement(adminToken, sellerId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.sellerSettlement.count({ where: { sellerId } })).toBe(1);
  });

  it('refuses a settlement with no eligible seller orders in the period', async () => {
    const adminToken = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9400000041', 'Empty Settlement Seller');
    moveClockPastCloseLag();
    expect((await createSettlement(adminToken, sellerId)).status).toBe(400);
  });
});

describe('settlement status transitions', () => {
  async function createdSettlement() {
    const { adminToken, sellerId } = await deliveredSeller('9400000050', 'Transition Seller', 1200);
    moveClockPastCloseLag();
    const res = await createSettlement(adminToken, sellerId).expect(201);
    return { adminToken, sellerId, settlementId: expectSuccess<{ id: string }>(res.body).data.id };
  }

  const setStatus = (token: string, id: string, status: string) =>
    api().patch(`/api/v1/admin/settlements/${id}/status`).set('Authorization', bearer(token)).send({ status });

  it('PENDING -> PROCESSING -> PAID, and a retried "mark PAID" is idempotent', async () => {
    const { adminToken, sellerId, settlementId } = await createdSettlement();

    await setStatus(adminToken, settlementId, 'PROCESSING').expect(200);
    const paid1 = await setStatus(adminToken, settlementId, 'PAID').expect(200);
    const paid1Data = expectSuccess<SettlementDetail>(paid1.body).data;
    expect(paid1Data.status).toBe('PAID');

    const paid2 = await setStatus(adminToken, settlementId, 'PAID').expect(200);
    expect(expectSuccess<SettlementDetail>(paid2.body).data.paidAt).toBe(paid1Data.paidAt);

    const earnings = await sellerEarnings(adminToken, sellerId);
    expect(earnings.settledAmountPaise).toBe(1200);
    expect(earnings.inSettlementPaise).toBe(0);
  });

  it('concurrent "mark PAID" requests stamp paidAt once', async () => {
    const { adminToken, settlementId } = await createdSettlement();
    await setStatus(adminToken, settlementId, 'PROCESSING').expect(200);
    const results = await Promise.all([1, 2, 3].map(() => setStatus(adminToken, settlementId, 'PAID')));
    const paidAts = new Set(results.map((r) => expectSuccess<SettlementDetail>(r.body).data.paidAt));
    expect(paidAts.size).toBe(1);
  });

  it('rejects an invalid transition (PENDING -> PAID directly)', async () => {
    const { adminToken, settlementId } = await createdSettlement();
    const res = await setStatus(adminToken, settlementId, 'PAID');
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });

  it('rejects any transition once a settlement is PAID (terminal)', async () => {
    const { adminToken, settlementId } = await createdSettlement();
    await setStatus(adminToken, settlementId, 'PROCESSING').expect(200);
    await setStatus(adminToken, settlementId, 'PAID').expect(200);
    expect((await setStatus(adminToken, settlementId, 'PROCESSING')).status).toBe(409);
    expect((await setStatus(adminToken, settlementId, 'FAILED')).status).toBe(409);
  });

  it('FAILED can only be re-queued as PENDING', async () => {
    const { adminToken, settlementId } = await createdSettlement();
    await setStatus(adminToken, settlementId, 'FAILED').expect(200);
    expect((await setStatus(adminToken, settlementId, 'PAID')).status).toBe(409);
    await setStatus(adminToken, settlementId, 'PENDING').expect(200);
  });

  it("a seller sees its own settlements and their sellerOrders, never another seller's", async () => {
    const { sellerId, settlementId } = await createdSettlement();
    const token = await loginSeller('9400000050');

    const list = await api().get('/api/v1/seller/settlements').set('Authorization', bearer(token)).expect(200);
    expect(expectSuccess<{ items: { id: string }[] }>(list.body).data.items.map((s) => s.id)).toEqual([settlementId]);

    const own = await api().get(`/api/v1/seller/settlements/${settlementId}`).set('Authorization', bearer(token)).expect(200);
    const ownData = expectSuccess<SettlementDetail>(own.body).data;
    expect(ownData.sellerId).toBe(sellerId);
    expect(ownData.commissionPaise).toBe(0);
    expect(ownData.sellerOrders).toHaveLength(1);

    await seedSellerWithOwner('9400000051', 'Other Seller Viewer');
    const otherToken = await loginSeller('9400000051');
    const denied = await api().get(`/api/v1/seller/settlements/${settlementId}`).set('Authorization', bearer(otherToken));
    expect(denied.status).toBe(404);
    const otherList = await api().get('/api/v1/seller/settlements').set('Authorization', bearer(otherToken)).expect(200);
    expect(expectSuccess<{ items: unknown[] }>(otherList.body).data.items).toHaveLength(0);
  });
});

describe('multi-seller refunds (partial refunds, full-cancellation final refund) and delivered-order refunds', () => {
  const cancelSo = (token: string, id: string) =>
    api()
      .patch(`/api/v1/admin/seller-orders/${id}/status`)
      .set('Authorization', bearer(token))
      .send({ toStatus: 'CANCELLED', reason: 'multi-seller refund test' });

  it('refunds a second cancelled seller portion after the parent is already PARTIALLY_REFUNDED, exactly once each', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const sellerAId = await seedSellerWithOwner('9400000060', 'Refund Seller A', 500);
    const sellerBId = await seedSellerWithOwner('9400000061', 'Refund Seller B', 1000);
    const productA = await seedProduct(platformSellerId, { pricePaise: 3000, stockQty: 10, taxRateBp: 1800 });
    const productB = await seedProduct(platformSellerId, { pricePaise: 2000, stockQty: 10, taxRateBp: 500 });
    const productC = await seedProduct(platformSellerId, { pricePaise: 1500, stockQty: 10 });
    const listingA = await addListing(adminToken, sellerAId, productA.variantId, 3000);
    const listingB = await addListing(adminToken, sellerBId, productB.variantId, 2000);

    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(
      token,
      addressId,
      [
        { listingId: listingA, qty: 1 },
        { listingId: listingB, qty: 1 },
        { listingId: productC.storeVariantId, qty: 1 },
      ],
      PaymentMethod.ONLINE,
    );
    const so = (sellerId: string) => placed.sellerOrders.find((s) => s.sellerId === sellerId)!.id;
    const before = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    await cancelSo(adminToken, so(sellerAId)).expect(204);
    const afterA = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(afterA.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(afterA.currentPayablePaise).toBe(before.currentPayablePaise - 3000);

    // Second portion, while the parent is already PARTIALLY_REFUNDED.
    await cancelSo(adminToken, so(sellerBId)).expect(204);
    const afterB = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(afterB.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(afterB.currentPayablePaise).toBe(before.currentPayablePaise - 3000 - 2000);

    // Retries are no-ops: no second refund, no second decrement.
    await cancelSo(adminToken, so(sellerAId)).expect(204);
    await cancelSo(adminToken, so(sellerBId)).expect(204);
    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId }, orderBy: { createdAt: 'asc' } });
    expect(refunds.map((r) => [r.sellerOrderId, r.amountPaise, r.status])).toEqual([
      [so(sellerAId), 3000, 'COMPLETED'],
      [so(sellerBId), 2000, 'COMPLETED'],
    ]);
    expect(new Set(refunds.map((r) => r.providerRefundId)).size).toBe(2);
    // The platform seller's portion is still active, so the delivery and
    // platform fees are NOT refunded yet — no order-level refund exists.
    expect(refunds.every((r) => r.sellerOrderId !== null)).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).currentPayablePaise).toBe(
      afterB.currentPayablePaise,
    );
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: placed.orderId } })).status).toBe('CAPTURED');

    // A full-order refund can't stack on top of the per-seller ones.
    const full = await api()
      .post(`/api/v1/admin/orders/${placed.orderId}/refund`)
      .set('Authorization', bearer(adminToken))
      .send({ reason: 'try to refund everything' });
    expect(full.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(2);

    // The surviving sibling is delivered and settled in full; A and B are not.
    await advanceSellerOrderToReady(adminToken, so(platformSellerId));
    await deliverParentOrder(adminToken, placed.orderId);
    expect((await sellerEarnings(adminToken, platformSellerId)).pendingSettlementPaise).toBe(1500);
    const a = await sellerEarnings(adminToken, sellerAId);
    expect([a.cancelledAmountPaise, a.refundedAmountPaise, a.netPayablePaise, a.pendingSettlementPaise]).toEqual([3000, 3000, 0, 0]);
    const b = await sellerEarnings(adminToken, sellerBId);
    expect([b.cancelledAmountPaise, b.refundedAmountPaise, b.netPayablePaise, b.pendingSettlementPaise]).toEqual([2000, 2000, 0, 0]);
  });

  it('cancelling every seller portion refunds each portion once, then the remaining fees in one final refund', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const sellerAId = await seedSellerWithOwner('9400000062', 'All Cancel Seller A', 1000);
    const productA = await seedProduct(platformSellerId, { pricePaise: 2500, stockQty: 10 });
    const productP = await seedProduct(platformSellerId, { pricePaise: 1700, stockQty: 10 });
    const listingA = await addListing(adminToken, sellerAId, productA.variantId, 2500);

    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(
      token,
      addressId,
      [
        { listingId: listingA, qty: 1 },
        { listingId: productP.storeVariantId, qty: 1 },
      ],
      PaymentMethod.ONLINE,
    );
    const so = (sellerId: string) => placed.sellerOrders.find((s) => s.sellerId === sellerId)!.id;
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: placed.orderId, status: 'CAPTURED' } });
    const placedOrder = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    const fees = placedOrder.deliveryFeePaise + placedOrder.platformFeePaise - placedOrder.couponDiscountPaise;
    expect(fees).toBeGreaterThan(0); // default ₹5 platform fee + delivery below the free threshold

    // First portion: its own refund only — the other portion is still active.
    await cancelSo(adminToken, so(sellerAId)).expect(204);
    const mid = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([mid.status, mid.paymentStatus]).toEqual(['PARTIALLY_CANCELLED', 'PARTIALLY_REFUNDED']);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId, sellerOrderId: null } })).toBe(0);

    // Last active portion: its refund, then ONE final order-level refund.
    await cancelSo(adminToken, so(platformSellerId)).expect(204);
    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId }, orderBy: { createdAt: 'asc' } });
    expect(refunds.map((r) => [r.sellerOrderId, r.amountPaise, r.status])).toEqual([
      [so(sellerAId), 2500, 'COMPLETED'],
      [so(platformSellerId), 1700, 'COMPLETED'],
      [null, fees, 'COMPLETED'],
    ]);
    // Exactly what was captured comes back — never more.
    expect(refunds.reduce((s, r) => s + r.amountPaise, 0)).toBe(payment.amountPaise);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('REFUNDED');
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId: placed.orderId }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => h.toStatus).slice(-2)).toEqual(['CANCELLED', 'REFUNDED']);
    expect(history.at(-1)!.actorType).toBe('SYSTEM');

    // Earnings/commission: each seller's refunded amount is its own portion
    // only; the fee refund belongs to no seller and nothing is payable.
    const a = await sellerEarnings(adminToken, sellerAId);
    expect([a.cancelledAmountPaise, a.refundedAmountPaise, a.commissionPaise, a.netPayablePaise, a.pendingSettlementPaise]).toEqual([
      2500, 2500, 0, 0, 0,
    ]);
    const p = await sellerEarnings(adminToken, platformSellerId);
    expect([p.cancelledAmountPaise, p.refundedAmountPaise, p.commissionPaise, p.netPayablePaise, p.pendingSettlementPaise]).toEqual([
      1700, 1700, 0, 0, 0,
    ]);
    // The item/seller-order commission snapshots themselves are untouched.
    const soA = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: so(sellerAId) }, include: { items: true } });
    expect(soA.commissionPaise).toBe(250);
    expect(soA.items.reduce((s, i) => s + (i.commissionPaise ?? 0), 0)).toBe(soA.commissionPaise);
  });

  it('a single-seller paid order cancelled in full gets the entire captured amount back', async () => {
    const { adminToken, sellerId, placed } = await paidSingleSellerOrder('9400000064', 'Single Cancel Seller', 3100);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: placed.orderId, status: 'CAPTURED' } });

    await cancelSo(adminToken, placed.sellerOrders[0]!.id).expect(204);

    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId }, orderBy: { createdAt: 'asc' } });
    expect(refunds.map((r) => [r.sellerOrderId !== null, r.status])).toEqual([
      [true, 'COMPLETED'],
      [false, 'COMPLETED'],
    ]);
    expect(refunds[0]!.amountPaise).toBe(3100);
    expect(refunds.reduce((s, r) => s + r.amountPaise, 0)).toBe(payment.amountPaise);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
    expect((await sellerEarnings(adminToken, sellerId)).refundedAmountPaise).toBe(3100);
  });

  it('repeated cancellation / refund attempts and an already fully refunded order are no-ops', async () => {
    const { adminToken, placed } = await paidSingleSellerOrder('9400000065', 'Repeat Cancel Seller', 2200);
    const soId = placed.sellerOrders[0]!.id;
    await cancelSo(adminToken, soId).expect(204);
    const before = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    expect(before).toHaveLength(2);

    // The same cancellation again, the refund hook called again directly,
    // and an admin full refund — none may move any more money.
    await cancelSo(adminToken, soId).expect(204);
    await paymentService.refundSellerOrderIfPaid(soId, 'retry');
    await paymentService.refundSellerOrderIfPaid(soId, 'retry again');
    const full = await api()
      .post(`/api/v1/admin/orders/${placed.orderId}/refund`)
      .set('Authorization', bearer(adminToken))
      .send({ reason: 'try to refund everything again' });
    expect(full.status).toBeGreaterThanOrEqual(400);

    const after = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
  });

  it('the order reaches REFUNDED only once the final refund actually succeeds', async () => {
    const { adminToken, placed } = await paidSingleSellerOrder('9400000066', 'Failing Final Refund Seller', 2600);
    const soId = placed.sellerOrders[0]!.id;
    const original = paymentsInfra.payments.refund.bind(paymentsInfra.payments);
    let calls = 0;
    const spy = vi.spyOn(paymentsInfra.payments, 'refund').mockImplementation(async (input) => {
      calls += 1;
      // The seller-portion refund goes through; the final fee refund is refused.
      if (calls === 2) throw new Error('provider unavailable');
      return original(input);
    });

    await cancelSo(adminToken, soId).expect(204);
    let order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['CANCELLED', 'PARTIALLY_REFUNDED']);
    const failed = await prisma.refund.findFirstOrThrow({ where: { orderId: placed.orderId, sellerOrderId: null } });
    expect(failed.status).toBe('FAILED');
    expect(
      (await prisma.orderStatusHistory.findMany({ where: { orderId: placed.orderId } })).some((h) => h.toStatus === 'REFUNDED'),
    ).toBe(false);

    // A later attempt (the provider is back) completes it — once.
    spy.mockRestore();
    await paymentService.refundSellerOrderIfPaid(soId, 'retry after provider outage');
    order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    expect(refunds.filter((r) => r.status === 'COMPLETED').reduce((s, r) => s + r.amountPaise, 0)).toBe(order.totalPaise);
    expect(refunds.filter((r) => r.sellerOrderId === null).map((r) => r.status).sort()).toEqual(['COMPLETED', 'FAILED']);
  });

  it('READY_FOR_PICKUP + the last portion cancelled: parent CANCELLED, then REFUNDED once fully refunded; repeats are no-ops', async () => {
    const { adminToken, placed } = await paidSingleSellerOrder('9400000067', 'Ready Cancel Seller', 2700);
    const soId = placed.sellerOrders[0]!.id;
    await advanceSellerOrderToReady(adminToken, soId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe('READY_FOR_PICKUP');

    await cancelSo(adminToken, soId).expect(204);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { payments: true } });
    expect([order.status, order.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    expect(refunds.reduce((s, r) => s + r.amountPaise, 0)).toBe(order.payments[0]!.amountPaise);
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: placed.orderId, fromStatus: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.slice(-2).map((h) => [h.fromStatus, h.toStatus, h.actorType])).toEqual([
      ['READY_FOR_PICKUP', 'CANCELLED', 'SYSTEM'],
      ['CANCELLED', 'REFUNDED', 'SYSTEM'],
    ]);

    // Idempotent: the same cancellation again changes nothing.
    await cancelSo(adminToken, soId).expect(204);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(refunds.length);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: placed.orderId } })).toBe(history.length + 1);
  });

  it('READY_FOR_PICKUP with two portions: cancelling one keeps the parent ready; cancelling the last cancels + refunds it', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const sellerAId = await seedSellerWithOwner('9400000068', 'Ready Pair Seller A');
    const productA = await seedProduct(platformSellerId, { pricePaise: 2400, stockQty: 10 });
    const productP = await seedProduct(platformSellerId, { pricePaise: 1900, stockQty: 10 });
    const listingA = await addListing(adminToken, sellerAId, productA.variantId, 2400);
    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(
      token,
      addressId,
      [
        { listingId: listingA, qty: 1 },
        { listingId: productP.storeVariantId, qty: 1 },
      ],
      PaymentMethod.ONLINE,
    );
    for (const s of placed.sellerOrders) await advanceSellerOrderToReady(adminToken, s.id);
    const so = (sellerId: string) => placed.sellerOrders.find((s) => s.sellerId === sellerId)!.id;

    await cancelSo(adminToken, so(sellerAId)).expect(204);
    const mid = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([mid.status, mid.paymentStatus]).toEqual(['READY_FOR_PICKUP', 'PARTIALLY_REFUNDED']);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId, sellerOrderId: null } })).toBe(0);

    await cancelSo(adminToken, so(platformSellerId)).expect(204);
    const done = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([done.status, done.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
  });

  it('a COD order at READY_FOR_PICKUP whose last portion is cancelled ends CANCELLED (nothing to refund)', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const sellerId = await seedSellerWithOwner('9400000069', 'Ready COD Seller');
    const product = await seedProduct(platformSellerId, { pricePaise: 2300, stockQty: 10 });
    const listingId = await addListing(adminToken, sellerId, product.variantId, 2300);
    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(token, addressId, [{ listingId, qty: 1 }], PaymentMethod.COD);
    await advanceSellerOrderToReady(adminToken, placed.sellerOrders[0]!.id);

    await cancelSo(adminToken, placed.sellerOrders[0]!.id).expect(204);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['CANCELLED', 'PENDING']);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(0);
  });

  it('an order already OUT_FOR_DELIVERY is unaffected: its seller portion cannot be cancelled', async () => {
    const { adminToken, placed } = await paidSingleSellerOrder('9400000070', 'Out For Delivery Seller', 2900);
    const soId = placed.sellerOrders[0]!.id;
    await advanceSellerOrderToReady(adminToken, soId);
    const agent = await api()
      .post('/api/v1/admin/delivery-agents')
      .set('Authorization', bearer(adminToken))
      .send({ name: `Rider ${randomUUID().slice(0, 6)}`, mobile: `98765${Math.floor(10000 + Math.random() * 89999)}` })
      .expect(201);
    await api()
      .post(`/api/v1/admin/orders/${placed.orderId}/assign`)
      .set('Authorization', bearer(adminToken))
      .send({ agentId: expectSuccess<{ id: string }>(agent.body).data.id })
      .expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api().patch(`/api/v1/admin/orders/${placed.orderId}/status`).set('Authorization', bearer(adminToken)).send({ toStatus }).expect(204);
    }

    const res = await cancelSo(adminToken, soId);
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['OUT_FOR_DELIVERY', 'PAID']);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(0);
  });

  it('refuses a full refund of a DELIVERED order before any money moves, so the seller is settled normally', async () => {
    const { adminToken, sellerId, placed } = await deliveredSeller('9400000063', 'Delivered Refund Seller', 2800, PaymentMethod.ONLINE);

    const res = await api()
      .post(`/api/v1/admin/orders/${placed.orderId}/refund`)
      .set('Authorization', bearer(adminToken))
      .send({ reason: 'customer complaint' });
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);

    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(0);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { payments: true } });
    expect([order.status, order.paymentStatus, order.payments.map((p) => p.status)]).toEqual(['DELIVERED', 'PAID', ['CAPTURED']]);
    expect((await sellerEarnings(adminToken, sellerId)).pendingSettlementPaise).toBe(2800);
  });
});

describe('rider release when an order is fully cancelled before pickup', () => {
  const cancelSo = (token: string, id: string) =>
    api()
      .patch(`/api/v1/admin/seller-orders/${id}/status`)
      .set('Authorization', bearer(token))
      .send({ toStatus: 'CANCELLED', reason: 'rider release test' });

  async function createRider(adminToken: string): Promise<string> {
    const agent = await api()
      .post('/api/v1/admin/delivery-agents')
      .set('Authorization', bearer(adminToken))
      .send({ name: `Rider ${randomUUID().slice(0, 6)}`, mobile: `98765${Math.floor(10000 + Math.random() * 89999)}` })
      .expect(201);
    return expectSuccess<{ id: string }>(agent.body).data.id;
  }

  const assign = (adminToken: string, orderId: string, agentId: string) =>
    api().post(`/api/v1/admin/orders/${orderId}/assign`).set('Authorization', bearer(adminToken)).send({ agentId }).expect(200);

  async function activeCount(adminToken: string, agentId: string): Promise<number> {
    const res = await api().get('/api/v1/admin/delivery-agents').set('Authorization', bearer(adminToken)).expect(200);
    return expectSuccess<{ id: string; activeOrderCount: number }[]>(res.body).data.find((a) => a.id === agentId)!.activeOrderCount;
  }

  const tasksOf = (orderId: string) => prisma.deliveryTask.findMany({ where: { orderId }, orderBy: { assignedAt: 'asc' } });

  it('PROCESSING order with an assigned rider, fully cancelled: task released (history kept), rider count drops; a repeat changes nothing', async () => {
    const { adminToken, sellerId, placed } = await paidSingleSellerOrder('9400000071', 'Rider Processing Seller', 2100);
    const rider = await createRider(adminToken);
    await assign(adminToken, placed.orderId, rider);

    // A second order on the same rider, to prove only the cancelled one is released.
    const product = await seedProduct((await prisma.seller.findFirstOrThrow({ where: { isPlatformOwned: true } })).id, { pricePaise: 2000, stockQty: 10 });
    const listingId = await addListing(adminToken, sellerId, product.variantId, 2000);
    const { token, addressId } = await customerAndAddress();
    const other = await placeMixedOrder(token, addressId, [{ listingId, qty: 1 }], PaymentMethod.ONLINE);
    await assign(adminToken, other.orderId, rider);
    expect(await activeCount(adminToken, rider)).toBe(2);

    const [assigned] = await tasksOf(placed.orderId);
    await cancelSo(adminToken, placed.sellerOrders[0]!.id).expect(204);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
    const [released] = await tasksOf(placed.orderId);
    expect(released!.status).toBe('CANCELLED');
    expect(released!.cancelledAt).not.toBeNull();
    // Assignment history survives the release.
    expect([released!.id, released!.agentId, released!.assignedByUserId, released!.assignedAt.getTime()]).toEqual([
      assigned!.id, assigned!.agentId, assigned!.assignedByUserId, assigned!.assignedAt.getTime(),
    ]);
    expect(await activeCount(adminToken, rider)).toBe(1);
    expect((await tasksOf(other.orderId))[0]!.status).toBe('ASSIGNED');

    // Repeating the cancellation: no second state change on the task.
    await cancelSo(adminToken, placed.sellerOrders[0]!.id).expect(204);
    const [again] = await tasksOf(placed.orderId);
    expect([again!.status, again!.cancelledAt?.getTime(), again!.updatedAt.getTime()]).toEqual([
      released!.status, released!.cancelledAt?.getTime(), released!.updatedAt.getTime(),
    ]);
    expect(await activeCount(adminToken, rider)).toBe(1);
  });

  it('READY_FOR_PICKUP order with an assigned rider, last portion cancelled: task released', async () => {
    const { adminToken, placed } = await paidSingleSellerOrder('9400000072', 'Rider Ready Seller', 2500);
    await advanceSellerOrderToReady(adminToken, placed.sellerOrders[0]!.id);
    const rider = await createRider(adminToken);
    await assign(adminToken, placed.orderId, rider);
    expect(await activeCount(adminToken, rider)).toBe(1);

    await cancelSo(adminToken, placed.sellerOrders[0]!.id).expect(204);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe('REFUNDED');
    expect((await tasksOf(placed.orderId)).map((t) => t.status)).toEqual(['CANCELLED']);
    expect(await activeCount(adminToken, rider)).toBe(0);
  });

  it('a partial cancellation (another portion still active) keeps the rider assigned', async () => {
    const adminToken = await loginAdmin();
    const platformSellerId = await seedStore();
    const sellerAId = await seedSellerWithOwner('9400000073', 'Rider Partial Seller A');
    const productA = await seedProduct(platformSellerId, { pricePaise: 2200, stockQty: 10 });
    const productP = await seedProduct(platformSellerId, { pricePaise: 1800, stockQty: 10 });
    const listingA = await addListing(adminToken, sellerAId, productA.variantId, 2200);
    const { token, addressId } = await customerAndAddress();
    const placed = await placeMixedOrder(
      token,
      addressId,
      [
        { listingId: listingA, qty: 1 },
        { listingId: productP.storeVariantId, qty: 1 },
      ],
      PaymentMethod.ONLINE,
    );
    const rider = await createRider(adminToken);
    await assign(adminToken, placed.orderId, rider);

    await cancelSo(adminToken, placed.sellerOrders.find((s) => s.sellerId === sellerAId)!.id).expect(204);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe('PARTIALLY_CANCELLED');
    expect((await tasksOf(placed.orderId)).map((t) => t.status)).toEqual(['ASSIGNED']);
    expect(await activeCount(adminToken, rider)).toBe(1);
  });

  it('PICKED_UP, OUT_FOR_DELIVERY and DELIVERED orders keep their rider task untouched', async () => {
    const { adminToken, placed } = await paidSingleSellerOrder('9400000074', 'Rider In Flight Seller', 2400);
    const soId = placed.sellerOrders[0]!.id;
    await advanceSellerOrderToReady(adminToken, soId);
    const rider = await createRider(adminToken);
    await assign(adminToken, placed.orderId, rider);
    const setStatus = (toStatus: string) =>
      api().patch(`/api/v1/admin/orders/${placed.orderId}/status`).set('Authorization', bearer(adminToken)).send({ toStatus }).expect(204);

    for (const parent of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await setStatus(parent);
      const [before] = await tasksOf(placed.orderId);
      const refused = await cancelSo(adminToken, soId);
      expect(refused.status).toBe(409);
      const [after] = await tasksOf(placed.orderId);
      expect([after!.status, after!.cancelledAt, after!.updatedAt.getTime()]).toEqual([before!.status, before!.cancelledAt, before!.updatedAt.getTime()]);
      expect(after!.status).toBe('ASSIGNED');
      expect(await activeCount(adminToken, rider)).toBe(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe(parent);
    }

    await setStatus('DELIVERED');
    const [delivered] = await tasksOf(placed.orderId);
    expect(delivered!.status).toBe('DELIVERED');
    expect((await cancelSo(adminToken, soId)).status).toBe(409);
    const [still] = await tasksOf(placed.orderId);
    expect([still!.status, still!.cancelledAt, still!.updatedAt.getTime()]).toEqual(['DELIVERED', null, delivered!.updatedAt.getTime()]);
  });

  it('with no rider assigned, full cancellation and refund work exactly as before', async () => {
    const { adminToken, placed } = await paidSingleSellerOrder('9400000075', 'Riderless Seller', 1900);
    await cancelSo(adminToken, placed.sellerOrders[0]!.id).expect(204);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
    expect(await tasksOf(placed.orderId)).toHaveLength(0);
  });
});
