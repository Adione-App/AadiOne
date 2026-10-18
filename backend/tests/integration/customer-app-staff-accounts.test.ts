/**
 * Seller owners and admins in the CUSTOMER app.
 *
 *   - Any number may sign in to the customer app with an OTP — a seller
 *     owner's and an admin's too. The customer app uses the number's own
 *     CUSTOMER account (auth/account-type.ts): a SEPARATE account from the
 *     Seller / Admin Panel one, created on first sign-in and never merged
 *     with it. They shop with it: cart, checkout, their own orders.
 *   - That session is CUSTOMER-scoped: it never reaches a Seller Panel or
 *     Admin Panel API, and refreshing it does not change that.
 *   - The panels' email + password logins are unchanged and reach the panel
 *     account.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, PaymentMethod, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword, sha256 } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const SELLER_MOBILE = '9400000301';
const ADMIN = { mobile: '9400000302', email: 'admin302@example.test', password: 'AdminPass@2026' };

async function otpLogin(mobile: string) {
  const sent = await api().post('/api/v1/auth/send-otp').send({ mobile }).expect(200);
  const otp = expectSuccess<{ devOtp: string }>(sent.body).data.devOtp;
  const res = await api().post('/api/v1/auth/verify-otp').send({ mobile, otp });
  return {
    status: res.status,
    data: expectSuccess<{ user: { id: string; role: string; isNewUser?: boolean }; tokens: { accessToken: string; refreshToken: string } }>(res.body).data,
  };
}

async function createSellerOwner(): Promise<string> {
  const res = await api()
    .post('/api/v1/auth/seller/signup')
    .send({ fullName: 'Shop Owner', mobile: SELLER_MOBILE, email: 'shop301@example.test', password: 'MyShop@2026', businessName: 'Shop 301', sellerType: 'GROCERY' })
    .expect(201);
  return expectSuccess<{ user: { id: string } }>(res.body).data.user.id;
}

async function createAdmin(): Promise<string> {
  const admin = await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Admin With Phone', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  return admin.id;
}

async function expectForbidden(token: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const res = await api().get(path).set('Authorization', bearer(token));
    expect({ path, status: res.status }).toEqual({ path, status: 403 });
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  }
}

const MANAGEMENT = ['/api/v1/seller/lifecycle', '/api/v1/seller/orders', '/api/v1/admin/orders', '/api/v1/admin/sellers'];

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('customer-app OTP login for seller owners and admins', () => {
  it("a seller owner's number gets its own, separate CUSTOMER account — the seller account is untouched", async () => {
    const ownerId = await createSellerOwner();
    const ownerBefore = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    const { status, data } = await otpLogin(SELLER_MOBILE);

    expect(status).toBe(201);
    expect(data.user.isNewUser).toBe(true);
    expect(data.user.id).not.toBe(ownerId);
    expect(data.user.role).toBe(UserRole.CUSTOMER);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).toEqual(ownerBefore);
    await expectForbidden(data.tokens.accessToken, MANAGEMENT);

    // Signing in again reaches the SAME customer account — no duplicates.
    const again = await otpLogin(SELLER_MOBILE);
    expect(again.status).toBe(200);
    expect(again.data.user.id).toBe(data.user.id);
    expect(await prisma.user.count({ where: { mobile: SELLER_MOBILE } })).toBe(2);
  });

  it("an admin's number gets a separate CUSTOMER account; the Admin Panel login is unchanged", async () => {
    const adminId = await createAdmin();

    const { status, data } = await otpLogin(ADMIN.mobile);

    expect(status).toBe(201);
    expect(data.user.id).not.toBe(adminId);
    await expectForbidden(data.tokens.accessToken, MANAGEMENT);

    const panel = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
    const panelData = expectSuccess<{ user: { id: string }; tokens: { accessToken: string } }>(panel.body).data;
    expect(panelData.user.id).toBe(adminId);
    await api().get('/api/v1/admin/orders').set('Authorization', bearer(panelData.tokens.accessToken)).expect(200);
  });

  it('refreshing a customer-app session keeps it CUSTOMER-scoped', async () => {
    await createSellerOwner();
    const { data } = await otpLogin(SELLER_MOBILE);

    const refreshed = await api().post('/api/v1/auth/refresh').send({ refreshToken: data.tokens.refreshToken }).expect(200);
    const tokens = expectSuccess<{ tokens?: { accessToken: string }; accessToken?: string }>(refreshed.body).data;
    const accessToken = tokens.tokens?.accessToken ?? tokens.accessToken!;

    await expectForbidden(accessToken, MANAGEMENT);
    await api().get('/api/v1/cart').set('Authorization', bearer(accessToken)).expect(200);
    // Every token of THIS session (its rotation family) is CUSTOMER. The seller also has a FULL
    // Seller Panel session from signing up — a separate account and family, untouched.
    const opened = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(data.tokens.refreshToken) } });
    const family = await prisma.refreshToken.findMany({ where: { familyId: opened.familyId }, select: { scope: true } });
    expect(family.length).toBe(2); // the original and its rotation
    expect(new Set(family.map((row) => row.scope))).toEqual(new Set(['CUSTOMER']));
  });
});

describe('seller owners and admins shop with their CUSTOMER account', () => {
  for (const kind of ['seller owner', 'admin'] as const) {
    it(`${kind}: cart -> COD order -> the customer account's own order history`, async () => {
      const storeId = await seedStore();
      const product = await seedProduct(storeId, { pricePaise: 24900, mrpPaise: 28500, stockQty: 10 });
      const panelUserId = kind === 'seller owner' ? await createSellerOwner() : await createAdmin();
      const mobile = kind === 'seller owner' ? SELLER_MOBILE : ADMIN.mobile;
      const { data } = await otpLogin(mobile);
      const token = data.tokens.accessToken;
      const addressId = await seedAddress(data.user.id);

      await api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
      const placed = await api()
        .post('/api/v1/orders')
        .set('Authorization', bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ addressId, paymentMethod: PaymentMethod.COD });
      expect(placed.status).toBe(201);

      // The order belongs to the customer account — never to the panel account.
      const order = await prisma.order.findFirstOrThrow();
      expect(order.userId).toBe(data.user.id);
      expect(await prisma.order.count({ where: { userId: panelUserId } })).toBe(0);
      expect(await prisma.user.count({ where: { mobile, role: UserRole.CUSTOMER } })).toBe(1);

      const history = await api().get('/api/v1/orders').set('Authorization', bearer(token)).expect(200);
      expect(JSON.stringify(history.body)).toContain(order.orderNumber);
    });
  }
});
