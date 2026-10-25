/**
 * The global payment switches — PAYMENT_ONLINE_ENABLED / PAYMENT_COD_ENABLED
 * (Admin Panel → Configuration → Payments) — end to end:
 *
 *   - the checkout quote reports them (the app fades a switched-off method);
 *   - the server refuses a NEW order / NEW online payment with a switched-off
 *     method whatever the client sends (an older app, a crafted request),
 *     with a stable code, and writes nothing;
 *   - a payment that was already started keeps working: reopening its
 *     checkout, verification and webhooks; existing orders are untouched;
 *   - only an admin with configuration rights can change them.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, ErrorCode, OrderStatus, PAYMENT_UNAVAILABLE_MESSAGES, PaymentMethod, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { hashPassword } from '../../src/common/crypto';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { MockPaymentProvider } from '../../src/infra/payment';
import { configureTestMerchantUpi, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9876500011';
const ADMIN = { mobile: '9400000871', email: 'payments-admin@adione.test', password: 'TestAdmin@123' };

interface Shopper {
  token: string;
  addressId: string;
  listingId: string;
}

async function shopper(): Promise<Shopper> {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: product.storeVariantId, qty: 2 }).expect(200);
  return { token: session.accessToken, addressId, listingId: product.storeVariantId };
}

const placeOrder = (s: Shopper, paymentMethod: PaymentMethod) =>
  api().post('/api/v1/orders').set('Authorization', bearer(s.token)).set('Idempotency-Key', randomUUID()).send({ addressId: s.addressId, paymentMethod });

const quote = async (s: Shopper) =>
  expectSuccess<{ codAllowed: boolean; codBlockedReason: string | null; availablePaymentMethods: string[]; onlinePaymentEnabled: boolean; codEnabled: boolean }>(
    (await api().post('/api/v1/checkout/quote').set('Authorization', bearer(s.token)).send({ addressId: s.addressId }).expect(200)).body,
  ).data;

const createPayment = (token: string, orderId: string) =>
  api().post('/api/v1/payments/create').set('Authorization', bearer(token)).set('Idempotency-Key', randomUUID()).send({ orderId });

async function switches(online: boolean, cod: boolean) {
  await configService.set({ key: ConfigKey.PAYMENT_ONLINE_ENABLED, value: online });
  await configService.set({ key: ConfigKey.PAYMENT_COD_ENABLED, value: cod });
}

/** The listing's reserved / sold stock and how many orders and payments exist — "nothing was written". */
async function footprint(listingId: string) {
  const listing = await prisma.sellerListing.findUniqueOrThrow({ where: { id: listingId } });
  return { reserved: listing.reservedQty, stock: listing.stockQty, orders: await prisma.order.count(), payments: await prisma.payment.count() };
}

async function expectRefused(res: { status: number; body: unknown }, code: ErrorCode, message: string) {
  expect(res.status).toBe(409);
  const error = expectError(res.body);
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(MOBILE);
  await cache.clear();
  await configureTestMerchantUpi();
});

describe('the four combinations at checkout', () => {
  it('A — both on (the default for an installation that never set them): both methods quote and order', async () => {
    const s = await shopper();
    expect(await quote(s)).toMatchObject({ onlinePaymentEnabled: true, codEnabled: true, codAllowed: true, availablePaymentMethods: ['ONLINE', 'COD'] });
    expect((await placeOrder(s, PaymentMethod.COD)).status).toBe(201);
    await api().post('/api/v1/cart/items').set('Authorization', bearer(s.token)).send({ sellerListingId: s.listingId, qty: 1 }).expect(200);
    expect((await placeOrder(s, PaymentMethod.ONLINE)).status).toBe(201);
  });

  it('B — online off: the quote says so; an online order is refused with nothing written; COD orders work', async () => {
    const s = await shopper();
    await switches(false, true);
    expect(await quote(s)).toMatchObject({ onlinePaymentEnabled: false, codEnabled: true, codAllowed: true, availablePaymentMethods: ['COD'] });
    const before = await footprint(s.listingId);
    await expectRefused(await placeOrder(s, PaymentMethod.ONLINE), ErrorCode.ONLINE_PAYMENT_DISABLED, PAYMENT_UNAVAILABLE_MESSAGES.ONLINE);
    expect(await footprint(s.listingId)).toEqual(before);
    const cod = await placeOrder(s, PaymentMethod.COD);
    expect(cod.status).toBe(201);
    expect(expectSuccess<{ order: { status: string } }>(cod.body).data.order.status).toBe(OrderStatus.PROCESSING);
  });

  it('C — COD off: the quote fades COD with the reason (older apps too); a COD order is refused; online works', async () => {
    const s = await shopper();
    await switches(true, false);
    expect(await quote(s)).toMatchObject({
      onlinePaymentEnabled: true,
      codEnabled: false,
      codAllowed: false,
      codBlockedReason: PAYMENT_UNAVAILABLE_MESSAGES.COD,
      availablePaymentMethods: ['ONLINE'],
    });
    const before = await footprint(s.listingId);
    await expectRefused(await placeOrder(s, PaymentMethod.COD), ErrorCode.COD_DISABLED, PAYMENT_UNAVAILABLE_MESSAGES.COD);
    expect(await footprint(s.listingId)).toEqual(before);
    expect((await placeOrder(s, PaymentMethod.ONLINE)).status).toBe(201);
  });

  it('D — both off: no method is available and no order of either kind can be placed', async () => {
    const s = await shopper();
    await switches(false, false);
    expect(await quote(s)).toMatchObject({ onlinePaymentEnabled: false, codEnabled: false, codAllowed: false, availablePaymentMethods: [] });
    const before = await footprint(s.listingId);
    for (const method of [PaymentMethod.ONLINE, PaymentMethod.COD]) {
      await expectRefused(await placeOrder(s, method), ErrorCode.PAYMENTS_UNAVAILABLE, PAYMENT_UNAVAILABLE_MESSAGES.ALL);
    }
    expect(await footprint(s.listingId)).toEqual(before);
    // The cart is still there for later.
    expect((await prisma.cart.findFirstOrThrow({ where: { status: 'ACTIVE' }, include: { items: true } })).items).toHaveLength(1);
  });

  it('a switch turned back on applies at once (no stale cache)', async () => {
    const s = await shopper();
    await switches(true, false);
    await expectRefused(await placeOrder(s, PaymentMethod.COD), ErrorCode.COD_DISABLED, PAYMENT_UNAVAILABLE_MESSAGES.COD);
    await switches(true, true);
    expect((await placeOrder(s, PaymentMethod.COD)).status).toBe(201);
  });
});

describe('payments already under way are never stranded', () => {
  async function onlineOrder(s: Shopper) {
    const res = await placeOrder(s, PaymentMethod.ONLINE).expect(201);
    return expectSuccess<{ order: { id: string; bill: { totalPaise: number } } }>(res.body).data.order;
  }

  it('an online payment started before the switch: its checkout reopens, and verification confirms it', async () => {
    const s = await shopper();
    const order = await onlineOrder(s);
    const providerOrderId = expectSuccess<{ providerOrderId: string }>((await createPayment(s.token, order.id).expect(200)).body).data.providerOrderId;

    await switches(false, true);
    // Reopening the payment sheet returns the SAME payment — not a new one.
    const reopened = expectSuccess<{ providerOrderId: string }>((await createPayment(s.token, order.id).expect(200)).body).data.providerOrderId;
    expect(reopened).toBe(providerOrderId);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);

    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;
    const verified = expectSuccess<{ verified: boolean; paymentStatus: string }>(
      (
        await api()
          .post('/api/v1/payments/verify')
          .set('Authorization', bearer(s.token))
          .send({ orderId: order.id, providerOrderId, providerPaymentId, signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId) })
          .expect(200)
      ).body,
    ).data;
    expect(verified).toMatchObject({ verified: true, paymentStatus: 'PAID' });
  });

  it('the payment webhook still settles a payment started before both switches went off', async () => {
    const s = await shopper();
    const order = await onlineOrder(s);
    const providerOrderId = expectSuccess<{ providerOrderId: string }>((await createPayment(s.token, order.id).expect(200)).body).data.providerOrderId;
    await switches(false, false);
    await api()
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send({ event_id: randomUUID(), type: 'payment.captured', provider_order_id: providerOrderId, provider_payment_id: `mock_pay_${randomUUID().slice(0, 8)}`, amount_paise: order.bill.totalPaise })
      .expect(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: OrderStatus.PROCESSING, paymentStatus: 'PAID' });
  });

  it('no NEW online payment is started while online is off; nothing is written and the order is left as it was', async () => {
    const s = await shopper();
    const order = await onlineOrder(s);
    await switches(false, true);
    await expectRefused(await createPayment(s.token, order.id), ErrorCode.ONLINE_PAYMENT_DISABLED, PAYMENT_UNAVAILABLE_MESSAGES.ONLINE);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PENDING_PAYMENT);
    // Back on: the same order can be paid.
    await switches(true, true);
    expect((await createPayment(s.token, order.id)).status).toBe(200);
  });

  it('existing orders are not touched by a switch', async () => {
    const s = await shopper();
    const cod = expectSuccess<{ order: { id: string } }>((await placeOrder(s, PaymentMethod.COD).expect(201)).body).data.order;
    const before = await prisma.order.findUniqueOrThrow({ where: { id: cod.id } });
    await switches(false, false);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: cod.id } });
    expect(after).toEqual(before);
  });
});

describe('who may change the switches', () => {
  async function adminToken(): Promise<string> {
    await prisma.user.create({
      data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Payments Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
    });
    const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
    return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
  }

  it('no session: 401; a customer: 403; an admin: saved, readable publicly, and validated', async () => {
    const body = { key: ConfigKey.PAYMENT_COD_ENABLED, value: false };
    await api().patch('/api/v1/admin/config').send(body).expect(401);
    const customer = (await loginAs(MOBILE)).accessToken;
    await api().patch('/api/v1/admin/config').set('Authorization', bearer(customer)).send(body).expect(403);
    expect(await configService.get(ConfigKey.PAYMENT_COD_ENABLED)).toBe(true);

    const admin = await adminToken();
    await api().patch('/api/v1/admin/config').set('Authorization', bearer(admin)).send(body).expect(200);
    expect(await configService.get(ConfigKey.PAYMENT_COD_ENABLED)).toBe(false);
    await api().patch('/api/v1/admin/config').set('Authorization', bearer(admin)).send({ key: ConfigKey.PAYMENT_ONLINE_ENABLED, value: 'off' }).expect(400);

    const pub = expectSuccess<Record<string, unknown>>((await api().get('/api/v1/config/public').expect(200)).body).data;
    expect(pub).toMatchObject({ PAYMENT_ONLINE_ENABLED: true, PAYMENT_COD_ENABLED: false });
  });
});
