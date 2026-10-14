/**
 * Addresses, coordinates and distance, end to end (real app and database):
 * structured Indian addresses (village / city, district, state, PIN), where a
 * point came from, coordinate validation (swapped, (0, 0), outside India),
 * edits that move an address, older addresses, the radius boundary, the
 * seller's store point, and the chosen address in the order snapshot.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, PaymentMethod, UserRole, type AddressDto, type ServiceabilityResult } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { NEARBY, STORE_COORDS, seedProduct, seedStore, sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

async function customer(mobile: string) {
  await otpService.clearOtpState(mobile);
  return loginAs(mobile);
}

/** km due north of the store, as a latitude (1° of latitude ≈ 111.195 km on the IUGG sphere). */
const northOfStore = (km: number) => ({ latitude: STORE_COORDS.latitude + km / 111.19508, longitude: STORE_COORDS.longitude });

const RURAL = {
  label: 'Home',
  fullName: 'Kamla Devi',
  mobile: '9876543210',
  houseNo: null,
  street: null,
  area: 'Gujar Mohalla',
  city: 'Palsana', // a village / town
  district: 'Sikar',
  state: 'Rajasthan',
  pincode: '332402',
  landmark: 'Near the government school',
  ...NEARBY,
  locationSource: 'GPS',
  locationAccuracyM: 18,
};

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('structured addresses', () => {
  it('saves a rural village address and an urban one with district, state, PIN and the point’s origin', async () => {
    await seedStore();
    const session = await customer('9400002001');
    const rural = expectSuccess<AddressDto>((await as(session.accessToken).post('/addresses', RURAL).expect(201)).body).data;
    expect(rural).toMatchObject({ area: 'Gujar Mohalla', city: 'Palsana', district: 'Sikar', state: 'Rajasthan', pincode: '332402', locationSource: 'GPS', locationAccuracyM: 18 });
    expect(rural.latitude).toBe(NEARBY.latitude);
    expect(rural.isServiceable).toBe(true);

    const urban = expectSuccess<AddressDto>(
      (
        await as(session.accessToken)
          .post('/addresses', { ...RURAL, label: 'Work', houseNo: '12', street: 'Station Road', area: 'Shastri Nagar', city: 'Sikar', district: 'Sikar', locationSource: 'GEOCODED', locationAccuracyM: 40 })
          .expect(201)
      ).body,
    ).data;
    // An accuracy radius only belongs to a device fix.
    expect(urban).toMatchObject({ city: 'Sikar', district: 'Sikar', locationSource: 'GEOCODED', locationAccuracyM: null });
    const row = await prisma.address.findUniqueOrThrow({ where: { id: rural.id } });
    expect(row).toMatchObject({ district: 'Sikar', locationSource: 'GPS', locationAccuracyM: 18 });
  });

  it('rejects swapped, (0, 0), out-of-range and outside-India points, and invalid PIN codes', async () => {
    await seedStore();
    const session = await customer('9400002002');
    const post = (body: object) => as(session.accessToken).post('/addresses', { ...RURAL, ...body });
    const swapped = await post({ latitude: NEARBY.longitude, longitude: NEARBY.latitude });
    expect(swapped.status).toBe(400);
    expect(JSON.stringify(expectError(swapped.body))).toMatch(/look swapped/);
    expect(JSON.stringify(expectError((await post({ latitude: 0, longitude: 0 })).body))).toMatch(/\(0, 0\)/);
    expect((await post({ latitude: 95, longitude: 200 })).status).toBe(400);
    expect(JSON.stringify(expectError((await post({ latitude: 51.5, longitude: -0.12 })).body))).toMatch(/outside India/);
    expect((await post({ latitude: Number.NaN })).status).toBe(400);
    expect((await post({ pincode: '012345' })).status).toBe(400);
    expect((await post({ pincode: '33240' })).status).toBe(400);
    expect((await post({ city: '' })).status).toBe(400);
    expect(await prisma.address.count()).toBe(0);
  });

  it('an edit that moves the address must bring its coordinates; the new point recomputes serviceability and its origin', async () => {
    await seedStore();
    const session = await customer('9400002003');
    const created = expectSuccess<AddressDto>((await as(session.accessToken).post('/addresses', RURAL).expect(201)).body).data;

    // Text moved, point not sent: refused, nothing changed.
    const refused = await as(session.accessToken).patch(`/addresses/${created.id}`, { area: 'Another Colony', pincode: '332001' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(expectError(refused.body))).toMatch(/confirm its location/);
    expect((await prisma.address.findUniqueOrThrow({ where: { id: created.id } })).area).toBe('Gujar Mohalla');

    // Moved with a new (far) point: re-evaluated, origin replaced.
    const far = northOfStore(60);
    const moved = expectSuccess<AddressDto>(
      (await as(session.accessToken).patch(`/addresses/${created.id}`, { area: 'Another Colony', ...far, locationSource: 'GEOCODED' }).expect(200)).body,
    ).data;
    expect(moved).toMatchObject({ area: 'Another Colony', latitude: far.latitude, isServiceable: false, locationSource: 'GEOCODED', locationAccuracyM: null });
    expect(moved.distanceKm).toBeGreaterThan(59);

    // A label-only edit keeps the point and where it came from.
    const relabelled = expectSuccess<AddressDto>((await as(session.accessToken).patch(`/addresses/${created.id}`, { label: 'Other' }).expect(200)).body).data;
    expect(relabelled).toMatchObject({ label: 'Other', latitude: far.latitude, locationSource: 'GEOCODED' });
  });

  it('older addresses without a district or a recorded origin still list, show and edit — nothing is invented', async () => {
    await seedStore();
    const session = await customer('9400002004');
    const legacy = await prisma.address.create({
      data: { userId: session.userId, label: 'Home', fullName: 'Old Customer', mobile: '9876543210', area: 'Main Road', city: 'Sikar', state: 'Rajasthan', pincode: '332001', ...NEARBY, isDefault: true },
    });
    const listed = expectSuccess<AddressDto[]>((await as(session.accessToken).get('/addresses').expect(200)).body).data;
    expect(listed[0]).toMatchObject({ id: legacy.id, district: null, locationSource: null, locationAccuracyM: null, latitude: NEARBY.latitude });
    await as(session.accessToken).patch(`/addresses/${legacy.id}`, { label: 'Parents' }).expect(200);
    expect(await prisma.address.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ district: null, locationSource: null });
  });

  it('the app’s one House No. + Street field: an unchanged edit keeps both columns and the landmark; edited text is stored whole in street', async () => {
    await seedStore();
    const session = await customer('9400002005');
    const created = expectSuccess<AddressDto>(
      (await as(session.accessToken).post('/addresses', { ...RURAL, houseNo: '12', street: 'Station Road' }).expect(201)).body,
    ).data;
    // What the form sends on Save when the combined field was left as loaded:
    // no houseNo / street / landmark keys at all.
    const { houseNo: _h, street: _s, landmark: _l, ...withoutHouseStreet } = RURAL;
    const kept = expectSuccess<AddressDto>(
      (await as(session.accessToken).patch(`/addresses/${created.id}`, { ...withoutHouseStreet, fullName: 'Kamla Devi Jat' }).expect(200)).body,
    ).data;
    expect(kept).toMatchObject({ fullName: 'Kamla Devi Jat', houseNo: '12', street: 'Station Road', landmark: 'Near the government school' });

    // Edited: houseNo cleared, the whole text in street; the landmark still untouched.
    const edited = expectSuccess<AddressDto>(
      (
        await as(session.accessToken)
          .patch(`/addresses/${created.id}`, { ...withoutHouseStreet, houseNo: null, street: '14, Station Road' })
          .expect(200)
      ).body,
    ).data;
    expect(edited).toMatchObject({ houseNo: null, street: '14, Station Road', landmark: 'Near the government school' });
  });
});

describe('distance and the delivery radius', () => {
  it('decides on the exact distance and never shows a distance that contradicts the answer', async () => {
    await seedStore();
    const radius = expectSuccess<ServiceabilityResult>((await api().get(`/api/v1/store/serviceability?lat=${NEARBY.latitude}&lng=${NEARBY.longitude}`).expect(200)).body).data.maxRadiusKm;
    for (const km of [radius - 0.006, radius - 0.001, radius + 0.002, radius + 0.006]) {
      const point = northOfStore(km);
      const result = expectSuccess<ServiceabilityResult>((await api().get(`/api/v1/store/serviceability?lat=${point.latitude}&lng=${point.longitude}`).expect(200)).body).data;
      expect(result.serviceable, `${km} km`).toBe(km <= radius);
      if (result.serviceable) expect(result.distanceKm).toBeLessThanOrEqual(radius);
      else expect(result.distanceKm).toBeGreaterThan(radius);
    }
    // Swapped query coordinates are an error, not a far-away answer.
    expect((await api().get(`/api/v1/store/serviceability?lat=${NEARBY.longitude}&lng=${NEARBY.latitude}`)).status).toBe(400);
  });
});

describe('the seller’s store point', () => {
  it('takes locality, district and landmark, and refuses swapped or (0, 0) points', async () => {
    const seller = await prisma.seller.create({
      data: {
        code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Gaon Kirana',
        sellerType: 'GROCERY',
        addressLine: 'Shop 4, Bus Stand Road',
        city: 'Palsana',
        state: 'Rajasthan',
        pincode: '332402',
        latitude: 27.5,
        longitude: 75.2,
        isActive: true,
        ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      },
    });
    const user = await prisma.user.create({ data: { mobile: '9400002010', fullName: 'Owner', role: UserRole.SELLER_OWNER } });
    await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
    const token = (await customer('9400002010')).accessToken;

    const swapped = await as(token).patch('/seller/location', { latitude: 75.2, longitude: 27.5 });
    expect(swapped.status).toBe(400);
    expect(expectError(swapped.body).message).toMatch(/look swapped/);
    expect((await as(token).patch('/seller/location', { latitude: 0, longitude: 0 })).status).toBe(400);
    expect((await as(token).patch('/seller/location', { latitude: 27.51, longitude: 75.21, pincode: '032402' })).status).toBe(400);

    const saved = expectSuccess<{ locality: string; district: string; landmark: string; city: string; latitude: number }>(
      (await as(token).patch('/seller/location', { latitude: 27.51, longitude: 75.21, locality: 'Bus Stand', district: 'Sikar', landmark: 'Opposite the post office' }).expect(200)).body,
    ).data;
    expect(saved).toMatchObject({ locality: 'Bus Stand', district: 'Sikar', landmark: 'Opposite the post office', city: 'Palsana', latitude: 27.51 });
  });
});

describe('checkout', () => {
  it('orders to the CHOSEN address: the snapshot keeps its district and its own coordinates', async () => {
    const storeId = await seedStore();
    const session = await customer('9400002005');
    const product = await seedProduct(storeId, { pricePaise: 24900, mrpPaise: 28500, stockQty: 10 });
    // The default address, and a second one the customer picks.
    await as(session.accessToken).post('/addresses', { ...RURAL, isDefault: true }).expect(201);
    const pickedPoint = northOfStore(2);
    const picked = expectSuccess<AddressDto>(
      (await as(session.accessToken).post('/addresses', { ...RURAL, label: 'Work', area: 'Industrial Area', city: 'Sikar', district: 'Sikar', ...pickedPoint, isDefault: false }).expect(201)).body,
    ).data;

    await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId: picked.id, paymentMethod: PaymentMethod.COD });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const orderId = expectSuccess<{ order: { id: string } }>(placed.body).data.order.id;

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ addressId: picked.id, deliveryCity: 'Sikar', deliveryDistrict: 'Sikar', deliveryPincode: '332402', deliveryLatitude: picked.latitude, deliveryLongitude: picked.longitude });
    expect(order.distanceKm).toBeGreaterThanOrEqual(2);
    expect(order.distanceKm).toBeLessThan(2.05);

    // Editing the saved address later never rewrites the order.
    await as(session.accessToken).patch(`/addresses/${picked.id}`, { district: 'Jhunjhunu', ...northOfStore(3) }).expect(200);
    const detail = expectSuccess<{ deliveryAddress: AddressDto }>((await as(session.accessToken).get(`/orders/${orderId}`).expect(200)).body).data;
    expect(detail.deliveryAddress).toMatchObject({ district: 'Sikar', latitude: picked.latitude });
  });
});
