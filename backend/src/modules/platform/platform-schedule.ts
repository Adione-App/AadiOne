/**
 * App-wide availability — THE rule, as a pure function of its inputs and an
 * instant (no database, no clock of its own), so every boundary is tested
 * exactly (tests/unit/platform-schedule.test.ts). platform-availability.ts
 * loads the inputs and calls it with the server's time.
 *
 * Precedence (the first that applies decides; a lower one never reopens what a
 * higher one closed):
 *
 *   1. master switch OFF (ORDERING_ENABLED)           GLOBAL_DISABLED
 *      an active emergency closure                    EMERGENCY_CLOSURE
 *      an active "pause now" with no end              MANUAL_PAUSE
 *   2. an active pause with an end                    MANUAL_PAUSE / SCHEDULED_PAUSE
 *   3. a holiday covering today's LOCAL date           HOLIDAY_CLOSURE
 *   4. the weekly schedule (when one is configured)   OUTSIDE_OPERATING_HOURS
 *
 * Sellers' own availability and delivery areas come after all of these and
 * are unchanged (store-availability.ts, seller.service.ts).
 *
 * Time: every wall-clock rule is read in `timezone` (STORE_TIMEZONE), never
 * the server's or the customer's. Pauses are instants. Holidays are local
 * calendar dates. Hours: opening inclusive, closing exclusive; the same time
 * twice = open the whole day; closing before opening = the window runs past
 * midnight and belongs to the day it OPENED (Fri 18:00–02:00 covers Saturday
 * 01:00).
 *
 * The next opening is found by stepping from one restriction's end to the
 * next until nothing applies — so a pause that ends at night correctly
 * reopens at the next morning's opening — and is left out whenever any step
 * has no known end (master switch OFF, an open-ended pause or emergency, a
 * schedule with every day closed).
 */

import {
  formatTime12h,
  getTimeZoneOffsetMinutes,
  getZonedParts,
  parseTimeToMinutes,
  type ZonedParts,
} from '../../shared/datetime';
import type { PlatformClosedReason, PlatformDayHours } from '../../shared';

export interface ScheduledPause {
  id: string;
  kind: 'IMMEDIATE' | 'SCHEDULED' | 'EMERGENCY';
  message: string | null;
  startsAt: Date;
  /** Null = until an admin ends it. */
  endsAt: Date | null;
}

export interface Holiday {
  id: string;
  name: string;
  message: string | null;
  /** Local calendar dates, YYYY-MM-DD, both inclusive. */
  startDate: string;
  endDate: string;
}

/** Only pauses that are not cancelled and not ended early — the caller filters. */
export interface PlatformInputs {
  orderingEnabled: boolean;
  /** ORDERING_PAUSED_MESSAGE ('' = the standard sentence). */
  pausedMessage: string;
  timezone: string;
  /** 7 days, or empty = no schedule. */
  hours: readonly PlatformDayHours[];
  pauses: readonly ScheduledPause[];
  holidays: readonly Holiday[];
}

export interface Restriction {
  reason: PlatformClosedReason;
  /** Customer-facing, without the reopening sentence. */
  message: string;
  /** When this restriction stops applying; null = not known (needs an admin). */
  until: Date | null;
  id: string | null;
  name: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

export const DEFAULT_MESSAGES: Record<PlatformClosedReason, string> = {
  GLOBAL_DISABLED: 'Ordering is paused right now. You can keep browsing and adding items to your cart.',
  EMERGENCY_CLOSURE: 'Aadione has stopped taking orders for now. You can keep browsing and adding items to your cart.',
  MANUAL_PAUSE: 'Ordering is paused for a short while. You can keep browsing and adding items to your cart.',
  SCHEDULED_PAUSE: 'Ordering is paused for scheduled maintenance. You can keep browsing and adding items to your cart.',
  HOLIDAY_CLOSURE: 'Aadione is closed today. You can keep browsing and adding items to your cart.',
  OUTSIDE_OPERATING_HOURS: 'Aadione is closed right now. You can keep browsing and adding items to your cart.',
};

const DAY_MS = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Local date / time <-> instant                                              */
/* -------------------------------------------------------------------------- */

/** YYYY-MM-DD of a local date. */
export function localDateString(parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** The local date `days` after a YYYY-MM-DD date (calendar arithmetic, no zone). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/**
 * The instant at which the clock in `timeZone` shows `date` + `minutes`
 * (minutes may be 1440 = the next midnight). A wall time skipped by a DST jump
 * resolves just after it; India has no DST.
 */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + minutes * 60_000;
  let guess = wall - getTimeZoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  // Once more with the offset AT the guess (differs only across a DST change).
  guess = wall - getTimeZoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess);
}

/** "2026-10-29T16:00:00+05:30" — ISO 8601 with the zone's own offset. */
export function isoInZone(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  const offset = getTimeZoneOffsetMinutes(date, timeZone);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${localDateString(p)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "YYYY-MM-DDTHH:mm" in the zone — what an admin's date-time field shows. */
export function localDateTimeString(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${localDateString(p)}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Parses "YYYY-MM-DDTHH:mm" as a wall time in the zone; null when malformed or not a real date. */
export function parseLocalDateTime(value: string, timeZone: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match || !isRealDate(match[1]!)) return null;
  return zonedInstant(match[1]!, Number(match[2]) * 60 + Number(match[3]), timeZone);
}

/** A YYYY-MM-DD that exists on the calendar (not 2026-02-30). */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/* -------------------------------------------------------------------------- */
/* Weekly hours                                                               */
/* -------------------------------------------------------------------------- */

interface Window {
  start: Date;
  end: Date;
}

/** The window a day's row opens on `date`, as instants; null when closed that day. */
function windowOn(date: string, hours: readonly PlatformDayHours[], timeZone: string): Window | null {
  const row = hours.find((h) => h.dayOfWeek === weekdayOf(date));
  if (!row || row.isClosed) return null;
  const opens = parseTimeToMinutes(row.opensAt);
  const closes = parseTimeToMinutes(row.closesAt);
  if (opens === closes) return { start: zonedInstant(date, 0, timeZone), end: zonedInstant(date, 1440, timeZone) };
  return {
    start: zonedInstant(date, opens, timeZone),
    // Before the opening time = past midnight, on the next day.
    end: zonedInstant(date, closes > opens ? closes : 1440 + closes, timeZone),
  };
}

/** The window containing `t` (yesterday's overnight one, or today's), or null. */
function windowContaining(t: Date, hours: readonly PlatformDayHours[], timeZone: string): Window | null {
  const today = localDateString(getZonedParts(t, timeZone));
  for (const date of [addDays(today, -1), today]) {
    const w = windowOn(date, hours, timeZone);
    if (w && t >= w.start && t < w.end) return w;
  }
  return null;
}

/** The first window starting after `t` within the next 8 days, or null (every day closed). */
function nextWindowStart(t: Date, hours: readonly PlatformDayHours[], timeZone: string): Date | null {
  const today = localDateString(getZonedParts(t, timeZone));
  for (let k = 0; k <= 8; k += 1) {
    const w = windowOn(addDays(today, k), hours, timeZone);
    if (w && w.start > t) return w.start;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                   */
/* -------------------------------------------------------------------------- */

const isActive = (p: ScheduledPause, t: Date) => p.startsAt <= t && (p.endsAt === null || p.endsAt > t);

/** The highest-precedence restriction in force at `t`, or null (the app is open). */
export function restrictionAt(inputs: PlatformInputs, t: Date): Restriction | null {
  if (!inputs.orderingEnabled) {
    return {
      reason: 'GLOBAL_DISABLED',
      message: inputs.pausedMessage.trim() || DEFAULT_MESSAGES.GLOBAL_DISABLED,
      until: null,
      id: null,
      name: null,
      startsAt: null,
      endsAt: null,
    };
  }

  const active = inputs.pauses.filter((p) => isActive(p, t));
  const fromPause = (p: ScheduledPause, reason: PlatformClosedReason): Restriction => ({
    reason,
    message: p.message?.trim() || DEFAULT_MESSAGES[reason],
    until: p.endsAt,
    id: p.id,
    name: null,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
  });
  const emergency = active.find((p) => p.kind === 'EMERGENCY');
  if (emergency) return fromPause(emergency, 'EMERGENCY_CLOSURE');
  const openEnded = active.find((p) => p.kind === 'IMMEDIATE' && p.endsAt === null);
  if (openEnded) return fromPause(openEnded, 'MANUAL_PAUSE');
  // Timed pauses: the one ending last (none of them may end before it).
  const timed = [...active].sort((a, b) => b.endsAt!.getTime() - a.endsAt!.getTime())[0];
  if (timed) return fromPause(timed, timed.kind === 'SCHEDULED' ? 'SCHEDULED_PAUSE' : 'MANUAL_PAUSE');

  const today = localDateString(getZonedParts(t, inputs.timezone));
  const holiday = inputs.holidays.find((h) => h.startDate <= today && today <= h.endDate);
  if (holiday) {
    return {
      reason: 'HOLIDAY_CLOSURE',
      message: holiday.message?.trim() || `Aadione is closed for ${holiday.name}. You can keep browsing and adding items to your cart.`,
      until: zonedInstant(addDays(holiday.endDate, 1), 0, inputs.timezone),
      id: holiday.id,
      name: holiday.name,
      startsAt: zonedInstant(holiday.startDate, 0, inputs.timezone),
      endsAt: zonedInstant(addDays(holiday.endDate, 1), 0, inputs.timezone),
    };
  }

  if (inputs.hours.length > 0 && !windowContaining(t, inputs.hours, inputs.timezone)) {
    return {
      reason: 'OUTSIDE_OPERATING_HOURS',
      message: DEFAULT_MESSAGES.OUTSIDE_OPERATING_HOURS,
      until: nextWindowStart(t, inputs.hours, inputs.timezone),
      id: null,
      name: null,
      startsAt: null,
      endsAt: null,
    };
  }
  return null;
}

/** When ordering next opens after `now` (null: open now, or not determinable). */
export function nextOpening(inputs: PlatformInputs, now: Date): Date | null {
  let t = now;
  let restriction = restrictionAt(inputs, t);
  if (!restriction) return null;
  // Each step jumps to a restriction's end; a year of steps is far more than any real calendar needs.
  for (let step = 0; step < 400 && restriction; step += 1) {
    if (!restriction.until || restriction.until <= t) return null;
    t = restriction.until;
    restriction = restrictionAt(inputs, t);
  }
  return restriction ? null : t;
}

/**
 * While open: the next instant something could close it — the current
 * window's end, the next pause start, the next holiday's local midnight.
 * Apps ask again then instead of polling. Null when nothing is scheduled.
 */
export function nextClosing(inputs: PlatformInputs, now: Date): Date | null {
  const candidates: Date[] = [];
  if (inputs.hours.length > 0) {
    const w = windowContaining(now, inputs.hours, inputs.timezone);
    if (w) candidates.push(w.end);
  }
  for (const p of inputs.pauses) if (p.startsAt > now) candidates.push(p.startsAt);
  const today = localDateString(getZonedParts(now, inputs.timezone));
  for (const h of inputs.holidays) if (h.startDate > today) candidates.push(zonedInstant(h.startDate, 0, inputs.timezone));
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

/** "Opens today at 8:00 AM" / "Opens tomorrow at …" / "Opens Mon, 3 Nov at …", in the zone. */
export function describeOpening(at: Date, now: Date, timeZone: string): string {
  const p = getZonedParts(at, timeZone);
  const time = formatTime12h(`${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`);
  const day = localDateString(p);
  const today = localDateString(getZonedParts(now, timeZone));
  if (day === today) return `Opens today at ${time}`;
  if (day === addDays(today, 1)) return `Opens tomorrow at ${time}`;
  const label = new Intl.DateTimeFormat('en-IN', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(at);
  return `Opens ${label} at ${time}`;
}

/** Today's row in the zone (null when no schedule is configured). */
export function todayHours(inputs: PlatformInputs, now: Date): { isClosed: boolean; opensAt: string; closesAt: string } | null {
  if (inputs.hours.length === 0) return null;
  const row = inputs.hours.find((h) => h.dayOfWeek === getZonedParts(now, inputs.timezone).weekday);
  return row ? { isClosed: row.isClosed, opensAt: row.opensAt, closesAt: row.closesAt } : { isClosed: true, opensAt: '00:00', closesAt: '00:00' };
}

/* -------------------------------------------------------------------------- */
/* Validation (admin input)                                                   */
/* -------------------------------------------------------------------------- */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Problems with a weekly schedule, in words; empty = valid. Empty schedule = "no hours" (valid). */
export function weeklyHoursProblems(hours: unknown): string[] {
  if (!Array.isArray(hours)) return ['The weekly hours must be a list of days.'];
  if (hours.length === 0) return [];
  if (hours.length !== 7) return ['Give all seven days (Monday to Sunday), each open or closed.'];
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const row of hours as Partial<PlatformDayHours>[]) {
    const day = row?.dayOfWeek;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
      problems.push('Each day needs a dayOfWeek from 0 (Sunday) to 6 (Saturday).');
      continue;
    }
    if (seen.has(day)) problems.push('Each day can be given only once.');
    seen.add(day);
    if (typeof row.isClosed !== 'boolean') problems.push('Each day must be marked open or closed.');
    if (typeof row.opensAt !== 'string' || !TIME.test(row.opensAt) || typeof row.closesAt !== 'string' || !TIME.test(row.closesAt)) {
      problems.push('Opening and closing times must be 24-hour HH:mm.');
    }
  }
  return [...new Set(problems)];
}
