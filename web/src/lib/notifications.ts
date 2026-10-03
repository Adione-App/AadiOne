/**
 * Notification feeds for the web panels — types, presentation mappers and
 * query hooks, shared by the admin panel (/admin/notifications) and the
 * seller panel (/seller/notifications).
 *
 * The backend's NotificationDto is not in the generated `@shared` copy this
 * panel compiles against, so its shape is declared here field-for-field.
 * Everything a bell or list needs to decide about a row (icon, tone, label,
 * where a click goes) is answered here, so components never switch on `type`.
 *
 * Each panel describes its feed as a NotificationSource — which API client
 * and path, which cache keys, where each type leads. The server scopes every
 * feed to the signed-in user (and, for sellers, their seller); nothing here
 * sends a user or seller id.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { CursorPage } from '@shared';
import { api, ApiRequestError, type ApiClient } from './api';
import { useAuth } from './auth';
import type { IconName } from '@/components/ui';

/** One notification row — mirrors the backend's NotificationDto. */
export interface NotificationDto {
  id: string;
  /** Backend NotificationType. Kept as `string` so a type added server-side renders with the fallback. */
  type: string;
  audience: 'CUSTOMER' | 'SELLER' | 'ADMIN';
  title: string;
  body: string;
  orderId: string | null;
  sellerId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

interface UnreadCount {
  unread: number;
}

type NotificationPage = CursorPage<NotificationDto>;
type NotificationFeedData = InfiniteData<NotificationPage, string | null>;

/** Same cadence as the admin sidebar's store-status poll. */
const UNREAD_POLL_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* presentation                                                                */
/* -------------------------------------------------------------------------- */

export interface NotificationPresentation {
  label: string;
  icon: IconName;
  /** Tailwind classes for the icon badge. */
  toneClass: string;
}

const NEUTRAL = 'bg-brand-50 text-brand-600';
const INFO = 'bg-info-50 text-info-500';
const WARN = 'bg-warn-50 text-warn-500';
const DANGER = 'bg-danger-50 text-danger-500';

/** Backend NotificationType values for the ADMIN and SELLER audiences. */
const PRESENTATION: Record<string, NotificationPresentation> = {
  // admin
  ADMIN_ONBOARDING_SUBMITTED: { label: 'Seller onboarding', icon: 'store', toneClass: NEUTRAL },
  ADMIN_SELLER_APPLICATION_SUBMITTED: { label: 'Seller application', icon: 'store', toneClass: NEUTRAL },
  ADMIN_PRODUCTS_SUBMITTED: { label: 'Product approval', icon: 'products', toneClass: NEUTRAL },
  ADMIN_REFUND_FAILED: { label: 'Refund issue', icon: 'alert', toneClass: DANGER },
  ADMIN_SETTLEMENT_FAILED: { label: 'Settlement failed', icon: 'rupee', toneClass: DANGER },
  // seller
  SELLER_NEW_ORDER: { label: 'New order', icon: 'orders', toneClass: NEUTRAL },
  SELLER_ORDER_CANCELLED: { label: 'Order cancelled', icon: 'orders', toneClass: DANGER },
  SELLER_ORDER_UPDATE: { label: 'Order update', icon: 'orders', toneClass: INFO },
  SELLER_REFUND_ISSUED: { label: 'Refund', icon: 'rupee', toneClass: WARN },
  SELLER_ONBOARDING_APPROVED: { label: 'Onboarding', icon: 'shield', toneClass: NEUTRAL },
  SELLER_ONBOARDING_REJECTED: { label: 'Onboarding', icon: 'shield', toneClass: DANGER },
  SELLER_ONBOARDING_CHANGES_REQUESTED: { label: 'Onboarding', icon: 'shield', toneClass: WARN },
  SELLER_APPLICATION_APPROVED: { label: 'Application', icon: 'shield', toneClass: NEUTRAL },
  SELLER_APPLICATION_REJECTED: { label: 'Application', icon: 'shield', toneClass: DANGER },
  SELLER_PRODUCT_APPROVED: { label: 'Product approval', icon: 'products', toneClass: NEUTRAL },
  SELLER_PRODUCT_REJECTED: { label: 'Product approval', icon: 'products', toneClass: DANGER },
  SELLER_SETTLEMENT_CREATED: { label: 'Settlement', icon: 'rupee', toneClass: INFO },
  SELLER_SETTLEMENT_PROCESSING: { label: 'Settlement', icon: 'rupee', toneClass: INFO },
  SELLER_SETTLEMENT_PAID: { label: 'Settlement paid', icon: 'rupee', toneClass: NEUTRAL },
  SELLER_SETTLEMENT_FAILED: { label: 'Settlement failed', icon: 'rupee', toneClass: DANGER },
};

const FALLBACK: NotificationPresentation = { label: 'Notification', icon: 'bell', toneClass: NEUTRAL };

export function presentNotification(type: string): NotificationPresentation {
  return PRESENTATION[type] ?? FALLBACK;
}

/**
 * Admin: the panel route a notification opens, or null to just mark it read.
 * Each operational type opens the page that resolves it: failed refunds and
 * settlements (filtered to failures), product submissions, seller onboarding.
 */
export function adminNotificationDestination(notification: NotificationDto): string | null {
  switch (notification.type) {
    case 'ADMIN_REFUND_FAILED':
      return '/refunds?status=FAILED';
    case 'ADMIN_PRODUCTS_SUBMITTED':
      return '/product-approvals';
    case 'ADMIN_ONBOARDING_SUBMITTED':
      return '/sellers?lifecycle=ONBOARDING_PENDING_REVIEW';
    case 'ADMIN_SELLER_APPLICATION_SUBMITTED':
      return '/sellers?view=applications';
    case 'ADMIN_SETTLEMENT_FAILED':
      return '/settlements?status=FAILED';
    default:
      return null;
  }
}

/** "Just now", "5m ago", "3h ago", "Yesterday", then the IST date/time. */
export function formatNotificationTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'Yesterday';
  return at.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatUnreadBadge(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

/** Pages flattened, first copy of each id kept — cursor pages can overlap at a timestamp boundary. */
export function flattenNotificationPages(
  pages: readonly { items: NotificationDto[] }[] | undefined,
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

/** Copy for a failed feed request — never the raw server message. */
export function notificationErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return 'Your account does not have access to notifications.';
    if (error.status === 401) return 'Your session has ended. Please sign in again.';
    return 'Could not load notifications. Please try again.';
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/* -------------------------------------------------------------------------- */
/* sources                                                                     */
/* -------------------------------------------------------------------------- */

export interface NotificationSource {
  /** The API client whose session owns this feed. */
  client: ApiClient['api'];
  /** '/admin/notifications' | '/seller/notifications' */
  basePath: string;
  feedKey: readonly unknown[];
  unreadKey: readonly unknown[];
  /** False while nobody is signed in. */
  enabled: boolean;
  pageSize: number;
  /**
   * true: read state changes on screen at once and is rolled back on error.
   * false: the row / count change only after the server confirms.
   */
  optimistic: boolean;
  destination: (notification: NotificationDto) => string | null;
  /** Rows as kept in the cache (e.g. without ids the panel never uses). */
  mapItem?: (notification: NotificationDto) => NotificationDto;
  /** Full-page list, when the panel has one. */
  viewAllHref?: string;
  /** One line for the empty state. */
  emptyHint: string;
}

/**
 * The admin panel's feed. Keyed by admin user, so a different admin signing
 * in on the same browser never sees the previous one's feed.
 */
export function useAdminNotificationSource(): NotificationSource {
  const userId = useAuth((state) => state.user?.id ?? '');
  return {
    client: api,
    basePath: '/admin/notifications',
    feedKey: ['admin-notifications', userId, 'feed'],
    unreadKey: ['admin-notifications', userId, 'unread'],
    enabled: userId !== '',
    pageSize: 20,
    optimistic: true,
    destination: adminNotificationDestination,
    viewAllHref: '/notifications',
    emptyHint: 'Seller onboarding, product approvals and payment problems will show up here.',
  };
}

/* -------------------------------------------------------------------------- */
/* queries                                                                     */
/* -------------------------------------------------------------------------- */

function mapFeedItems(
  data: NotificationFeedData | undefined,
  fn: (item: NotificationDto) => NotificationDto,
): NotificationFeedData | undefined {
  if (!data) return data;
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(fn) })) };
}

/** A 403/404 will not fix itself on a retry. */
const retryServerErrorsOnce = (count: number, error: Error) =>
  !(error instanceof ApiRequestError && error.status < 500) && count < 1;

/** The feed, cursor-paged. Fetched fresh whenever a list or dropdown mounts. */
export function useNotificationFeed(source: NotificationSource) {
  return useInfiniteQuery({
    queryKey: source.feedKey,
    queryFn: async ({ pageParam }) => {
      const query = new URLSearchParams({ limit: String(source.pageSize) });
      if (pageParam) query.set('cursor', pageParam);
      const page = await source.client.get<NotificationPage>(`${source.basePath}?${query.toString()}`);
      return source.mapItem ? { ...page, items: page.items.map(source.mapItem) } : page;
    },
    initialPageParam: null as string | null,
    // No cursor means the end of the feed — never request past it.
    getNextPageParam: (last: NotificationPage) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    enabled: source.enabled,
    refetchOnMount: 'always',
    retry: retryServerErrorsOnce,
  });
}

/** The server's unread count — never derived from the loaded list. */
export function useNotificationUnreadCount(source: NotificationSource) {
  return useQuery({
    queryKey: source.unreadKey,
    queryFn: () => source.client.get<UnreadCount>(`${source.basePath}/unread-count`),
    select: (data) => data.unread,
    enabled: source.enabled,
    refetchInterval: UNREAD_POLL_MS,
    retry: retryServerErrorsOnce,
  });
}

export function useMarkNotificationRead(source: NotificationSource) {
  const queryClient = useQueryClient();
  const { feedKey, unreadKey } = source;
  const markRow = (id: string, readAt: string) =>
    queryClient.setQueryData<NotificationFeedData>(feedKey, (data) =>
      mapFeedItems(data, (n) => (n.id === id && !n.isRead ? { ...n, isRead: true, readAt } : n)),
    );

  return useMutation({
    mutationFn: (id: string) => source.client.post<void>(`${source.basePath}/${id}/read`),
    onMutate: async (id) => {
      if (!source.optimistic) return { wasUnread: false };
      await queryClient.cancelQueries({ queryKey: unreadKey });
      const wasUnread =
        queryClient
          .getQueryData<NotificationFeedData>(feedKey)
          ?.pages.some((page) => page.items.some((n) => n.id === id && !n.isRead)) ?? false;
      markRow(id, new Date().toISOString());
      if (wasUnread) {
        queryClient.setQueryData<UnreadCount>(unreadKey, (count) =>
          count ? { unread: Math.max(0, count.unread - 1) } : count,
        );
      }
      return { wasUnread };
    },
    onSuccess: (_data, id) => {
      // Confirm-first sources show the row as read only now.
      if (!source.optimistic) markRow(id, new Date().toISOString());
    },
    onError: (error, id, context) => {
      // 404: no longer in this feed — resync instead of flipping back.
      if (error instanceof ApiRequestError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: feedKey });
        return;
      }
      if (context?.wasUnread) {
        queryClient.setQueryData<NotificationFeedData>(feedKey, (data) =>
          mapFeedItems(data, (n) => (n.id === id ? { ...n, isRead: false, readAt: null } : n)),
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: unreadKey });
    },
  });
}

export function useMarkAllNotificationsRead(source: NotificationSource) {
  const queryClient = useQueryClient();
  const { feedKey, unreadKey } = source;

  return useMutation({
    mutationFn: () => source.client.post<{ updated: number }>(`${source.basePath}/read-all`),
    onMutate: async () => {
      if (!source.optimistic) return { unreadIds: new Set<string>() };
      await queryClient.cancelQueries({ queryKey: unreadKey });
      const unreadIds = new Set<string>();
      for (const page of queryClient.getQueryData<NotificationFeedData>(feedKey)?.pages ?? []) {
        for (const n of page.items) if (!n.isRead) unreadIds.add(n.id);
      }
      const readAt = new Date().toISOString();
      queryClient.setQueryData<NotificationFeedData>(feedKey, (data) =>
        mapFeedItems(data, (n) => (n.isRead ? n : { ...n, isRead: true, readAt })),
      );
      queryClient.setQueryData<UnreadCount>(unreadKey, { unread: 0 });
      return { unreadIds };
    },
    onError: (_error, _vars, context) => {
      // Only the rows this call flipped go back to unread; the count is
      // re-fetched in onSettled.
      const unreadIds = context?.unreadIds;
      if (!unreadIds || unreadIds.size === 0) return;
      queryClient.setQueryData<NotificationFeedData>(feedKey, (data) =>
        mapFeedItems(data, (n) => (unreadIds.has(n.id) ? { ...n, isRead: false, readAt: null } : n)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: unreadKey });
      // Confirm-first sources re-read the list from the server as well.
      if (!source.optimistic) void queryClient.invalidateQueries({ queryKey: feedKey });
    },
  });
}
