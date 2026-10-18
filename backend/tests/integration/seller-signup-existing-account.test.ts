/**
 * One account can shop AND sell. A SIGNED-IN customer applies to sell from
 * the app (GET /auth/seller/application, POST /auth/seller/apply): the
 * account is the session's — no mobile number in the body, no OTP, no
 * "existing account" warning. The store is added to the SAME account: no
 * second user, nothing of the customer's lost or overwritten (an existing
 * email or password is never replaced), the application PENDING until an
 * admin approves, and the Seller Panel limited to the application status until
 * then. Shopping keeps working throughout. The public signup form never
 * attaches to an existing account: it sends the applicant to sign in.
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
const PASSWORD = 'Seller@12345';

interface ApplicationStatus {
  status: string;
  canApply: boolean;
  sellerName: string | null;
  sellerPanelEmail: string | null;
  needsEmail: boolean;
  needsPassword: boolean;
}

const status = async (token: string) =>
  expectSuccess<ApplicationStatus>((await api().get('/api/v1/auth/seller/application').set('Authorization', bearer(token)).expect(200)).body).data;

const apply = (token: string | null, body: Record<string, unknown>) => {
  const req = api().post('/api/v1/auth/seller/apply');
  if (token) req.set('Authorization', bearer(token));
  return req.send({ businessName: 'Asha General Store', sellerType: SellerType.GROCERY, ...body });
};

/** A shopper with real history: an address, a placed order, an issued coupon, a signed-in app session. */
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
  await otpService.clearOtpState(MOBILE);
});

describe('a signed-in customer applies to sell (same account)', () => {
  it('no OTP, no warning: the store joins the SAME account — customer data intact, shopping works, Seller Panel waits for approval', async () => {
    const customer = await existingCustomer();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });

    // What the app shows: the form, asking only for the Seller Panel sign-in this account lacks.
    expect(await status(customer.accessToken)).toEqual({
      status: 'NONE', canApply: true, sellerName: null, reason: null, sellerPanelEmail: null, needsEmail: true, needsPassword: true,
    });

    const res = await apply(customer.accessToken, { ownerFullName: 'Asha Shopper', email: 'Asha@Store.test', password: PASSWORD });
    expect(res.status).toBe(201);
    const data = expectSuccess<{ sellerId: string; lifecycleStatus: string; sellerPanelEmail: string }>(res.body).data;
    expect(data).toMatchObject({ lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING, sellerPanelEmail: 'asha@store.test' });

    // One account, now also a seller applicant.
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(after).toMatchObject({ role: UserRole.SELLER_OWNER, status: UserStatus.ACTIVE, email: 'asha@store.test', referralCode: before.referralCode, mobile: MOBILE });
    expect(after.passwordHash).not.toBeNull();
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: data.sellerId } });
    expect(seller).toMatchObject({ lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING, onboardingStatus: 'PENDING', name: 'Asha General Store' });
    expect(await prisma.sellerStaff.count({ where: { userId: customer.userId, sellerId: data.sellerId, role: 'OWNER', isActive: true } })).toBe(1);
    expect(await prisma.sellerProfile.findUniqueOrThrow({ where: { sellerId: data.sellerId } })).toMatchObject({ ownerMobile: MOBILE, ownerEmail: 'asha@store.test', ownerFullName: 'Asha Shopper' });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller_application.submit', entityId: data.sellerId } });
    expect(audit).toMatchObject({ actorUserId: customer.userId });
    expect(audit.after).toMatchObject({ linkedExistingAccount: true, ownerUserId: customer.userId });

    // Customer data untouched; the same app session keeps shopping.
    expect(await prisma.address.count({ where: { id: customer.addressId, userId: customer.userId } })).toBe(1);
    expect(await prisma.order.count({ where: { id: customer.orderId, userId: customer.userId } })).toBe(1);
    expect(await prisma.coupon.count({ where: { id: customer.couponId, issuedToUserId: customer.userId } })).toBe(1);
    const orders = await api().get('/api/v1/orders').set('Authorization', bearer(customer.accessToken)).expect(200);
    expect(JSON.stringify(orders.body)).toContain(customer.orderId);

    // The app now shows the application's progress.
    expect(await status(customer.accessToken)).toMatchObject({ status: SellerLifecycleStatus.APPLICATION_PENDING, sellerName: 'Asha General Store', needsEmail: false, needsPassword: false });

    // The customer-app session never opens the Seller Panel; the Seller Panel login does — limited until approval.
    expect((await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(customer.accessToken))).status).toBe(403);
    const login = await api().post('/api/v1/auth/seller/login').send({ email: 'asha@store.test', password: PASSWORD }).expect(200);
    const sellerToken = expectSuccess<{ tokens: { accessToken: string } }>(login.body).data.tokens.accessToken;
    await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(sellerToken)).expect(200);
    expect(expectError((await api().get('/api/v1/seller/products').set('Authorization', bearer(sellerToken))).body).code).toBe(ErrorCode.SELLER_ACCOUNT_NOT_ACTIVE);
    await prisma.seller.update({ where: { id: data.sellerId }, data: { lifecycleStatus: SellerLifecycleStatus.ACTIVE, onboardingStatus: 'APPROVED' } });
    await api().get('/api/v1/seller/products').set('Authorization', bearer(sellerToken)).expect(200);
    await api().get('/api/v1/orders').set('Authorization', bearer(customer.accessToken)).expect(200);

    // One store per account.
    const again = await apply(customer.accessToken, { businessName: 'Second Store' });
    expect(again.status).toBe(409);
    expect(expectError(again.body).message).toMatch(/already has a store/);
    expect(await prisma.sellerStaff.count({ where: { userId: customer.userId } })).toBe(1);
  });

  it("the account's own email and password are kept — never replaced, never asked for again", async () => {
    const customer = await loginAs(MOBILE);
    await api().patch('/api/v1/auth/me').set('Authorization', bearer(customer.accessToken)).send({ fullName: 'Asha', email: 'asha@family.test' }).expect(200);
    const hash = await hashPassword('Existing@123');
    await prisma.user.update({ where: { id: customer.userId }, data: { passwordHash: hash } });

    expect(await status(customer.accessToken)).toMatchObject({ needsEmail: false, needsPassword: false, sellerPanelEmail: 'asha@family.test' });

    const otherEmail = await apply(customer.accessToken, { email: 'someone.else@store.test' });
    expect(otherEmail.status).toBe(400);
    expect(expectError(otherEmail.body).message).toMatch(/already uses the email a\*\*\*@family\.test/);
    const newPassword = await apply(customer.accessToken, { password: PASSWORD });
    expect(newPassword.status).toBe(400);
    expect(expectError(newPassword.body).message).toMatch(/already has a Seller Panel password/);
    expect(await prisma.seller.count()).toBe(0);

    const ok = await apply(customer.accessToken, {});
    expect(ok.status).toBe(201);
    expect(expectSuccess<{ sellerPanelEmail: string }>(ok.body).data.sellerPanelEmail).toBe('asha@family.test');
    expect(await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).toMatchObject({ email: 'asha@family.test', fullName: 'Asha', passwordHash: hash });
    expect(await prisma.sellerProfile.count({ where: { ownerFullName: 'Asha' } })).toBe(1); // defaults to the account's own name
  });

  it('missing Seller Panel credentials, or another account’s email, are refused — nothing created', async () => {
    const customer = await loginAs(MOBILE);
    await prisma.user.create({ data: { mobile: '9876500077', email: 'taken@store.test', fullName: 'Someone', role: UserRole.CUSTOMER } });

    expect(expectError((await apply(customer.accessToken, { ownerFullName: 'Asha', password: PASSWORD })).body).details?.[0]).toMatchObject({ field: 'email' });
    expect(expectError((await apply(customer.accessToken, { ownerFullName: 'Asha', email: 'asha@store.test' })).body).details?.[0]).toMatchObject({ field: 'password' });
    expect(expectError((await apply(customer.accessToken, { email: 'asha@store.test', password: PASSWORD })).body).details?.[0]).toMatchObject({ field: 'ownerFullName' });
    expect(expectError((await apply(customer.accessToken, { ownerFullName: 'Asha', email: 'TAKEN@store.test', password: PASSWORD })).body).code).toBe(
      ErrorCode.EMAIL_ALREADY_REGISTERED,
    );
    expect(await prisma.seller.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).role).toBe(UserRole.CUSTOMER);
  });
});

describe('who may apply, and on which account', () => {
  it('signed out is refused; the body can never name an account (no mobile field)', async () => {
    const customer = await loginAs(MOBILE);
    expect((await apply(null, { email: 'x@store.test', password: PASSWORD })).status).toBe(401);
    expect((await api().get('/api/v1/auth/seller/application')).status).toBe(401);

    const named = await apply(customer.accessToken, { mobile: '9876500088', ownerFullName: 'Asha', email: 'x@store.test', password: PASSWORD });
    expect(named.status).toBe(400); // strict body: there is nothing to point at another account with
    expect(await prisma.seller.count()).toBe(0);
  });

  it('staff / admin accounts cannot open a store; blocked accounts are rejected', async () => {
    await prisma.user.create({
      data: { mobile: '9000000011', email: 'admin@adione.test', fullName: 'Admin', passwordHash: await hashPassword('TestAdmin@123'), role: UserRole.ADMIN },
    });
    const login = await api().post('/api/v1/auth/admin/login').send({ email: 'admin@adione.test', password: 'TestAdmin@123' }).expect(200);
    const adminToken = expectSuccess<{ tokens: { accessToken: string } }>(login.body).data.tokens.accessToken;
    expect((await status(adminToken)).canApply).toBe(false);
    expect((await apply(adminToken, { ownerFullName: 'Admin' })).status).toBe(403);

    const customer = await loginAs(MOBILE);
    await prisma.user.update({ where: { id: customer.userId }, data: { status: 'BLOCKED' } });
    expect((await apply(customer.accessToken, { ownerFullName: 'Asha', email: 'x@store.test', password: PASSWORD })).status).toBeGreaterThanOrEqual(401);
    expect(await prisma.seller.count()).toBe(0);
  });

  it('a former seller (store gone) re-applies on the same account', async () => {
    const user = await prisma.user.create({
      data: { mobile: MOBILE, email: 'former@store.test', fullName: 'Former', role: UserRole.SELLER_OWNER, passwordHash: await hashPassword(PASSWORD) },
    });
    const old = await prisma.seller.create({
      data: { name: 'Old Store', code: 'OLDSTORE', addressLine: '', city: '', state: '', pincode: '', latitude: 0, longitude: 0, deletedAt: new Date(), isActive: false },
    });
    await prisma.sellerStaff.create({ data: { sellerId: old.id, userId: user.id, role: 'OWNER', isActive: false, deletedAt: new Date() } });
    // Signed in to the customer app (OTP) — how this person reaches Account → Sell on Aadione.
    const sent = await api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE }).expect(200);
    const otp = expectSuccess<{ devOtp: string }>(sent.body).data.devOtp;
    const verified = await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp }).expect(200);
    const token = expectSuccess<{ tokens: { accessToken: string } }>(verified.body).data.tokens.accessToken;
    expect(await status(token)).toMatchObject({ status: 'NONE', canApply: true, needsEmail: false, needsPassword: false });
    expect((await apply(token, {})).status).toBe(201);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
  });

  it('two taps / two devices at once create exactly one store', async () => {
    const customer = await loginAs(MOBILE);
    const body = { ownerFullName: 'Asha', email: 'asha@store.test', password: PASSWORD };
    const [a, b] = await Promise.all([apply(customer.accessToken, body), apply(customer.accessToken, body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.sellerStaff.count({ where: { userId: customer.userId } })).toBe(1);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
  });
});

describe('the public Partner Portal form (signed out)', () => {
  it("never attaches to an existing customer's account — it sends them to sign in; new numbers sign up as before", async () => {
    const customer = await loginAs(MOBILE);
    const res = await api()
      .post('/api/v1/auth/seller/signup')
      .send({ fullName: 'Asha', mobile: MOBILE, email: 'asha@store.test', password: PASSWORD, businessName: 'Asha Store', sellerType: SellerType.GROCERY });
    expect(res.status).toBe(409);
    expect(expectError(res.body).details?.[0]).toMatchObject({ conflict: 'CUSTOMER', signInToApply: true });
    expect(expectError(res.body).message).toMatch(/Sign in to the Aadione app/);
    expect(await prisma.seller.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).role).toBe(UserRole.CUSTOMER);

    // An OTP field is not accepted any more.
    const withOtp = await api()
      .post('/api/v1/auth/seller/signup')
      .send({ fullName: 'Asha', mobile: MOBILE, email: 'asha@store.test', password: PASSWORD, businessName: 'Asha Store', sellerType: SellerType.GROCERY, otp: '123456' });
    expect(withOtp.status).toBe(400);

    const fresh = await api()
      .post('/api/v1/auth/seller/signup')
      .send({ fullName: 'New Owner', mobile: '9876500099', email: 'new@store.test', password: PASSWORD, businessName: 'New Store', sellerType: SellerType.GROCERY });
    expect(fresh.status).toBe(201);
    expect(expectSuccess<{ lifecycleStatus: string }>(fresh.body).data.lifecycleStatus).toBe(SellerLifecycleStatus.APPLICATION_PENDING);
  });
});
