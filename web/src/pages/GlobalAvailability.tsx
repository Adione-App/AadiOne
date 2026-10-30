/**
 * Marketplace Admin → Configuration — the Aadione app's availability and main
 * store location, at the top of the Configuration page (Config.tsx renders
 * this first). In order:
 *
 *   1. Aadione App Availability   master switch (ORDERING_ENABLED) + its message
 *   2. Daily Operating Hours      Monday–Sunday (PLATFORM_OPERATING_HOURS), timezone
 *   3. Operating Mode             Fixed Timing / Always Open (PLATFORM_OPERATING_MODE)
 *   4. Temporary Pause & Scheduled Closure
 *   5. Holidays & Emergency Closure
 *   6. Aadione Main Store Location (PLATFORM_LOCATION — informational)
 *   7. Global Default Delivery Radius (MAX_SERVICE_RADIUS_KM)
 *   8. Effective App Status & Customer Message Preview
 *
 * The page never decides availability: the status figures come from
 * GET /admin/platform-availability (the backend's one rule), recomputed after
 * every change. Sellers keep their own availability, hours, location and
 * radius on their own pages — nothing here edits them. Reads need
 * CONFIG_READ; changes need CONFIG_WRITE (controls are disabled without it,
 * and the API refuses them anyway).
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
  type PlatformOperatingMode,
  type PlatformPauseDto,
} from '@shared';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '@shared/distance';
import { DETECT_MESSAGE, describeAccuracy } from '@shared/location';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { detectBrowserLocation } from '@/lib/browserLocation';
import { REVERSE_GEOCODE_URL, suggestAddress } from '@/lib/mapConfig';
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
type SectionProps = { data: View; canWrite: boolean; onNotice: (message: string) => void };

const errorText = (error: unknown, fallback: string) => (error instanceof ApiRequestError ? error.message : fallback);

const STATUS_LABEL: Record<View['availability']['status'], { text: string; tone: 'brand' | 'amber' | 'red' | 'gray' }> = {
  OPEN: { text: 'OPEN — taking orders', tone: 'brand' },
  OFF: { text: 'CLOSED — app switched OFF', tone: 'red' },
  EMERGENCY: { text: 'CLOSED — emergency closure', tone: 'red' },
  PAUSED: { text: 'CLOSED — temporarily paused', tone: 'amber' },
  HOLIDAY: { text: 'CLOSED — holiday', tone: 'amber' },
  OUTSIDE_HOURS: { text: 'CLOSED — outside operating hours', tone: 'gray' },
};

const REASON_LABEL: Record<string, string> = {
  GLOBAL_DISABLED: 'Aadione App Availability is switched OFF',
  EMERGENCY_CLOSURE: 'An emergency closure is active',
  MANUAL_PAUSE: 'Ordering is paused',
  SCHEDULED_PAUSE: 'A scheduled pause is running',
  HOLIDAY_CLOSURE: 'Holiday / closure day',
  OUTSIDE_OPERATING_HOURS: 'Outside the daily operating hours',
};

const MODE_LABEL: Record<PlatformOperatingMode, string> = { FIXED_TIMING: 'Fixed Timing', ALWAYS_OPEN: 'Always Open' };

/** Every write answers with the recomputed view. */
function useWrite<T>(send: (input: T) => Promise<View>, onDone?: (view: View) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (view) => {
      queryClient.setQueryData(PLATFORM_AVAILABILITY_KEY, view);
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      onDone?.(view);
    },
  });
}

/** Existing configuration keys answer with the value only — read the whole view again. */
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

const changedText = (change: { at: string; byName: string | null } | null) =>
  change ? `Last updated ${new Date(change.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${change.byName ? ` by ${change.byName}` : ''}` : null;

export default function GlobalAvailabilitySettings() {
  const role = useAuth((state) => state.user?.role);
  const canWrite = role !== undefined && roleHasPermission(role, Permission.CONFIG_WRITE);
  const view = usePlatformAvailabilityAdmin();
  const [notice, setNotice] = useState<string | null>(null);

  if (view.isPending) return <Spinner label="Loading app availability…" />;
  if (view.isError) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={errorText(view.error, 'Could not load the app availability settings.')} />
        <Button variant="secondary" onClick={() => void view.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const data = view.data;
  const props: SectionProps = { data, canWrite, onNotice: setNotice };

  return (
    <div id="app-availability" className="scroll-mt-24 space-y-5">
      {notice && (
        <div role="status" className="sticky top-2 z-10 flex items-start justify-between gap-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700 shadow-sm">
          <span>{notice}</span>
          <button type="button" className="text-xs font-semibold underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!canWrite && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">Read-only — changing these settings needs the Configuration write permission.</p>}

      <AppAvailabilitySwitch {...props} />
      <DailyOperatingHours {...props} />
      <OperatingMode {...props} />
      <Pauses {...props} />
      <Closures {...props} />
      <MainStoreLocation {...props} />
      <DefaultRadius {...props} />
      <EffectiveStatus data={data} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 py-2 last:border-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-900">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Aadione App Availability                                                */
/* -------------------------------------------------------------------------- */

function AppAvailabilitySwitch({ data, canWrite, onNotice }: SectionProps) {
  const s = data.settings;
  const a = data.availability;
  const status = STATUS_LABEL[a.status];
  const [confirmOff, setConfirmOff] = useState(false);
  const [message, setMessage] = useState(s.pausedMessage);
  useEffect(() => setMessage(s.pausedMessage), [s.pausedMessage]);
  const write = useConfigWrite();

  async function turnOff() {
    if (message.trim() !== s.pausedMessage) await write.mutateAsync({ key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: message.trim() });
    await write.mutateAsync({ key: ConfigKey.ORDERING_ENABLED, value: false });
    setConfirmOff(false);
    onNotice('Aadione App Availability is OFF — every store shows closed and no new orders are accepted until it is switched back on.');
  }

  return (
    <Panel title="Aadione App Availability">
      <div className="space-y-4 text-sm">
        <div className={`flex flex-wrap items-center gap-4 rounded-xl p-4 ${s.orderingEnabled ? 'bg-brand-50' : 'bg-danger-50'}`}>
          <Toggle
            checked={s.orderingEnabled}
            label="Aadione App Availability"
            disabled={!canWrite || write.isPending}
            onChange={(on) =>
              on
                ? write.mutate(
                    { key: ConfigKey.ORDERING_ENABLED, value: true },
                    { onSuccess: () => onNotice('Aadione App Availability is ON — hours, pauses, holidays and each store’s own availability still apply.') },
                  )
                : setConfirmOff(true)
            }
          />
          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900">App ordering: {s.orderingEnabled ? 'ON' : 'OFF'}</p>
            <p className="text-xs text-gray-600">{changedText(data.masterSwitchChange) ?? 'Never changed'}</p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-xs text-gray-500">Effective status now</p>
            <Pill tone={status.tone}>{status.text}</Pill>
          </div>
        </div>
        {a.reasonCode && (
          <p className="text-gray-700">
            <span className="font-semibold">Why closed:</span> {REASON_LABEL[a.reasonCode] ?? a.reasonCode}
            {a.nextOpeningText ? ` · ${a.nextOpeningText}` : ''}
          </p>
        )}
        <p className="text-xs text-gray-500">
          OFF closes ordering in the whole app: every store shows closed, customers keep browsing, orders already placed are not touched, and no
          seller’s own settings change. ON does not override the operating hours, pauses, holidays or an emergency — or a store’s own closure.
        </p>
        <Field label="Message customers see while the app is OFF" hint="Up to 200 characters. Empty = “Ordering is paused right now. You can keep browsing and adding items to your cart.”">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={message} maxLength={200} disabled={!canWrite} onChange={(e) => setMessage(e.target.value)} className={inputClass} />
            <Button
              variant="secondary"
              disabled={!canWrite || write.isPending || message.trim() === s.pausedMessage}
              onClick={() => write.mutate({ key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: message.trim() }, { onSuccess: () => onNotice('Closure message saved.') })}
            >
              Save message
            </Button>
          </div>
        </Field>
        <ErrorBanner message={write.isError ? errorText(write.error, 'Could not save.') : null} />
      </div>
      {confirmOff && (
        <Modal
          title="Switch the whole Aadione app OFF?"
          subtitle="Every store shows closed and no new orders are accepted. Customers can still browse; orders already placed are not affected."
          onClose={() => setConfirmOff(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmOff(false)}>
                Keep it ON
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
          <p className="mt-2 text-sm text-gray-600">It stays OFF until someone switches it back ON. For a timed break, use “Pause now” below instead.</p>
        </Modal>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Daily Operating Hours                                                   */
/* -------------------------------------------------------------------------- */

const defaultWeek = (): PlatformDayHours[] => WEEK_DAYS.map(({ dayOfWeek }) => ({ dayOfWeek, isClosed: false, opensAt: '08:00', closesAt: '22:00' }));
const sortWeek = (hours: PlatformDayHours[]) => [...hours].sort((a, b) => a.dayOfWeek - b.dayOfWeek);

function DailyOperatingHours({ data, canWrite, onNotice }: SectionProps) {
  const saved = data.settings.hours;
  const signature = JSON.stringify(saved);
  const [draft, setDraft] = useState<PlatformDayHours[]>(saved.length > 0 ? saved : defaultWeek());
  const [problem, setProblem] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(data.settings.timezone);
  useEffect(() => {
    setDraft(saved.length > 0 ? saved : defaultWeek());
    // Re-seed only when the SAVED schedule changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => setTimezone(data.settings.timezone), [data.settings.timezone]);

  const save = useWrite((hours: PlatformDayHours[]) => platformApi.setHours(hours), () => onNotice('Daily operating hours saved.'));
  const tzWrite = useConfigWrite(() => onNotice(`Timezone set to ${timezone}.`));
  const dirty = JSON.stringify(sortWeek(draft)) !== signature;
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['Asia/Kolkata', 'UTC'];
  const patch = (day: number, changes: Partial<PlatformDayHours>) => setDraft((days) => days.map((d) => (d.dayOfWeek === day ? { ...d, ...changes } : d)));
  const fixed = data.settings.operatingMode === 'FIXED_TIMING';

  function submit() {
    setProblem(null);
    const p = hoursProblems(draft);
    if (p) return setProblem(p);
    save.mutate(sortWeek(draft));
  }

  return (
    <Panel
      title="Daily Operating Hours"
      action={
        <div className="flex gap-2">
          {dirty && saved.length > 0 && (
            <Button variant="ghost" disabled={save.isPending} onClick={() => setDraft(saved)}>
              Cancel
            </Button>
          )}
          <Button disabled={!canWrite || !dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save hours'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p className={`rounded-lg px-3 py-2 ${fixed ? 'bg-brand-50 text-brand-700' : 'bg-gray-50 text-gray-600'}`}>
          {fixed
            ? 'Fixed Timing is on: outside these hours the whole app is CLOSED, even with App Availability ON.'
            : saved.length > 0
              ? 'Always Open is on: these saved hours are kept but not applied. Choose Fixed Timing below to use them.'
              : 'No hours saved yet. Set them here, save, then choose Fixed Timing below to apply them.'}
        </p>
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
        <p className="text-xs text-gray-500">
          Opening time included, closing time excluded. The same time twice = open all day. A closing time before the opening time runs past
          midnight (6:00 PM – 2:00 AM). {changedText(data.settings.hoursChange) ?? ''}
        </p>
        <ErrorBanner message={problem ?? (save.isError ? errorText(save.error, 'Could not save the hours.') : null)} />

        <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
          <Field label="Timezone" hint="Hours, holidays and pause times are read in it (also “today” on the dashboard and reports). Server time decides, never the customer’s phone.">
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
/* 3. Operating Mode                                                          */
/* -------------------------------------------------------------------------- */

function OperatingMode({ data, canWrite, onNotice }: SectionProps) {
  const current = data.settings.operatingMode;
  const hasHours = data.settings.hours.length > 0;
  const [choice, setChoice] = useState<PlatformOperatingMode | null>(null);
  const save = useWrite((mode: PlatformOperatingMode) => platformApi.setMode(mode), (v) => {
    setChoice(null);
    onNotice(`Operating mode: ${MODE_LABEL[v.settings.operatingMode]}.`);
  });

  const options: { mode: PlatformOperatingMode; title: string; body: string; disabled: boolean }[] = [
    {
      mode: 'FIXED_TIMING',
      title: 'Fixed Timing',
      body: 'The Daily Operating Hours decide. Outside them the whole app is CLOSED; inside them it takes orders, if nothing else closes it.',
      disabled: !hasHours,
    },
    {
      mode: 'ALWAYS_OPEN',
      title: 'Always Open',
      body: 'No opening or closing time — orders 24/7, unless App Availability is OFF, a pause, a holiday or an emergency closes it. The saved hours are kept.',
      disabled: false,
    },
  ];

  return (
    <Panel title="Operating Mode">
      <div className="space-y-3 text-sm">
        <p>
          Current mode: <Pill tone={current === 'FIXED_TIMING' ? 'blue' : 'brand'}>{MODE_LABEL[current]}</Pill>
          {!data.settings.operatingModeChosen && <span className="ml-2 text-xs text-gray-500">(not chosen yet — follows whether hours are saved)</span>}
        </p>
        <div role="radiogroup" aria-label="Operating mode" className="grid gap-3 sm:grid-cols-2">
          {options.map((o) => {
            const selected = o.mode === current;
            return (
              <button
                key={o.mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canWrite || selected || o.disabled || save.isPending}
                onClick={() => setChoice(o.mode)}
                className={`rounded-xl border p-4 text-left transition ${selected ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100' : 'border-gray-200 bg-white hover:border-brand-200'} disabled:cursor-default`}
              >
                <p className="font-semibold text-gray-900">
                  {o.title} {selected && <span className="ml-1 text-xs font-medium text-brand-600">(selected)</span>}
                </p>
                <p className="mt-1 text-xs text-gray-600">{o.body}</p>
                {o.disabled && <p className="mt-1 text-xs text-warn-500">Save the Daily Operating Hours first.</p>}
              </button>
            );
          })}
        </div>
        <ErrorBanner message={save.isError ? errorText(save.error, 'Could not change the mode.') : null} />
      </div>
      {choice && (
        <Modal
          title={`Switch to ${MODE_LABEL[choice]}?`}
          subtitle={
            choice === 'ALWAYS_OPEN'
              ? 'The app stops closing at night. App Availability OFF, pauses, holidays and emergencies still close it.'
              : 'Outside the Daily Operating Hours the whole app will show CLOSED.'
          }
          onClose={() => setChoice(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setChoice(null)}>
                Cancel
              </Button>
              <Button disabled={save.isPending} onClick={() => save.mutate(choice)}>
                {save.isPending ? 'Saving…' : `Use ${MODE_LABEL[choice]}`}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">You can switch back at any time; the saved hours are never deleted by switching.</p>
        </Modal>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Temporary Pause and Scheduled Closure                                   */
/* -------------------------------------------------------------------------- */

const PAUSE_STATUS_TONE: Record<PlatformPauseDto['status'], 'brand' | 'amber' | 'gray' | 'red'> = {
  UPCOMING: 'amber',
  ACTIVE: 'red',
  EXPIRED: 'gray',
  ENDED: 'gray',
  CANCELLED: 'gray',
};

const DURATIONS: { value: string; label: string; minutes: number | null }[] = [
  { value: 'until-resumed', label: 'Until I resume it', minutes: null },
  { value: '30', label: 'For 30 minutes', minutes: 30 },
  { value: '60', label: 'For 1 hour', minutes: 60 },
  { value: '120', label: 'For 2 hours', minutes: 120 },
  { value: '240', label: 'For 4 hours', minutes: 240 },
  { value: 'until-time', label: 'Until a specific time…', minutes: null },
];

function Pauses({ data, canWrite, onNotice }: SectionProps) {
  const tz = data.settings.timezone;
  const pauses = data.pauses.filter((p) => p.kind !== 'EMERGENCY');
  const activeNow = pauses.find((p) => p.kind === 'IMMEDIATE' && p.status === 'ACTIVE');
  const [nowMessage, setNowMessage] = useState('');
  const [duration, setDuration] = useState('until-resumed');
  const [resumeAt, setResumeAt] = useState('');
  const [confirmNow, setConfirmNow] = useState(false);
  const [schedule, setSchedule] = useState({ message: '', startsAt: '', endsAt: '' });
  const [editing, setEditing] = useState<PlatformPauseDto | null>(null);

  const chosen = DURATIONS.find((d) => d.value === duration)!;
  const until = chosen.minutes ? { durationMinutes: chosen.minutes } : duration === 'until-time' && resumeAt ? { resumeAtLocal: resumeAt } : null;
  const untilText = chosen.minutes ? chosen.label.toLowerCase() : until ? `until ${formatLocal(resumeAt)} (${tz})` : 'until someone resumes it';

  const pauseNow = useWrite((x: { message: string | null; until: typeof until }) => platformApi.pauseNow(x.message, x.until), () => {
    setConfirmNow(false);
    setNowMessage('');
    setResumeAt('');
    setDuration('until-resumed');
    onNotice('Ordering paused.');
  });
  const scheduled = useWrite((x: typeof schedule) => platformApi.schedulePause(x.message.trim() || null, x.startsAt, x.endsAt), () => {
    setSchedule({ message: '', startsAt: '', endsAt: '' });
    onNotice('Closure scheduled.');
  });
  const cancel = useWrite((id: string) => platformApi.cancelPause(id), () => onNotice('Scheduled closure cancelled.'));
  const end = useWrite((id: string) => platformApi.endPause(id), () => onNotice('Pause ended — ordering resumes unless something else still applies.'));
  const update = useWrite((x: { id: string; body: { message?: string | null; startsAtLocal?: string; endsAtLocal?: string | null } }) => platformApi.updatePause(x.id, x.body), () => {
    setEditing(null);
    onNotice('Pause updated.');
  });
  const error = [pauseNow, scheduled, cancel, end, update].find((m) => m.isError)?.error;

  return (
    <Panel title="Temporary Pause and Scheduled Closure">
      <div className="space-y-5 text-sm">
        <p className="text-xs text-gray-500">Times are in {tz}. A pause ends on time by itself; ending it never reopens what App Availability OFF, a holiday or the hours keep closed.</p>
        <ErrorBanner message={error ? errorText(error, 'Could not save the pause.') : null} />

        <div className="space-y-2 rounded-xl border border-gray-200 p-3">
          <p className="font-semibold text-gray-900">Pause now</p>
          {activeNow ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warn-50 px-3 py-2">
              <span>
                Paused since {formatLocal(activeNow.startsAtLocal)} — {activeNow.endsAtLocal ? `resumes ${formatLocal(activeNow.endsAtLocal)}` : 'until resumed'}
                {activeNow.message ? ` · “${activeNow.message}”` : ''}.
              </span>
              <Button disabled={!canWrite || end.isPending} onClick={() => end.mutate(activeNow.id)}>
                Resume now
              </Button>
            </div>
          ) : (
            <div className="grid gap-2 lg:grid-cols-[1fr_13rem_auto] lg:items-end">
              <Field label="Reason / message (optional)">
                <input value={nowMessage} maxLength={200} disabled={!canWrite} onChange={(e) => setNowMessage(e.target.value)} className={inputClass} placeholder="e.g. Restocking — back shortly" />
              </Field>
              <Field label="How long">
                <select value={duration} disabled={!canWrite} onChange={(e) => setDuration(e.target.value)} className={inputClass}>
                  {DURATIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Button disabled={!canWrite || (duration === 'until-time' && !resumeAt)} onClick={() => setConfirmNow(true)}>
                Pause now
              </Button>
              {duration === 'until-time' && (
                <div className="lg:col-start-2">
                  <Field label={`Resume at (${tz})`}>
                    <input type="datetime-local" value={resumeAt} disabled={!canWrite} onChange={(e) => setResumeAt(e.target.value)} className={inputClass} />
                  </Field>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-xl border border-gray-200 p-3">
          <p className="font-semibold text-gray-900">Schedule a closure</p>
          <form
            className="grid gap-2 lg:grid-cols-[13rem_13rem_1fr_auto] lg:items-end"
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
            <Field label="Reason / message (optional)">
              <input value={schedule.message} maxLength={200} disabled={!canWrite} onChange={(e) => setSchedule({ ...schedule, message: e.target.value })} className={inputClass} placeholder="e.g. Temporary maintenance" />
            </Field>
            <Button type="submit" disabled={!canWrite || scheduled.isPending || !schedule.startsAt || !schedule.endsAt}>
              {scheduled.isPending ? 'Saving…' : 'Schedule'}
            </Button>
          </form>
          <p className="text-xs text-gray-500">Example: today 4:00 PM to 6:00 PM — ordering stops at 4 PM and can resume at 6 PM. Scheduled closures cannot overlap; edit or cancel one before it starts.</p>
        </div>

        <PauseTable pauses={pauses} canWrite={canWrite} onCancel={(id) => cancel.mutate(id)} onEnd={(id) => end.mutate(id)} onEdit={setEditing} busy={cancel.isPending || end.isPending} />
      </div>

      {confirmNow && (
        <Modal
          title="Pause ordering now?"
          subtitle={`The whole app stops taking new orders ${untilText}, unless something else keeps it closed longer.`}
          onClose={() => setConfirmNow(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmNow(false)}>
                Cancel
              </Button>
              <Button disabled={pauseNow.isPending} onClick={() => pauseNow.mutate({ message: nowMessage.trim() || null, until })}>
                {pauseNow.isPending ? 'Pausing…' : 'Pause ordering'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">Customers keep browsing. Orders already placed are not affected.</p>
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
/* 5. Holidays and Emergency Closure                                          */
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
    onNotice('Holiday saved.');
  });
  const remove = useWrite((id: string) => platformApi.deleteHoliday(id), () => {
    setRemoving(null);
    onNotice('Holiday removed.');
  });
  const error = [start, endEmergency, saveHoliday, remove].find((m) => m.isError)?.error;

  return (
    <Panel title="Holidays and Emergency Closure">
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
          <p className="font-semibold text-gray-900">{editingId ? 'Edit holiday' : 'Add a holiday'}</p>
          <form
            className="grid gap-2 lg:grid-cols-[1fr_10rem_10rem] lg:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (saveHoliday.isPending) return;
              saveHoliday.mutate({ id: editingId, body: { ...form, name: form.name.trim(), message: form.message?.trim() || null, endDate: form.endDate || form.startDate } });
            }}
          >
            <Field label="Holiday name">
              <input required minLength={2} maxLength={80} value={form.name} disabled={!canWrite} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} placeholder="e.g. Diwali" />
            </Field>
            <Field label="First day">
              <input type="date" required value={form.startDate} disabled={!canWrite} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Last day (optional)">
              <input type="date" value={form.endDate} min={form.startDate || undefined} disabled={!canWrite} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className={inputClass} />
            </Field>
            <div className="lg:col-span-2">
              <Field label="Message customers see (optional)">
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
                {saveHoliday.isPending ? 'Saving…' : editingId ? 'Save' : 'Add holiday'}
              </Button>
            </div>
          </form>
          <p className="text-xs text-gray-500">Whole days in {data.settings.timezone}: closed from 00:00 on the first day until midnight after the last. Holidays cannot overlap.</p>
        </div>

        {data.holidays.length === 0 ? (
          <p className="text-gray-500">No holidays in the last 30 days or ahead.</p>
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
                            Delete
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
          subtitle="All new orders stop immediately, for every store, until you end it here."
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
          title={`Delete “${removing.name}”?`}
          subtitle={removing.status === 'ACTIVE' ? 'It is active now: ordering reopens at once unless something else keeps it closed.' : undefined}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRemoving(null)}>
                Keep it
              </Button>
              <Button disabled={remove.isPending} onClick={() => remove.mutate(removing.id)}>
                Delete holiday
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600">{removing.startDate === removing.endDate ? removing.startDate : `${removing.startDate} → ${removing.endDate}`}</p>
        </Modal>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 6. Aadione Main Store Location                                             */
/* -------------------------------------------------------------------------- */

function MainStoreLocation({ data, canWrite, onNotice }: SectionProps) {
  const saved = data.settings.location;
  const [name, setName] = useState(saved?.name ?? '');
  const [address, setAddress] = useState(saved?.addressLine ?? '');
  const [landmark, setLandmark] = useState(saved?.landmark ?? '');
  const [lat, setLat] = useState(saved ? String(saved.latitude) : '');
  const [lng, setLng] = useState(saved ? String(saved.longitude) : '');
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'fetch' | 'gps' | null>(null);
  const savedSignature = JSON.stringify(saved);
  useEffect(() => {
    setName(saved?.name ?? '');
    setAddress(saved?.addressLine ?? '');
    setLandmark(saved?.landmark ?? '');
    setLat(saved ? String(saved.latitude) : '');
    setLng(saved ? String(saved.longitude) : '');
    // Re-seed only when the SAVED location changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSignature]);

  const save = useWrite((location: Parameters<typeof platformApi.setLocation>[0]) => platformApi.setLocation(location), (v) => {
    setInfo(null);
    onNotice(v.settings.location ? 'Main store location saved.' : 'Main store location cleared.');
  });

  const latitude = Number(lat);
  const longitude = Number(lng);
  const pointProblem = lat.trim() && lng.trim() ? coordinateProblem(latitude, longitude, { requireIndia: true }) : 'MISSING';
  const dirty =
    name.trim() !== (saved?.name ?? '') ||
    address.trim() !== (saved?.addressLine ?? '') ||
    landmark.trim() !== (saved?.landmark ?? '') ||
    lat.trim() !== (saved ? String(saved.latitude) : '') ||
    lng.trim() !== (saved ? String(saved.longitude) : '');

  /** Reverse-geocodes a point into the name and address fields (editable before saving). */
  async function fetchFor(pointLat: number, pointLng: number): Promise<void> {
    if (!REVERSE_GEOCODE_URL) {
      setProblem('Address lookup is turned off (VITE_REVERSE_GEOCODE_URL=off). Enter the name and address yourself.');
      return;
    }
    const found = await suggestAddress(pointLat, pointLng);
    const readable = found.displayName ?? [found.addressLine, found.locality, found.city, found.district, found.state, found.pincode].filter(Boolean).join(', ');
    if (!readable) throw new Error('No readable address was found for this point.');
    if (found.placeName) setName(found.placeName);
    setAddress(readable);
    setInfo(`Found: ${readable}. Check and edit the name and address, then Save Location.`);
  }

  async function fetchLocation() {
    setProblem(null);
    setInfo(null);
    if (pointProblem) {
      setProblem(pointProblem === 'MISSING' ? 'Enter both latitude and longitude, then Fetch Location.' : COORDINATE_PROBLEM_MESSAGE[pointProblem]);
      return;
    }
    setBusy('fetch');
    try {
      await fetchFor(latitude, longitude);
    } catch (err) {
      setProblem(`${err instanceof Error ? err.message : 'The address lookup failed.'} You can enter the name and address yourself.`);
    } finally {
      setBusy(null);
    }
  }

  async function useLiveLocation() {
    setProblem(null);
    setInfo(null);
    setBusy('gps');
    try {
      // Only on this click: the browser asks for permission.
      const result = await detectBrowserLocation();
      if (result.status !== 'OK') {
        setProblem(`${DETECT_MESSAGE[result.status]} Enter the latitude and longitude yourself, or drag the pin.`);
        return;
      }
      const pLat = Number(result.latitude.toFixed(6));
      const pLng = Number(result.longitude.toFixed(6));
      setLat(String(pLat));
      setLng(String(pLng));
      const accuracy = `Live location ${describeAccuracy(result.accuracyM)}.`;
      try {
        await fetchFor(pLat, pLng);
        setInfo((current) => `${accuracy} ${current ?? ''}`);
      } catch {
        setInfo(`${accuracy} No readable address was found — enter the name and address yourself, then Save Location.`);
      }
    } finally {
      setBusy(null);
    }
  }

  function submit() {
    setProblem(null);
    if (name.trim().length < 2) return setProblem('Enter the location name.');
    if (address.trim().length < 2) return setProblem('Enter the full address.');
    if (pointProblem) return setProblem(pointProblem === 'MISSING' ? 'Set the map point: Use Live Location, drag the pin, or enter latitude and longitude.' : COORDINATE_PROBLEM_MESSAGE[pointProblem]);
    save.mutate({ name: name.trim(), addressLine: address.trim(), landmark: landmark.trim() || null, latitude, longitude });
  }

  return (
    <Panel title="Aadione Main Store Location">
      <div className="space-y-3 text-sm">
        {saved ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
            <p className="text-base font-semibold text-gray-900">{saved.name || 'Aadione main store'}</p>
            <p className="text-gray-700">{saved.addressLine}</p>
            {saved.landmark && <p className="text-xs text-gray-500">Landmark: {saved.landmark}</p>}
            <p className="mt-1 text-xs text-gray-500">
              {saved.latitude.toFixed(6)}, {saved.longitude.toFixed(6)}
            </p>
          </div>
        ) : (
          <p className="text-gray-500">Not set yet.</p>
        )}
        <p className="text-xs text-gray-500">
          Aadione’s own business location — not a seller’s. Informational: whether a customer is served is still measured from each seller’s own
          location and radius (Sellers → a seller → Delivery area).
        </p>

        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Location name" required>
            <input value={name} maxLength={120} disabled={!canWrite} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="e.g. Aadione Main Store" />
          </Field>
          <Field label="Landmark">
            <input value={landmark} maxLength={160} disabled={!canWrite} onChange={(e) => setLandmark(e.target.value)} className={inputClass} placeholder="e.g. Near the bus stand" />
          </Field>
        </div>
        <Field label="Full address" required>
          <input value={address} maxLength={300} disabled={!canWrite} onChange={(e) => setAddress(e.target.value)} className={inputClass} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Latitude" required>
            <input value={lat} inputMode="decimal" disabled={!canWrite} onChange={(e) => setLat(e.target.value)} className={inputClass} placeholder="e.g. 25.029000" />
          </Field>
          <Field label="Longitude" required>
            <input value={lng} inputMode="decimal" disabled={!canWrite} onChange={(e) => setLng(e.target.value)} className={inputClass} placeholder="e.g. 74.109600" />
          </Field>
          <Button variant="secondary" disabled={!canWrite || busy !== null} onClick={() => void fetchLocation()}>
            {busy === 'fetch' ? 'Fetching…' : 'Fetch Location'}
          </Button>
        </div>
        {lat.trim() && lng.trim() && pointProblem && pointProblem !== 'MISSING' && <p className="text-xs text-danger-600">{COORDINATE_PROBLEM_MESSAGE[pointProblem]}</p>}

        <LocationMap
          pin={pointProblem ? null : { latitude, longitude }}
          onPinChange={
            canWrite
              ? (p) => {
                  setLat(String(p.latitude));
                  setLng(String(p.longitude));
                  setInfo('Pin moved. Press Fetch Location to look up its name and address.');
                }
              : undefined
          }
          label="Aadione main store — click or drag the pin"
        />

        {info && (
          <p role="status" className="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">
            {info}
          </p>
        )}
        <ErrorBanner message={problem ?? (save.isError ? errorText(save.error, 'Could not save the location.') : null)} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="secondary" disabled={!canWrite || busy !== null} onClick={() => void useLiveLocation()}>
            {busy === 'gps' ? 'Reading live location…' : 'Use Live Location'}
          </Button>
          <div className="flex flex-wrap gap-2">
            {saved && (
              <Button variant="ghost" disabled={!canWrite || save.isPending} onClick={() => save.mutate(null)}>
                Clear location
              </Button>
            )}
            <Button disabled={!canWrite || save.isPending || !dirty} onClick={submit}>
              {save.isPending ? 'Saving…' : 'Save Location'}
            </Button>
          </div>
        </div>
        <p className="text-xs text-gray-500">Use Live Location only when this device is at the store; the browser asks for permission. Nothing is saved until you press Save Location.</p>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 7. Global Default Delivery Radius                                          */
/* -------------------------------------------------------------------------- */

function DefaultRadius({ data, canWrite, onNotice }: SectionProps) {
  const current = data.settings.defaultServiceRadiusKm;
  const [radius, setRadius] = useState(String(current));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setRadius(String(current)), [current]);
  const write = useConfigWrite(() => onNotice('Default delivery radius saved.'));

  function submit() {
    setProblem(null);
    const value = Number(radius);
    if (!radius.trim() || !Number.isFinite(value) || value <= 0 || value > 50) return setProblem('Enter a radius above 0 and at most 50 km.');
    write.mutate({ key: ConfigKey.MAX_SERVICE_RADIUS_KM, value });
  }

  return (
    <Panel title="Global Default Delivery Radius">
      <div className="space-y-3 text-sm">
        <p>
          Current default: <span className="font-semibold text-gray-900">{current} km</span>
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Default radius (km)">
            <div className="w-32">
              <input type="number" min={0.1} max={50} step={0.1} value={radius} disabled={!canWrite} onChange={(e) => setRadius(e.target.value)} className={inputClass} />
            </div>
          </Field>
          <Button disabled={!canWrite || write.isPending || Number(radius) === current} onClick={submit}>
            {write.isPending ? 'Saving…' : 'Save radius'}
          </Button>
        </div>
        <p className="text-xs text-gray-500">
          The default for every seller without its own radius — straight-line distance from each seller’s own location (not the road route, and not
          from the main store location). A seller’s own radius (Sellers → a seller → Delivery area) always overrides it.
        </p>
        <ErrorBanner message={problem ?? (write.isError ? errorText(write.error, 'Could not save the radius.') : null)} />
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 8. Effective App Status and Customer Message Preview                       */
/* -------------------------------------------------------------------------- */

function EffectiveStatus({ data }: { data: View }) {
  const a = data.availability;
  const s = data.settings;
  const status = STATUS_LABEL[a.status];
  const activePause = data.pauses.find((p) => p.status === 'ACTIVE');
  const activeHoliday = data.holidays.find((h) => h.status === 'ACTIVE');
  return (
    <Panel title="Effective App Status and Customer Message Preview">
      <div className="grid gap-5 lg:grid-cols-2">
        <dl className="text-sm">
          <Row label="App status (computed by the server)">
            <Pill tone={status.tone}>{a.acceptingOrders ? 'OPEN' : 'CLOSED'}</Pill>
          </Row>
          <Row label="App Availability switch">
            <Pill tone={s.orderingEnabled ? 'brand' : 'red'}>{s.orderingEnabled ? 'ON' : 'OFF'}</Pill>
          </Row>
          <Row label="Operating mode">{MODE_LABEL[s.operatingMode]}</Row>
          <Row label="Local time">
            {formatInZone(a.currentTime, a.timezone)} <span className="text-xs text-gray-500">({a.timezone})</span>
          </Row>
          <Row label="Today’s hours">{s.operatingMode === 'ALWAYS_OPEN' ? 'Always Open — no hour restriction' : describeHours(a.todayOpeningHours)}</Row>
          <Row label="Active pause / closure">
            {activePause
              ? `${activePause.kind === 'EMERGENCY' ? 'Emergency closure' : 'Pause'} since ${formatLocal(activePause.startsAtLocal)}${activePause.endsAtLocal ? `, until ${formatLocal(activePause.endsAtLocal)}` : ''}`
              : activeHoliday
                ? `${activeHoliday.name} (${activeHoliday.startDate === activeHoliday.endDate ? activeHoliday.startDate : `${activeHoliday.startDate} → ${activeHoliday.endDate}`})`
                : 'None'}
          </Row>
          <Row label="Reason closed">{a.reasonCode ? `${REASON_LABEL[a.reasonCode] ?? a.reasonCode} (${a.reasonCode})` : '—'}</Row>
          <Row label="Next opening">
            {a.acceptingOrders ? '—' : a.nextOpeningText ? `${a.nextOpeningText} (${formatInZone(a.nextOpeningAt, a.timezone)})` : 'Not scheduled — reopens only when an admin acts'}
          </Row>
          <Row label="Main store location">{s.location ? `${s.location.name ?? 'Main store'} — ${s.location.addressLine}` : 'Not set'}</Row>
          <Row label="Default delivery radius">{s.defaultServiceRadiusKm} km</Row>
        </dl>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-gray-900">What customers see in the app</p>
          <div className={`rounded-xl px-4 py-3 text-sm ${a.acceptingOrders ? 'bg-brand-50 text-brand-700' : 'bg-warn-50 text-gray-800'}`}>
            {a.acceptingOrders ? 'No closure notice — the app is taking orders (each store’s own hours and status still apply).' : a.message}
          </div>
          <p className="text-xs text-gray-500">
            While CLOSED, every store shows ordering unavailable, customers keep browsing, and the server refuses every new order and payment start.
          </p>
        </div>
      </div>
    </Panel>
  );
}
