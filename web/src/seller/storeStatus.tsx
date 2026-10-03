/**
 * The store's state, explained — shared by the dashboard and Availability.
 * Every fact comes from GET /seller/availability (backend
 * evaluateSellerAvailability); the only thing computed here is which of
 * the saved weekly rows is "today" in the store's own timezone.
 */

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ErrorBanner, Icon, Modal, Surface, Toggle, type Tone } from '@/components/ui';
import { WEEK, describeAvailability, sellerErrorMessage, type SellerAvailability } from './sellerApi';
import { useSellerAvailability, useSetAcceptingOrders } from './sellerQueries';
import { SkeletonBlock, StatusText, linkClass, toast } from './sellerUi';

/** "21:30" -> "9:30 PM". */
export function time12h(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** 0 = Sunday … 6 = Saturday, in the store's timezone. */
export function weekdayIn(timezone: string, now: Date = new Date()): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** Today's saved hours as one phrase. Same rules the server applies. */
export function todayHoursText(a: SellerAvailability, now: Date = new Date()): string {
  if (!a.hoursConfigured) return 'Open all day (no weekly hours saved)';
  const today = a.hours.find((h) => h.dayOfWeek === weekdayIn(a.timezone, now));
  if (!today || today.isClosed) return 'Closed today';
  if (today.opensAt === today.closesAt) return 'Open all day';
  return `${time12h(today.opensAt)} – ${time12h(today.closesAt)}`;
}

export function todayName(a: SellerAvailability, now: Date = new Date()): string {
  return WEEK.find((day) => day.dayOfWeek === weekdayIn(a.timezone, now))?.name ?? 'Today';
}

/** Open / Closed / Temporarily closed / Paused by Aadione. */
export function storeState(a: SellerAvailability): { label: string; tone: Tone } {
  if (a.acceptingOrdersNow) return { label: 'Open', tone: 'brand' };
  switch (a.closedReason) {
    case 'SELLER_INACTIVE':
    case 'SELLER_DELETED':
      return { label: 'Paused by Aadione', tone: 'red' };
    case 'MANUALLY_CLOSED':
    case 'CLOSURE':
      return { label: 'Temporarily closed', tone: 'amber' };
    default:
      return { label: 'Closed', tone: 'gray' };
  }
}

/** "Closes at 9:30 PM" while open; "Opens …" (server text) while closed. */
export function nextChangeText(a: SellerAvailability): string | null {
  if (a.acceptingOrdersNow) {
    if (a.todayClosesAt && a.todayOpensAt !== a.todayClosesAt) return `Closes at ${time12h(a.todayClosesAt)}`;
    // No window today (no hours saved, or the same open/close time): open all day.
    return 'Open all day — no closing time';
  }
  if (a.closedReason === 'MANUALLY_CLOSED') return 'Opens when you switch Accepting Orders back on';
  return a.nextOpenText;
}

/**
 * The Accepting Orders switch. Turning it OFF asks first: customers stop
 * being able to order straight away. Turning it ON needs no confirmation.
 */
export function AcceptingOrdersSwitch({ availability }: { availability: SellerAvailability }) {
  const setAccepting = useSetAcceptingOrders();
  const [confirming, setConfirming] = useState(false);
  const blocked = !availability.isActive;
  const inFlight = useRef(false);

  function apply(next: boolean): void {
    if (inFlight.current) return;
    inFlight.current = true;
    setAccepting.mutate(next, {
      onSuccess: () => toast(next ? 'You are accepting orders again.' : 'Accepting Orders is now OFF.'),
      onSettled: () => {
        inFlight.current = false;
      },
    });
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-gray-700" aria-hidden="true">
          {setAccepting.isPending ? 'Saving…' : availability.isAcceptingOrders ? 'ON' : 'OFF'}
        </span>
        <Toggle
          checked={availability.isAcceptingOrders}
          disabled={setAccepting.isPending || blocked}
          label="Accepting orders"
          onChange={(next) => (next ? apply(true) : setConfirming(true))}
        />
      </div>
      {setAccepting.isError && (
        <div className="mt-3 w-full">
          <ErrorBanner message={sellerErrorMessage(setAccepting.error)} />
        </div>
      )}
      {confirming && (
        <Modal
          title="Stop accepting orders?"
          subtitle="Customers won't be able to place new orders with your store until you turn this back on."
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep accepting
              </Button>
              <Button
                variant="danger"
                disabled={setAccepting.isPending}
                onClick={() => {
                  setConfirming(false);
                  apply(false);
                }}
              >
                Turn OFF
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">Orders you already have are not affected — keep preparing them as usual.</p>
        </Modal>
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-gray-900">{children}</dd>
    </div>
  );
}

/** The store status card. `compact` (dashboard) links to Availability. */
export function StoreStatusCard({ compact = false }: { compact?: boolean }) {
  const availability = useSellerAvailability();

  if (availability.isPending) return <SkeletonBlock lines={2} label="Loading store status…" />;
  if (availability.isError) return <ErrorBanner message={sellerErrorMessage(availability.error)} />;

  const a = availability.data;
  const state = storeState(a);
  const explanation = describeAvailability(a);
  const next = nextChangeText(a);

  return (
    <Surface className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
              a.acceptingOrdersNow ? 'bg-brand-50 text-brand-600' : state.tone === 'red' ? 'bg-danger-50 text-danger-600' : 'bg-gray-100 text-gray-500'
            }`}
          >
            <Icon name="store" className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-gray-900">{a.sellerName}</p>
            {/* The effective state (switch + hours + closures + Aadione), not just the switch. */}
            <p className={`mt-0.5 text-lg font-bold ${a.acceptingOrdersNow ? 'text-brand-600' : 'text-danger-600'}`}>
              <span aria-hidden="true">{a.acceptingOrdersNow ? '🟢 ' : '🔴 '}</span>
              {a.acceptingOrdersNow ? 'Accepting Orders' : 'Not Accepting Orders'}
            </p>
          </div>
        </div>
        <AcceptingOrdersSwitch availability={a} />
      </div>

      <p
        className={`mt-3 text-sm ${
          explanation.tone === 'open' ? 'text-brand-700' : explanation.tone === 'blocked' ? 'text-danger-600' : 'text-gray-600'
        }`}
      >
        {explanation.text}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-gray-100 pt-4 sm:grid-cols-4">
        <Fact label="Store status">
          <StatusText tone={a.isActive ? 'brand' : 'red'}>{a.isActive ? 'Active' : 'Paused by Aadione'}</StatusText>
        </Fact>
        <Fact label="Right now">
          <StatusText tone={state.tone}>{state.label}</StatusText>
        </Fact>
        <Fact label={`Today (${todayName(a)})`}>{todayHoursText(a)}</Fact>
        <Fact label={a.acceptingOrdersNow ? 'Next closing' : 'Next opening'}>{next ?? '—'}</Fact>
      </dl>

      {compact && (
        <div className="mt-4 flex justify-end">
          <Link to="/seller/availability" className={linkClass}>
            Manage availability <Icon name="chevronRight" className="h-4 w-4" />
          </Link>
        </div>
      )}
    </Surface>
  );
}
