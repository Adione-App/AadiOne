/**
 * Seller dashboard — what needs doing now. Every figure is live server data:
 *
 *   tiles            GET /seller/orders/summary, /seller/earnings/today,
 *                    the product + listing lists, the unread count
 *   store status     GET /seller/availability (storeStatus.tsx)
 *   order overview   the summary + GET /seller/orders?stage=COMPLETED
 *   inventory alerts the product + listing lists (productRows.ts)
 *   recent activity  the notification feed + GET /seller/activity
 *
 * The lists are the same cached queries Products and Inventory use, so
 * opening those pages afterwards costs no extra requests.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { Icon, Pill, Surface, type IconName, type Tone } from '@/components/ui';
import {
  flattenNotificationPages,
  formatNotificationTime,
  presentNotification,
  useNotificationFeed,
  useNotificationUnreadCount,
} from '@/lib/notifications';
import { sellerOrderStatusLabel } from '@/lib/v2Orders';
import { HANDOVER_LABEL, sellerApi, sellerErrorMessage, type SellerActivityItem, type SellerOrderPage } from '../sellerApi';
import {
  sellerKeys,
  useSellerActivity,
  useSellerListings,
  useSellerOrderSummary,
  useSellerProducts,
  useSellerTodayEarnings,
} from '../sellerQueries';
import { useSellerNotificationSource } from '../sellerNotifications';
import { ATTENTION_ORDER, attentionOf, rowsOf, type Attention, type ProductRow } from '../productRows';
import { ProductImage } from '../productUi';
import { StoreStatusCard } from '../storeStatus';
import { CardHeader, EmptyPanel, LoadError, MetricTile, Skeleton, SkeletonList, SkeletonTiles, linkClass } from '../sellerUi';

export default function SellerDashboardPage() {
  return (
    <div className="space-y-5">
      <SummaryTiles />
      <StoreStatusCard compact />
      <div className="grid gap-5 lg:grid-cols-2">
        <OrderOverview />
        <InventoryAlerts />
      </div>
      <RecentActivity />
    </div>
  );
}

/* ------------------------------------------------------------------- tiles */

function SummaryTiles() {
  const summary = useSellerOrderSummary();
  const today = useSellerTodayEarnings();
  const products = useSellerProducts();
  const listings = useSellerListings();
  const unread = useNotificationUnreadCount(useSellerNotificationSource());

  if (summary.isPending && today.isPending && listings.isPending) return <SkeletonTiles count={6} label="Loading your numbers…" />;

  const rows = products.data && listings.data ? rowsOf(products.data, listings.data) : null;
  const onSale = rows ? rows.filter((row) => row.visibility.sellable).length : null;
  const lowStock = rows ? rows.filter((row) => row.visibility.lowStock).length : null;
  const day = summary.data?.today;

  return (
    <section aria-label="Today at a glance" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <MetricTile
        label="Today's orders"
        icon="orders"
        tone="blue"
        value={summary.data?.todayOrders ?? null}
        to={day ? `/seller/orders?tab=ALL&from=${day}&to=${day}` : '/seller/orders?tab=ALL'}
      />
      <MetricTile label="Pending orders" icon="bell" tone="amber" value={summary.data?.counts.NEW ?? null} hint="To accept" to="/seller/orders?tab=NEW" />
      <MetricTile
        label="Today's sales"
        icon="rupee"
        tone="brand"
        value={today.data ? formatPaise(today.data.grossSalesPaise) : null}
        hint={today.data ? `${today.data.orderCount} order${today.data.orderCount === 1 ? '' : 's'}` : undefined}
        to="/seller/earnings"
      />
      <MetricTile label="Available products" icon="products" tone="brand" value={onSale} hint="Buyable now" to="/seller/products?view=ON_SALE" />
      <MetricTile label="Low stock" icon="alert" tone={lowStock ? 'amber' : 'gray'} value={lowStock} to="/seller/inventory?stock=LOW" />
      <MetricTile label="Unread notifications" icon="bell" tone={unread.data ? 'red' : 'gray'} value={unread.data ?? null} to="/seller/notifications" />
    </section>
  );
}

/* ---------------------------------------------------------- order overview */

const STAGES: { key: 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY'; label: string; hint: string; tab: string; tone: Tone }[] = [
  { key: 'NEW', label: 'New orders', hint: 'Accept or reject', tab: 'NEW', tone: 'blue' },
  { key: 'ACCEPTED', label: 'Accepted', hint: 'Start preparing', tab: 'ACCEPTED', tone: 'brand' },
  { key: 'PREPARING', label: 'Preparing', hint: 'Mark ready when packed', tab: 'PREPARING', tone: 'amber' },
  { key: 'READY', label: 'Ready for pickup', hint: 'Waiting for the rider', tab: 'READY_FOR_PICKUP', tone: 'purple' },
];

const TONE_TEXT: Record<Tone, string> = {
  brand: 'text-brand-600',
  blue: 'text-info-500',
  amber: 'text-warn-500',
  red: 'text-danger-600',
  purple: 'text-purple-600',
  gray: 'text-gray-500',
};

function OrderOverview() {
  const summary = useSellerOrderSummary();
  const completed = useQuery({
    queryKey: sellerKeys.orderList({ stage: 'COMPLETED', limit: '5' }),
    queryFn: () => sellerApi.get<SellerOrderPage>('/seller/orders?stage=COMPLETED&limit=5'),
  });

  return (
    <Surface className="space-y-4 p-4 sm:p-5">
      <CardHeader
        title="Orders"
        action={
          <Link to="/seller/orders?tab=ALL" className={linkClass}>
            View all orders <Icon name="chevronRight" className="h-4 w-4" />
          </Link>
        }
      />
      {summary.isError ? (
        <LoadError message={sellerErrorMessage(summary.error)} onRetry={() => void summary.refetch()} />
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {STAGES.map((stage) => (
            <li key={stage.key}>
              <Link
                to={`/seller/orders?tab=${stage.tab}`}
                className="block rounded-xl border border-gray-200 px-3 py-2.5 outline-none transition hover:border-brand-200 hover:bg-brand-50/40 focus-visible:ring-2 focus-visible:ring-brand-400"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-gray-700">{stage.label}</span>
                  <span className={`text-xl font-bold ${TONE_TEXT[stage.tone]}`}>
                    {summary.isPending ? <Skeleton className="inline-block h-5 w-6 align-middle" /> : summary.data.counts[stage.key]}
                  </span>
                </span>
                <span className="block text-xs text-gray-500">{stage.hint}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div>
        <p className="mb-1.5 text-sm font-semibold text-gray-800">Recently completed</p>
        {completed.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : completed.isError ? (
          <LoadError message={sellerErrorMessage(completed.error)} onRetry={() => void completed.refetch()} />
        ) : completed.data.items.length === 0 ? (
          <p className="text-sm text-gray-500">Orders appear here once the rider has picked them up.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {completed.data.items.map((order) => (
              <li key={order.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-mono font-semibold text-gray-900">#{order.orderNumber}</span>
                  <span className="block truncate text-xs text-gray-500">
                    {order.handover ? HANDOVER_LABEL[order.handover] : sellerOrderStatusLabel(order.status)} · {formatNotificationTime(order.createdAt)}
                  </span>
                </span>
                <span className="shrink-0 font-semibold text-gray-900">{formatPaise(order.subtotalPaise)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Surface>
  );
}

/* -------------------------------------------------------- inventory alerts */

function InventoryAlerts() {
  const products = useSellerProducts();
  const listings = useSellerListings();

  const alerts = useMemo(() => {
    if (!products.data || !listings.data) return null;
    return rowsOf(products.data, listings.data)
      .map((row) => ({ row, attention: attentionOf(row) }))
      .filter((item): item is { row: ProductRow; attention: Attention } => item.attention !== null)
      .sort((a, b) => ATTENTION_ORDER.indexOf(a.attention.kind) - ATTENTION_ORDER.indexOf(b.attention.kind));
  }, [products.data, listings.data]);

  const error = products.error ?? listings.error;
  const counts = alerts
    ? ATTENTION_ORDER.map((kind) => ({ kind, count: alerts.filter((item) => item.attention.kind === kind).length })).filter((c) => c.count > 0)
    : [];

  return (
    <Surface className="space-y-4 p-4 sm:p-5">
      <CardHeader
        title="Needs attention"
        subtitle="Products customers can't buy, or soon won't be able to."
        action={
          <Link to="/seller/inventory" className={linkClass}>
            Inventory <Icon name="chevronRight" className="h-4 w-4" />
          </Link>
        }
      />
      {error ? (
        <LoadError message={sellerErrorMessage(error)} onRetry={() => void Promise.all([products.refetch(), listings.refetch()])} />
      ) : !alerts ? (
        <SkeletonList rows={3} label="Checking your products…" />
      ) : alerts.length === 0 ? (
        <EmptyPanel icon="check" title="Everything looks good" hint="No low stock, hidden, rejected or pending products." />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {counts.map(({ kind, count }) => {
              const look = alerts.find((item) => item.attention.kind === kind)!.attention;
              return (
                <Pill key={kind} tone={look.tone}>
                  {count} {kind === 'LOW_STOCK' ? 'low stock' : look.label.toLowerCase()}
                </Pill>
              );
            })}
          </div>
          <ul className="divide-y divide-gray-100">
            {alerts.slice(0, 6).map(({ row, attention }) => (
              <li key={row.key} className="flex items-center gap-3 py-2.5">
                <ProductImage src={row.image} alt="" size="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-900">{row.name}</p>
                  <p className="text-xs">
                    <span className={TONE_TEXT[attention.tone]}>{attention.label}</span>
                  </p>
                </div>
                <Link
                  to={attention.href}
                  className="inline-flex min-h-9 shrink-0 items-center rounded-lg border border-gray-200 px-3 text-xs font-semibold text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-400"
                  aria-label={`${attention.action}: ${row.name}`}
                >
                  {attention.action}
                </Link>
              </li>
            ))}
          </ul>
          {alerts.length > 6 && (
            <Link to="/seller/products" className={linkClass}>
              See all {alerts.length} in Products
            </Link>
          )}
        </>
      )}
    </Surface>
  );
}

/* ---------------------------------------------------------- recent activity */

interface ActivityLine {
  id: string;
  at: string;
  icon: IconName;
  tone: string;
  text: string;
  detail: string | null;
  href: string | null;
  unread: boolean;
}

const ORDER_VERB: Record<string, string> = {
  ACCEPTED: 'accepted',
  PREPARING: 'started preparing',
  READY_FOR_PICKUP: 'marked ready for pickup',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

const who = (by: SellerActivityItem['by']): string => (by === 'AdiOne' ? 'Aadione' : by);

function activityLine(item: SellerActivityItem): ActivityLine {
  const base = { id: `act-${item.id}`, at: item.at, unread: false };
  switch (item.kind) {
    case 'ORDER':
      return {
        ...base,
        icon: 'orders',
        tone: item.toStatus === 'REJECTED' || item.toStatus === 'CANCELLED' ? 'bg-danger-50 text-danger-500' : 'bg-brand-50 text-brand-600',
        text: `${who(item.by)} ${ORDER_VERB[item.toStatus] ?? sellerOrderStatusLabel(item.toStatus).toLowerCase()} order #${item.orderNumber}`,
        detail: item.reason,
        href: '/seller/orders?tab=ALL',
      };
    case 'STOCK':
      return {
        ...base,
        icon: 'inventory',
        tone: 'bg-info-50 text-info-500',
        text: `${who(item.by)} ${item.delta >= 0 ? 'added' : 'removed'} ${Math.abs(item.delta)} × ${item.productName}`,
        detail: item.note,
        href: '/seller/inventory',
      };
    case 'PRICE':
      return {
        ...base,
        icon: 'rupee',
        tone: 'bg-warn-50 text-warn-500',
        text: `${who(item.by)} changed the price of ${item.productName}`,
        detail: item.fromPaise !== null && item.toPaise !== null ? `${formatPaise(item.fromPaise)} → ${formatPaise(item.toPaise)}` : null,
        href: '/seller/products',
      };
    case 'VISIBILITY':
      return {
        ...base,
        icon: item.onSale ? 'eye' : 'eyeOff',
        tone: 'bg-gray-100 text-gray-600',
        text: `${who(item.by)} ${item.onSale ? 'put' : 'took'} ${item.productName} ${item.onSale ? 'on sale' : 'off sale'}`,
        detail: null,
        href: '/seller/products',
      };
    case 'ADMIN':
      return {
        ...base,
        icon: 'lock',
        tone: 'bg-danger-50 text-danger-500',
        text: `Aadione ${item.action === 'DISABLED' ? 'disabled' : 'enabled'} ${item.productName}`,
        detail: item.reason,
        href: `/seller/products/${item.productId}#visibility`,
      };
  }
}

function RecentActivity() {
  const source = useSellerNotificationSource();
  const feed = useNotificationFeed(source);
  const activity = useSellerActivity(15);

  const lines = useMemo(() => {
    const fromNotifications: ActivityLine[] = flattenNotificationPages(feed.data?.pages).map((n) => {
      const look = presentNotification(n.type);
      return {
        id: `n-${n.id}`,
        at: n.createdAt,
        icon: look.icon,
        tone: look.toneClass,
        text: n.title,
        detail: n.body,
        href: source.destination(n),
        unread: !n.isRead,
      };
    });
    const fromActivity = (activity.data ?? []).map(activityLine);
    return [...fromNotifications, ...fromActivity].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10);
  }, [feed.data, activity.data, source]);

  const loading = feed.isPending && activity.isPending;
  const failed = feed.isError && activity.isError;

  return (
    <Surface className="space-y-3 p-4 sm:p-5">
      <CardHeader
        title="Recent activity"
        action={
          <Link to="/seller/notifications" className={linkClass}>
            All notifications <Icon name="chevronRight" className="h-4 w-4" />
          </Link>
        }
      />
      {loading ? (
        <SkeletonList rows={3} label="Loading recent activity…" />
      ) : failed ? (
        <LoadError message="Could not load recent activity." onRetry={() => void Promise.all([feed.refetch(), activity.refetch()])} />
      ) : lines.length === 0 ? (
        <EmptyPanel icon="clock" title="No activity yet" hint="New orders, stock changes and approvals will show up here." />
      ) : (
        <ul className="divide-y divide-gray-100">
          {lines.map((line) => {
            const content = (
              <>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${line.tone}`}>
                  <Icon name={line.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm text-gray-900 ${line.unread ? 'font-semibold' : ''}`}>{line.text}</span>
                  {line.detail && <span className="block truncate text-xs text-gray-500">{line.detail}</span>}
                </span>
                <span className="shrink-0 text-xs text-gray-400">
                  {formatNotificationTime(line.at)}
                  {line.unread && <span className="sr-only"> (unread)</span>}
                </span>
              </>
            );
            return (
              <li key={line.id}>
                {line.href ? (
                  <Link to={line.href} className="flex items-start gap-3 rounded-lg py-2.5 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-brand-400">
                    {content}
                  </Link>
                ) : (
                  <div className="flex items-start gap-3 py-2.5">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Surface>
  );
}
