/**
 * Notifications — the admin's platform-wide operational feed (seller
 * onboarding, product submissions, refund and settlement problems), the same
 * feed and cache as the header bell (lib/notifications.ts). Opening a row
 * marks it read and goes to its page when there is one.
 */

import { useMemo } from 'react';
import { Button, ErrorBanner, Surface } from '@/components/ui';
import { NotificationRow, useOpenNotification } from '@/components/NotificationBell';
import {
  flattenNotificationPages,
  notificationErrorMessage,
  useAdminNotificationSource,
  useMarkAllNotificationsRead,
  useNotificationFeed,
  useNotificationUnreadCount,
} from '@/lib/notifications';
import { EmptyPanel, LoadError, SkeletonList } from '@/seller/sellerUi';

export default function NotificationsPage() {
  const source = useAdminNotificationSource();
  const feed = useNotificationFeed(source);
  const unread = useNotificationUnreadCount(source);
  const markAll = useMarkAllNotificationsRead(source);
  const { open } = useOpenNotification(source);
  const items = useMemo(() => flattenNotificationPages(feed.data?.pages), [feed.data]);
  const unreadCount = unread.data ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600" aria-live="polite">
          {unread.isPending ? 'Checking…' : unreadCount === 0 ? 'All caught up' : `${unreadCount} unread`}
        </p>
        <Button variant="secondary" disabled={unreadCount === 0 || markAll.isPending} onClick={() => markAll.mutate()}>
          {markAll.isPending ? 'Marking…' : 'Mark all as read'}
        </Button>
      </div>
      {markAll.isError && <ErrorBanner message={notificationErrorMessage(markAll.error)} />}

      {feed.isPending ? (
        <SkeletonList rows={5} label="Loading notifications…" />
      ) : feed.isError && items.length === 0 ? (
        <LoadError message={notificationErrorMessage(feed.error)} onRetry={() => void feed.refetch()} />
      ) : items.length === 0 ? (
        <EmptyPanel icon="bell" title="No notifications yet" hint={source.emptyHint} />
      ) : (
        <Surface className="overflow-hidden">
          <ul className="divide-y divide-gray-100">
            {items.map((item) => (
              <NotificationRow key={item.id} item={item} destination={source.destination(item)} onOpen={open} />
            ))}
          </ul>
          {feed.hasNextPage && (
            <div className="border-t border-gray-100 p-3 text-center">
              <Button variant="secondary" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </Surface>
      )}
    </div>
  );
}
