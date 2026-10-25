/**
 * Regression, server side — the Kuraj / Railmagra case end to end through
 * the real app: a store at production's Railmagra point (25.029, 74.11), the
 * configured radius (12 km by default — never a hard-coded one here), and
 * addresses saved with:
 *   - the real Kuraj point (~5 km away)      → deliverable
 *   - a district-level fallback (~22 km)     → saved, not deliverable
 *   - no / (0, 0) coordinates                → refused, nothing saved
 *   - points either side of the radius       → decided on the exact distance
 * and the approved PIN list: it can only rule a PIN out, never in.
 * (The geocoder side — which results may become an address's point — is in
 * tests/unit/kuraj-geocode-radius.test.ts.)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, ErrorCode, type AddressDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedProduct, seedStore } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const STORE = { latitude: 25.029, longitude: 74.11 };
const KURAJ = { latitude: 25.0739038, longitude: 74.0988101 };
const RAJSAMAND_TOWN = { latitude: 25.0716, longitude: 73.8805 };
const MOBILE = '9400003001';

const KURAJ_ADDRESS = {
  label: 'Home',
  fullName: 'Kamla Devi',
  mobile: '9876543210',
  street: 'Ward 4',
  area: 'Kuraj',
  city: 'Kuraj',
  district: 'Rajsamand',
  state: 'Rajasthan',
  pincode: '313328',
  ...KURAJ,
  locationSource: 'GEOCODED',
};

const as = (token: string) => ({
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});
const north = (km: number) => ({ latitude: STORE.latitude + km / 111.19508, longitude: STORE.longitude });

let token: string;
let listingId: string;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  const storeId = await seedStore();
  await prisma.seller.update({ where: { id: storeId }, data: { ...STORE, city: 'Railmagra', district: 'Rajsamand', pincode: '313329' } });
  listingId = (await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 })).storeVariantId;
  await otpService.clearOtpState(MOBILE);
  token = (await loginAs(MOBILE)).accessToken;
});

const save = async (body: object) => expectSuccess<AddressDto>((await as(token).post('/addresses', body).expect(201)).body).data;

describe('Kuraj, ~5 km from the Railmagra store', () => {
  it('the real Kuraj point is deliverable, ~5 km away, inside the configured radius', async () => {
    const radius = await configService.get(ConfigKey.MAX_SERVICE_RADIUS_KM);
    const address = await save(KURAJ_ADDRESS);
    expect(address.isServiceable).toBe(true);
    expect(address.distanceKm).toBeGreaterThan(4.5);
    expect(address.distanceKm).toBeLessThan(6.5);
    expect(address.distanceKm!).toBeLessThan(radius);
    // The point and its origin are kept exactly as confirmed.
    expect(address).toMatchObject({ ...KURAJ, locationSource: 'GEOCODED', locationAccuracyM: null });
  });

  it('a wrong, district-level point (~22 km) is saved but not deliverable — the radius was never the problem', async () => {
    const address = await save({ ...KURAJ_ADDRESS, ...RAJSAMAND_TOWN });
    expect(address.isServiceable).toBe(false);
    expect(address.distanceKm!).toBeGreaterThan(20);
  });

  it('an address without usable coordinates is refused — nothing is saved, no default point is used', async () => {
    const { latitude: _lat, longitude: _lng, ...noPoint } = KURAJ_ADDRESS;
    await as(token).post('/addresses', noPoint).expect(400);
    expect(expectError((await as(token).post('/addresses', { ...KURAJ_ADDRESS, latitude: 0, longitude: 0 }).expect(400)).body).code).toBe(ErrorCode.VALIDATION_ERROR);
    await as(token).post('/addresses', { ...KURAJ_ADDRESS, latitude: KURAJ.longitude, longitude: KURAJ.latitude }).expect(400);
    expect(await prisma.address.count()).toBe(0);
  });

  it('radius boundary: just inside is deliverable, just outside is not; the shown km agrees', async () => {
    const radius = await configService.get(ConfigKey.MAX_SERVICE_RADIUS_KM);
    const inside = await save({ ...KURAJ_ADDRESS, ...north(radius - 0.005) });
    const outside = await save({ ...KURAJ_ADDRESS, label: 'Other', ...north(radius + 0.02) });
    expect(inside.isServiceable).toBe(true);
    expect(inside.distanceKm!).toBeLessThanOrEqual(radius);
    expect(outside.isServiceable).toBe(false);
    expect(outside.distanceKm!).toBeGreaterThan(radius);
  });
});

describe('approved PIN codes (SERVICEABLE_PINCODES)', () => {
  it('empty by default: the radius alone decides', async () => {
    expect(await configService.get(ConfigKey.SERVICEABLE_PINCODES)).toEqual([]);
    expect((await save(KURAJ_ADDRESS)).isServiceable).toBe(true);
  });

  it('a PIN not on the list is not delivered to — on save and at checkout — even 5 km from a store', async () => {
    await configService.set({ key: ConfigKey.SERVICEABLE_PINCODES, value: ['313329'] });
    const address = await save(KURAJ_ADDRESS);
    expect(address.isServiceable).toBe(false);

    await api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId: listingId, qty: 1 }).expect(200);
    const quote = await as(token).post('/checkout/quote', { addressId: address.id });
    expect(quote.status).toBe(422);
    expect(expectError(quote.body)).toMatchObject({ code: ErrorCode.OUT_OF_SERVICE_AREA, message: 'Sorry, we do not deliver to PIN code 313328 yet.' });
  });

  it('a listed PIN never makes a far address deliverable — the point and the radius still decide', async () => {
    await configService.set({ key: ConfigKey.SERVICEABLE_PINCODES, value: ['313328'] });
    expect((await save(KURAJ_ADDRESS)).isServiceable).toBe(true);
    expect((await save({ ...KURAJ_ADDRESS, label: 'Far', ...RAJSAMAND_TOWN })).isServiceable).toBe(false);
  });

  it('only a list of distinct 6-digit PIN codes can be configured', async () => {
    for (const bad of ['313328', ['31332'], ['313328', '313328'], [313328]]) {
      await expect(configService.set({ key: ConfigKey.SERVICEABLE_PINCODES, value: bad as never })).rejects.toThrow();
    }
  });
});
