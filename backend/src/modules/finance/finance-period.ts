/**
 * The Financial Overview's date filters, resolved in the marketplace's
 * reporting timezone (STORE_TIMEZONE, "Asia/Kolkata" by default — the same
 * one the admin Dashboard uses for "today"). Pure; unit-tested in
 * tests/unit/finance-period.test.ts.
 *
 * A period is a whole number of local calendar days: [start of `fromDate`,
 * start of the day after `toDate`) as UTC instants. LIFETIME has no bounds.
 * Weeks start on Monday.
 */

import { getZonedParts, startOfZonedDay } from '../../shared/datetime';

export const FINANCE_PERIODS = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'THIS_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_YEAR',
  'LIFETIME',
  'CUSTOM',
] as const;
export type FinancePeriod = (typeof FINANCE_PERIODS)[number];

/** A custom range may cover at most this many days (about ten years). */
export const MAX_CUSTOM_RANGE_DAYS = 3660;

export interface ResolvedPeriod {
  preset: FinancePeriod;
  /** First local day included ("YYYY-MM-DD"); null for LIFETIME. */
  fromDate: string | null;
  /** Last local day included ("YYYY-MM-DD"); null for LIFETIME. */
  toDate: string | null;
  /** Inclusive start instant; null for LIFETIME. */
  from: Date | null;
  /** EXCLUSIVE end instant (start of the day after toDate); null for LIFETIME. */
  to: Date | null;
  label: string;
}

export class PeriodError extends Error {}

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" → days since the epoch, or null if it is not a real date. */
function dayNumber(value: string): number | null {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return ms / DAY_MS;
}

const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The local calendar date of an instant. */
export function localDate(instant: Date, timeZone: string): string {
  const p = getZonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Start of a local calendar day as a UTC instant. */
export function startOfLocalDay(day: string, timeZone: string): Date {
  // Midday UTC is the same calendar day in every zone within ±12 h.
  return startOfZonedDay(new Date(`${day}T12:00:00.000Z`), timeZone);
}

export function addDays(day: string, days: number): string {
  const n = dayNumber(day);
  if (n === null) throw new PeriodError(`invalid date ${day}`);
  return fromDayNumber(n + days);
}

/** Monday of the week containing `day`. */
export function weekStart(day: string): string {
  const n = dayNumber(day);
  if (n === null) throw new PeriodError(`invalid date ${day}`);
  const weekday = new Date(n * DAY_MS).getUTCDay(); // 0 = Sunday
  return fromDayNumber(n - ((weekday + 6) % 7));
}

export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

const LABELS: Record<FinancePeriod, string> = {
  TODAY: 'Today',
  YESTERDAY: 'Yesterday',
  LAST_7_DAYS: 'Last 7 days',
  THIS_WEEK: 'This week',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  THIS_YEAR: 'This year',
  LIFETIME: 'Lifetime (all time)',
  CUSTOM: 'Custom range',
};

export function resolvePeriod(
  preset: FinancePeriod,
  custom: { from?: string; to?: string },
  now: Date,
  timeZone: string,
): ResolvedPeriod {
  const today = localDate(now, timeZone);
  let range: [string, string] | null;
  switch (preset) {
    case 'TODAY':
      range = [today, today];
      break;
    case 'YESTERDAY':
      range = [addDays(today, -1), addDays(today, -1)];
      break;
    case 'LAST_7_DAYS':
      range = [addDays(today, -6), today];
      break;
    case 'THIS_WEEK':
      range = [weekStart(today), today];
      break;
    case 'THIS_MONTH':
      range = [monthStart(today), today];
      break;
    case 'LAST_MONTH': {
      const first = monthStart(addDays(monthStart(today), -1));
      range = [first, addDays(monthStart(today), -1)];
      break;
    }
    case 'THIS_YEAR':
      range = [`${today.slice(0, 4)}-01-01`, today];
      break;
    case 'LIFETIME':
      range = null;
      break;
    case 'CUSTOM': {
      if (!custom.from || !custom.to) throw new PeriodError('Choose both a start and an end date.');
      const a = dayNumber(custom.from);
      const b = dayNumber(custom.to);
      if (a === null || b === null) throw new PeriodError('Dates must be real calendar dates (YYYY-MM-DD).');
      if (a > b) throw new PeriodError('The start date must be on or before the end date.');
      if (b - a + 1 > MAX_CUSTOM_RANGE_DAYS) throw new PeriodError(`A custom range can cover at most ${MAX_CUSTOM_RANGE_DAYS} days.`);
      range = [custom.from, custom.to];
      break;
    }
  }
  if (!range) return { preset, fromDate: null, toDate: null, from: null, to: null, label: LABELS[preset] };
  const [fromDate, toDate] = range;
  return {
    preset,
    fromDate,
    toDate,
    from: startOfLocalDay(fromDate, timeZone),
    to: startOfLocalDay(addDays(toDate, 1), timeZone),
    label: LABELS[preset],
  };
}
