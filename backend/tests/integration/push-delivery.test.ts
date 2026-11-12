/**
 * Push delivery (notification.service dispatch / retryPending / FCM payload).
 *
 *   - Every push names the app's Android channel ("orders"), is high priority
 *     and expires after an hour — an order update is never shown days late.
 *   - Only a FRESH update is pushed or retried (PUSH_RETRY_WINDOW_MS): the
 *     backlog of rows written while no phone could register a token stays in
 *     the in-app feed and is never sent as a stale order update.
 *   - Each attempt is claimed: the first attempt and the retry job never both send.
 *   - A token FCM rejects (UNREGISTERED / not an FCM token) is switched off and
 *     never sent to again until the app registers it afresh; any other failure
 *     (credentials, project mismatch, outage) keeps the device and is retried.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NotificationStatus, NotificationType } from '../../src/shared';
import { api, bearer, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import * as otpService from '../../src/modules/auth/otp.service';
import {
  ANDROID_CHANNEL_ID,
  classifyFcmError,
  fcmMessage,
  notificationProvider,
  notify,
  PUSH_MAX_ATTEMPTS,
  PUSH_RETRY_WINDOW_MS,
  PushTokenRejectedError,
  retryPending,
  type NotificationProvider,
} from '../../src/modules/notifications/notification.service';

const PHONE_A = 'fcm-token-phone-a-000000000001';
const PHONE_B = 'fcm-token-phone-b-000000000002';

let seq = 0;

async function customerWithPhones(...tokens: string[]) {
  const user = await prisma.user.create({ data: { mobile: `98765${String(++seq).padStart(5, '0')}`, fullName: 'Customer' } });
  for (const token of tokens) await prisma.deviceToken.create({ data: { userId: user.id, token, platform: 'ANDROID' } });
  return user;
}

/** A row as notify() writes it, `ageMs` old, as if its first attempt already happened (or never could). */
function row(userId: string, ageMs: number, extra: { status?: NotificationStatus; attempts?: number } = {}) {
  return prisma.notification.create({
    data: {
      userId,
      type: NotificationType.ORDER_OUT_FOR_DELIVERY,
      dedupeKey: `test:${++seq}`,
      title: 'Out for delivery',
      body: 'Your order is on the way.',
      createdAt: new Date(Date.now() - ageMs),
      status: extra.status ?? NotificationStatus.QUEUED,
      attempts: extra.attempts ?? 0,
    },
  });
}

const reload = (id: string) => prisma.notification.findUniqueOrThrow({ where: { id } });
const active = async (token: string) => (await prisma.deviceToken.findUniqueOrThrow({ where: { token } })).isActive;

/** notify() dispatches without waiting; this waits for its attempt to finish. */
async function settled(userId: string) {
  await vi.waitFor(
    async () => {
      const rows = await prisma.notification.findMany({ where: { userId } });
      expect(rows.every((r) => r.attempts > 0 && r.status !== NotificationStatus.QUEUED)).toBe(true);
    },
    { timeout: 5000, interval: 50 },
  );
  return prisma.notification.findFirstOrThrow({ where: { userId } });
}

let send: MockInstance<NotificationProvider['send']>;

beforeEach(async () => {
  await truncateAll();
  send = vi.spyOn(notificationProvider, 'send').mockResolvedValue({ messageId: 'projects/aadione/messages/1' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the FCM message', () => {
  it('names the app\'s "orders" channel, is high priority, expires after an hour and carries string data', () => {
    const message = fcmMessage({ token: PHONE_A, title: 'Delivered', body: 'Thank you!', data: { orderId: 'o1', type: 'ORDER_DELIVERED', audience: 'CUSTOMER' } });
    expect(ANDROID_CHANNEL_ID).toBe('orders');
    expect(message).toEqual({
      token: PHONE_A,
      notification: { title: 'Delivered', body: 'Thank you!' },
      data: { orderId: 'o1', type: 'ORDER_DELIVERED', audience: 'CUSTOMER' },
      android: { priority: 'high', ttl: '3600s', notification: { channel_id: 'orders' } },
    });
  });

  it('switches a device off only when FCM rejects the token itself', () => {
    const fcm = (status: string, errorCode: string | null, message: string) => ({
      error: { status, message, details: errorCode ? [{ errorCode }] : [] },
    });
    expect(classifyFcmError(404, fcm('NOT_FOUND', 'UNREGISTERED', 'Requested entity was not found.')).tokenRejected).toBe(true);
    expect(classifyFcmError(400, fcm('INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token')).tokenRejected).toBe(true);
    // A bad payload, or a server-side misconfiguration, must never switch off every phone.
    expect(classifyFcmError(400, fcm('INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Invalid value at message.android.ttl')).tokenRejected).toBe(false);
    expect(classifyFcmError(403, fcm('PERMISSION_DENIED', 'SENDER_ID_MISMATCH', 'SenderId mismatch')).tokenRejected).toBe(false);
    expect(classifyFcmError(401, fcm('UNAUTHENTICATED', 'THIRD_PARTY_AUTH_ERROR', 'Auth error')).tokenRejected).toBe(false);
    expect(classifyFcmError(503, fcm('UNAVAILABLE', 'UNAVAILABLE', 'Try later')).tokenRejected).toBe(false);
    expect(classifyFcmError(500, {}).summary).toBe('fcm 500 UNKNOWN: ');
    expect(classifyFcmError(404, fcm('NOT_FOUND', 'UNREGISTERED', 'Requested entity was not found.')).summary).toBe(
      'fcm 404 UNREGISTERED: Requested entity was not found.',
    );
  });
});

describe('fresh updates are pushed', () => {
  it('a new notification goes to every active phone at once, in one recorded attempt', async () => {
    const user = await customerWithPhones(PHONE_A, PHONE_B);
    await notify({ userId: user.id, type: NotificationType.ORDER_DELIVERED, dedupeKey: 'order:1:DELIVERED', context: { orderNumber: 'AD-1' } });
    const sent = await settled(user.id);
    expect(sent).toMatchObject({ status: NotificationStatus.SENT, attempts: 1, providerMessageId: 'projects/aadione/messages/1', failureReason: null });
    expect(send.mock.calls.map(([m]) => (m as { token: string }).token).sort()).toEqual([PHONE_A, PHONE_B]);
    expect(send.mock.calls[0]![0]).toMatchObject({ title: 'Delivered', data: { type: 'ORDER_DELIVERED', audience: 'CUSTOMER' } });
  });

  it('with no phone registered the row stays in the feed as one failed attempt — and a phone registered soon after still gets it', async () => {
    const user = await customerWithPhones();
    await notify({ userId: user.id, type: NotificationType.ORDER_ACCEPTED, dedupeKey: 'so:1:ACCEPTED', context: { orderNumber: 'AD-2' } });
    const first = await settled(user.id);
    expect(first).toMatchObject({ status: NotificationStatus.FAILED, attempts: 1, failureReason: 'no registered device' });
    expect(send).not.toHaveBeenCalled();

    await prisma.deviceToken.create({ data: { userId: user.id, token: PHONE_A, platform: 'ANDROID' } });
    await prisma.notification.update({ where: { id: first.id }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    expect(await retryPending()).toBe(1);
    expect(await reload(first.id)).toMatchObject({ status: NotificationStatus.SENT, attempts: 2, failureReason: null });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('stale updates are never pushed', () => {
  it('the backlog from before phones could register (old QUEUED rows) is left alone, however many there are', async () => {
    const user = await customerWithPhones(PHONE_A);
    const old = [];
    for (let i = 0; i < 60; i++) old.push(await row(user.id, 2 * 24 * 60 * 60_000));
    const justStale = await row(user.id, PUSH_RETRY_WINDOW_MS + 60_000, { status: NotificationStatus.FAILED, attempts: 1 });

    expect(await retryPending()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    for (const r of [...old.slice(0, 3), justStale]) {
      const now = await reload(r.id);
      expect([now.status, now.attempts]).toEqual([r.status, r.attempts]); // untouched: still in the in-app feed
    }
  });

  it('a stale backlog does not crowd out a fresh failure (the oldest-first page used to be all stale rows)', async () => {
    const user = await customerWithPhones(PHONE_A);
    for (let i = 0; i < 60; i++) await row(user.id, 3 * 24 * 60 * 60_000);
    const fresh = await row(user.id, 3 * 60_000, { status: NotificationStatus.FAILED, attempts: 1 });
    expect(await retryPending()).toBe(1);
    expect(await reload(fresh.id)).toMatchObject({ status: NotificationStatus.SENT, attempts: 2 });
  });

  it('a row is left to its first attempt for a minute, and given up after the last attempt', async () => {
    const user = await customerWithPhones(PHONE_A);
    await row(user.id, 10_000); // first attempt may still be running
    await row(user.id, 5 * 60_000, { status: NotificationStatus.FAILED, attempts: PUSH_MAX_ATTEMPTS });
    expect(await retryPending()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('retries', () => {
  it('an FCM outage keeps the phone and is retried until it goes through', async () => {
    const user = await customerWithPhones(PHONE_A);
    send.mockRejectedValueOnce(new Error('fcm 503 UNAVAILABLE: Try later'));
    await notify({ userId: user.id, type: NotificationType.ORDER_DELIVERED, dedupeKey: 'order:2:DELIVERED' });
    const failed = await settled(user.id);
    expect(failed).toMatchObject({ status: NotificationStatus.FAILED, attempts: 1, failureReason: 'Error: fcm 503 UNAVAILABLE: Try later' });
    expect(await active(PHONE_A)).toBe(true);

    await prisma.notification.update({ where: { id: failed.id }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    await retryPending();
    expect(await reload(failed.id)).toMatchObject({ status: NotificationStatus.SENT, attempts: 2 });
  });

  it('two retry runs reaching the same row together send it once', async () => {
    const user = await customerWithPhones(PHONE_A);
    const r = await row(user.id, 3 * 60_000, { status: NotificationStatus.FAILED, attempts: 1 });
    await Promise.all([retryPending(), retryPending(), retryPending()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await reload(r.id)).toMatchObject({ status: NotificationStatus.SENT, attempts: 2 });
  });
});

describe('rejected tokens', () => {
  it('a token FCM rejects is switched off; the account\'s other phone still gets the push', async () => {
    const user = await customerWithPhones(PHONE_A, PHONE_B);
    send.mockImplementation(async (m) => {
      if (m.token === PHONE_A) throw new PushTokenRejectedError('fcm 404 UNREGISTERED: Requested entity was not found.');
      return { messageId: 'projects/aadione/messages/2' };
    });
    await notify({ userId: user.id, type: NotificationType.ORDER_DELIVERED, dedupeKey: 'order:3:DELIVERED' });
    expect(await settled(user.id)).toMatchObject({ status: NotificationStatus.SENT, providerMessageId: 'projects/aadione/messages/2' });
    expect(await active(PHONE_A)).toBe(false);
    expect(await active(PHONE_B)).toBe(true);

    send.mockClear();
    await notify({ userId: user.id, type: NotificationType.ORDER_CANCELLED, dedupeKey: 'order:4:CANCELLED' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0]![0] as { token: string }).token).toBe(PHONE_B);
  });

  it('when every phone is rejected the row fails without a retry storm, and the app registering again turns the phone back on', async () => {
    await otpService.clearOtpState('9123400001');
    const session = await loginAs('9123400001');
    const register = () =>
      api().post('/api/v1/devices').set('Authorization', bearer(session.accessToken)).send({ token: PHONE_A, platform: 'ANDROID', appVersion: '1.1.6' });
    expect((await register()).status).toBeLessThan(300);
    const user = await prisma.deviceToken.findUniqueOrThrow({ where: { token: PHONE_A } });

    send.mockRejectedValue(new PushTokenRejectedError('fcm 400 INVALID_ARGUMENT: The registration token is not a valid FCM registration token'));
    await notify({ userId: user.userId, type: NotificationType.ORDER_DELIVERED, dedupeKey: 'order:5:DELIVERED' });
    const failed = await settled(user.userId);
    expect(failed.status).toBe(NotificationStatus.FAILED);
    expect(await active(PHONE_A)).toBe(false);

    // The next retry finds no active phone: nothing is sent to the dead token.
    await prisma.notification.update({ where: { id: failed.id }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    send.mockClear();
    await retryPending();
    expect(send).not.toHaveBeenCalled();
    expect(await reload(failed.id)).toMatchObject({ status: NotificationStatus.FAILED, failureReason: 'no registered device' });

    expect((await register()).status).toBeLessThan(300);
    expect(await active(PHONE_A)).toBe(true);
  });
});
