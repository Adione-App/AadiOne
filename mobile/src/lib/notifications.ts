/**
 * In-app notification feed — types and presentation mappers.
 *
 * The shape is declared here, field-for-field from what the V2 notification
 * service actually sends (`toDto` in backend/src/modules/notifications/
 * notification.service.ts). The `NotificationDto` in `@shared` lags it — it
 * has no `audience`, `sellerId` or `isRead` — so it is deliberately not used
 * for the feed. Everything a screen needs to decide about a
 * row — its icon, its colour, where tapping it goes, how its timestamp reads —
 * is answered by the functions below, so screens never switch on `type`.
 */

import type { Ionicons } from "@expo/vector-icons";
import type { InfiniteData } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import type { CursorPage } from "@shared";
import { formatDateTimeInZone } from "@shared/datetime";
import { colors } from "@shared/theme";

/** One row of `GET /notifications` — mirrors the notification service's `toDto`. */
export interface NotificationDto {
  id: string;
  /** Backend NotificationType. Kept as `string` so a type added server-side renders with the fallback instead of breaking. */
  type: string;
  audience: "CUSTOMER" | "SELLER" | "ADMIN";
  title: string;
  body: string;
  orderId: string | null;
  sellerId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationUnreadCount {
  unread: number;
}

/** One `GET /notifications` response: `{ items, hasMore, nextCursor }`. */
export type NotificationPage = CursorPage<NotificationDto>;

/**
 * What `useInfiniteQuery` caches for the feed: every page fetched so far, in
 * order, each paired with the cursor it was fetched with (null = first page).
 */
export type NotificationFeedData = InfiniteData<NotificationPage, string | null>;

/**
 * A notifications endpoint answered 2xx with a body that is not the V2
 * contract, e.g. a V1 server, whose `GET /notifications` returns a bare array
 * of rows. Thrown from the query function, so React Query records an error
 * (the screen's error state) instead of caching a page the UI cannot read.
 */
export class NotificationResponseShapeError extends Error {
  constructor(endpoint: string) {
    super(`Unexpected response shape from ${endpoint}`);
    this.name = "NotificationResponseShapeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the fields the feed UI actually reads. */
function isNotificationDto(value: unknown): value is NotificationDto {
  if (!isRecord(value)) return false;
  const { id, type, title, body, orderId, isRead, createdAt } = value;
  return (
    typeof id === "string" &&
    typeof type === "string" &&
    typeof title === "string" &&
    typeof body === "string" &&
    (orderId === null || typeof orderId === "string") &&
    typeof isRead === "boolean" &&
    typeof createdAt === "string"
  );
}

/** Validates one feed page. The only way data enters the feed cache. */
export function parseNotificationPage(payload: unknown): NotificationPage {
  if (isRecord(payload)) {
    const { items, hasMore, nextCursor } = payload;
    if (
      Array.isArray(items) &&
      items.every(isNotificationDto) &&
      typeof hasMore === "boolean" &&
      (nextCursor === null || typeof nextCursor === "string")
    ) {
      return { items, hasMore, nextCursor };
    }
  }
  throw new NotificationResponseShapeError("GET /notifications");
}

export function parseUnreadCount(payload: unknown): NotificationUnreadCount {
  if (isRecord(payload) && typeof payload.unread === "number") {
    return { unread: payload.unread };
  }
  throw new NotificationResponseShapeError("GET /notifications/unread-count");
}

/** Page size for the feed — the server's own default. */
export const NOTIFICATION_PAGE_SIZE = 20;

type IoniconName = ComponentProps<typeof Ionicons>["name"];

export interface NotificationPresentation {
  icon: IoniconName;
  /** Icon colour. */
  tone: string;
  /** Soft background behind the icon. */
  toneSurface: string;
}

const GOOD = { tone: colors.success, toneSurface: colors.successSurface };
const BAD = { tone: colors.danger, toneSurface: colors.dangerSurface };
const INFO = { tone: colors.info, toneSurface: colors.infoSurface };
const WARN = { tone: colors.warning, toneSurface: colors.warningSurface };

/** The customer feed's notification types (backend NotificationType, CUSTOMER audience). */
const PRESENTATION: Record<string, NotificationPresentation> = {
  ORDER_PLACED: { icon: "receipt-outline", ...INFO },
  ORDER_ACCEPTED: { icon: "checkmark-circle-outline", ...GOOD },
  ORDER_REJECTED: { icon: "close-circle-outline", ...BAD },
  ORDER_PREPARING: { icon: "time-outline", ...INFO },
  ORDER_READY: { icon: "bag-check-outline", ...INFO },
  ORDER_OUT_FOR_DELIVERY: { icon: "bicycle-outline", ...INFO },
  ORDER_DELIVERED: { icon: "checkmark-done-circle-outline", ...GOOD },
  ORDER_CANCELLED: { icon: "close-circle-outline", ...BAD },
  PAYMENT_SUCCESS: { icon: "card-outline", ...GOOD },
  PAYMENT_FAILED: { icon: "alert-circle-outline", ...BAD },
  REFUND_INITIATED: { icon: "return-down-back-outline", ...WARN },
  REFUND_COMPLETED: { icon: "wallet-outline", ...GOOD },
  BACK_IN_STOCK: { icon: "cube-outline", ...GOOD },
};

const FALLBACK: NotificationPresentation = {
  icon: "notifications-outline",
  tone: colors.primary,
  toneSurface: colors.primarySurface,
};

export function presentNotification(type: string): NotificationPresentation {
  return PRESENTATION[type] ?? FALLBACK;
}

/**
 * Where tapping a notification leads. Only an order reference maps to an
 * existing screen (Order Tracking); everything else — e.g. BACK_IN_STOCK,
 * whose row carries no product id — is marked read in place.
 */
export type NotificationDestination = { screen: "OrderTracking"; orderId: string } | null;

export function notificationDestination(notification: NotificationDto): NotificationDestination {
  return notification.orderId ? { screen: "OrderTracking", orderId: notification.orderId } : null;
}

/** "Just now", "5m ago", "3h ago", "Yesterday", then the full IST date/time. */
export function formatNotificationTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return formatDateTimeInZone(at, "Asia/Kolkata");
}

/** Badge text — the count itself, capped so it fits the dot. */
export function formatUnreadBadge(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

/**
 * Flattens the feed's pages into one list, keeping the first copy of any id.
 * Cursor pages can overlap when rows share a timestamp at a page boundary, or
 * after new notifications arrive between two page loads.
 *
 * `pages` is undefined until the first page arrives (and while a first load
 * is failing); once present, every entry came through parseNotificationPage,
 * so each has an `items` array (possibly empty).
 */
export function flattenNotificationPages(
  pages: NotificationFeedData["pages"] | undefined,
): NotificationDto[] {
  const seen = new Set<string>();
  const out: NotificationDto[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
