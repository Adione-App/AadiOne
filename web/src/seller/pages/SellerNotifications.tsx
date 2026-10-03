/**
 * All of the seller's notifications — the same feed and cache as the header
 * bell (shared hooks in lib/notifications.ts), grouped by kind (Orders,
 * Products, Payments, Settlements, System) and by day. Opening a row marks
 * it read and goes to its order / page; "Mark read" marks it without
 * leaving; "Mark all as read" clears everything. Read state changes only
 * after the server confirms; the unread count is always the server's.
 */

import { useMemo, useRef, useState } from 'react';
import { Button, ErrorBanner, Icon, Surface } from '@/components/ui';
import { useOpenNotification } from '@/components/NotificationBell';
import {
  flattenNotificationPages,
  formatNotificationTime,
  notificationErrorMessage,
  presentNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationFeed,
  useNotificationUnreadCount,
  type NotificationDto,
} from '@/lib/notifications';
import { NOTIFICATION_GROUPS, notificationGroup, useSellerNotificationSource, type NotificationGroup } from '../sellerNotifications';
import { ChipTabs, EmptyPanel, LoadError, SkeletonList, toast } from '../sellerUi';

type Filter = 'ALL' | 'UNREAD' | NotificationGroup;

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' });
const fullTime = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function dayHeading(iso: string, now = new Date()): string {
  const key = dayKey.format(new Date(iso));
  if (key === dayKey.format(now)) return 'Today';
  if (key === dayKey.format(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return dayLabel.format(new Date(iso));
}

export default function SellerNotificationsPage() {
  const source = useSellerNotificationSource();
  const feed = useNotificationFeed(source);
  const unread = useNotificationUnreadCount(source);
  const markAll = useMarkAllNotificationsRead(source);
  const markOne = useMarkNotificationRead(source);
  const { open } = useOpenNotification(source);
  const [filter, setFilter] = useState<Filter>('ALL');
  /** Ids with a "Mark read" request in flight — a double click sends one. */
  const marking = useRef(new Set<string>());

  const items = useMemo(() => flattenNotificationPages(feed.data?.pages), [feed.data]);
  const unreadCount = unread.data ?? 0;
  const visible = items.filter((item) =>
    filter === 'ALL' ? true : filter === 'UNREAD' ? !item.isRead : notificationGroup(item.type) === filter,
  );
  const sections = useMemo(() => {
    const out: { heading: string; items: NotificationDto[] }[] = [];
    for (const item of visible) {
      const heading = dayHeading(item.createdAt);
      const last = out[out.length - 1];
      if (last && last.heading === heading) last.items.push(item);
      else out.push({ heading, items: [item] });
    }
    return out;
  }, [visible]);

  function markRead(item: NotificationDto): void {
    if (item.isRead || marking.current.has(item.id)) return;
    marking.current.add(item.id);
    markOne.mutate(item.id, { onSettled: () => marking.current.delete(item.id) });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600" aria-live="polite">
          {unread.isPending ? 'Checking…' : unreadCount === 0 ? 'All caught up' : `${unreadCount} unread`}
        </p>
        <Button
          variant="secondary"
          disabled={unreadCount === 0 || markAll.isPending}
          onClick={() => markAll.mutate(undefined, { onSuccess: () => toast('All notifications marked as read.') })}
        >
          {markAll.isPending ? 'Marking…' : 'Mark all as read'}
        </Button>
      </div>

      <ChipTabs
        label="Notification type"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'ALL' as Filter, label: 'All' },
          { value: 'UNREAD' as Filter, label: 'Unread', count: unread.data ?? null },
          ...NOTIFICATION_GROUPS.map((group) => ({
            value: group.value as Filter,
            label: group.label,
            count: items.length ? items.filter((item) => notificationGroup(item.type) === group.value).length : null,
          })),
        ]}
      />

      {markAll.isError && <ErrorBanner message={notificationErrorMessage(markAll.error)} />}
      {markOne.isError && <ErrorBanner message="Could not mark that notification as read. Please try again." />}

      {feed.isPending ? (
        <SkeletonList rows={4} label="Loading notifications…" />
      ) : feed.isError && items.length === 0 ? (
        <LoadError message={notificationErrorMessage(feed.error)} onRetry={() => void feed.refetch()} />
      ) : visible.length === 0 ? (
        <EmptyPanel
          icon="bell"
          title={items.length === 0 ? 'No notifications yet' : filter === 'UNREAD' ? 'No unread notifications' : 'Nothing here yet'}
          hint={items.length === 0 ? source.emptyHint : feed.hasNextPage ? 'Older notifications may match — load more below.' : undefined}
        />
      ) : (
        <div className="space-y-4">
          {sections.map((section) => (
            <section key={section.heading} aria-label={section.heading}>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{section.heading}</h2>
              <Surface className="overflow-hidden">
                <ul className="divide-y divide-gray-100">
                  {section.items.map((item) => {
                    const look = presentNotification(item.type);
                    const group = NOTIFICATION_GROUPS.find((g) => g.value === notificationGroup(item.type))!;
                    const destination = source.destination(item);
                    return (
                      <li key={item.id} className={`flex items-start gap-1 ${item.isRead ? '' : 'bg-brand-50/50'}`}>
                        <button
                          type="button"
                          onClick={() => open(item)}
                          className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left outline-none transition hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
                        >
                          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${look.toneClass}`}>
                            <Icon name={look.icon} className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`block text-sm leading-snug text-gray-900 ${item.isRead ? 'font-medium' : 'font-semibold'}`}>
                              {!item.isRead && <span className="sr-only">Unread: </span>}
                              {item.title}
                            </span>
                            <span className="mt-0.5 line-clamp-3 block text-sm text-gray-600">{item.body}</span>
                            <span className="mt-1 block text-xs text-gray-400">
                              {group.label} · <time dateTime={item.createdAt} title={fullTime.format(new Date(item.createdAt))}>{formatNotificationTime(item.createdAt)}</time>
                              {destination && <span className="text-brand-600"> · {destination.startsWith('/seller/orders?') ? 'Open order' : 'Open'}</span>}
                            </span>
                          </span>
                        </button>
                        {!item.isRead && (
                          <button
                            type="button"
                            onClick={() => markRead(item)}
                            disabled={markOne.isPending && markOne.variables === item.id}
                            aria-label={`Mark "${item.title}" as read`}
                            className="m-2 shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-600 outline-none hover:bg-brand-100 focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-50"
                          >
                            Mark read
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Surface>
            </section>
          ))}
        </div>
      )}

      {feed.hasNextPage && (
        <div className="text-center">
          {feed.isFetchNextPageError && <p className="mb-2 text-xs text-danger-600">Could not load more.</p>}
          <Button variant="secondary" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? 'Loading…' : feed.isFetchNextPageError ? 'Try again' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
