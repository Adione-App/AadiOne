/**
 * App-wide availability — loads the inputs and applies THE rule
 * (platform-schedule.ts) for the server's "now"; admin management of the
 * inputs: weekly hours, pauses, holidays, the emergency closure and Aadione's
 * main location.
 *
 * One source of truth per input:
 *   master switch + its message   Configuration ORDERING_ENABLED / ORDERING_PAUSED_MESSAGE
 *   timezone                      Configuration STORE_TIMEZONE (the marketplace timezone)
 *   weekly hours                  Configuration PLATFORM_OPERATING_HOURS (empty = none)
 *   main location                 Configuration PLATFORM_LOCATION ({} = not set)
 *   default service radius        Configuration MAX_SERVICE_RADIUS_KM (unchanged meaning)
 *   pauses / emergency closures   platform_pauses (instants)
 *   holidays                      platform_holidays (local dates)
 *
 * Nothing is held in memory or on a timer: every evaluation reads the rows,
 * so a pause starts and ends on time and survives a restart. Every order and
 * payment start goes through store-availability.ts `assertOrderingEnabled`,
 * which asks this module.
 *
 * The main location is INFORMATIONAL: delivery is still measured from each
 * seller's own map point and radius (seller.service.ts). It is never a
 * delivery origin.
 */

import { ConfigKey, ErrorCode } from '../../shared';
import type {
  AdminPlatformAvailabilityDto,
  PlatformAvailabilityDto,
  PlatformAvailabilityStatus,
  PlatformClosedReason,
  PlatformDayHours,
  PlatformHolidayDto,
  PlatformHolidayStatus,
  PlatformLocation,
  PlatformPauseDto,
  PlatformPauseKind,
  PlatformPauseStatus,
} from '../../shared';
import { getZonedParts } from '../../shared/datetime';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { emitStoreAvailabilityChanged } from '../../realtime/socket';
import * as configService from '../configuration/configuration.service';
import {
  addDays,
  describeOpening,
  isRealDate,
  isoInZone,
  localDateString,
  localDateTimeString,
  nextClosing,
  nextOpening,
  parseLocalDateTime,
  restrictionAt,
  todayHours,
  type Holiday,
  type PlatformInputs,
  type ScheduledPause,
} from './platform-schedule';

/** Serializes pause / holiday writes, so two admins cannot create overlapping ones at once. */
const WRITE_LOCK_KEY = 7_310_029;
const MAX_PAUSE_DAYS = 31;
const MAX_HOLIDAY_DAYS = 31;
const HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;

const STATUS_OF: Record<PlatformClosedReason, PlatformAvailabilityStatus> = {
  GLOBAL_DISABLED: 'OFF',
  EMERGENCY_CLOSURE: 'EMERGENCY',
  MANUAL_PAUSE: 'PAUSED',
  SCHEDULED_PAUSE: 'PAUSED',
  HOLIDAY_CLOSURE: 'HOLIDAY',
  OUTSIDE_OPERATING_HOURS: 'OUTSIDE_HOURS',
};

const conflict = (message: string) => new AppError(ErrorCode.VALIDATION_ERROR, { status: 409, message });
const invalid = (message: string) => new AppError(ErrorCode.VALIDATION_ERROR, { message });
const notFound = (what: string) => new AppError(ErrorCode.NOT_FOUND, { message: `${what} not found.` });
const dateOf = (d: Date) => d.toISOString().slice(0, 10);

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

interface Loaded {
  inputs: PlatformInputs;
  location: PlatformLocation | null;
  defaultServiceRadiusKm: number;
}

export function locationOrNull(value: PlatformLocation | Record<string, never>): PlatformLocation | null {
  return 'latitude' in value && typeof value.latitude === 'number' ? (value as PlatformLocation) : null;
}

async function load(now: Date): Promise<Loaded> {
  const config = await configService.getMany([
    ConfigKey.ORDERING_ENABLED,
    ConfigKey.ORDERING_PAUSED_MESSAGE,
    ConfigKey.STORE_TIMEZONE,
    ConfigKey.PLATFORM_OPERATING_HOURS,
    ConfigKey.PLATFORM_LOCATION,
    ConfigKey.MAX_SERVICE_RADIUS_KM,
  ]);
  const timezone = config.STORE_TIMEZONE || 'Asia/Kolkata';
  const yesterday = addDays(localDateString(getZonedParts(now, timezone)), -1);
  const [pauses, holidays] = await Promise.all([
    // Not cancelled, not ended early, not over.
    prisma.platformPause.findMany({
      where: { cancelledAt: null, endedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      orderBy: { startsAt: 'asc' },
    }),
    prisma.platformHoliday.findMany({ where: { endDate: { gte: new Date(`${yesterday}T00:00:00.000Z`) } }, orderBy: { startDate: 'asc' } }),
  ]);
  return {
    inputs: {
      orderingEnabled: config.ORDERING_ENABLED,
      pausedMessage: config.ORDERING_PAUSED_MESSAGE,
      timezone,
      hours: Array.isArray(config.PLATFORM_OPERATING_HOURS) ? config.PLATFORM_OPERATING_HOURS : [],
      pauses: pauses.map((p): ScheduledPause => ({ id: p.id, kind: p.kind, message: p.message, startsAt: p.startsAt, endsAt: p.endsAt })),
      holidays: holidays.map((h): Holiday => ({ id: h.id, name: h.name, message: h.message, startDate: dateOf(h.startDate), endDate: dateOf(h.endDate) })),
    },
    location: locationOrNull(config.PLATFORM_LOCATION),
    defaultServiceRadiusKm: config.MAX_SERVICE_RADIUS_KM,
  };
}

function toDto(loaded: Loaded, now: Date): PlatformAvailabilityDto {
  const { inputs } = loaded;
  const tz = inputs.timezone;
  const restriction = restrictionAt(inputs, now);
  const opening = restriction ? nextOpening(inputs, now) : null;
  const openingText = opening ? describeOpening(opening, now, tz) : null;
  const change = restriction ? restriction.until : nextClosing(inputs, now);
  return {
    acceptingOrders: restriction === null,
    status: restriction ? STATUS_OF[restriction.reason] : 'OPEN',
    reasonCode: restriction?.reason ?? null,
    message: restriction ? (openingText ? `${restriction.message} ${openingText}.` : restriction.message) : null,
    timezone: tz,
    currentTime: isoInZone(now, tz),
    ...(opening ? { nextOpeningAt: isoInZone(opening, tz), nextOpeningText: openingText! } : {}),
    ...(change ? { nextChangeAt: isoInZone(change, tz) } : {}),
    hoursConfigured: inputs.hours.length > 0,
    todayOpeningHours: todayHours(inputs, now),
    globalLocation: loaded.location,
    defaultServiceRadiusKm: loaded.defaultServiceRadiusKm,
    activeRestriction: restriction
      ? {
          kind: restriction.reason,
          id: restriction.id,
          name: restriction.name,
          startsAt: restriction.startsAt ? isoInZone(restriction.startsAt, tz) : null,
          endsAt: restriction.endsAt ? isoInZone(restriction.endsAt, tz) : null,
        }
      : null,
  };
}

/** The app's availability right now — GET /availability, the cart, every order and payment start. */
export async function getPlatformAvailability(now: Date = new Date()): Promise<PlatformAvailabilityDto> {
  return toDto(await load(now), now);
}

/* -------------------------------------------------------------------------- */
/* Admin view                                                                 */
/* -------------------------------------------------------------------------- */

function pauseStatus(p: { startsAt: Date; endsAt: Date | null; cancelledAt: Date | null; endedAt: Date | null }, now: Date): PlatformPauseStatus {
  if (p.cancelledAt) return 'CANCELLED';
  if (p.endedAt) return 'ENDED';
  if (p.startsAt > now) return 'UPCOMING';
  if (p.endsAt && p.endsAt <= now) return 'EXPIRED';
  return 'ACTIVE';
}

function holidayStatus(h: { startDate: string; endDate: string }, today: string): PlatformHolidayStatus {
  if (h.endDate < today) return 'PAST';
  return h.startDate > today ? 'UPCOMING' : 'ACTIVE';
}

async function userNames(ids: (string | null)[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email ?? null]));
}

export async function getAdminView(now: Date = new Date()): Promise<AdminPlatformAvailabilityDto> {
  const loaded = await load(now);
  const tz = loaded.inputs.timezone;
  const today = localDateString(getZonedParts(now, tz));
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const [pauses, holidays, masterRow, config] = await Promise.all([
    prisma.platformPause.findMany({
      where: { OR: [{ createdAt: { gte: since } }, { cancelledAt: null, endedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: since } }] }] },
      orderBy: { startsAt: 'desc' },
      take: 100,
    }),
    prisma.platformHoliday.findMany({
      where: { endDate: { gte: new Date(`${addDays(today, -HISTORY_DAYS)}T00:00:00.000Z`) } },
      orderBy: { startDate: 'asc' },
      take: 200,
    }),
    prisma.configuration.findFirst({ where: { key: ConfigKey.ORDERING_ENABLED, sellerId: null }, select: { updatedAt: true, updatedByUserId: true } }),
    configService.getMany([ConfigKey.ORDERING_ENABLED, ConfigKey.ORDERING_PAUSED_MESSAGE]),
  ]);
  const names = await userNames([...pauses.map((p) => p.createdByUserId), ...holidays.map((h) => h.createdByUserId), masterRow?.updatedByUserId ?? null]);

  return {
    availability: toDto(loaded, now),
    settings: {
      orderingEnabled: config.ORDERING_ENABLED,
      pausedMessage: config.ORDERING_PAUSED_MESSAGE,
      timezone: tz,
      hours: [...loaded.inputs.hours],
      location: loaded.location,
      defaultServiceRadiusKm: loaded.defaultServiceRadiusKm,
    },
    masterSwitchChange: masterRow
      ? { at: masterRow.updatedAt.toISOString(), byName: masterRow.updatedByUserId ? (names.get(masterRow.updatedByUserId) ?? null) : null }
      : null,
    pauses: pauses.map(
      (p): PlatformPauseDto => ({
        id: p.id,
        kind: p.kind,
        message: p.message,
        startsAt: isoInZone(p.startsAt, tz),
        endsAt: p.endsAt ? isoInZone(p.endsAt, tz) : null,
        startsAtLocal: localDateTimeString(p.startsAt, tz),
        endsAtLocal: p.endsAt ? localDateTimeString(p.endsAt, tz) : null,
        status: pauseStatus(p, now),
        cancelledAt: p.cancelledAt?.toISOString() ?? null,
        endedAt: p.endedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
        createdByName: p.createdByUserId ? (names.get(p.createdByUserId) ?? null) : null,
      }),
    ),
    holidays: holidays.map((h): PlatformHolidayDto => {
      const startDate = dateOf(h.startDate);
      const endDate = dateOf(h.endDate);
      return {
        id: h.id,
        name: h.name,
        message: h.message,
        startDate,
        endDate,
        status: holidayStatus({ startDate, endDate }, today),
        createdAt: h.createdAt.toISOString(),
        createdByName: h.createdByUserId ? (names.get(h.createdByUserId) ?? null) : null,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Weekly hours and main location (configuration)                            */
/* -------------------------------------------------------------------------- */

/** Saves the weekly schedule (7 days) or clears it ([] = no hour restriction). Validated by the configuration service. */
export async function setOperatingHours(hours: PlatformDayHours[], actorUserId: string): Promise<AdminPlatformAvailabilityDto> {
  const sorted = [...hours].sort((a, b) => a.dayOfWeek - b.dayOfWeek).map((h) => ({ dayOfWeek: h.dayOfWeek, isClosed: h.isClosed, opensAt: h.opensAt, closesAt: h.closesAt }));
  const before = await configService.get(ConfigKey.PLATFORM_OPERATING_HOURS);
  await configService.set({ key: ConfigKey.PLATFORM_OPERATING_HOURS, value: sorted as never, actorUserId });
  await prisma.auditLog.create({
    data: { actorUserId, action: 'platform.hours_update', entityType: 'Configuration', entityId: ConfigKey.PLATFORM_OPERATING_HOURS, before: { hours: before as never }, after: { hours: sorted } },
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

/** Saves (or clears, with null) Aadione's main location. Informational only. */
export async function setLocation(location: PlatformLocation | null, actorUserId: string): Promise<AdminPlatformAvailabilityDto> {
  const value = location
    ? { addressLine: location.addressLine.trim(), landmark: location.landmark?.trim() || null, latitude: location.latitude, longitude: location.longitude }
    : {};
  const before = await configService.get(ConfigKey.PLATFORM_LOCATION);
  await configService.set({ key: ConfigKey.PLATFORM_LOCATION, value: value as never, actorUserId });
  await prisma.auditLog.create({
    data: { actorUserId, action: 'platform.location_update', entityType: 'Configuration', entityId: ConfigKey.PLATFORM_LOCATION, before: before as never, after: value },
  });
  return getAdminView();
}

/* -------------------------------------------------------------------------- */
/* Pauses and the emergency closure                                           */
/* -------------------------------------------------------------------------- */

export type CreatePauseInput =
  | { kind: 'IMMEDIATE'; message?: string | null; resumeAtLocal?: string | null }
  | { kind: 'EMERGENCY'; message?: string | null }
  | { kind: 'SCHEDULED'; message?: string | null; startsAtLocal: string; endsAtLocal: string };

async function timezone(): Promise<string> {
  return (await configService.get(ConfigKey.STORE_TIMEZONE)) || 'Asia/Kolkata';
}

function parseInZone(value: string, tz: string, label: string): Date {
  const at = parseLocalDateTime(value, tz);
  if (!at) throw invalid(`${label} must be a real date and time (YYYY-MM-DDTHH:mm).`);
  return at;
}

function assertWindow(start: Date, end: Date, now: Date): void {
  if (end <= start) throw invalid('The pause must end after it starts.');
  if (end.getTime() - start.getTime() > MAX_PAUSE_DAYS * DAY_MS) throw invalid(`A pause can last at most ${MAX_PAUSE_DAYS} days — use a holiday for longer closures.`);
  if (end <= now) throw invalid('The end time has already passed.');
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function lock(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WRITE_LOCK_KEY})`;
}

/** Another live scheduled pause overlapping [start, end) — scheduled pauses never overlap each other. */
async function assertNoScheduledOverlap(tx: Tx, start: Date, end: Date, now: Date, exceptId?: string): Promise<void> {
  const clash = await tx.platformPause.findFirst({
    where: {
      kind: 'SCHEDULED',
      cancelledAt: null,
      endedAt: null,
      startsAt: { lt: end },
      endsAt: { gt: start > now ? start : now },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  if (clash) throw conflict('This overlaps another scheduled pause. Change or cancel that one first.');
}

export async function createPause(input: CreatePauseInput, actorUserId: string, now: Date = new Date()): Promise<AdminPlatformAvailabilityDto> {
  const tz = await timezone();
  const message = input.message?.trim() || null;
  let startsAt = now;
  let endsAt: Date | null = null;
  if (input.kind === 'IMMEDIATE' && input.resumeAtLocal) {
    endsAt = parseInZone(input.resumeAtLocal, tz, 'The resume time');
    assertWindow(startsAt, endsAt, now);
  }
  if (input.kind === 'SCHEDULED') {
    startsAt = parseInZone(input.startsAtLocal, tz, 'The start time');
    endsAt = parseInZone(input.endsAtLocal, tz, 'The end time');
    if (startsAt <= now) throw invalid('A scheduled pause must start in the future — use "Pause now" to pause immediately.');
    if (startsAt.getTime() - now.getTime() > 366 * DAY_MS) throw invalid('A scheduled pause can start at most a year ahead.');
    assertWindow(startsAt, endsAt, now);
  }

  await prisma.$transaction(async (tx) => {
    await lock(tx);
    if (input.kind === 'SCHEDULED') await assertNoScheduledOverlap(tx, startsAt, endsAt!, now);
    else {
      const running = await tx.platformPause.findFirst({
        where: { kind: input.kind, cancelledAt: null, endedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      });
      if (running) {
        throw conflict(input.kind === 'EMERGENCY' ? 'An emergency closure is already active.' : 'Ordering is already paused — resume it or change its resume time.');
      }
    }
    const pause = await tx.platformPause.create({ data: { kind: input.kind, message, startsAt, endsAt, createdByUserId: actorUserId } });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: input.kind === 'EMERGENCY' ? 'platform.emergency_start' : 'platform.pause_create',
        entityType: 'PlatformPause',
        entityId: pause.id,
        after: { kind: pause.kind, message, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null },
      },
    });
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

export interface UpdatePauseInput {
  message?: string | null;
  /** UPCOMING scheduled pauses only. */
  startsAtLocal?: string;
  /** UPCOMING scheduled pauses; an ACTIVE "pause now" may set (or, with null, clear) its resume time. */
  endsAtLocal?: string | null;
}

export async function updatePause(id: string, input: UpdatePauseInput, actorUserId: string, now: Date = new Date()): Promise<AdminPlatformAvailabilityDto> {
  const tz = await timezone();
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const pause = await tx.platformPause.findUnique({ where: { id } });
    if (!pause) throw notFound('Pause');
    const status = pauseStatus(pause, now);
    if (status !== 'UPCOMING' && status !== 'ACTIVE') throw conflict('This pause is over and can no longer be changed.');

    const data: { message?: string | null; startsAt?: Date; endsAt?: Date | null } = {};
    if (input.message !== undefined) data.message = input.message?.trim() || null;

    if (input.startsAtLocal !== undefined || input.endsAtLocal !== undefined) {
      if (pause.kind === 'EMERGENCY') throw conflict('An emergency closure has no schedule — end it when ordering can resume.');
      if (pause.kind === 'SCHEDULED') {
        if (status !== 'UPCOMING') throw conflict('A scheduled pause that has started can only be ended, not rescheduled.');
        const startsAt = input.startsAtLocal !== undefined ? parseInZone(input.startsAtLocal, tz, 'The start time') : pause.startsAt;
        if (input.endsAtLocal === null) throw invalid('A scheduled pause needs an end time.');
        const endsAt = input.endsAtLocal !== undefined ? parseInZone(input.endsAtLocal, tz, 'The end time') : pause.endsAt!;
        if (startsAt <= now) throw invalid('A scheduled pause must start in the future.');
        assertWindow(startsAt, endsAt, now);
        await assertNoScheduledOverlap(tx, startsAt, endsAt, now, pause.id);
        data.startsAt = startsAt;
        data.endsAt = endsAt;
      } else {
        // IMMEDIATE: only its resume time.
        if (input.startsAtLocal !== undefined) throw invalid('A "pause now" started when it was created; only its resume time can change.');
        if (input.endsAtLocal === null) data.endsAt = null;
        else if (input.endsAtLocal !== undefined) {
          const endsAt = parseInZone(input.endsAtLocal, tz, 'The resume time');
          assertWindow(pause.startsAt, endsAt, now);
          data.endsAt = endsAt;
        }
      }
    }

    await tx.platformPause.update({ where: { id }, data });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'platform.pause_update',
        entityType: 'PlatformPause',
        entityId: id,
        before: { message: pause.message, startsAt: pause.startsAt.toISOString(), endsAt: pause.endsAt?.toISOString() ?? null },
        after: {
          message: data.message !== undefined ? data.message : pause.message,
          startsAt: (data.startsAt ?? pause.startsAt).toISOString(),
          endsAt: data.endsAt !== undefined ? (data.endsAt?.toISOString() ?? null) : (pause.endsAt?.toISOString() ?? null),
        },
      },
    });
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

/** Cancels a pause that has not started yet. */
export async function cancelPause(id: string, actorUserId: string, now: Date = new Date()): Promise<AdminPlatformAvailabilityDto> {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const pause = await tx.platformPause.findUnique({ where: { id } });
    if (!pause) throw notFound('Pause');
    if (pauseStatus(pause, now) !== 'UPCOMING') throw conflict('Only a pause that has not started can be cancelled — end an active one instead.');
    await tx.platformPause.update({ where: { id }, data: { cancelledAt: now } });
    await tx.auditLog.create({ data: { actorUserId, action: 'platform.pause_cancel', entityType: 'PlatformPause', entityId: id, before: { startsAt: pause.startsAt.toISOString() } } });
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

/** Resumes ordering early: ends an active pause or the emergency closure now. Other restrictions still apply. */
export async function endPause(id: string, actorUserId: string, now: Date = new Date()): Promise<AdminPlatformAvailabilityDto> {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const pause = await tx.platformPause.findUnique({ where: { id } });
    if (!pause) throw notFound('Pause');
    if (pauseStatus(pause, now) !== 'ACTIVE') throw conflict('This pause is not active — cancel an upcoming one instead.');
    await tx.platformPause.update({ where: { id }, data: { endedAt: now } });
    await tx.auditLog.create({
      data: { actorUserId, action: pause.kind === 'EMERGENCY' ? 'platform.emergency_end' : 'platform.pause_end', entityType: 'PlatformPause', entityId: id, after: { endedAt: now.toISOString() } },
    });
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

/* -------------------------------------------------------------------------- */
/* Holidays                                                                   */
/* -------------------------------------------------------------------------- */

export interface HolidayInput {
  name: string;
  message?: string | null;
  startDate: string;
  endDate: string;
}

function validateHoliday(input: HolidayInput, today: string): void {
  if (!isRealDate(input.startDate) || !isRealDate(input.endDate)) throw invalid('Use real calendar dates (YYYY-MM-DD).');
  if (input.endDate < input.startDate) throw invalid('The last day cannot be before the first day.');
  const days = (Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / DAY_MS + 1;
  if (days > MAX_HOLIDAY_DAYS) throw invalid(`A closure can cover at most ${MAX_HOLIDAY_DAYS} days.`);
  if (input.endDate < today) throw invalid('That closure would already be over.');
}

async function assertNoHolidayOverlap(tx: Tx, input: HolidayInput, exceptId?: string): Promise<void> {
  const clash = await tx.platformHoliday.findFirst({
    where: {
      startDate: { lte: new Date(`${input.endDate}T00:00:00.000Z`) },
      endDate: { gte: new Date(`${input.startDate}T00:00:00.000Z`) },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  if (clash) throw conflict(`These dates overlap "${clash.name}" (${dateOf(clash.startDate)} to ${dateOf(clash.endDate)}).`);
}

export async function createHoliday(input: HolidayInput, actorUserId: string, now: Date = new Date()): Promise<AdminPlatformAvailabilityDto> {
  const today = localDateString(getZonedParts(now, await timezone()));
  validateHoliday(input, today);
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    await assertNoHolidayOverlap(tx, input);
    const holiday = await tx.platformHoliday.create({
      data: {
        name: input.name.trim(),
        message: input.message?.trim() || null,
        startDate: new Date(`${input.startDate}T00:00:00.000Z`),
        endDate: new Date(`${input.endDate}T00:00:00.000Z`),
        createdByUserId: actorUserId,
      },
    });
    await tx.auditLog.create({
      data: { actorUserId, action: 'platform.holiday_create', entityType: 'PlatformHoliday', entityId: holiday.id, after: { name: holiday.name, startDate: input.startDate, endDate: input.endDate } },
    });
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

export async function updateHoliday(id: string, input: HolidayInput, actorUserId: string, now: Date = new Date()): Promise<AdminPlatformAvailabilityDto> {
  const today = localDateString(getZonedParts(now, await timezone()));
  validateHoliday(input, today);
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const holiday = await tx.platformHoliday.findUnique({ where: { id } });
    if (!holiday) throw notFound('Closure');
    if (dateOf(holiday.endDate) < today) throw conflict('This closure is over and can no longer be changed.');
    await assertNoHolidayOverlap(tx, input, id);
    await tx.platformHoliday.update({
      where: { id },
      data: {
        name: input.name.trim(),
        message: input.message?.trim() || null,
        startDate: new Date(`${input.startDate}T00:00:00.000Z`),
        endDate: new Date(`${input.endDate}T00:00:00.000Z`),
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'platform.holiday_update',
        entityType: 'PlatformHoliday',
        entityId: id,
        before: { name: holiday.name, startDate: dateOf(holiday.startDate), endDate: dateOf(holiday.endDate) },
        after: { name: input.name.trim(), startDate: input.startDate, endDate: input.endDate },
      },
    });
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

export async function deleteHoliday(id: string, actorUserId: string): Promise<AdminPlatformAvailabilityDto> {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const holiday = await tx.platformHoliday.findUnique({ where: { id } });
    if (!holiday) throw notFound('Closure');
    await tx.platformHoliday.delete({ where: { id } });
    await tx.auditLog.create({
      data: { actorUserId, action: 'platform.holiday_delete', entityType: 'PlatformHoliday', entityId: id, before: { name: holiday.name, startDate: dateOf(holiday.startDate), endDate: dateOf(holiday.endDate) } },
    });
  });
  emitStoreAvailabilityChanged(null);
  return getAdminView();
}

export type { PlatformPauseKind };
