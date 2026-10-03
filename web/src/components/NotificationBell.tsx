/**
 * Top-bar bell: unread badge plus a dropdown feed — used by both the admin
 * panel and the seller panel, each passing its own NotificationSource.
 *
 * The feed is fetched only while the dropdown is open; the badge polls on its
 * own (the server's count, never derived from the list). A row click marks it
 * read (once — rows already read, or with a request in flight, send nothing)
 * and navigates only when the notification has a page in the panel (see the
 * source's `destination`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/ui';
import {
  flattenNotificationPages,
  formatNotificationTime,
  formatUnreadBadge,
  notificationErrorMessage,
  presentNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationFeed,
  useNotificationUnreadCount,
  type NotificationDto,
  type NotificationSource,
} from '@/lib/notifications';

export function NotificationBell({ source }: { source: NotificationSource }) {
  const [open, setOpen] = useState(false);
  const unread = useNotificationUnreadCount(source);
  const count = unread.data ?? 0;
  const { pathname } = useLocation();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Navigating anywhere closes the dropdown.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative rounded-lg p-2.5 text-gray-500 transition hover:bg-gray-100"
      >
        <Icon name="bell" />
        {count > 0 && (
          <span className="absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger-500 px-1 text-[10px] font-bold leading-none text-white">
            {formatUnreadBadge(count)}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            className="fixed inset-0 z-10 cursor-default"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
          />
          <NotificationPanel source={source} unreadCount={count} onClose={() => setOpen(false)} />
        </>
      )}
    </div>
  );
}

/**
 * What clicking a row does: mark it read (once) and open its page, if any.
 * Shared by the dropdown and the seller's full Notifications page.
 */
export function useOpenNotification(source: NotificationSource, beforeNavigate?: () => void) {
  const navigate = useNavigate();
  const markRead = useMarkNotificationRead(source);
  /** Ids with a read request in flight — a double click must not send two. */
  const pendingReads = useRef(new Set<string>());

  const open = useCallback(
    (item: NotificationDto) => {
      if (!item.isRead && !pendingReads.current.has(item.id)) {
        pendingReads.current.add(item.id);
        markRead
          .mutateAsync(item.id)
          .catch(() => undefined)
          .finally(() => pendingReads.current.delete(item.id));
      }
      const destination = source.destination(item);
      if (destination) {
        beforeNavigate?.();
        navigate(destination);
      }
    },
    [markRead, navigate, source, beforeNavigate],
  );

  return { open, markRead };
}

function NotificationPanel({
  source,
  unreadCount,
  onClose,
}: {
  source: NotificationSource;
  unreadCount: number;
  onClose: () => void;
}) {
  const feed = useNotificationFeed(source);
  const markAllRead = useMarkAllNotificationsRead(source);
  const { open: openItem } = useOpenNotification(source, onClose);

  const items = useMemo(() => flattenNotificationPages(feed.data?.pages), [feed.data]);
  const hasUnread = unreadCount > 0 || items.some((n) => !n.isRead);

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 z-20 mt-2 flex max-h-[32rem] w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <p className="text-sm font-semibold text-gray-900">Notifications</p>
        {items.length > 0 && hasUnread && (
          <button
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="text-xs font-semibold text-brand-600 transition hover:text-brand-700 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            {markAllRead.isPending ? 'Marking…' : 'Mark all read'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {feed.isPending ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
            Loading notifications…
          </div>
        ) : feed.isError && items.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-gray-600">{notificationErrorMessage(feed.error)}</p>
            <button
              onClick={() => void feed.refetch()}
              className="mt-3 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-700">You're all caught up</p>
            <p className="mt-1 text-xs text-gray-500">{source.emptyHint}</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items.map((item) => (
              <NotificationRow key={item.id} item={item} destination={source.destination(item)} onOpen={openItem} />
            ))}
          </ul>
        )}

        {feed.hasNextPage && (
          <div className="border-t border-gray-100 px-4 py-2.5 text-center">
            {feed.isFetchNextPageError && (
              <p className="mb-1.5 text-xs text-danger-600">Could not load more.</p>
            )}
            <button
              onClick={() => void feed.fetchNextPage()}
              disabled={feed.isFetchingNextPage}
              className="text-xs font-semibold text-brand-600 transition hover:text-brand-700 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              {feed.isFetchingNextPage
                ? 'Loading…'
                : feed.isFetchNextPageError
                  ? 'Try again'
                  : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {source.viewAllHref && (
        <div className="border-t border-gray-100 px-4 py-2.5 text-center">
          <Link to={source.viewAllHref} className="text-sm font-semibold text-brand-600 hover:text-brand-700">
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * "/seller/earnings" -> "Open earnings"; "/product-approvals" -> "Open product
 * approvals"; "/seller/orders?order=…" -> "Open order" (the query never shows).
 */
function openLabel(destination: string): string {
  const [path = '', query = ''] = destination.split('?');
  if (/(^|&)order=/.test(query)) return 'Open order';
  return `Open ${(path.split('/').filter(Boolean).at(-1) ?? 'page').replace(/-/g, ' ')}`;
}

export function NotificationRow({
  item,
  destination,
  onOpen,
}: {
  item: NotificationDto;
  destination: string | null;
  onOpen: (item: NotificationDto) => void;
}) {
  const look = presentNotification(item.type);
  return (
    <li>
      <button
        onClick={() => onOpen(item)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-gray-50 ${
          item.isRead ? '' : 'bg-brand-50/50'
        }`}
      >
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${look.toneClass}`}>
          <Icon name={look.icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block text-sm leading-snug text-gray-900 ${item.isRead ? 'font-medium' : 'font-semibold'}`}
          >
            {item.title}
          </span>
          <span className="mt-0.5 line-clamp-3 block text-sm text-gray-600">{item.body}</span>
          <span className="mt-1 block text-xs text-gray-400">
            {look.label} · {formatNotificationTime(item.createdAt)}
            {destination && <span className="text-brand-600"> · {openLabel(destination)}</span>}
          </span>
        </span>
        {!item.isRead && (
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />
        )}
      </button>
    </li>
  );
}
