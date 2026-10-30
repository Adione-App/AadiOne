/**
 * App-wide availability, end to end (real app + database):
 *
 *   - GET /availability (public) is computed on the server: master switch,
 *     emergency closure, pauses, holidays, weekly hours — in that order;
 *   - every order (and the cart's checkout state) obeys it, while browsing
 *     keeps working; a change between quote and order is caught at order time;
 *   - admin management: save / reload, validation, overlap rules, audit rows,
 *     CONFIG_WRITE only;
 *   - nothing is held in memory: a pause survives a cache reset ("restart")
 *     and ends on its own;
 *   - sellers' own availability, hours and radius are unchanged by any of it.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ConfigKey,
  ErrorCode,
  PaymentMethod,
  UserRole,
  type AdminPlatformAvailabilityDto,
  type CartDto,
  type PlatformAvailabilityDto,
  type PlatformDayHours,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { STORE_COORDS, configureTestMerchantUpi, seedAddress, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { getZonedParts } from '../../src/shared/datetime';
import { localDateString, localDateTimeString } from '../../src/modules/platform/platform-schedule';

const TZ = 'Asia/Kolkata';
const BASE = '/admin/platform-availability';

let seq = 0;
async function panelUser(role: UserRole): Promise<{ token: string; userId: string }> {
  seq += 1;
  const email = `platform${seq}@adione.test`;
  const user = await prisma.user.create({
    data: { mobile: `00000004${String(seq).padStart(2, '0')}`, email, fullName: `Ops ${seq}`, passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return { token: expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken, userId: user.id };
}

const as = (token: string | null) => {
  const auth = (r: ReturnType<ReturnType<typeof api>['get']>) => (token ? r.set('Authorization', bearer(token)) : r);
  return {
    get: (p: string) => auth(api().get(`/api/v1${p}`)),
    post: (p: string, body: object = {}) => auth(api().post(`/api/v1${p}`)).send(body),
    put: (p: string, body: object) => auth(api().put(`/api/v1${p}`)).send(body),
    patch: (p: string, body: object) => auth(api().patch(`/api/v1${p}`)).send(body),
    delete: (p: string) => auth(api().delete(`/api/v1${p}`)),
  };
};
const data = <T>(res: { body: unknown }) => expectSuccess<T>(res.body).data;
const availability = async () => data<PlatformAvailabilityDto>(await api().get('/api/v1/availability').expect(200));

/** "HH:mm" in India, `minutes` from now. */
const hhmm = (minutes: number) => {
  const p = getZonedParts(new Date(Date.now() + minutes * 60_000), TZ);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};
const everyDay = (opensAt: string, closesAt: string): PlatformDayHours[] =>
  Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isClosed: false, opensAt, closesAt }));
const localIn = (minutes: number) => localDateTimeString(new Date(Date.now() + minutes * 60_000), TZ);
const today = (days = 0) => localDateString(getZonedParts(new Date(Date.now() + days * 86_400_000), TZ));

async function seedSeller(name = 'Open Kirana') {
  const seller = await prisma.seller.create({
    data: {
      code: `PLAT${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      sellerType: 'GROCERY',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: TZ,
      isActive: true,
      maxServiceRadiusKm: 9,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  return seller.id;
}

/** A customer with one product (from an open seller) in the cart and a serviceable address. */
async function shopper(mobile: string) {
  const sellerId = await seedSeller();
  const product = await seedProduct(sellerId, { pricePaise: 20000, stockQty: 10 });
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  const addressId = await seedAddress(session.userId);
  await as(session.accessToken).post('/cart/items', { sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
  const placeOrder = () =>
    api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.COD });
  return { sellerId, token: session.accessToken, addressId, placeOrder };
}

beforeEach(async () => {
  await truncateAll();
  invalidateCategoryCache();
  await configService.invalidateAll();
  await cache.clear();
  await configureTestMerchantUpi();
});

/* -------------------------------------------------------------------------- */

describe('defaults and the public status', () => {
  it('unconfigured: open, no hours, no location, radius 12 — production behaviour unchanged; guests can read it', async () => {
    const a = await availability();
    expect(a).toMatchObject({
      acceptingOrders: true,
      status: 'OPEN',
      reasonCode: null,
      message: null,
      timezone: TZ,
      hoursConfigured: false,
      todayOpeningHours: null,
      globalLocation: null,
      defaultServiceRadiusKm: 12,
      activeRestriction: null,
    });
    expect(a.currentTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/);
    expect(a.nextOpeningAt).toBeUndefined();
  });
});

describe('authorization', () => {
  it('reads need CONFIG_READ; every write needs CONFIG_WRITE; staff, customers and guests are refused', async () => {
    const staff = await panelUser(UserRole.STAFF);
    await otpService.clearOtpState('9400005001');
    const customer = await loginAs('9400005001');
    const writes = (token: string | null) => [
      as(token).put(`${BASE}/hours`, { hours: everyDay('08:00', '22:00') }),
      as(token).put(`${BASE}/location`, { location: null }),
      as(token).post(`${BASE}/pauses`, { kind: 'EMERGENCY' }),
      as(token).post(`${BASE}/holidays`, { name: 'Diwali', startDate: today(1), endDate: today(1) }),
      as(token).patch('/admin/config', { key: ConfigKey.ORDERING_ENABLED, value: false }),
    ];
    for (const res of await Promise.all(writes(staff.token))) expect(res.status).toBe(403);
    for (const res of await Promise.all(writes(customer.accessToken))) expect(res.status).toBe(403);
    for (const res of await Promise.all(writes(null))) expect(res.status).toBe(401);
    expect((await as(customer.accessToken).get(BASE)).status).toBe(403);
    expect(await prisma.platformPause.count()).toBe(0);
    expect(await prisma.platformHoliday.count()).toBe(0);
    expect((await availability()).acceptingOrders).toBe(true);
  });
});

describe('master switch', () => {
  it('OFF closes ordering for every seller with its message (cart and order), browsing still works; ON reopens', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005002');
    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: 'Closed for stock-taking.' }).expect(200);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_ENABLED, value: false }).expect(200);

    expect(await availability()).toMatchObject({ acceptingOrders: false, status: 'OFF', reasonCode: 'GLOBAL_DISABLED', message: 'Closed for stock-taking.' });
    const cart = data<CartDto>(await as(world.token).get('/cart').expect(200));
    expect(cart).toMatchObject({ orderingEnabled: false, orderingPausedMessage: 'Closed for stock-taking.' });
    expect(cart.items[0]).toMatchObject({ available: true }); // the seller itself is open
    expect(expectError((await world.placeOrder()).body)).toMatchObject({ code: ErrorCode.ORDERING_PAUSED, message: 'Closed for stock-taking.' });
    await api().get('/api/v1/home').expect(200); // browsing works
    expect(await prisma.order.count()).toBe(0);

    const view = data<AdminPlatformAvailabilityDto>(await as(admin.token).get(BASE).expect(200));
    expect(view.settings.orderingEnabled).toBe(false);
    expect(view.masterSwitchChange?.byName).toBe(`Ops ${seq}`);

    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_ENABLED, value: true }).expect(200);
    expect((await availability()).acceptingOrders).toBe(true);
    expect((await world.placeOrder()).status).toBe(201);
  });
});

describe('weekly hours', () => {
  it('saved and reloaded; outside them ordering is refused with the reopening time; clearing them reopens', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005003');
    const later = everyDay(hhmm(120), hhmm(180)); // opens in 2 h

    const saved = data<AdminPlatformAvailabilityDto>(await as(admin.token).put(`${BASE}/hours`, { hours: later }).expect(200));
    expect(saved.settings.hours).toEqual(later);
    expect(data<AdminPlatformAvailabilityDto>(await as(admin.token).get(BASE).expect(200)).settings.hours).toEqual(later);
    // Saving hours does not apply them: still Always Open until Fixed Timing is chosen.
    expect(saved.settings).toMatchObject({ operatingMode: 'ALWAYS_OPEN', operatingModeChosen: true });
    expect((await availability()).acceptingOrders).toBe(true);
    await as(admin.token).put(`${BASE}/mode`, { mode: 'FIXED_TIMING' }).expect(200);

    const closed = await availability();
    expect(closed).toMatchObject({ acceptingOrders: false, status: 'OUTSIDE_HOURS', reasonCode: 'OUTSIDE_OPERATING_HOURS', hoursConfigured: true });
    expect(closed.nextOpeningAt).toMatch(/\+05:30$/);
    expect(closed.message).toMatch(/Opens (today|tomorrow) at /);
    const refused = expectError((await world.placeOrder()).body);
    expect(refused.code).toBe(ErrorCode.ORDERING_PAUSED);
    expect(refused.message).toMatch(/Opens (today|tomorrow) at /);
    expect(await prisma.auditLog.count({ where: { action: 'platform.hours_update' } })).toBe(1);

    // Inside the hours: open.
    await as(admin.token).put(`${BASE}/hours`, { hours: everyDay(hhmm(-60), hhmm(60)) }).expect(200);
    expect(await availability()).toMatchObject({ acceptingOrders: true, status: 'OPEN' });
    // Always Open: no hour restriction at all (the schedule is kept).
    await as(admin.token).put(`${BASE}/hours`, { hours: later }).expect(200);
    await as(admin.token).put(`${BASE}/mode`, { mode: 'ALWAYS_OPEN' }).expect(200);
    expect(await availability()).toMatchObject({ acceptingOrders: true, hoursConfigured: false });
  });

  it('invalid schedules are refused and change nothing', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    await as(admin.token).put(`${BASE}/hours`, { hours: everyDay('08:00', '22:00').slice(0, 6) }).expect(400);
    await as(admin.token).put(`${BASE}/hours`, { hours: everyDay('8:00', '22:00') }).expect(400);
    await as(admin.token).put(`${BASE}/hours`, { hours: everyDay('08:00', '22:00').map((d) => ({ ...d, dayOfWeek: 2 })) }).expect(400);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.PLATFORM_OPERATING_HOURS, value: 'always' }).expect(400);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.STORE_TIMEZONE, value: 'Mars/Olympus' }).expect(400);
    expect((await availability()).hoursConfigured).toBe(false);
  });
});

describe('pauses', () => {
  it('pause now (with a resume time): refused orders, one at a time, resumed early by an admin', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005004');
    const view = data<AdminPlatformAvailabilityDto>(
      await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE', message: 'Restocking, back shortly.', resumeAtLocal: localIn(90) }).expect(201),
    );
    const pause = view.pauses[0]!;
    expect(pause).toMatchObject({ kind: 'IMMEDIATE', status: 'ACTIVE', message: 'Restocking, back shortly.' });
    const a = await availability();
    expect(a).toMatchObject({ acceptingOrders: false, status: 'PAUSED', reasonCode: 'MANUAL_PAUSE', activeRestriction: { id: pause.id } });
    expect(a.nextOpeningAt).toBeDefined();
    expect((await world.placeOrder()).status).toBe(409);

    // A second "pause now" while one runs is a conflict.
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE' }).expect(409);
    // Resume time in the past is refused.
    await as(admin.token).patch(`${BASE}/pauses/${pause.id}`, { endsAtLocal: localIn(-10) }).expect(400);

    await as(admin.token).post(`${BASE}/pauses/${pause.id}/end`).expect(200);
    expect((await availability()).acceptingOrders).toBe(true);
    expect((await world.placeOrder()).status).toBe(201);
    expect(await prisma.auditLog.count({ where: { action: { in: ['platform.pause_create', 'platform.pause_end'] } } })).toBe(2);
  });

  it('an indefinite pause has no reopening time; it survives a cache reset ("restart") because it lives in the database', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE' }).expect(201);
    const a = await availability();
    expect(a).toMatchObject({ acceptingOrders: false, reasonCode: 'MANUAL_PAUSE' });
    expect(a.nextOpeningAt).toBeUndefined();
    await configService.invalidateAll();
    await cache.clear();
    expect((await availability()).reasonCode).toBe('MANUAL_PAUSE');
  });

  it('scheduled: future only, no overlaps, editable and cancellable before it starts; expires on its own', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const created = data<AdminPlatformAvailabilityDto>(
      await as(admin.token).post(`${BASE}/pauses`, { kind: 'SCHEDULED', message: 'Maintenance', startsAtLocal: localIn(120), endsAtLocal: localIn(240) }).expect(201),
    );
    const pause = created.pauses[0]!;
    expect(pause).toMatchObject({ status: 'UPCOMING', startsAtLocal: localIn(120) });
    const open = await availability();
    expect(open.acceptingOrders).toBe(true);
    expect(open.nextChangeAt).toBe(pause.startsAt); // apps ask again when it starts

    await as(admin.token).post(`${BASE}/pauses`, { kind: 'SCHEDULED', startsAtLocal: localIn(180), endsAtLocal: localIn(300) }).expect(409);
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'SCHEDULED', startsAtLocal: localIn(-30), endsAtLocal: localIn(30) }).expect(400);
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'SCHEDULED', startsAtLocal: localIn(120), endsAtLocal: localIn(60) }).expect(400);
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'SCHEDULED', startsAtLocal: '2026-02-30T10:00', endsAtLocal: localIn(60) }).expect(400);

    const moved = data<AdminPlatformAvailabilityDto>(await as(admin.token).patch(`${BASE}/pauses/${pause.id}`, { startsAtLocal: localIn(150) }).expect(200));
    expect(moved.pauses.find((p) => p.id === pause.id)).toMatchObject({ startsAtLocal: localIn(150) });

    const cancelled = data<AdminPlatformAvailabilityDto>(await as(admin.token).post(`${BASE}/pauses/${pause.id}/cancel`).expect(200));
    expect(cancelled.pauses.find((p) => p.id === pause.id)).toMatchObject({ status: 'CANCELLED' });
    await as(admin.token).post(`${BASE}/pauses/${pause.id}/cancel`).expect(409);

    // A pause whose window has passed (as after a restart) is simply over.
    await prisma.platformPause.create({ data: { kind: 'SCHEDULED', startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 3_600_000) } });
    expect((await availability()).acceptingOrders).toBe(true);
    const view = data<AdminPlatformAvailabilityDto>(await as(admin.token).get(BASE).expect(200));
    expect(view.pauses.some((p) => p.status === 'EXPIRED')).toBe(true);
  });

  it('an active timed pause that expires does not reopen what the master switch closes', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    await prisma.platformPause.create({ data: { kind: 'IMMEDIATE', startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 60_000) } });
    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_ENABLED, value: false }).expect(200);
    expect((await availability()).reasonCode).toBe('GLOBAL_DISABLED');
  });
});

describe('holidays and emergency closures', () => {
  it('a holiday today closes with its message; overlapping or past ones are refused; removing it reopens', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005005');
    const view = data<AdminPlatformAvailabilityDto>(
      await as(admin.token).post(`${BASE}/holidays`, { name: 'Diwali', message: 'Happy Diwali! Back on Friday.', startDate: today(), endDate: today(2) }).expect(201),
    );
    const holiday = view.holidays[0]!;
    expect(holiday).toMatchObject({ name: 'Diwali', status: 'ACTIVE', startDate: today(), endDate: today(2) });
    const a = await availability();
    expect(a).toMatchObject({ acceptingOrders: false, status: 'HOLIDAY', reasonCode: 'HOLIDAY_CLOSURE', activeRestriction: { id: holiday.id, name: 'Diwali' } });
    expect(a.message).toMatch(/^Happy Diwali! Back on Friday\. Opens /);
    expect(a.nextOpeningAt).toMatch(new RegExp(`^${today(3)}T00:00:00\\+05:30$`));
    expect(expectError((await world.placeOrder()).body).code).toBe(ErrorCode.ORDERING_PAUSED);

    await as(admin.token).post(`${BASE}/holidays`, { name: 'Overlap', startDate: today(2), endDate: today(4) }).expect(409);
    await as(admin.token).post(`${BASE}/holidays`, { name: 'Past', startDate: today(-5), endDate: today(-4) }).expect(400);
    await as(admin.token).post(`${BASE}/holidays`, { name: 'Backwards', startDate: today(5), endDate: today(4) }).expect(400);
    await as(admin.token).post(`${BASE}/holidays`, { name: 'Too long', startDate: today(10), endDate: today(60) }).expect(400);

    // A later single-day closure and its edit.
    const later = data<AdminPlatformAvailabilityDto>(await as(admin.token).post(`${BASE}/holidays`, { name: 'Holi', startDate: today(10), endDate: today(10) }).expect(201));
    const holi = later.holidays.find((h) => h.name === 'Holi')!;
    expect(holi.status).toBe('UPCOMING');
    await as(admin.token).put(`${BASE}/holidays/${holi.id}`, { name: 'Holi', message: 'Closed for Holi.', startDate: today(11), endDate: today(11) }).expect(200);

    await as(admin.token).delete(`${BASE}/holidays/${holiday.id}`).expect(200);
    expect((await availability()).acceptingOrders).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'platform.holiday_' } } })).toBe(4);
  });

  it('an emergency closure is enforced at once, outranks a pause, and ends only when an admin ends it', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005006');
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE', resumeAtLocal: localIn(60) }).expect(201);
    const view = data<AdminPlatformAvailabilityDto>(await as(admin.token).post(`${BASE}/pauses`, { kind: 'EMERGENCY', message: 'Heavy rain — riders are off the road.' }).expect(201));
    const emergency = view.pauses.find((p) => p.kind === 'EMERGENCY')!;
    const a = await availability();
    expect(a).toMatchObject({ status: 'EMERGENCY', reasonCode: 'EMERGENCY_CLOSURE', message: 'Heavy rain — riders are off the road.' });
    expect(a.nextOpeningAt).toBeUndefined();
    expect(expectError((await world.placeOrder()).body).message).toBe('Heavy rain — riders are off the road.');
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'EMERGENCY' }).expect(409);

    await as(admin.token).post(`${BASE}/pauses/${emergency.id}/end`).expect(200);
    // The pause below it still applies.
    expect((await availability()).reasonCode).toBe('MANUAL_PAUSE');
  });
});

describe('main location and radius', () => {
  it('saved and reloaded, validated, informational only — sellers keep their own points and radius', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const sellerId = await seedSeller('Radius Shop');
    const location = { addressLine: 'Aadione HQ, Station Road, Sikar', landmark: 'Near clock tower', latitude: 27.6094, longitude: 75.1399 };
    const saved = data<AdminPlatformAvailabilityDto>(await as(admin.token).put(`${BASE}/location`, { location }).expect(200));
    // No name given: stored as null (the name field came later).
    expect(saved.settings.location).toEqual({ ...location, name: null });
    expect((await availability()).globalLocation).toEqual({ ...location, name: null });

    await as(admin.token).put(`${BASE}/location`, { location: { ...location, latitude: 91 } }).expect(400);
    await as(admin.token).put(`${BASE}/location`, { location: { ...location, latitude: 0, longitude: 0 } }).expect(400);
    await as(admin.token).put(`${BASE}/location`, { location: { ...location, addressLine: 'x' } }).expect(400);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: -1 }).expect(400);
    expect((await availability()).globalLocation).toEqual({ ...location, name: null });

    // Seller untouched; its own radius still decides its delivery area.
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId }, include: { hours: true } });
    expect(seller).toMatchObject({ maxServiceRadiusKm: 9, ...STORE_COORDS });
    expect(seller.hours).toHaveLength(7);
    const area = await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-area`).expect(200);
    expect(data<{ effectiveRadiusKm: number }>(area).effectiveRadiusKm).toBe(9);

    await as(admin.token).put(`${BASE}/location`, { location: null }).expect(200);
    expect((await availability()).globalLocation).toBeNull();
  });
});

describe('seller rules under the global rule', () => {
  it('global open: a closed seller is still closed; global closed: an open seller cannot take orders', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005007');
    await prisma.seller.update({ where: { id: world.sellerId }, data: { isAcceptingOrders: false } });
    const cart = data<CartDto>(await as(world.token).get('/cart').expect(200));
    expect(cart.orderingEnabled).toBe(true);
    expect(cart.items[0]).toMatchObject({ available: false, unavailableReason: 'STORE_CLOSED' });

    await prisma.seller.update({ where: { id: world.sellerId }, data: { isAcceptingOrders: true } });
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE' }).expect(201);
    const paused = data<CartDto>(await as(world.token).get('/cart').expect(200));
    expect(paused.orderingEnabled).toBe(false);
    expect(paused.items[0]).toMatchObject({ available: true });
    expect((await world.placeOrder()).status).toBe(409);
  });

  it('closing between the quote and the order is caught at order time; nothing is ordered', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005008');
    await as(world.token).post('/checkout/quote', { addressId: world.addressId }).expect(200);
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'EMERGENCY' }).expect(201);
    const res = await world.placeOrder();
    expect(expectError(res.body).code).toBe(ErrorCode.ORDERING_PAUSED);
    expect(await prisma.order.count()).toBe(0);
  });

  it('closing never touches orders already placed: they can still be read and cancelled', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005009');
    const placed = await world.placeOrder();
    expect(placed.status).toBe(201);
    const orderId = expectSuccess<{ order: { id: string } }>(placed.body).data.order.id;
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'EMERGENCY' }).expect(201);
    await as(world.token).get(`/orders/${orderId}`).expect(200);
    await as(world.token).post(`/orders/${orderId}/cancel`, { reason: 'Changed my mind' }).expect(200);
  });
});

describe('operating mode: Fixed Timing / Always Open', () => {
  it('never chosen: follows the schedule (production behaviour unchanged); Always Open lifts only the hours and keeps them', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005010');
    const later = everyDay(hhmm(120), hhmm(180)); // closed now

    expect((await availability()).operatingMode).toBe('ALWAYS_OPEN'); // nothing saved
    // As stored before the mode existed (production): hours saved, no mode → the hours apply.
    await configService.set({ key: ConfigKey.PLATFORM_OPERATING_HOURS, value: later as never, actorUserId: admin.userId });
    let view = data<AdminPlatformAvailabilityDto>(await as(admin.token).get(BASE).expect(200));
    expect(view.settings).toMatchObject({ operatingMode: 'FIXED_TIMING', operatingModeChosen: false });
    expect(view.settings.hoursChange?.byName).toBe(`Ops ${seq}`);
    // Editing the hours then keeps that mode (pinned), it does not flip it.
    view = data<AdminPlatformAvailabilityDto>(await as(admin.token).put(`${BASE}/hours`, { hours: later }).expect(200));
    expect(view.settings).toMatchObject({ operatingMode: 'FIXED_TIMING', operatingModeChosen: true });
    expect(await availability()).toMatchObject({ status: 'OUTSIDE_HOURS', operatingMode: 'FIXED_TIMING' });

    view = data<AdminPlatformAvailabilityDto>(await as(admin.token).put(`${BASE}/mode`, { mode: 'ALWAYS_OPEN' }).expect(200));
    expect(view.settings).toMatchObject({ operatingMode: 'ALWAYS_OPEN', operatingModeChosen: true, hours: later });
    expect(await availability()).toMatchObject({ acceptingOrders: true, operatingMode: 'ALWAYS_OPEN', hoursConfigured: false, todayOpeningHours: null });
    expect((await world.placeOrder()).status).toBe(201);
    expect(await prisma.auditLog.count({ where: { action: 'platform.operating_mode_update' } })).toBe(1);

    // Back to Fixed Timing: the kept schedule applies again.
    await as(admin.token).put(`${BASE}/mode`, { mode: 'FIXED_TIMING' }).expect(200);
    expect(await availability()).toMatchObject({ acceptingOrders: false, reasonCode: 'OUTSIDE_OPERATING_HOURS' });
    // Fixed Timing cannot lose its schedule.
    await as(admin.token).put(`${BASE}/hours`, { hours: [] }).expect(409);
  });

  it('Always Open never bypasses the master switch, a pause, a holiday or an emergency', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const world = await shopper('9400005011');
    await as(admin.token).put(`${BASE}/hours`, { hours: everyDay(hhmm(120), hhmm(180)) }).expect(200);
    await as(admin.token).put(`${BASE}/mode`, { mode: 'ALWAYS_OPEN' }).expect(200);

    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_ENABLED, value: false }).expect(200);
    expect((await availability()).reasonCode).toBe('GLOBAL_DISABLED');
    expect((await world.placeOrder()).status).toBe(409);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_ENABLED, value: true }).expect(200);

    const paused = data<AdminPlatformAvailabilityDto>(await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE' }).expect(201));
    expect((await availability()).reasonCode).toBe('MANUAL_PAUSE');
    await as(admin.token).post(`${BASE}/pauses/${paused.pauses[0]!.id}/end`).expect(200);

    const holiday = data<AdminPlatformAvailabilityDto>(await as(admin.token).post(`${BASE}/holidays`, { name: 'Local Day', startDate: today(), endDate: today() }).expect(201));
    expect((await availability()).reasonCode).toBe('HOLIDAY_CLOSURE');
    await as(admin.token).delete(`${BASE}/holidays/${holiday.holidays[0]!.id}`).expect(200);

    await as(admin.token).post(`${BASE}/pauses`, { kind: 'EMERGENCY' }).expect(201);
    expect((await availability()).reasonCode).toBe('EMERGENCY_CLOSURE');
  });

  it('Fixed Timing needs a saved schedule; only CONFIG_WRITE may switch; invalid modes are refused', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const staff = await panelUser(UserRole.STAFF);
    await as(admin.token).put(`${BASE}/mode`, { mode: 'FIXED_TIMING' }).expect(400);
    await as(admin.token).put(`${BASE}/mode`, { mode: 'SOMETIMES' }).expect(400);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.PLATFORM_OPERATING_MODE, value: 'SOMETIMES' }).expect(400);
    expect((await as(staff.token).put(`${BASE}/mode`, { mode: 'ALWAYS_OPEN' })).status).toBe(403);
    expect((await as(null).put(`${BASE}/mode`, { mode: 'ALWAYS_OPEN' })).status).toBe(401);
    expect((await availability()).operatingMode).toBe('ALWAYS_OPEN');
  });
});

describe('main location name', () => {
  it('is saved and read back with the address; a location saved before names existed still reads', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const location = { name: 'Aadione Main Store', addressLine: 'Bus Stand Road, Railmagra', landmark: null, latitude: 25.029, longitude: 74.1096 };
    const saved = data<AdminPlatformAvailabilityDto>(await as(admin.token).put(`${BASE}/location`, { location }).expect(200));
    expect(saved.settings.location).toEqual(location);
    expect((await availability()).globalLocation).toEqual(location);
    await as(admin.token).put(`${BASE}/location`, { location: { ...location, name: 'x'.repeat(121) } }).expect(400);

    // As stored by the first version (no name).
    await configService.set({ key: ConfigKey.PLATFORM_LOCATION, value: { addressLine: 'Old HQ', landmark: null, latitude: 25.03, longitude: 74.11 } as never });
    expect((await availability()).globalLocation).toMatchObject({ addressLine: 'Old HQ', latitude: 25.03 });
  });
});

describe('pause for a duration', () => {
  it('ends that long after the server\'s now; a duration and a resume time together are refused', async () => {
    const admin = await panelUser(UserRole.ADMIN);
    const before = Date.now();
    const view = data<AdminPlatformAvailabilityDto>(await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE', durationMinutes: 30 }).expect(201));
    const ends = Date.parse(view.pauses[0]!.endsAt!);
    expect(ends - before).toBeGreaterThanOrEqual(30 * 60_000 - 1_000);
    expect(ends - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 1_000);
    expect((await availability()).reasonCode).toBe('MANUAL_PAUSE');
    await as(admin.token).post(`${BASE}/pauses/${view.pauses[0]!.id}/end`).expect(200);
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE', durationMinutes: 30, resumeAtLocal: localIn(60) }).expect(400);
    await as(admin.token).post(`${BASE}/pauses`, { kind: 'IMMEDIATE', durationMinutes: 0 }).expect(400);
  });
});
