/**
 * Refer & Earn coupon at checkout — exactly the path the customer app takes
 * (mobile CartScreen): apply the coupon to the cart (POST /cart/coupon), show
 * the bill from POST /checkout/quote (sent with the destination only — the
 * app never sends a coupon code there), then place the order with that
 * quote's total as `expectedTotalPaise`.
 *
 *   A. a real referral: the referred friend's ₹99+ order is delivered, the
 *      referrer's ₹50 coupon appears in Rewards, applies at checkout and is
 *      charged — once;
 *   B. what must be refused: expired, already used, someone else's, an order
 *      below the coupon's minimum (without breaking the cart), applying twice;
 *   C. payment failure, cancellation and retry never consume the coupon;
 *   D. ordinary promo codes behave the same; an explicit quote code still works.
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

import {
  ConfigKey,
  ErrorCode,
  OrderStatus,
  PaymentMethod,
  SellerOrderStatus,
  UserRole,
  type BillDto,
  type CartDto,
  type OrderDetailDto,
  type RewardCouponDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { hashPassword } from '../../src/common/crypto';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { releaseExpiredReservations } from '../../src/jobs';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };
let mobiles = 0;
const nextMobile = () => `93000${String(10000 + (mobiles += 1)).slice(-5)}`;

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Owner', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

/** A signed-in customer with a saved address, and the calls the app makes. */
async function customer() {
  const mobile = nextMobile();
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  const addressId = await seedAddress(session.userId);
  const auth = { Authorization: bearer(session.accessToken) };
  return {
    ...session,
    addressId,
    auth,
    add: async (sellerListingId: string, qty: number) =>
      expectSuccess<CartDto>((await api().post('/api/v1/cart/items').set(auth).send({ sellerListingId, qty }).expect(200)).body).data,
    cart: () => api().get('/api/v1/cart').set(auth),
    applyCoupon: (code: string) => api().post('/api/v1/cart/coupon').set(auth).send({ code }),
    removeCoupon: () => api().delete('/api/v1/cart/coupon').set(auth),
    /** As the app: the destination only. */
    quote: async (body: Record<string, unknown> = {}) =>
      expectSuccess<{ bill: BillDto }>((await api().post('/api/v1/checkout/quote').set(auth).send({ addressId, ...body }).expect(200)).body).data.bill,
    /** As the app: the quote's total is what the customer agreed to pay. */
    place: (method: PaymentMethod, expectedTotalPaise: number, key: string = randomUUID()) =>
      api()
        .post('/api/v1/orders')
        .set(auth)
        .set('Idempotency-Key', key)
        .send({ addressId, paymentMethod: method, expectedTotalPaise, ...(method === PaymentMethod.ONLINE ? { openPayment: true } : {}) }),
    rewards: async () => expectSuccess<RewardCouponDto[]>((await api().get('/api/v1/rewards/coupons').set(auth).expect(200)).body).data,
    refresh: (orderId: string) => api().post(`/api/v1/payments/${orderId}/refresh`).set(auth).expect(200),
    cancel: (orderId: string) => api().post(`/api/v1/orders/${orderId}/cancel`).set(auth).send({ reason: 'Changed my mind' }),
  };
}
type Customer = Awaited<ReturnType<typeof customer>>;

async function deliverCodOrder(adminToken: string, order: OrderDetailDto): Promise<void> {
  const admin = { Authorization: bearer(adminToken) };
  for (const toStatus of [SellerOrderStatus.ACCEPTED, SellerOrderStatus.PREPARING, SellerOrderStatus.READY_FOR_PICKUP]) {
    for (const so of await prisma.sellerOrder.findMany({ where: { orderId: order.id } })) {
      await api().patch(`/api/v1/admin/seller-orders/${so.id}/status`).set(admin).send({ toStatus }).expect(204);
    }
  }
  const agent = await api()
    .post('/api/v1/admin/delivery-agents')
    .set(admin)
    .send({ name: `Rider ${randomUUID().slice(0, 6)}`, mobile: `98765${Math.floor(10000 + Math.random() * 89999)}` })
    .expect(201);
  await api().post(`/api/v1/admin/orders/${order.id}/assign`).set(admin).send({ agentId: expectSuccess<{ id: string }>(agent.body).data.id }).expect(200);
  await api().patch(`/api/v1/admin/orders/${order.id}/status`).set(admin).send({ toStatus: OrderStatus.PICKED_UP }).expect(204);
  await api().patch(`/api/v1/admin/orders/${order.id}/status`).set(admin).send({ toStatus: OrderStatus.OUT_FOR_DELIVERY }).expect(204);
  await api()
    .patch(`/api/v1/admin/orders/${order.id}/status`)
    .set(admin)
    .send({ toStatus: OrderStatus.DELIVERED, deliveryOtp: order.deliveryOtp, cashCollectedPaise: order.bill.totalPaise })
    .expect(204);
}

/** A 201 response's body, failing with the server's answer otherwise. */
function created(res: { status: number; body: unknown }): unknown {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** The app's checkout: quote, then place with the quote's total. */
async function checkout(c: Customer, method: PaymentMethod) {
  const bill = await c.quote();
  const res = await c.place(method, bill.totalPaise);
  return { bill, res };
}

/**
 * The real referral flow: `referrer` shares their code, a new customer signs
 * up with it and gets a qualifying first order delivered. Returns the coupon.
 */
async function earnReferralCoupon(adminToken: string, referrer: Customer, listingId: string): Promise<RewardCouponDto> {
  const code = expectSuccess<{ referralCode: string | null }>((await api().get('/api/v1/auth/me').set(referrer.auth).expect(200)).body).data.referralCode!;
  const friend = await customer();
  await api().post('/api/v1/referrals/apply').set(friend.auth).send({ code }).expect(200);
  await friend.add(listingId, 1);
  const { res } = await checkout(friend, PaymentMethod.COD);
  const order = expectSuccess<{ order: OrderDetailDto }>(created(res)).data.order;
  await deliverCodOrder(adminToken, order);
  const rewards = await referrer.rewards();
  expect(rewards).toHaveLength(1);
  return rewards[0]!;
}

let storeId: string;
let item150: string; // ₹150
let item60: string; // ₹60
let adminToken: string;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
  item150 = (await seedProduct(storeId, { name: 'Basmati 1 kg', pricePaise: 15000, stockQty: 100 })).storeVariantId;
  item60 = (await seedProduct(storeId, { name: 'Salt 1 kg', pricePaise: 6000, stockQty: 100 })).storeVariantId;
  adminToken = await loginAdmin();
});

/* -------------------------------------------------------------------------- */

describe('A. a real referral coupon, end to end, the way the app checks out', () => {
  it('is issued once to the right customer, shows in checkout, discounts the quote and the order, and is redeemed once', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);

    // Issued exactly as the programme says: ₹50, minimum ₹99, 7 days, one use, to the referrer.
    expect(coupon).toMatchObject({ status: 'ACTIVE', discountValue: 5000, minOrderPaise: 9900, origin: 'REFERRAL_REWARD' });
    const days = (Date.parse(coupon.expiresAt!) - Date.parse(coupon.issuedAt)) / 86_400_000;
    expect(days).toBeCloseTo(7, 5);
    const row = await prisma.coupon.findUniqueOrThrow({ where: { code: coupon.code } });
    expect(row).toMatchObject({ issuedToUserId: referrer.userId, usageLimitTotal: 1, usageLimitPerUser: 1, usedCount: 0 });
    expect(await prisma.coupon.count()).toBe(1);

    // Checkout: apply → the cart, the quote (what the screen shows) and the order agree.
    await referrer.add(item150, 2); // ₹300
    const applied = expectSuccess<CartDto>((await referrer.applyCoupon(coupon.code).expect(200)).body).data;
    expect(applied.bill).toMatchObject({ couponCode: coupon.code, couponDiscountPaise: 5000 });

    const bill = await referrer.quote();
    expect(bill.couponCode).toBe(coupon.code);
    expect(bill.couponDiscountPaise).toBe(5000);
    expect(bill.totalPaise).toBe(30000 - 5000 + bill.deliveryFeePaise + bill.platformFeePaise);

    const placed = await referrer.place(PaymentMethod.COD, bill.totalPaise);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const order = expectSuccess<{ order: OrderDetailDto }>(placed.body).data.order;
    expect(order.bill.couponCode).toBe(coupon.code);
    expect(order.bill.couponDiscountPaise).toBe(5000);
    expect(order.bill.totalPaise).toBe(bill.totalPaise);

    expect(await prisma.couponRedemption.count({ where: { coupon: { code: coupon.code }, releasedAt: null } })).toBe(1);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: coupon.code } })).usedCount).toBe(1);
    expect((await referrer.rewards())[0]!.status).toBe('USED');

    // Not a second time: refused on apply, and not silently priced in the quote.
    await referrer.add(item150, 1);
    expect(expectError((await referrer.applyCoupon(coupon.code).expect(422)).body).code).toBe(ErrorCode.COUPON_LIMIT_REACHED);
    const next = await referrer.quote();
    expect(next.couponDiscountPaise).toBe(0);
    expect(next.couponCode).toBeNull();
    // The referred friend's reward stays single: still one coupon in the system.
    expect(await prisma.coupon.count()).toBe(1);
  });

  it('online payment: the quote total with the coupon is accepted, the paid order is discounted, the coupon is used once', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);
    const { bill, res } = await checkout(referrer, PaymentMethod.ONLINE);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const placed = expectSuccess<{ order: { id: string }; payment: { providerOrderId: string } }>(res.body).data;
    expect(bill.couponDiscountPaise).toBe(5000);
    cashfree.attempt(placed.payment.providerOrderId, 'SUCCESS');
    await referrer.refresh(placed.order.id);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(order).toMatchObject({ couponDiscountPaise: 5000, totalPaise: bill.totalPaise });
    expect((await referrer.rewards())[0]!.status).toBe('USED');
    // The paid order took the coupon off the cart.
    expect(expectSuccess<CartDto>((await referrer.cart().expect(200)).body).data.bill.couponCode).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('B. what is refused', () => {
  it('an expired coupon cannot be applied; one that expires after applying drops out of the cart and the quote without blocking checkout', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);

    await prisma.coupon.update({ where: { code: coupon.code }, data: { validTo: new Date(Date.now() - 60_000) } });
    const bill = await referrer.quote();
    expect(bill.couponDiscountPaise).toBe(0);
    const placed = await referrer.place(PaymentMethod.COD, bill.totalPaise);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(expectSuccess<{ order: OrderDetailDto }>(placed.body).data.order.bill.couponDiscountPaise).toBe(0);

    await referrer.add(item150, 1);
    expect(expectError((await referrer.applyCoupon(coupon.code).expect(422)).body).code).toBe(ErrorCode.COUPON_EXPIRED);
    expect((await referrer.rewards())[0]!.status).toBe('EXPIRED');
    expect(await prisma.couponRedemption.count()).toBe(0);
  });

  it("another customer's coupon is invalid for them — in apply and in an explicit quote", async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    const other = await customer();
    await other.add(item150, 1);
    expect(expectError((await other.applyCoupon(coupon.code).expect(422)).body).code).toBe(ErrorCode.COUPON_INVALID);
    const quote = await api().post('/api/v1/checkout/quote').set(other.auth).send({ addressId: other.addressId, couponCode: coupon.code });
    expect(expectError(quote.body).code).toBe(ErrorCode.COUPON_INVALID);
    expect((await other.rewards()).length).toBe(0);
  });

  it('below the ₹99 minimum: refused with the reason, nothing stored, and the cart keeps loading', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item60, 1); // ₹60
    const refused = await referrer.applyCoupon(coupon.code);
    expect(refused.status).toBe(422);
    expect(expectError(refused.body).code).toBe(ErrorCode.COUPON_MIN_ORDER_NOT_MET);
    expect(expectError(refused.body).message).toMatch(/₹99/);
    expect((await prisma.cart.findFirstOrThrow({ where: { userId: referrer.userId, status: 'ACTIVE' } })).couponCode).toBeNull();
    expect((await referrer.cart()).status).toBe(200);
    expect((await referrer.quote()).couponDiscountPaise).toBe(0);
    // Enough items now: it applies.
    await referrer.add(item60, 1); // ₹120
    expect(expectSuccess<CartDto>((await referrer.applyCoupon(coupon.code).expect(200)).body).data.bill.couponDiscountPaise).toBe(5000);
  });

  it('a cart that drops below the minimum after applying loses the coupon with a notice; checkout still works', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    const cart = await referrer.add(item60, 2); // ₹120
    await referrer.applyCoupon(coupon.code).expect(200);
    const lineId = cart.items[0]!.id;
    // The quantity change answers with the re-read cart: that answer carries the notice.
    const lowered = await api().patch(`/api/v1/cart/items/${lineId}`).set(referrer.auth).send({ qty: 1 }); // ₹60
    expect(lowered.status).toBe(200);
    const dto = expectSuccess<CartDto>(lowered.body).data;
    expect(dto.bill.couponCode).toBeNull();
    expect(dto.bill.couponDiscountPaise).toBe(0);
    expect(dto.changes.some((change) => change.type === 'COUPON_REMOVED' && /₹99/.test(change.message))).toBe(true);
    // And the cart keeps loading afterwards (it used to fail on every read).
    expect((await referrer.cart()).status).toBe(200);
    const { bill, res } = await checkout(referrer, PaymentMethod.COD);
    expect(bill.couponDiscountPaise).toBe(0);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await referrer.rewards())[0]!.status).toBe('ACTIVE'); // not consumed
  });

  it('applying twice discounts once; two orders cannot both use it', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);
    const twice = expectSuccess<CartDto>((await referrer.applyCoupon(coupon.code.toLowerCase()).expect(200)).body).data;
    expect(twice.bill.couponDiscountPaise).toBe(5000);
    const bill = await referrer.quote();
    expect(bill.couponDiscountPaise).toBe(5000);
    expect((await referrer.place(PaymentMethod.COD, bill.totalPaise)).status).toBe(201);
    // The same code sent explicitly on a second order is refused.
    await referrer.add(item150, 1);
    const second = await api()
      .post('/api/v1/orders')
      .set(referrer.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ addressId: referrer.addressId, paymentMethod: PaymentMethod.COD, couponCode: coupon.code });
    expect(expectError(second.body).code).toBe(ErrorCode.COUPON_LIMIT_REACHED);
    expect(await prisma.couponRedemption.count({ where: { releasedAt: null } })).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('C. payment failure, cancellation and retry never consume the coupon', () => {
  it('a failed online payment keeps the coupon on the cart; paying again reuses the checkout with the same discount', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);
    const first = await checkout(referrer, PaymentMethod.ONLINE);
    expect(first.res.status, JSON.stringify(first.res.body)).toBe(201);
    const unpaid = expectSuccess<{ order: { id: string }; payment: { providerOrderId: string } }>(first.res.body).data;
    cashfree.attempt(unpaid.payment.providerOrderId, 'FAILED');
    await referrer.refresh(unpaid.order.id);

    // Back in the cart: the coupon is still applied, the quote still discounts.
    const cart = expectSuccess<CartDto>((await referrer.cart().expect(200)).body).data;
    expect(cart.bill.couponCode).toBe(coupon.code);
    expect(cart.changes.some((change) => change.type === 'COUPON_REMOVED')).toBe(false);
    const retry = await checkout(referrer, PaymentMethod.ONLINE);
    expect(retry.bill.couponDiscountPaise).toBe(5000);
    expect(retry.res.status, JSON.stringify(retry.res.body)).toBe(201);
    const again = expectSuccess<{ order: { id: string }; payment: { providerOrderId: string } }>(retry.res.body).data;
    expect(again.order.id).toBe(unpaid.order.id); // the same checkout, reused
    expect(await prisma.couponRedemption.count({ where: { releasedAt: null } })).toBe(1);

    cashfree.attempt(again.payment.providerOrderId, 'SUCCESS');
    await referrer.refresh(again.order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: again.order.id } })).couponDiscountPaise).toBe(5000);
    expect((await referrer.rewards())[0]!.status).toBe('USED');
  });

  it('an unpaid checkout that runs out of time gives the coupon back; it applies again', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);
    const { res } = await checkout(referrer, PaymentMethod.ONLINE);
    const unpaid = expectSuccess<{ order: { id: string } }>(created(res)).data;
    await prisma.order.update({ where: { id: unpaid.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await releaseExpiredReservations();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unpaid.order.id } })).status).not.toBe(OrderStatus.PROCESSING);
    expect(await prisma.couponRedemption.count({ where: { releasedAt: null } })).toBe(0);
    expect((await referrer.rewards())[0]!.status).toBe('ACTIVE');
    const bill = await referrer.quote();
    expect(bill.couponDiscountPaise).toBe(5000); // still on the cart, usable again
    expect((await referrer.place(PaymentMethod.COD, bill.totalPaise)).status).toBe(201);
    expect((await referrer.rewards())[0]!.status).toBe('USED');
  });

  it('switching to cash on delivery after a failed online attempt: one order, one use, the discount kept', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);
    const online = await checkout(referrer, PaymentMethod.ONLINE);
    const unpaid = expectSuccess<{ order: { id: string }; payment: { providerOrderId: string } }>(created(online.res)).data;
    cashfree.attempt(unpaid.payment.providerOrderId, 'FAILED');
    await referrer.refresh(unpaid.order.id);
    const cod = await checkout(referrer, PaymentMethod.COD);
    expect(cod.bill.couponDiscountPaise).toBe(5000);
    expect(cod.res.status, JSON.stringify(cod.res.body)).toBe(201);
    const order = expectSuccess<{ order: OrderDetailDto }>(cod.res.body).data.order;
    expect(order.bill.couponDiscountPaise).toBe(5000);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unpaid.order.id } })).status).toBe(OrderStatus.CANCELLED);
    expect(await prisma.couponRedemption.count({ where: { releasedAt: null } })).toBe(1);
  });

  it('a cancelled order gives the coupon back; it can be applied and used again', async () => {
    const referrer = await customer();
    const coupon = await earnReferralCoupon(adminToken, referrer, item150);
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);
    const { res } = await checkout(referrer, PaymentMethod.COD);
    const order = expectSuccess<{ order: OrderDetailDto }>(created(res)).data.order;
    expect((await referrer.rewards())[0]!.status).toBe('USED');
    expect((await referrer.cancel(order.id)).status).toBe(200);
    expect((await referrer.rewards())[0]!.status).toBe('ACTIVE');
    await referrer.add(item150, 1);
    await referrer.applyCoupon(coupon.code).expect(200);
    const again = await checkout(referrer, PaymentMethod.COD);
    expect(again.bill.couponDiscountPaise).toBe(5000);
    expect(again.res.status).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */

describe('D. other coupons keep working', () => {
  it('a global promo code (percent, capped) applies through the same cart → quote → order path', async () => {
    await prisma.coupon.create({ data: { code: 'SAVE10', type: 'PERCENT', discountValue: 10, maxDiscountPaise: 2000, minOrderPaise: 0, usageLimitPerUser: 2 } });
    const shopper = await customer();
    await shopper.add(item150, 2); // ₹300 → 10% = ₹30
    await shopper.applyCoupon('save10').expect(200);
    const bill = await shopper.quote();
    expect(bill).toMatchObject({ couponCode: 'SAVE10', couponDiscountPaise: 2000 }); // capped at ₹20
    const placed = await shopper.place(PaymentMethod.COD, bill.totalPaise);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(expectSuccess<{ order: OrderDetailDto }>(placed.body).data.order.bill.couponDiscountPaise).toBe(2000);
  });

  it('a free-delivery code and an explicit quote code keep their existing behaviour; removing the coupon removes the discount', async () => {
    await prisma.coupon.create({ data: { code: 'FLAT20', type: 'FLAT', discountValue: 2000, minOrderPaise: 0 } });
    const shopper = await customer();
    await shopper.add(item150, 1);
    // An explicit code in the quote (older callers) is priced as before, without touching the cart.
    expect((await shopper.quote({ couponCode: 'FLAT20' })).couponDiscountPaise).toBe(2000);
    expect((await shopper.quote()).couponDiscountPaise).toBe(0);
    await shopper.applyCoupon('FLAT20').expect(200);
    expect((await shopper.quote()).couponDiscountPaise).toBe(2000);
    await shopper.removeCoupon().expect(200);
    const bill = await shopper.quote();
    expect(bill.couponDiscountPaise).toBe(0);
    expect((await shopper.place(PaymentMethod.COD, bill.totalPaise)).status).toBe(201);
  });
});
