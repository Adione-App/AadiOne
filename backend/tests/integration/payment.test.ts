/**
 * Phase 9 — online payment settlement.
 *
 * Exercises all three convergent paths and the failure modes that actually
 * occur in production: forged client success, amount tampering, replayed
 * webhooks, and payment abandoned mid-flow.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, OrderStatus, PaymentMethod } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { MockPaymentProvider } from '../../src/infra/payment';
import { releaseExpiredReservations } from '../../src/jobs';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9876543210';

interface OnlineOrder {
  token: string;
  orderId: string;
  storeVariantId: string;
  totalPaise: number;
}

async function placeOnlineOrder(): Promise<OnlineOrder> {
  const storeId = await seedStore();
  const product = await seedProduct(storeId, { pricePaise: 20000, mrpPaise: 24000, stockQty: 10 });
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);

  await api()
    .post('/api/v1/cart/items')
    .set('Authorization', bearer(session.accessToken))
    .send({ sellerListingId: product.storeVariantId, qty: 2 })
    .expect(200);

  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(session.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.ONLINE })
    .expect(201);

  const order = expectSuccess<{ order: { id: string; bill: { totalPaise: number } } }>(res.body)
    .data.order;

  return {
    token: session.accessToken,
    orderId: order.id,
    storeVariantId: product.storeVariantId,
    totalPaise: order.bill.totalPaise,
  };
}

async function createIntent(order: OnlineOrder): Promise<string> {
  const res = await api()
    .post('/api/v1/payments/create')
    .set('Authorization', bearer(order.token))
    .set('Idempotency-Key', randomUUID())
    .send({ orderId: order.orderId })
    .expect(200);

  return expectSuccess<{ providerOrderId: string }>(res.body).data.providerOrderId;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await otpService.clearOtpState(MOBILE);
  await cache.clear();
});

describe('online payment — fast path', () => {
  it('confirms the order and commits stock only after server-side verification', async () => {
    const order = await placeOnlineOrder();
    const providerOrderId = await createIntent(order);

    // Stock is held, not sold, while payment is outstanding.
    let offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: order.storeVariantId },
    });
    expect(offer.stockQty).toBe(10);
    expect(offer.reservedQty).toBe(2);

    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;
    const res = await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(order.token))
      .send({
        orderId: order.orderId,
        providerOrderId,
        providerPaymentId,
        signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId),
      })
      .expect(200);

    const result = expectSuccess<{ verified: boolean; orderStatus: string; paymentStatus: string }>(
      res.body,
    ).data;
    expect(result.verified).toBe(true);
    // PAYMENT_CONFIRMED is transient — the customer never rests there.
    expect(result.orderStatus).toBe(OrderStatus.PROCESSING);
    expect(result.paymentStatus).toBe('PAID');

    // Reservation converted into a sale.
    offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: order.storeVariantId },
    });
    expect(offer.stockQty).toBe(8);
    expect(offer.reservedQty).toBe(0);

    const ledger = await prisma.stockLedger.findMany({ orderBy: { createdAt: 'asc' } });
    expect(ledger.map((row) => row.reason)).toEqual(['ORDER_RESERVE', 'ORDER_COMMIT']);
  });

  it('rejects a forged client success and fails the order', async () => {
    // The whole point of server-side verification: a modified app claiming
    // success must get nowhere near a confirmed order.
    const order = await placeOnlineOrder();
    const providerOrderId = await createIntent(order);

    const res = await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(order.token))
      .send({
        orderId: order.orderId,
        providerOrderId,
        providerPaymentId: 'mock_pay_forged',
        signature: 'f'.repeat(64),
      });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.PAYMENT_VERIFICATION_FAILED);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(updated.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(updated.paymentStatus).toBe('FAILED');

    // Stock released back to sale — nothing sold for a payment that never happened.
    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: order.storeVariantId },
    });
    expect(offer.stockQty).toBe(10);
    expect(offer.reservedQty).toBe(0);
  });

  it("refuses to confirm another customer's order", async () => {
    const order = await placeOnlineOrder();
    await otpService.clearOtpState('9812345678');
    const attacker = await loginAs('9812345678');

    const res = await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(attacker.accessToken))
      .send({
        orderId: order.orderId,
        providerOrderId: 'mock_order_x',
        providerPaymentId: 'mock_pay_x',
        signature: 'a'.repeat(64),
      });

    expect(res.status).toBe(404);
  });

  it('reuses the same provider order when the payment sheet is reopened', async () => {
    const order = await placeOnlineOrder();
    const first = await createIntent(order);
    const second = await createIntent(order);

    expect(second).toBe(first);
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(1);
  });
});

describe('webhook — truth path', () => {
  it('settles an order from a signed webhook alone', async () => {
    // The case where the app was killed after paying: no client callback ever
    // arrives, and the webhook has to carry the order over the line.
    const order = await placeOnlineOrder();
    const providerOrderId = await createIntent(order);
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;

    await api()
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send({
        event_id: randomUUID(),
        type: 'payment.captured',
        provider_order_id: providerOrderId,
        provider_payment_id: providerPaymentId,
        amount_paise: order.totalPaise,
      })
      .expect(200);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(updated.status).toBe(OrderStatus.PROCESSING);
    expect(updated.paymentStatus).toBe('PAID');
  });

  it('treats a replayed webhook as a no-op', async () => {
    const order = await placeOnlineOrder();
    const providerOrderId = await createIntent(order);
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;
    const eventId = randomUUID();

    const body = {
      event_id: eventId,
      type: 'payment.captured',
      provider_order_id: providerOrderId,
      provider_payment_id: providerPaymentId,
      amount_paise: order.totalPaise,
    };

    // Providers retry aggressively; five deliveries must settle once.
    for (let i = 0; i < 5; i += 1) {
      await api()
        .post('/api/v1/payments/webhook')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
    }

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(
      await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } }),
    ).toBe(1);

    // And stock moved exactly once.
    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: order.storeVariantId },
    });
    expect(offer.stockQty).toBe(8);
  });

  it('refuses to confirm when the captured amount does not match the order', async () => {
    // Amount tampering. The order total is the only figure that may be
    // charged, so a mismatch is never auto-confirmed.
    const order = await placeOnlineOrder();
    const providerOrderId = await createIntent(order);

    await api()
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send({
        event_id: randomUUID(),
        type: 'payment.captured',
        provider_order_id: providerOrderId,
        provider_payment_id: `mock_pay_${randomUUID().slice(0, 8)}`,
        amount_paise: 1,
      })
      .expect(200);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(updated.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(updated.paymentStatus).toBe('PENDING');

    // The failure is recorded for investigation rather than swallowed.
    const event = await prisma.paymentEvent.findFirstOrThrow();
    expect(event.error).toContain('PAYMENT_AMOUNT_MISMATCH');
  });

  it('does not double-settle when verify and webhook both arrive', async () => {
    const order = await placeOnlineOrder();
    const providerOrderId = await createIntent(order);
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;

    await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(order.token))
      .send({
        orderId: order.orderId,
        providerOrderId,
        providerPaymentId,
        signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId),
      })
      .expect(200);

    await api()
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send({
        event_id: randomUUID(),
        type: 'payment.captured',
        provider_order_id: providerOrderId,
        provider_payment_id: providerPaymentId,
        amount_paise: order.totalPaise,
      })
      .expect(200);

    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: order.storeVariantId },
    });
    // Stock committed once, not twice.
    expect(offer.stockQty).toBe(8);
    expect(
      await prisma.payment.count({ where: { orderId: order.orderId, status: 'CAPTURED' } }),
    ).toBe(1);
  });
});

describe('abandoned payment', () => {
  it('releases the reservation once the hold expires', async () => {
    // One abandoned checkout must not remove an item from sale forever.
    const order = await placeOnlineOrder();
    await createIntent(order);

    await prisma.order.update({
      where: { id: order.orderId },
      data: { reservationExpiresAt: new Date(Date.now() - 60_000) },
    });

    const released = await releaseExpiredReservations();
    expect(released).toBe(1);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(updated.status).toBe(OrderStatus.PAYMENT_FAILED);

    const offer = await prisma.sellerListing.findUniqueOrThrow({
      where: { id: order.storeVariantId },
    });
    expect(offer.stockQty).toBe(10);
    expect(offer.reservedQty).toBe(0);
  });
});

describe('COD orders', () => {
  it('cannot start an online payment', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { stockQty: 10 });
    const session = await loginAs(MOBILE);
    const addressId = await seedAddress(session.userId);

    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(session.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 1 })
      .expect(200);

    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.COD })
      .expect(201);

    const orderId = expectSuccess<{ order: { id: string } }>(placed.body).data.order.id;

    const res = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId });

    expect(res.status).toBe(400);
    expect(expectError(res.body).message).toMatch(/cash on delivery/i);
  });
});
