/**
 * Rajasthan-only operation, end to end (real app and database).
 *
 * The rule is checked on the POINT against Rajasthan's boundary — never on
 * the state text alone — for live locations, saved addresses (new, edited
 * and old ones), checkout quotes, order creation, the location lookup and
 * sellers' store points. The seller radius still applies inside Rajasthan.
 * Old out-of-state records are refused, never rewritten.
 *
 * Border fixture (Bhiwadi, RJ / Haryana): the boundary along 76.86° E is at
 * ≈28.22° N. A store at 28.205 (inside) is 3.3 km from 28.235 (Haryana) —
 * well within the 12 km radius, so only the state rule can refuse it.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, PaymentMethod, UserRole, type AddressDto, type ServiceabilityResult } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { FAR, NEARBY, seedProduct, seedStore, sellerLifecycleFields } from '../helpers/fixtures';

const MOBILE = '9876543210';
const BHIWADI_STORE = { latitude: 28.205, longitude: 76.86 };
const ACROSS_IN_HARYANA = { latitude: 28.235, longitude: 76.86 };
const JUST_INSIDE_BORDER = { latitude: 28.218, longitude: 76.86 };
const AHMEDABAD = { latitude: 23.03, longitude: 72.58 };

const live = (point: { latitude: number; longitude: number }, overrides: Record<string, unknown> = {}) => ({
  ...point,
  accuracyM: 15,
  fullName: 'Ramesh Jat',
  mobile: '9829012345',
  city: 'Bhiwadi',
  state: 'Rajasthan',
  ...overrides,
});

const savedBody = (point: { latitude: number; longitude: number }, overrides: Record<string, unknown> = {}) => ({
  label: 'Home',
  fullName: 'Kamla Devi',
  mobile: '9876543210',
  area: 'Gujar Mohalla',
  city: 'Sikar',
  district: 'Sikar',
  state: 'Rajasthan',
  pincode: '332001',
  ...point,
  locationSource: 'GPS',
  locationAccuracyM: 12,
  ...overrides,
});

/** A store (with one product in the customer's cart) at `storePoint`. */
async function setup(storePoint: { latitude: number; longitude: number } = { latitude: 27.6094, longitude: 75.1399 }) {
  const storeId = await seedStore();
  await prisma.seller.update({ where: { id: storeId }, data: storePoint });
  const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
  const session = await loginAs(MOBILE);
  await api()
    .post('/api/v1/cart/items')
    .set('Authorization', bearer(session.accessToken))
    .send({ sellerListingId: product.storeVariantId, qty: 1 })
    .expect(200);
  return { session, storeId };
}

const order = (token: string, body: object) =>
  api().post('/api/v1/orders').set('Authorization', bearer(token)).set('Idempotency-Key', randomUUID()).send({ paymentMethod: PaymentMethod.COD, ...body });
const quote = (token: string, body: object) => api().post('/api/v1/checkout/quote').set('Authorization', bearer(token)).send(body);
const serviceability = async (point: { latitude: number; longitude: number }) =>
  expectSuccess<ServiceabilityResult>((await api().get(`/api/v1/store/serviceability?lat=${point.latitude}&lng=${point.longitude}`).expect(200)).body).data;

function expectOutsideState(res: { status: number; body: unknown }, reason?: string): void {
  expect(res.status).toBe(422);
  const error = expectError(res.body);
  expect(error.code).toBe(ErrorCode.OUTSIDE_SERVICE_STATE);
  expect(error.message).toMatch(/only in Rajasthan/);
  if (reason) expect(JSON.stringify(error.details)).toContain(reason);
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(MOBILE);
  await cache.clear();
});

describe('live GPS locations', () => {
  it('a Rajasthan point inside the seller radius is accepted', async () => {
    const { session } = await setup(BHIWADI_STORE);
    const res = await order(session.accessToken, { liveLocation: live(BHIWADI_STORE) });
    expect(res.status).toBe(201);
    expect(await prisma.order.count()).toBe(1);
  });

  it('a point across the border is refused even though a seller 3 km away would deliver there', async () => {
    const { session } = await setup(BHIWADI_STORE);
    // The seller radius alone would allow it…
    const lookup = await serviceability(ACROSS_IN_HARYANA);
    expect(lookup.distanceKm).toBeLessThan(lookup.maxRadiusKm);
    // …but Aadione does not operate in Haryana.
    expect(lookup.serviceable).toBe(false);

    expectOutsideState(await quote(session.accessToken, { liveLocation: live(ACROSS_IN_HARYANA) }), 'OUTSIDE_STATE');
    expectOutsideState(await order(session.accessToken, { liveLocation: live(ACROSS_IN_HARYANA) }), 'OUTSIDE_STATE');
    expect(await prisma.order.count()).toBe(0);
  });

  it('the state text is not trusted: "Rajasthan" with an out-of-state point is refused', async () => {
    const { session } = await setup();
    expectOutsideState(await order(session.accessToken, { liveLocation: live(AHMEDABAD, { city: 'Ahmedabad' }) }), 'OUTSIDE_STATE');
    expect(await prisma.order.count()).toBe(0);
  });

  it('a Rajasthan point sent with another state is refused', async () => {
    const { session } = await setup();
    expectOutsideState(await order(session.accessToken, { liveLocation: live(NEARBY, { state: 'Gujarat', city: 'Sikar' }) }), 'STATE_NOT_SERVED');
  });

  it('a point too close to the border to confirm fails safe', async () => {
    const { session } = await setup(BHIWADI_STORE);
    expectOutsideState(await order(session.accessToken, { liveLocation: live(JUST_INSIDE_BORDER) }), 'NEAR_BORDER');
    expect((await serviceability(JUST_INSIDE_BORDER)).serviceable).toBe(false);
  });

  it('a Rajasthan point beyond the seller radius is still refused by the radius rule', async () => {
    const { session } = await setup(); // store at Sikar; FAR = Jaipur, ~100 km, in Rajasthan
    const res = await order(session.accessToken, { liveLocation: live(FAR, { city: 'Jaipur' }) });
    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
  });

  it('stores the state in its official spelling', async () => {
    const { session } = await setup(BHIWADI_STORE);
    await order(session.accessToken, { liveLocation: live(BHIWADI_STORE, { state: 'राजस्थान' }) }).expect(201);
    expect((await prisma.order.findFirstOrThrow()).deliveryState).toBe('Rajasthan');
  });
});

describe('saved addresses', () => {
  it('new addresses must be in Rajasthan — state AND point', async () => {
    await setup();
    const session = await loginAs(MOBILE);
    const post = (body: object) => api().post('/api/v1/addresses').set('Authorization', bearer(session.accessToken)).send(body);

    expectOutsideState(await post(savedBody(AHMEDABAD, { state: 'Gujarat', city: 'Ahmedabad', pincode: '380001' })));
    expectOutsideState(await post(savedBody(AHMEDABAD, { city: 'Ahmedabad', pincode: '380001' })), 'OUTSIDE_STATE');
    expectOutsideState(await post(savedBody(NEARBY, { state: 'Gujarat' })), 'STATE_NOT_SERVED');
    expect(await prisma.address.count()).toBe(0);

    const ok = expectSuccess<AddressDto>((await post(savedBody(NEARBY, { state: 'rajasthan' })).expect(201)).body).data;
    expect(ok).toMatchObject({ state: 'Rajasthan', isServiceable: true });
  });

  it('an older out-of-state address is refused for quotes, orders and edits — and never rewritten', async () => {
    const { session } = await setup();
    const legacy = await prisma.address.create({
      data: {
        userId: session.userId,
        label: 'Parents',
        fullName: 'Old Customer',
        mobile: '9876543210',
        area: 'Navrangpura',
        city: 'Ahmedabad',
        state: 'Gujarat',
        pincode: '380009',
        ...AHMEDABAD,
        isDefault: true,
        // Cached before the rule existed.
        isServiceable: true,
      },
    });
    const before = await prisma.address.findUniqueOrThrow({ where: { id: legacy.id } });

    // Listed, but never as deliverable.
    const listed = expectSuccess<AddressDto[]>((await api().get('/api/v1/addresses').set('Authorization', bearer(session.accessToken)).expect(200)).body).data;
    expect(listed[0]).toMatchObject({ id: legacy.id, state: 'Gujarat', isServiceable: false });

    expectOutsideState(await quote(session.accessToken, { addressId: legacy.id }));
    expectOutsideState(await order(session.accessToken, { addressId: legacy.id }));
    expectOutsideState(
      await api().patch(`/api/v1/addresses/${legacy.id}`).set('Authorization', bearer(session.accessToken)).send({ label: 'Mummy-Papa' }),
    );

    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.address.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(before);

    // It can still be deleted.
    await api().delete(`/api/v1/addresses/${legacy.id}`).set('Authorization', bearer(session.accessToken)).expect(204);
  });

  it('a Rajasthan saved address inside the radius orders as before', async () => {
    const { session } = await setup();
    const created = expectSuccess<AddressDto>(
      (await api().post('/api/v1/addresses').set('Authorization', bearer(session.accessToken)).send(savedBody(NEARBY)).expect(201)).body,
    ).data;
    await order(session.accessToken, { addressId: created.id }).expect(201);
  });
});

describe('sellers and admin cannot place a store outside Rajasthan', () => {
  async function loginAdmin(): Promise<string> {
    await prisma.user.create({
      data: { mobile: '0000000001', email: 'owner@adione.test', fullName: 'Admin', passwordHash: await hashPassword('TestAdmin@123'), role: UserRole.ADMIN },
    });
    const res = await api().post('/api/v1/auth/admin/login').send({ email: 'owner@adione.test', password: 'TestAdmin@123' }).expect(200);
    return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
  }

  it('admin seller creation refuses an out-of-state store', async () => {
    const token = await loginAdmin();
    const body = {
      name: 'Border Kirana',
      sellerType: 'GROCERY',
      addressLine: 'Main Bazar',
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380001',
      ...AHMEDABAD,
      ownerMobile: '9600000099',
      ownerFullName: 'Owner Name',
    };
    expectOutsideState(await api().post('/api/v1/admin/sellers').set('Authorization', bearer(token)).send(body));
    expectOutsideState(await api().post('/api/v1/admin/sellers').set('Authorization', bearer(token)).send({ ...body, state: 'Rajasthan' }), 'OUTSIDE_STATE');
    expect(await prisma.seller.count()).toBe(0);
  });

  it('a seller cannot move its store point outside Rajasthan', async () => {
    const seller = await prisma.seller.create({
      data: {
        code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Gaon Kirana',
        sellerType: 'GROCERY',
        addressLine: 'Bus Stand Road',
        city: 'Sikar',
        state: 'Rajasthan',
        pincode: '332001',
        latitude: 27.5,
        longitude: 75.2,
        isActive: true,
        ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      },
    });
    const user = await prisma.user.create({ data: { mobile: '9400004010', fullName: 'Owner', role: UserRole.SELLER_OWNER } });
    await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
    await otpService.clearOtpState('9400004010');
    const token = (await loginAs('9400004010')).accessToken;

    const patch = (body: object) => api().patch('/api/v1/seller/location').set('Authorization', bearer(token)).send(body);
    expectOutsideState(await patch(ACROSS_IN_HARYANA), 'OUTSIDE_STATE');
    expectOutsideState(await patch({ latitude: 27.51, longitude: 75.21, state: 'Haryana' }), 'STATE_NOT_SERVED');
    expect(await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } })).toMatchObject({ latitude: 27.5, state: 'Rajasthan' });

    await patch({ latitude: 27.51, longitude: 75.21 }).expect(200);
  });
});
