/**
 * The seller's own availability: the Accepting Orders switch
 * (PATCH /seller/availability), weekly hours (PUT /seller/hours) and date
 * closures (POST / DELETE /seller/closures). Everything reads from
 * GET /seller/availability, which every one of those writes also returns.
 * Admin deactivation is never writable from here, and nothing here changes
 * how the server combines these into "can customers order now".
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorBanner, Field, Icon, Modal, Panel, Pill, Toggle, inputClass } from '@/components/ui';
import { todayIsoInIndia } from '@/lib/dashboardDate';
import { WEEK, sellerApi, sellerErrorMessage, type SellerAvailability, type SellerHours } from '../sellerApi';
import { sellerKeys, useSellerAvailability } from '../sellerQueries';
import { StoreStatusCard, time12h, weekdayIn } from '../storeStatus';
import { EmptyPanel, LoadError, SkeletonBlock, toast } from '../sellerUi';

export default function SellerAvailabilityPage() {
  const availability = useSellerAvailability();

  return (
    <div className="space-y-5">
      <StoreStatusCard />

      <div className="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
        <Icon name="shield" className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
        <p>
          <span className="font-semibold text-gray-800">Aadione can pause your store.</span> When it does, customers can't order
          and you can't switch it back on from here — an Aadione restriction always wins. Turning Accepting Orders OFF yourself
          stops new orders only; orders you already have are not affected.
        </p>
      </div>

      {availability.isPending ? (
        <SkeletonBlock lines={7} label="Loading hours…" />
      ) : availability.isError ? (
        <LoadError message={sellerErrorMessage(availability.error)} onRetry={() => void availability.refetch()} />
      ) : (
        <>
          <WeeklyHours availability={availability.data} />
          <Closures availability={availability.data} />
        </>
      )}
    </div>
  );
}

/**
 * All seven days, as the server applies them: with NO saved schedule the
 * store is open all day every day; once a schedule exists, a day with no
 * row is closed. The form starts from exactly that, so saving it unchanged
 * never changes when the store is open.
 */
function fullWeek(hours: SellerHours[]): SellerHours[] {
  const configured = hours.length > 0;
  return WEEK.map(
    ({ dayOfWeek }) =>
      hours.find((h) => h.dayOfWeek === dayOfWeek) ??
      (configured
        ? { dayOfWeek, opensAt: '09:00', closesAt: '21:00', isClosed: true }
        : { dayOfWeek, opensAt: '00:00', closesAt: '00:00', isClosed: false }),
  );
}

function useSaveAvailability<TInput>(send: (input: TInput) => Promise<SellerAvailability>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => queryClient.setQueryData(sellerKeys.availability, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sellerKeys.availability }),
  });
}

function dayHours(day: SellerHours): string {
  if (day.isClosed) return 'Closed';
  if (day.opensAt === day.closesAt) return 'Open all day';
  return `${time12h(day.opensAt)} – ${time12h(day.closesAt)}`;
}

function WeeklyHours({ availability }: { availability: SellerAvailability }) {
  const serverWeek = useMemo(() => fullWeek(availability.hours), [availability.hours]);
  const serverSignature = JSON.stringify(serverWeek);
  const [draft, setDraft] = useState<SellerHours[]>(serverWeek);
  const [seededFrom, setSeededFrom] = useState(serverSignature);
  const save = useSaveAvailability((hours: SellerHours[]) => sellerApi.put<SellerAvailability>('/seller/hours', { hours }));
  const today = weekdayIn(availability.timezone);

  // Re-seed the form when the SAVED hours change (after a save, or an edit
  // made elsewhere) — a background refetch of unchanged hours keeps edits.
  if (serverSignature !== seededFrom) {
    setSeededFrom(serverSignature);
    setDraft(serverWeek);
  }

  const dirty = JSON.stringify(draft) !== serverSignature;

  function patch(dayOfWeek: number, changes: Partial<SellerHours>): void {
    setDraft((days) => days.map((day) => (day.dayOfWeek === dayOfWeek ? { ...day, ...changes } : day)));
  }

  return (
    <Panel
      title="Weekly hours"
      action={
        <div className="flex gap-2">
          {dirty && (
            <Button variant="ghost" disabled={save.isPending} onClick={() => setDraft(serverWeek)}>
              Discard
            </Button>
          )}
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(draft, { onSuccess: () => toast('Weekly hours saved.') })}>
            {save.isPending ? 'Saving…' : 'Save hours'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {!availability.hoursConfigured && (
          <p className="rounded-xl bg-warn-50 px-3.5 py-2.5 text-sm text-gray-700">
            No weekly hours saved yet, so your store is open all day, every day. Set your hours and save.
          </p>
        )}
        {save.isError && <ErrorBanner message={sellerErrorMessage(save.error)} />}
        {dirty && <p className="text-sm font-medium text-warn-500">You have unsaved changes.</p>}

        <div className="divide-y divide-gray-100">
          {WEEK.map(({ dayOfWeek, name }) => {
            const day = draft.find((d) => d.dayOfWeek === dayOfWeek)!;
            const isToday = dayOfWeek === today;
            return (
              <div key={dayOfWeek} className={`flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 ${isToday ? '-mx-2 rounded-xl bg-brand-50/50 px-2' : ''}`}>
                <span className="flex w-32 items-center gap-2 text-sm font-medium text-gray-900">
                  {name}
                  {isToday && <Pill tone="brand">Today</Pill>}
                </span>
                <div className="flex w-24 items-center gap-2">
                  <Toggle checked={!day.isClosed} label={`${name} open`} onChange={(open) => patch(dayOfWeek, { isClosed: !open })} />
                  <span className="text-xs font-medium text-gray-600">{day.isClosed ? 'Closed' : 'Open'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={day.opensAt}
                    disabled={day.isClosed}
                    aria-label={`${name} opening time`}
                    onChange={(event) => patch(dayOfWeek, { opensAt: event.target.value })}
                    className={`${inputClass} w-[7.5rem] disabled:bg-gray-50 disabled:text-gray-400`}
                  />
                  <span className="text-sm text-gray-400">to</span>
                  <input
                    type="time"
                    value={day.closesAt}
                    disabled={day.isClosed}
                    aria-label={`${name} closing time`}
                    onChange={(event) => patch(dayOfWeek, { closesAt: event.target.value })}
                    className={`${inputClass} w-[7.5rem] disabled:bg-gray-50 disabled:text-gray-400`}
                  />
                </div>
                <span className="text-xs text-gray-500 sm:ml-auto">{dayHours(day)}</span>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-gray-500">
          Times are in {availability.timezone}. The same opening and closing time means open all day; a closing time earlier than
          the opening time runs past midnight.
        </p>
      </div>
    </Panel>
  );
}

function formatClosureDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function Closures({ availability }: { availability: SellerAvailability }) {
  const today = todayIsoInIndia();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState<{ id: string; date: string } | null>(null);
  const add = useSaveAvailability((input: { date: string; reason: string | null }) =>
    sellerApi.post<SellerAvailability>('/seller/closures', input),
  );
  const remove = useSaveAvailability((id: string) => sellerApi.delete<SellerAvailability>(`/seller/closures/${id}`));

  return (
    <Panel title="Closures">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Days your store is closed all day — holidays, stock-taking, travel. Customers cannot order on those days.
        </p>

        {(add.isError || remove.isError) && <ErrorBanner message={sellerErrorMessage(add.error ?? remove.error)} />}

        {availability.upcomingClosures.length === 0 ? (
          <EmptyPanel icon="calendar" title="No upcoming closures" hint="Add a date below if you'll be closed for a day." />
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
            {availability.upcomingClosures.map((closure) => {
              const current = closure.date === today;
              return (
                <li key={closure.id} className={`flex items-center justify-between gap-3 px-4 py-3 ${current ? 'bg-warn-50/60' : ''}`}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-900">
                      {formatClosureDate(closure.date)}
                      {current && <Pill tone="amber">Today · closed now</Pill>}
                    </p>
                    {closure.reason && <p className="truncate text-xs text-gray-500">{closure.reason}</p>}
                  </div>
                  <Button variant="secondary" disabled={remove.isPending} onClick={() => setRemoving({ id: closure.id, date: closure.date })}>
                    {remove.isPending && remove.variables === closure.id ? 'Removing…' : 'Remove'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <form
          className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (!date || add.isPending) return;
            add.mutate(
              { date, reason: reason.trim() || null },
              {
                onSuccess: () => {
                  toast(`Closed on ${formatClosureDate(date)}.`);
                  setDate('');
                  setReason('');
                },
              },
            );
          }}
        >
          <Field label="Date">
            <input type="date" value={date} min={today} onChange={(event) => setDate(event.target.value)} className={inputClass} required />
          </Field>
          <Field label="Reason (optional)">
            <input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} className={inputClass} placeholder="e.g. Diwali holiday" />
          </Field>
          <Button type="submit" disabled={!date || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add closure'}
          </Button>
        </form>
      </div>

      {removing && (
        <Modal
          title={`Open on ${formatClosureDate(removing.date)}?`}
          subtitle="Customers will be able to order that day, during your weekly hours."
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRemoving(null)}>
                Keep closure
              </Button>
              <Button
                disabled={remove.isPending}
                onClick={() => {
                  const target = removing;
                  setRemoving(null);
                  remove.mutate(target.id, { onSuccess: () => toast(`Open again on ${formatClosureDate(target.date)}.`) });
                }}
              >
                Remove closure
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">You can add the closure again at any time.</p>
        </Modal>
      )}
    </Panel>
  );
}
