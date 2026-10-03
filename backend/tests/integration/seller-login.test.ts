/**
 * Admin-issued seller logins and the seller email + password sign-in.
 *
 * Sellers never register themselves: an admin creates the seller (owner with
 * a mobile only), then issues the owner's login — an email and a temporary
 * password shown once. The seller signs in at /auth/seller/login (the server
 * checks the account's own role and seller membership) and changes it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(role: UserRole = UserRole.ADMIN, email = ADMIN.email): Promise<string> {
  await prisma.user.create({
    data: { mobile: `00000000${role === UserRole.ADMIN ? '01' : '02'}`, email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function createSeller(adminToken: string, name: string, ownerMobile: string): Promise<string> {
  const res = await api()
    .post('/api/v1/admin/sellers')
    .set('Authorization', bearer(adminToken))
    .send({ name, sellerType: 'GROCERY', addressLine: 'Test Address', city: 'Sikar', state: 'Rajasthan', pincode: '332001', latitude: 27.62, longitude: 75.14, ownerMobile, ownerFullName: `${name} Owner` })
    .expect(201);
  return expectSuccess<{ sellerId: string }>(res.body).data.sellerId;
}

async function issueLogin(adminToken: string, sellerId: string, email: string) {
  const res = await api().post(`/api/v1/admin/sellers/${sellerId}/login-credentials`).set('Authorization', bearer(adminToken)).send({ email });
  return res;
}

const sellerLogin = (email: string, password: string) => api().post('/api/v1/auth/seller/login').send({ email, password });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('admin issues a seller login', () => {
  it('creates the seller without a password, then issues an email + temporary password shown once', async () => {
    const admin = await loginAdmin();
    const sellerId = await createSeller(admin, 'Login Seller', '9400000101');

    const before = await api().get(`/api/v1/admin/sellers/${sellerId}/login-credentials`).set('Authorization', bearer(admin)).expect(200);
    expect(expectSuccess<{ hasPassword: boolean; email: string | null }>(before.body).data).toMatchObject({ hasPassword: false, email: null });

    const issued = await issueLogin(admin, sellerId, 'Seller@Example.test');
    expect(issued.status).toBe(200);
    expect(issued.headers['cache-control']).toBe('no-store');
    const data = expectSuccess<{ email: string; temporaryPassword: string; passwordChangeRequired: boolean; ownerUserId: string }>(issued.body).data;
    expect(data.email).toBe('seller@example.test');
    expect(data.temporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{14}$/);
    expect(data.passwordChangeRequired).toBe(true);

    // Stored only as a hash; never returned again; audited without the password.
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: data.ownerUserId } });
    expect(owner.passwordHash).not.toContain(data.temporaryPassword);
    const again = await api().get(`/api/v1/admin/sellers/${sellerId}/login-credentials`).set('Authorization', bearer(admin)).expect(200);
    expect(JSON.stringify(again.body)).not.toContain(data.temporaryPassword);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller_login.credentials_issued', entityId: data.ownerUserId } });
    expect(JSON.stringify(audit)).not.toContain(data.temporaryPassword);
  });

  it('refuses an email another account already uses (case-insensitive)', async () => {
    const admin = await loginAdmin();
    const a = await createSeller(admin, 'Seller A', '9400000102');
    const b = await createSeller(admin, 'Seller B', '9400000103');
    expect((await issueLogin(admin, a, 'same@example.test')).status).toBe(200);
    const clash = await issueLogin(admin, b, 'SAME@example.test');
    expect(clash.status).toBe(400);
    expect(expectError(clash.body).message).toMatch(/already used/i);
  });

  it('is admin-only: STAFF (no SELLER_MANAGE) and sellers are refused', async () => {
    const admin = await loginAdmin();
    const sellerId = await createSeller(admin, 'Guarded Seller', '9400000104');
    const staff = await loginAdmin(UserRole.STAFF, 'staff@adione.test');
    expect((await issueLogin(staff, sellerId, 'x@example.test')).status).toBe(403);
    const issued = expectSuccess<{ temporaryPassword: string }>((await issueLogin(admin, sellerId, 'guarded@example.test')).body).data;
    const seller = expectSuccess<{ tokens: { accessToken: string } }>((await sellerLogin('guarded@example.test', issued.temporaryPassword)).body).data;
    expect((await issueLogin(seller.tokens.accessToken, sellerId, 'other@example.test')).status).toBe(403);
  });
});

describe('seller sign-in', () => {
  it('signs a seller in, asks for a password change, and the change ends other sessions', async () => {
    const admin = await loginAdmin();
    const sellerId = await createSeller(admin, 'Flow Seller', '9400000105');
    const temp = expectSuccess<{ temporaryPassword: string }>((await issueLogin(admin, sellerId, 'flow@example.test')).body).data.temporaryPassword;

    const res = await sellerLogin('flow@example.test', temp).expect(200);
    const login = expectSuccess<{ user: { role: string }; tokens: { accessToken: string; refreshToken: string }; passwordChangeRequired: boolean }>(res.body).data;
    expect(login.user.role).toBe(UserRole.SELLER_OWNER);
    expect(login.passwordChangeRequired).toBe(true);
    const own = await api().get('/api/v1/seller/onboarding').set('Authorization', bearer(login.tokens.accessToken)).expect(200);
    expect(expectSuccess<{ sellerId: string }>(own.body).data.sellerId).toBe(sellerId);

    // A wrong current password is a 400 — the session itself is fine.
    const wrong = await api().post('/api/v1/auth/change-password').set('Authorization', bearer(login.tokens.accessToken)).send({ currentPassword: 'nope-1234', newPassword: 'MyShop2026x' });
    expect(wrong.status).toBe(400);

    const changed = await api().post('/api/v1/auth/change-password').set('Authorization', bearer(login.tokens.accessToken)).send({ currentPassword: temp, newPassword: 'MyShop2026x' }).expect(200);
    const fresh = expectSuccess<{ tokens: { accessToken: string } }>(changed.body).data.tokens.accessToken;
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: login.tokens.refreshToken })).status).toBe(401);
    const status = await api().get('/api/v1/auth/password-status').set('Authorization', bearer(fresh)).expect(200);
    expect(expectSuccess(status.body).data).toEqual({ hasPassword: true, passwordChangeRequired: false });
    expect((await sellerLogin('flow@example.test', temp)).status).toBe(401);
    expect((await sellerLogin('flow@example.test', 'MyShop2026x')).status).toBe(200);
  });

  it('refuses admins, customers, unknown emails and wrong passwords with one identical error', async () => {
    const admin = await loginAdmin();
    const sellerId = await createSeller(admin, 'Refusal Seller', '9400000106');
    const temp = expectSuccess<{ temporaryPassword: string }>((await issueLogin(admin, sellerId, 'refusal@example.test')).body).data.temporaryPassword;
    await prisma.user.create({ data: { mobile: '9400000107', email: 'customer@example.test', fullName: 'Customer', passwordHash: await hashPassword('Customer123'), role: UserRole.CUSTOMER } });

    const attempts = [
      await sellerLogin(ADMIN.email, ADMIN.password),
      await sellerLogin('customer@example.test', 'Customer123'),
      await sellerLogin('nobody@example.test', 'Whatever123'),
      await sellerLogin('refusal@example.test', 'Wrong12345'),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(expectError(res.body).code).toBe(ErrorCode.INVALID_CREDENTIALS);
    }
    expect(new Set(attempts.map((r) => expectError(r.body).message)).size).toBe(1);
    // …and seller credentials cannot open the admin panel.
    const onAdmin = await api().post('/api/v1/auth/admin/login').send({ email: 'refusal@example.test', password: temp });
    expect(onAdmin.status).toBe(401);
  });

  it('refuses a seller account whose membership was revoked', async () => {
    const admin = await loginAdmin();
    const sellerId = await createSeller(admin, 'Revoked Seller', '9400000108');
    const temp = expectSuccess<{ temporaryPassword: string }>((await issueLogin(admin, sellerId, 'revoked@example.test')).body).data.temporaryPassword;
    await prisma.sellerStaff.updateMany({ where: { sellerId }, data: { isActive: false } });
    expect((await sellerLogin('revoked@example.test', temp)).status).toBe(401);
  });

  it('keeps sellers isolated: no admin routes, never another seller’s data (X-Seller-Id cannot switch)', async () => {
    const admin = await loginAdmin();
    const a = await createSeller(admin, 'Isolated A', '9400000109');
    const b = await createSeller(admin, 'Isolated B', '9400000110');
    const tempB = expectSuccess<{ temporaryPassword: string }>((await issueLogin(admin, b, 'isob@example.test')).body).data.temporaryPassword;
    const token = expectSuccess<{ tokens: { accessToken: string } }>((await sellerLogin('isob@example.test', tempB)).body).data.tokens.accessToken;

    for (const path of ['/api/v1/admin/orders', '/api/v1/admin/sellers', `/api/v1/admin/sellers/${a}/login-credentials`]) {
      expect((await api().get(path).set('Authorization', bearer(token))).status).toBe(403);
    }
    const spoof = await api().get('/api/v1/seller/onboarding').set('Authorization', bearer(token)).set('X-Seller-Id', a).expect(200);
    expect(expectSuccess<{ sellerId: string }>(spoof.body).data.sellerId).toBe(b);
  });
});
