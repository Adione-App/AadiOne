/**
 * Phase 3 — serviceability and store-hours integration tests.
 *
 * These exercise the real configuration table, so they also prove that
 * MAX_SERVICE_RADIUS_KM is genuinely read from configuration rather than
 * hardcoded: the same coordinates flip decision when the config row changes.
 *
 * V2: "the store" is the platform-owned Seller row (see seller.service.ts's
 * own scope note) — `/store*` routes are kept for the customer app's existing
 * single-seller grocery experience, but everything underneath is Seller /
 * SellerHours / SellerClosure now.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, ErrorCode } from '../../src/shared';
import { api, expectError, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as sellerService from '../../src/modules/sellers/seller.service';
import { sellerLifecycleFields } from '../helpers/fixtures';

// Sikar, matching the seed.
const STORE = { latitude: 27.6094, longitude: 75.1399 };
const NEARBY = { lat: 27.6364, lng: 75.1399 }; // ~3 km north
const FAR = { lat: 26.9124, lng: 75.7873 }; // Jaipur, ~100 km

async function createStore(overrides: Record<string, unknown> = {}): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: 'TEST-STORE',
      name: 'Test Store',
      isPlatformOwned: true,
      ...sellerLifecycleFields('APPROVED'),
      addressLine: 'Main Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: STORE.latitude,
      longitude: STORE.longitude,
      timezone: 'Asia/Kolkata',
      isActive: true,
      ...overrides,
    },
  });

  // Open 08:00-22:00 every day, as in the mockup.
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      sellerId: seller.id,
      dayOfWeek,
      opensAt: '08:00',
      closesAt: '22:00',
      isClosed: false,
    })),
  });

  return seller.id;
}

async function setConfig(key: Parameters<typeof configService.set>[0]['key'], value: never) {
  await configService.set({ key, value });
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
});

describe('GET /store/serviceability', () => {
  it('reports a nearby location as serviceable with distance, ETA and fee', async () => {
    await createStore();
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 10 as never);

    const res = await api()
      .get('/api/v1/store/serviceability')
      .query({ lat: NEARBY.lat, lng: NEARBY.lng })
      .expect(200);

    const data = expectSuccess<{
      serviceable: boolean;
      distanceKm: number;
      maxRadiusKm: number;
      etaMinutes: number | null;
      deliveryFeePaise: number | null;
    }>(res.body).data;

    expect(data.serviceable).toBe(true);
    expect(data.distanceKm).toBeGreaterThan(2.5);
    expect(data.distanceKm).toBeLessThan(3.5);
    expect(data.maxRadiusKm).toBe(10);
    expect(data.etaMinutes).toBeGreaterThan(0);
    expect(data.deliveryFeePaise).toBeGreaterThan(0);
  });

  it('reports a distant location as not serviceable and withholds ETA and fee', async () => {
    await createStore();
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 10 as never);

    const res = await api()
      .get('/api/v1/store/serviceability')
      .query({ lat: FAR.lat, lng: FAR.lng })
      .expect(200);

    const data = expectSuccess<{
      serviceable: boolean;
      distanceKm: number;
      etaMinutes: number | null;
      deliveryFeePaise: number | null;
    }>(res.body).data;

    expect(data.serviceable).toBe(false);
    expect(data.distanceKm).toBeGreaterThan(90);
    // Null rather than a number the UI might render beside "we don't deliver here".
    expect(data.etaMinutes).toBeNull();
    expect(data.deliveryFeePaise).toBeNull();
  });

  it('honours MAX_SERVICE_RADIUS_KM from configuration, not a constant', async () => {
    await createStore();

    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 10 as never);
    const wide = await api()
      .get('/api/v1/store/serviceability')
      .query({ lat: NEARBY.lat, lng: NEARBY.lng })
      .expect(200);
    expect(expectSuccess<{ serviceable: boolean }>(wide.body).data.serviceable).toBe(true);

    // Shrink the radius in the database — the SAME coordinates must now fail.
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 1 as never);
    const narrow = await api()
      .get('/api/v1/store/serviceability')
      .query({ lat: NEARBY.lat, lng: NEARBY.lng })
      .expect(200);
    expect(expectSuccess<{ serviceable: boolean; maxRadiusKm: number }>(narrow.body).data)
      .toMatchObject({ serviceable: false, maxRadiusKm: 1 });
  });

  it('lets a per-store radius override the global configuration', async () => {
    await createStore({ maxServiceRadiusKm: 2 });
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 10 as never);

    const res = await api()
      .get('/api/v1/store/serviceability')
      .query({ lat: NEARBY.lat, lng: NEARBY.lng })
      .expect(200);

    expect(expectSuccess<{ serviceable: boolean; maxRadiusKm: number }>(res.body).data)
      .toMatchObject({ serviceable: false, maxRadiusKm: 2 });
  });

  it('prices delivery from the ROAD distance, not the straight line', async () => {
    await createStore();
    await setConfig(ConfigKey.MAX_SERVICE_RADIUS_KM, 10 as never);
    await setConfig(ConfigKey.ROAD_DISTANCE_FACTOR, 1.3 as never);
    await setConfig(
      ConfigKey.DELIVERY_FEE_SLABS,
      [
        { maxKm: 3, feePaise: 2000 },
        { maxKm: 6, feePaise: 3000 },
        { maxKm: 10, feePaise: 4000 },
      ] as never,
    );

    // ~3.0 km straight line -> ~3.9 km road -> the SECOND slab, not the first.
    const res = await api()
      .get('/api/v1/store/serviceability')
      .query({ lat: NEARBY.lat, lng: NEARBY.lng })
      .expect(200);

    expect(expectSuccess<{ deliveryFeePaise: number }>(res.body).data.deliveryFeePaise)
      .toBe(3000);
  });

  it('rejects a failed GPS fix rather than reporting "out of area"', async () => {
    await createStore();
    // Android returns 0,0 on a failed fix; blaming the customer's location
    // would be misleading, so it is treated as invalid input.
    const res = await api().get('/api/v1/store/serviceability').query({ lat: 0, lng: 0 });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects missing or non-numeric coordinates', async () => {
    await createStore();
    expect((await api().get('/api/v1/store/serviceability')).status).toBe(400);
    expect(
      (await api().get('/api/v1/store/serviceability').query({ lat: 'abc', lng: 'def' })).status,
    ).toBe(400);
  });

  it('works without authentication', async () => {
    // A customer outside the delivery area must not have to create an account
    // just to be told we do not deliver to them.
    await createStore();
    await api()
      .get('/api/v1/store/serviceability')
      .query({ lat: NEARBY.lat, lng: NEARBY.lng })
      .expect(200);
  });
});

describe('store opening hours', () => {
  it('reports open during trading hours in the store timezone', async () => {
    const sellerId = await createStore();
    const seller = (await prisma.seller.findUniqueOrThrow({
      where: { id: sellerId },
      include: { hours: true },
    })) as never;

    // 12:30 IST on a Wednesday = 07:00 UTC.
    const middayIst = new Date('2026-08-12T07:00:00.000Z');
    const state = await sellerService.getSellerOpenState(seller, middayIst);
    expect(state.isOpen).toBe(true);
    expect(state.todayOpensAt).toBe('08:00');
  });

  it('reports closed outside trading hours and says when it opens next', async () => {
    const sellerId = await createStore();
    const seller = (await prisma.seller.findUniqueOrThrow({
      where: { id: sellerId },
      include: { hours: true },
    })) as never;

    // 05:00 IST = 23:30 UTC the previous day. Evaluating this in UTC would
    // wrongly report the store as open.
    const earlyMorningIst = new Date('2026-08-11T23:30:00.000Z');
    const state = await sellerService.getSellerOpenState(seller, earlyMorningIst);

    expect(state.isOpen).toBe(false);
    expect(state.nextOpenText).toMatch(/Opens today at 8:00 AM/);
  });

  it('treats a recorded closure as shut for the whole day', async () => {
    const sellerId = await createStore();
    await prisma.sellerClosure.create({
      data: { sellerId, closedOn: new Date('2026-08-12T00:00:00.000Z'), reason: 'Holiday' },
    });

    const seller = (await prisma.seller.findUniqueOrThrow({
      where: { id: sellerId },
      include: { hours: true },
    })) as never;

    const middayIst = new Date('2026-08-12T07:00:00.000Z');
    const state = await sellerService.getSellerOpenState(seller, middayIst);
    expect(state.isOpen).toBe(false);
  });

  it('blocks order placement while closed, unless configured otherwise', async () => {
    const sellerId = await createStore();
    const seller = (await prisma.seller.findUniqueOrThrow({
      where: { id: sellerId },
      include: { hours: true },
    })) as never;
    const earlyMorningIst = new Date('2026-08-11T23:30:00.000Z');

    await expect(
      sellerService.assertSellerAcceptingOrders(seller, earlyMorningIst),
    ).rejects.toMatchObject({ code: ErrorCode.SELLER_CLOSED });

    // The override is configuration, not a code branch.
    await setConfig(ConfigKey.ALLOW_ORDERS_WHEN_CLOSED, true as never);
    await expect(
      sellerService.assertSellerAcceptingOrders(seller, earlyMorningIst),
    ).resolves.toBeUndefined();
  });
});

describe('GET /store', () => {
  it('returns store details and whether it is open now', async () => {
    await createStore();
    const res = await api().get('/api/v1/store').expect(200);

    const data = expectSuccess<{
      name: string;
      city: string;
      timezone: string;
      isOpenNow: boolean;
      todayHours: { opensAt: string } | null;
    }>(res.body).data;

    expect(data.name).toBe('Test Store');
    expect(data.city).toBe('Sikar');
    expect(data.timezone).toBe('Asia/Kolkata');
    expect(typeof data.isOpenNow).toBe('boolean');
    expect(data.todayHours?.opensAt).toBe('08:00');
  });

  it('reports service unavailable when no active store exists', async () => {
    const res = await api().get('/api/v1/store');
    expect(res.status).toBe(503);
    expect(expectError(res.body).code).toBe(ErrorCode.SELLER_INACTIVE);
  });
});
