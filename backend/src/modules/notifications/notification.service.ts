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
 *
 * V2: three FEEDS on the one table, by `audience` — CUSTOMER (the shopping
 * app), SELLER (a seller panel; rows also carry `sellerId`) and ADMIN.
 * Every business event carries a deterministic `dedupeKey`, UNIQUE per user,
 * so a repeated/retried operation never notifies the same person twice.
 */

import jwt from 'jsonwebtoken';
import {
  ADMIN_PANEL_ROLES,
  ErrorCode,
  NotificationAudience,
  NotificationChannel,
  NotificationStatus,
  NotificationType,
  ROLE_PERMISSIONS,
  type CursorPage,
  type Permission,
} from '../../shared';
import { AppError } from '../../common/errors';
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

export interface NotifyContext {
  orderNumber?: string;
  totalPaise?: number;
  amountPaise?: number;
  etaMinutes?: number | null;
  reason?: string | null;
  sellerName?: string;
  productName?: string;
  status?: string;
  count?: number;
}

/**
 * User-facing copy per event.
 *
 * Short, concrete, no jargon — these arrive as a phone banner and are read by
 * first-time smartphone users (customers) or busy shop staff (sellers).
 */
function compose(type: NotificationType, c: NotifyContext): { title: string; body: string } {
  const order = c.orderNumber ?? '';
  const seller = c.sellerName ?? 'The store';
  const money = (paise?: number) => (paise !== undefined ? formatPaise(paise) : '');
  switch (type) {
    /* --- customer --------------------------------------------------------- */
    case NotificationType.ORDER_PLACED:
      return { title: 'Order placed', body: `We have received your order ${order}.` };
    case NotificationType.ORDER_ACCEPTED:
      return {
        title: 'Order confirmed',
        body: c.etaMinutes
          ? `${seller} is preparing your order. Arriving in about ${c.etaMinutes} mins.`
          : `${seller} has confirmed your order ${order}.`,
      };
    case NotificationType.ORDER_PREPARING:
      return { title: 'Preparing your order', body: `${seller} is preparing your order ${order}.` };
    case NotificationType.ORDER_READY:
      return { title: 'Order packed', body: `Your items from ${seller} are ready and waiting for a delivery partner.` };
    case NotificationType.ORDER_OUT_FOR_DELIVERY:
      return { title: 'Out for delivery', body: 'Your order is on the way. Please keep your phone nearby.' };
    case NotificationType.ORDER_DELIVERED:
      return { title: 'Delivered', body: `Your order ${order} has been delivered. Thank you!` };
    case NotificationType.ORDER_CANCELLED:
      return {
        title: 'Order cancelled',
        body: c.reason ? `Your order ${order} was cancelled: ${c.reason}` : `Your order ${order} was cancelled.`,
      };
    case NotificationType.ORDER_REJECTED:
      return {
        title: 'Order could not be accepted',
        body: `${seller} could not accept your order.${c.reason ? ` ${c.reason}.` : ''} Any payment for it will be refunded.`,
      };
    case NotificationType.PAYMENT_FAILED:
      return {
        title: 'Payment failed',
        body: 'Your payment did not go through. No money has been deducted, or it will be refunded.',
      };
    case NotificationType.PAYMENT_SUCCESS:
      return { title: 'Payment received', body: c.totalPaise ? `We received ${money(c.totalPaise)} for order ${order}.` : 'Payment received.' };
    case NotificationType.REFUND_INITIATED:
      return { title: 'Refund started', body: `Your refund of ${money(c.amountPaise)} for order ${order} has been started.` };
    case NotificationType.REFUND_COMPLETED:
      return { title: 'Refund complete', body: `${money(c.amountPaise)} for order ${order} has been refunded.` };
    case NotificationType.BACK_IN_STOCK:
      return { title: 'Back in stock', body: 'An item you wanted is available again.' };

    /* --- seller ----------------------------------------------------------- */
    case NotificationType.SELLER_NEW_ORDER:
      return { title: 'New order', body: `New order ${order} — ${money(c.amountPaise)}. Please accept it.` };
    case NotificationType.SELLER_ORDER_CANCELLED:
      return { title: 'Order cancelled', body: `Order ${order} was cancelled${c.reason ? `: ${c.reason}` : '.'}` };
    case NotificationType.SELLER_ORDER_UPDATE:
      return { title: 'Order update', body: `Order ${order} is now ${String(c.status ?? '').toLowerCase().replace(/_/g, ' ')}.` };
    case NotificationType.SELLER_REFUND_ISSUED:
      return { title: 'Refund issued', body: `${money(c.amountPaise)} was refunded to the customer for your cancelled order ${order}.` };
    case NotificationType.SELLER_ONBOARDING_APPROVED:
      return { title: 'You are approved', body: 'Your seller account has been approved. You can start selling.' };
    case NotificationType.SELLER_ONBOARDING_REJECTED:
      return { title: 'Seller account not approved', body: `Your seller onboarding was not approved${c.reason ? `: ${c.reason}` : '.'}` };
    case NotificationType.SELLER_ONBOARDING_CHANGES_REQUESTED:
      return { title: 'Onboarding needs changes', body: `Please update your onboarding and resubmit${c.reason ? `: ${c.reason}` : '.'}` };
    case NotificationType.SELLER_APPLICATION_APPROVED:
      return { title: 'Application approved', body: 'Your seller application is approved. Complete your seller onboarding to start selling.' };
    case NotificationType.SELLER_APPLICATION_REJECTED:
      return { title: 'Application not approved', body: `Your seller application was not approved${c.reason ? `: ${c.reason}` : '.'}` };
    case NotificationType.SELLER_PRODUCT_APPROVED:
      return c.count
        ? { title: 'Products approved', body: `${c.count} product${c.count === 1 ? ' is' : 's are'} approved and now live for customers (when in stock).` }
        : { title: 'Product approved', body: `"${c.productName ?? 'Your product'}" is approved and now live for customers (when in stock).` };
    case NotificationType.SELLER_PRODUCT_REJECTED:
      return { title: 'Product not approved', body: `"${c.productName ?? 'Your product'}" was not approved${c.reason ? `: ${c.reason}` : '.'}` };
    case NotificationType.SELLER_SETTLEMENT_CREATED:
      return { title: 'Settlement created', body: `A settlement of ${money(c.amountPaise)} has been created for you.` };
    case NotificationType.SELLER_SETTLEMENT_PROCESSING:
      return { title: 'Payout in progress', body: `Your payout of ${money(c.amountPaise)} is being processed.` };
    case NotificationType.SELLER_SETTLEMENT_PAID:
      return { title: 'Payout sent', body: `${money(c.amountPaise)} has been paid to your bank account.` };
    case NotificationType.SELLER_SETTLEMENT_FAILED:
      return { title: 'Payout failed', body: `Your payout of ${money(c.amountPaise)} failed. AdiOne will retry it.` };

    /* --- admin ------------------------------------------------------------ */
    case NotificationType.ADMIN_ONBOARDING_SUBMITTED:
      return { title: 'Seller onboarding to review', body: `${seller} submitted onboarding for review.` };
    case NotificationType.ADMIN_SELLER_APPLICATION_SUBMITTED:
      return { title: 'New seller application', body: `${seller} applied to sell on Aadione.` };
    case NotificationType.ADMIN_PRODUCTS_SUBMITTED:
      return { title: 'Products to review', body: `${seller} submitted ${c.count ?? 1} product(s) for approval.` };
    case NotificationType.ADMIN_REFUND_FAILED:
      return { title: 'Refund needs attention', body: `A ${money(c.amountPaise)} refund on order ${order} ${c.reason ?? 'failed'}.` };
    case NotificationType.ADMIN_SETTLEMENT_FAILED:
      return { title: 'Payout failed', body: `The ${money(c.amountPaise)} payout to ${seller} failed and needs a retry.` };
    default:
      return { title: 'Update', body: order ? `There is an update on your order ${order}.` : 'There is an update for you.' };
  }
}

/* -------------------------------------------------------------------------- */
/* Queueing — with duplicate protection                                       */
/* -------------------------------------------------------------------------- */

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  /**
   * Deterministic identity of the business event, e.g. `so:<id>:ACCEPTED`.
   * UNIQUE per user (`notifications_user_id_dedupe_key_key`): a retried or
   * repeated operation that produces the same key notifies nobody twice.
   */
  dedupeKey: string;
  audience?: NotificationAudience;
  /** Required for SELLER audience (DB CHECK `notifications_seller_scope`). */
  sellerId?: string | null;
  orderId?: string | null;
  context?: NotifyContext;
}

/**
 * Queues a notification and attempts delivery. Returns false when the event
 * was already notified to this user (duplicate suppressed) or queueing failed.
 *
 * NEVER throws into the caller. An order must not fail because a push gateway
 * is down — the row is persisted first, and dispatch is best-effort with the
 * failure recorded for retry.
 */
export async function notify(input: NotifyInput): Promise<boolean> {
  const { title, body } = compose(input.type, input.context ?? {});
  const audience = input.audience ?? NotificationAudience.CUSTOMER;

  // The ordinary repeat (a retried operation) is caught here quietly; the
  // unique index is the backstop for two truly concurrent first attempts.
  const existing = await prisma.notification
    .findUnique({ where: { userId_dedupeKey: { userId: input.userId, dedupeKey: input.dedupeKey } }, select: { id: true } })
    .catch(() => null);
  if (existing) {
    log.debug({ type: input.type, dedupeKey: input.dedupeKey }, 'duplicate notification suppressed');
    return false;
  }

  let recordId: string | null = null;
  try {
    const record = await prisma.notification.create({
      data: {
        userId: input.userId,
        orderId: input.orderId ?? null,
        type: input.type,
        audience,
        sellerId: audience === NotificationAudience.SELLER ? (input.sellerId ?? null) : null,
        dedupeKey: input.dedupeKey,
        channel: NotificationChannel.PUSH,
        title,
        body,
        data: { orderId: input.orderId ?? '', type: input.type, audience } as never,
      },
      select: { id: true },
    });
    recordId = record.id;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      log.debug({ type: input.type, dedupeKey: input.dedupeKey }, 'duplicate notification suppressed');
    } else {
      log.error({ err: error, type: input.type }, 'failed to queue notification');
    }
    return false;
  }

  void dispatch(recordId).catch((error) => log.error({ err: error, notificationId: recordId }, 'dispatch failed'));
  return true;
}

type FanOutInput = Omit<NotifyInput, 'userId' | 'audience' | 'sellerId'>;

/** Every active staff user of one seller, on that seller's SELLER feed. */
export async function notifySeller(sellerId: string, input: FanOutInput): Promise<void> {
  try {
    const staff = await prisma.sellerStaff.findMany({
      where: { sellerId, isActive: true, deletedAt: null, user: { deletedAt: null, status: 'ACTIVE' } },
      select: { userId: true },
    });
    for (const { userId } of staff) {
      await notify({ ...input, userId, audience: NotificationAudience.SELLER, sellerId });
    }
  } catch (error) {
    log.error({ err: error, sellerId, type: input.type }, 'seller notification fan-out failed');
  }
}

/** Admin-panel users whose role holds `permission` — the same rule that
 * decides whether they may act on the event. */
export async function notifyAdmins(permission: Permission, input: FanOutInput): Promise<void> {
  try {
    const roles = ADMIN_PANEL_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
    const admins = await prisma.user.findMany({
      where: { role: { in: [...roles] }, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const { id } of admins) {
      await notify({ ...input, userId: id, audience: NotificationAudience.ADMIN });
    }
  } catch (error) {
    log.error({ err: error, permission, type: input.type }, 'admin notification fan-out failed');
  }
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
    // the user still sees the update when they open the app/panel.
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
        data: { orderId: notification.orderId ?? '', type: notification.type, audience: notification.audience },
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

/* -------------------------------------------------------------------------- */
/* Feeds — always scoped to (user, audience[, seller])                        */
/* -------------------------------------------------------------------------- */

export interface FeedScope {
  userId: string;
  audience: NotificationAudience;
  /** SELLER feeds only: the seller the request acts as. */
  sellerId?: string;
}

const scopeWhere = (scope: FeedScope) => ({
  userId: scope.userId,
  audience: scope.audience,
  ...(scope.audience === NotificationAudience.SELLER ? { sellerId: scope.sellerId ?? '00000000-0000-0000-0000-000000000000' } : {}),
});

function toDto(n: {
  id: string;
  type: NotificationType;
  audience: NotificationAudience;
  title: string;
  body: string;
  orderId: string | null;
  sellerId: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    type: n.type,
    audience: n.audience,
    title: n.title,
    body: n.body,
    orderId: n.orderId,
    sellerId: n.sellerId,
    isRead: n.readAt !== null,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function listFeed(
  scope: FeedScope,
  options: { cursor?: string | null; limit: number; unreadOnly?: boolean },
): Promise<CursorPage<ReturnType<typeof toDto>>> {
  const rows = await prisma.notification.findMany({
    where: {
      ...scopeWhere(scope),
      ...(options.unreadOnly ? { readAt: null } : {}),
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toDto),
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

export async function unreadCount(scope: FeedScope): Promise<{ unread: number }> {
  return { unread: await prisma.notification.count({ where: { ...scopeWhere(scope), readAt: null } }) };
}

/** Idempotent; another user's (or feed's) notification is reported exactly
 * like a missing one. */
export async function markRead(scope: FeedScope, notificationId: string): Promise<void> {
  const { count } = await prisma.notification.updateMany({
    where: { id: notificationId, ...scopeWhere(scope), readAt: null },
    data: { readAt: new Date() },
  });
  if (count === 0) {
    const exists = await prisma.notification.count({ where: { id: notificationId, ...scopeWhere(scope) } });
    if (exists === 0) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Notification not found.' });
  }
}

export async function markAllRead(scope: FeedScope): Promise<{ updated: number }> {
  const { count } = await prisma.notification.updateMany({
    where: { ...scopeWhere(scope), readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: count };
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
