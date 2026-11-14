/**
 * The admin "NEW ORDER" popups — a stack on the right, one card per unread
 * new order (GET /admin/order-alerts, read state per admin on the server).
 *
 *   - A card stays until the admin closes it (×). Closing hides the popup
 *     only: the order stays unread (the Orders badge still counts it) and
 *     "Show N hidden" brings closed ones back.
 *   - "View order" opens it on the Orders page and marks it read for this
 *     admin — the card and the badge then drop by one.
 *   - A short sound for a genuinely new order only — never again for the same
 *     order after a reload or reconnect (lib/orderAlertState.ts).
 *   - Re-read on every realtime "order.created", every socket (re)connect,
 *     the browser coming back online, the tab becoming visible, window focus
 *     and a 30 s timer (lib/orderAlerts.ts) — a missed event is recovered by
 *     the next read.
 *
 * Mounted once for admins who can read orders (App.tsx).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Permission, roleHasPermission, type AdminOrderAlertDto } from '@shared';
import { useAuth } from '@/lib/auth';
import { formatPaise } from '@shared/money';
import { imageSrc } from '@/lib/image';
import { adminOrderTabOf } from '@/lib/v2Orders';
import { playChime } from '@/lib/chime';
import { useOrderSocket } from '@/lib/socket';
import { orderAlertsKey, useMarkOrderRead, useOrderAlerts } from '@/lib/orderAlerts';
import { announce, dismissedKey, popupsOf, prune, readIds, seenKey, writeIds } from '@/lib/orderAlertState';
import { Icon } from './ui';
import { confirmLeave } from '@/lib/unsavedChanges';

/** Cards on screen at once; the rest wait behind "+N more". */
const MAX_CARDS = 4;

const paymentLabel = (alert: AdminOrderAlertDto) => (alert.paymentMethod === 'COD' ? 'COD (Cash on Delivery)' : 'Online Payment');

function paymentStatusLabel(alert: AdminOrderAlertDto): string {
  if (alert.paymentMethod === 'COD') return alert.paymentStatus === 'PAID' ? 'Collected' : 'To collect on delivery';
  return alert.paymentStatus === 'PAID' ? 'Paid' : alert.paymentStatus.charAt(0) + alert.paymentStatus.slice(1).toLowerCase().replace(/_/g, ' ');
}

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function Thumb({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const src = imageSrc(url);
  if (!src || failed) {
    return (
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600" aria-hidden="true">
        <Icon name="box" className="h-6 w-6" />
      </span>
    );
  }
  return <img src={src} alt={name} onError={() => setFailed(true)} className="h-14 w-14 shrink-0 rounded-xl border border-gray-100 object-cover" />;
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${strong ? 'border-t border-gray-100 pt-1.5 text-sm font-bold text-gray-900' : 'text-xs text-gray-600'}`}>
      <span>{label}</span>
      <span className={`tabular-nums ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function AlertCard({
  alert,
  onView,
  onClose,
  phoneHidden,
}: {
  alert: AdminOrderAlertDto;
  onView: () => void;
  onClose: () => void;
  /** Phones show one card at a time — the rest wait behind "+N more". */
  phoneHidden: boolean;
}) {
  const item = alert.firstItem;
  const moreLines = alert.lineCount - 1;
  return (
    <article
      role="status"
      aria-label={`New order ${alert.orderNumber}`}
      className={`order-alert-in pointer-events-auto w-full shrink-0 overflow-hidden rounded-2xl ${phoneHidden ? 'hidden sm:block' : ''} border border-brand-500/30 bg-white shadow-xl ring-1 ring-black/5`}
    >
      <header className="flex items-center justify-between gap-2 bg-brand-50 px-4 py-2.5">
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" aria-hidden="true" />
          <span className="text-xs font-extrabold tracking-widest text-brand-700">NEW ORDER</span>
          <span className="text-xs text-brand-700/70">· {timeAgo(alert.alertedAt)}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-gray-500 outline-none transition hover:bg-white hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-brand-400"
          aria-label={`Close the alert for order ${alert.orderNumber} (it stays unread)`}
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </header>

      <div className="space-y-3 px-4 py-3">
        <div className="flex items-start gap-3">
          <Thumb url={item?.imageUrl ?? null} name={item?.productName ?? 'Order item'} />
          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-gray-900">#{alert.orderNumber}</p>
            {item ? (
              <p className="line-clamp-2 text-sm text-gray-800">
                {item.productName}
                {item.variantName && <span className="text-gray-500"> · {item.variantName}</span>}
                <span className="font-semibold"> × {item.qty}</span>
              </p>
            ) : null}
            <p className="text-xs text-gray-500">
              {moreLines > 0 ? `+${moreLines} more item${moreLines === 1 ? '' : 's'} · ` : ''}
              {alert.unitCount} unit{alert.unitCount === 1 ? '' : 's'}
              {alert.sellerCount > 1 ? ` · ${alert.sellerCount} sellers` : ''}
              {alert.customerName ? ` · ${alert.customerName}` : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              alert.paymentMethod === 'COD' ? 'bg-warn-50 text-warn-500' : 'bg-brand-50 text-brand-700'
            }`}
          >
            {paymentLabel(alert)}
          </span>
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">{paymentStatusLabel(alert)}</span>
        </div>

        <div className="space-y-1 rounded-xl bg-gray-50 px-3 py-2">
          <Row label="Item subtotal" value={formatPaise(alert.itemsSubtotalPaise)} />
          <Row label="Delivery charges" value={alert.deliveryFeePaise > 0 ? formatPaise(alert.deliveryFeePaise) : 'Free'} />
          {alert.platformFeePaise > 0 && <Row label="Platform fee" value={formatPaise(alert.platformFeePaise)} />}
          {alert.taxPaise > 0 && <Row label="Tax" value={formatPaise(alert.taxPaise)} />}
          {alert.discountPaise > 0 && <Row label="Discount" value={`− ${formatPaise(alert.discountPaise)}`} tone="text-brand-700" />}
          <Row label="Total payable" value={formatPaise(alert.totalPaise)} strong />
        </div>

        <button
          type="button"
          onClick={onView}
          className="flex min-h-10 w-full items-center justify-center rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white outline-none transition hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand-400"
        >
          View order
        </button>
      </div>
    </article>
  );
}

export function OrderAlerts({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const alerts = useOrderAlerts();
  const markRead = useMarkOrderRead();
  const [dismissed, setDismissed] = useState<string[]>(() => readIds(dismissedKey(userId)) ?? []);
  const seen = useRef<string[] | null>(readIds(seenKey(userId)));

  // Realtime: re-read on a new order and on every (re)connect — a missed event is recovered.
  useOrderSocket({
    onNewOrder: () => void queryClient.invalidateQueries({ queryKey: orderAlertsKey }),
    onConnect: () => void queryClient.invalidateQueries({ queryKey: orderAlertsKey }),
  });

  // Back online / the tab shown again (a laptop waking up): re-read at once —
  // the socket may not have noticed the drop yet, and the 30 s poll is the last resort.
  useEffect(() => {
    const reread = () => void queryClient.invalidateQueries({ queryKey: orderAlertsKey });
    const onVisible = () => {
      if (document.visibilityState === 'visible') reread();
    };
    window.addEventListener('online', reread);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', reread);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [queryClient]);

  const items = alerts.data?.items;
  useEffect(() => {
    if (!items) return;
    const ids = items.map((item) => item.alertId);
    const { fresh, seen: nextSeen } = announce(ids, seen.current);
    seen.current = nextSeen;
    writeIds(seenKey(userId), nextSeen);
    if (fresh.length > 0) playChime();
    // Closed popups of orders that are read now are forgotten.
    setDismissed((current) => {
      const kept = prune(current, ids);
      if (kept.length !== current.length) writeIds(dismissedKey(userId), kept);
      return kept.length !== current.length ? kept : current;
    });
  }, [items, userId]);

  if (!items || items.length === 0) return null;
  const { shown, hidden } = popupsOf(items, dismissed);
  const close = (alertId: string) => {
    const next = [...dismissed, alertId];
    setDismissed(next);
    writeIds(dismissedKey(userId), next);
  };
  const reopen = () => {
    setDismissed([]);
    writeIds(dismissedKey(userId), []);
  };
  /** Opens the orders page — after asking, when a page has unsaved work (e.g. a policy being edited). */
  const go = (to: string) => {
    if (confirmLeave()) navigate(to);
  };
  const view = (alert: AdminOrderAlertDto) => {
    if (!confirmLeave()) return;
    markRead.mutate(alert.orderId);
    navigate(
      `/orders?tab=${adminOrderTabOf(alert.orderStatus)}&search=${encodeURIComponent(alert.orderNumber)}&open=${alert.orderId}`,
    );
  };

  return (
    <div
      className="pointer-events-none fixed right-3 top-[4.5rem] z-50 flex max-h-[calc(100vh-5.5rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-3 overflow-y-auto overscroll-contain pb-1 sm:right-5 sm:top-20 sm:max-h-[calc(100vh-6rem)]"
      aria-live="polite"
      aria-label="New orders"
    >
      {shown.slice(0, MAX_CARDS).map((alert, index) => (
        <AlertCard key={alert.alertId} alert={alert} phoneHidden={index > 0} onView={() => view(alert)} onClose={() => close(alert.alertId)} />
      ))}
      {shown.length > 1 && (
        <button
          type="button"
          onClick={() => go('/orders?tab=PROCESSING')}
          className="pointer-events-auto shrink-0 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-lg sm:hidden"
        >
          +{shown.length - 1} more new order{shown.length - 1 === 1 ? '' : 's'}
        </button>
      )}
      {shown.length > MAX_CARDS && (
        <button
          type="button"
          onClick={() => go('/orders?tab=PROCESSING')}
          className="pointer-events-auto hidden shrink-0 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-lg sm:block"
        >
          +{shown.length - MAX_CARDS} more new order{shown.length - MAX_CARDS === 1 ? '' : 's'}
        </button>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={reopen}
          className="pointer-events-auto shrink-0 self-end rounded-full border border-brand-500/40 bg-white px-3.5 py-1.5 text-xs font-semibold text-brand-700 shadow-md hover:bg-brand-50"
        >
          Show {hidden} hidden new order{hidden === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}

/** The red count beside "Orders" in the sidebar — this admin's unread new orders. */
export function NewOrdersBadge() {
  const role = useAuth((state) => state.user?.role);
  const alerts = useOrderAlerts(role !== undefined && roleHasPermission(role, Permission.ORDER_READ_ALL));
  const unread = alerts.data?.unread ?? 0;
  if (unread === 0) return null;
  return (
    <span aria-label={`${unread} new order${unread === 1 ? '' : 's'}`} className="ml-auto min-w-[1.4rem] rounded-full bg-danger-500 px-2 py-0.5 text-center text-xs font-bold text-white">
      {unread > 99 ? '99+' : unread}
    </span>
  );
}
