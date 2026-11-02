/**
 * Admin-approved delivery villages (Configuration DELIVERY_LOCATIONS), end to
 * end through the real app and database:
 *
 *   - the admin adds / edits / disables village + PIN pairs (CONFIG_WRITE);
 *     the app's dropdown list (GET /store/delivery-locations) shows only
 *     active villages, each with its own PIN codes;
 *   - approved village + its PIN → delivered to; approved village + another
 *     PIN, an unapproved village, or a disabled pair → refused — on address
 *     save, checkout quote and order placement, whatever the app sends;
 *   - the Home check decides by the pair when the app sends one.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, ErrorCode, PaymentMethod, UserRole, type AddressDto, type ServiceabilityResult } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { NEARBY, seedProduct, seedStore } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const MOBILE = '9400007001';

const PAIRS = [
  { id: 'kuraj', village: 'Kuraj', pincode: '313328', active: true },
  { id: 'charbhuja', village: 'Charbhuja', pincode: '313325', active: true },
  { id: 'kelwara', village: 'Kelwara', pincode: '313334', active: true },
  { id: 'amet', village: 'Amet', pincode: '313332', active: false },
];

let seq = 0;
async function panelUser(role: UserRole): Promise<string> {
  seq += 1;
  const email = `villages${seq}@adione.test`;
  await prisma.user.create({
    data: { mobile: `00000007${String(seq).padStart(2, '0')}`, email, fullName: `Ops ${seq}`, passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const as = (token: string) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
});

const address = (overrides: Record<string, unknown> = {}) => ({
  label: 'Home',
  fullName: 'Kamla Devi',
  mobile: '9876543210',
  area: 'Ward 4',
  city: 'Kuraj',
  district: 'Rajsamand',
  state: 'Rajasthan',
  pincode: '313328',
  ...NEARBY,
  locationSource: 'GPS',
  ...overrides,
});

const live = (overrides: Record<string, unknown> = {}) => ({
  ...NEARBY,
  accuracyM: 15,
  fullName: 'Ramesh Jat',
  mobile: '9829012345',
  city: 'Kuraj',
  state: 'Rajasthan',
  pincode: '313328',
  ...overrides,
});

const dropdowns = async () =>
  expectSuccess<{ villages: { village: string; pincodes: string[] }[] }>((await api().get('/api/v1/store/delivery-locations').expect(200)).body).data
    .villages;

async function shopper() {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, stockQty: 10 });
  await otpService.clearOtpState(MOBILE);
  const session = await loginAs(MOBILE);
  await as(session.accessToken).post('/cart/items', { sellerListingId: product.storeVariantId, qty: 1 }).expect(200);
  const order = (body: object) =>
    api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ paymentMethod: PaymentMethod.COD, ...body });
  return { token: session.accessToken, order };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await configService.set({ key: ConfigKey.DELIVERY_LOCATIONS, value: PAIRS as never });
});

describe('admin manages village + PIN pairs', () => {
  it('a new pair appears in the app list; the list shows only active villages, each with its own PINs, A–Z', async () => {
    expect(await dropdowns()).toEqual([
      { village: 'Charbhuja', pincodes: ['313325'] },
      { village: 'Kelwara', pincodes: ['313334'] },
      { village: 'Kuraj', pincodes: ['313328'] },
    ]);

    const admin = await panelUser(UserRole.ADMIN);
    await as(admin)
      .patch('/admin/config', {
        key: ConfigKey.DELIVERY_LOCATIONS,
        value: [...PAIRS, { id: 'railmagra', village: 'Railmagra', pincode: '313329', active: true }, { id: 'kuraj-2', village: 'Kuraj', pincode: '313301', active: true }],
      })
      .expect(200);
    expect(await dropdowns()).toEqual([
      { village: 'Charbhuja', pincodes: ['313325'] },
      { village: 'Kelwara', pincodes: ['313334'] },
      { village: 'Kuraj', pincodes: ['313301', '313328'] },
      { village: 'Railmagra', pincodes: ['313329'] },
    ]);

    // Enabling Amet shows it; disabling Kelwara hides it.
    await as(admin)
      .patch('/admin/config', {
        key: ConfigKey.DELIVERY_LOCATIONS,
        value: PAIRS.map((p) => (p.id === 'amet' ? { ...p, active: true } : p.id === 'kelwara' ? { ...p, active: false } : p)),
      })
      .expect(200);
    expect((await dropdowns()).map((v) => v.village)).toEqual(['Amet', 'Charbhuja', 'Kuraj']);
  });

  it('only CONFIG_WRITE can change the list; invalid lists are refused', async () => {
    const staff = await panelUser(UserRole.STAFF);
    expect((await as(staff).patch('/admin/config', { key: ConfigKey.DELIVERY_LOCATIONS, value: [] })).status).toBe(403);
    const admin = await panelUser(UserRole.ADMIN);
    await as(admin)
      .patch('/admin/config', { key: ConfigKey.DELIVERY_LOCATIONS, value: [{ id: 'x', village: 'Kuraj', pincode: '3133', active: true }] })
      .expect(400);
    expect((await dropdowns()).length).toBe(3);
  });
});

describe('the approved pair decides delivery', () => {
  it('approved village + its PIN: saved as deliverable (the admin spelling kept) and ordered to', async () => {
    const { token, order } = await shopper();
    const saved = expectSuccess<AddressDto>((await as(token).post('/addresses', address({ city: ' kuraj ' })).expect(201)).body).data;
    expect(saved).toMatchObject({ city: 'Kuraj', pincode: '313328', isServiceable: true });
    await order({ addressId: saved.id }).expect(201);
  });

  it('approved village with a wrong PIN, an unapproved village, a disabled pair: refused on save, nothing saved', async () => {
    const { token } = await shopper();
    for (const [body, reason] of [
      [address({ pincode: '313325' }), /only with its own PIN code/],
      [address({ city: 'Deogarh', pincode: '313331' }), /not delivering to Deogarh 313331/],
      [address({ city: 'Amet', pincode: '313332' }), /not delivering to Amet 313332/],
    ] as const) {
      const res = await as(token).post('/addresses', body);
      expect(res.status).toBe(422);
      expect(expectError(res.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
      expect(expectError(res.body).message).toMatch(reason);
    }
    expect(await prisma.address.count()).toBe(0);
  });

  it('live locations: the same rule at quote and order; a manipulated pair is refused, nothing ordered', async () => {
    const { token, order } = await shopper();
    await as(token).post('/checkout/quote', { liveLocation: live() }).expect(200);
    for (const tampered of [live({ pincode: '313325' }), live({ city: 'Deogarh', pincode: '313331' }), live({ city: 'Amet', pincode: '313332' }), live({ pincode: undefined })]) {
      const quote = await as(token).post('/checkout/quote', { liveLocation: tampered });
      expect(quote.status).toBe(422);
      const placed = await order({ liveLocation: tampered });
      expect(placed.status).toBe(422);
      expect(expectError(placed.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
    }
    expect(await prisma.order.count()).toBe(0);
    await order({ liveLocation: live() }).expect(201);
    expect((await prisma.order.findFirstOrThrow()).deliveryCity).toBe('Kuraj');
  });

  it('a saved address whose pair the admin later disables is refused at checkout and listed as not deliverable', async () => {
    const { token, order } = await shopper();
    const saved = expectSuccess<AddressDto>((await as(token).post('/addresses', address()).expect(201)).body).data;
    await configService.set({ key: ConfigKey.DELIVERY_LOCATIONS, value: PAIRS.map((p) => (p.id === 'kuraj' ? { ...p, active: false } : p)) as never });
    const listed = expectSuccess<AddressDto[]>((await as(token).get('/addresses').expect(200)).body).data;
    expect(listed[0]).toMatchObject({ id: saved.id, isServiceable: false });
    const res = await order({ addressId: saved.id });
    expect(res.status).toBe(422);
    expect(await prisma.order.count()).toBe(0);
  });
});

describe('the Home check with the location\'s village + PIN', () => {
  const check = async (query: string) =>
    expectSuccess<ServiceabilityResult>((await api().get(`/api/v1/store/serviceability?lat=${NEARBY.latitude}&lng=${NEARBY.longitude}${query}`).expect(200)).body).data;

  it('approved: available; wrong PIN / unapproved / disabled: not delivering, with the reason; none sent: the radius hint', async () => {
    await seedStore();
    expect(await check('&village=Kuraj&pincode=313328')).toMatchObject({ serviceable: true, status: 'AVAILABLE', canOrder: true });
    const wrongPin = await check('&village=Kuraj&pincode=313325');
    expect(wrongPin).toMatchObject({ serviceable: false, status: 'OUTSIDE_RADIUS', canOrder: false });
    expect(wrongPin.message).toMatch(/only with its own PIN code/);
    expect((await check('&village=Deogarh&pincode=313331')).message).toMatch(/not delivering to Deogarh 313331/);
    expect((await check('&village=Amet&pincode=313332')).canOrder).toBe(false);
    // An older app sends no village: the admin radius around the service location is the hint.
    expect((await check('')).status).toBe('AVAILABLE');
  });
});
