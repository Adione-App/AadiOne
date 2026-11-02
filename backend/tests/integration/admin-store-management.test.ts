/**
 * Admin store management, end to end (real app + database):
 *
 *   - availability: admin sets a seller's Accepting Orders switch, weekly
 *     hours with the store's own timezone, and date closures — through the
 *     seller's own service and the one availability rule (admin inactive >
 *     switch > closure > hours), under the app-wide ordering pause;
 *   - identity and location: store name, address and map point saved and
 *     read back together, validated, audited, with the last change shown;
 *   - delivery area: the admin's one area (service location PLATFORM_LOCATION
 *     + radius MAX_SERVICE_RADIUS_KM) shown on a seller's page, no per-store
 *     radius, the straight-line delivery check (inside / boundary / outside),
 *     and checkout rejecting an address outside it;
 *   - authorization: SELLER_MANAGE for every write and check.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ConfigKey,
  ErrorCode,
  PaymentMethod,
  UserRole,
  type CartDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { NEARBY, STORE_COORDS, configureTestMerchantUpi, seedAddress, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { getZonedParts } from '../../src/shared/datetime';
import { distanceKmExact } from '../../src/shared/distance';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** ~8 km south of STORE_COORDS (Sikar): inside 12 km, outside 5 km. */
const EIGHT_KM = { latitude: 27.5375, longitude: 75.1399 };

interface Availability {
  timezone: string;
  isActive: boolean;
  isAcceptingOrders: boolean;
  isOpenNow: boolean;
  acceptingOrdersNow: boolean;
  closedReason: string | null;
  hoursConfigured: boolean;
  hours: { dayOfWeek: number; opensAt: string; closesAt: string; isClosed: boolean }[];
  upcomingClosures: { id: string; date: string; reason: string | null }[];
}

interface DeliveryArea {
  latitude: number;
  longitude: number;
  areaConfigured: boolean;
  storeLocationSet: boolean;
  maxServiceRadiusKm: number | null;
  defaultRadiusKm: number;
  effectiveRadiusKm: number;
  radiusLimitKm: number;
}

interface DeliveryCheck {
  store: { latitude: number; longitude: number };
  distanceKm: number;
  effectiveRadiusKm: number;
  deliverable: boolean;
  insideRadius: boolean;
  insideServiceState: boolean;
  estimatedRoadDistanceKm: number;
  reason: string | null;
}

let seq = 0;

async function seedSeller(name = 'Sikar Kirana', point: { latitude: number; longitude: number } = STORE_COORDS) {
  seq += 1;
  const seller = await prisma.seller.create({
    data: {
      code: `ADMSTORE${seq}${randomUUID().slice(0, 4).toUpperCase()}`,
      name,
      sellerType: 'GROCERY',
      addressLine: 'Station Road',
      city: 'Sikar',
      district: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...point,
      timezone: 'Asia/Kolkata',
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  return seller.id;
}

async function panelUser(role: UserRole): Promise<{ token: string; userId: string }> {
  seq += 1;
  const email = `store-admin${seq}@adione.test`;
  const user = await prisma.user.create({
    data: { mobile: `00000003${String(seq).padStart(2, '0')}`, email, fullName: `Ops ${seq}`, passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return { token: expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken, userId: user.id };
}

const as = (token: string) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  put: (path: string, body: object) => api().put(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  delete: (path: string) => api().delete(`/api/v1${path}`).set('Authorization', bearer(token)),
});

const data = <T>(res: { body: unknown }) => expectSuccess<T>(res.body).data;

/** "HH:mm" of `now` shifted by `minutes`, in a timezone. */
function localTime(timezone: string, minutes: number): string {
  const parts = getZonedParts(new Date(Date.now() + minutes * 60_000), timezone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/** Today's date (YYYY-MM-DD) in a timezone. */
function localDate(timezone: string, days = 0): string {
  const parts = getZonedParts(new Date(Date.now() + days * 86_400_000), timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Every day open from an hour ago to an hour from now, in Asia/Kolkata. */
const openAroundNow = () =>
  Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    opensAt: localTime('Asia/Kolkata', -60),
    closesAt: localTime('Asia/Kolkata', 60),
    isClosed: false,
  }));

beforeEach(async () => {
  await truncateAll();
  invalidateCategoryCache();
  await configService.invalidateAll();
  await cache.clear();
  await configService.set({ key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: 12 as never });
});

/* -------------------------------------------------------------------------- */
/* authorization                                                              */
/* -------------------------------------------------------------------------- */

describe('authorization', () => {
  it('every admin store write and the delivery check need SELLER_MANAGE', async () => {
    const sellerId = await seedSeller();
    const staff = await panelUser(UserRole.STAFF);
    const customer = await loginAs('9400004001');

    const writes = (token: string) => [
      as(token).patch(`/admin/sellers/${sellerId}/availability`, { isAcceptingOrders: false }),
      as(token).put(`/admin/sellers/${sellerId}/hours`, { hours: openAroundNow() }),
      as(token).post(`/admin/sellers/${sellerId}/closures`, { date: localDate('Asia/Kolkata', 1) }),
      as(token).patch(`/admin/sellers/${sellerId}/delivery-area`, { maxServiceRadiusKm: 10 }),
      as(token).get(`/admin/sellers/${sellerId}/delivery-area`),
      as(token).get(`/admin/sellers/${sellerId}/delivery-check?lat=${NEARBY.latitude}&lng=${NEARBY.longitude}`),
      as(token).patch(`/admin/sellers/${sellerId}/location`, { ...STORE_COORDS, name: 'Renamed' }),
    ];
    for (const res of await Promise.all(writes(staff.token))) expect(res.status).toBe(403);
    for (const res of await Promise.all(writes(customer.accessToken))) expect(res.status).toBe(403);
    expect((await api().patch(`/api/v1/admin/sellers/${sellerId}/availability`).send({ isAcceptingOrders: false })).status).toBe(401);

    // Nothing changed.
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller).toMatchObject({ isAcceptingOrders: true, maxServiceRadiusKm: null, name: 'Sikar Kirana' });
    expect(await prisma.sellerHours.count({ where: { sellerId } })).toBe(0);
    expect(await prisma.sellerClosure.count({ where: { sellerId } })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* availability                                                               */
/* -------------------------------------------------------------------------- */

describe('availability controls', () => {
  it('admin switches Accepting Orders off and on: audited, and the cart marks the store closed', async () => {
    const sellerId = await seedSeller();
    const product = await seedProduct(sellerId, { pricePaise: 20000, stockQty: 10 });
    const admin = await panelUser(UserRole.ADMIN);
    await otpService.clearOtpState('9400004002');
    const shopper = await loginAs('9400004002');
    await as(shopper.accessToken).post('/cart/items', { sellerListingId: product.storeVariantId, qty: 1 }).expect(200);

    const closed = data<Availability>(await as(admin.token).patch(`/admin/sellers/${sellerId}/availability`, { isAcceptingOrders: false }).expect(200));
    expect(closed).toMatchObject({ isAcceptingOrders: false, isOpenNow: false, acceptingOrdersNow: false, closedReason: 'MANUALLY_CLOSED' });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller.store_close', entityId: sellerId } });
    expect(audit.actorUserId).toBe(admin.userId);

    const cart = data<CartDto>(await as(shopper.accessToken).get('/cart').expect(200));
    expect(cart.items[0]).toMatchObject({ available: false, unavailableReason: 'STORE_CLOSED' });

    const reopened = data<Availability>(await as(admin.token).patch(`/admin/sellers/${sellerId}/availability`, { isAcceptingOrders: true }).expect(200));
    expect(reopened).toMatchObject({ isAcceptingOrders: true, isOpenNow: true, closedReason: null });
    expect(data<CartDto>(await as(shopper.accessToken).get('/cart').expect(200)).items[0]).toMatchObject({ available: true });

    // Strict body: admin deactivation is not writable through this route.
    await as(admin.token).patch(`/admin/sellers/${sellerId}/availability`, { isAcceptingOrders: true, isActive: false }).expect(400);
  });

  it('weekly hours are read in the store\'s own timezone; an invalid timezone or time is refused', async () => {
    const sellerId = await seedSeller();
    const admin = await panelUser(UserRole.ADMIN);

    const open = data<Availability>(
      await as(admin.token).put(`/admin/sellers/${sellerId}/hours`, { hours: openAroundNow(), timezone: 'Asia/Kolkata' }).expect(200),
    );
    expect(open).toMatchObject({ hoursConfigured: true, isOpenNow: true, closedReason: null, timezone: 'Asia/Kolkata' });

    // The same clock times in New York (9.5–10.5 h behind) are hours away.
    const elsewhere = data<Availability>(
      await as(admin.token).put(`/admin/sellers/${sellerId}/hours`, { hours: openAroundNow(), timezone: 'America/New_York' }).expect(200),
    );
    expect(elsewhere).toMatchObject({ timezone: 'America/New_York', isOpenNow: false, closedReason: 'OUTSIDE_HOURS' });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller.update_hours', entityId: sellerId }, orderBy: { createdAt: 'desc' } });
    expect(audit.actorUserId).toBe(admin.userId);
    expect(audit.before).toMatchObject({ timezone: 'Asia/Kolkata' });
    expect(audit.after).toMatchObject({ timezone: 'America/New_York' });

    const bad = await as(admin.token).put(`/admin/sellers/${sellerId}/hours`, { hours: openAroundNow(), timezone: 'Mars/Olympus' }).expect(400);
    expect(expectError(bad.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    await as(admin.token).put(`/admin/sellers/${sellerId}/hours`, { hours: [{ dayOfWeek: 1, opensAt: '25:00', closesAt: '10:00', isClosed: false }] }).expect(400);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).timezone).toBe('America/New_York');
  });

  it('precedence: a manual close and a closure beat open hours; admin inactive beats the switch', async () => {
    const sellerId = await seedSeller();
    const admin = await panelUser(UserRole.ADMIN);
    const availability = async () => data<Availability>(await as(admin.token).get(`/admin/sellers/${sellerId}/availability`).expect(200));

    await as(admin.token).put(`/admin/sellers/${sellerId}/hours`, { hours: openAroundNow() }).expect(200);
    expect((await availability()).isOpenNow).toBe(true);

    // Closed today: a closure for the store's local date.
    const today = localDate('Asia/Kolkata');
    const withClosure = data<Availability>(
      await as(admin.token).post(`/admin/sellers/${sellerId}/closures`, { date: today, reason: 'Diwali' }).expect(200),
    );
    expect(withClosure).toMatchObject({ isOpenNow: false, closedReason: 'CLOSURE' });
    const closure = withClosure.upcomingClosures.find((c) => c.date === today)!;
    expect(closure.reason).toBe('Diwali');

    // The same date twice, or a past date, is refused.
    await as(admin.token).post(`/admin/sellers/${sellerId}/closures`, { date: today }).expect(409);
    await as(admin.token).post(`/admin/sellers/${sellerId}/closures`, { date: localDate('Asia/Kolkata', -2) }).expect(400);

    // Another seller's closure cannot be removed through this seller.
    const other = await seedSeller('Other Store');
    await as(admin.token).delete(`/admin/sellers/${other}/closures/${closure.id}`).expect(404);

    const removed = data<Availability>(await as(admin.token).delete(`/admin/sellers/${sellerId}/closures/${closure.id}`).expect(200));
    expect(removed).toMatchObject({ isOpenNow: true, closedReason: null });

    // Manual close beats open hours.
    await as(admin.token).patch(`/admin/sellers/${sellerId}/availability`, { isAcceptingOrders: false }).expect(200);
    expect(await availability()).toMatchObject({ isOpenNow: false, closedReason: 'MANUALLY_CLOSED' });

    // Admin deactivation beats the switch: switching it back ON does not reopen the store.
    await as(admin.token).patch(`/admin/sellers/${sellerId}/status`, { isActive: false, reason: 'Licence check pending' }).expect(200);
    await as(admin.token).patch(`/admin/sellers/${sellerId}/availability`, { isAcceptingOrders: true }).expect(200);
    expect(await availability()).toMatchObject({ isActive: false, isAcceptingOrders: true, isOpenNow: false, closedReason: 'SELLER_INACTIVE' });
  });

  it('the app-wide pause and its message stop orders even from a store whose hours say open', async () => {
    const sellerId = await seedSeller();
    const product = await seedProduct(sellerId, { pricePaise: 20000, stockQty: 10 });
    const admin = await panelUser(UserRole.ADMIN);
    await as(admin.token).put(`/admin/sellers/${sellerId}/hours`, { hours: openAroundNow() }).expect(200);
    await configureTestMerchantUpi();
    await otpService.clearOtpState('9400004003');
    const shopper = await loginAs('9400004003');
    const addressId = await seedAddress(shopper.userId);
    await as(shopper.accessToken).post('/cart/items', { sellerListingId: product.storeVariantId, qty: 1 }).expect(200);

    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_ENABLED, value: false }).expect(200);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: 'Back at 7 AM tomorrow.' }).expect(200);

    const pub = data<Record<string, unknown>>(await api().get('/api/v1/config/public').expect(200));
    expect(pub).toMatchObject({ ORDERING_ENABLED: false, ORDERING_PAUSED_MESSAGE: 'Back at 7 AM tomorrow.' });
    expect(data<Availability>(await as(admin.token).get(`/admin/sellers/${sellerId}/availability`).expect(200)).isOpenNow).toBe(true);

    const order = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(shopper.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.COD });
    expect(expectError(order.body)).toMatchObject({ code: ErrorCode.ORDERING_PAUSED });
    expect(expectError(order.body).message).toContain('Back at 7 AM tomorrow.');
    expect(await prisma.order.count()).toBe(0);

    // A message longer than 200 characters is refused.
    await as(admin.token).patch('/admin/config', { key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: 'x'.repeat(201) }).expect(400);
  });
});

/* -------------------------------------------------------------------------- */
/* identity and location                                                      */
/* -------------------------------------------------------------------------- */

describe('store name, address and map point', () => {
  it('saved together, read back with the last change, audited; invalid input changes nothing', async () => {
    const sellerId = await seedSeller('Sikar Kirana');
    const admin = await panelUser(UserRole.ADMIN);
    const moved = { latitude: 27.61234, longitude: 75.14321 };

    const saved = data<{ name: string; latitude: number; longitude: number; addressLine: string; landmark: string | null }>(
      await as(admin.token)
        .patch(`/admin/sellers/${sellerId}/location`, {
          name: 'Sikar Kirana & General Store',
          ...moved,
          addressLine: 'Shop 4, Station Road',
          locality: 'Bajaj Gram',
          city: 'Sikar',
          district: 'Sikar',
          state: 'Rajasthan',
          pincode: '332001',
          landmark: 'Near the clock tower',
        })
        .expect(200),
    );
    expect(saved).toMatchObject({ name: 'Sikar Kirana & General Store', ...moved, addressLine: 'Shop 4, Station Road', landmark: 'Near the clock tower' });

    const read = data<{ name: string; latitude: number; lastChange: { at: string; byName: string | null; byRole: string | null } | null }>(
      await as(admin.token).get(`/admin/sellers/${sellerId}/location`).expect(200),
    );
    expect(read).toMatchObject({ name: 'Sikar Kirana & General Store', latitude: moved.latitude });
    expect(read.lastChange).toMatchObject({ byRole: UserRole.ADMIN });
    expect(read.lastChange?.byName).toMatch(/^Ops /);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller.update_location', entityId: sellerId } });
    expect(audit.actorUserId).toBe(admin.userId);
    expect(audit.before).toMatchObject({ name: 'Sikar Kirana', latitude: STORE_COORDS.latitude });
    expect(audit.after).toMatchObject({ name: 'Sikar Kirana & General Store', latitude: moved.latitude });

    // The code never changes with the name.
    const row = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(row.code).toMatch(/^ADMSTORE/);

    // Out-of-range latitude, (0, 0), a one-letter name: refused, nothing saved.
    await as(admin.token).patch(`/admin/sellers/${sellerId}/location`, { latitude: 91, longitude: 75.1 }).expect(400);
    await as(admin.token).patch(`/admin/sellers/${sellerId}/location`, { latitude: 0, longitude: 0 }).expect(400);
    await as(admin.token).patch(`/admin/sellers/${sellerId}/location`, { ...moved, name: 'X' }).expect(400);
    expect(await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).toMatchObject({ name: 'Sikar Kirana & General Store', ...moved });
    expect(await prisma.auditLog.count({ where: { action: 'seller.update_location', entityId: sellerId } })).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* delivery area                                                              */
/* -------------------------------------------------------------------------- */

describe('delivery area — the admin service location and radius', () => {
  const setRadius = (token: string, km: number) => as(token).patch('/admin/config', { key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: km }).expect(200);

  it("shows the admin area (service location + MAX_SERVICE_RADIUS_KM) on every seller's page; a per-store radius can no longer be set", async () => {
    const sellerId = await seedSeller('Elsewhere Kirana', EIGHT_KM);
    const admin = await panelUser(UserRole.ADMIN);

    expect(data<DeliveryArea>(await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-area`).expect(200))).toMatchObject({
      // The service location (tests start with it at STORE_COORDS) — not the store's own point.
      ...STORE_COORDS,
      areaConfigured: true,
      storeLocationSet: true,
      defaultRadiusKm: 12,
      effectiveRadiusKm: 12,
      radiusLimitKm: 50,
    });

    const refused = await as(admin.token).patch(`/admin/sellers/${sellerId}/delivery-area`, { maxServiceRadiusKm: 10.5 });
    expect(refused.status).toBe(422);
    expect(expectError(refused.body).message).toMatch(/no longer have their own delivery radius/);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).maxServiceRadiusKm).toBeNull();

    // The admin radius has its limits, and is what every store shows.
    await as(admin.token).patch('/admin/config', { key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: 120 }).expect(400);
    await as(admin.token).patch('/admin/config', { key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: 0 }).expect(400);
    await setRadius(admin.token, 11);
    expect(data<DeliveryArea>(await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-area`).expect(200)).effectiveRadiusKm).toBe(11);
  });

  it('the delivery check: inside, exactly on the boundary, and outside the admin radius (straight line from the service location)', async () => {
    const sellerId = await seedSeller();
    const admin = await panelUser(UserRole.ADMIN);
    const check = async (point: { latitude: number; longitude: number }) =>
      data<DeliveryCheck>(await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-check?lat=${point.latitude}&lng=${point.longitude}`).expect(200));

    const near = await check(NEARBY);
    expect(near).toMatchObject({ deliverable: true, insideRadius: true, effectiveRadiusKm: 12, reason: null, store: STORE_COORDS });
    expect(near.distanceKm).toBeGreaterThan(2.9);
    expect(near.distanceKm).toBeLessThan(3.1);
    expect(near.estimatedRoadDistanceKm).toBeGreaterThan(near.distanceKm);

    // A radius of exactly the exact distance includes the point; a hair less excludes it.
    const exact = distanceKmExact(STORE_COORDS.latitude, STORE_COORDS.longitude, EIGHT_KM.latitude, EIGHT_KM.longitude);
    await setRadius(admin.token, exact);
    expect(await check(EIGHT_KM)).toMatchObject({ deliverable: true, insideRadius: true });
    await setRadius(admin.token, exact - 0.001);
    const outside = await check(EIGHT_KM);
    expect(outside).toMatchObject({ deliverable: false, insideRadius: false });
    expect(outside.reason).toMatch(/beyond the .* km delivery radius/);

    // Invalid destinations are refused.
    for (const [lat, lng] of [
      [91, 75],
      [0, 0],
      [27.6, 181],
    ]) {
      const res = await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-check?lat=${lat}&lng=${lng}`).expect(400);
      expect(expectError(res.body).code).toBe(ErrorCode.INVALID_COORDINATES);
    }
    await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-check?lat=abc&lng=75`).expect(400);
  });

  it("a store's own map point does not matter (even none); without a service location orders still go to approved villages (fee: first slab)", async () => {
    const sellerId = await seedSeller('Pinless Store', { latitude: 0, longitude: 0 });
    const admin = await panelUser(UserRole.ADMIN);
    await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-check?lat=${NEARBY.latitude}&lng=${NEARBY.longitude}`).expect(200);

    const product = await seedProduct(sellerId, { pricePaise: 20000, stockQty: 10 });
    await otpService.clearOtpState('9400004004');
    const shopper = await loginAs('9400004004');
    const addressId = await seedAddress(shopper.userId);
    await as(shopper.accessToken).post('/cart/items', { sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
    await as(shopper.accessToken).post('/checkout/quote', { addressId }).expect(200);

    // The admin clears the service location: no distance to measure, but the
    // approved village still decides — the fee falls back to the first slab.
    await configService.set({ key: ConfigKey.PLATFORM_LOCATION, value: {} as never });
    expect(data<DeliveryArea>(await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-area`).expect(200)).areaConfigured).toBe(false);
    await as(admin.token).get(`/admin/sellers/${sellerId}/delivery-check?lat=${NEARBY.latitude}&lng=${NEARBY.longitude}`).expect(422);
    await as(shopper.accessToken).post('/checkout/quote', { addressId }).expect(200);
  });

  it('the radius never refuses an approved village; disabling its pair does — the same for every store in the cart', async () => {
    await configureTestMerchantUpi();
    const near = await seedSeller('Near Store');
    const second = await seedSeller('Second Store', EIGHT_KM);
    const admin = await panelUser(UserRole.ADMIN);
    const [p1, p2] = [
      await seedProduct(near, { pricePaise: 20000, stockQty: 10 }),
      await seedProduct(second, { pricePaise: 20000, stockQty: 10 }),
    ];
    await otpService.clearOtpState('9400004005');
    const shopper = await loginAs('9400004005');
    const addressId = await seedAddress(shopper.userId, EIGHT_KM);
    for (const p of [p1!, p2!]) {
      await as(shopper.accessToken).post('/cart/items', { sellerListingId: p.storeVariantId, qty: 1 }).expect(200);
    }

    // 8 km from the service location, radius 12 km: the quote goes through.
    await as(shopper.accessToken).post('/checkout/quote', { addressId }).expect(200);

    // The admin shrinks the radius to 5 km: still delivered to — the village + PIN decide.
    await setRadius(admin.token, 5);
    await as(shopper.accessToken).post('/checkout/quote', { addressId }).expect(200);

    // The admin disables the address's village + PIN (Sikar 332001): refused.
    await as(admin.token)
      .patch('/admin/config', { key: ConfigKey.DELIVERY_LOCATIONS, value: [{ id: 'sikar', village: 'Sikar', pincode: '332001', active: false }] })
      .expect(200);
    const refused = await as(shopper.accessToken).post('/checkout/quote', { addressId });
    expect(expectError(refused.body)).toMatchObject({
      code: ErrorCode.OUT_OF_SERVICE_AREA,
      message: 'Sorry! Aadione is not delivering to Sikar 332001 yet. We are working to expand our service area.',
    });
    const order = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(shopper.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.COD });
    expect(expectError(order.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
    expect(await prisma.order.count()).toBe(0);

    await as(admin.token)
      .patch('/admin/config', { key: ConfigKey.DELIVERY_LOCATIONS, value: [{ id: 'sikar', village: 'Sikar', pincode: '332001', active: true }] })
      .expect(200);
    await as(shopper.accessToken).post('/checkout/quote', { addressId }).expect(200);
  });
});
