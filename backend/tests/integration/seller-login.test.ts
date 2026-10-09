/**
 * Seller authentication — EMAIL + PASSWORD only.
 *
 *   - Sellers sign in at POST /auth/seller/login with their email and password.
 *     A mobile OTP opens only a CUSTOMER-app session — for a seller owner too
 *     (sellers may shop) — never a Seller Panel session.
 *   - "Forgot Password?" emails a single-use, expiring link; the seller sets a
 *     new password; every old session ends; the old password stops working.
 *   - Admin sees a seller's login EMAIL only. No admin route issues, resets,
 *     changes or reveals a seller password (the old temporary-password route
 *     is gone); admin may set a login email once for an owner that has none.
 *   - Lifecycle gating and seller isolation are unchanged after sign-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword, sha256 } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import { emailProvider } from '../../src/infra/email';
import * as configService from '../../src/modules/configuration/configuration.service';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };
const SELLER_PASSWORD = 'MyShop@2026';
const NEW_PASSWORD = 'BetterShop@2027';

async function loginAdmin(role: UserRole = UserRole.ADMIN, email = ADMIN.email): Promise<string> {
  await prisma.user.create({
    data: { mobile: `00000000${role === UserRole.ADMIN ? '01' : '02'}`, email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

/** Seller self-signup (an APPLICATION_PENDING seller) with email + password. */
async function signupSeller(mobile: string, email: string, password = SELLER_PASSWORD): Promise<string> {
  const res = await api()
    .post('/api/v1/auth/seller/signup')
    .send({ fullName: 'Shop Owner', mobile, email, password, businessName: `Shop ${mobile}`, sellerType: 'GROCERY' })
    .expect(201);
  return expectSuccess<{ sellerId: string }>(res.body).data.sellerId;
}

/** Admin-created seller: its owner account has a mobile only — no email, no password. */
async function createSellerByAdmin(adminToken: string, name: string, ownerMobile: string): Promise<string> {
  const res = await api()
    .post('/api/v1/admin/sellers')
    .set('Authorization', bearer(adminToken))
    .send({ name, sellerType: 'GROCERY', addressLine: 'Test Address', city: 'Sikar', state: 'Rajasthan', pincode: '332001', latitude: 27.62, longitude: 75.14, ownerMobile, ownerFullName: `${name} Owner` })
    .expect(201);
  return expectSuccess<{ sellerId: string }>(res.body).data.sellerId;
}

const sellerLogin = (email: string, password: string) => api().post('/api/v1/auth/seller/login').send({ email, password });
const forgot = (email: string) => api().post('/api/v1/auth/seller/forgot-password').send({ email });
const reset = (token: string, newPassword: string) => api().post('/api/v1/auth/seller/reset-password').send({ token, newPassword });

async function sellerTokens(email: string, password = SELLER_PASSWORD) {
  return expectSuccess<{ tokens: { accessToken: string; refreshToken: string }; user: { id: string; role: string } }>(
    (await sellerLogin(email, password).expect(200)).body,
  ).data;
}

/** Every email "sent" in this test (the console provider is replaced by this spy). */
let sentEmails: { to: string; subject: string; text: string }[] = [];

function resetTokenFromLastEmail(to: string): string {
  const message = [...sentEmails].reverse().find((m) => m.to === to);
  if (!message) throw new Error(`no email sent to ${to}`);
  const match = /reset-password\?token=([^\s]+)/.exec(message.text);
  if (!match) throw new Error('no reset link in the email');
  return decodeURIComponent(match[1]!);
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  sentEmails = [];
  vi.spyOn(emailProvider, 'send').mockImplementation(async (input) => {
    sentEmails.push({ to: input.to, subject: input.subject, text: input.text });
    return { messageId: 'test', delivered: true };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('seller sign-in — email + password only', () => {
  it('signs a seller in with its email and password; the lifecycle still decides what opens', async () => {
    await signupSeller('9400000101', 'shop101@example.test');

    const session = await sellerTokens('SHOP101@example.test'); // email in any case
    expect(session.user.role).toBe(UserRole.SELLER_OWNER);

    // Signed in, but only an APPLICATION_PENDING seller: status yes, operations no.
    await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(session.tokens.accessToken)).expect(200);
    const orders = await api().get('/api/v1/seller/orders').set('Authorization', bearer(session.tokens.accessToken));
    expect(orders.status).toBe(403);
    expect(expectError(orders.body).code).toBe(ErrorCode.SELLER_ACCOUNT_NOT_ACTIVE);
  });

  it('refuses a wrong password, an unknown email, and non-seller accounts — with one identical error', async () => {
    await signupSeller('9400000102', 'shop102@example.test');
    await loginAdmin();
    await api().post('/api/v1/auth/signup').send({ fullName: 'A Customer', email: 'customer@example.test', password: 'Customer@123', mobile: '9400000199' }).expect(201);

    const attempts = [
      await sellerLogin('shop102@example.test', 'WrongPass@1'),
      await sellerLogin('nobody@example.test', SELLER_PASSWORD),
      await sellerLogin(ADMIN.email, ADMIN.password),
      await sellerLogin('customer@example.test', 'Customer@123'),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(expectError(res.body).code).toBe(ErrorCode.INVALID_CREDENTIALS);
    }
    expect(new Set(attempts.map((res) => JSON.stringify(expectError(res.body).message))).size).toBe(1);
  });

  it("a seller owner's mobile OTP opens the CUSTOMER app only — never the Seller Panel; customers unchanged", async () => {
    const sellerId = await signupSeller('9400000103', 'shop103@example.test');
    const owner = await prisma.sellerStaff.findFirstOrThrow({ where: { sellerId } });
    const usersBefore = await prisma.user.count();

    const sent = await api().post('/api/v1/auth/send-otp').send({ mobile: '9400000103' }).expect(200);
    const otp = expectSuccess<{ devOtp: string }>(sent.body).data.devOtp;
    const verified = await api().post('/api/v1/auth/verify-otp').send({ mobile: '9400000103', otp });
    expect(verified.status).toBe(200);
    const session = expectSuccess<{ user: { id: string; role: string }; tokens: { accessToken: string } }>(verified.body).data;
    // The SAME account — no customer duplicate is created for the seller.
    expect(session.user.id).toBe(owner.userId);
    expect(await prisma.user.count()).toBe(usersBefore);
    // Stored as a customer-app session.
    expect(await prisma.refreshToken.findFirstOrThrow({ where: { userId: owner.userId }, orderBy: { createdAt: 'desc' } })).toMatchObject({ scope: 'CUSTOMER' });

    // It shops like a customer…
    await api().get('/api/v1/cart').set('Authorization', bearer(session.tokens.accessToken)).expect(200);
    // …and can never open the Seller Panel or Admin Panel.
    for (const path of ['/api/v1/seller/lifecycle', '/api/v1/seller/orders', '/api/v1/admin/orders']) {
      const res = await api().get(path).set('Authorization', bearer(session.tokens.accessToken));
      expect(res.status).toBe(403);
      expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
    }
    // The Seller Panel login (email + password) is unchanged.
    const panel = expectSuccess<{ tokens: { accessToken: string } }>((await sellerLogin('shop103@example.test', SELLER_PASSWORD).expect(200)).body).data;
    await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(panel.tokens.accessToken)).expect(200);

    // Customer OTP login is unchanged: a new number signs up, an existing customer signs in.
    for (const expectNew of [true, false]) {
      await cache.clear(); // OTP resend cooldown, not under test here
      const customerOtp = expectSuccess<{ devOtp: string }>((await api().post('/api/v1/auth/send-otp').send({ mobile: '9400000198' }).expect(200)).body).data.devOtp;
      const customer = await api().post('/api/v1/auth/verify-otp').send({ mobile: '9400000198', otp: customerOtp });
      expect(customer.status).toBe(expectNew ? 201 : 200); // a first OTP login creates the account
      const data = expectSuccess<{ user: { role: string; isNewUser?: boolean }; tokens: { accessToken: string } }>(customer.body).data;
      expect(data.user.role).toBe(UserRole.CUSTOMER);
      expect(Boolean(data.user.isNewUser)).toBe(expectNew);
    }
  });

  it('refuses a seller account whose membership was revoked', async () => {
    const sellerId = await signupSeller('9400000104', 'shop104@example.test');
    await prisma.sellerStaff.updateMany({ where: { sellerId }, data: { isActive: false } });
    expect((await sellerLogin('shop104@example.test', SELLER_PASSWORD)).status).toBe(401);
  });

  it('keeps sellers isolated: the seller id comes from the session, never from X-Seller-Id; no admin routes', async () => {
    const a = await signupSeller('9400000105', 'shopa@example.test');
    const b = await signupSeller('9400000106', 'shopb@example.test');
    const token = (await sellerTokens('shopb@example.test')).tokens.accessToken;

    for (const path of ['/api/v1/admin/orders', '/api/v1/admin/sellers', `/api/v1/admin/sellers/${a}/login-credentials`]) {
      expect((await api().get(path).set('Authorization', bearer(token))).status).toBe(403);
    }
    const spoof = await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(token)).set('X-Seller-Id', a).expect(200);
    expect(expectSuccess<{ sellerId: string }>(spoof.body).data.sellerId).toBe(b);
  });
});

/* -------------------------------------------------------------------------- */

describe('Forgot Password', () => {
  it('answers every email identically (no account enumeration); only a seller account gets a link', async () => {
    await signupSeller('9400000111', 'shop111@example.test');
    await loginAdmin();
    await api().post('/api/v1/auth/signup').send({ fullName: 'A Customer', email: 'buyer@example.test', password: 'Customer@123', mobile: '9400000197' }).expect(201);

    const responses = [
      await forgot('shop111@example.test'),
      await forgot('nobody@example.test'),
      await forgot(ADMIN.email),
      await forgot('buyer@example.test'),
    ];
    for (const res of responses) expect(res.status).toBe(200);
    expect(new Set(responses.map((res) => JSON.stringify(res.body.data))).size).toBe(1);

    expect(sentEmails.map((m) => m.to)).toEqual(['shop111@example.test']);
    expect(await prisma.passwordResetToken.count()).toBe(1);
    // A malformed email is a plain validation error, like any form.
    expect((await forgot('not-an-email')).status).toBe(400);
  });

  it('resets the password: the new one works, the old one does not, and every old session ends', async () => {
    const sellerId = await signupSeller('9400000112', 'shop112@example.test');
    const before = await sellerTokens('shop112@example.test');

    await forgot('shop112@example.test').expect(200);
    const token = resetTokenFromLastEmail('shop112@example.test');
    await reset(token, NEW_PASSWORD).expect(200);

    await sellerTokens('shop112@example.test', NEW_PASSWORD);
    expect((await sellerLogin('shop112@example.test', SELLER_PASSWORD)).status).toBe(401);
    // The session from before the reset is gone.
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: before.tokens.refreshToken })).status).toBe(401);

    // Still the same seller, still gated by its lifecycle.
    const after = (await sellerTokens('shop112@example.test', NEW_PASSWORD)).tokens.accessToken;
    const lifecycle = await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(after)).expect(200);
    expect(expectSuccess<{ sellerId: string; lifecycleStatus: string }>(lifecycle.body).data).toMatchObject({
      sellerId,
      lifecycleStatus: 'APPLICATION_PENDING',
    });
    const status = await api().get('/api/v1/auth/password-status').set('Authorization', bearer(after)).expect(200);
    expect(expectSuccess<{ passwordChangeRequired: boolean }>(status.body).data.passwordChangeRequired).toBe(false);
  });

  it('a reset link works once; a newer link replaces an older one', async () => {
    await signupSeller('9400000113', 'shop113@example.test');

    await forgot('shop113@example.test').expect(200);
    const older = resetTokenFromLastEmail('shop113@example.test');
    await forgot('shop113@example.test').expect(200);
    const newer = resetTokenFromLastEmail('shop113@example.test');
    expect(newer).not.toBe(older);

    expect((await reset(older, NEW_PASSWORD)).status).toBe(400);
    await reset(newer, NEW_PASSWORD).expect(200);
    const reused = await reset(newer, 'Another@2028');
    expect(reused.status).toBe(400);
    expect(expectError(reused.body).message).toMatch(/invalid, already used or expired/);
    await sellerTokens('shop113@example.test', NEW_PASSWORD);
  });

  it('an expired link fails; a weak new password is refused without spending the link', async () => {
    await signupSeller('9400000114', 'shop114@example.test');
    await forgot('shop114@example.test').expect(200);
    const token = resetTokenFromLastEmail('shop114@example.test');

    expect((await reset(token, 'short')).status).toBe(400);
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await reset(token, NEW_PASSWORD)).status).toBe(400);
    await sellerTokens('shop114@example.test'); // the old password is unchanged
  });

  it('an admin-created seller sets its own first password through Forgot Password', async () => {
    const admin = await loginAdmin();
    const sellerId = await createSellerByAdmin(admin, 'Admin Made Store', '9400000115');

    await api().put(`/api/v1/admin/sellers/${sellerId}/login-email`).set('Authorization', bearer(admin)).send({ email: 'madestore@example.test' }).expect(200);
    // No password was created by that: sign-in is impossible until the seller sets one.
    expect((await sellerLogin('madestore@example.test', SELLER_PASSWORD)).status).toBe(401);

    await forgot('madestore@example.test').expect(200);
    await reset(resetTokenFromLastEmail('madestore@example.test'), NEW_PASSWORD).expect(200);
    await sellerTokens('madestore@example.test', NEW_PASSWORD);
  });
});

/* -------------------------------------------------------------------------- */

describe('admin and seller credentials', () => {
  it('admin sees the seller login email — never a password, a hash or password state', async () => {
    const admin = await loginAdmin();
    const sellerId = await signupSeller('9400000121', 'shop121@example.test');

    const res = await api().get(`/api/v1/admin/sellers/${sellerId}/login-credentials`).set('Authorization', bearer(admin)).expect(200);
    const data = expectSuccess<Record<string, unknown>>(res.body).data;
    expect(Object.keys(data).sort()).toEqual(['email', 'lastLoginAt', 'ownerName', 'sellerId']);
    expect(data['email']).toBe('shop121@example.test');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toContain('$2'); // no bcrypt hash

    // The seller detail and onboarding views carry no password data either.
    for (const path of [`/api/v1/admin/sellers/${sellerId}`, `/api/v1/admin/sellers/${sellerId}/onboarding/summary`]) {
      const view = await api().get(path).set('Authorization', bearer(admin)).expect(200);
      expect(JSON.stringify(view.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    }
  });

  it('admin cannot issue, reset, change or reveal a seller password — and cannot take over the login email', async () => {
    const admin = await loginAdmin();
    const sellerId = await signupSeller('9400000122', 'shop122@example.test');
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'shop122@example.test' } });

    // The former temporary-password route is gone, in every verb.
    for (const method of ['post', 'put', 'patch'] as const) {
      const res = await api()[method](`/api/v1/admin/sellers/${sellerId}/login-credentials`).set('Authorization', bearer(admin)).send({ email: 'shop122@example.test', password: 'Hijack@123' });
      expect(res.status, method).toBe(404);
    }
    // Setting an email over an existing one would allow a takeover via reset — refused.
    const takeover = await api().put(`/api/v1/admin/sellers/${sellerId}/login-email`).set('Authorization', bearer(admin)).send({ email: 'attacker@example.test' });
    expect(takeover.status).toBe(409);
    // Admin's own change-password only ever changes the admin's own password.
    await api().post('/api/v1/auth/change-password').set('Authorization', bearer(admin)).send({ currentPassword: ADMIN.password, newPassword: 'NewAdmin@456' }).expect(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.email).toBe('shop122@example.test');
    expect(after.passwordHash).toBe(owner.passwordHash);
    await sellerTokens('shop122@example.test');

    // Login email: SELLER_MANAGE only — STAFF and sellers are refused.
    const staff = await loginAdmin(UserRole.STAFF, 'staff@adione.test');
    const sellerToken = (await sellerTokens('shop122@example.test')).tokens.accessToken;
    for (const token of [staff, sellerToken]) {
      expect((await api().get(`/api/v1/admin/sellers/${sellerId}/login-credentials`).set('Authorization', bearer(token))).status).toBe(403);
      expect((await api().put(`/api/v1/admin/sellers/${sellerId}/login-email`).set('Authorization', bearer(token)).send({ email: 'x@example.test' })).status).toBe(403);
    }
  });

  it('the seller changes its own password after login; other sessions end', async () => {
    await signupSeller('9400000124', 'shop124@example.test');
    const first = await sellerTokens('shop124@example.test');
    const second = await sellerTokens('shop124@example.test');

    const changed = await api()
      .post('/api/v1/auth/change-password')
      .set('Authorization', bearer(second.tokens.accessToken))
      .send({ currentPassword: SELLER_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);
    expect(JSON.stringify(changed.body)).not.toContain(NEW_PASSWORD);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: first.tokens.refreshToken })).status).toBe(401);
    expect((await sellerLogin('shop124@example.test', SELLER_PASSWORD)).status).toBe(401);
    await sellerTokens('shop124@example.test', NEW_PASSWORD);
  });

  it('admin setting a first login email refuses one another account already uses (any case)', async () => {
    const admin = await loginAdmin();
    await signupSeller('9400000125', 'taken@example.test');
    const sellerId = await createSellerByAdmin(admin, 'No Email Store', '9400000126');

    const clash = await api().put(`/api/v1/admin/sellers/${sellerId}/login-email`).set('Authorization', bearer(admin)).send({ email: 'TAKEN@example.test' });
    expect(clash.status).toBe(400);
    expect(expectError(clash.body).message).toMatch(/already used/);
    const owner = await prisma.sellerStaff.findFirstOrThrow({ where: { sellerId }, include: { user: true } });
    expect(owner.user.email).toBeNull();
  });

  it('no plaintext password or reset token is stored, returned or audited', async () => {
    const admin = await loginAdmin();
    const sellerId = await createSellerByAdmin(admin, 'Leak Check Store', '9400000123');
    const bodies: unknown[] = [];
    bodies.push((await api().put(`/api/v1/admin/sellers/${sellerId}/login-email`).set('Authorization', bearer(admin)).send({ email: 'leak@example.test' }).expect(200)).body);
    bodies.push((await forgot('leak@example.test').expect(200)).body);
    const token = resetTokenFromLastEmail('leak@example.test');
    bodies.push((await reset(token, NEW_PASSWORD).expect(200)).body);
    bodies.push((await sellerLogin('leak@example.test', NEW_PASSWORD).expect(200)).body);
    bodies.push((await api().get(`/api/v1/admin/sellers/${sellerId}/login-credentials`).set('Authorization', bearer(admin)).expect(200)).body);

    for (const body of bodies) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(NEW_PASSWORD);
      expect(text).not.toContain(token);
    }
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'leak@example.test' } });
    expect(owner.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt, never plaintext
    const audit = JSON.stringify(await prisma.auditLog.findMany());
    expect(audit).not.toContain(NEW_PASSWORD);
    expect(audit).not.toContain(token);
    // Only the hash of the reset token is stored.
    const rows = await prisma.passwordResetToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});
