/**
 * Phase 8 — order pipeline.
 *
 * The two tests that matter most in this entire project are here:
 * OVERSELLING under concurrency, and DUPLICATE ORDERS on retry. Both are run
 * against real PostgreSQL, because both depend on behaviour that only exists
 * in the database — row locks, CHECK constraints and unique indexes.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CodPolicy, ConfigKey, ErrorCode, OrderStatus, PaymentMethod } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { FAR, seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9876543210';

interface Session {
  accessToken: string;
  userId: string;
}

async function setup(): Promise<{ session: Session; storeId: string }> {
  const storeId = await seedStore();
  const session = await loginAs(MOBILE);
  return { session, storeId };
}

async function addToCart(token: string, sellerListingId: string, qty = 1): Promise<void> {
  await api()
    .post('/api/v1/cart/items')
    .set('Authorization', bearer(token))
    .send({ sellerListingId, qty })
    .expect(200);
}

async function placeOrder(
  token: string,
  body: Record<string, unknown>,
  key = randomUUID(),
) {
  return api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(token))
    .set('Idempotency-Key', key)
    .send(body);
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(MOBILE);
  // leak into this one.
  await cache.clear();
});

describe('COD order — happy path', () => {
  it('places an order, decrements stock and returns a full receipt', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { pricePaise: 24900, mrpPaise: 28500, stockQty: 10 });
    const addressId = await seedAddress(session.userId);

    await addToCart(session.accessToken, product.storeVariantId, 2);

    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
    });

    expect(res.status).toBe(201);
    const { order, requiresPayment } = expectSuccess<{
      order: {
        orderNumber: string;
        status: OrderStatus;
        bill: { itemsSubtotalPaise: number; totalPaise: number; deliveryFeePaise: number };
        items: { qty: number; unitPricePaise: number }[];
        deliveryOtp: string | null;
        timeline: { step: string; status: string }[];
      };
      requiresPayment: boolean;
    }>(res.body).data;

    // COD skips PENDING_PAYMENT entirely — there is nothing to wait for.
    expect(order.status).toBe(OrderStatus.PROCESSING);
    expect(requiresPayment).toBe(false);
    expect(order.orderNumber).toMatch(/^AD\d{6}[A-Z0-9]{6}$/);
    expect(order.bill.itemsSubtotalPaise).toBe(49800);
    expect(order.bill.totalPaise).toBeGreaterThan(order.bill.itemsSubtotalPaise);
    expect(order.items[0]!.qty).toBe(2);

    // Delivery OTP is returned exactly once, at creation.
    expect(order.deliveryOtp).toMatch(/^\d{4}$/);
    const stored = await prisma.order.findFirstOrThrow();
    expect(stored.deliveryOtpHash).not.toBe(order.deliveryOtp);

    // Stock left the shelf; nothing is left reserved.
    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(8);
    expect(offer.reservedQty).toBe(0);

    // Ledger explains the movement.
    const ledger = await prisma.stockLedger.findMany({ orderBy: { createdAt: 'asc' } });
    expect(ledger.map((row) => row.reason)).toEqual(['ORDER_RESERVE', 'ORDER_COMMIT']);

    // Cart is consumed, not left behind to be ordered twice.
    const cart = await prisma.cart.findFirstOrThrow();
    expect(cart.status).toBe('CONVERTED');

    expect(order.timeline.find((step) => step.step === 'PLACED')?.status).toBe('IN_PROGRESS');
  });

  it('holds stock as RESERVED for an online order rather than selling it', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { stockQty: 10 });
    const addressId = await seedAddress(session.userId);
    await addToCart(session.accessToken, product.storeVariantId, 3);

    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.ONLINE,
    });
    expect(res.status).toBe(201);

    const data = expectSuccess<{ order: { status: string }; requiresPayment: boolean }>(res.body)
      .data;
    expect(data.order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(data.requiresPayment).toBe(true);

    // Goods are still on the shelf, but spoken for.
    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(10);
    expect(offer.reservedQty).toBe(3);

    // And the hold has an expiry, so an abandoned checkout frees it.
    const order = await prisma.order.findFirstOrThrow();
    expect(order.reservationExpiresAt).not.toBeNull();
  });
});

describe('overselling', () => {
  it('sells the last unit exactly once under concurrent checkout', async () => {
    // THE test. Ten customers, one unit. Without row locks taken in a
    // deterministic order, several would each read "1 available" and all
    // succeed — the store then owes stock it does not have.
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { stockQty: 1, maxQtyPerOrder: 5 });

    const shoppers = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const mobile = `98765000${String(index).padStart(2, '0')}`;
        await otpService.clearOtpState(mobile);
        const session = await loginAs(mobile);
        const addressId = await seedAddress(session.userId);
        await addToCart(session.accessToken, product.storeVariantId, 1);
        return { session, addressId };
      }),
    );

    const results = await Promise.all(
      shoppers.map((shopper) =>
        placeOrder(shopper.session.accessToken, {
          addressId: shopper.addressId,
          paymentMethod: PaymentMethod.COD,
        }),
      ),
    );

    const succeeded = results.filter((res) => res.status === 201);
    const failed = results.filter((res) => res.status !== 201);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(9);

    // The failures must be honest about why.
    for (const res of failed) {
      expect([ErrorCode.ITEM_OUT_OF_STOCK, ErrorCode.PRODUCT_UNAVAILABLE]).toContain(
        expectError(res.body).code,
      );
    }

    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(0);
    expect(offer.reservedQty).toBe(0);
    expect(await prisma.order.count()).toBe(1);
  });

  it('refuses a quantity larger than the stock on hand', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { stockQty: 2, maxQtyPerOrder: 10 });
    const addressId = await seedAddress(session.userId);

    // Add 2 (all of it), then drop stock underneath the cart.
    await addToCart(session.accessToken, product.storeVariantId, 2);
    await prisma.sellerListing.update({
      where: { id: product.storeVariantId },
      data: { stockQty: 1 },
    });

    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
    });

    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.ITEM_OUT_OF_STOCK);
    expect(await prisma.order.count()).toBe(0);
  });
});

describe('idempotency', () => {
  it('creates one order when the same request is retried', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { stockQty: 10 });
    const addressId = await seedAddress(session.userId);
    await addToCart(session.accessToken, product.storeVariantId, 1);

    const key = randomUUID();
    const body = { addressId, paymentMethod: PaymentMethod.COD };

    const first = await placeOrder(session.accessToken, body, key);
    expect(first.status).toBe(201);

    // The retry a flaky network produces: same key, same payload.
    const retry = await placeOrder(session.accessToken, body, key);
    expect(retry.status).toBe(201);

    const firstOrder = expectSuccess<{ order: { id: string } }>(first.body).data.order;
    const retryOrder = expectSuccess<{ order: { id: string } }>(retry.body).data.order;
    expect(retryOrder.id).toBe(firstOrder.id);

    expect(await prisma.order.count()).toBe(1);
    // And stock moved exactly once.
    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(9);
  });

  it('rejects a key reused with a different payload', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { stockQty: 10 });
    const addressA = await seedAddress(session.userId);
    await addToCart(session.accessToken, product.storeVariantId, 1);

    const key = randomUUID();
    await placeOrder(session.accessToken, { addressId: addressA, paymentMethod: 'COD' }, key);

    const res = await placeOrder(
      session.accessToken,
      { addressId: addressA, paymentMethod: 'ONLINE' },
      key,
    );

    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
  });

  it('requires an idempotency key', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, {});
    const addressId = await seedAddress(session.userId);
    await addToCart(session.accessToken, product.storeVariantId, 1);

    const res = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .send({ addressId, paymentMethod: PaymentMethod.COD });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
  });
});

describe('order-time re-validation', () => {
  it('blocks COD when any item denies it, and names the item', async () => {
    const { session, storeId } = await setup();
    const ok = await seedProduct(storeId, { name: 'Aashirvaad Atta', stockQty: 10 });
    const denied = await seedProduct(storeId, {
      name: 'Fresh Tomatoes',
      stockQty: 10,
      // Data-driven: the category says DENY. No category name in code.
      categoryAllowCod: CodPolicy.DENY,
    });
    const addressId = await seedAddress(session.userId);

    await addToCart(session.accessToken, ok.storeVariantId, 1);
    await addToCart(session.accessToken, denied.storeVariantId, 1);

    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
    });

    expect(res.status).toBe(422);
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.COD_NOT_ALLOWED);
    expect(error.message).toContain('Fresh Tomatoes');

    // The same basket must still be orderable online.
    const online = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.ONLINE,
    });
    expect(online.status).toBe(201);
  });

  it('rejects an address outside the delivery area', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, {});
    const addressId = await seedAddress(session.userId, FAR);
    await addToCart(session.accessToken, product.storeVariantId, 1);

    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
    });

    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.OUT_OF_SERVICE_AREA);
  });

  it("refuses another customer's address", async () => {
    // IDOR: knowing an address id must not be enough to deliver to it.
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, {});
    await addToCart(session.accessToken, product.storeVariantId, 1);

    await otpService.clearOtpState('9812345678');
    const other = await loginAs('9812345678');
    const foreignAddressId = await seedAddress(other.userId);

    const res = await placeOrder(session.accessToken, {
      addressId: foreignAddressId,
      paymentMethod: PaymentMethod.COD,
    });

    expect(res.status).toBe(404);
  });

  it('enforces the minimum order value', async () => {
    const { session, storeId } = await setup();
    await configService.set({
      key: ConfigKey.MIN_ORDER_VALUE_PAISE,
      value: 50_000 as never,
    });
    const product = await seedProduct(storeId, { pricePaise: 1000, mrpPaise: 1000 });
    const addressId = await seedAddress(session.userId);
    await addToCart(session.accessToken, product.storeVariantId, 1);

    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
    });

    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.MIN_ORDER_NOT_MET);
  });

  it('rejects the order when the price moved since the review screen', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { pricePaise: 10000, mrpPaise: 12000 });
    const addressId = await seedAddress(session.userId);
    await addToCart(session.accessToken, product.storeVariantId, 1);

    // The customer saw a total based on the old price; the shop then raised it.
    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
      expectedTotalPaise: 999,
    });

    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.PRICE_CHANGED);
    // Nothing was charged and no order exists — they re-confirm instead.
    expect(await prisma.order.count()).toBe(0);
  });

  it('rejects an empty cart', async () => {
    const { session } = await setup();
    const addressId = await seedAddress(session.userId);

    const res = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
    });

    expect(res.status).toBe(422);
    expect(expectError(res.body).code).toBe(ErrorCode.CART_EMPTY);
  });
});

describe('cart revalidation', () => {
  it('removes an out-of-stock item and says so, instead of silently dropping it', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { name: 'Tata Salt', stockQty: 5 });
    await addToCart(session.accessToken, product.storeVariantId, 2);

    await prisma.sellerListing.update({
      where: { id: product.storeVariantId },
      data: { stockQty: 0 },
    });

    const res = await api()
      .get('/api/v1/cart')
      .set('Authorization', bearer(session.accessToken))
      .expect(200);

    const cart = expectSuccess<{
      items: unknown[];
      changes: { type: string; message: string }[];
      checkoutEnabled: boolean;
    }>(res.body).data;

    expect(cart.items).toHaveLength(0);
    expect(cart.changes[0]!.type).toBe('ITEM_REMOVED_OUT_OF_STOCK');
    expect(cart.changes[0]!.message).toContain('Tata Salt');
    expect(cart.checkoutEnabled).toBe(false);
  });

  it('reduces quantity to what is left, with a notice', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { name: 'Amul Milk', stockQty: 5 });
    await addToCart(session.accessToken, product.storeVariantId, 4);

    await prisma.sellerListing.update({
      where: { id: product.storeVariantId },
      data: { stockQty: 2 },
    });

    const res = await api()
      .get('/api/v1/cart')
      .set('Authorization', bearer(session.accessToken))
      .expect(200);

    const cart = expectSuccess<{
      items: { qty: number }[];
      changes: { type: string; previousValue?: number; newValue?: number }[];
    }>(res.body).data;

    expect(cart.items[0]!.qty).toBe(2);
    expect(cart.changes[0]).toMatchObject({
      type: 'QTY_REDUCED_STOCK',
      previousValue: 4,
      newValue: 2,
    });
  });

  it('never stores a price on the cart line', async () => {
    // Structural guarantee: there is nowhere for a stale price to live.
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, {});
    await addToCart(session.accessToken, product.storeVariantId, 1);

    const row = await prisma.cartItem.findFirstOrThrow();
    expect(Object.keys(row)).not.toContain('pricePaise');
    expect(Object.keys(row)).not.toContain('unitPricePaise');
  });
});

describe('cancellation', () => {
  it('lets the customer cancel early and puts the stock back', async () => {
    const { session, storeId } = await setup();
    const product = await seedProduct(storeId, { stockQty: 10 });
    const addressId = await seedAddress(session.userId);
    await addToCart(session.accessToken, product.storeVariantId, 2);

    const placed = await placeOrder(session.accessToken, {
      addressId,
      paymentMethod: PaymentMethod.COD,
    });
    const orderId = expectSuccess<{ order: { id: string } }>(placed.body).data.order.id;

    const res = await api()
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', bearer(session.accessToken))
      .send({ reason: 'Ordered by mistake' })
      .expect(200);

    expect(expectSuccess<{ status: string }>(res.body).data.status).toBe(OrderStatus.CANCELLED);

    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: product.storeVariantId },
    });
    expect(offer.stockQty).toBe(10); // restocked

    const ledger = await prisma.stockLedger.findMany({ orderBy: { createdAt: 'asc' } });
    expect(ledger.map((row) => row.reason)).toContain('ORDER_CANCEL_RESTOCK');
  });
});
