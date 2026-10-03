/**
 * Seller detail — Availability tab (READ-ONLY in Phase 6).
 *
 * One read: GET /admin/sellers/:id/availability (admin session). Admin never
 * edits the seller's own switch, hours or closures here — those belong to the
 * seller's Seller Panel; the only admin control is the admin switch in the
 * header (isActive).
 *
 * Kept visibly separate, exactly as the backend evaluates them:
 *   admin switch (isActive) -> seller switch (isAcceptingOrders)
 *   -> closure today -> weekly hours => isOpenNow / acceptingOrdersNow + closedReason.
 */

import { ApprovalStatus, formatTime12h, type AdminSellerDetailDto, type SellerHoursDto } from '@shared';
import { sellerErrorMessage, useAdminSellerAvailability } from '@/lib/sellers';
import { ActivePill, CLOSED_REASON_LABEL, DetailRow, formatSellerDate } from '@/components/SellerBadges';
import { Button, EmptyState, ErrorBanner, Panel, Pill, Spinner, Td, Th } from '@/components/ui';

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

export default function SellerAvailabilityTab({ seller }: { seller: AdminSellerDetailDto }) {
  const availability = useAdminSellerAvailability(seller.id);

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

  return (
    <div className="space-y-5">
      <Panel title="Current availability">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Admin status">
            <ActivePill isActive={a.isActive} />
          </DetailRow>
          <DetailRow label="Seller order switch">
            <Pill tone={a.isAcceptingOrders ? 'brand' : 'gray'}>
              {a.isAcceptingOrders ? 'Accepting Orders' : 'Not Accepting Orders'}
            </Pill>
          </DetailRow>
          <DetailRow label="Current status">
            <Pill tone={a.isOpenNow ? 'brand' : 'amber'}>{a.isOpenNow ? 'Open' : 'Closed'}</Pill>
          </DetailRow>
          <DetailRow label="Taking orders now">
            {a.acceptingOrdersNow ? (a.isOpenNow ? 'Yes' : 'Yes — orders allowed while closed') : 'No'}
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
          {a.nextOpenText && <DetailRow label="Next opening">{a.nextOpenText}</DetailRow>}
          <DetailRow label="Timezone">{a.timezone}</DetailRow>
        </dl>
        {seller.onboardingStatus !== ApprovalStatus.APPROVED && (
          <p className="mt-3 text-xs text-warn-500">
            Onboarding is not approved, so customers cannot order from this seller whatever its availability says.
          </p>
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Weekly hours" bodyClass="">
          {!a.hoursConfigured ? (
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
                  const shown = describeDay(a.hours.find((h) => h.dayOfWeek === day));
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
          {a.upcomingClosures.length === 0 ? (
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
                {a.upcomingClosures.map((closure) => (
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

      <p className="text-xs text-gray-500">
        Read-only. The seller manages its order switch, weekly hours and closures in the Seller Panel; the admin switch
        is the Activate / Deactivate action above.
      </p>
    </div>
  );
}
