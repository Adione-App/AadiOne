/**
 * Refund management — Phase 7: a coupon use is given back on an eligible
 * cancellation (approved policy 2026-10-31).
 *
 *   - a whole order cancelled (or never paid): the redemption is released —
 *     kept as history, stamped, the coupon's count and the customer's
 *     per-user count no longer include it;
 *   - exactly once under repeats and concurrency;
 *   - the coupon is untouched: same expiry and limits, no new coupon;
 *   - a partial cancellation or a delivered order releases nothing.
 */

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

import { randomUUID } from 'node:crypto';
import { ActorType, ConfigKey, OrderStatus, PaymentMethod, SellerOrderStatus } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { runInTransaction } from '../../src/infra/db/prisma';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { releaseCouponRedemptions } from '../../src/modules/orders/coupon-release';
import { transitionOrder } from '../../src/modules/orders/order-state.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedStore } from '../helpers/fixtures';
import { PAID, cancelAsCustomer, deliver, panelToken, placeOrder, setSellerOrder, twoSellers } from '../helpers/refund-fixtures';

const CUSTOMER = '9400000711';
let storeId: string;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  cashfree.refundStartStatus = 'SUCCESS';
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
});

const validTo = new Date('2099-12-31T18:29:59.000Z');
async function singleUseCoupon(code = 'ONCE50') {
  return prisma.coupon.create({
    data: { code, type: 'FLAT', discountValue: 5000, usageLimitPerUser: 1, usageLimitTotal: 1, validTo },
  });
}
const couponNow = (id: string) => prisma.coupon.findUniqueOrThrow({ where: { id } });

describe('coupon release', () => {
  it('a fully cancelled order gives its use back — once, history kept, coupon unchanged — and it can be used again', async () => {
    const coupon = await singleUseCoupon();
    const { aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID, coupon.code);
    expect((await couponNow(coupon.id)).usedCount).toBe(1);

    await cancelAsCustomer(placed).expect(200);

    const redemption = await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: placed.orderId } });
    expect(redemption.releasedAt).not.toBeNull();
    expect(redemption.releaseReason).toBe('ORDER_CANCELLED');
    expect(redemption.discountPaise).toBe(5000); // history kept as it was
    const after = await couponNow(coupon.id);
    expect(after).toMatchObject({ usedCount: 0, usageLimitTotal: 1, usageLimitPerUser: 1, isActive: true });
    expect(after.validTo?.toISOString()).toBe(validTo.toISOString());
    expect(await prisma.coupon.count()).toBe(1); // no new coupon
    expect(await prisma.auditLog.count({ where: { action: 'coupon.redemption_release', entityId: placed.orderId } })).toBe(1);

    // Replays (and a concurrent pair) release nothing more.
    await Promise.all([
      runInTransaction((tx) => releaseCouponRedemptions(tx, placed.orderId, 'ORDER_CANCELLED')),
      runInTransaction((tx) => releaseCouponRedemptions(tx, placed.orderId, 'ORDER_CANCELLED')),
    ]);
    expect((await couponNow(coupon.id)).usedCount).toBe(0);

    // The single-use coupon works again for the same customer.
    const again = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID, coupon.code);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: again.orderId } })).couponDiscountPaise).toBe(5000);
    expect((await couponNow(coupon.id)).usedCount).toBe(1);
  });

  it('a partial cancellation releases nothing — the coupon still discounts what is delivered', async () => {
    const coupon = await singleUseCoupon();
    const { a, aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID, coupon.code);
    const { token } = await panelToken();
    await setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED).expect(204);
    expect((await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: placed.orderId } })).releasedAt).toBeNull();
    expect((await couponNow(coupon.id)).usedCount).toBe(1);

    // Delivered: still used.
    await deliver(token, placed);
    expect((await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: placed.orderId } })).releasedAt).toBeNull();
    expect((await couponNow(coupon.id)).usedCount).toBe(1);
  });

  it('an unpaid order cancelled, or whose payment failed, gives the use back', async () => {
    const coupon = await prisma.coupon.create({ data: { code: 'TWICE', type: 'FLAT', discountValue: 2000, usageLimitPerUser: 2, validTo } });
    const { aListing } = await twoSellers(storeId);
    await otpService.clearOtpState(CUSTOMER);
    const customer = await loginAs(CUSTOMER);
    const addressId = await seedAddress(customer.userId);

    async function unpaidOrder(): Promise<string> {
      await api().post('/api/v1/cart/items').set('Authorization', bearer(customer.accessToken)).send({ sellerListingId: aListing, qty: 1 }).expect(200);
      const res = await api()
        .post('/api/v1/orders')
        .set('Authorization', bearer(customer.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ addressId, paymentMethod: PaymentMethod.ONLINE, couponCode: coupon.code })
        .expect(201);
      return expectSuccess<{ order: { id: string } }>(res.body).data.order.id;
    }

    const cancelled = await unpaidOrder();
    await api().post(`/api/v1/orders/${cancelled}/cancel`).set('Authorization', bearer(customer.accessToken)).send({ reason: 'Changed my mind' }).expect(200);
    expect(await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: cancelled } })).toMatchObject({ releaseReason: 'ORDER_CANCELLED' });

    const failed = await unpaidOrder();
    await transitionOrder({ orderId: failed, toStatus: OrderStatus.PAYMENT_FAILED, actorType: ActorType.SYSTEM });
    expect(await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: failed } })).toMatchObject({ releaseReason: 'PAYMENT_FAILED' });
    expect((await couponNow(coupon.id)).usedCount).toBe(0);
  });

  it('never extends an expired coupon: a released use of an expired coupon cannot be used again', async () => {
    const coupon = await singleUseCoupon('SOONGONE');
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID, coupon.code);
    await prisma.coupon.update({ where: { id: coupon.id }, data: { validTo: new Date(Date.now() - 60_000) } });
    await cancelAsCustomer(placed).expect(200);
    const after = await couponNow(coupon.id);
    expect(after.usedCount).toBe(0);
    expect(after.validTo!.getTime()).toBeLessThan(Date.now());
    await expect(placeOrder(CUSTOMER, [{ listingId: aListing }], PAID, coupon.code)).rejects.toThrow(/COUPON_EXPIRED/);
  });
});
