/**
 * Push tokens on sign-out (auth.service logout + notification.service
 * removeDevice).
 *
 * Signing out used to revoke only the session: the phone's push token stayed
 * attached to the account, so its order updates kept arriving on that phone —
 * also after someone else signed in there. Now POST /auth/logout takes the
 * phone's token and removes it from THAT account only:
 *   - the account's other phones keep their tokens;
 *   - a token that has moved to another account (switching accounts on a
 *     shared phone) is never removed from the new owner;
 *   - a retried logout (the app retries one that could not reach the server)
 *     still removes it, and is harmless when there is nothing left to do;
 *   - deleting the account removes every token.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import * as otpService from '../../src/modules/auth/otp.service';

const PHONE_1 = 'fcm-token-phone-one-0000000001';
const PHONE_2 = 'fcm-token-phone-two-0000000002';

async function customer(mobile: string) {
  await otpService.clearOtpState(mobile);
  return loginAs(mobile);
}

const register = (accessToken: string, token: string) =>
  api().post('/api/v1/devices').set('Authorization', bearer(accessToken)).send({ token, platform: 'ANDROID', appVersion: '1.1.3' }).expect((res) => {
    expect(res.status).toBeLessThan(300);
  });

const tokensOf = async (userId: string) =>
  (await prisma.deviceToken.findMany({ where: { userId }, select: { token: true }, orderBy: { token: 'asc' } })).map((row) => row.token);

beforeEach(async () => {
  await truncateAll();
});

describe('signing out removes this phone\'s push token', () => {
  it('only from this account, and never another phone\'s', async () => {
    const onPhone1 = await customer('9400000911');
    const onPhone2 = await customer('9400000911');
    await register(onPhone1.accessToken, PHONE_1);
    await register(onPhone2.accessToken, PHONE_2);
    expect(await tokensOf(onPhone1.userId)).toEqual([PHONE_1, PHONE_2]);

    await api().post('/api/v1/auth/logout').send({ refreshToken: onPhone1.refreshToken, deviceToken: PHONE_1 }).expect(204);
    expect(await tokensOf(onPhone1.userId)).toEqual([PHONE_2]);
    // That session is over; the other phone's is not.
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: onPhone1.refreshToken })).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: onPhone2.refreshToken })).status).toBe(200);
  });

  it('a retried logout still removes the token and is harmless when repeated', async () => {
    const user = await customer('9400000912');
    await register(user.accessToken, PHONE_1);
    // The first attempt (offline) revoked nothing on the server; the session is
    // revoked by another path, then the queued retry arrives.
    await api().post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken }).expect(204);
    expect(await tokensOf(user.userId)).toEqual([PHONE_1]);
    await api().post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken, deviceToken: PHONE_1 }).expect(204);
    expect(await tokensOf(user.userId)).toEqual([]);
    await api().post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken, deviceToken: PHONE_1 }).expect(204);
  });

  it('switching accounts on a shared phone: the token moves, and the old account\'s late logout never takes it from the new one', async () => {
    const first = await customer('9400000913');
    await register(first.accessToken, PHONE_1);
    const second = await customer('9400000914');
    await register(second.accessToken, PHONE_1);
    expect(await tokensOf(first.userId)).toEqual([]);
    expect(await tokensOf(second.userId)).toEqual([PHONE_1]);

    // The first account's sign-out, retried after the second one signed in.
    await api().post('/api/v1/auth/logout').send({ refreshToken: first.refreshToken, deviceToken: PHONE_1 }).expect(204);
    expect(await tokensOf(second.userId)).toEqual([PHONE_1]);
  });

  it('an unknown session or a malformed token never removes anything', async () => {
    const user = await customer('9400000915');
    await register(user.accessToken, PHONE_1);
    await api().post('/api/v1/auth/logout').send({ refreshToken: 'x'.repeat(40), deviceToken: PHONE_1 }).expect(204);
    expect(await tokensOf(user.userId)).toEqual([PHONE_1]);
    expect((await api().post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken, deviceToken: 'short' })).status).toBe(400);
    expect(await tokensOf(user.userId)).toEqual([PHONE_1]);
  });

  it('deleting the account removes every token', async () => {
    const user = await customer('9400000916');
    await register(user.accessToken, PHONE_1);
    await register(user.accessToken, PHONE_2);
    await api().delete('/api/v1/auth/me').set('Authorization', bearer(user.accessToken)).expect((res) => expect(res.status).toBeLessThan(300));
    expect(await tokensOf(user.userId)).toEqual([]);
  });
});
