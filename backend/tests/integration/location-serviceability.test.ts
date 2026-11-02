/**
 * Live-location delivery eligibility (GET /store/serviceability + order
 * placement): the CURRENT point decides, by the admin-configured delivery
 * area — the service location (PLATFORM_LOCATION; the tests start with it at
 * STORE_COORDS, helpers/db.ts) and the radius (MAX_SERVICE_RADIUS_KM) — with
 * one status per reason, and placement checks it all again for the exact
 * destination the order uses.
 *
 * Covers: Home inside / Office outside (the same customer, a day apart), the
 * inclusive boundary, the radius coming from configuration (never hardcoded,
 * never a store's own), distance measured from the service location (never a
 * seller's point), no area configured, store closed, store not accepting,
 * app-wide ordering off, no eligible store, no hardcoded state, invalid
 * coordinates, client-sent eligibility ignored, placement revalidation, and
 * the immutable delivery snapshot + serving store.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, ErrorCode, PaymentMethod, type ServiceabilityResult } from '../../src/shared';
import { checkServiceability, distanceKmExact } from '../../src/shared/distance';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { NOT_DELIVERING_MESSAGE } from '../../src/modules/sellers/location-serviceability.service';
import { STORE_COORDS, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';

const MOBILE = '9400000921';
const KM_PER_DEG_LAT = 111.19492664455873; // the haversine's own (R = 6371 km)

/** A point `km` due north of the store. */
const north = (km: number, from = STORE_COORDS) => ({ latitude: from.latitude + km / KM_PER_DEG_LAT, longitude: from.longitude });

// Day 1 the customer is at Home, 1 km from the store; Day 2 at the Office, 5 km further.
const HOME = north(1);
const OFFICE = north(6);

let sellerSeq = 0;
async function createSeller(
  options: {
    at?: { latitude: number; longitude: number };
    radiusKm?: number | null;
    hours?: 'open' | 'closed';
    acceptingOrders?: boolean;
    name?: string;
  } = {},
): Promise<string> {
  sellerSeq += 1;
  const seller = await prisma.seller.create({
    data: {
      code: `LOC-${sellerSeq}`,
      name: options.name ?? `Store ${sellerSeq}`,
      isPlatformOwned: false,
      ...sellerLifecycleFields('APPROVED'),
      addressLine: 'Main Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...(options.at ?? STORE_COORDS),
      maxServiceRadiusKm: options.radiusKm ?? null,
      timezone: 'Asia/Kolkata',
      isActive: true,
      isAcceptingOrders: options.acceptingOrders ?? true,
    },
  });
  const closed = options.hours === 'closed';
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      sellerId: seller.id,
      dayOfWeek,
      opensAt: '00:00',
      closesAt: '00:00',
      isClosed: closed,
    })),
  });
  return seller.id;
}

function check(point: { latitude: number; longitude: number }, extra: Record<string, unknown> = {}) {
  return api().get('/api/v1/store/serviceability').query({ lat: point.latitude, lng: point.longitude, ...extra });
}

async function serviceability(point: { latitude: number; longitude: number }, extra: Record<string, unknown> = {}) {
  return expectSuccess<ServiceabilityResult>((await check(point, extra).expect(200)).body).data;
}

const setConfig = (key: Parameters<typeof configService.set>[0]['key'], value: unknown) =>
  configService.set({ key, value: value as never });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

const setRadius = (km: number) => setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, km);

describe('the current point decides — Home inside, Office outside', () => {
  it('Day 1 at Home: available; Day 2 at the Office (5 km away): not delivering, with the expansion message', async () => {
    await setRadius(3);
    await createSeller();

    const home = await serviceability(HOME);
    expect(home).toMatchObject({ serviceable: true, status: 'AVAILABLE', canOrder: true, message: null, maxRadiusKm: 3 });
    expect(home.distanceKm).toBeLessThanOrEqual(1.1);

    const office = await serviceability(OFFICE);
    expect(office).toMatchObject({ serviceable: false, status: 'OUTSIDE_RADIUS', canOrder: false, maxRadiusKm: 3 });
    expect(office.message).toBe(NOT_DELIVERING_MESSAGE);
    expect(office.message).toBe(
      'Sorry! Aadione is currently not delivering to your location. We are working to expand our service area.',
    );
    expect(office.distanceKm).toBeGreaterThan(3);

    // Back at Home: available again — nothing about the earlier answers is remembered.
    expect((await serviceability(HOME)).status).toBe('AVAILABLE');
  });
});

describe('the radius is the admin configuration — never hardcoded', () => {
  it('a store without its own radius follows MAX_SERVICE_RADIUS_KM; changing it flips the answer', async () => {
    await createSeller({ radiusKm: null });
    const point = north(7);
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 5);
    expect(await serviceability(point)).toMatchObject({ status: 'OUTSIDE_RADIUS', maxRadiusKm: 5 });
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 8);
    expect(await serviceability(point)).toMatchObject({ status: 'AVAILABLE', maxRadiusKm: 8 });
  });

  it("a store's own (old) radius is ignored — the admin radius applies to every store", async () => {
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 20);
    await createSeller({ radiusKm: 2 });
    expect(await serviceability(north(3))).toMatchObject({ status: 'AVAILABLE', maxRadiusKm: 20 });
  });

  it('the boundary is inclusive: distance == radius is inside, just beyond is outside', async () => {
    const point = north(4);
    const exact = distanceKmExact(point.latitude, point.longitude, STORE_COORDS.latitude, STORE_COORDS.longitude);
    expect(checkServiceability(point.latitude, point.longitude, STORE_COORDS.latitude, STORE_COORDS.longitude, exact).serviceable).toBe(true);
    expect(checkServiceability(point.latitude, point.longitude, STORE_COORDS.latitude, STORE_COORDS.longitude, exact - 0.001).serviceable).toBe(false);

    await setRadius(4);
    await createSeller();
    expect((await serviceability(north(3.999))).status).toBe('AVAILABLE');
    expect((await serviceability(north(4.02))).status).toBe('OUTSIDE_RADIUS');
  });
});

describe('the admin service location is the centre — never a seller\'s point', () => {
  it('the distance (and so the fee and ETA) is measured from the service location, wherever the stores are', async () => {
    await setRadius(10);
    await createSeller({ at: north(4), name: 'Store 4 km north' });
    const result = await serviceability(north(5));
    expect(result.status).toBe('AVAILABLE');
    expect(result.distanceKm).toBeGreaterThan(4.9); // 5 km from the service location, 1 km from the store
    expect(result.distanceKm).toBeLessThanOrEqual(5.01);
  });

  it('a point next to a store but outside the admin area is not served', async () => {
    await setRadius(3);
    await createSeller({ at: north(10), name: 'Store 10 km north' });
    expect((await serviceability(north(10))).status).toBe('OUTSIDE_RADIUS');
  });

  it('moving the service location moves the area', async () => {
    await setRadius(10);
    await createSeller();
    expect((await serviceability(north(5))).status).toBe('AVAILABLE');
    await setConfig(ConfigKey.PLATFORM_LOCATION, { name: 'New centre', addressLine: 'Far away', landmark: null, ...north(20) });
    const moved = await serviceability(north(5));
    expect(moved.status).toBe('OUTSIDE_RADIUS');
    expect(moved.distanceKm).toBeGreaterThan(14.9);
  });

  it('no service location set: nowhere is served, whatever stores exist', async () => {
    await createSeller();
    await setConfig(ConfigKey.PLATFORM_LOCATION, {});
    expect(await serviceability(HOME)).toMatchObject({ serviceable: false, status: 'NO_ELIGIBLE_STORE', canOrder: false });
  });
});

describe('store and app-wide state', () => {
  it('in range but every serving store closed by its hours: STORE_CLOSED', async () => {
    await createSeller({ radiusKm: 3, hours: 'closed' });
    const result = await serviceability(HOME);
    expect(result).toMatchObject({ serviceable: true, status: 'STORE_CLOSED', canOrder: false, sellerOpen: false });
    expect(result.message).toMatch(/closed right now/);
  });

  it('in range but every serving store switched orders off: STORE_NOT_ACCEPTING', async () => {
    await createSeller({ radiusKm: 3, acceptingOrders: false });
    const result = await serviceability(HOME);
    expect(result).toMatchObject({ serviceable: true, status: 'STORE_NOT_ACCEPTING', canOrder: false });
    expect(result.message).toMatch(/not taking orders/);
  });

  it('one closed and one open store in range: available', async () => {
    await createSeller({ radiusKm: 3, hours: 'closed' });
    await createSeller({ radiusKm: 3 });
    expect(await serviceability(HOME)).toMatchObject({ status: 'AVAILABLE', canOrder: true });
  });

  it('app-wide ordering off: ORDERING_DISABLED in range; outside the area still says outside', async () => {
    await setRadius(3);
    await createSeller();
    await setConfig(ConfigKey.ORDERING_ENABLED, false);
    const home = await serviceability(HOME);
    expect(home).toMatchObject({ serviceable: true, status: 'ORDERING_DISABLED', canOrder: false });
    expect(home.message).toBeTruthy();
    expect((await serviceability(OFFICE)).status).toBe('OUTSIDE_RADIUS');
  });

  it('no live store: NO_ELIGIBLE_STORE (an inactive store does not count; a store without a map point does — its point is not used)', async () => {
    expect(await serviceability(HOME)).toMatchObject({ serviceable: false, status: 'NO_ELIGIBLE_STORE', canOrder: false, message: NOT_DELIVERING_MESSAGE });
    const inactive = await createSeller();
    await prisma.seller.update({ where: { id: inactive }, data: { isActive: false } });
    expect((await serviceability(HOME)).status).toBe('NO_ELIGIBLE_STORE');
    await createSeller({ at: { latitude: 0, longitude: 0 } });
    expect((await serviceability(HOME)).status).toBe('AVAILABLE');
  });

  it('no state is hardcoded: a point across the state border, inside the admin area, is served', async () => {
    // Service location in Bhiwadi (Rajasthan); Dharuhera (Haryana) is ~6.5 km away.
    await setConfig(ConfigKey.PLATFORM_LOCATION, { name: 'Bhiwadi', addressLine: 'Bhiwadi', landmark: null, latitude: 28.2104, longitude: 76.8606 });
    await setRadius(10);
    await createSeller({ at: { latitude: 28.2104, longitude: 76.8606 } });
    expect(await serviceability({ latitude: 28.2062, longitude: 76.7953 })).toMatchObject({ serviceable: true, status: 'AVAILABLE' });
  });
});

describe('coordinates and client input', () => {
  it('rejects (0, 0), out-of-range and missing coordinates', async () => {
    await createSeller({ radiusKm: 3 });
    for (const query of [{ lat: 0, lng: 0 }, { lat: 91, lng: 75 }, { lat: 27, lng: 181 }, { lat: 'x', lng: 75 }, {}]) {
      const res = await api().get('/api/v1/store/serviceability').query(query);
      expect(res.status).toBe(400);
    }
  });

  it('ignores any distance or eligibility the client sends', async () => {
    await setRadius(3);
    await createSeller();
    const result = await serviceability(OFFICE, { distanceKm: 0.1, serviceable: 'true', canOrder: 'true', radiusKm: 50 });
    expect(result).toMatchObject({ serviceable: false, status: 'OUTSIDE_RADIUS', canOrder: false });
  });
});

describe('order placement checks the destination again', () => {
  const LIVE = {
    accuracyM: 15,
    fullName: 'Ramesh Jat',
    mobile: '9829012345',
    street: 'Station Road',
    city: 'Sikar',
    state: 'Rajasthan',
    pincode: '332001',
  };

  async function cartAt(sellerId: string) {
    await otpService.clearOtpState(MOBILE);
    const session = await loginAs(MOBILE);
    const product = await seedProduct(sellerId, { pricePaise: 20000, stockQty: 10 });
    await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
    const place = (body: object) =>
      api().post('/api/v1/orders').set('Authorization', bearer(session.accessToken)).set('Idempotency-Key', randomUUID()).send({ paymentMethod: PaymentMethod.COD, ...body });
    return { session, place };
  }

  it('an order is decided by its village + PIN, never by a stale answer or what the client claims', async () => {
    await setRadius(3);
    const sellerId = await createSeller();
    expect((await serviceability(HOME)).canOrder).toBe(true);
    const { place } = await cartAt(sellerId);
    const res = await place({ liveLocation: { ...LIVE, ...HOME, city: 'Laxmangarh', pincode: '332311', serviceable: true, distanceKm: 0.5 } });
    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
    expect(await prisma.order.count()).toBe(0);
  });

  it('a store that stops accepting after the location check: the order is refused at placement', async () => {
    const sellerId = await createSeller({ radiusKm: 3 });
    expect((await serviceability(HOME)).canOrder).toBe(true);
    const { place } = await cartAt(sellerId);
    await prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders: false } });
    const res = await place({ liveLocation: { ...LIVE, ...HOME } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.order.count()).toBe(0);
  });

  it('app-wide ordering switched off after the check: refused at placement', async () => {
    const sellerId = await createSeller({ radiusKm: 3 });
    const { place } = await cartAt(sellerId);
    await setConfig(ConfigKey.ORDERING_ENABLED, false);
    const res = await place({ liveLocation: { ...LIVE, ...HOME } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(expectError(res.body).code).toBe(ErrorCode.ORDERING_PAUSED);
    expect(await prisma.order.count()).toBe(0);
  });

  it('the placed order keeps its delivery point, address and serving store — moving or editing later changes nothing', async () => {
    await setRadius(3);
    const sellerId = await createSeller();
    const { session, place } = await cartAt(sellerId);
    const placed = expectSuccess<{ order: { id: string } }>((await place({ liveLocation: { ...LIVE, ...HOME } }).expect(201)).body).data.order;

    const before = await prisma.order.findUniqueOrThrow({ where: { id: placed.id }, include: { sellerOrders: true } });
    expect(before).toMatchObject({ deliveryMode: 'LIVE_LOCATION', deliveryLatitude: HOME.latitude, deliveryLongitude: HOME.longitude, deliveryCity: 'Sikar' });
    expect(before.sellerOrders.map((so) => so.sellerId)).toEqual([sellerId]);

    // The customer moves to the Office and saves an address there; the delivery radius shrinks.
    expect((await serviceability(OFFICE)).status).toBe('OUTSIDE_RADIUS');
    await api()
      .post('/api/v1/addresses')
      .set('Authorization', bearer(session.accessToken))
      .send({ label: 'Office', fullName: 'Ramesh Jat', mobile: '9829012345', area: 'Industrial Area', city: 'Sikar', state: 'Rajasthan', pincode: '332001', ...OFFICE });
    await setRadius(0.5);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: placed.id }, include: { sellerOrders: true } });
    expect(after.deliveryLatitude).toBe(before.deliveryLatitude);
    expect(after.deliveryLongitude).toBe(before.deliveryLongitude);
    expect(after.deliveryAddressLine).toBe(before.deliveryAddressLine);
    expect(after.deliveryMode).toBe(before.deliveryMode);
    expect(after.distanceKm).toBe(before.distanceKm);
    expect(after.sellerOrders.map((so) => so.sellerId)).toEqual([sellerId]);
  });
});
