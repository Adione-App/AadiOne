/**
 * One mobile number, two SEPARATE accounts: the customer (shopping app) and
 * the partner (Seller Panel). Neither registration blocks the other, in
 * either order; each portal signs in to its own account; nothing is merged
 * or overwritten; duplicates of the SAME type are still impossible; seller
 * registration never asks for an OTP or phone code.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { ErrorCode, PaymentMethod, SellerLifecycleStatus, SellerType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginCustomerApp } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { planSellerCleanup } from '../../src/modules/maintenance/seller-cleanup';

const MOBILE = '8690530973';
const SELLER_PASSWORD = 'Seller@12345';
const CUSTOMER_PASSWORD = 'Customer@123';

const sellerSignup = (overrides: Record<string, unknown> = {}) =>
  api()
    .post('/api/v1/auth/seller/signup')
    .send({
      fullName: 'Asha Owner',
      mobile: MOBILE,
      email: 'asha@store.test',
      password: SELLER_PASSWORD,
      businessName: 'Asha General Store',
      sellerType: SellerType.GROCERY,
      ...overrides,
    });

const sellerLogin = (email: string, password: string) => api().post('/api/v1/auth/seller/login').send({ email, password });
const tokenOf = (body: unknown) => expectSuccess<{ user: { id: string }; tokens: { accessToken: string } }>(body).data;

/** A shopper with history: address, a placed order, an issued coupon. */
async function shopWith(session: { accessToken: string; userId: string }) {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { stockQty: 10 });
  const addressId = await seedAddress(session.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
  const order = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(session.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD });
  expect(order.status).toBe(201);
  const coupon = await prisma.coupon.create({ data: { code: `REWARD-${randomUUID().slice(0, 6)}`, type: 'FLAT', discountValue: 5000, issuedToUserId: session.userId } });
  return { addressId, orderId: expectSuccess<{ order: { id: string } }>(order.body).data.order.id, couponId: coupon.id };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await otpService.clearOtpState(MOBILE);
});

describe('the same number in both portals — two separate accounts', () => {
  it('SELLER FIRST, then customer: the customer app gets its own account; both portals work', async () => {
    // Seller Panel registration: no OTP / phone code anywhere.
    const signed = await sellerSignup();
    expect(signed.status).toBe(201);
    const sellerId = tokenOf(signed.body).user.id;

    // Customer app with the same number: a NEW customer account, the seller account untouched.
    const customer = await loginCustomerApp(MOBILE);
    expect(customer.userId).not.toBe(sellerId);
    const customerRow = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(customerRow).toMatchObject({ role: UserRole.CUSTOMER, mobile: MOBILE, email: null, passwordHash: null });
    const sellerRow = await prisma.user.findUniqueOrThrow({ where: { id: sellerId } });
    expect(sellerRow).toMatchObject({ role: UserRole.SELLER_OWNER, mobile: MOBILE, email: 'asha@store.test' });
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(2);

    // The customer shops; it is the customer account's history, not the seller's.
    const history = await shopWith(customer);
    expect(await prisma.order.count({ where: { id: history.orderId, userId: customer.userId } })).toBe(1);
    expect(await prisma.order.count({ where: { userId: sellerId } })).toBe(0);

    // Each portal signs in to its own account.
    const seller = tokenOf((await sellerLogin('asha@store.test', SELLER_PASSWORD).expect(200)).body);
    expect(seller.user.id).toBe(sellerId);
    await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(seller.tokens.accessToken)).expect(200);
    expect(expectError((await api().get('/api/v1/seller/products').set('Authorization', bearer(seller.tokens.accessToken))).body).code).toBe(
      ErrorCode.SELLER_ACCOUNT_NOT_ACTIVE, // approval restrictions unchanged
    );
    expect((await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(customer.accessToken))).status).toBe(403);
    const again = await loginCustomerApp(MOBILE);
    expect(again.userId).toBe(customer.userId); // the same customer account every time
    expect(JSON.stringify((await api().get('/api/v1/orders').set('Authorization', bearer(again.accessToken)).expect(200)).body)).toContain(history.orderId);
  });

  it('CUSTOMER FIRST, then seller: seller registration succeeds (same number AND same email); the customer account and its data are untouched', async () => {
    const customer = await loginCustomerApp(MOBILE);
    const history = await shopWith(customer);
    await api().patch('/api/v1/auth/me').set('Authorization', bearer(customer.accessToken)).send({ fullName: 'Asha', email: 'asha@family.test' }).expect(200);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });

    const signed = await sellerSignup({ email: 'asha@family.test' });
    expect(signed.status).toBe(201);
    const sellerId = tokenOf(signed.body).user.id;
    expect(sellerId).not.toBe(customer.userId);

    // Nothing of the customer's changed.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(after).toEqual(before);
    expect(await prisma.address.count({ where: { id: history.addressId, userId: customer.userId } })).toBe(1);
    expect(await prisma.order.count({ where: { id: history.orderId, userId: customer.userId } })).toBe(1);
    expect(await prisma.coupon.count({ where: { id: history.couponId, issuedToUserId: customer.userId } })).toBe(1);
    expect(await prisma.sellerStaff.count({ where: { userId: customer.userId } })).toBe(0);

    // Customer app: the same customer account, with its orders.
    const back = await loginCustomerApp(MOBILE);
    expect(back.userId).toBe(customer.userId);
    expect(JSON.stringify((await api().get('/api/v1/orders').set('Authorization', bearer(back.accessToken)).expect(200)).body)).toContain(history.orderId);

    // Seller Panel: the seller account (same email — different account), limited until approval, then open.
    const seller = tokenOf((await sellerLogin('asha@family.test', SELLER_PASSWORD).expect(200)).body);
    expect(seller.user.id).toBe(sellerId);
    const panel = () => api().get('/api/v1/seller/products').set('Authorization', bearer(seller.tokens.accessToken));
    expect(expectError((await panel()).body).code).toBe(ErrorCode.SELLER_ACCOUNT_NOT_ACTIVE);
    await prisma.seller.updateMany({ data: { lifecycleStatus: SellerLifecycleStatus.ACTIVE, onboardingStatus: 'APPROVED' } });
    expect((await panel()).status).toBe(200);
    await api().get('/api/v1/orders').set('Authorization', bearer(back.accessToken)).expect(200);
  });

  it('each portal authenticates ITS account when both share the number and the email', async () => {
    // Customer email + password signup, then a seller with the same number and email, different passwords.
    const customerSignup = await api()
      .post('/api/v1/auth/signup')
      .send({ fullName: 'Asha', email: 'asha@both.test', password: CUSTOMER_PASSWORD, mobile: MOBILE });
    expect(customerSignup.status).toBe(201);
    const customerId = tokenOf(customerSignup.body).user.id;
    const sellerId = tokenOf((await sellerSignup({ email: 'asha@both.test' })).body).user.id;
    expect(sellerId).not.toBe(customerId);

    const customerLogin = await api().post('/api/v1/auth/login').send({ email: 'asha@both.test', password: CUSTOMER_PASSWORD }).expect(200);
    expect(tokenOf(customerLogin.body).user.id).toBe(customerId);
    expect(tokenOf((await sellerLogin('asha@both.test', SELLER_PASSWORD).expect(200)).body).user.id).toBe(sellerId);
    // The other account's password never opens a portal.
    expect((await sellerLogin('asha@both.test', CUSTOMER_PASSWORD)).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: 'asha@both.test', password: SELLER_PASSWORD })).status).toBe(401);
    // And the passwords were never overwritten.
    const [c, s] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: customerId } }), prisma.user.findUniqueOrThrow({ where: { id: sellerId } })]);
    expect(c.passwordHash).not.toBe(s.passwordHash);
  });

  it('a blocked account in one portal does not block the other', async () => {
    const sellerId = tokenOf((await sellerSignup()).body).user.id;
    await prisma.user.update({ where: { id: sellerId }, data: { status: 'BLOCKED' } });
    const customer = await loginCustomerApp(MOBILE); // the customer app is unaffected
    expect(customer.userId).not.toBe(sellerId);
    await prisma.user.update({ where: { id: customer.userId }, data: { status: 'BLOCKED' } });
    expect((await sellerLogin('asha@store.test', SELLER_PASSWORD)).status).not.toBe(200); // the blocked seller stays blocked
  });
});

describe('duplicates of the SAME account type are still impossible', () => {
  it('a second seller registration for the number is refused; a second customer registration is refused; OTP sign-in never duplicates', async () => {
    expect((await sellerSignup()).status).toBe(201);
    const dupSeller = await sellerSignup({ email: 'other@store.test', businessName: 'Second Store' });
    expect(dupSeller.status).toBe(409);
    expect(expectError(dupSeller.body).code).toBe(ErrorCode.MOBILE_ALREADY_REGISTERED);

    const first = await api().post('/api/v1/auth/signup').send({ fullName: 'Asha', email: 'asha@cust.test', password: CUSTOMER_PASSWORD, mobile: MOBILE });
    expect(first.status).toBe(201); // the seller account does not block the customer
    const dupCustomer = await api().post('/api/v1/auth/signup').send({ fullName: 'Asha', email: 'asha2@cust.test', password: CUSTOMER_PASSWORD, mobile: MOBILE });
    expect(expectError(dupCustomer.body).code).toBe(ErrorCode.MOBILE_ALREADY_REGISTERED);

    await loginCustomerApp(MOBILE);
    await loginCustomerApp(MOBILE);
    expect(await prisma.user.count({ where: { mobile: MOBILE, role: UserRole.CUSTOMER } })).toBe(1);
    expect(await prisma.user.count({ where: { mobile: MOBILE, role: { not: UserRole.CUSTOMER } } })).toBe(1);
  });

  it('an email is unique within each account type', async () => {
    expect((await sellerSignup()).status).toBe(201);
    const sameEmailSeller = await sellerSignup({ mobile: '9876500088', businessName: 'Other Store' });
    expect(expectError(sameEmailSeller.body).code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);

    expect((await api().post('/api/v1/auth/signup').send({ fullName: 'Asha', email: 'shared@cust.test', password: CUSTOMER_PASSWORD, mobile: '9876500077' })).status).toBe(201);
    const sameEmailCustomer = await api().post('/api/v1/auth/signup').send({ fullName: 'Bina', email: 'SHARED@cust.test', password: CUSTOMER_PASSWORD, mobile: '9876500066' });
    expect(expectError(sameEmailCustomer.body).code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);
  });

  it('the database itself enforces one account per type per number (and per email)', async () => {
    const create = (role: UserRole, mobile = MOBILE, email: string | null = null) => prisma.user.create({ data: { mobile, role, fullName: 'X', email } });
    await create(UserRole.CUSTOMER);
    await create(UserRole.SELLER_OWNER); // customer + partner: allowed
    await expect(create(UserRole.CUSTOMER)).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(create(UserRole.SELLER_MANAGER)).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(create(UserRole.ADMIN)).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError); // staff share the partner slot

    await create(UserRole.CUSTOMER, '9876500011', 'same@both.test');
    await create(UserRole.SELLER_OWNER, '9876500012', 'Same@Both.test'); // different types: allowed
    await expect(create(UserRole.CUSTOMER, '9876500013', 'SAME@both.test')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(create(UserRole.STAFF, '9876500014', 'same@BOTH.test')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('two first sign-ins to the customer app at once create one customer account', async () => {
    await sellerSignup();
    const send = await api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE }).expect(200);
    const otp = expectSuccess<{ devOtp: string }>(send.body).data.devOtp;
    // Both race the same code: whatever each one answers, there is ONE customer account.
    await Promise.all([api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp }), api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp })]);
    expect(await prisma.user.count({ where: { mobile: MOBILE, role: UserRole.CUSTOMER } })).toBe(1);
  });
});

describe('seller registration never asks for a code; existing data stays reachable', () => {
  it('no OTP field is accepted, and registration needs no OTP call at all', async () => {
    const withCode = await sellerSignup({ otp: '123456' });
    expect(withCode.status).toBe(400); // the strict body has no such field
    expect(await prisma.user.count()).toBe(0);
    expect((await sellerSignup()).status).toBe(201); // nothing was sent to /auth/send-otp
  });

  it('an older account that already shops under a seller role keeps serving the customer app — no duplicate, history reachable', async () => {
    // Before accounts were separated: one SELLER_OWNER account that also shopped.
    const legacy = await prisma.user.create({ data: { mobile: MOBILE, role: UserRole.SELLER_OWNER, fullName: 'Legacy' } });
    await seedAddress(legacy.id);
    const session = await loginCustomerApp(MOBILE);
    expect(session.userId).toBe(legacy.id);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
  });

  it('seller cleanup never turns a seller account into a second customer account for the same number', async () => {
    const sellerId = tokenOf((await sellerSignup({ businessName: 'Gift Store' })).body).user.id;
    await prisma.seller.updateMany({ data: { code: 'GIFTSTORE' } });
    await loginCustomerApp(MOBILE); // the number has its own, separate customer account
    await seedAddress(sellerId); // ...and the seller account has shopping history of its own
    const plan = await planSellerCleanup(['GIFTSTORE']);
    expect(plan.entries[0]!.staff).toEqual([expect.objectContaining({ decision: 'MEMBERSHIP_REMOVED' })]);
  });
});
