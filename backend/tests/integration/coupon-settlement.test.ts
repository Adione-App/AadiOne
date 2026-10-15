/**
 * Aadione-funded coupons across sellers: allocation, commission, payouts,
 * refunds and reporting (approved policy 2026-10-15 — proportional
 * allocation; the coupon is Aadione's expense, never the seller's).
 *
 * The worked example used throughout: Seller A ₹600, Seller B ₹400, 10%
 * commission, an Aadione ₹50 coupon:
 *   coupon share           A ₹30   B ₹20     (sum ₹50)
 *   gross commission       A ₹60   B ₹40
 *   net contribution       A ₹30   B ₹20     (commission - coupon share)
 *   seller payable         A ₹540  B ₹360    (coupon NOT deducted)
 *   customer paid          A ₹570  B ₹380    (what cancelling refunds)
 *
 * Runs through the real HTTP API with the mock gateway (as
 * seller-settlement.test.ts does); the Cashfree-specific refund paths are in
 * payment-security.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigKey, ErrorCode, PaymentMethod, SellerOrderStatus, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { MockPaymentProvider } from '../../src/infra/payment';
import { SETTLEMENT_CLOSE_LAG_MS } from '../../src/modules/sellers/seller-settlement.service';
import {
  configureTestMerchantUpi,
  seedAddress,
  seedProduct,
  seedSellerListing,
  seedStore,
  sellerLifecycleFields,
} from '../helpers/fixtures';

const CUSTOMER = '9400000101';

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

let adminSeq = 0;
async function adminToken(role: UserRole = UserRole.ADMIN): Promise<{ token: string; userId: string }> {
  adminSeq += 1;
  const email = `fin${adminSeq}@adione.test`;
  const user = await prisma.user.create({
    data: {
      mobile: `00000001${String(adminSeq).padStart(2, '0')}`,
      email,
      fullName: `Finance ${role}`,
      passwordHash: await hashPassword('TestAdmin@123'),
      role,
    },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return { token: expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken, userId: user.id };
}

async function seedSeller(name: string, ownerMobile: string, commissionBp = 1000): Promise<string> {
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
      defaultCommissionBp: commissionBp,
      ...sellerLifecycleFields('APPROVED'),
    },
  });
  const owner = await prisma.user.create({ data: { mobile: ownerMobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: owner.id, role: 'OWNER', isActive: true } });
  return seller.id;
}

let platformStoreId: string;
async function listing(sellerId: string, pricePaise: number): Promise<string> {
  const product = await seedProduct(platformStoreId, { pricePaise, stockQty: 50 });
  return seedSellerListing(sellerId, product.variantId, { mrpPaise: pricePaise + 100, pricePaise, stockQty: 50 });
}

async function coupon(code: string, data: { type: 'FLAT' | 'PERCENT'; discountValue: number; maxDiscountPaise?: number; minOrderPaise?: number }) {
  await prisma.coupon.create({ data: { code, usageLimitPerUser: 100, ...data } });
}

interface Placed {
  orderId: string;
  token: string;
  userId: string;
  deliveryOtp: string | null;
  sellerOrderOf: (sellerId: string) => string;
}

async function placeOrder(
  lines: { listingId: string; qty?: number }[],
  method: PaymentMethod,
  couponCode?: string,
): Promise<Placed> {
  await otpService.clearOtpState(CUSTOMER);
  const customer = await loginAs(CUSTOMER);
  const addressId = await seedAddress(customer.userId);
  for (const line of lines) {
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(customer.accessToken))
      .send({ sellerListingId: line.listingId, qty: line.qty ?? 1 })
      .expect(200);
  }
  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(customer.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: method, ...(couponCode ? { couponCode } : {}) })
    .expect(201);
  const order = expectSuccess<{ order: { id: string; deliveryOtp: string | null; sellerOrders: { id: string; sellerId: string }[] } }>(
    res.body,
  ).data.order;

  if (method === PaymentMethod.ONLINE) {
    const intent = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.id })
      .expect(200);
    const providerOrderId = expectSuccess<{ providerOrderId: string }>(intent.body).data.providerOrderId;
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;
    await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(customer.accessToken))
      .send({ orderId: order.id, providerOrderId, providerPaymentId, signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId) })
      .expect(200);
  }
  return {
    orderId: order.id,
    token: customer.accessToken,
    userId: customer.userId,
    deliveryOtp: order.deliveryOtp,
    sellerOrderOf: (sellerId) => order.sellerOrders.find((so) => so.sellerId === sellerId)!.id,
  };
}

const setSellerOrder = (token: string, sellerOrderId: string, toStatus: SellerOrderStatus) =>
  api().patch(`/api/v1/admin/seller-orders/${sellerOrderId}/status`).set('Authorization', bearer(token)).send({ toStatus, reason: 'Out of stock today' });

async function deliver(token: string, placed: Placed): Promise<void> {
  const active = await prisma.sellerOrder.findMany({
    where: { orderId: placed.orderId, status: { notIn: [SellerOrderStatus.CANCELLED, SellerOrderStatus.REJECTED] } },
  });
  for (const so of active) {
    for (const s of [SellerOrderStatus.ACCEPTED, SellerOrderStatus.PREPARING, SellerOrderStatus.READY_FOR_PICKUP]) {
      await setSellerOrder(token, so.id, s).expect(204);
    }
  }
  const agent = await api()
    .post('/api/v1/admin/delivery-agents')
    .set('Authorization', bearer(token))
    .send({ name: `Rider ${randomUUID().slice(0, 6)}`, mobile: `98765${Math.floor(10000 + Math.random() * 89999)}` })
    .expect(201);
  await api()
    .post(`/api/v1/admin/orders/${placed.orderId}/assign`)
    .set('Authorization', bearer(token))
    .send({ agentId: expectSuccess<{ id: string }>(agent.body).data.id })
    .expect(200);
  for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
    await api().patch(`/api/v1/admin/orders/${placed.orderId}/status`).set('Authorization', bearer(token)).send({ toStatus }).expect(204);
  }
  await api()
    .patch(`/api/v1/admin/orders/${placed.orderId}/status`)
    .set('Authorization', bearer(token))
    .send({ toStatus: 'DELIVERED', ...(placed.deliveryOtp ? { deliveryOtp: placed.deliveryOtp } : {}) })
    .expect(204);
}

interface SellerFin {
  sellerOrderId: string;
  sellerId: string;
  status: string;
  subtotalPaise: number;
  couponSharePaise: number;
  customerPaidPaise: number;
  grossCommissionPaise: number;
  netCommissionContributionPaise: number;
  sellerPayablePaise: number;
  reversedCommissionPaise: number;
  reversedCouponExpensePaise: number;
  refundedPaise: number;
  refundPendingPaise: number;
  remainingRefundablePaise: number;
  settlement: { eligible: boolean; ineligibleReason: string | null; settlementStatus: string | null; payoutReference: string | null };
}
interface OrderFin {
  paymentStatus: string;
  itemsSubtotalPaise: number;
  couponDiscountPaise: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  totalPaise: number;
  currentPayablePaise: number;
  capturedPaise: number | null;
  refundedPaise: number;
  refundPendingPaise: number;
  sellers: SellerFin[];
  platform: { grossCommissionPaise: number; couponExpensePaise: number; netCommissionContributionPaise: number; sellerPayablePaise: number };
  reconciliation: { couponAllocationMatches: boolean; subtotalsMatch: boolean; refundsWithinCaptured: boolean };
}

async function financials(token: string, orderId: string): Promise<OrderFin> {
  const res = await api().get(`/api/v1/admin/orders/${orderId}/financials`).set('Authorization', bearer(token)).expect(200);
  return expectSuccess<OrderFin>(res.body).data;
}
const seller = (fin: OrderFin, sellerId: string) => fin.sellers.find((s) => s.sellerId === sellerId)!;

async function platformAccounting(token: string, sellerId: string) {
  const res = await api().get(`/api/v1/admin/sellers/${sellerId}/platform-accounting`).set('Authorization', bearer(token)).expect(200);
  return expectSuccess<{
    grossCommissionPaise: number;
    couponExpensePaise: number;
    netCommissionContributionPaise: number;
    sellerPayablePaise: number;
    reversedCommissionPaise: number;
    reversedCouponExpensePaise: number;
  }>(res.body).data;
}

/** The worked example: Seller A ₹600, Seller B ₹400, 10% commission. */
async function twoSellers() {
  const a = await seedSeller('Seller A', '9400000201');
  const b = await seedSeller('Seller B', '9400000202');
  return { a, b, aListing: await listing(a, 60000), bListing: await listing(b, 40000) };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
  platformStoreId = await seedStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* allocation, commission, payout                                             */
/* -------------------------------------------------------------------------- */

describe('the worked example — ₹50 Aadione coupon across Seller A ₹600 and Seller B ₹400', () => {
  it('allocates ₹30 / ₹20, keeps commission and payout on the pre-coupon amount, and reports net contribution', async () => {
    const { a, b, aListing, bListing } = await twoSellers();
    await coupon('SAVE50', { type: 'FLAT', discountValue: 5000 });
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.ONLINE, 'SAVE50');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.couponDiscountPaise).toBe(5000);
    const portions = await prisma.sellerOrder.findMany({ where: { orderId: order.id }, include: { items: true } });
    const portion = (sellerId: string) => portions.find((p) => p.sellerId === sellerId)!;
    expect(portion(a)).toMatchObject({ subtotalPaise: 60000, couponDiscountPaise: 3000, commissionPaise: 6000 });
    expect(portion(b)).toMatchObject({ subtotalPaise: 40000, couponDiscountPaise: 2000, commissionPaise: 4000 });
    for (const p of portions) expect(p.items.reduce((s, i) => s + i.couponDiscountPaise, 0)).toBe(p.couponDiscountPaise);

    const fin = await financials(token, order.id);
    expect(seller(fin, a)).toMatchObject({
      couponSharePaise: 3000,
      customerPaidPaise: 57000,
      grossCommissionPaise: 6000,
      netCommissionContributionPaise: 3000,
      sellerPayablePaise: 54000,
    });
    expect(seller(fin, b)).toMatchObject({
      couponSharePaise: 2000,
      customerPaidPaise: 38000,
      grossCommissionPaise: 4000,
      netCommissionContributionPaise: 2000,
      sellerPayablePaise: 36000,
    });
    expect(fin.platform).toEqual({
      grossCommissionPaise: 10000,
      couponExpensePaise: 5000,
      netCommissionContributionPaise: 5000,
      sellerPayablePaise: 90000,
    });
    expect(fin.reconciliation).toEqual({ couponAllocationMatches: true, subtotalsMatch: true, refundsWithinCaptured: true });
    // The customer paid items minus the coupon plus the fees — exactly what was captured.
    expect(fin.capturedPaise).toBe(100000 - 5000 + fin.deliveryFeePaise + fin.platformFeePaise);
    expect(fin.capturedPaise).toBe(fin.totalPaise);

    // The seller's own earnings view never sees the coupon: payable = subtotal - commission.
    const earnings = await api().get(`/api/v1/admin/sellers/${b}/earnings`).set('Authorization', bearer(token)).expect(200);
    expect(expectSuccess<{ netPayablePaise: number; commissionPaise: number }>(earnings.body).data).toMatchObject({
      netPayablePaise: 36000,
      commissionPaise: 4000,
    });
  });

  it('a percent coupon with a cap is allocated as applied (₹30 cap -> ₹18 / ₹12), not as the raw percentage', async () => {
    const { a, b, aListing, bListing } = await twoSellers();
    await coupon('HALF', { type: 'PERCENT', discountValue: 50, maxDiscountPaise: 3000 });
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.ONLINE, 'HALF');
    const fin = await financials(token, placed.orderId);
    expect(fin.couponDiscountPaise).toBe(3000);
    expect(seller(fin, a).couponSharePaise).toBe(1800);
    expect(seller(fin, b).couponSharePaise).toBe(1200);
    expect(seller(fin, a).sellerPayablePaise).toBe(54000);
  });

  it('an ineligible coupon (minimum order not met) places no order at all', async () => {
    const { aListing } = await twoSellers();
    await coupon('BIGSPEND', { type: 'FLAT', discountValue: 5000, minOrderPaise: 500000 });
    await otpService.clearOtpState(CUSTOMER);
    const customer = await loginAs(CUSTOMER);
    const addressId = await seedAddress(customer.userId);
    await api().post('/api/v1/cart/items').set('Authorization', bearer(customer.accessToken)).send({ sellerListingId: aListing, qty: 1 }).expect(200);
    const res = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.ONLINE, couponCode: 'BIGSPEND' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(ErrorCode.COUPON_MIN_ORDER_NOT_MET);
    expect(await prisma.order.count()).toBe(0);
  });

  it('no coupon: nothing is allocated, and a cancelled portion refunds its full subtotal (unchanged)', async () => {
    const { a, aListing, bListing } = await twoSellers();
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.ONLINE);
    expect(await prisma.sellerOrder.count({ where: { orderId: placed.orderId, couponDiscountPaise: { not: 0 } } })).toBe(0);
    await setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED).expect(204);
    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ sellerOrderId: placed.sellerOrderOf(a), amountPaise: 60000, status: 'COMPLETED' });
  });
});

describe('multiple products per seller — exact paise rounding', () => {
  it('line shares sum to each seller share, and seller shares to the coupon', async () => {
    const a = await seedSeller('Seller A', '9400000211');
    const b = await seedSeller('Seller B', '9400000212');
    const lines = [await listing(a, 10000), await listing(a, 10000), await listing(b, 10000)];
    await coupon('ONE', { type: 'FLAT', discountValue: 100 }); // ₹1 over three ₹100 lines: 34 + 33 + 33
    const { token } = await adminToken();
    const placed = await placeOrder(lines.map((listingId) => ({ listingId })), PaymentMethod.ONLINE, 'ONE');

    const items = await prisma.orderItem.findMany({ where: { sellerOrder: { orderId: placed.orderId } } });
    expect(items.map((i) => i.couponDiscountPaise).sort()).toEqual([33, 33, 34]);
    const portions = await prisma.sellerOrder.findMany({ where: { orderId: placed.orderId }, include: { items: true } });
    for (const p of portions) expect(p.couponDiscountPaise).toBe(p.items.reduce((s, i) => s + i.couponDiscountPaise, 0));
    expect(portions.reduce((s, p) => s + p.couponDiscountPaise, 0)).toBe(100);
    expect((await financials(token, placed.orderId)).reconciliation.couponAllocationMatches).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* cancellations and refunds                                                  */
/* -------------------------------------------------------------------------- */

describe('one seller cancelled, the other fulfilled', () => {
  it('refunds what the customer paid for the cancelled portion; the other seller keeps its payout and coupon share', async () => {
    const { a, b, aListing, bListing } = await twoSellers();
    await coupon('SAVE50', { type: 'FLAT', discountValue: 5000 });
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.ONLINE, 'SAVE50');
    const total = (await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).totalPaise;

    await setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED).expect(204);
    // A repeated cancel is a no-op: no second refund, no second reversal.
    await setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED).expect(204);

    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    expect(refunds).toHaveLength(1);
    // ₹570 = ₹600 - its ₹30 coupon share. Never the pre-coupon ₹600.
    expect(refunds[0]).toMatchObject({ sellerOrderId: placed.sellerOrderOf(a), amountPaise: 57000, status: 'COMPLETED' });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(order.currentPayablePaise).toBe(total - 57000);

    await deliver(token, placed);
    const fin = await financials(token, placed.orderId);
    expect(seller(fin, a)).toMatchObject({
      status: 'CANCELLED',
      sellerPayablePaise: 0,
      netCommissionContributionPaise: 0,
      reversedCommissionPaise: 6000,
      reversedCouponExpensePaise: 3000,
      refundedPaise: 57000,
      remainingRefundablePaise: 0,
      settlement: { eligible: false, ineligibleReason: 'CANCELLED' },
    });
    expect(seller(fin, b)).toMatchObject({
      couponSharePaise: 2000,
      sellerPayablePaise: 36000,
      grossCommissionPaise: 4000,
      netCommissionContributionPaise: 2000,
      refundedPaise: 0,
      settlement: { eligible: true, ineligibleReason: null },
    });
    expect(fin.platform).toEqual({ grossCommissionPaise: 4000, couponExpensePaise: 2000, netCommissionContributionPaise: 2000, sellerPayablePaise: 36000 });
    expect(fin.refundedPaise).toBe(57000);
    expect(fin.reconciliation.refundsWithinCaptured).toBe(true);

    // Reversed exactly once, however often the cancel was repeated.
    expect(await platformAccounting(token, a)).toMatchObject({
      grossCommissionPaise: 0,
      couponExpensePaise: 0,
      sellerPayablePaise: 0,
      reversedCommissionPaise: 6000,
      reversedCouponExpensePaise: 3000,
    });
    expect(await prisma.auditLog.count({ where: { action: 'payment.refund_seller_portion', entityId: placed.orderId } })).toBe(1);

    // Seller B's payout is untouched by A's cancellation: ₹360, coupon not deducted.
    const earnings = await api().get(`/api/v1/admin/sellers/${b}/earnings`).set('Authorization', bearer(token)).expect(200);
    expect(expectSuccess<{ pendingSettlementPaise: number; netPayablePaise: number }>(earnings.body).data).toMatchObject({
      pendingSettlementPaise: 36000,
      netPayablePaise: 36000,
    });
  });
});

describe('full cancellation after a coupon', () => {
  it('returns exactly what was captured — each portion net of its coupon share, then the fees — never the coupon as cash', async () => {
    const { a, b, aListing, bListing } = await twoSellers();
    await coupon('SAVE50', { type: 'FLAT', discountValue: 5000 });
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.ONLINE, 'SAVE50');
    const before = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    const fees = before.deliveryFeePaise + before.platformFeePaise;

    await api().post(`/api/v1/orders/${placed.orderId}/cancel`).set('Authorization', bearer(placed.token)).send({ reason: 'Changed my mind' }).expect(200);

    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    const bySellerOrder = (id: string | null) => refunds.filter((r) => r.sellerOrderId === id).reduce((s, r) => s + r.amountPaise, 0);
    expect(bySellerOrder(placed.sellerOrderOf(a))).toBe(57000);
    expect(bySellerOrder(placed.sellerOrderOf(b))).toBe(38000);
    expect(bySellerOrder(null)).toBe(fees);
    expect(refunds.reduce((s, r) => s + r.amountPaise, 0)).toBe(before.totalPaise);
    expect(refunds.every((r) => r.status === 'COMPLETED')).toBe(true);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([after.status, after.paymentStatus]).toEqual(['REFUNDED', 'REFUNDED']);
    // What is "still payable" is the fees, refunded too — never negative.
    expect(after.currentPayablePaise).toBe(fees);

    const fin = await financials(token, placed.orderId);
    expect(fin.platform).toEqual({ grossCommissionPaise: 0, couponExpensePaise: 0, netCommissionContributionPaise: 0, sellerPayablePaise: 0 });
    expect(fin.refundedPaise).toBe(fin.capturedPaise);
    for (const s of fin.sellers) expect(s.remainingRefundablePaise).toBe(0);
  });

  it('concurrent cancellations refund each portion once and never more than was captured', async () => {
    const { a, aListing, bListing } = await twoSellers();
    await coupon('SAVE50', { type: 'FLAT', discountValue: 5000 });
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.ONLINE, 'SAVE50');
    const total = (await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).totalPaise;

    await Promise.all([
      setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED),
      setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED),
      api().post(`/api/v1/orders/${placed.orderId}/cancel`).set('Authorization', bearer(placed.token)).send({ reason: 'Changed my mind' }),
    ]);

    const refunds = await prisma.refund.findMany({ where: { orderId: placed.orderId, status: { in: ['PENDING', 'PROCESSING', 'COMPLETED'] } } });
    const perPortion = new Map<string | null, number>();
    for (const r of refunds) perPortion.set(r.sellerOrderId, (perPortion.get(r.sellerOrderId) ?? 0) + 1);
    for (const count of perPortion.values()) expect(count).toBe(1);
    expect(refunds.reduce((s, r) => s + r.amountPaise, 0)).toBeLessThanOrEqual(total);
    const fin = await financials(token, placed.orderId);
    expect(fin.reconciliation.refundsWithinCaptured).toBe(true);
  });
});

describe('Cash on Delivery with a coupon', () => {
  it('moves no money; the amount to collect drops by the customer-paid portion; payouts are unchanged', async () => {
    const { a, b, aListing, bListing } = await twoSellers();
    await coupon('SAVE50', { type: 'FLAT', discountValue: 5000 });
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.COD, 'SAVE50');
    const total = (await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).totalPaise;

    await setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED).expect(204);
    expect(await prisma.refund.count()).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).currentPayablePaise).toBe(total - 57000);

    await deliver(token, placed);
    const fin = await financials(token, placed.orderId);
    expect(fin.capturedPaise).toBeNull();
    expect(fin.paymentStatus).toBe('PAID');
    expect(seller(fin, b)).toMatchObject({ sellerPayablePaise: 36000, couponSharePaise: 2000, settlement: { eligible: true } });
    expect(seller(fin, a)).toMatchObject({ sellerPayablePaise: 0, remainingRefundablePaise: 0 });
  });

  it('a coupon covering every item still pays the sellers in full — Aadione bears it — and a cancelled portion refunds nothing', async () => {
    const { a, b, aListing, bListing } = await twoSellers();
    await coupon('ALLFREE', { type: 'FLAT', discountValue: 500000 }); // capped at the ₹1000 items subtotal
    const { token } = await adminToken();
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.COD, 'ALLFREE');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.couponDiscountPaise).toBe(100000);

    await setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED).expect(204);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).currentPayablePaise).toBe(order.totalPaise);

    const fin = await financials(token, placed.orderId);
    expect(seller(fin, b)).toMatchObject({
      couponSharePaise: 40000,
      customerPaidPaise: 0,
      sellerPayablePaise: 36000,
      netCommissionContributionPaise: 4000 - 40000,
    });
    expect(fin.platform.couponExpensePaise).toBe(40000);
  });
});

/* -------------------------------------------------------------------------- */
/* settlement payout reference                                                */
/* -------------------------------------------------------------------------- */

describe('settlement payout', () => {
  it('settles the seller on the pre-coupon payable and records the payout reference with PAID', async () => {
    const { b, bListing } = await twoSellers();
    await coupon('SAVE50', { type: 'FLAT', discountValue: 5000 });
    const admin = await adminToken();
    const placed = await placeOrder([{ listingId: bListing }], PaymentMethod.ONLINE, 'SAVE50');
    await deliver(admin.token, placed);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SETTLEMENT_CLOSE_LAG_MS + 1_000);
    const created = await api().post(`/api/v1/admin/sellers/${b}/settlements`).set('Authorization', bearer(admin.token)).send({}).expect(201);
    const settlementId = expectSuccess<{ id: string }>(created.body).data.id;
    const settlement = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    // ₹400 subtotal - ₹40 commission; the ₹50 coupon (all on this portion) is Aadione's.
    expect(settlement).toMatchObject({ grossSalesPaise: 40000, commissionPaise: 4000, netPayablePaise: 36000 });

    const setStatus = (body: object) =>
      api().patch(`/api/v1/admin/settlements/${settlementId}/status`).set('Authorization', bearer(admin.token)).send(body);
    expect((await setStatus({ status: 'PROCESSING', reference: 'UTR000111222' })).status).toBe(400);
    await setStatus({ status: 'PROCESSING' }).expect(200);
    const paid = await setStatus({ status: 'PAID', reference: 'UTR000111222' }).expect(200);
    expect(expectSuccess<{ payoutReference: string }>(paid.body).data.payoutReference).toBe('UTR000111222');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'settlement.status', entityId: settlementId, after: { path: ['status'], equals: 'PAID' } } });
    expect(audit.actorUserId).toBe(admin.userId);
    expect(audit.after).toMatchObject({ payoutReference: 'UTR000111222', netPayablePaise: 36000 });

    const fin = await financials(admin.token, placed.orderId);
    expect(seller(fin, b).settlement).toMatchObject({ eligible: true, settlementStatus: 'PAID', payoutReference: 'UTR000111222' });
  });
});

/* -------------------------------------------------------------------------- */
/* authorization                                                              */
/* -------------------------------------------------------------------------- */

describe('financial reports are admin-only', () => {
  it('staff, sellers and customers cannot read order financials or platform accounting', async () => {
    const { a, aListing } = await twoSellers();
    const placed = await placeOrder([{ listingId: aListing }], PaymentMethod.COD);
    const staff = await adminToken(UserRole.STAFF);
    await otpService.clearOtpState('9400000201');
    const sellerSession = await loginAs('9400000201');

    for (const token of [staff.token, sellerSession.accessToken, placed.token]) {
      const fin = await api().get(`/api/v1/admin/orders/${placed.orderId}/financials`).set('Authorization', bearer(token));
      expect(fin.status).toBe(403);
      const acc = await api().get(`/api/v1/admin/sellers/${a}/platform-accounting`).set('Authorization', bearer(token));
      expect(acc.status).toBe(403);
    }
    expect((await api().get(`/api/v1/admin/orders/${placed.orderId}/financials`)).status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* migration backfill parity                                                  */
/* -------------------------------------------------------------------------- */

describe('migration backfill', () => {
  it('allocates existing coupon orders by the same rule, exactly, and leaves allocated orders alone', async () => {
    const { a, b, aListing, bListing } = await twoSellers();
    await coupon('SAVE50', { type: 'FLAT', discountValue: 5000 });
    const placed = await placeOrder([{ listingId: aListing }, { listingId: bListing }], PaymentMethod.COD, 'SAVE50');
    const allocated = await prisma.sellerOrder.findMany({ where: { orderId: placed.orderId }, select: { id: true, couponDiscountPaise: true } });

    // Simulate an order placed before the columns existed.
    await prisma.$executeRawUnsafe(
      `UPDATE order_items SET coupon_discount_paise = 0 WHERE seller_order_id IN (SELECT id FROM seller_orders WHERE order_id = $1::uuid)`,
      placed.orderId,
    );
    await prisma.$executeRawUnsafe(`UPDATE seller_orders SET coupon_discount_paise = 0 WHERE order_id = $1::uuid`, placed.orderId);

    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../prisma/migrations/20261015120000_v2_coupon_allocation_payout_reference/migration.sql'),
      'utf8',
    );
    const backfill = sql.slice(sql.indexOf('WITH lines AS'), sql.indexOf('-- A share can never'));
    const statements = backfill.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);
    // Idempotent: a second run changes nothing.
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);

    const backfilled = await prisma.sellerOrder.findMany({ where: { orderId: placed.orderId }, select: { id: true, sellerId: true, couponDiscountPaise: true } });
    expect(new Map(backfilled.map((so) => [so.id, so.couponDiscountPaise]))).toEqual(new Map(allocated.map((so) => [so.id, so.couponDiscountPaise])));
    expect(backfilled.find((so) => so.sellerId === a)!.couponDiscountPaise).toBe(3000);
    expect(backfilled.find((so) => so.sellerId === b)!.couponDiscountPaise).toBe(2000);
  });
});
