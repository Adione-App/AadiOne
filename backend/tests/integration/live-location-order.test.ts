/**
 * Live-location orders, end to end (real app, real database, Cashfree faked
 * at the network only): an order delivered to the GPS point the customer is
 * at, with the details they confirmed, WITHOUT saving an address.
 *
 * Covers: complete and incomplete live details, coordinate validation, one
 * destination only, the same seller-radius check as saved addresses (and no
 * trust in client-sent distance/eligibility), the immutable snapshot, the
 * quote, COD and online payment, idempotent retries, and the saved-address
 * path still working exactly as before.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infra/payment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infra/payment')>();
  const fake = await import('../helpers/fake-cashfree');
  return {
    ...actual,
    payments: new actual.CashfreeProvider({
      appId: 'cf_test_app_id',
      secretKey: fake.FAKE_CASHFREE_SECRET,
      environment: 'SANDBOX',
      apiVersion: '2026-01-01',
      fetch: fake.sharedFakeCashfree.fetch,
    }),
    requiresManualPaymentConfirmation: () => false,
    allowsManualPaymentConfirmation: () => false,
  };
});

import { DeliveryMode, ErrorCode, OrderStatus, PaymentMethod, type CheckoutQuoteResponse, type OrderDetailDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { FAR, NEARBY, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9876543210';

/** Everything the app sends after reverse geocoding + the customer's edits. */
const LIVE_COMPLETE = {
  ...NEARBY,
  accuracyM: 12,
  fullName: 'Ramesh Jat',
  mobile: '+91 98290 12345',
  houseNo: null,
  street: '14, Station Road',
  area: 'Shastri Nagar',
  city: 'Sikar',
  district: 'Sikar',
  state: 'Rajasthan',
  pincode: '332001',
};

/** The customer did not know the house number, locality, district or PIN. */
const LIVE_MINIMAL = {
  ...NEARBY,
  accuracyM: 35,
  fullName: 'Sita Devi',
  mobile: '9414000001',
  city: 'Palsana',
  state: 'Rajasthan',
};

async function setup(stockQty = 10) {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty });
  const session = await loginAs(MOBILE);
  await api()
    .post('/api/v1/cart/items')
    .set('Authorization', bearer(session.accessToken))
    .send({ sellerListingId: product.storeVariantId, qty: 2 })
    .expect(200);
  return { session, listingId: product.storeVariantId };
}

const placeOrder = (token: string, body: object, key = randomUUID()) =>
  api().post('/api/v1/orders').set('Authorization', bearer(token)).set('Idempotency-Key', key).send(body);

const quote = (token: string, body: object) =>
  api().post('/api/v1/checkout/quote').set('Authorization', bearer(token)).send(body);

const orderDetail = async (token: string, orderId: string) =>
  expectSuccess<OrderDetailDto>((await api().get(`/api/v1/orders/${orderId}`).set('Authorization', bearer(token)).expect(200)).body).data;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(MOBILE);
  await cache.clear();
  cashfree.reset();
});

describe('live-location orders', () => {
  it('places a COD order at the GPS point with complete details — no address is saved', async () => {
    const { session } = await setup();
    const res = await placeOrder(session.accessToken, { liveLocation: LIVE_COMPLETE, paymentMethod: PaymentMethod.COD });
    expect(res.status).toBe(201);
    const { order, requiresPayment } = expectSuccess<{ order: OrderDetailDto; requiresPayment: boolean }>(res.body).data;

    expect(requiresPayment).toBe(false);
    expect(order.status).toBe(OrderStatus.PROCESSING);
    expect(order.deliveryMode).toBe(DeliveryMode.LIVE_LOCATION);
    expect(order.deliveryAddress).toMatchObject({
      id: '',
      label: 'Live location',
      fullName: 'Ramesh Jat',
      mobile: '9829012345', // normalised
      city: 'Sikar',
      district: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: NEARBY.latitude,
      longitude: NEARBY.longitude,
      locationSource: 'GPS',
      locationAccuracyM: 12,
    });
    expect(order.deliveryAddress.area).toContain('14, Station Road');
    expect(order.deliveryAddress.area).toContain('Shastri Nagar');

    const row = await prisma.order.findFirstOrThrow();
    expect(row).toMatchObject({
      deliveryMode: 'LIVE_LOCATION',
      addressId: null,
      deliveryLatitude: NEARBY.latitude,
      deliveryLongitude: NEARBY.longitude,
      deliveryLocationAccuracyM: 12,
      deliveryLandmark: null,
    });
    expect(row.distanceKm).toBeGreaterThan(0);
    // Not saved as a permanent address.
    expect(await prisma.address.count()).toBe(0);
  });

  it('accepts a live location whose house, locality, district and PIN the customer did not know', async () => {
    const { session } = await setup();
    const res = await placeOrder(session.accessToken, { liveLocation: LIVE_MINIMAL, paymentMethod: PaymentMethod.COD });
    expect(res.status).toBe(201);
    const order = expectSuccess<{ order: OrderDetailDto }>(res.body).data.order;
    expect(order.deliveryAddress).toMatchObject({ fullName: 'Sita Devi', mobile: '9414000001', city: 'Palsana', district: null, pincode: '' });
    // Nothing invented for the missing parts.
    const row = await prisma.order.findFirstOrThrow();
    // No house / street / locality: the line is empty, the town and state
    // have their own columns — and the point is what the rider goes to.
    expect(row).toMatchObject({
      deliveryAddressLine: '',
      deliveryCity: 'Palsana',
      deliveryState: 'Rajasthan',
      deliveryPincode: '',
      deliveryDistrict: null,
      deliveryLandmark: null,
      deliveryLatitude: NEARBY.latitude,
    });
  });

  it('rejects missing, invalid, (0, 0), swapped and outside-India coordinates — and bad details — without ordering', async () => {
    const { session } = await setup();
    const attempt = (live: object) => placeOrder(session.accessToken, { liveLocation: live, paymentMethod: PaymentMethod.COD });
    const { latitude: _lat, ...noLatitude } = LIVE_COMPLETE;

    expect((await attempt(noLatitude)).status).toBe(400);
    expect((await attempt({ ...LIVE_COMPLETE, latitude: '27.63' })).status).toBe(400);
    expect((await attempt({ ...LIVE_COMPLETE, latitude: 95, longitude: 200 })).status).toBe(400);
    expect(JSON.stringify(expectError((await attempt({ ...LIVE_COMPLETE, latitude: 0, longitude: 0 })).body))).toMatch(/\(0, 0\)/);
    expect(JSON.stringify(expectError((await attempt({ ...LIVE_COMPLETE, latitude: NEARBY.longitude, longitude: NEARBY.latitude })).body))).toMatch(/swapped/);
    expect(JSON.stringify(expectError((await attempt({ ...LIVE_COMPLETE, latitude: 51.5, longitude: -0.12 })).body))).toMatch(/outside India/);
    // Required details: recipient, a real mobile number, the village / town; a PIN only if valid.
    expect((await attempt({ ...LIVE_COMPLETE, fullName: '' })).status).toBe(400);
    expect((await attempt({ ...LIVE_COMPLETE, mobile: '12345' })).status).toBe(400);
    expect((await attempt({ ...LIVE_COMPLETE, city: '' })).status).toBe(400);
    expect((await attempt({ ...LIVE_COMPLETE, pincode: '012345' })).status).toBe(400);

    expect(await prisma.order.count()).toBe(0);
  });

  it('takes exactly one destination: a saved address OR a live location', async () => {
    const { session } = await setup();
    const addressId = await seedAddress(session.userId);
    const both = await placeOrder(session.accessToken, { addressId, liveLocation: LIVE_COMPLETE, paymentMethod: PaymentMethod.COD });
    expect(both.status).toBe(400);
    expect(JSON.stringify(expectError(both.body))).toMatch(/one delivery destination/);
    expect((await placeOrder(session.accessToken, { paymentMethod: PaymentMethod.COD })).status).toBe(400);
    expect((await quote(session.accessToken, {})).status).toBe(400);
    expect(await prisma.order.count()).toBe(0);
  });

  it('refuses an out-of-range live point with the seller radius rule — client-sent distance or eligibility is ignored', async () => {
    const { session, listingId } = await setup();
    const res = await placeOrder(session.accessToken, {
      liveLocation: { ...LIVE_COMPLETE, ...FAR, distanceKm: 0.2, serviceable: true, sellerId: randomUUID() },
      paymentMethod: PaymentMethod.COD,
    });
    expect(res.status).toBe(422);
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
    expect(error.message).toMatch(/does not deliver to this location/);
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: listingId } })).reservedQty).toBe(0);

    // The quote gives the same answer before the customer ever taps Pay.
    const quoted = await quote(session.accessToken, { liveLocation: { ...LIVE_COMPLETE, ...FAR } });
    expect(quoted.status).toBe(422);
    expect(expectError(quoted.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
  });

  it('quotes a live location exactly like the order it then places', async () => {
    const { session } = await setup();
    const quoted = expectSuccess<CheckoutQuoteResponse>((await quote(session.accessToken, { liveLocation: LIVE_COMPLETE }).expect(200)).body).data;
    expect(quoted.serviceability.serviceable).toBe(true);
    const placed = expectSuccess<{ order: OrderDetailDto }>(
      (
        await placeOrder(session.accessToken, {
          liveLocation: LIVE_COMPLETE,
          paymentMethod: PaymentMethod.COD,
          expectedTotalPaise: quoted.bill.totalPaise,
        }).expect(201)
      ).body,
    ).data.order;
    expect(placed.bill.totalPaise).toBe(quoted.bill.totalPaise);
    expect(placed.bill.deliveryFeePaise).toBe(quoted.bill.deliveryFeePaise);
  });

  it('a retried live order is ONE order; the same key with a different point is refused', async () => {
    const { session } = await setup();
    const key = randomUUID();
    const body = { liveLocation: LIVE_COMPLETE, paymentMethod: PaymentMethod.COD };
    const first = await placeOrder(session.accessToken, body, key);
    expect(first.status).toBe(201);

    // Retried the moment the first response arrived: the stored order is
    // replayed — never "still in progress", never a second order.
    const retry = await placeOrder(session.accessToken, body, key);
    expect(retry.status).toBe(201);
    expect(expectSuccess<{ order: { id: string } }>(retry.body).data.order.id).toBe(
      expectSuccess<{ order: { id: string } }>(first.body).data.order.id,
    );
    expect(await prisma.order.count()).toBe(1);

    const moved = await placeOrder(session.accessToken, { ...body, liveLocation: { ...LIVE_COMPLETE, latitude: NEARBY.latitude + 0.001 } }, key);
    expect(moved.status).toBe(409);
    expect(await prisma.order.count()).toBe(1);
  });

  it('pays online for a live-location order through the real Cashfree path, contact = the live recipient', async () => {
    const { session, listingId } = await setup();
    const res = await placeOrder(session.accessToken, { liveLocation: LIVE_COMPLETE, paymentMethod: PaymentMethod.ONLINE });
    expect(res.status).toBe(201);
    const { order, requiresPayment } = expectSuccess<{ order: OrderDetailDto; requiresPayment: boolean }>(res.body).data;
    expect(requiresPayment).toBe(true);
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: listingId } })).reservedQty).toBe(2);

    const checkout = expectSuccess<{ providerOrderId: string }>(
      (
        await api()
          .post('/api/v1/payments/create')
          .set('Authorization', bearer(session.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ orderId: order.id })
          .expect(200)
      ).body,
    ).data;
    expect(cashfree.orders.get(checkout.providerOrderId)!.customer_details['customer_phone']).toBe('9829012345');

    cashfree.attempt(checkout.providerOrderId, 'SUCCESS');
    const state = expectSuccess<{ status: OrderStatus; paymentStatus: string }>(
      (await api().post(`/api/v1/payments/${order.id}/refresh`).set('Authorization', bearer(session.accessToken)).expect(200)).body,
    ).data;
    expect(state).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });

    // Confirmation still shows the live destination.
    const detail = await orderDetail(session.accessToken, order.id);
    expect(detail).toMatchObject({ deliveryMode: DeliveryMode.LIVE_LOCATION, deliveryAddress: { fullName: 'Ramesh Jat', mobile: '9829012345' } });
  });
});

describe('saved-address orders alongside live ones', () => {
  it('still order exactly as before, with the saved address’s own recipient', async () => {
    const { session } = await setup();
    const addressId = await seedAddress(session.userId);
    const order = expectSuccess<{ order: OrderDetailDto }>(
      (await placeOrder(session.accessToken, { addressId, paymentMethod: PaymentMethod.COD }).expect(201)).body,
    ).data.order;
    expect(order.deliveryMode).toBe(DeliveryMode.SAVED_ADDRESS);
    expect(order.deliveryAddress).toMatchObject({ id: addressId, label: 'Home', fullName: 'Test Customer', mobile: '9876543210', locationSource: null });
    expect(await prisma.order.findFirstOrThrow()).toMatchObject({ deliveryMode: 'SAVED_ADDRESS', addressId, deliveryLocationAccuracyM: null });
  });

  it('keep their snapshot when the saved address and the profile are edited afterwards', async () => {
    const { session } = await setup();
    const addressId = await seedAddress(session.userId);
    const placed = expectSuccess<{ order: OrderDetailDto }>(
      (await placeOrder(session.accessToken, { addressId, paymentMethod: PaymentMethod.COD }).expect(201)).body,
    ).data.order;

    await api()
      .patch(`/api/v1/addresses/${addressId}`)
      .set('Authorization', bearer(session.accessToken))
      .send({ label: 'Parents', fullName: 'Someone Else', mobile: '9000000009', area: 'Another Colony', city: 'Fatehpur', ...FAR })
      .expect(200);
    await api().patch('/api/v1/auth/me').set('Authorization', bearer(session.accessToken)).send({ fullName: 'Renamed Customer' }).expect(200);

    const after = await orderDetail(session.accessToken, placed.id);
    expect(after.deliveryAddress).toMatchObject({
      // The label as it was when ordering — not the address's new one.
      label: 'Home',
      fullName: 'Test Customer',
      mobile: '9876543210',
      city: 'Sikar',
      latitude: NEARBY.latitude,
      longitude: NEARBY.longitude,
    });
    expect(after.deliveryAddress.area).toBe(placed.deliveryAddress.area);
  });

  it('a live-location order is untouched by a later profile edit, and never uses another customer’s address', async () => {
    const { session } = await setup();
    const live = expectSuccess<{ order: OrderDetailDto }>(
      (await placeOrder(session.accessToken, { liveLocation: LIVE_COMPLETE, paymentMethod: PaymentMethod.COD }).expect(201)).body,
    ).data.order;
    await api().patch('/api/v1/auth/me').set('Authorization', bearer(session.accessToken)).send({ fullName: 'Renamed Customer' }).expect(200);
    expect((await orderDetail(session.accessToken, live.id)).deliveryAddress).toMatchObject({ fullName: 'Ramesh Jat', mobile: '9829012345' });

    // Another customer's saved address is not a destination for this one.
    await otpService.clearOtpState('9400003001');
    const other = await loginAs('9400003001');
    const othersAddress = await seedAddress(other.userId);
    const stolen = await quote(session.accessToken, { addressId: othersAddress });
    expect(stolen.status).toBe(404);
  });
});
