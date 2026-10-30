/**
 * App Settings → Global Availability — when the WHOLE Aadione app takes
 * orders (sellers keep their own availability on their pages).
 *
 *   Summary          the server's computed status for now, and what customers see
 *   Master switch    ORDERING_ENABLED + its message (existing config keys)
 *   Weekly hours     PLATFORM_OPERATING_HOURS, in the marketplace timezone
 *   Pauses           pause now (optionally until a time) and scheduled pauses
 *   Closures         holidays (local dates) and the emergency closure
 *   Main location    PLATFORM_LOCATION (informational) + the default radius
 *
 * The page never decides availability: every figure under "Right now" comes
 * from GET /admin/platform-availability, recomputed after each change.
 * Reads need CONFIG_READ; changes need CONFIG_WRITE (the controls are
 * disabled without it, and the API refuses them anyway).
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ConfigKey,
  Permission,
  roleHasPermission,
  type AdminPlatformAvailabilityDto,
  type PlatformDayHours,
  type PlatformHolidayDto,
  type PlatformPauseDto,
} from '@shared';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '@shared/distance';
import { DETECT_MESSAGE, describeAccuracy, type DetectResult } from '@shared/location';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { detectBrowserLocation } from '@/lib/browserLocation';
import {
  PLATFORM_AVAILABILITY_KEY,
  WEEK_DAYS,
  describeHours,
  formatInZone,
  formatLocal,
  hoursProblems,
  platformApi,
  usePlatformAvailabilityAdmin,
  type HolidayBody,
} from '@/lib/platformAvailability';
import LocationMap from '@/components/LocationMap';
import { Button, ErrorBanner, Field, Modal, Panel, Pill, Spinner, Td, Th, Toggle, inputClass } from '@/components/ui';

type View = AdminPlatformAvailabilityDto;

const errorText = (error: unknown, fallback: string) => (error instanceof ApiRequestError ? error.message : fallback);

const STATUS_LABEL: Record<View['availability']['status'], { text: string; tone: 'brand' | 'amber' | 'red' | 'gray' }> = {
  OPEN: { text: 'Open — accepting orders', tone: 'brand' },
  OFF: { text: 'Closed — master switch OFF', tone: 'red' },
  EMERGENCY: { text: 'Closed — emergency closure', tone: 'red' },
  PAUSED: { text: 'Temporarily paused', tone: 'amber' },
  HOLIDAY: { text: 'Closed — holiday', tone: 'amber' },
  OUTSIDE_HOURS: { text: 'Closed — outside operating hours', tone: 'gray' },
};

const REASON_LABEL: Record<string, string> = {
  GLOBAL_DISABLED: 'Master switch is OFF',
  EMERGENCY_CLOSURE: 'Emergency closure is active',
  MANUAL_PAUSE: 'Ordering is paused',
  SCHEDULED_PAUSE: 'A scheduled pause is running',
  HOLIDAY_CLOSURE: 'Holiday / closure day',
  OUTSIDE_OPERATING_HOURS: 'Outside the weekly operating hours',
};

/** One mutation helper: every write answers with the recomputed view. */
function useWrite<T>(send: (input: T) => Promise<View>, onDone?: (view: View) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (view) => {
      queryClient.setQueryData(PLATFORM_AVAILABILITY_KEY, view);
      onDone?.(view);
    },
  });
}

/** Config writes answer with the value only — read the whole view again. */
function useConfigWrite(onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: ConfigKey; value: unknown }) => platformApi.setConfig(key, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLATFORM_AVAILABILITY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      void queryClient.invalidateQueries({ queryKey: ['public-config'] });
      onDone?.();
    },
  });
}

export default function GlobalAvailabilityPage() {
  const role = useAuth((state) => state.user?.role);
  const canWrite = role !== undefined && roleHasPermission(role, Permission.CONFIG_WRITE);
  const view = usePlatformAvailabilityAdmin();
  const [notice, setNotice] = useState<string | null>(null);

  if (view.isPending) return <Spinner label="Loading global availability…" />;
  if (view.isError) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={errorText(view.error, 'Could not load global availability.')} />
        <Button variant="secondary" onClick={() => void view.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const data = view.data;

  return (
    <div className="space-y-5">
      {notice && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
          <span>{notice}</span>
          <button type="button" className="text-xs font-semibold underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!canWrite && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">Read-only — changing these settings needs the Configuration write permission.</p>}

      <Summary data={data} />
      <MasterSwitch data={data} canWrite={canWrite} onNotice={setNotice} />
      <WeeklyHours data={data} canWrite={canWrite} onNotice={setNotice} />
      <Pauses data={data} canWrite={canWrite} onNotice={setNotice} />
      <Closures data={data} canWrite={canWrite} onNotice={setNotice} />
      <MainLocation data={data} canWrite={canWrite} onNotice={setNotice} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* F. Summary                                                                 */
/* -------------------------------------------------------------------------- */

function Summary({ data }: { data: View }) {
  const a = data.availability;
  const s = data.settings;
  const status = STATUS_LABEL[a.status];
  return (
    <Panel title="Right now">
      <div className="grid gap-5 lg:grid-cols-2">
        <dl className="space-y-2 text-sm">
          <Row label="Effective status (computed)">
            <Pill tone={status.tone}>{status.text}</Pill>
          </Row>
          <Row label="Master switch (configured)">
            <Pill tone={s.orderingEnabled ? 'brand' : 'red'}>{s.orderingEnabled ? 'ON' : 'OFF'}</Pill>
          </Row>
          {a.reasonCode && (
            <Row label="Reason">
              {REASON_LABEL[a.reasonCode] ?? a.reasonCode} <span className="text-xs text-gray-500">({a.reasonCode})</span>
            </Row>
          )}
          <Row label="Local time">
            {formatInZone(a.currentTime, a.timezone)} <span className="text-xs text-gray-500">({a.timezone})</span>
          </Row>
          <Row label="Today's hours">{a.hoursConfigured ? describeHours(a.todayOpeningHours) : 'No weekly schedule — no hour restriction'}</Row>
          {a.activeRestriction && (a.activeRestriction.startsAt || a.activeRestriction.endsAt) && (
            <Row label="Active restriction">
              {a.activeRestriction.name ? `${a.activeRestriction.name}: ` : ''}
              {formatInZone(a.activeRestriction.startsAt, a.timezone)} → {a.activeRestriction.endsAt ? formatInZone(a.activeRestriction.endsAt, a.timezone) : 'until ended by an admin'}
            </Row>
          )}
          <Row label="Next opening">
            {a.acceptingOrders ? '—' : a.nextOpeningText ? `${a.nextOpeningText} (${formatInZone(a.nextOpeningAt, a.timezone)})` : 'Not scheduled — reopens only when an admin acts'}
          </Row>
          <Row label="Main location">{s.location ? s.location.addressLine : 'Not set'}</Row>
          <Row label="Default service radius">{s.defaultServiceRadiusKm} km (each seller may have its own)</Row>
        </dl>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-gray-900">What customers see</p>
          <div className={`rounded-xl px-4 py-3 text-sm ${a.acceptingOrders ? 'bg-brand-50 text-brand-700' : 'bg-warn-50 text-gray-800'}`}>
            {a.acceptingOrders ? 'Nothing — the app is taking orders (each store’s own hours and status still apply).' : a.message}
          </div>
          <p className="text-xs text-gray-500">
            Customers can always browse and fill their cart; while closed, the app shows this message and the server refuses every new order and payment start.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 pb-2 last:border-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-900">{children}</dd>
    </div>
  );
}

type SectionProps = { data: View; canWrite: boolean; onNotice: (message: string) => void };

/* -------------------------------------------------------------------------- */
/* A. Master switch                                                           */
/* -------------------------------------------------------------------------- */

function MasterSwitch({ data, canWrite, onNotice }: SectionProps) {
  const s = data.settings;
  const [confirmOff, setConfirmOff] = useState(false);
  const [message, setMessage] = useState(s.pausedMessage);
  useEffect(() => setMessage(s.pausedMessage), [s.pausedMessage]);
  const write = useConfigWrite();

  async function turnOff() {
    if (message.trim() !== s.pausedMessage) await write.mutateAsync({ key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: message.trim() });
    await write.mutateAsync({ key: ConfigKey.ORDERING_ENABLED, value: false });
    setConfirmOff(false);
    onNotice('Master switch OFF — no new orders anywhere in the app until it is switched back on.');
  }

  return (
    <Panel title="Master switch">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            checked={s.orderingEnabled}
            label="Accepting orders (master switch)"
            disabled={!canWrite || write.isPending}
            onChange={(on) => (on ? write.mutate({ key: ConfigKey.ORDERING_ENABLED, value: true }, { onSuccess: () => onNotice('Master switch ON — the schedule, pauses and closures below still apply.') }) : setConfirmOff(true))}
          />
          <span className="font-semibold text-gray-900">Accepting orders: {s.orderingEnabled ? 'ON' : 'OFF'}</span>
          {data.masterSwitchChange && (
            <span className="text-xs text-gray-500">
              Last changed {new Date(data.masterSwitchChange.at).toLocaleString('en-IN')}
              {data.masterSwitchChange.byName ? ` by ${data.masterSwitchChange.byName}` : ''}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500">
          ON does not override the weekly hours, pauses, holidays or an emergency closure — the status above shows what actually applies.
        </p>
        <Field label="Message while the master switch is OFF" hint="Up to 200 characters. Empty = the standard sentence.">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={message} maxLength={200} disabled={!canWrite} onChange={(e) => setMessage(e.target.value)} className={inputClass} />
            <Button
              variant="secondary"
              disabled={!canWrite || write.isPending || message.trim() === s.pausedMessage}
              onClick={() => write.mutate({ key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: message.trim() }, { onSuccess: () => onNotice('Message saved.') })}
            >
              Save message
            </Button>
          </div>
        </Field>
        <ErrorBanner message={write.isError ? errorText(write.error, 'Could not save.') : null} />
      </div>
      {confirmOff && (
        <Modal
          title="Stop all new orders?"
          subtitle="Every seller stops taking new orders. Customers can still browse; orders already placed are not affected."
          onClose={() => setConfirmOff(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmOff(false)}>
                Keep taking orders
              </Button>
              <Button disabled={write.isPending} onClick={() => void turnOff()}>
                {write.isPending ? 'Switching off…' : 'Switch OFF'}
              </Button>
            </>
          }
        >
          <Field label="Message customers will see" hint="Empty = the standard sentence.">
            <input value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} className={inputClass} />
          </Field>
          <p className="mt-2 text-sm text-gray-600">It stays OFF — with no automatic reopening — until someone switches it back on. For a timed break, use “Pause now” with a resume time instead.</p>
        </Modal>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* B. Weekly hours                                                            */
/* -------------------------------------------------------------------------- */

const defaultWeek = (): PlatformDayHours[] => WEEK_DAYS.map(({ dayOfWeek }) => ({ dayOfWeek, isClosed: false, opensAt: '08:00', closesAt: '22:00' }));

function WeeklyHours({ data, canWrite, onNotice }: SectionProps) {
  const saved = data.settings.hours;
  const [enabled, setEnabled] = useState(saved.length > 0);
  const [draft, setDraft] = useState<PlatformDayHours[]>(saved.length > 0 ? saved : defaultWeek());
  const [problem, setProblem] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(data.settings.timezone);
  const signature = JSON.stringify(saved);
  useEffect(() => {
    setEnabled(saved.length > 0);
    setDraft(saved.length > 0 ? saved : defaultWeek());
    // Re-seed only when the SAVED schedule changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => setTimezone(data.settings.timezone), [data.settings.timezone]);

  const save = useWrite((hours: PlatformDayHours[]) => platformApi.setHours(hours), (v) =>
    onNotice(v.settings.hours.length > 0 ? 'Weekly hours saved.' : 'Weekly hours removed — no hour restriction.'),
  );
  const tzWrite = useConfigWrite(() => onNotice(`Timezone set to ${timezone}.`));
  const dirty = enabled ? JSON.stringify([...draft].sort((a, b) => a.dayOfWeek - b.dayOfWeek)) !== signature : saved.length > 0;
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['Asia/Kolkata', 'UTC'];
  const patch = (day: number, changes: Partial<PlatformDayHours>) => setDraft((days) => days.map((d) => (d.dayOfWeek === day ? { ...d, ...changes } : d)));

  function submit() {
    setProblem(null);
    if (!enabled) return save.mutate([]);
    const p = hoursProblems(draft);
    if (p) return setProblem(p);
    save.mutate(draft);
  }

  return (
    <Panel
      title="Weekly operating hours"
      action={
        <Button disabled={!canWrite || !dirty || save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save hours'}
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} disabled={!canWrite} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="font-medium text-gray-900">Only take orders during these weekly hours</span>
        </label>
        {!enabled && <p className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">No weekly schedule: the app takes orders at any hour (each store’s own hours still apply).</p>}
        {enabled && (
          <div className="divide-y divide-gray-100">
            {WEEK_DAYS.map(({ dayOfWeek, name }) => {
              const day = draft.find((d) => d.dayOfWeek === dayOfWeek)!;
              return (
                <div key={dayOfWeek} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                  <span className="w-28 font-medium text-gray-900">{name}</span>
                  <div className="flex w-24 items-center gap-2">
                    <Toggle checked={!day.isClosed} label={`${name} open`} disabled={!canWrite} onChange={(open) => patch(dayOfWeek, { isClosed: !open })} />
                    <span className="text-xs text-gray-600">{day.isClosed ? 'Closed' : 'Open'}</span>
                  </div>
                  <input type="time" aria-label={`${name} opening time`} value={day.opensAt} disabled={!canWrite || day.isClosed} onChange={(e) => patch(dayOfWeek, { opensAt: e.target.value })} className={`${inputClass} !w-32 disabled:bg-gray-50`} />
                  <span className="text-gray-400">to</span>
                  <input type="time" aria-label={`${name} closing time`} value={day.closesAt} disabled={!canWrite || day.isClosed} onChange={(e) => patch(dayOfWeek, { closesAt: e.target.value })} className={`${inputClass} !w-32 disabled:bg-gray-50`} />
                  <span className="text-xs text-gray-500 sm:ml-auto">{describeHours(day)}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-gray-500">
          Opening time included, closing time excluded. The same time twice = open all day. A closing time before the opening time runs past midnight (6:00 PM – 2:00 AM).
        </p>
        <ErrorBanner message={problem ?? (save.isError ? errorText(save.error, 'Could not save the hours.') : null)} />

        <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
          <Field label="Timezone" hint="Hours, holidays and pause times are all read in it — also “today” on the dashboard and reports.">
            <select value={timezone} disabled={!canWrite} onChange={(e) => setTimezone(e.target.value)} className={`${inputClass} sm:!w-72`}>
              {[data.settings.timezone, ...zones.filter((z) => z !== data.settings.timezone)].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="secondary" disabled={!canWrite || tzWrite.isPending || timezone === data.settings.timezone} onClick={() => tzWrite.mutate({ key: ConfigKey.STORE_TIMEZONE, value: timezone })}>
            Save timezone
          </Button>
        </div>
        <ErrorBanner message={tzWrite.isError ? errorText(tzWrite.error, 'Could not save the timezone.') : null} />
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* C. Pauses                                                                  */
/* -------------------------------------------------------------------------- */

const PAUSE_STATUS_TONE: Record<PlatformPauseDto['status'], 'brand' | 'amber' | 'gray' | 'red'> = {
  UPCOMING: 'amber',
  ACTIVE: 'red',
  EXPIRED: 'gray',
  ENDED: 'gray',
  CANCELLED: 'gray',
};

function Pauses({ data, canWrite, onNotice }: SectionProps) {
  const tz = data.settings.timezone;
  const pauses = data.pauses.filter((p) => p.kind !== 'EMERGENCY');
  const activeNow = pauses.find((p) => p.kind === 'IMMEDIATE' && p.status === 'ACTIVE');
  const [nowMessage, setNowMessage] = useState('');
  const [resumeAt, setResumeAt] = useState('');
  const [confirmNow, setConfirmNow] = useState(false);
  const [schedule, setSchedule] = useState({ message: '', startsAt: '', endsAt: '' });
  const [editing, setEditing] = useState<PlatformPauseDto | null>(null);

  const pauseNow = useWrite((x: { message: string | null; resumeAt: string | null }) => platformApi.pauseNow(x.message, x.resumeAt), () => {
    setConfirmNow(false);
    setNowMessage('');
    setResumeAt('');
    onNotice('Ordering paused.');
  });
  const scheduled = useWrite((x: typeof schedule) => platformApi.schedulePause(x.message.trim() || null, x.startsAt, x.endsAt), () => {
    setSchedule({ message: '', startsAt: '', endsAt: '' });
    onNotice('Pause scheduled.');
  });
  const cancel = useWrite((id: string) => platformApi.cancelPause(id), () => onNotice('Scheduled pause cancelled.'));
  const end = useWrite((id: string) => platformApi.endPause(id), () => onNotice('Pause ended — ordering resumes unless something else still applies.'));
  const update = useWrite((x: { id: string; body: { message?: string | null; startsAtLocal?: string; endsAtLocal?: string | null } }) => platformApi.updatePause(x.id, x.body), () => {
    setEditing(null);
    onNotice('Pause updated.');
  });
  const error = [pauseNow, scheduled, cancel, end, update].find((m) => m.isError)?.error;

  return (
    <Panel title="Temporary pauses">
      <div className="space-y-5 text-sm">
        <p className="text-xs text-gray-500">All times are in {tz}. A pause ends on time by itself (no restart needed); ending it never reopens what the master switch, a holiday or the hours keep closed.</p>
        <ErrorBanner message={error ? errorText(error, 'Could not save the pause.') : null} />

        <div className="space-y-2 rounded-xl border border-gray-200 p-3">
          <p className="font-semibold text-gray-900">Pause now</p>
          {activeNow ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Paused since {formatLocal(activeNow.startsAtLocal)} — {activeNow.endsAtLocal ? `resumes ${formatLocal(activeNow.endsAtLocal)}` : 'until resumed'}.
              </span>
              <Button disabled={!canWrite || end.isPending} onClick={() => end.mutate(activeNow.id)}>
                Resume ordering now
              </Button>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
              <Field label="Message (optional)">
                <input value={nowMessage} maxLength={200} disabled={!canWrite} onChange={(e) => setNowMessage(e.target.value)} className={inputClass} placeholder="e.g. Restocking — back shortly" />
              </Field>
              <Field label={`Resume at (${tz}, optional)`}>
                <input type="datetime-local" value={resumeAt} disabled={!canWrite} onChange={(e) => setResumeAt(e.target.value)} className={inputClass} />
              </Field>
              <Button disabled={!canWrite} onClick={() => setConfirmNow(true)}>
                Pause now
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-xl border border-gray-200 p-3">
          <p className="font-semibold text-gray-900">Schedule a pause</p>
          <form
            className="grid gap-2 sm:grid-cols-[13rem_13rem_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (schedule.startsAt && schedule.endsAt && !scheduled.isPending) scheduled.mutate(schedule);
            }}
          >
            <Field label={`Starts (${tz})`}>
              <input type="datetime-local" required value={schedule.startsAt} disabled={!canWrite} onChange={(e) => setSchedule({ ...schedule, startsAt: e.target.value })} className={inputClass} />
            </Field>
            <Field label={`Ends (${tz})`}>
              <input type="datetime-local" required value={schedule.endsAt} disabled={!canWrite} onChange={(e) => setSchedule({ ...schedule, endsAt: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Message (optional)">
              <input value={schedule.message} maxLength={200} disabled={!canWrite} onChange={(e) => setSchedule({ ...schedule, message: e.target.value })} className={inputClass} placeholder="e.g. Temporary maintenance" />
            </Field>
            <Button type="submit" disabled={!canWrite || scheduled.isPending || !schedule.startsAt || !schedule.endsAt}>
              {scheduled.isPending ? 'Saving…' : 'Schedule'}
            </Button>
          </form>
          <p className="text-xs text-gray-500">Scheduled pauses cannot overlap each other. Edit or cancel one before it starts.</p>
        </div>

        <PauseTable pauses={pauses} canWrite={canWrite} onCancel={(id) => cancel.mutate(id)} onEnd={(id) => end.mutate(id)} onEdit={setEditing} busy={cancel.isPending || end.isPending} />
      </div>

      {confirmNow && (
        <Modal
          title="Pause ordering now?"
          subtitle={resumeAt ? `Ordering resumes at ${formatLocal(resumeAt)} (${tz}), unless something else keeps it closed.` : 'Ordering stays paused until someone resumes it.'}
          onClose={() => setConfirmNow(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmNow(false)}>
                Cancel
              </Button>
              <Button disabled={pauseNow.isPending} onClick={() => pauseNow.mutate({ message: nowMessage.trim() || null, resumeAt: resumeAt || null })}>
                {pauseNow.isPending ? 'Pausing…' : 'Pause ordering'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">Every seller stops taking new orders. Orders already placed are not affected.</p>
        </Modal>
      )}
      {editing && <EditPause pause={editing} tz={tz} busy={update.isPending} onClose={() => setEditing(null)} onSave={(body) => update.mutate({ id: editing.id, body })} />}
    </Panel>
  );
}

function PauseTable({
  pauses,
  canWrite,
  busy,
  onCancel,
  onEnd,
  onEdit,
}: {
  pauses: PlatformPauseDto[];
  canWrite: boolean;
  busy: boolean;
  onCancel: (id: string) => void;
  onEnd: (id: string) => void;
  onEdit: (pause: PlatformPauseDto) => void;
}) {
  if (pauses.length === 0) return <p className="text-gray-500">No pauses in the last 30 days or ahead.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-y border-gray-200 bg-gray-50">
          <tr>
            <Th>Type</Th>
            <Th>From</Th>
            <Th>Until</Th>
            <Th>Message</Th>
            <Th>Status</Th>
            <Th>{''}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {pauses.map((p) => (
            <tr key={p.id}>
              <Td>{p.kind === 'SCHEDULED' ? 'Scheduled' : 'Pause now'}</Td>
              <Td className="whitespace-nowrap">{formatLocal(p.startsAtLocal)}</Td>
              <Td className="whitespace-nowrap">{p.endsAtLocal ? formatLocal(p.endsAtLocal) : 'Until resumed'}</Td>
              <Td className="max-w-xs truncate text-gray-700">{p.message ?? '—'}</Td>
              <Td>
                <Pill tone={PAUSE_STATUS_TONE[p.status]}>{p.status}</Pill>
              </Td>
              <Td className="whitespace-nowrap text-right">
                {canWrite && (p.status === 'UPCOMING' || p.status === 'ACTIVE') && (
                  <span className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => onEdit(p)}>
                      Edit
                    </Button>
                    {p.status === 'UPCOMING' ? (
                      <Button variant="secondary" disabled={busy} onClick={() => onCancel(p.id)}>
                        Cancel
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={busy} onClick={() => onEnd(p.id)}>
                        End now
                      </Button>
                    )}
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditPause({
  pause,
  tz,
  busy,
  onClose,
  onSave,
}: {
  pause: PlatformPauseDto;
  tz: string;
  busy: boolean;
  onClose: () => void;
  onSave: (body: { message?: string | null; startsAtLocal?: string; endsAtLocal?: string | null }) => void;
}) {
  const [message, setMessage] = useState(pause.message ?? '');
  const [startsAt, setStartsAt] = useState(pause.startsAtLocal);
  const [endsAt, setEndsAt] = useState(pause.endsAtLocal ?? '');
  const reschedulable = pause.kind === 'SCHEDULED' && pause.status === 'UPCOMING';
  const resumeEditable = pause.kind === 'IMMEDIATE';
  return (
    <Modal
      title="Edit pause"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              onSave({
                message: message.trim() || null,
                ...(reschedulable ? { startsAtLocal: startsAt, endsAtLocal: endsAt } : {}),
                ...(resumeEditable ? { endsAtLocal: endsAt || null } : {}),
              })
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Message">
          <input value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} className={inputClass} />
        </Field>
        {reschedulable && (
          <Field label={`Starts (${tz})`}>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputClass} />
          </Field>
        )}
        {(reschedulable || resumeEditable) && (
          <Field label={reschedulable ? `Ends (${tz})` : `Resume at (${tz}) — empty = until resumed`}>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputClass} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* D. Holidays and emergency closure                                          */
/* -------------------------------------------------------------------------- */

const emptyHoliday = (): HolidayBody => ({ name: '', message: null, startDate: '', endDate: '' });

function Closures({ data, canWrite, onNotice }: SectionProps) {
  const emergency = data.pauses.find((p) => p.kind === 'EMERGENCY' && p.status === 'ACTIVE');
  const [confirmEmergency, setConfirmEmergency] = useState(false);
  const [emergencyMessage, setEmergencyMessage] = useState('');
  const [form, setForm] = useState<HolidayBody>(emptyHoliday());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PlatformHolidayDto | null>(null);

  const start = useWrite((message: string | null) => platformApi.startEmergency(message), () => {
    setConfirmEmergency(false);
    setEmergencyMessage('');
    onNotice('Emergency closure started — no new orders until it is ended.');
  });
  const endEmergency = useWrite((id: string) => platformApi.endPause(id), () => onNotice('Emergency closure ended.'));
  const saveHoliday = useWrite((x: { id: string | null; body: HolidayBody }) => (x.id ? platformApi.updateHoliday(x.id, x.body) : platformApi.addHoliday(x.body)), () => {
    setForm(emptyHoliday());
    setEditingId(null);
    onNotice('Closure saved.');
  });
  const remove = useWrite((id: string) => platformApi.deleteHoliday(id), () => {
    setRemoving(null);
    onNotice('Closure removed.');
  });
  const error = [start, endEmergency, saveHoliday, remove].find((m) => m.isError)?.error;

  return (
    <Panel title="Holidays and emergency closures">
      <div className="space-y-5 text-sm">
        <ErrorBanner message={error ? errorText(error, 'Could not save.') : null} />

        <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 ${emergency ? 'bg-danger-50' : 'border border-gray-200'}`}>
          <div>
            <p className="font-semibold text-gray-900">Emergency closure</p>
            <p className="text-xs text-gray-600">
              {emergency
                ? `Active since ${formatLocal(emergency.startsAtLocal)}${emergency.message ? ` — “${emergency.message}”` : ''}. Enforced by the server on every order.`
                : 'Closes ordering immediately for everyone (severe weather, outages). It stays until ended here.'}
            </p>
          </div>
          {emergency ? (
            <Button disabled={!canWrite || endEmergency.isPending} onClick={() => endEmergency.mutate(emergency.id)}>
              End emergency closure
            </Button>
          ) : (
            <Button disabled={!canWrite} onClick={() => setConfirmEmergency(true)}>
              Start emergency closure
            </Button>
          )}
        </div>

        <div className="space-y-2 rounded-xl border border-gray-200 p-3">
          <p className="font-semibold text-gray-900">{editingId ? 'Edit closure' : 'Add a holiday / closure'}</p>
          <form
            className="grid gap-2 sm:grid-cols-[1fr_10rem_10rem] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (saveHoliday.isPending) return;
              saveHoliday.mutate({ id: editingId, body: { ...form, name: form.name.trim(), message: form.message?.trim() || null, endDate: form.endDate || form.startDate } });
            }}
          >
            <Field label="Name">
              <input required minLength={2} maxLength={80} value={form.name} disabled={!canWrite} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} placeholder="e.g. Diwali" />
            </Field>
            <Field label="First day">
              <input type="date" required value={form.startDate} disabled={!canWrite} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Last day (optional)">
              <input type="date" value={form.endDate} min={form.startDate || undefined} disabled={!canWrite} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className={inputClass} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Message (optional)">
                <input value={form.message ?? ''} maxLength={200} disabled={!canWrite} onChange={(e) => setForm({ ...form, message: e.target.value })} className={inputClass} placeholder="e.g. Happy Diwali! We are back on Friday." />
              </Field>
            </div>
            <div className="flex gap-2">
              {editingId && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditingId(null);
                    setForm(emptyHoliday());
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button type="submit" disabled={!canWrite || saveHoliday.isPending || !form.name.trim() || !form.startDate}>
                {saveHoliday.isPending ? 'Saving…' : editingId ? 'Save' : 'Add closure'}
              </Button>
            </div>
          </form>
          <p className="text-xs text-gray-500">Whole local days in {data.settings.timezone}: closed from 00:00 on the first day until midnight after the last. Closures cannot overlap.</p>
        </div>

        {data.holidays.length === 0 ? (
          <p className="text-gray-500">No closures in the last 30 days or ahead.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-y border-gray-200 bg-gray-50">
                <tr>
                  <Th>Name</Th>
                  <Th>Dates</Th>
                  <Th>Message</Th>
                  <Th>Status</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.holidays.map((h) => (
                  <tr key={h.id}>
                    <Td className="font-medium text-gray-900">{h.name}</Td>
                    <Td className="whitespace-nowrap">{h.startDate === h.endDate ? h.startDate : `${h.startDate} → ${h.endDate}`}</Td>
                    <Td className="max-w-xs truncate text-gray-700">{h.message ?? '—'}</Td>
                    <Td>
                      <Pill tone={h.status === 'ACTIVE' ? 'red' : h.status === 'UPCOMING' ? 'amber' : 'gray'}>{h.status}</Pill>
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      {canWrite && (
                        <span className="flex justify-end gap-2">
                          {h.status !== 'PAST' && (
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setEditingId(h.id);
                                setForm({ name: h.name, message: h.message, startDate: h.startDate, endDate: h.endDate });
                              }}
                            >
                              Edit
                            </Button>
                          )}
                          <Button variant="secondary" onClick={() => setRemoving(h)}>
                            Remove
                          </Button>
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmEmergency && (
        <Modal
          title="Start an emergency closure?"
          subtitle="All new orders stop immediately, for every seller, until you end it here."
          onClose={() => setConfirmEmergency(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmEmergency(false)}>
                Cancel
              </Button>
              <Button disabled={start.isPending} onClick={() => start.mutate(emergencyMessage.trim() || null)}>
                {start.isPending ? 'Starting…' : 'Close ordering now'}
              </Button>
            </>
          }
        >
          <Field label="Message customers will see (optional)">
            <input value={emergencyMessage} maxLength={200} onChange={(e) => setEmergencyMessage(e.target.value)} className={inputClass} placeholder="e.g. Heavy rain — deliveries are suspended for now." />
          </Field>
        </Modal>
      )}
      {removing && (
        <Modal
          title={`Remove “${removing.name}”?`}
          subtitle={removing.status === 'ACTIVE' ? 'It is active now: ordering reopens at once unless something else keeps it closed.' : undefined}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRemoving(null)}>
                Keep it
              </Button>
              <Button disabled={remove.isPending} onClick={() => remove.mutate(removing.id)}>
                Remove closure
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">
            {removing.startDate === removing.endDate ? removing.startDate : `${removing.startDate} → ${removing.endDate}`}
          </p>
        </Modal>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* E. Main location and default radius                                        */
/* -------------------------------------------------------------------------- */

function MainLocation({ data, canWrite, onNotice }: SectionProps) {
  const saved = data.settings.location;
  const [address, setAddress] = useState(saved?.addressLine ?? '');
  const [landmark, setLandmark] = useState(saved?.landmark ?? '');
  const [lat, setLat] = useState(saved ? String(saved.latitude) : '');
  const [lng, setLng] = useState(saved ? String(saved.longitude) : '');
  const [radius, setRadius] = useState(String(data.settings.defaultServiceRadiusKm));
  const [problem, setProblem] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [detected, setDetected] = useState<Extract<DetectResult, { status: 'OK' }> | null>(null);
  useEffect(() => setRadius(String(data.settings.defaultServiceRadiusKm)), [data.settings.defaultServiceRadiusKm]);

  const save = useWrite((location: Parameters<typeof platformApi.setLocation>[0]) => platformApi.setLocation(location), (v) =>
    onNotice(v.settings.location ? 'Main location saved.' : 'Main location cleared.'),
  );
  const radiusWrite = useConfigWrite(() => onNotice('Default service radius saved.'));

  const latitude = Number(lat);
  const longitude = Number(lng);
  const pointProblem = lat.trim() && lng.trim() ? coordinateProblem(latitude, longitude, { requireIndia: true }) : 'MISSING';

  async function useDevice() {
    setLocating(true);
    setDetected(null);
    const result = await detectBrowserLocation();
    setLocating(false);
    if (result.status !== 'OK') return setProblem(`${DETECT_MESSAGE[result.status]} Enter the point yourself.`);
    setDetected(result);
  }

  function submit() {
    setProblem(null);
    if (address.trim().length < 2) return setProblem('Enter the address.');
    if (pointProblem) return setProblem(pointProblem === 'MISSING' ? 'Set the map point: drag the pin or enter latitude and longitude.' : COORDINATE_PROBLEM_MESSAGE[pointProblem]);
    save.mutate({ addressLine: address.trim(), landmark: landmark.trim() || null, latitude, longitude });
  }

  return (
    <Panel title="Main Aadione location and service radius">
      <div className="space-y-3 text-sm">
        <p className="rounded-lg bg-info-50 px-3 py-2 text-gray-700">
          Informational: Aadione’s main address and point. It is <span className="font-semibold">not</span> a delivery origin — whether an address is
          served is measured from each seller’s own map point and radius (Sellers → a seller → Delivery area).
        </p>
        <Field label="Address" required>
          <input value={address} maxLength={300} disabled={!canWrite} onChange={(e) => setAddress(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Landmark">
          <input value={landmark} maxLength={160} disabled={!canWrite} onChange={(e) => setLandmark(e.target.value)} className={inputClass} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Latitude" required>
            <input value={lat} inputMode="decimal" disabled={!canWrite} onChange={(e) => setLat(e.target.value)} className={inputClass} placeholder="e.g. 25.02900" />
          </Field>
          <Field label="Longitude" required>
            <input value={lng} inputMode="decimal" disabled={!canWrite} onChange={(e) => setLng(e.target.value)} className={inputClass} placeholder="e.g. 74.10960" />
          </Field>
        </div>
        {lat.trim() && lng.trim() && pointProblem && pointProblem !== 'MISSING' && <p className="text-xs text-danger-600">{COORDINATE_PROBLEM_MESSAGE[pointProblem]}</p>}
        <LocationMap
          pin={pointProblem ? null : { latitude, longitude }}
          onPinChange={
            canWrite
              ? (p) => {
                  setLat(String(p.latitude));
                  setLng(String(p.longitude));
                }
              : undefined
          }
          radiusKm={data.settings.defaultServiceRadiusKm}
          label="Main location — click or drag the pin"
        />
        {canWrite && (
          <button type="button" onClick={() => void useDevice()} disabled={locating} className="text-left text-sm font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-60">
            {locating ? 'Reading this device’s location…' : 'Use this device’s location — only when you are at the main location'}
          </button>
        )}
        {detected && (
          <div role="status" className="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">
            Found {detected.latitude.toFixed(6)}, {detected.longitude.toFixed(6)} — {describeAccuracy(detected.accuracyM)}.{' '}
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => {
                setLat(detected.latitude.toFixed(6));
                setLng(detected.longitude.toFixed(6));
                setDetected(null);
              }}
            >
              Use this point
            </button>{' '}
            <button type="button" className="underline" onClick={() => setDetected(null)}>
              Discard
            </button>
          </div>
        )}
        <ErrorBanner message={problem ?? (save.isError ? errorText(save.error, 'Could not save the location.') : null)} />
        <div className="flex flex-wrap justify-end gap-2">
          {saved && (
            <Button variant="secondary" disabled={!canWrite || save.isPending} onClick={() => save.mutate(null)}>
              Clear location
            </Button>
          )}
          <Button disabled={!canWrite || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save location'}
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
          <Field label="Default service radius (km)" hint="Straight-line, from each seller’s own point; above 0 and at most 50. A seller’s own radius overrides it.">
            <div className="w-32">
              <input type="number" min={0.1} max={50} step={0.1} value={radius} disabled={!canWrite} onChange={(e) => setRadius(e.target.value)} className={inputClass} />
            </div>
          </Field>
          <Button
            variant="secondary"
            disabled={!canWrite || radiusWrite.isPending || Number(radius) === data.settings.defaultServiceRadiusKm}
            onClick={() => radiusWrite.mutate({ key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: Number(radius) })}
          >
            Save radius
          </Button>
        </div>
        <ErrorBanner message={radiusWrite.isError ? errorText(radiusWrite.error, 'Could not save the radius.') : null} />
      </div>
    </Panel>
  );
}
