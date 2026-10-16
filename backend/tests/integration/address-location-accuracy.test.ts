/**
 * Location accuracy, end to end (real app + database; no geocoding provider —
 * the app geocodes on the phone, the server decides on the point it is sent):
 *   - the same point from GPS or from a confirmed geocoded address gives the
 *     same distance and serviceability;
 *   - a geocoded point is stored as approximate (source GEOCODED, no accuracy);
 *   - an edit that names a different place cannot keep the old point;
 *   - store distance uses the store's real point, which an admin can correct
 *     (audited, validated).
 * Fixture points: Railmagra (Rajsamand) shop area 25.0290, 74.1096; Kuraj
 * village (PIN 313328) ~5 km north at 25.0745, 74.1010.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ConfigKey, UserRole, type AddressDto, type ServiceabilityResult } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { distanceKmExact } from '../../src/shared/distance';

const SHOP = { latitude: 25.029, longitude: 74.1096 };
const KURAJ = { latitude: 25.0745, longitude: 74.101 };

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

const ADDRESS = {
  label: 'Home',
  fullName: 'Kamla Devi',
  mobile: '9876543210',
  houseNo: null,
  street: 'Bus Stand Road',
  area: 'Teli Mohalla',
  city: 'Railmagra',
  district: 'Rajsamand',
  state: 'Rajasthan',
  pincode: '313329',
  landmark: null,
};

async function railmagraShop(): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: 'RAILMAGRASHOP',
      name: 'Railmagra Shop',
      sellerType: 'GROCERY',
      addressLine: 'Bus Stand',
      city: 'Railmagra',
      district: 'Rajsamand',
      state: 'Rajasthan',
      pincode: '313329',
      ...SHOP,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  return seller.id;
}

async function customer(mobile = '9400003001') {
  await otpService.clearOtpState(mobile);
  return loginAs(mobile);
}

let adminSeq = 0;
async function panelUser(role: UserRole): Promise<{ token: string; userId: string }> {
  adminSeq += 1;
  const email = `loc${adminSeq}@adione.test`;
  const user = await prisma.user.create({
    data: { mobile: `00000002${String(adminSeq).padStart(2, '0')}`, email, fullName: 'Ops', passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return { token: expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken, userId: user.id };
}

const serviceability = async (point: { latitude: number; longitude: number }) =>
  expectSuccess<ServiceabilityResult>((await api().get(`/api/v1/store/serviceability?lat=${point.latitude}&lng=${point.longitude}`).expect(200)).body).data;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await configService.set({ key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: 12 as never });
});

describe('GPS and a confirmed geocoded address for the same point', () => {
  it('give the same distance and serviceability; the geocoded one is stored as approximate', async () => {
    await railmagraShop();
    const session = await customer();
    const point = { latitude: 25.0331, longitude: 74.1128 }; // ~550 m from the shop
    const gps = expectSuccess<AddressDto>(
      (await as(session.accessToken).post('/addresses', { ...ADDRESS, ...point, locationSource: 'GPS', locationAccuracyM: 12 }).expect(201)).body,
    ).data;
    const typed = expectSuccess<AddressDto>(
      (
        await as(session.accessToken)
          .post('/addresses', { ...ADDRESS, label: 'Typed', ...point, locationSource: 'GEOCODED', locationAccuracyM: 12 })
          .expect(201)
      ).body,
    ).data;

    expect([typed.isServiceable, typed.distanceKm]).toEqual([gps.isServiceable, gps.distanceKm]);
    expect(gps.isServiceable).toBe(true);
    // The distance is the real Haversine distance to the shop's point (rounded up to 10 m).
    const exact = distanceKmExact(point.latitude, point.longitude, SHOP.latitude, SHOP.longitude);
    expect(gps.distanceKm).toBeGreaterThanOrEqual(exact);
    expect(gps.distanceKm).toBeLessThan(exact + 0.011);
    expect((await serviceability(point)).distanceKm).toBe(gps.distanceKm);

    // A geocoded point is never presented as precise: its accuracy is not kept.
    expect(gps).toMatchObject({ locationSource: 'GPS', locationAccuracyM: 12 });
    expect(typed).toMatchObject({ locationSource: 'GEOCODED', locationAccuracyM: null });
  });

  it('missing or invalid coordinates never produce a saved, serviceable address', async () => {
    await railmagraShop();
    const session = await customer();
    const { latitude: _lat, longitude: _lng, ...noPoint } = { ...ADDRESS, ...SHOP };
    expect((await as(session.accessToken).post('/addresses', noPoint)).status).toBe(400);
    for (const bad of [{ latitude: 0, longitude: 0 }, { latitude: 74.1096, longitude: 25.029 }, { latitude: 125, longitude: 74 }]) {
      expect((await as(session.accessToken).post('/addresses', { ...ADDRESS, ...bad, locationSource: 'GEOCODED' })).status).toBe(400);
    }
    expect(await prisma.address.count()).toBe(0);
  });
});

describe('editing an address', () => {
  it('cannot keep the old point when the village, district, state or PIN changes — the place must be confirmed again', async () => {
    await railmagraShop();
    const session = await customer();
    const saved = expectSuccess<AddressDto>(
      (await as(session.accessToken).post('/addresses', { ...ADDRESS, ...SHOP, locationSource: 'GPS', locationAccuracyM: 9 }).expect(201)).body,
    ).data;

    // The app echoes the old point with a new village: refused, nothing changes.
    for (const change of [{ city: 'Kuraj' }, { pincode: '313328' }, { district: 'Bhilwara' }]) {
      const res = await as(session.accessToken).patch(`/addresses/${saved.id}`, { ...change, latitude: saved.latitude, longitude: saved.longitude });
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.address.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({ city: 'Railmagra', pincode: '313329' });

    // House / street edits keep the point; spelling / spacing of the same village is no change.
    const street = await as(session.accessToken).patch(`/addresses/${saved.id}`, { street: 'Station Road', latitude: saved.latitude, longitude: saved.longitude });
    expect(street.status).toBe(200);
    const respelled = await as(session.accessToken).patch(`/addresses/${saved.id}`, { city: ' railmagra ', latitude: saved.latitude, longitude: saved.longitude });
    expect(respelled.status).toBe(200);
    expect(expectSuccess<AddressDto>(respelled.body).data).toMatchObject({ latitude: SHOP.latitude, locationSource: 'GPS', locationAccuracyM: 9 });

    // A new village WITH its newly confirmed point: saved, and serviceability recomputed for it.
    const moved = expectSuccess<AddressDto>(
      (
        await as(session.accessToken)
          .patch(`/addresses/${saved.id}`, { city: 'Kuraj', pincode: '313328', ...KURAJ, locationSource: 'GEOCODED' })
          .expect(200)
      ).body,
    ).data;
    expect(moved).toMatchObject({ city: 'Kuraj', pincode: '313328', latitude: KURAJ.latitude, locationSource: 'GEOCODED', locationAccuracyM: null });
    expect(moved.distanceKm).toBeGreaterThan(5);
    expect(moved.distanceKm).toBeLessThan(5.2);
  });
});

describe('the store point', () => {
  it('distance is measured to the store\'s own point; an admin can correct it — validated and audited', async () => {
    const shopId = await railmagraShop();
    const admin = await panelUser(UserRole.ADMIN);
    const staff = await panelUser(UserRole.STAFF);

    // From Kuraj the shop is ~5 km away; within the 12 km radius.
    const before = await serviceability(KURAJ);
    expect(before.serviceable).toBe(true);
    expect(before.distanceKm).toBeGreaterThan(5);

    // Staff (no SELLER_MANAGE) cannot move a store; (0, 0) and swapped points are refused.
    expect((await as(staff.token).patch(`/admin/sellers/${shopId}/location`, { latitude: 25.03, longitude: 74.11 })).status).toBe(403);
    expect((await as(admin.token).patch(`/admin/sellers/${shopId}/location`, { latitude: 0, longitude: 0 })).status).toBe(400);
    expect((await as(admin.token).patch(`/admin/sellers/${shopId}/location`, { latitude: 74.11, longitude: 25.03 })).status).toBe(400);

    // The admin moves the pin to where the shop really is: distance follows the new point.
    const corrected = expectSuccess<{ latitude: number; longitude: number }>(
      (await as(admin.token).patch(`/admin/sellers/${shopId}/location`, { ...KURAJ, city: 'Kuraj', pincode: '313328' }).expect(200)).body,
    ).data;
    expect(corrected).toMatchObject(KURAJ);
    const after = await serviceability(KURAJ);
    expect(after.distanceKm).toBeLessThan(0.02);
    const fetched = expectSuccess<{ latitude: number }>((await as(admin.token).get(`/admin/sellers/${shopId}/location`).expect(200)).body).data;
    expect(fetched.latitude).toBe(KURAJ.latitude);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller.update_location', entityId: shopId } });
    expect(audit.actorUserId).toBe(admin.userId);
    expect(audit.before).toMatchObject({ latitude: SHOP.latitude, longitude: SHOP.longitude });
    expect(audit.after).toMatchObject({ latitude: KURAJ.latitude, longitude: KURAJ.longitude });
  });
});
