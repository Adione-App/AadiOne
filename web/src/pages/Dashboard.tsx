import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ORDER_STATUS_LABELS,
  AdminOrderTab,
  type AdminDashboardDto,
  type AdminOrderSummaryDto,
  type CursorPage,
  type PublicConfig,
} from '@shared';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { formatShortDate, todayIsoInIndia } from '@/lib/dashboardDate';
import {
  Button,
  EmptyState,
  Icon,
  Panel,
  Spinner,
  StatCard,
  StatusPill,
  Td,
  Th,
} from '@/components/ui';

/** Slice colours, in the order statuses come back. */
const SLICE_COLOURS = ['#1E8E3E', '#3B82F6', '#F59E0B', '#8B5CF6', '#4FB06C', '#E5484D'];

/**
 * Donut chart, drawn with stroke-dasharray on concentric circles.
 *
 * A charting library would be ~50 KB gzipped to render one ring; this is the
 * whole implementation.
 */
function Donut({
  segments,
  total,
}: {
  segments: { label: string; count: number; colour: string }[];
  total: number;
}) {
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;

  return (
    <div className="flex flex-wrap items-center justify-center gap-8">
      <svg viewBox="0 0 160 160" className="h-44 w-44 -rotate-90">
        <circle cx="80" cy="80" r={radius} fill="none" stroke="#F3F4F6" strokeWidth="22" />
        {total > 0 &&
          segments.map((segment) => {
            const length = (segment.count / total) * circumference;
            const dash = `${length} ${circumference - length}`;
            const offset = -consumed;
            consumed += length;
            return (
              <circle
                key={segment.label}
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                stroke={segment.colour}
                strokeWidth="22"
                strokeDasharray={dash}
                strokeDashoffset={offset}
              />
            );
          })}
        {/* Counter-rotated so the label reads horizontally inside the ring. */}
        <g transform="rotate(90 80 80)">
          <text
            x="80"
            y="76"
            textAnchor="middle"
            className="fill-gray-900"
            fontSize="26"
            fontWeight="700"
          >
            {total}
          </text>
          <text x="80" y="95" textAnchor="middle" className="fill-gray-500" fontSize="11">
            Total Orders
          </text>
        </g>
      </svg>

      <ul className="space-y-2.5 text-sm">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2.5">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: segment.colour }}
            />
            <span className="text-gray-700">{segment.label}</span>
            <span className="ml-auto pl-4 font-medium text-gray-500">
              {segment.count}
              {total > 0 && ` (${Math.round((segment.count / total) * 100)}%)`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="text-gray-600">{label}</dt>
      <dd className="text-right font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

export default function DashboardPage() {
  // Same URL param the date picker in the TopBar writes to (see App.tsx) —
  // reading it here, not from a separate store, keeps exactly one source of
  // truth for "which day is selected" and makes it survive a page refresh.
  const [searchParams] = useSearchParams();
  const todayIso = todayIsoInIndia();
  const selectedDate = searchParams.get('date') ?? todayIso;
  const isToday = selectedDate === todayIso;

  const dashboard = useQuery({
    // The date is part of the key: switching dates is a genuinely different
    // query/cache entry, not a mutation of one shared entry — so a slower
    // response for a date the admin has since navigated away from can never
    // land on top of the one currently being viewed (React Query only ever
    // applies a response to the cache slot for the key it was fetched with).
    queryKey: ['dashboard', selectedDate],
    queryFn: () => api.get<AdminDashboardDto>(`/admin/dashboard?date=${selectedDate}`),
    // Only today's numbers can still move; a past day is done and settled,
    // so polling it every 30s would just be wasted requests.
    refetchInterval: isToday ? 30_000 : false,
    // Keep showing the PREVIOUS date's numbers while the newly-picked date
    // loads, instead of blanking the whole dashboard to a spinner on every
    // switch — a rapid 17 → 16 → 15 pick then settles on 15's data once it
    // arrives, never a full-page reload feel in between.
    placeholderData: keepPreviousData,
  });

  const config = useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<PublicConfig>('/config/public'),
    staleTime: 5 * 60_000,
  });

  const recent = useQuery({
    queryKey: ['admin-orders', 'dashboard', selectedDate],
    queryFn: () =>
      isToday
        ? api.get<CursorPage<AdminOrderSummaryDto>>(
            `/admin/orders?tab=${AdminOrderTab.NEW}&limit=5`,
          )
        : api.get<CursorPage<AdminOrderSummaryDto>>(
            `/admin/orders?date=${selectedDate}&limit=5`,
          ),
    refetchInterval: isToday ? 30_000 : false,
    placeholderData: keepPreviousData,
  });

  const data = dashboard.data;
  if (dashboard.isLoading || !data) return <Spinner label="Loading dashboard…" />;

  const segments = data.ordersByStatus.map((row, index) => ({
    label: ORDER_STATUS_LABELS[row.status],
    count: row.count,
    colour: SLICE_COLOURS[index % SLICE_COLOURS.length]!,
  }));
  const inProgressTotal = segments.reduce((sum, segment) => sum + segment.count, 0);

  return (
    <div className="space-y-5">
      {/* ---- headline metrics ---- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon="orders"
          label={data.isToday ? "Today's Orders" : `Orders on ${formatShortDate(data.date)}`}
          value={data.todayOrderCount}
          tone="brand"
          foot={
            <Link to="/orders" className="font-medium text-brand-600 hover:underline">
              View all orders →
            </Link>
          }
        />
        <StatCard
          icon="rupee"
          label={data.isToday ? "Today's Sales" : `Sales on ${formatShortDate(data.date)}`}
          value={formatPaise(data.todayRevenuePaise)}
          tone="amber"
          foot={<span className="text-gray-500">{data.completedTodayCount} delivered</span>}
        />
        <StatCard
          icon="clock"
          label="Pending Orders"
          value={data.pendingOrderCount}
          tone="purple"
          foot={
            <Link to="/orders" className="font-medium text-brand-600 hover:underline">
              View pending →
            </Link>
          }
        />
        <StatCard
          icon="box"
          label="Low Stock Products"
          value={data.lowStockCount}
          tone="red"
          foot={
            <Link to="/inventory" className="font-medium text-brand-600 hover:underline">
              View inventory →
            </Link>
          }
        />
      </div>

      {/* ---- middle row ---- */}
      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="Order Status">
          {inProgressTotal === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">Nothing in progress right now.</p>
          ) : (
            <Donut segments={segments} total={inProgressTotal} />
          )}
        </Panel>

        <Panel
          title="Low Stock Products"
          action={
            <Link to="/inventory" className="text-sm font-medium text-brand-600 hover:underline">
              View all →
            </Link>
          }
        >
          {data.lowStockItems.length === 0 ? (
            <EmptyState title="Everything is well stocked" />
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.lowStockItems.slice(0, 5).map((item) => (
                <li
                  key={item.storeVariantId}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-800">
                      {item.productName}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {item.variantName}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 font-semibold ${
                      item.availableQty === 0 ? 'text-danger-500' : 'text-warn-500'
                    }`}
                  >
                    {item.availableQty} units
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Store Summary">
          <dl className="text-sm">
            <SummaryRow
              label="Store Status"
              value={
                <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-600">
                  Open
                </span>
              }
            />
            <SummaryRow
              label="Service Radius"
              value={
                config.data ? `${config.data.MAX_SERVICE_RADIUS_KM} km` : '—'
              }
            />
            <SummaryRow
              label="Minimum Order Amount"
              value={config.data ? formatPaise(config.data.MIN_ORDER_VALUE_PAISE) : '—'}
            />
            <SummaryRow
              label="Free Delivery Above"
              value={config.data ? formatPaise(config.data.FREE_DELIVERY_THRESHOLD_PAISE) : '—'}
            />
            <SummaryRow
              label="Platform Fee"
              value={config.data ? formatPaise(config.data.PLATFORM_FEE_PAISE) : '—'}
            />
            <SummaryRow
              label="Delivery Promise"
              value={config.data?.DELIVERY_PROMISE_TEXT ?? '—'}
            />
          </dl>

          <Link to="/settings" className="mt-4 block">
            <Button variant="secondary" className="w-full">
              <Icon name="config" className="h-4 w-4" />
              Edit Configuration
            </Button>
          </Link>
        </Panel>
      </div>

      {/* ---- recent orders ---- */}
      <Panel
        title={data.isToday ? 'New Orders' : `Orders on ${formatShortDate(data.date)}`}
        bodyClass=""
        action={
          <Link to="/orders" className="text-sm font-medium text-brand-600 hover:underline">
            View all orders →
          </Link>
        }
      >
        {(recent.data?.items.length ?? 0) === 0 ? (
          <div className="p-5 pt-0">
            {data.isToday ? (
              <EmptyState
                title="No new orders waiting"
                hint="Accepted orders move to their own tab."
              />
            ) : (
              <EmptyState
                title="No orders on this date"
                hint={`No orders were placed on ${formatShortDate(data.date)}.`}
              />
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-y border-gray-200 bg-gray-50">
                <tr>
                  <Th>Order ID</Th>
                  <Th>Customer</Th>
                  <Th>Amount</Th>
                  <Th>Status</Th>
                  <Th>Waiting</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(recent.data?.items ?? []).map((order) => (
                  <tr key={order.id} className="transition hover:bg-gray-50/60">
                    <Td>
                      <Link
                        to="/orders"
                        className="font-semibold text-brand-600 hover:underline"
                      >
                        #{order.orderNumber}
                      </Link>
                    </Td>
                    <Td className="text-gray-700">{order.customerName ?? 'Customer'}</Td>
                    <Td className="font-semibold text-gray-900">
                      {formatPaise(order.totalPaise)}
                    </Td>
                    <Td>
                      <StatusPill status={order.status} />
                    </Td>
                    <Td className="text-gray-500">{order.minutesSincePlaced} min</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
