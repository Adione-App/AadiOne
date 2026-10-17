/**
 * App version management, end to end: the public policy endpoint, the admin
 * endpoints and their authorization, and the server-side minimum-version gate
 * on the customer APIs — including everything it must NOT touch (admin and
 * seller panels, the payment webhook and payment verification, auth, config).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AppUpdateMode,
  AppUpdateStatus,
  ConfigKey,
  ErrorCode,
  UserRole,
  type AppUpdateCheckDto,
  type AppUpdatePolicy,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { clearAppUpdatePolicyMemo } from '../../src/modules/app-version/app-version.service';

const CUSTOMER = '9876500001';
const PLAY = 'https://play.google.com/store/apps/details?id=in.adione.app';
const APP_STORE = 'https://apps.apple.com/in/app/aadione/id0000000000';

const appHeaders = (platform: 'android' | 'ios', version?: string, build = '9') => ({
  'X-App-Platform': platform,
  ...(version ? { 'X-App-Version': version } : {}),
  'X-App-Build': build,
});

function policy(overrides: Partial<AppUpdatePolicy> = {}): AppUpdatePolicy {
  return {
    enabled: true,
    mode: AppUpdateMode.OPTIONAL,
    blockUnversionedClients: false,
    title: 'Update available',
    message: 'A new Aadione is here — please update.',
    releaseNotes: 'Faster checkout.',
    android: { latestVersion: '1.0.10', minimumVersion: '1.0.9', storeUrl: PLAY },
    ios: { latestVersion: null, minimumVersion: null, storeUrl: null },
    ...overrides,
  };
}

async function staffToken(role: UserRole, email: string, mobile: string): Promise<string> {
  await prisma.user.create({
    data: { mobile, email, fullName: 'Panel user', passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const adminToken = () => staffToken(UserRole.ADMIN, 'admin@adione.test', '9000000001');

async function savePolicy(token: string, value: AppUpdatePolicy) {
  return api().put('/api/v1/admin/app-update-policy').set('Authorization', bearer(token)).send(value);
}

async function check(query: string, headers: Record<string, string> = {}): Promise<AppUpdateCheckDto> {
  const res = await api().get(`/api/v1/app-version/policy${query}`).set(headers).expect(200);
  return expectSuccess<AppUpdateCheckDto>(res.body).data;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  clearAppUpdatePolicyMemo();
  await otpService.clearOtpState(CUSTOMER);
});

describe('GET /app-version/policy (public)', () => {
  it('with no saved policy: off — nobody is prompted or blocked', async () => {
    const answer = await check('?platform=android&version=0.0.1');
    expect(answer).toMatchObject({ status: AppUpdateStatus.NONE, platform: 'android', installedVersion: '0.0.1' });
  });

  it('answers per platform and version, from the query or the app headers, with only app-facing fields', async () => {
    const admin = await adminToken();
    await savePolicy(admin, policy()).then((r) => expect(r.status).toBe(200));

    const optional = await check('?platform=android&version=1.0.9');
    expect(optional).toMatchObject({
      status: AppUpdateStatus.OPTIONAL,
      latestVersion: '1.0.10',
      minimumVersion: '1.0.9',
      storeUrl: PLAY,
      releaseNotes: 'Faster checkout.',
    });
    expect(Object.keys(optional).sort()).toEqual(
      ['installedVersion', 'latestVersion', 'message', 'minimumVersion', 'platform', 'promptKey', 'releaseNotes', 'status', 'storeUrl', 'title'].sort(),
    );
    expect(JSON.stringify(optional)).not.toMatch(/blockUnversionedClients|updatedBy|enabled/);

    expect((await check('', appHeaders('android', '1.0.8'))).status).toBe(AppUpdateStatus.REQUIRED);
    expect((await check('?platform=android&version=1.0.10')).status).toBe(AppUpdateStatus.NONE);
    // iOS has no policy here.
    expect((await check('?platform=ios&version=0.1.0')).status).toBe(AppUpdateStatus.NONE);
    // 1.0.10 vs 1.0.9 is numeric, not lexicographic.
    expect((await check('?platform=android&version=1.0.9')).status).toBe(AppUpdateStatus.OPTIONAL);
  });

  it('rejects a missing/unknown platform; a malformed version is treated as unknown', async () => {
    expect(expectError((await api().get('/api/v1/app-version/policy').expect(400)).body).code).toBe(ErrorCode.VALIDATION_ERROR);
    await api().get('/api/v1/app-version/policy?platform=windows').expect(400);
    const admin = await adminToken();
    await savePolicy(admin, policy());
    expect(await check('?platform=android&version=1.0.x')).toMatchObject({ status: AppUpdateStatus.NONE, installedVersion: null });
  });
});

describe('admin endpoints', () => {
  it('admin reads the default, saves, and the change is audited and effective immediately', async () => {
    const admin = await adminToken();
    const initial = expectSuccess<{ policy: AppUpdatePolicy; updatedAt: string | null }>(
      (await api().get('/api/v1/admin/app-update-policy').set('Authorization', bearer(admin)).expect(200)).body,
    ).data;
    expect(initial).toMatchObject({ updatedAt: null, policy: { enabled: false } });

    const saved = await savePolicy(admin, policy({ title: '  Update now  ' }));
    expect(saved.status).toBe(200);
    expect(expectSuccess<{ policy: AppUpdatePolicy }>(saved.body).data.policy.title).toBe('Update now');
    expect((await check('?platform=android&version=1.0.8')).status).toBe(AppUpdateStatus.REQUIRED);

    const audit = await prisma.auditLog.findMany({ where: { action: 'app_update_policy.update' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: ConfigKey.APP_UPDATE_POLICY });
    expect(audit[0]!.before).toMatchObject({ enabled: false });
    expect(audit[0]!.after).toMatchObject({ enabled: true, mode: 'OPTIONAL' });
  });

  it('rejects an invalid policy with per-field details, and stores nothing', async () => {
    const admin = await adminToken();
    const res = await savePolicy(admin, policy({ android: { latestVersion: '1.0.9', minimumVersion: '1.0.10', storeUrl: 'https://evil.example/apk' } }));
    expect(res.status).toBe(400);
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.details?.map((d) => d.field)).toEqual(expect.arrayContaining(['android.minimumVersion', 'android.storeUrl']));
    expect((await check('?platform=android&version=0.0.1')).status).toBe(AppUpdateStatus.NONE);
  });

  it('the generic configuration endpoint applies the same validation', async () => {
    const admin = await adminToken();
    const bad = await api()
      .patch('/api/v1/admin/config')
      .set('Authorization', bearer(admin))
      .send({ key: ConfigKey.APP_UPDATE_POLICY, value: { ...policy(), mode: 'FORCE' } });
    expect(bad.status).toBe(400);
  });

  it('customers and staff without configuration access cannot read or change the policy', async () => {
    const customer = await loginAs(CUSTOMER);
    for (const token of [customer.accessToken, await staffToken(UserRole.STAFF, 'staff@adione.test', '9000000002')]) {
      expect((await api().get('/api/v1/admin/app-update-policy').set('Authorization', bearer(token))).status).toBe(403);
      expect((await savePolicy(token, policy())).status).toBe(403);
    }
    expect((await api().get('/api/v1/admin/app-update-policy')).status).toBe(401);
    expect((await api().put('/api/v1/admin/app-update-policy').send(policy())).status).toBe(401);
  });
});

describe('server-side minimum-version enforcement', () => {
  async function setup(value: AppUpdatePolicy) {
    const admin = await adminToken();
    expect((await savePolicy(admin, value)).status).toBe(200);
    const customer = await loginAs(CUSTOMER);
    return { admin, customer: customer.accessToken };
  }
  const cart = (token: string, headers: Record<string, string> = {}) =>
    api().get('/api/v1/cart').set('Authorization', bearer(token)).set(headers);

  it('an app below the minimum gets 426 APP_UPDATE_REQUIRED with the update details; supported apps pass', async () => {
    const { customer } = await setup(policy());

    const blocked = await cart(customer, appHeaders('android', '1.0.8'));
    expect(blocked.status).toBe(426);
    const error = expectError(blocked.body);
    expect(error.code).toBe(ErrorCode.APP_UPDATE_REQUIRED);
    const update = error.details?.find((d) => d.field === 'appUpdate')?.['update'] as AppUpdateCheckDto;
    expect(update).toMatchObject({ status: AppUpdateStatus.REQUIRED, minimumVersion: '1.0.9', storeUrl: PLAY, platform: 'android' });

    expect((await cart(customer, appHeaders('android', '1.0.9'))).status).toBe(200); // optional, not blocked
    expect((await cart(customer, appHeaders('android', '1.0.10'))).status).toBe(200);
    // An Android policy never blocks iOS.
    expect((await cart(customer, appHeaders('ios', '1.0.0'))).status).toBe(200);
  });

  it('every customer commerce route is gated; payment creation too', async () => {
    const { customer } = await setup(policy());
    const old = appHeaders('android', '1.0.8');
    const requests = [
      api().get('/api/v1/addresses'),
      api().get('/api/v1/orders'),
      api().post('/api/v1/checkout/quote').send({}),
      api().post('/api/v1/cart/items').send({ sellerListingId: randomUUID(), qty: 1 }),
      api().post('/api/v1/payments/create').send({ orderId: randomUUID() }),
      api().get('/api/v1/referrals/me'),
    ];
    for (const request of requests) {
      const res = await request.set('Authorization', bearer(customer)).set(old);
      expect(res.status).toBe(426);
    }
  });

  it('never blocks: payment verification and the gateway webhook, auth, config, the policy endpoint, catalogue', async () => {
    const { customer } = await setup(policy({ mode: AppUpdateMode.MANDATORY, blockUnversionedClients: true }));
    const old = appHeaders('android', '1.0.0');
    const orderId = randomUUID();

    // Money already taken must stay verifiable.
    expect((await api().post(`/api/v1/payments/${orderId}/refresh`).set('Authorization', bearer(customer)).set(old)).status).toBe(404);
    expect((await api().get(`/api/v1/payments/${orderId}/status`).set('Authorization', bearer(customer)).set(old)).status).toBe(200);
    const verify = await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(customer))
      .set(old)
      .send({ orderId, providerOrderId: 'order_x', providerPaymentId: 'pay_x', signature: 's'.repeat(16) });
    expect(verify.status).not.toBe(426);
    // The webhook: never gated (its own signature check answers).
    const hook = await api().post('/api/v1/payments/webhook').set('Content-Type', 'application/json').send('{"type":"PAYMENT_SUCCESS_WEBHOOK"}');
    expect(hook.status).not.toBe(426);
    const hookWithAppHeaders = await api().post('/api/v1/payments/webhook').set(old).set('Content-Type', 'application/json').send('{}');
    expect(hookWithAppHeaders.status).not.toBe(426);

    expect((await api().get('/api/v1/config/public').set(old)).status).toBe(200);
    expect((await api().get('/api/v1/app-version/policy').set(old)).status).toBe(200);
    expect((await api().get('/health').set(old)).status).not.toBe(426);
    expect((await api().post('/api/v1/auth/refresh').set(old).send({ refreshToken: 'x'.repeat(40) })).status).not.toBe(426);
    expect((await api().get('/api/v1/categories').set(old)).status).not.toBe(426);
  });

  it('the admin panel (no app headers) is never gated, even with every switch on', async () => {
    const { admin } = await setup(policy({ mode: AppUpdateMode.MANDATORY, blockUnversionedClients: true }));
    expect((await api().get('/api/v1/admin/app-update-policy').set('Authorization', bearer(admin))).status).toBe(200);
    expect((await api().get('/api/v1/admin/orders').set('Authorization', bearer(admin))).status).toBe(200);
  });

  it('mandatory mode: everything below the latest version must update', async () => {
    const { customer } = await setup(policy({ mode: AppUpdateMode.MANDATORY }));
    expect((await cart(customer, appHeaders('android', '1.0.9'))).status).toBe(426);
    expect((await cart(customer, appHeaders('android', '1.0.10'))).status).toBe(200);
  });

  it('apps that send no version (older builds): allowed by default; refused only when the admin switches it on — panels unaffected', async () => {
    const { admin, customer } = await setup(policy());
    expect((await cart(customer)).status).toBe(200);

    expect((await savePolicy(admin, policy({ blockUnversionedClients: true }))).status).toBe(200);
    const refused = await cart(customer);
    expect(refused.status).toBe(426);
    expect(expectError(refused.body).message).toMatch(/update Aadione/i);
    // A platform header without a usable version counts as unversioned too.
    expect((await cart(customer, { 'X-App-Platform': 'android', 'X-App-Version': 'garbage' })).status).toBe(426);
    // Full-scope (panel) sessions never send app headers and are never gated.
    expect((await api().get('/api/v1/admin/orders').set('Authorization', bearer(admin))).status).toBe(200);
  });

  it('switching back to optional or off takes effect at once — no app release needed', async () => {
    const { admin, customer } = await setup(policy({ mode: AppUpdateMode.MANDATORY }));
    expect((await cart(customer, appHeaders('android', '1.0.9'))).status).toBe(426);
    expect((await savePolicy(admin, policy({ mode: AppUpdateMode.OPTIONAL, android: { latestVersion: '1.0.10', minimumVersion: null, storeUrl: PLAY } }))).status).toBe(200);
    expect((await cart(customer, appHeaders('android', '1.0.9'))).status).toBe(200);
    expect((await check('?platform=android&version=1.0.9')).status).toBe(AppUpdateStatus.OPTIONAL);
    expect((await savePolicy(admin, policy({ enabled: false }))).status).toBe(200);
    expect((await cart(customer, appHeaders('android', '0.0.1'))).status).toBe(200);
    expect((await check('?platform=android&version=0.0.1')).status).toBe(AppUpdateStatus.NONE);
  });

  it('fails open: a stored policy that no longer validates blocks nobody', async () => {
    const customer = await loginAs(CUSTOMER);
    // A hand-edited row (bypassing every validation).
    await prisma.configuration.create({
      data: { key: ConfigKey.APP_UPDATE_POLICY, value: { enabled: true, mode: 'MANDATORY', android: { minimumVersion: '99.0.0' } }, isPublic: false },
    });
    await configService.invalidateAll();
    clearAppUpdatePolicyMemo();
    expect((await cart(customer.accessToken, appHeaders('android', '1.0.0'))).status).toBe(200);
    expect((await check('?platform=android&version=1.0.0')).status).toBe(AppUpdateStatus.NONE);
  });

  it('iOS policy with its own App Store link applies to iPhones only', async () => {
    const { customer } = await setup(
      policy({
        android: { latestVersion: null, minimumVersion: null, storeUrl: PLAY },
        ios: { latestVersion: '2.0.0', minimumVersion: '2.0.0', storeUrl: APP_STORE },
      }),
    );
    const blocked = await cart(customer, appHeaders('ios', '1.9.9'));
    expect(blocked.status).toBe(426);
    expect((expectError(blocked.body).details?.[0]?.['update'] as AppUpdateCheckDto).storeUrl).toBe(APP_STORE);
    expect((await cart(customer, appHeaders('android', '0.1.0'))).status).toBe(200);
  });
});
