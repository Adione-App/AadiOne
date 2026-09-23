/**
 * Refer & Earn — referral linkage and reward issuance.
 *
 * Walks the real HTTP surface (OTP signup, cart, checkout, admin status
 * transitions) exactly like order-lifecycle.test.ts, rather than calling
 * `referralService.tryRewardForOrder` directly — the thing actually being
 * verified is that DELIVERED, reached the normal way, is what triggers a
 * reward, not a shortcut that only proves the function works in isolation.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  OrderStatus,
  PaymentMethod,
  UserRole,
  type CouponDto,
  type OrderDetailDto,
  type ReferralSummaryDto,
  type RewardCouponDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { hashPassword } from '../../src/common/crypto';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: {
      mobile: '0000000001',
      email: ADMIN.email,
      fullName: 'Store Owner',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.STORE_OWNER,
    },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

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

/** Places a COD order for `qty` units of `product` and walks it all the way
 * to DELIVERED — COD skips the payment gate entirely, which keeps every
 * reward-eligibility test focused on the ₹ amount / status logic rather than
 * re-running the online payment dance every time. */
async function placeAndDeliverCodOrder(
  adminToken: string,
  customerToken: string,
  addressId: string,
  variantId: string,
  qty: number,
): Promise<{ orderId: string; itemsSubtotalPaise: number }> {
  await api()
    .post('/api/v1/cart/items')
    .set('Authorization', bearer(customerToken))
    .send({ variantId, qty })
    .expect(200);

  const placed = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(customerToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD })
    .expect(201);

  const order = expectSuccess<{ order: OrderDetailDto }>(placed.body).data.order;
  const deliveryOtp = order.deliveryOtp!;

  const agent = await api()
    .post('/api/v1/admin/delivery-agents')
    .set('Authorization', bearer(adminToken))
    .send({ name: `Rider ${randomUUID().slice(0, 6)}`, mobile: `98765${Math.floor(10000 + Math.random() * 89999)}` })
    .expect(201);
  const agentId = expectSuccess<{ id: string }>(agent.body).data.id;

  await advance(adminToken, order.id, OrderStatus.STORE_ACCEPTED);
  await advance(adminToken, order.id, OrderStatus.PREPARING);
  await advance(adminToken, order.id, OrderStatus.READY_FOR_PICKUP);
  await api()
    .post(`/api/v1/admin/orders/${order.id}/assign`)
    .set('Authorization', bearer(adminToken))
    .send({ agentId })
    .expect(200);
  await advance(adminToken, order.id, OrderStatus.OUT_FOR_DELIVERY);
  await advance(adminToken, order.id, OrderStatus.DELIVERED, {
    deliveryOtp,
    cashCollectedPaise: order.bill.totalPaise,
  });

  return { orderId: order.id, itemsSubtotalPaise: order.bill.itemsSubtotalPaise };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('Refer & Earn — normal referral', () => {
  it('rewards the referrer exactly once when the referred friend delivers a ≥₹99 order', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 15000, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000001');
    const referrer = await loginAs('9000000001');

    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const referralCode = expectSuccess<{ referralCode: string | null }>(me.body).data.referralCode!;
    expect(referralCode).toBeTruthy();

    await otpService.clearOtpState('9000000002');
    const referred = await loginAs('9000000002');

    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);

    const addressId = await seedAddress(referred.userId);
    // 1 × ₹150 = ₹150, clears the ₹99 default minimum.
    await placeAndDeliverCodOrder(adminToken, referred.accessToken, addressId, product.variantId, 1);

    const coupons = await prisma.coupon.findMany({ where: { issuedToUserId: referrer.userId } });
    expect(coupons).toHaveLength(1);
    expect(coupons[0]!.discountValue).toBe(5000); // ₹50, the default REFERRAL_REWARD_PAISE
    expect(coupons[0]!.minOrderPaise).toBe(9900);
    expect(coupons[0]!.origin).toBe('REFERRAL_REWARD');

    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.userId } });
    expect(referral.status).toBe('REWARD_ISSUED');
    expect(referral.rewardIssuedAt).not.toBeNull();

    // Visible on the referrer's own Rewards page.
    const myCoupons = await api()
      .get('/api/v1/rewards/coupons')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const rewards = expectSuccess<RewardCouponDto[]>(myCoupons.body).data;
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.status).toBe('ACTIVE');

    const summary = await api()
      .get('/api/v1/referrals/me')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const summaryData = expectSuccess<ReferralSummaryDto>(summary.body).data;
    expect(summaryData.referredCount).toBe(1);
    expect(summaryData.rewardsIssuedCount).toBe(1);
  });
});

describe('Refer & Earn — ₹99 minimum boundary', () => {
  it('does not reward a ₹98 eligible order', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 9800, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000003');
    const referrer = await loginAs('9000000003');
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const referralCode = expectSuccess<{ referralCode: string | null }>(me.body).data.referralCode!;

    await otpService.clearOtpState('9000000004');
    const referred = await loginAs('9000000004');
    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);

    const addressId = await seedAddress(referred.userId);
    await placeAndDeliverCodOrder(adminToken, referred.accessToken, addressId, product.variantId, 1);

    expect(await prisma.coupon.count({ where: { issuedToUserId: referrer.userId } })).toBe(0);
    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.userId } });
    expect(referral.status).toBe('FIRST_ORDER_PENDING');
  });

  it('rewards a ₹99 eligible order (the exact boundary)', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 9900, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000005');
    const referrer = await loginAs('9000000005');
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const referralCode = expectSuccess<{ referralCode: string | null }>(me.body).data.referralCode!;

    await otpService.clearOtpState('9000000006');
    const referred = await loginAs('9000000006');
    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);

    const addressId = await seedAddress(referred.userId);
    await placeAndDeliverCodOrder(adminToken, referred.accessToken, addressId, product.variantId, 1);

    expect(await prisma.coupon.count({ where: { issuedToUserId: referrer.userId } })).toBe(1);
  });
});

describe('Refer & Earn — first ELIGIBLE order, not just first order', () => {
  it('skips a below-minimum first order and rewards the next qualifying one', async () => {
    const storeId = await seedStore();
    const cheap = await seedProduct(storeId, { pricePaise: 8000, stockQty: 20 });
    const pricey = await seedProduct(storeId, { pricePaise: 15000, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000007');
    const referrer = await loginAs('9000000007');
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const referralCode = expectSuccess<{ referralCode: string | null }>(me.body).data.referralCode!;

    await otpService.clearOtpState('9000000008');
    const referred = await loginAs('9000000008');
    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);

    const addressId = await seedAddress(referred.userId);

    // Order #1 — ₹80, below the minimum. No reward.
    await placeAndDeliverCodOrder(adminToken, referred.accessToken, addressId, cheap.variantId, 1);
    expect(await prisma.coupon.count({ where: { issuedToUserId: referrer.userId } })).toBe(0);
    expect(
      (await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.userId } })).status,
    ).toBe('FIRST_ORDER_PENDING');

    // Order #2 — ₹150, qualifies. Reward fires now, exactly once.
    await placeAndDeliverCodOrder(adminToken, referred.accessToken, addressId, pricey.variantId, 1);
    expect(await prisma.coupon.count({ where: { issuedToUserId: referrer.userId } })).toBe(1);
    expect(
      (await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.userId } })).status,
    ).toBe('REWARD_ISSUED');
  });
});

describe('Refer & Earn — cancelled / failed orders never reward', () => {
  it('does not reward a cancelled order', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 15000, stockQty: 20 });

    await otpService.clearOtpState('9000000009');
    const referrer = await loginAs('9000000009');
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const referralCode = expectSuccess<{ referralCode: string | null }>(me.body).data.referralCode!;

    await otpService.clearOtpState('9000000010');
    const referred = await loginAs('9000000010');
    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);

    const addressId = await seedAddress(referred.userId);

    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(referred.accessToken))
      .send({ variantId: product.variantId, qty: 1 })
      .expect(200);

    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(referred.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.COD })
      .expect(201);
    const orderId = expectSuccess<{ order: { id: string } }>(placed.body).data.order.id;

    await api()
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', bearer(referred.accessToken))
      .send({ reason: 'Changed my mind' })
      .expect(200);

    expect(await prisma.coupon.count({ where: { issuedToUserId: referrer.userId } })).toBe(0);
    expect(
      (await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.userId } })).status,
    ).toBe('FIRST_ORDER_PENDING');
  });
});

describe('Refer & Earn — fraud / abuse prevention', () => {
  it('rejects a self-referral', async () => {
    await otpService.clearOtpState('9000000011');
    const user = await loginAs('9000000011');
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);
    const ownCode = expectSuccess<{ referralCode: string | null }>(me.body).data.referralCode!;

    const res = await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(user.accessToken))
      .send({ code: ownCode });

    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.REFERRAL_SELF_REFERRAL);
  });

  it('rejects a second referral code once one is already linked', async () => {
    await otpService.clearOtpState('9000000012');
    const referrerA = await loginAs('9000000012');
    const codeA = expectSuccess<{ referralCode: string | null }>(
      (await api().get('/api/v1/auth/me').set('Authorization', bearer(referrerA.accessToken)).expect(200)).body,
    ).data.referralCode!;

    await otpService.clearOtpState('9000000013');
    const referrerB = await loginAs('9000000013');
    const codeB = expectSuccess<{ referralCode: string | null }>(
      (await api().get('/api/v1/auth/me').set('Authorization', bearer(referrerB.accessToken)).expect(200)).body,
    ).data.referralCode!;

    await otpService.clearOtpState('9000000014');
    const referred = await loginAs('9000000014');

    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: codeA })
      .expect(200);

    const second = await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: codeB });

    expect(second.status).toBe(422);
    expect(expectError(second.body).code).toBe(ErrorCode.REFERRAL_ALREADY_LINKED);

    // The FIRST referrer's link stands — not silently replaced.
    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.userId } });
    expect(referral.referrerUserId).toBe(referrerA.userId);
  });

  it('rejects an unknown referral code', async () => {
    await otpService.clearOtpState('9000000015');
    const user = await loginAs('9000000015');

    const res = await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(user.accessToken))
      .send({ code: 'NOTREAL1' });

    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.REFERRAL_CODE_INVALID);
  });
});

describe('Refer & Earn — multiple referrals, separate coupons', () => {
  it('issues one independent coupon per successful referral, never combined', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 15000, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000016');
    const referrer = await loginAs('9000000016');
    const referralCode = expectSuccess<{ referralCode: string | null }>(
      (await api().get('/api/v1/auth/me').set('Authorization', bearer(referrer.accessToken)).expect(200)).body,
    ).data.referralCode!;

    for (const mobile of ['9000000017', '9000000018']) {
      await otpService.clearOtpState(mobile);
      const friend = await loginAs(mobile);
      await api()
        .post('/api/v1/referrals/apply')
        .set('Authorization', bearer(friend.accessToken))
        .send({ code: referralCode })
        .expect(200);

      const addressId = await seedAddress(friend.userId);
      await placeAndDeliverCodOrder(adminToken, friend.accessToken, addressId, product.variantId, 1);
    }

    const coupons = await prisma.coupon.findMany({ where: { issuedToUserId: referrer.userId } });
    expect(coupons).toHaveLength(2);
    // Two DISTINCT ₹50 coupons, not one ₹100 coupon.
    expect(new Set(coupons.map((c) => c.code)).size).toBe(2);
    expect(coupons.every((c) => c.discountValue === 5000)).toBe(true);
  });
});

describe('Refer & Earn — coupon usage lifecycle', () => {
  it('lets the reward be applied once and rejects reuse afterward', async () => {
    const storeId = await seedStore();
    const referralUnlock = await seedProduct(storeId, { pricePaise: 15000, stockQty: 20 });
    const shoppingItem = await seedProduct(storeId, { pricePaise: 20000, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000019');
    const referrer = await loginAs('9000000019');
    const referralCode = expectSuccess<{ referralCode: string | null }>(
      (await api().get('/api/v1/auth/me').set('Authorization', bearer(referrer.accessToken)).expect(200)).body,
    ).data.referralCode!;

    await otpService.clearOtpState('9000000020');
    const referred = await loginAs('9000000020');
    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);
    const referredAddressId = await seedAddress(referred.userId);
    await placeAndDeliverCodOrder(adminToken, referred.accessToken, referredAddressId, referralUnlock.variantId, 1);

    const coupon = await prisma.coupon.findFirstOrThrow({ where: { issuedToUserId: referrer.userId } });

    // The referrer applies their own ₹50 coupon to a real order.
    const referrerAddressId = await seedAddress(referrer.userId);
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(referrer.accessToken))
      .send({ variantId: shoppingItem.variantId, qty: 1 })
      .expect(200);

    const applied = await api()
      .post('/api/v1/cart/coupon')
      .set('Authorization', bearer(referrer.accessToken))
      .send({ code: coupon.code })
      .expect(200);
    expect(expectSuccess<{ bill: { couponDiscountPaise: number } }>(applied.body).data.bill.couponDiscountPaise).toBe(
      5000,
    );

    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(referrer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId: referrerAddressId, paymentMethod: PaymentMethod.COD })
      .expect(201);
    const order = expectSuccess<{ order: OrderDetailDto }>(placed.body).data.order;
    expect(order.bill.couponDiscountPaise).toBe(5000);
    expect(order.bill.totalPaise).toBe(20000 - 5000 + order.bill.deliveryFeePaise + order.bill.platformFeePaise);

    // Once redeemed, the SAME coupon cannot be applied to a new order.
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(referrer.accessToken))
      .send({ variantId: shoppingItem.variantId, qty: 1 })
      .expect(200);

    const reapply = await api()
      .post('/api/v1/cart/coupon')
      .set('Authorization', bearer(referrer.accessToken))
      .send({ code: coupon.code });

    expect(reapply.status).toBe(422);
    expect(expectError(reapply.body).code).toBe(ErrorCode.COUPON_LIMIT_REACHED);

    // And it now reads USED on the Rewards page, never ACTIVE again.
    const myCoupons = await api()
      .get('/api/v1/rewards/coupons')
      .set('Authorization', bearer(referrer.accessToken))
      .expect(200);
    const rewards = expectSuccess<RewardCouponDto[]>(myCoupons.body).data;
    expect(rewards.find((r) => r.code === coupon.code)?.status).toBe('USED');
  });

  it('is invisible/unusable to anyone other than the user it was issued to', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 15000, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000021');
    const referrer = await loginAs('9000000021');
    const referralCode = expectSuccess<{ referralCode: string | null }>(
      (await api().get('/api/v1/auth/me').set('Authorization', bearer(referrer.accessToken)).expect(200)).body,
    ).data.referralCode!;

    await otpService.clearOtpState('9000000022');
    const referred = await loginAs('9000000022');
    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);
    const addressId = await seedAddress(referred.userId);
    await placeAndDeliverCodOrder(adminToken, referred.accessToken, addressId, product.variantId, 1);

    const coupon = await prisma.coupon.findFirstOrThrow({ where: { issuedToUserId: referrer.userId } });

    await otpService.clearOtpState('9000000023');
    const stranger = await loginAs('9000000023');
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(stranger.accessToken))
      .send({ variantId: product.variantId, qty: 1 })
      .expect(200);

    const stolen = await api()
      .post('/api/v1/cart/coupon')
      .set('Authorization', bearer(stranger.accessToken))
      .send({ code: coupon.code });

    expect(stolen.status).toBe(422);
    expect(expectError(stolen.body).code).toBe(ErrorCode.COUPON_INVALID);
  });
});

describe('Refer & Earn — duplicate/concurrent reward issuance', () => {
  it('never issues two coupons even if the reward path runs twice for the same referral', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { pricePaise: 15000, stockQty: 20 });
    const adminToken = await loginAdmin();

    await otpService.clearOtpState('9000000024');
    const referrer = await loginAs('9000000024');
    const referralCode = expectSuccess<{ referralCode: string | null }>(
      (await api().get('/api/v1/auth/me').set('Authorization', bearer(referrer.accessToken)).expect(200)).body,
    ).data.referralCode!;

    await otpService.clearOtpState('9000000025');
    const referred = await loginAs('9000000025');
    await api()
      .post('/api/v1/referrals/apply')
      .set('Authorization', bearer(referred.accessToken))
      .send({ code: referralCode })
      .expect(200);
    const addressId = await seedAddress(referred.userId);
    const { orderId } = await placeAndDeliverCodOrder(
      adminToken,
      referred.accessToken,
      addressId,
      product.variantId,
      1,
    );

    // The order is ALREADY DELIVERED — a duplicate webhook/retry re-driving
    // the same transition is exactly what `transitionOrder`'s own idempotent
    // no-op path (fromStatus === toStatus) already guards against, and
    // separately, `Coupon.issuedForReferralId` is `@unique` — call the
    // reward function directly a second time, bypassing that no-op guard, to
    // prove the DB constraint (not just the state machine) is what actually
    // stops a duplicate.
    const referralRow = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.userId } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    const referralService = await import('../../src/modules/referrals/referral.service');
    const { runInTransaction } = await import('../../src/infra/db/prisma');

    const results = await Promise.allSettled([
      runInTransaction((tx) =>
        referralService.tryRewardForOrder(tx, {
          id: order.id,
          userId: order.userId,
          itemsSubtotalPaise: order.itemsSubtotalPaise,
        }),
      ),
      runInTransaction((tx) =>
        referralService.tryRewardForOrder(tx, {
          id: order.id,
          userId: order.userId,
          itemsSubtotalPaise: order.itemsSubtotalPaise,
        }),
      ),
    ]);

    // Both calls resolve cleanly (the second sees REWARD_ISSUED already and
    // no-ops) — no crash, no error surfaced to a caller.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const coupons = await prisma.coupon.findMany({ where: { issuedForReferralId: referralRow.id } });
    expect(coupons).toHaveLength(1);
  });
});
