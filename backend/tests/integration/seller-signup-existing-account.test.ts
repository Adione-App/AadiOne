/**
 * One account can shop AND sell. An existing customer applies to sell with
 * the same mobile number: the number is proven with an OTP and the store is
 * added to the SAME account — no second user, nothing of the customer's lost
 * or overwritten, the application PENDING until an admin approves, and the
 * Seller Panel limited to the application status until then. Shopping keeps
 * working throughout.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, PaymentMethod, SellerLifecycleStatus, SellerType, UserRole, UserStatus } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const MOBILE = '8690530973';
const OTHER = '9876500077';
const PASSWORD = 'Seller@12345';

let counter = 0;
function signup(mobile: string, overrides: Record<string, unknown> = {}) {
  counter += 1;
  return api()
    .post('/api/v1/auth/seller/signup')
    .send({
      fullName: 'Store Owner',
      mobile,
      email: `owner${counter}@adione.test`,
      password: PASSWORD,
      businessName: `Corner Store ${counter}`,
      sellerType: SellerType.GROCERY,
      ...overrides,
    });
}

async function sendOtp(mobile: string): Promise<string> {
  // Test-only: reset the in-memory OTP cooldown and per-number send limit (3/hour) between codes.
  await cache.clear();
  const res = await api().post('/api/v1/auth/send-otp').send({ mobile }).expect(200);
  const code = expectSuccess<{ devOtp?: string }>(res.body).data.devOtp;
  if (!code) throw new Error('console OTP provider did not return devOtp');
  return code;
}

const mobileDetail = (body: unknown) => expectError(body).details?.find((detail) => detail.field === 'mobile');

/** A shopper with real history: an address, a placed order, an issued coupon, and a live app session. */
async function existingCustomer() {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { stockQty: 10 });
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
  const order = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(session.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD });
  expect(order.status).toBe(201);
  const coupon = await prisma.coupon.create({ data: { code: 'WELCOME-REWARD', type: 'FLAT', discountValue: 5000, issuedToUserId: session.userId } });
  return { ...session, addressId, orderId: expectSuccess<{ order: { id: string } }>(order.body).data.order.id, couponId: coupon.id };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  for (const mobile of [MOBILE, OTHER]) await otpService.clearOtpState(mobile);
});

describe('an existing customer applies to sell with the same number', () => {
  it('is asked to verify the number, then the store joins the SAME account — customer data intact, shopping still works', async () => {
    const customer = await existingCustomer();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });

    // 1. Without the code: not a dead end — the server asks for it.
    const first = await signup(MOBILE, { email: 'shopper@adione.test', fullName: 'Asha Shopper' });
    expect(first.status).toBe(409);
    expect(mobileDetail(first.body)).toMatchObject({ conflict: 'CUSTOMER', requiresOtp: true });
    expect(expectError(first.body).message).toMatch(/verify the number/i);
    expect(await prisma.seller.count()).toBe(1); // only the seeded store

    // 2. With the code: one account, now also a seller applicant.
    const code = await sendOtp(MOBILE);
    const joined = await signup(MOBILE, { email: 'shopper@adione.test', fullName: 'Asha Shopper', otp: code });
    expect(joined.status).toBe(201);
    const data = expectSuccess<{ user: { id: string; role: string }; sellerId: string; lifecycleStatus: string; tokens: { accessToken: string } }>(joined.body).data;
    expect(data.user.id).toBe(customer.userId);
    expect(data.lifecycleStatus).toBe(SellerLifecycleStatus.APPLICATION_PENDING);

    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(after).toMatchObject({ role: UserRole.SELLER_OWNER, status: UserStatus.ACTIVE, email: 'shopper@adione.test', referralCode: before.referralCode });
    expect(after.passwordHash).not.toBeNull();
    expect(after.mobileVerifiedAt).not.toBeNull();
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: data.sellerId } });
    expect(seller).toMatchObject({ lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING, onboardingStatus: 'PENDING' });
    expect(await prisma.sellerStaff.count({ where: { userId: customer.userId, sellerId: data.sellerId, role: 'OWNER', isActive: true } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller_application.submit', entityId: data.sellerId } });
    expect(audit.after).toMatchObject({ linkedExistingAccount: true, ownerUserId: customer.userId });

    // Customer data untouched.
    expect(await prisma.address.count({ where: { id: customer.addressId, userId: customer.userId } })).toBe(1);
    expect(await prisma.order.count({ where: { id: customer.orderId, userId: customer.userId } })).toBe(1);
    expect(await prisma.coupon.count({ where: { id: customer.couponId, issuedToUserId: customer.userId } })).toBe(1);

    // Shopping still works with the existing app session (and a fresh OTP sign-in is still a shopper session).
    const orders = await api().get('/api/v1/orders').set('Authorization', bearer(customer.accessToken)).expect(200);
    expect(JSON.stringify(orders.body)).toContain(customer.orderId);
    const otpLogin = await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp: await sendOtp(MOBILE) }).expect(200);
    const shopperToken = expectSuccess<{ tokens: { accessToken: string } }>(otpLogin.body).data.tokens.accessToken;
    await api().get('/api/v1/orders').set('Authorization', bearer(shopperToken)).expect(200);
    // …and an SMS code never opens the Seller Panel.
    expect((await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(shopperToken))).status).toBe(403);

    // Seller Panel: application status only, until an admin approves.
    const login = await api().post('/api/v1/auth/seller/login').send({ email: 'shopper@adione.test', password: PASSWORD }).expect(200);
    const sellerToken = expectSuccess<{ tokens: { accessToken: string } }>(login.body).data.tokens.accessToken;
    await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(sellerToken)).expect(200);
    const blocked = await api().get('/api/v1/seller/products').set('Authorization', bearer(sellerToken));
    expect(expectError(blocked.body).code).toBe(ErrorCode.SELLER_ACCOUNT_NOT_ACTIVE);

    // Approved (both gates) -> the dashboard opens; shopping still works.
    await prisma.seller.update({ where: { id: data.sellerId }, data: { lifecycleStatus: SellerLifecycleStatus.ACTIVE, onboardingStatus: 'APPROVED' } });
    await api().get('/api/v1/seller/products').set('Authorization', bearer(sellerToken)).expect(200);
    await api().get('/api/v1/orders').set('Authorization', bearer(customer.accessToken)).expect(200);

    // One application per account: applying again is refused as a SELLER.
    const again = await signup(MOBILE, { email: 'shopper@adione.test', otp: await sendOtp(MOBILE) });
    expect(again.status).toBe(409);
    expect(mobileDetail(again.body)).toMatchObject({ conflict: 'SELLER', requiresOtp: false });
    expect(await prisma.seller.count({ where: { staff: { some: { userId: customer.userId } } } })).toBe(1);
  });

  it('a wrong code changes nothing; a fixable mistake (the account already has another email) does not use up the code', async () => {
    const customer = await loginAs(MOBILE);
    await prisma.user.update({ where: { id: customer.userId }, data: { email: 'asha@family.test', fullName: 'Asha' } });
    const code = await sendOtp(MOBILE);

    const wrong = await signup(MOBILE, { email: 'asha@family.test', otp: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.seller.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).role).toBe(UserRole.CUSTOMER);

    // The account has its own email: never overwritten — the applicant is told which to use (masked).
    const otherEmail = await signup(MOBILE, { email: 'someone.else@adione.test', otp: code });
    expect(otherEmail.status).toBe(400);
    expect(expectError(otherEmail.body).message).toMatch(/already uses the email a\*\*\*@family\.test/);
    expect(expectError(otherEmail.body).message).not.toContain('asha@family.test');

    // Same code, right email: accepted. Name and email stay the customer's own.
    const ok = await signup(MOBILE, { email: 'ASHA@family.test', fullName: 'Different Name', otp: code });
    expect(ok.status).toBe(201);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).toMatchObject({ email: 'asha@family.test', fullName: 'Asha' });
  });

  it("another account's email is refused; brand-new numbers sign up exactly as before (no code needed)", async () => {
    await prisma.user.create({ data: { mobile: OTHER, email: 'taken@adione.test', fullName: 'Someone', role: UserRole.CUSTOMER } });
    await loginAs(MOBILE);
    const res = await signup(MOBILE, { email: 'taken@adione.test', otp: await sendOtp(MOBILE) });
    expect(expectError(res.body).code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);

    const fresh = await signup('9876500099');
    expect(fresh.status).toBe(201);
    expect(expectSuccess<{ lifecycleStatus: string }>(fresh.body).data.lifecycleStatus).toBe(SellerLifecycleStatus.APPLICATION_PENDING);
  });

  it('a former seller (store gone) re-applies on the same account — with its own Partner Portal password', async () => {
    const user = await prisma.user.create({
      data: { mobile: MOBILE, email: 'former@adione.test', fullName: 'Former', role: UserRole.SELLER_OWNER, passwordHash: await hashPassword(PASSWORD) },
    });
    const old = await prisma.seller.create({
      data: { name: 'Old Store', code: 'OLDSTORE', addressLine: '', city: '', state: '', pincode: '', latitude: 0, longitude: 0, deletedAt: new Date(), isActive: false },
    });
    await prisma.sellerStaff.create({ data: { sellerId: old.id, userId: user.id, role: 'OWNER', isActive: false, deletedAt: new Date() } });

    const code = await sendOtp(MOBILE);
    const wrongPassword = await signup(MOBILE, { email: 'former@adione.test', password: 'Another@12345', otp: code });
    expect(wrongPassword.status).toBe(400);
    expect(expectError(wrongPassword.body).message).toMatch(/already has a Partner Portal password/);

    const ok = await signup(MOBILE, { email: 'former@adione.test', otp: code });
    expect(ok.status).toBe(201);
    expect(expectSuccess<{ user: { id: string } }>(ok.body).data.user.id).toBe(user.id);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
  });

  it('staff and blocked numbers stay refused even with a valid code', async () => {
    await prisma.user.create({ data: { mobile: MOBILE, fullName: 'Rider', role: UserRole.DELIVERY_AGENT } });
    const staff = await signup(MOBILE, { otp: await sendOtp(MOBILE) });
    expect(mobileDetail(staff.body)).toMatchObject({ conflict: 'STAFF', requiresOtp: false });

    await prisma.user.create({ data: { mobile: OTHER, fullName: 'Blocked', role: UserRole.CUSTOMER, status: 'BLOCKED' } });
    const blocked = await signup(OTHER, { otp: '123456' });
    expect(mobileDetail(blocked.body)).toMatchObject({ conflict: 'BLOCKED', requiresOtp: false });
    expect(await prisma.seller.count()).toBe(0);
  });

  it('two applications racing for one customer account create exactly one store', async () => {
    const customer = await loginAs(MOBILE);
    const code = await sendOtp(MOBILE);
    const [a, b] = await Promise.all([signup(MOBILE, { otp: code }), signup(MOBILE, { otp: code })]);
    expect([a.status, b.status].filter((status) => status === 201)).toHaveLength(1);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
    expect(await prisma.sellerStaff.count({ where: { userId: customer.userId } })).toBe(1);
    expect(await prisma.seller.count()).toBe(1);
  });
});
