/**
 * Seller self-signup and an already-used mobile number: the number is
 * normalised once (+91, spaces, a leading 0), and a refusal names the ACTUAL
 * conflicting PARTNER account — seller, rejected application, former seller,
 * staff or blocked — instead of a generic "already exists". The number's
 * CUSTOMER (shopping app) account is a separate account and never a conflict.
 * Concurrent signups for one number create exactly one seller.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, SellerLifecycleStatus, SellerType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedAddress } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { hashPassword } from '../../src/common/crypto';
import { findMobileConflict } from '../../src/modules/sellers/seller-mobile-conflict';

const MOBILE = '8690530973';

let counter = 0;
function signup(mobile: string, overrides: Record<string, unknown> = {}) {
  counter += 1;
  return api()
    .post('/api/v1/auth/seller/signup')
    .send({
      fullName: 'Test Owner',
      mobile,
      email: `owner${counter}@adione.test`,
      password: 'Seller@12345',
      businessName: `Test Store ${counter}`,
      sellerType: SellerType.GROCERY,
      ...overrides,
    });
}

function conflictOf(body: unknown): string | undefined {
  return expectError(body).details?.find((detail) => detail.field === 'mobile')?.['conflict'] as string | undefined;
}

const partnerAccount = () => prisma.user.findFirstOrThrow({ where: { mobile: MOBILE, role: { not: UserRole.CUSTOMER } } });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await otpService.clearOtpState(MOBILE);
});

describe('seller signup — which PARTNER account already uses the number', () => {
  it('a free number signs up, whatever format it is typed in, and is stored canonically', async () => {
    const res = await signup('+91 86905-30973');
    expect(res.status).toBe(201);
    expect((await partnerAccount()).role).toBe(UserRole.SELLER_OWNER);
  });

  it('a number with a CUSTOMER account is NOT a conflict, in any format — the seller gets its own separate account', async () => {
    const customer = await loginAs(MOBILE); // the customer app's first OTP login creates the customer account
    expect((await findMobileConflict(prisma, MOBILE)).kind).toBe('NONE');
    const res = await signup('+91 86905 30973');
    expect(res.status).toBe(201);
    const seller = await partnerAccount();
    expect(seller.id).not.toBe(customer.userId);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).role).toBe(UserRole.CUSTOMER);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(2);
  });

  it('a number that already owns a seller is refused as a SELLER; a rejected application is told to resubmit', async () => {
    expect((await signup(MOBILE)).status).toBe(201);
    const again = await signup('08690530973');
    expect(again.status).toBe(409);
    expect(conflictOf(again.body)).toBe('SELLER');
    expect(expectError(again.body).message).toMatch(/already registered as a seller/);

    await prisma.seller.updateMany({ data: { lifecycleStatus: SellerLifecycleStatus.APPLICATION_REJECTED } });
    const rejected = await signup(MOBILE);
    expect(conflictOf(rejected.body)).toBe('SELLER');
    expect(expectError(rejected.body).message).toMatch(/correct and resubmit/);
  });

  it('a seller account whose store is gone is a FORMER_SELLER — reported, never deleted or reused silently', async () => {
    expect((await signup(MOBILE)).status).toBe(201);
    await prisma.seller.updateMany({ data: { deletedAt: new Date(), isActive: false } });
    const res = await signup(MOBILE);
    expect(conflictOf(res.body)).toBe('FORMER_SELLER');
    expect(expectError(res.body).message).toMatch(/Sign in to the Seller Panel/);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
    expect(await prisma.seller.count()).toBe(1);
  });

  it('a staff / delivery number is refused as STAFF', async () => {
    await prisma.user.create({ data: { mobile: MOBILE, fullName: 'Rider', role: UserRole.DELIVERY_AGENT } });
    const res = await signup(MOBILE);
    expect(conflictOf(res.body)).toBe('STAFF');
  });

  it('two signups racing for one number create exactly one seller; the loser gets the precise conflict', async () => {
    const [a, b] = await Promise.all([signup(MOBILE), signup(MOBILE)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(expectError(loser.body).code).toBe(ErrorCode.MOBILE_ALREADY_REGISTERED);
    expect(conflictOf(loser.body)).toBe('SELLER');
    expect(await prisma.seller.count()).toBe(1);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
  });

  it('the classifier looks at partner accounts only, and recognises a blocked one', async () => {
    expect((await findMobileConflict(prisma, MOBILE)).kind).toBe('NONE');
    await prisma.user.create({ data: { mobile: MOBILE, fullName: 'Shopper', role: UserRole.CUSTOMER, status: 'BLOCKED' } });
    expect((await findMobileConflict(prisma, MOBILE)).kind).toBe('NONE'); // a (even blocked) customer account is separate
    await prisma.user.create({ data: { mobile: MOBILE, fullName: 'Seller', role: UserRole.SELLER_OWNER, status: 'BLOCKED' } });
    expect((await findMobileConflict(prisma, MOBILE)).kind).toBe('BLOCKED');
  });
});

async function adminToken(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '9000000012', email: 'conflict-admin@adione.test', fullName: 'Admin', passwordHash: await hashPassword('TestAdmin@123'), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: 'conflict-admin@adione.test', password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const adminCreateBody = (ownerMobile: string) => ({
  name: 'Admin Created Store',
  sellerType: 'GROCERY',
  addressLine: 'Main Road',
  city: 'Sikar',
  state: 'Rajasthan',
  pincode: '332001',
  latitude: 27.62,
  longitude: 75.14,
  ownerMobile,
  ownerFullName: 'Store Owner',
});

describe('admin-created seller for a number that already has an account', () => {
  it('a CUSTOMER number: the owner gets a SEPARATE Seller Panel account — the customer account is untouched', async () => {
    const customer = await loginAs(MOBILE);
    const addressId = await seedAddress(customer.userId);

    const token = await adminToken();
    const res = await api().post('/api/v1/admin/sellers').set('Authorization', bearer(token)).send(adminCreateBody('+91 86905 30973'));
    expect(res.status).toBe(201);
    const created = expectSuccess<{ sellerId: string; ownerUserId: string; isNewOwnerAccount: boolean }>(res.body).data;
    expect(created.isNewOwnerAccount).toBe(true);
    expect(created.ownerUserId).not.toBe(customer.userId);

    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).role).toBe(UserRole.CUSTOMER);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: created.ownerUserId } })).role).toBe(UserRole.SELLER_OWNER);
    expect(await prisma.sellerStaff.count({ where: { userId: customer.userId } })).toBe(0);
    expect(await prisma.address.count({ where: { id: addressId, userId: customer.userId } })).toBe(1);

    expect(conflictOf((await signup(MOBILE)).body)).toBe('SELLER');
  });

  it('a BLOCKED partner account is never handed a store by an admin — refused, unchanged', async () => {
    await prisma.user.create({ data: { mobile: MOBILE, fullName: 'Seller', role: UserRole.SELLER_OWNER, status: 'BLOCKED' } });
    const token = await adminToken();
    const res = await api().post('/api/v1/admin/sellers').set('Authorization', bearer(token)).send(adminCreateBody(MOBILE));
    expect(res.status).toBe(400);
    expect(expectError(res.body).message).toMatch(/blocked account/);
    expect(await prisma.seller.count()).toBe(0);
    expect(await partnerAccount()).toMatchObject({ role: UserRole.SELLER_OWNER, status: 'BLOCKED' });
  });
});
