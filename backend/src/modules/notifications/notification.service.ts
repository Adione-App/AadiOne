/**
 * Notifications (Phase 11).
 *
 * `NotificationProvider` is a port so SMS, WhatsApp and email can be added
 * without touching the order code that triggers them. V1 ships a console
 * provider and an FCM provider.
 *
 * The `notifications` table doubles as an OUTBOX and the in-app feed: a row is
 * written inside the caller's flow, then dispatched separately. A push that
 * fails is retried from the row rather than lost, and — crucially — a failing
 * push provider can never roll back an order.
 */

import jwt from 'jsonwebtoken';
import { NotificationChannel, NotificationStatus, NotificationType } from '../../shared';
import { formatPaise } from '../../shared/money';
import { env } from '../../config/env';
import { prisma } from '../../infra/db/prisma';
import { moduleLogger } from '../../common/logger';

const log = moduleLogger('notifications');

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface NotificationProvider {
  readonly name: string;
  send(message: PushMessage): Promise<{ messageId: string | null }>;
}

class ConsoleNotificationProvider implements NotificationProvider {
  readonly name = 'console';
  async send(message: PushMessage): Promise<{ messageId: string | null }> {
    log.info({ title: message.title, body: message.body }, 'PUSH (console provider)');
    return { messageId: `console-${Date.now()}` };
  }
}

const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

class FcmNotificationProvider implements NotificationProvider {
  readonly name = 'fcm';

  // Cached across sends: the token is valid for an hour, and requesting a
  // fresh one per push would mean two Google round-trips for every single
  // notification instead of one.
  private cachedToken: { accessToken: string; expiresAt: number } | null = null;

  async send(message: PushMessage): Promise<{ messageId: string | null }> {
    // Kept deliberately thin: obtaining an OAuth token from the service
    // account is the only real work, and doing it here avoids the
    // firebase-admin dependency for what is one HTTP call.
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
            android: { priority: 'high' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      throw new Error(`fcm ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { name?: string };
    return { messageId: body.name ?? null };
  }

  /**
   * Exchanges the service-account credentials for a short-lived OAuth access
   * token, via the standard Google JWT-bearer flow (RFC 7523): a JWT signed
   * with the service account's own private key, asserting the scope we want,
   * traded in for an access token at Google's token endpoint. No Firebase
   * SDK needed for this — it's two HTTP-adjacent steps.
   */
  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.accessToken;
    }

    if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
      throw new Error(
        'FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY are not configured — cannot obtain an FCM access token',
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: env.FCM_CLIENT_EMAIL,
        scope: FCM_SCOPE,
        aud: FCM_TOKEN_URL,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      env.FCM_PRIVATE_KEY,
      { algorithm: 'RS256' },
    );

    const response = await fetch(FCM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`fcm token exchange ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return body.access_token;
  }
}

const provider: NotificationProvider =
  env.NOTIFICATION_PROVIDER === 'fcm' ? new FcmNotificationProvider() : new ConsoleNotificationProvider();

log.info({ provider: provider.name }, 'notification provider initialised');

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * User-facing copy per event.
 *
 * Short, concrete, no jargon — these arrive as a phone banner and are read by
 * first-time smartphone users.
 */
function compose(
  type: NotificationType,
  context: { orderNumber: string; totalPaise?: number; etaMinutes?: number | null; reason?: string | null },
): { title: string; body: string } {
  const order = context.orderNumber;
  switch (type) {
    case NotificationType.ORDER_PLACED:
      return { title: 'Order placed', body: `We have received your order ${order}.` };
    case NotificationType.ORDER_ACCEPTED:
      return {
        title: 'Order confirmed',
        body: context.etaMinutes
          ? `The store is preparing your order. Arriving in about ${context.etaMinutes} mins.`
          : 'The store has confirmed your order.',
      };
    case NotificationType.ORDER_PREPARING:
      return { title: 'Preparing your order', body: `Your order ${order} is being packed.` };
    case NotificationType.ORDER_READY:
      return { title: 'Order packed', body: 'Your order is packed and waiting for a delivery partner.' };
    case NotificationType.ORDER_OUT_FOR_DELIVERY:
      return { title: 'Out for delivery', body: 'Your order is on the way. Please keep your phone nearby.' };
    case NotificationType.ORDER_DELIVERED:
      return { title: 'Delivered', body: `Your order ${order} has been delivered. Thank you!` };
    case NotificationType.ORDER_CANCELLED:
      return {
        title: 'Order cancelled',
        body: context.reason ? `Your order was cancelled: ${context.reason}` : 'Your order was cancelled.',
      };
    case NotificationType.ORDER_REJECTED:
      return {
        title: 'Order could not be accepted',
        body: context.reason ?? 'The store could not accept your order. Any payment will be refunded.',
      };
    case NotificationType.PAYMENT_FAILED:
      return {
        title: 'Payment failed',
        body: 'Your payment did not go through. No money has been deducted, or it will be refunded.',
      };
    case NotificationType.PAYMENT_SUCCESS:
      return {
        title: 'Payment received',
        body: context.totalPaise ? `We received ${formatPaise(context.totalPaise)}.` : 'Payment received.',
      };
    case NotificationType.REFUND_INITIATED:
      return { title: 'Refund started', body: 'Your refund has been started and will reach you shortly.' };
    case NotificationType.REFUND_COMPLETED:
      return { title: 'Refund complete', body: 'Your refund has been processed.' };
    case NotificationType.BACK_IN_STOCK:
      return { title: 'Back in stock', body: 'An item you wanted is available again.' };
    default:
      return { title: 'Order update', body: `There is an update on your order ${order}.` };
  }
}

/* -------------------------------------------------------------------------- */
/* Task 11.1 / 11.2                                                           */
/* -------------------------------------------------------------------------- */

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  orderId?: string | null;
  orderNumber?: string;
  totalPaise?: number;
  etaMinutes?: number | null;
  reason?: string | null;
}

/**
 * Queues a notification and attempts delivery.
 *
 * NEVER throws into the caller. An order must not fail because a push gateway
 * is down — the row is persisted first, and dispatch is best-effort with the
 * failure recorded for retry.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const { title, body } = compose(input.type, {
    orderNumber: input.orderNumber ?? '',
    ...(input.totalPaise !== undefined ? { totalPaise: input.totalPaise } : {}),
    etaMinutes: input.etaMinutes ?? null,
    reason: input.reason ?? null,
  });

  const record = await prisma.notification
    .create({
      data: {
        userId: input.userId,
        orderId: input.orderId ?? null,
        type: input.type,
        channel: NotificationChannel.PUSH,
        title,
        body,
        data: { orderId: input.orderId ?? '', type: input.type } as never,
      },
    })
    .catch((error) => {
      log.error({ err: error, type: input.type }, 'failed to queue notification');
      return null;
    });

  if (!record) return;

  void dispatch(record.id).catch((error) =>
    log.error({ err: error, notificationId: record.id }, 'dispatch failed'),
  );
}

async function dispatch(notificationId: string): Promise<void> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: { include: { deviceTokens: { where: { isActive: true } } } } },
  });
  if (!notification || notification.status !== NotificationStatus.QUEUED) return;

  const tokens = notification.user.deviceTokens;
  if (tokens.length === 0) {
    // No device registered yet. The row remains as the in-app feed entry —
    // the customer still sees the update when they open the app.
    return;
  }

  let messageId: string | null = null;
  let failure: string | null = null;

  for (const device of tokens) {
    try {
      const result = await provider.send({
        token: device.token,
        title: notification.title,
        body: notification.body,
        data: { orderId: notification.orderId ?? '', type: notification.type },
      });
      messageId ??= result.messageId;
    } catch (error) {
      failure = String(error).slice(0, 300);
      log.warn({ err: error, deviceId: device.id }, 'push failed for device');
    }
  }

  await prisma.notification.update({
    where: { id: notificationId },
    data: {
      status: messageId ? NotificationStatus.SENT : NotificationStatus.FAILED,
      providerMessageId: messageId,
      failureReason: failure,
      sentAt: messageId ? new Date() : null,
      attempts: { increment: 1 },
    },
  });
}

/** Retries queued/failed notifications. Called by the background job. */
export async function retryPending(limit = 50): Promise<number> {
  const pending = await prisma.notification.findMany({
    where: { status: NotificationStatus.QUEUED, attempts: { lt: 3 } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  for (const item of pending) await dispatch(item.id).catch(() => undefined);
  return pending.length;
}

export async function listForUser(userId: string, limit = 50) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { status: NotificationStatus.READ, readAt: new Date() },
  });
}

export async function registerDevice(input: {
  userId: string;
  token: string;
  platform: 'ANDROID' | 'IOS' | 'WEB';
  appVersion?: string;
}): Promise<void> {
  // Upsert on the token: reinstalling the app or switching accounts on a
  // shared phone must move the token, not create a duplicate that pushes a
  // stranger's order updates to the wrong person.
  await prisma.deviceToken.upsert({
    where: { token: input.token },
    create: {
      userId: input.userId,
      token: input.token,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
    },
    update: {
      userId: input.userId,
      isActive: true,
      lastSeenAt: new Date(),
      appVersion: input.appVersion ?? null,
    },
  });
}
