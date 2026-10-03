/**
 * The seller panel's notification feed (GET /seller/notifications and its
 * unread-count / read / read-all siblings), plugged into the shared
 * notification hooks and bell (lib/notifications.ts).
 *
 * The server scopes the feed to the signed-in user AND their seller; nothing
 * here sends a seller id. Cache keys sit under the seller query root and the
 * seller user's id, so signing out (which drops every seller query) clears
 * them, and a different seller signing in never sees the previous feed.
 */

import type { NotificationDto, NotificationSource } from '@/lib/notifications';
import type { IconName } from '@/components/ui';
import { SELLER_QUERY_ROOT, sellerApi } from './sellerApi';
import { useSellerAuth } from './sellerAuth';

export type NotificationGroup = 'ORDERS' | 'PRODUCTS' | 'PAYMENTS' | 'SETTLEMENTS' | 'SYSTEM';

export const NOTIFICATION_GROUPS: { value: NotificationGroup; label: string; icon: IconName }[] = [
  { value: 'ORDERS', label: 'Orders', icon: 'orders' },
  { value: 'PRODUCTS', label: 'Products', icon: 'products' },
  { value: 'PAYMENTS', label: 'Payments', icon: 'rupee' },
  { value: 'SETTLEMENTS', label: 'Settlements', icon: 'clipboard' },
  { value: 'SYSTEM', label: 'System', icon: 'shield' },
];

/** Which group a backend NotificationType belongs to; unknown types are System. */
export function notificationGroup(type: string): NotificationGroup {
  switch (type) {
    case 'SELLER_NEW_ORDER':
    case 'SELLER_ORDER_CANCELLED':
    case 'SELLER_ORDER_UPDATE':
      return 'ORDERS';
    case 'SELLER_PRODUCT_APPROVED':
    case 'SELLER_PRODUCT_REJECTED':
      return 'PRODUCTS';
    case 'SELLER_REFUND_ISSUED':
      return 'PAYMENTS';
    case 'SELLER_SETTLEMENT_CREATED':
    case 'SELLER_SETTLEMENT_PROCESSING':
    case 'SELLER_SETTLEMENT_PAID':
    case 'SELLER_SETTLEMENT_FAILED':
      return 'SETTLEMENTS';
    default:
      return 'SYSTEM';
  }
}

/**
 * Where a seller notification leads — a fixed Seller Panel page, chosen by
 * its backend type. An order notification opens that one order: the parent
 * order id is only ever sent back as a filter on GET /seller/orders, which
 * the server scopes to this seller (another seller's id finds nothing).
 * Unknown types stay on the list (they are only marked read).
 */
export function sellerNotificationDestination(notification: NotificationDto): string | null {
  const order = notification.orderId ? `/seller/orders?tab=ALL&order=${encodeURIComponent(notification.orderId)}` : '/seller/orders';
  switch (notification.type) {
    case 'SELLER_NEW_ORDER':
    case 'SELLER_ORDER_CANCELLED':
    case 'SELLER_ORDER_UPDATE':
    case 'SELLER_REFUND_ISSUED':
      return order;
    case 'SELLER_PRODUCT_APPROVED':
      return '/seller/products?view=APPROVED';
    case 'SELLER_PRODUCT_REJECTED':
      return '/seller/products?view=REJECTED';
    case 'SELLER_ONBOARDING_APPROVED':
    case 'SELLER_ONBOARDING_REJECTED':
      return '/seller/profile';
    case 'SELLER_SETTLEMENT_CREATED':
    case 'SELLER_SETTLEMENT_PROCESSING':
    case 'SELLER_SETTLEMENT_PAID':
    case 'SELLER_SETTLEMENT_FAILED':
      return '/seller/settlements';
    default:
      return null;
  }
}

/** The seller id is never used by the seller panel — not kept in the cache. */
const stripSellerId = (notification: NotificationDto): NotificationDto => ({ ...notification, sellerId: null });

export function useSellerNotificationSource(): NotificationSource {
  const userId = useSellerAuth((state) => state.user?.id ?? '');
  return {
    client: sellerApi,
    basePath: '/seller/notifications',
    feedKey: [SELLER_QUERY_ROOT, 'notifications', userId, 'feed'],
    unreadKey: [SELLER_QUERY_ROOT, 'notifications', userId, 'unread'],
    enabled: userId !== '',
    pageSize: 10,
    // Read state changes only once the server confirms it.
    optimistic: false,
    destination: sellerNotificationDestination,
    mapItem: stripSellerId,
    viewAllHref: '/seller/notifications',
    emptyHint: 'New orders, product approvals, onboarding and settlement updates will show up here.',
  };
}
