/**
 * Tasks 2.5 and 2.6 — email + password signup and login.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache, CacheKey } from '../../src/infra/cache';
import * as otpService from '../../src/modules/auth/otp.service';
import { hashPassword } from '../../src/common/crypto';

const SIGNUP = {
  fullName: 'Avinash Jat',
  email: 'avinash@example.com',
  password: 'Sikar@2026',
  mobile: '9876543210',
};

async function clearLimiters(): Promise<void> {
  const ids = [
    SIGNUP.email,
    SIGNUP.mobile,
    '::ffff:127.0.0.1',
    '127.0.0.1',
    'unknown',
    'other@example.com',
  ];
  for (const scope of [
    'login:email',
    'login:ip',
    'signup:ip',
    'signup:mobile',
    'admin:login:ip',
    'api:ip',
    'otp:mobile:hour',
    'otp:mobile:day',
    'otp:ip:hour',
    'otp:verify:ip',
  ]) {
    for (const id of ids) await cache.delete(CacheKey.rateLimit(scope, id));
  }
}

beforeEach(async () => {
  await truncateAll();
  await otpService.clearOtpState(SIGNUP.mobile);
  await clearLimiters();
});

describe('POST /auth/signup', () => {
  it('creates a customer and logs them straight in', async () => {
    const res = await api().post('/api/v1/auth/signup').send(SIGNUP);
    expect(res.status).toBe(201);

    const { user, tokens } = expectSuccess<{
      user: {
        id: string;
        fullName: string;
        email: string;
        mobile: string;
        role: string;
        mobileVerified: boolean;
        isNewUser?: boolean;
        referralCode: string | null;
      };
      tokens: { accessToken: string; refreshToken: string };
    }>(res.body).data;

    expect(user.fullName).toBe(SIGNUP.fullName);
    expect(user.email).toBe(SIGNUP.email);
    expect(user.mobile).toBe(SIGNUP.mobile);
    expect(user.role).toBe(UserRole.CUSTOMER);
    expect(user.isNewUser).toBe(true);
    expect(user.referralCode).toBeTruthy();
    expect(tokens.accessToken).toBeTruthy();

    // The token works immediately — no second login step.
    await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokens.accessToken))
      .expect(200);
  });

  it('marks the mobile number as UNVERIFIED', async () => {
    // Nobody proved the number belongs to the person signing up — they typed
    // it. The rider phones this number and COD depends on reaching someone,
    // so treating it as verified would be a real hole.
    const res = await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    expect(expectSuccess<{ user: { mobileVerified: boolean } }>(res.body).data.user
      .mobileVerified).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { mobile: SIGNUP.mobile } });
    expect(row.mobileVerifiedAt).toBeNull();
  });

  it('marks the mobile verified once the customer completes an OTP login', async () => {
    await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    await clearLimiters();

    const sent = await api()
      .post('/api/v1/auth/send-otp')
      .send({ mobile: SIGNUP.mobile })
      .expect(200);
    const otp = expectSuccess<{ devOtp?: string }>(sent.body).data.devOtp!;

    const verified = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ mobile: SIGNUP.mobile, otp })
      .expect(200);

    expect(expectSuccess<{ user: { mobileVerified: boolean } }>(verified.body).data.user
      .mobileVerified).toBe(true);

    // Still one account — OTP login found the existing user rather than
    // creating a duplicate.
    expect(await prisma.user.count()).toBe(1);
  });

  it('never stores the password in plaintext', async () => {
    await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    const row = await prisma.user.findUniqueOrThrow({ where: { mobile: SIGNUP.mobile } });

    expect(row.passwordHash).toBeTruthy();
    expect(row.passwordHash).not.toBe(SIGNUP.password);
    expect(row.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt
  });

  it('rejects a duplicate mobile number with a clear, actionable message', async () => {
    await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    await clearLimiters();

    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ ...SIGNUP, email: 'different@example.com' });

    expect(res.status).toBe(409);
    const error = expectError(res.body);
    // Unlike login, signup MUST say which field clashes — the user cannot
    // proceed otherwise, and the failure itself already discloses it.
    expect(error.code).toBe(ErrorCode.MOBILE_ALREADY_REGISTERED);
    expect(error.message).toMatch(/mobile number already exists/i);
  });

  it('rejects a duplicate email', async () => {
    await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    await clearLimiters();

    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ ...SIGNUP, mobile: '9876500099' });

    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);
  });

  it('treats email as case-insensitive', async () => {
    await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    await clearLimiters();

    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ ...SIGNUP, email: 'AVINASH@Example.COM', mobile: '9876500098' });

    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);
  });

  it('enforces the password policy with a field-level message', async () => {
    for (const [password, pattern] of [
      ['short1', /at least 8 characters/i],
      ['alllettershere', /must contain a number/i],
      ['12345678', /must contain a letter/i],
    ] as const) {
      await clearLimiters();
      const res = await api().post('/api/v1/auth/signup').send({ ...SIGNUP, password });
      expect(res.status, password).toBe(400);
      expect(expectError(res.body).message).toMatch(pattern);
    }
  });

  it('validates name, email and mobile', async () => {
    for (const patch of [
      { fullName: 'A' },
      { email: 'not-an-email' },
      { mobile: '12345' },
    ]) {
      await clearLimiters();
      const res = await api().post('/api/v1/auth/signup').send({ ...SIGNUP, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });

  it('normalises the mobile number before storing it', async () => {
    await api()
      .post('/api/v1/auth/signup')
      .send({ ...SIGNUP, mobile: '+91 98765 43210' })
      .expect(201);

    expect(await prisma.user.findUnique({ where: { mobile: '9876543210' } })).not.toBeNull();
  });

  it('rate-limits repeated signups from one source', async () => {
    // 5 per hour per IP. Creating accounts is free for an attacker and
    // expensive for us, so this is deliberately tight.
    for (let i = 0; i < 5; i += 1) {
      await api()
        .post('/api/v1/auth/signup')
        .send({ ...SIGNUP, email: `user${i}@example.com`, mobile: `98765000${10 + i}` });
    }

    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ ...SIGNUP, email: 'blocked@example.com', mobile: '9876500077' });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('POST /auth/login', () => {
  async function register(): Promise<void> {
    await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    await clearLimiters();
  }

  it('issues tokens for correct credentials', async () => {
    await register();

    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.email, password: SIGNUP.password })
      .expect(200);

    const { user, tokens } = expectSuccess<{
      user: { email: string; role: string };
      tokens: { accessToken: string; refreshToken: string };
    }>(res.body).data;

    expect(user.email).toBe(SIGNUP.email);
    expect(user.role).toBe(UserRole.CUSTOMER);

    await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokens.accessToken))
      .expect(200);
  });

  it('accepts the email in any case', async () => {
    await register();
    await api()
      .post('/api/v1/auth/login')
      .send({ email: 'Avinash@EXAMPLE.com', password: SIGNUP.password })
      .expect(200);
  });

  it('returns one identical error for unknown email and wrong password', async () => {
    await register();

    const wrongPassword = await api()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.email, password: 'WrongPassword9' });
    const unknownEmail = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: SIGNUP.password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);

    const a = expectError(wrongPassword.body);
    const b = expectError(unknownEmail.body);
    expect(a.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(a.code).toBe(b.code);
    // Identical wording, so the endpoint cannot be used to enumerate accounts.
    expect(a.message).toBe(b.message);
  });

  it('rejects an OTP-only account without leaking that it exists', async () => {
    // Account created by OTP has no password. The response must look exactly
    // like "no such account".
    const sent = await api()
      .post('/api/v1/auth/send-otp')
      .send({ mobile: SIGNUP.mobile })
      .expect(200);
    const otp = expectSuccess<{ devOtp?: string }>(sent.body).data.devOtp!;
    await api().post('/api/v1/auth/verify-otp').send({ mobile: SIGNUP.mobile, otp }).expect(201);
    await prisma.user.update({
      where: { mobile: SIGNUP.mobile },
      data: { email: SIGNUP.email },
    });
    await clearLimiters();

    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.email, password: 'AnyPassword1' });

    expect(res.status).toBe(401);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_CREDENTIALS);
  });

  it('refuses a blocked account', async () => {
    await register();
    await prisma.user.update({ where: { mobile: SIGNUP.mobile }, data: { status: 'BLOCKED' } });

    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.email, password: SIGNUP.password });

    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.ACCOUNT_BLOCKED);
  });

  it('rate-limits a dictionary attack on one account', async () => {
    await register();

    // 8 attempts per email per 15 minutes.
    for (let i = 0; i < 8; i += 1) {
      await api()
        .post('/api/v1/auth/login')
        .send({ email: SIGNUP.email, password: `Guess${i}abc` });
    }

    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.email, password: SIGNUP.password });

    // Even the CORRECT password is refused once the limit trips.
    expect(res.status).toBe(429);
    expect(expectError(res.body).message).toMatch(/too many login attempts/i);
  });

  it('validates the request body', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'nope', password: '' });
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe('POST /auth/admin/login vs /auth/login', () => {
  const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

  beforeEach(async () => {
    await prisma.user.create({
      data: {
        mobile: '0000000001',
        email: ADMIN.email,
        fullName: 'Test Owner',
        passwordHash: await hashPassword(ADMIN.password),
        role: UserRole.ADMIN,
      },
    });
    await clearLimiters();
    await cache.delete(CacheKey.rateLimit('login:email', ADMIN.email));
  });

  it('lets staff in through the admin endpoint', async () => {
    const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
    expect(expectSuccess<{ user: { role: string } }>(res.body).data.user.role).toBe(
      UserRole.ADMIN,
    );
  });

  it('keeps a customer out of the admin panel despite valid credentials', async () => {
    await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    await clearLimiters();

    // The general login accepts them...
    await api()
      .post('/api/v1/auth/login')
      .send({ email: SIGNUP.email, password: SIGNUP.password })
      .expect(200);

    await clearLimiters();

    // ...the admin endpoint does not.
    const res = await api()
      .post('/api/v1/auth/admin/login')
      .send({ email: SIGNUP.email, password: SIGNUP.password });

    expect(res.status).toBe(401);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_CREDENTIALS);
  });

  it('also lets staff use the general login endpoint', async () => {
    // Same credentials path; only the role restriction differs.
    const res = await api().post('/api/v1/auth/login').send(ADMIN).expect(200);
    expect(expectSuccess<{ user: { role: string } }>(res.body).data.user.role).toBe(
      UserRole.ADMIN,
    );
  });
});

/**
 * Regression cover for account deletion.
 *
 * The tombstone written into `users.mobile` must fit VarChar(15). It did not:
 * `deleted_` + 8 hex characters is 16, so every deletion failed with Prisma
 * P2000 and a 500. Nothing caught it because the endpoint had no test and the
 * mobile app had never been run against it.
 */
describe('DELETE /auth/me', () => {
  beforeEach(clearLimiters);

  it('erases the account and frees the mobile number for reuse', async () => {
    const signup = await api().post('/api/v1/auth/signup').send(SIGNUP).expect(201);
    const { tokens, user } = expectSuccess<{
      user: { id: string };
      tokens: { accessToken: string };
    }>(signup.body).data;

    await api()
      .delete('/api/v1/auth/me')
      .set('Authorization', bearer(tokens.accessToken))
      .expect(204);

    const row = await prisma.user.findUnique({ where: { id: user.id } });

    // The row survives so historical orders still resolve, but nothing
    // personal is left on it.
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.email).toBeNull();
    expect(row?.fullName).toBeNull();
    expect(row?.passwordHash).toBeNull();

    // The tombstone replaces the number, and must fit the column.
    expect(row?.mobile).not.toBe(SIGNUP.mobile);
    expect(row?.mobile.length).toBeLessThanOrEqual(15);
    expect(row?.mobile).toMatch(/^del_[0-9a-f]{11}$/);

    // Addresses are the most sensitive thing held, and must be gone.
    expect(await prisma.address.count({ where: { userId: user.id } })).toBe(0);
  });

  it('rejects an unauthenticated delete', async () => {
    await api().delete('/api/v1/auth/me').expect(401);
  });
});
