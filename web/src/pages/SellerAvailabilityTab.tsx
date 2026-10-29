/**
 * Seller detail — Availability tab.
 *
 * Reads GET /admin/sellers/:id/availability. With SELLER_MANAGE, admin also
 * sets the seller's Accepting Orders switch, weekly hours (with the store's
 * own timezone) and date closures through /admin/sellers/:id/... — the same
 * service, validation and audit as the seller's own Availability page, whose
 * editors (WeeklyHours, Closures) are reused here. Without it, read-only.
 *
 * Kept visibly separate, exactly as the backend evaluates them:
 *   app-wide pause (ORDERING_ENABLED, Configuration → Orders)
 *   -> admin switch (isActive — the Activate / Deactivate action above)
 *   -> Accepting Orders switch (isAcceptingOrders)
 *   -> closure today -> weekly hours => isOpenNow / acceptingOrdersNow + closedReason.
 * No layer can override one above it: open hours never reopen a store that
 * is switched off, and nothing reopens a store while ordering is paused.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApprovalStatus, formatTime12h, type AdminSellerDetailDto, type PublicConfig, type SellerHoursDto } from '@shared';
import { api } from '@/lib/api';
import { adminSellerKeys, sellerErrorMessage, sellersApi, useAdminSellerAvailability, useSellerPermissions } from '@/lib/sellers';
import { ActivePill, CLOSED_REASON_LABEL, DetailRow, formatSellerDate } from '@/components/SellerBadges';
import { Button, EmptyState, ErrorBanner, Modal, Panel, Pill, Spinner, Td, Th, Toggle } from '@/components/ui';
import { Closures, WeeklyHours, type AvailabilityEditorSource } from '@/seller/pages/SellerAvailability';

/** Monday first; `dayOfWeek` is the backend's 0 = Sunday … 6 = Saturday. */
const WEEK: { day: number; label: string }[] = [
  { day: 1, label: 'Monday' },
  { day: 2, label: 'Tuesday' },
  { day: 3, label: 'Wednesday' },
  { day: 4, label: 'Thursday' },
  { day: 5, label: 'Friday' },
  { day: 6, label: 'Saturday' },
  { day: 0, label: 'Sunday' },
];

/** How the backend's `isWithinWindow` reads a saved day. */
function describeDay(row: SellerHoursDto | undefined): { text: string; closed: boolean } {
  // With a schedule configured, a day with no row is closed all day.
  if (!row || row.isClosed) return { text: row ? 'Closed' : 'Closed (not set)', closed: true };
  if (row.opensAt === row.closesAt) return { text: 'Open 24 hours', closed: false };
  const window = `${formatTime12h(row.opensAt)} – ${formatTime12h(row.closesAt)}`;
  return { text: row.closesAt < row.opensAt ? `${window} (next day)` : window, closed: false };
}

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-start justify-between gap-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
      <span>{message}</span>
      <button type="button" className="text-xs font-semibold underline" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export default function SellerAvailabilityTab({ seller }: { seller: AdminSellerDetailDto }) {
  const availability = useAdminSellerAvailability(seller.id);
  const { canManage } = useSellerPermissions();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const publicConfig = useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<PublicConfig>('/config/public'),
    staleTime: 30_000,
  });

  const switchOrders = useMutation({
    mutationFn: (isAcceptingOrders: boolean) => sellersApi.setAcceptingOrders(seller.id, isAcceptingOrders),
    onSuccess: (data) => {
      queryClient.setQueryData(adminSellerKeys.availability(seller.id), data);
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.detail(seller.id) });
      setNotice(data.isAcceptingOrders ? 'Accepting Orders is ON — the weekly hours and closures decide again.' : 'Accepting Orders is OFF — no new orders from this store until it is switched back on.');
    },
  });

  if (availability.isPending) return <Spinner label="Loading availability…" />;
  if (availability.isError) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={sellerErrorMessage(availability.error, 'Could not load availability.')} />
        <Button variant="secondary" onClick={() => void availability.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const a = availability.data;
  const orderingPaused = publicConfig.data?.ORDERING_ENABLED === false;
  const editor: AvailabilityEditorSource = {
    queryKey: adminSellerKeys.availability(seller.id),
    saveHours: (hours, timezone) => sellersApi.saveHours(seller.id, hours, timezone),
    addClosure: (input) => sellersApi.addClosure(seller.id, input),
    removeClosure: (id) => sellersApi.removeClosure(seller.id, id),
    errorMessage: (error) => sellerErrorMessage(error, 'Could not save the availability.'),
    notify: setNotice,
    timezoneEditable: true,
  };

  return (
    <div className="space-y-5">
      {notice && <Notice message={notice} onDismiss={() => setNotice(null)} />}

      {orderingPaused && (
        <div role="alert" className="rounded-lg border border-warn-500 bg-warn-50 px-3 py-2 text-sm text-gray-800">
          <span className="font-semibold">Ordering is paused app-wide.</span> No store takes new orders, whatever its status below, until it is
          reopened in{' '}
          <Link to="/settings" className="font-semibold text-brand-600 hover:underline">
            Configuration → Orders
          </Link>
          .
        </div>
      )}

      <Panel title="Current availability">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Admin status">
            <ActivePill isActive={a.isActive} />
          </DetailRow>
          <DetailRow label="Accepting Orders switch">
            <div className="flex flex-wrap items-center gap-3">
              <Pill tone={a.isAcceptingOrders ? 'brand' : 'gray'}>{a.isAcceptingOrders ? 'ON — Accepting Orders' : 'OFF — Not Accepting Orders'}</Pill>
              {canManage && (
                <Toggle
                  checked={a.isAcceptingOrders}
                  label="Accepting Orders"
                  disabled={switchOrders.isPending}
                  onChange={(on) => (on ? switchOrders.mutate(true) : setConfirmOff(true))}
                />
              )}
            </div>
          </DetailRow>
          <DetailRow label="Current status">
            <Pill tone={a.isOpenNow ? 'brand' : 'amber'}>{a.isOpenNow ? 'Open' : 'Closed'}</Pill>
          </DetailRow>
          <DetailRow label="Taking orders now">
            {orderingPaused ? 'No — ordering is paused app-wide' : a.acceptingOrdersNow ? (a.isOpenNow ? 'Yes' : 'Yes — orders allowed while closed') : 'No'}
          </DetailRow>
          <DetailRow label="Reason">
            {a.closedReason ? (
              <span>
                {CLOSED_REASON_LABEL[a.closedReason] ?? a.closedReason}{' '}
                <span className="text-xs font-normal text-gray-500">({a.closedReason})</span>
              </span>
            ) : (
              '—'
            )}
          </DetailRow>
          {a.todayOpensAt && a.todayClosesAt && (
            <DetailRow label="Today's hours">
              {formatTime12h(a.todayOpensAt)} – {formatTime12h(a.todayClosesAt)}
            </DetailRow>
          )}
          {a.nextOpenText && <DetailRow label="Next opening">{a.nextOpenText}</DetailRow>}
          <DetailRow label="Timezone">{a.timezone}</DetailRow>
        </dl>
        {switchOrders.isError && <ErrorBanner message={sellerErrorMessage(switchOrders.error, 'Could not change the switch.')} />}
        {!a.isActive && a.isAcceptingOrders && (
          <p className="mt-3 text-xs text-warn-500">Switched off by admin: the Accepting Orders switch and the hours have no effect until the store is activated.</p>
        )}
        {seller.onboardingStatus !== ApprovalStatus.APPROVED && (
          <p className="mt-3 text-xs text-warn-500">
            Onboarding is not approved, so customers cannot order from this seller whatever its availability says.
          </p>
        )}
      </Panel>

      <Panel title="How ordering is decided">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
          <li>
            <span className="font-semibold">App-wide ordering</span> (Configuration → Orders) — paused, no store takes orders.
          </li>
          <li>
            <span className="font-semibold">Admin status</span> (Activate / Deactivate above) — a deactivated store is closed, and the seller cannot reopen it.
          </li>
          <li>
            <span className="font-semibold">Accepting Orders</span> — the store's own ON / OFF switch (seller or admin). OFF stays OFF until switched back on.
          </li>
          <li>
            <span className="font-semibold">Closures</span> — whole days closed, e.g. holidays.
          </li>
          <li>
            <span className="font-semibold">Weekly hours</span> — open inside them, in the store's timezone. No hours saved = no hour restriction.
          </li>
        </ol>
        <p className="mt-2 text-xs text-gray-500">Each step can only close a store, never reopen one closed by a step above it. The server checks all of them again at checkout.</p>
      </Panel>

      {canManage ? (
        <>
          <WeeklyHours availability={a} source={editor} />
          <Closures availability={a} source={editor} />
        </>
      ) : (
        <ReadOnlySchedule hours={a.hours} hoursConfigured={a.hoursConfigured} closures={a.upcomingClosures} />
      )}

      {confirmOff && (
        <Modal
          title="Stop new orders from this store?"
          subtitle="Customers can still browse its products, but cannot order them. Orders already placed are not affected."
          onClose={() => setConfirmOff(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmOff(false)}>
                Keep accepting orders
              </Button>
              <Button
                disabled={switchOrders.isPending}
                onClick={() => {
                  setConfirmOff(false);
                  switchOrders.mutate(false);
                }}
              >
                Switch Accepting Orders OFF
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">It stays OFF — overriding the weekly hours — until the seller or an admin switches it back on.</p>
        </Modal>
      )}
    </div>
  );
}

function ReadOnlySchedule({
  hours,
  hoursConfigured,
  closures,
}: {
  hours: SellerHoursDto[];
  hoursConfigured: boolean;
  closures: { id: string; date: string; reason: string | null }[];
}) {
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Weekly hours" bodyClass="">
          {!hoursConfigured ? (
            <div className="p-5 pt-0">
              <EmptyState title="No weekly hours configured" hint="Without a saved schedule there is no hour restriction." />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-y border-gray-200 bg-gray-50">
                <tr>
                  <Th>Day</Th>
                  <Th>Hours</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {WEEK.map(({ day, label }) => {
                  const shown = describeDay(hours.find((h) => h.dayOfWeek === day));
                  return (
                    <tr key={day}>
                      <Td className="font-medium text-gray-900">{label}</Td>
                      <Td className={shown.closed ? 'text-gray-500' : 'text-gray-800'}>{shown.text}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Upcoming closures" bodyClass="">
          {closures.length === 0 ? (
            <div className="p-5 pt-0">
              <EmptyState title="No upcoming closures" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-y border-gray-200 bg-gray-50">
                <tr>
                  <Th>Date</Th>
                  <Th>Reason</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {closures.map((closure) => (
                  <tr key={closure.id}>
                    {/* closedOn is a calendar date (UTC midnight), not an instant. */}
                    <Td className="whitespace-nowrap font-medium text-gray-900">{formatSellerDate(`${closure.date}T12:00:00.000Z`)}</Td>
                    <Td className="text-gray-700">{closure.reason ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <p className="text-xs text-gray-500">Read-only — changing a store's availability needs the Manage sellers permission.</p>
    </>
  );
}
