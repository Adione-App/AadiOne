/**
 * Checkout idempotency (POST /orders with the Idempotency-Key header), the
 * server half of the contract the app keeps (mobile lib/checkoutIntent.ts):
 *
 *   - a retry of the SAME request with the SAME key replays the same order and
 *     the same Cashfree session — never a second order or Cashfree order;
 *   - a NEW checkout uses a new key and gets its own order;
 *   - one key with a different body is refused (IDEMPOTENCY_KEY_REUSED) and
 *     creates nothing — the production error, caused by the app reusing the
 *     previous order's key;
 *   - concurrent requests (same key, or two keys for one cart) make one order;
 *   - a failed attempt releases its key, so the corrected retry works.
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

import { ConfigKey, ErrorCode, PaymentMethod } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9400000941';

interface Placed {
  order: { id: string; bill: { totalPaise: number } };
  payment?: { providerOrderId: string; cashfree?: { paymentSessionId: string; orderId: string } };
}

async function setup() {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, stockQty: 50 });
  await otpService.clearOtpState(MOBILE);
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);
  const auth = { Authorization: bearer(session.accessToken) };
  const addToCart = (qty = 2) =>
    api().post('/api/v1/cart/items').set(auth).send({ sellerListingId: product.storeVariantId, qty }).expect(200);
  const place = (key: string, body: Record<string, unknown> = {}) =>
    api()
      .post('/api/v1/orders')
      .set(auth)
      .set('Idempotency-Key', key)
      .send({ addressId, paymentMethod: PaymentMethod.ONLINE, openPayment: true, ...body });
  return { auth, addToCart, place, userId: session.userId, listingId: product.storeVariantId };
}

const cashfreeOrderCreates = () => cashfree.requests.filter((r) => r.method === 'POST' && r.path === '/orders').length;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
});

describe('POST /orders idempotency', () => {
  it('same checkout retry: the same key and body replay the same order and Cashfree session', async () => {
    const { addToCart, place } = await setup();
    await addToCart();
    const key = randomUUID();
    const first = expectSuccess<Placed>((await place(key).expect(201)).body).data;
    const retry = expectSuccess<Placed>((await place(key).expect(201)).body).data;
    expect(retry.order.id).toBe(first.order.id);
    expect(retry.payment?.cashfree?.paymentSessionId).toBe(first.payment?.cashfree?.paymentSessionId);
    expect(await prisma.order.count()).toBe(1);
    expect(cashfreeOrderCreates()).toBe(1);
  });

  it('a new checkout after the previous one gets a new key and its own order', async () => {
    const { addToCart, place } = await setup();
    await addToCart();
    const first = expectSuccess<Placed>((await place(randomUUID()).expect(201)).body).data;
    await addToCart(3);
    const second = expectSuccess<Placed>((await place(randomUUID()).expect(201)).body).data;
    expect(second.order.id).not.toBe(first.order.id);
    expect(second.payment?.providerOrderId).not.toBe(first.payment?.providerOrderId);
    expect(await prisma.order.count()).toBe(2);
  });

  it("reusing one key with a different payload is refused — 'This request was already used for a different order.' — and creates nothing", async () => {
    const { addToCart, place, userId, listingId } = await setup();
    await addToCart();
    const key = randomUUID();
    await place(key).expect(201);
    // The app kept the previous order's key for the next checkout (the bug).
    await addToCart(3);
    const res = await place(key, { paymentMethod: PaymentMethod.COD, openPayment: undefined });
    expect(res.status).toBe(409);
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    expect(error.message).toBe('This request was already used for a different order.');
    expect(await prisma.order.count()).toBe(1);
    // The new lines are untouched in the cart, ready for a request with a new key.
    const lines = await prisma.cartItem.findMany({ where: { cart: { userId, status: 'ACTIVE' } } });
    expect(lines.map((l) => [l.sellerListingId, l.qty])).toEqual([[listingId, 3]]);
    expect((await place(randomUUID(), { paymentMethod: PaymentMethod.COD, openPayment: undefined })).status).toBe(201);
  });

  it('an identical body under an OLD key replays the old order even after it was cancelled — why each new checkout needs a new key', async () => {
    const { auth, addToCart, place } = await setup();
    await addToCart();
    const key = randomUUID();
    const first = expectSuccess<Placed>((await place(key).expect(201)).body).data;
    await api().post(`/api/v1/orders/${first.order.id}/cancel`).set(auth).send({ reason: 'Changed my mind' }).expect(200);
    // The cancel put the same items back; the identical request with the old key is a replay.
    const replay = expectSuccess<Placed>((await place(key).expect(201)).body).data;
    expect(replay.order.id).toBe(first.order.id);
    // With a new key it is a new order.
    const fresh = expectSuccess<Placed>((await place(randomUUID()).expect(201)).body).data;
    expect(fresh.order.id).not.toBe(first.order.id);
  });

  it('two concurrent requests with the same key make one order and one Cashfree order', async () => {
    const { addToCart, place } = await setup();
    await addToCart();
    const key = randomUUID();
    const results = await Promise.all([place(key), place(key), place(key)]);
    for (const r of results) expect([201, 409]).toContain(r.status);
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => expectSuccess<Placed>(r.body).data.order.id));
    expect(ids.size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    expect(cashfreeOrderCreates()).toBe(1);
  });

  it('two concurrent requests with different keys for the same cart still make one order', async () => {
    const { addToCart, place } = await setup();
    await addToCart();
    const results = await Promise.all([place(randomUUID()), place(randomUUID())]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.order.count()).toBe(1);
    expect(cashfreeOrderCreates()).toBe(1);
  });

  it('app restart and retry: the same key later replays the same order and session, with no new Cashfree order', async () => {
    const { addToCart, place } = await setup();
    await addToCart();
    const key = randomUUID();
    const first = expectSuccess<Placed>((await place(key).expect(201)).body).data;
    // …the app is killed before it sees the answer; after a restart it retries with the persisted key.
    const afterRestart = expectSuccess<Placed>((await place(key).expect(201)).body).data;
    expect(afterRestart.order.id).toBe(first.order.id);
    expect(afterRestart.payment?.cashfree).toEqual(first.payment?.cashfree);
    expect(cashfreeOrderCreates()).toBe(1);
  });

  it('a failed attempt releases its key: the corrected retry with the same key succeeds (never locked out)', async () => {
    const { addToCart, place } = await setup();
    await addToCart();
    const key = randomUUID();
    // A stale total — refused, nothing ordered.
    const refused = await place(key, { expectedTotalPaise: 1 });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.idempotencyKey.count()).toBe(0);
    // Same key, corrected body: accepted.
    await place(key).expect(201);
    expect(await prisma.order.count()).toBe(1);
  });
});
