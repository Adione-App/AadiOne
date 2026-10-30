/**
 * App-wide availability rule (platform-schedule.ts) — pure, exact instants.
 * The week used: Monday 2 Nov 2026 … Sunday 8 Nov 2026, Asia/Kolkata unless
 * a test says otherwise.
 */

import { describe, expect, it } from 'vitest';
import type { PlatformDayHours } from '../../src/shared';
import {
  describeOpening,
  isoInZone,
  nextClosing,
  nextOpening,
  parseLocalDateTime,
  restrictionAt,
  todayHours,
  weeklyHoursProblems,
  zonedInstant,
  type PlatformInputs,
  type ScheduledPause,
} from '../../src/modules/platform/platform-schedule';

const TZ = 'Asia/Kolkata';
/** "2026-11-02 08:00" (local, Asia/Kolkata unless given) → instant. */
const at = (local: string, tz = TZ) => {
  const [date, time] = local.split(' ') as [string, string];
  const [h, m] = time.split(':').map(Number) as [number, number];
  return zonedInstant(date, h * 60 + m, tz);
};
const everyDay = (opensAt: string, closesAt: string): PlatformDayHours[] =>
  Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isClosed: false, opensAt, closesAt }));
const inputs = (over: Partial<PlatformInputs> = {}): PlatformInputs => ({
  orderingEnabled: true,
  pausedMessage: '',
  timezone: TZ,
  hours: [],
  pauses: [],
  holidays: [],
  ...over,
});
const pause = (kind: ScheduledPause['kind'], from: string, to: string | null, message: string | null = null): ScheduledPause => ({
  id: `${kind}-${from}`,
  kind,
  message,
  startsAt: at(from),
  endsAt: to ? at(to) : null,
});

describe('nothing configured', () => {
  it('is open, with nothing scheduled to change — exactly how the app behaved before', () => {
    const i = inputs();
    expect(restrictionAt(i, at('2026-11-02 03:00'))).toBeNull();
    expect(nextOpening(i, at('2026-11-02 03:00'))).toBeNull();
    expect(nextClosing(i, at('2026-11-02 03:00'))).toBeNull();
    expect(todayHours(i, at('2026-11-02 03:00'))).toBeNull();
  });
});

describe('master switch', () => {
  it('OFF closes with its own message, and no reopening time can be known', () => {
    const i = inputs({ orderingEnabled: false, pausedMessage: 'Back soon.', hours: everyDay('08:00', '22:00') });
    const r = restrictionAt(i, at('2026-11-02 12:00'))!;
    expect(r).toMatchObject({ reason: 'GLOBAL_DISABLED', message: 'Back soon.', until: null });
    expect(nextOpening(i, at('2026-11-02 12:00'))).toBeNull();
  });
});

describe('weekly hours', () => {
  const i = inputs({ hours: everyDay('08:00', '22:00') });

  it('opening inclusive, closing exclusive', () => {
    expect(restrictionAt(i, at('2026-11-02 07:59'))).toMatchObject({ reason: 'OUTSIDE_OPERATING_HOURS' });
    expect(restrictionAt(i, at('2026-11-02 08:00'))).toBeNull();
    expect(restrictionAt(i, at('2026-11-02 21:59'))).toBeNull();
    expect(restrictionAt(i, at('2026-11-02 22:00'))).toMatchObject({ reason: 'OUTSIDE_OPERATING_HOURS' });
  });

  it('next opening: later today, or tomorrow morning; next closing while open', () => {
    expect(nextOpening(i, at('2026-11-02 06:00'))).toEqual(at('2026-11-02 08:00'));
    expect(nextOpening(i, at('2026-11-02 23:00'))).toEqual(at('2026-11-03 08:00'));
    expect(nextClosing(i, at('2026-11-02 12:00'))).toEqual(at('2026-11-02 22:00'));
    expect(describeOpening(at('2026-11-03 08:00'), at('2026-11-02 23:00'), TZ)).toBe('Opens tomorrow at 8:00 AM');
    expect(describeOpening(at('2026-11-02 08:00'), at('2026-11-02 06:00'), TZ)).toBe('Opens today at 8:00 AM');
    expect(describeOpening(at('2026-11-05 08:00'), at('2026-11-02 23:00'), TZ)).toMatch(/^Opens Thu, 5 Nov at 8:00 AM$/);
  });

  it('overnight: Friday 18:00–02:00 covers Saturday 01:59 and closes at 02:00', () => {
    const fri: PlatformDayHours[] = everyDay('00:00', '00:00').map((d) => (d.dayOfWeek === 5 ? { ...d, opensAt: '18:00', closesAt: '02:00' } : { ...d, isClosed: true }));
    const o = inputs({ hours: fri });
    expect(restrictionAt(o, at('2026-11-06 17:59'))).not.toBeNull();
    expect(restrictionAt(o, at('2026-11-06 18:00'))).toBeNull();
    expect(restrictionAt(o, at('2026-11-06 23:59'))).toBeNull();
    expect(restrictionAt(o, at('2026-11-07 01:59'))).toBeNull();
    expect(restrictionAt(o, at('2026-11-07 02:00'))).toMatchObject({ reason: 'OUTSIDE_OPERATING_HOURS' });
    expect(nextOpening(o, at('2026-11-07 03:00'))).toEqual(at('2026-11-13 18:00'));
    expect(nextClosing(o, at('2026-11-06 20:00'))).toEqual(at('2026-11-07 02:00'));
  });

  it('the same time twice = the whole day, midnight to midnight', () => {
    const mondayOnly = everyDay('00:00', '00:00').map((d) => (d.dayOfWeek === 1 ? d : { ...d, isClosed: true }));
    const m = inputs({ hours: mondayOnly });
    expect(restrictionAt(m, at('2026-11-01 23:59'))).not.toBeNull();
    expect(restrictionAt(m, at('2026-11-02 00:00'))).toBeNull();
    expect(restrictionAt(m, at('2026-11-02 23:59'))).toBeNull();
    expect(restrictionAt(m, at('2026-11-03 00:00'))).not.toBeNull();
  });

  it('a closed weekday reopens on the next open day; every day closed = no known opening', () => {
    const noSunday = everyDay('08:00', '22:00').map((d) => (d.dayOfWeek === 0 ? { ...d, isClosed: true } : d));
    expect(nextOpening(inputs({ hours: noSunday }), at('2026-11-08 12:00'))).toEqual(at('2026-11-09 08:00'));
    const allClosed = everyDay('08:00', '22:00').map((d) => ({ ...d, isClosed: true }));
    const c = inputs({ hours: allClosed });
    expect(restrictionAt(c, at('2026-11-02 12:00'))).toMatchObject({ reason: 'OUTSIDE_OPERATING_HOURS', until: null });
    expect(nextOpening(c, at('2026-11-02 12:00'))).toBeNull();
    expect(todayHours(c, at('2026-11-02 12:00'))).toEqual({ isClosed: true, opensAt: '08:00', closesAt: '22:00' });
  });

  it('is read in the configured timezone, not the server\'s', () => {
    const ny = inputs({ hours: everyDay('08:00', '22:00'), timezone: 'America/New_York' });
    // 12:00 in India = 01:30 / 02:30 in New York: closed there.
    expect(restrictionAt(i, at('2026-11-02 12:00'))).toBeNull();
    expect(restrictionAt(ny, at('2026-11-02 12:00'))).toMatchObject({ reason: 'OUTSIDE_OPERATING_HOURS' });
    expect(restrictionAt(ny, at('2026-11-02 12:00', 'America/New_York'))).toBeNull();
  });
});

describe('pauses', () => {
  it('a scheduled pause closes from its start to its end, and is the next closing before it starts', () => {
    const i = inputs({ pauses: [pause('SCHEDULED', '2026-11-02 16:00', '2026-11-02 18:00', 'Maintenance')] });
    expect(restrictionAt(i, at('2026-11-02 15:59'))).toBeNull();
    expect(nextClosing(i, at('2026-11-02 15:00'))).toEqual(at('2026-11-02 16:00'));
    expect(restrictionAt(i, at('2026-11-02 16:00'))).toMatchObject({ reason: 'SCHEDULED_PAUSE', message: 'Maintenance', until: at('2026-11-02 18:00') });
    expect(nextOpening(i, at('2026-11-02 17:00'))).toEqual(at('2026-11-02 18:00'));
    expect(restrictionAt(i, at('2026-11-02 18:00'))).toBeNull(); // expired: open again
  });

  it('a pause ending outside the hours reopens at the next opening, not at its end', () => {
    const i = inputs({ hours: everyDay('08:00', '22:00'), pauses: [pause('IMMEDIATE', '2026-11-02 21:00', '2026-11-02 23:00')] });
    expect(restrictionAt(i, at('2026-11-02 21:30'))).toMatchObject({ reason: 'MANUAL_PAUSE' });
    expect(nextOpening(i, at('2026-11-02 21:30'))).toEqual(at('2026-11-03 08:00'));
  });

  it('an open-ended pause or an emergency has no known reopening; emergency outranks every pause', () => {
    const open = inputs({ pauses: [pause('IMMEDIATE', '2026-11-02 10:00', null)] });
    expect(restrictionAt(open, at('2026-11-02 11:00'))).toMatchObject({ reason: 'MANUAL_PAUSE', until: null });
    expect(nextOpening(open, at('2026-11-02 11:00'))).toBeNull();
    const both = inputs({ pauses: [pause('SCHEDULED', '2026-11-02 10:00', '2026-11-02 12:00'), pause('EMERGENCY', '2026-11-02 10:30', null, 'Flooding')] });
    expect(restrictionAt(both, at('2026-11-02 11:00'))).toMatchObject({ reason: 'EMERGENCY_CLOSURE', message: 'Flooding' });
  });

  it('an expired pause never reopens what the master switch or a holiday closes', () => {
    const expired = [pause('SCHEDULED', '2026-11-02 08:00', '2026-11-02 09:00')];
    expect(restrictionAt(inputs({ orderingEnabled: false, pauses: expired }), at('2026-11-02 10:00'))).toMatchObject({ reason: 'GLOBAL_DISABLED' });
    const holiday = inputs({ pauses: expired, holidays: [{ id: 'h', name: 'Diwali', message: null, startDate: '2026-11-02', endDate: '2026-11-02' }] });
    expect(restrictionAt(holiday, at('2026-11-02 08:30'))).toMatchObject({ reason: 'SCHEDULED_PAUSE' });
    expect(restrictionAt(holiday, at('2026-11-02 10:00'))).toMatchObject({ reason: 'HOLIDAY_CLOSURE' });
  });
});

describe('holidays', () => {
  const diwali = { id: 'h1', name: 'Diwali', message: null, startDate: '2026-11-02', endDate: '2026-11-03' };

  it('cover whole LOCAL days, from 00:00 on the first to 24:00 on the last', () => {
    const i = inputs({ holidays: [diwali] });
    expect(restrictionAt(i, at('2026-11-01 23:59'))).toBeNull();
    expect(restrictionAt(i, at('2026-11-02 00:00'))).toMatchObject({ reason: 'HOLIDAY_CLOSURE', message: expect.stringContaining('closed for Diwali') });
    expect(restrictionAt(i, at('2026-11-03 23:59'))).toMatchObject({ reason: 'HOLIDAY_CLOSURE' });
    expect(restrictionAt(i, at('2026-11-04 00:00'))).toBeNull();
    expect(nextOpening(i, at('2026-11-02 12:00'))).toEqual(at('2026-11-04 00:00'));
    expect(nextClosing(i, at('2026-11-01 20:00'))).toEqual(at('2026-11-02 00:00'));
  });

  it('with hours, the day after the holiday opens at its opening time', () => {
    const i = inputs({ holidays: [diwali], hours: everyDay('08:00', '22:00') });
    expect(nextOpening(i, at('2026-11-02 12:00'))).toEqual(at('2026-11-04 08:00'));
  });

  it('a holiday outranks the hours; a pause outranks a holiday', () => {
    const i = inputs({ holidays: [diwali], hours: everyDay('08:00', '22:00'), pauses: [pause('SCHEDULED', '2026-11-02 10:00', '2026-11-02 11:00')] });
    expect(restrictionAt(i, at('2026-11-02 09:00'))).toMatchObject({ reason: 'HOLIDAY_CLOSURE' });
    expect(restrictionAt(i, at('2026-11-02 10:30'))).toMatchObject({ reason: 'SCHEDULED_PAUSE' });
  });
});

describe('formats and validation', () => {
  it('ISO 8601 with the zone offset; local date-times parsed in the zone; impossible dates refused', () => {
    expect(isoInZone(at('2026-11-02 16:00'), TZ)).toBe('2026-11-02T16:00:00+05:30');
    expect(parseLocalDateTime('2026-11-02T16:00', TZ)).toEqual(at('2026-11-02 16:00'));
    expect(parseLocalDateTime('2026-02-30T10:00', TZ)).toBeNull();
    expect(parseLocalDateTime('2026-11-02T24:00', TZ)).toBeNull();
    expect(parseLocalDateTime('tomorrow', TZ)).toBeNull();
  });

  it('weekly hours: 7 days or none, each once, HH:mm', () => {
    expect(weeklyHoursProblems([])).toEqual([]);
    expect(weeklyHoursProblems(everyDay('08:00', '22:00'))).toEqual([]);
    expect(weeklyHoursProblems(everyDay('08:00', '22:00').slice(0, 6))).not.toEqual([]);
    expect(weeklyHoursProblems(everyDay('8:00', '22:00'))).not.toEqual([]);
    expect(weeklyHoursProblems(everyDay('08:00', '22:00').map((d) => ({ ...d, dayOfWeek: 1 })))).not.toEqual([]);
    expect(weeklyHoursProblems('all week')).not.toEqual([]);
  });
});
