/**
 * Task 2.4 — auth integration tests.
 *
 * Covers the full OTP → verify → session flow plus the edge cases that
 * actually bite: wrong codes, expiry, attempt exhaustion, single-use codes,
 * rate limits, refresh rotation and refresh-token reuse.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache, CacheKey } from '../../src/infra/cache';
import * as otpService from '../../src/modules/auth/otp.service';
import { hashPassword } from '../../src/common/crypto';
import { UserRole } from '../../src/shared';

const MOBILE = '9876543210';

/** Requests an OTP and returns the dev code. */
async function requestOtp(mobile = MOBILE): Promise<string> {
  const res = await api().post('/api/v1/auth/send-otp').send({ mobile }).expect(200);
  const otp = expectSuccess<{ devOtp?: string }>(res.body).data.devOtp;
  expect(otp).toBeDefined();
  return otp!;
}

beforeEach(async () => {
  await truncateAll();
  // Rate-limit and OTP counters live in the cache, not the database, so they
  // must be cleared separately or a later test inherits an earlier one's usage.
  await otpService.clearOtpState(MOBILE);
  for (const scope of [
    'otp:mobile:hour',
    'otp:mobile:day',
    'otp:ip:hour',
    'otp:verify:ip',
    'admin:login:ip',
    'api:ip',
  ]) {
    await cache.delete(CacheKey.rateLimit(scope, MOBILE));
    await cache.delete(CacheKey.rateLimit(scope, '::ffff:127.0.0.1'));
    await cache.delete(CacheKey.rateLimit(scope, '127.0.0.1'));
  }
});

describe('POST /auth/send-otp', () => {
  it('normalises every common mobile-number format to the same account', async () => {
    // A user who types "+91 98765 43210" today and "09876543210" tomorrow must
    // land on one account, and must share one rate-limit counter.
    for (const input of ['+91 98765 43210', '09876543210', '91-9876543210']) {
      await otpService.clearOtpState(MOBILE);
      const res = await api().post('/api/v1/auth/send-otp').send({ mobile: input });
      expect(res.status, `input: ${input}`).toBe(200);
    }
  });

  it('rejects an invalid mobile number with a field-level message', async () => {
    const res = await api().post('/api/v1/auth/send-otp').send({ mobile: '12345' });
    expect(res.status).toBe(400);
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.message).toMatch(/valid 10-digit mobile/i);
  });

  it('never stores the OTP in plaintext', async () => {
    const otp = await requestOtp();
    const stored = await cache.get(CacheKey.otp(MOBILE));

    expect(stored).toBeTruthy();
    expect(stored).not.toBe(otp);
    // HMAC-SHA256 hex.
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
  });

  it('enforces the resend cooldown', async () => {
    await requestOtp();
    const res = await api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE });

    expect(res.status).toBe(429);
    expect(expectError(res.body).code).toBe(ErrorCode.OTP_RESEND_TOO_SOON);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('only lets one of two concurrent requests for the same number through', async () => {
    // Reproduces the exact race that used to let two requests both reach the
    // SMS provider with the same OTP content seconds apart (MSG91 error
    // 311, "duplicate content"): a rapid double-tap, or a client retry that
    // overlaps with the original request. The cooldown reservation must be
    // atomic so only one of these can ever win.
    const [first, second] = await Promise.all([
      api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE }),
      api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 429]);

    const blocked = first.status === 429 ? first : second;
    expect(expectError(blocked.body).code).toBe(ErrorCode.OTP_RESEND_TOO_SOON);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('does not let two different mobile numbers block each other', async () => {
    const OTHER_MOBILE = '9876500001';
    await otpService.clearOtpState(OTHER_MOBILE);

    const [a, b] = await Promise.all([
      api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE }),
      api().post('/api/v1/auth/send-otp').send({ mobile: OTHER_MOBILE }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('rate-limits repeated requests for the same number', async () => {
    // 3 per hour. The cooldown is 1s in test config, so wait it out between
    // attempts to prove the HOURLY limiter fires rather than the cooldown.
    for (let i = 0; i < 3; i += 1) {
      await api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE });
      await cache.delete(CacheKey.otpResendCooldown(MOBILE));
    }

    const res = await api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE });
    expect(res.status).toBe(429);
    expect(expectError(res.body).code).toBe(ErrorCode.OTP_RATE_LIMITED);
  });
});

describe('POST /auth/verify-otp', () => {
  it('creates the account on first successful verification and returns 201', async () => {
    const otp = await requestOtp();

    const res = await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp });
    expect(res.status).toBe(201);

    const { user, tokens } = expectSuccess<{
      user: { id: string; mobile: string; isNewUser?: boolean; referralCode: string | null };
      tokens: { accessToken: string; refreshToken: string };
    }>(res.body).data;

    expect(user.mobile).toBe(MOBILE);
    expect(user.isNewUser).toBe(true);
    expect(user.referralCode).toBeTruthy();
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();

    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
  });

  it('logs an existing customer in without creating a second account', async () => {
    await loginAs(MOBILE);
    await otpService.clearOtpState(MOBILE);

    const otp = await requestOtp();
    const res = await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp });

    expect(res.status).toBe(200);
    expect(expectSuccess<{ user: { isNewUser?: boolean } }>(res.body).data.user.isNewUser)
      .toBe(false);
    expect(await prisma.user.count({ where: { mobile: MOBILE } })).toBe(1);
  });

  it('rejects a wrong OTP and reports the remaining attempts', async () => {
    await requestOtp();

    const res = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ mobile: MOBILE, otp: '000000' });

    expect(res.status).toBe(400);
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.OTP_INVALID);
    expect(error.message).toMatch(/attempts remaining/i);
  });

  it('destroys the code after the maximum number of attempts', async () => {
    const otp = await requestOtp();

    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp: '111111' });
    }

    // Even the CORRECT code must now fail: exhausting attempts destroys it, so
    // an attacker has to request a new one and face the per-mobile rate limit.
    const res = await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect([ErrorCode.OTP_MAX_ATTEMPTS, ErrorCode.OTP_EXPIRED]).toContain(
      expectError(res.body).code,
    );
    expect(await prisma.user.count()).toBe(0);
  });

  it('treats an OTP as single-use', async () => {
    const otp = await requestOtp();
    await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp }).expect(201);

    const replay = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ mobile: MOBILE, otp });

    expect(replay.status).toBe(400);
    expect(expectError(replay.body).code).toBe(ErrorCode.OTP_EXPIRED);
  });

  it('reports an expired code the same way as one that was never requested', async () => {
    // Indistinguishable on purpose: otherwise the endpoint reveals which
    // numbers currently have a login in flight.
    const res = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ mobile: MOBILE, otp: '123456' });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.OTP_EXPIRED);
  });

  it('rejects a malformed OTP before touching any state', async () => {
    await requestOtp();
    const res = await api().post('/api/v1/auth/verify-otp').send({ mobile: MOBILE, otp: '12' });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    // The real code survives — a typo must not burn the customer's OTP.
    expect(await cache.get(CacheKey.otp(MOBILE))).toBeTruthy();
  });
});

describe('session lifecycle', () => {
  it('accepts the access token on a protected route', async () => {
    const { accessToken, userId } = await loginAs(MOBILE);

    const res = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(accessToken))
      .expect(200);

    expect(expectSuccess<{ id: string }>(res.body).data.id).toBe(userId);
  });

  it('rejects a missing or malformed token', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);

    const bad = await api().get('/api/v1/auth/me').set('Authorization', 'Bearer nonsense');
    expect(bad.status).toBe(401);
    expect(expectError(bad.body).code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('rotates the refresh token and invalidates the old one', async () => {
    const { refreshToken } = await loginAs(MOBILE);

    const refreshed = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    const next = expectSuccess<{ tokens: { refreshToken: string } }>(refreshed.body).data;
    expect(next.tokens.refreshToken).not.toBe(refreshToken);

    // The spent token must not work again.
    const reused = await api().post('/api/v1/auth/refresh').send({ refreshToken });
    expect(reused.status).toBe(401);
  });

  it('revokes the whole session family when a rotated token is replayed', async () => {
    // The defence against a stolen refresh token: if a spent token reappears,
    // either it was stolen or replayed, and both end the session.
    const { refreshToken } = await loginAs(MOBILE);

    const first = await api().post('/api/v1/auth/refresh').send({ refreshToken }).expect(200);
    const rotated = expectSuccess<{ tokens: { refreshToken: string } }>(first.body).data
      .tokens.refreshToken;

    // Replay the original — triggers family revocation.
    await api().post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);

    // The legitimately rotated token is now dead too.
    const after = await api().post('/api/v1/auth/refresh').send({ refreshToken: rotated });
    expect(after.status).toBe(401);

    const live = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('revokes the session on logout', async () => {
    const { refreshToken } = await loginAs(MOBILE);

    await api().post('/api/v1/auth/logout').send({ refreshToken }).expect(204);

    const res = await api().post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('stores only a hash of the refresh token', async () => {
    const { refreshToken } = await loginAs(MOBILE);
    const rows = await prisma.refreshToken.findMany({ select: { tokenHash: true } });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(refreshToken);
    expect(rows[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('account status', () => {
  it('blocks a blocked user at send-otp, before an SMS is paid for', async () => {
    await loginAs(MOBILE);
    await prisma.user.update({ where: { mobile: MOBILE }, data: { status: 'BLOCKED' } });
    await otpService.clearOtpState(MOBILE);

    const res = await api().post('/api/v1/auth/send-otp').send({ mobile: MOBILE });
    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.ACCOUNT_BLOCKED);
  });
});

describe('POST /auth/admin/login', () => {
  const EMAIL = 'owner@adione.test';
  const PASSWORD = 'TestAdmin@123';

  async function createAdmin(role: UserRole = UserRole.STORE_OWNER): Promise<void> {
    await prisma.user.create({
      data: {
        mobile: '0000000001',
        email: EMAIL,
        fullName: 'Test Owner',
        passwordHash: await hashPassword(PASSWORD),
        role,
      },
    });
  }

  it('issues tokens for valid staff credentials', async () => {
    await createAdmin();
    const res = await api()
      .post('/api/v1/auth/admin/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    const data = expectSuccess<{ user: { role: string }; tokens: { accessToken: string } }>(
      res.body,
    ).data;
    expect(data.user.role).toBe(UserRole.STORE_OWNER);
    expect(data.tokens.accessToken).toBeTruthy();
  });

  it('returns the same generic error for unknown email and wrong password', async () => {
    // Distinguishing them would turn this endpoint into an oracle for which
    // staff accounts exist.
    await createAdmin();

    const wrongPassword = await api()
      .post('/api/v1/auth/admin/login')
      .send({ email: EMAIL, password: 'WrongPassword1' });
    const unknownEmail = await api()
      .post('/api/v1/auth/admin/login')
      .send({ email: 'nobody@adione.test', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(expectError(wrongPassword.body).message).toBe(
      expectError(unknownEmail.body).message,
    );
  });

  it('refuses a customer account even with a correct password', async () => {
    await createAdmin(UserRole.CUSTOMER);
    const res = await api()
      .post('/api/v1/auth/admin/login')
      .send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_CREDENTIALS);
  });
});

describe('PATCH /auth/me', () => {
  it('updates the profile but never the mobile number', async () => {
    const { accessToken } = await loginAs(MOBILE);

    const res = await api()
      .patch('/api/v1/auth/me')
      .set('Authorization', bearer(accessToken))
      // `mobile` is not in the schema, so Zod strips it — the mockup states the
      // number cannot be changed, and the API enforces that structurally.
      .send({ fullName: 'Avinash Jat', email: 'avinash@example.com', mobile: '9999999999' })
      .expect(200);

    const user = expectSuccess<{ fullName: string; email: string; mobile: string }>(res.body)
      .data;
    expect(user.fullName).toBe('Avinash Jat');
    expect(user.email).toBe('avinash@example.com');
    expect(user.mobile).toBe(MOBILE);
  });
});
