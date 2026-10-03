/**
 * CashfreeProvider — request shapes, server-side verification, webhook
 * signatures and refund idempotency, against an in-memory Cashfree. No
 * database: every case here is the provider on its own.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared';
import { AppError } from '../../src/common/errors';
import {
  CASHFREE_MIN_EXPIRY_MS,
  CashfreeApiError,
  CashfreeProvider,
  cashfreeRefundId,
  paiseToRupees,
  refundIdFromCashfree,
  rupeesToPaise,
  toCashfreeTime,
} from '../../src/infra/payment/cashfree.provider';
import { FAKE_CASHFREE_SECRET, FakeCashfree, signCashfreeWebhook } from '../helpers/fake-cashfree';

const ORDER_ID = '6f1c2b1e-8a4d-4c3b-9d2e-1a2b3c4d5e6f';
const USER_ID = '0b7e5a52-3c1d-4f7e-8a9b-112233445566';

function setup(environment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX') {
  const gateway = new FakeCashfree();
  const provider = new CashfreeProvider({
    appId: 'cf_test_app_id',
    secretKey: FAKE_CASHFREE_SECRET,
    environment,
    apiVersion: '2026-01-01',
    fetch: gateway.fetch,
  });
  return { gateway, provider };
}

/** What checkout asks Cashfree for: its 15-minute minimum plus a minute's headroom. */
const sixteenMinutesFromNow = () => new Date(Date.now() + 16 * 60_000);

async function openCheckout(provider: CashfreeProvider, amountPaise = 25_300, expiresAt = sixteenMinutesFromNow()) {
  return provider.createIntent({
    orderId: ORDER_ID,
    orderNumber: 'AD260930TESTAB',
    amountPaise,
    currency: 'INR',
    customer: { id: USER_ID, name: 'Test Customer', email: null, contact: '+91 98765 43210' },
    expiresAt,
  });
}

describe('amount and time formatting', () => {
  it('converts paise <-> rupees without float drift', () => {
    expect(paiseToRupees(25_300)).toBe(253);
    expect(paiseToRupees(1_015)).toBe(10.15);
    expect(paiseToRupees(999_999)).toBe(9999.99);
    expect(rupeesToPaise(10.15)).toBe(1_015);
    expect(rupeesToPaise('253.00')).toBe(25_300);
    expect(rupeesToPaise(0.29)).toBe(29);
    expect(rupeesToPaise(undefined)).toBe(0);
  });

  it('formats expiry as ISO 8601 with the +05:30 offset Cashfree documents', () => {
    expect(toCashfreeTime(new Date('2026-09-30T06:30:00.000Z'))).toBe('2026-09-30T12:00:00+05:30');
  });

  it('maps our refund id to an alphanumeric refund_id and back', () => {
    const id = 'c0ffee00-1234-4abc-8def-0123456789ab';
    expect(cashfreeRefundId(id)).toMatch(/^[0-9a-f]{32}$/);
    expect(refundIdFromCashfree(cashfreeRefundId(id))).toBe(id);
    expect(refundIdFromCashfree('not-ours')).toBeNull();
  });
});

describe('createIntent', () => {
  it('creates a sandbox order for the server total, in rupees, with a single-order session', async () => {
    const { gateway, provider } = setup();
    const expiresAt = sixteenMinutesFromNow();
    const intent = await openCheckout(provider, 25_300, expiresAt);

    const request = gateway.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://sandbox.cashfree.com/pg/orders');
    expect(request.headers['x-client-id']).toBe('cf_test_app_id');
    expect(request.headers['x-api-version']).toBe('2026-01-01');
    expect(request.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    // Idempotent create: the same key can never mint a second Cashfree order.
    expect(request.headers['x-idempotency-key']).toBe(request.body?.['order_id']);

    expect(request.body?.['order_amount']).toBe(253);
    expect(request.body?.['order_currency']).toBe('INR');
    expect(String(request.body?.['order_id'])).toMatch(/^AD260930TESTAB_[0-9a-f]{8}$/);
    expect(String(request.body?.['order_id']).length).toBeLessThanOrEqual(45);
    expect(request.body?.['order_expiry_time']).toBe(toCashfreeTime(expiresAt));
    expect(request.body?.['customer_details']).toEqual({
      customer_id: USER_ID.replace(/-/g, ''),
      customer_phone: '9876543210',
      customer_name: 'Test Customer',
    });
    expect(request.body?.['order_tags']).toEqual({
      adione_order_id: ORDER_ID,
      adione_order_number: 'AD260930TESTAB',
    });
    // No webhook URL is invented — the webhook is configured in the dashboard.
    expect(request.body).not.toHaveProperty('order_meta');

    expect(intent.providerOrderId).toBe(request.body?.['order_id']);
    expect(intent.publicKey).toBe('');
    expect(intent.checkout?.paymentSessionId).toMatch(/^session_/);
    expect(intent.checkout?.environment).toBe('SANDBOX');
  });

  it('talks to the production host only in production mode', async () => {
    const { gateway, provider } = setup('PRODUCTION');
    const intent = await openCheckout(provider);
    expect(gateway.requests[0]!.url).toBe('https://api.cashfree.com/pg/orders');
    expect(intent.checkout?.environment).toBe('PRODUCTION');
  });

  it('declares Cashfree’s real minimum expiry (more than 15 minutes) to the checkout', () => {
    const { provider } = setup();
    expect(CASHFREE_MIN_EXPIRY_MS).toBe(15 * 60_000);
    expect(provider.minCheckoutWindowMs).toBe(CASHFREE_MIN_EXPIRY_MS);
  });

  it('an expiry of 15 minutes or less is rejected exactly as Cashfree does (regression: ~9 min was sent before)', async () => {
    const { gateway, provider } = setup();
    for (const minutes of [9, 15]) {
      const error = await openCheckout(provider, 25_300, new Date(Date.now() + minutes * 60_000)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CashfreeApiError);
      expect((error as CashfreeApiError).httpStatus).toBe(400);
      expect((error as CashfreeApiError).cashfreeCode).toBe('order_expiry_time_invalid');
    }
    expect(gateway.orders.size).toBe(0);
  });

  it('refuses an amount below Cashfree’s ₹1 minimum without calling Cashfree', async () => {
    const { gateway, provider } = setup();
    await expect(openCheckout(provider, 99)).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(gateway.requests).toHaveLength(0);
  });

  it('never leaks the secret in an API error', async () => {
    const { gateway, provider } = setup();
    gateway.failNext = { status: 401, code: 'request_failed', message: 'authentication Failed' };
    const error = await openCheckout(provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CashfreeApiError);
    expect((error as CashfreeApiError).httpStatus).toBe(401);
    // Our own HTTP status stays ours.
    expect((error as AppError).status).toBe(402);
    expect(JSON.stringify(error)).not.toContain(FAKE_CASHFREE_SECRET);
    expect(String((error as AppError).internalMessage)).not.toContain(FAKE_CASHFREE_SECRET);
  });
});

describe('fetchOrder — server-side verification', () => {
  it('reports a capture only when the ORDER is PAID by a SUCCESS payment, in paise', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    const paid = gateway.attempt(intent.providerOrderId, 'SUCCESS');

    const status = await provider.fetchOrder(intent.providerOrderId);
    expect(status.orderStatus).toBe('PAID');
    expect(status.amountPaise).toBe(25_300);
    expect(status.adioneOrderId).toBe(ORDER_ID);
    expect(status.captured).toEqual({
      providerPaymentId: paid.cf_payment_id,
      amountPaise: 25_300,
      method: 'upi',
    });
  });

  it('reports a failed attempt without a capture — the order is still payable', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    gateway.attempt(intent.providerOrderId, 'USER_DROPPED');

    const status = await provider.fetchOrder(intent.providerOrderId);
    expect(status.orderStatus).toBe('ACTIVE');
    expect(status.captured).toBeNull();
    expect(status.lastFailure).toMatchObject({ status: 'USER_DROPPED' });
  });

  it('does not report a failure while a newer attempt is still in progress', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    gateway.attempt(intent.providerOrderId, 'FAILED');
    gateway.attempt(intent.providerOrderId, 'PENDING');

    const status = await provider.fetchOrder(intent.providerOrderId);
    expect(status.captured).toBeNull();
    expect(status.lastFailure).toBeNull();
  });

  it('does not trust a SUCCESS attempt on an order Cashfree does not call PAID', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    gateway.attempt(intent.providerOrderId, 'SUCCESS');
    gateway.orders.get(intent.providerOrderId)!.order_status = 'ACTIVE';

    expect((await provider.fetchOrder(intent.providerOrderId)).captured).toBeNull();
  });

  it('verify() is fetchOrder — no client signature is accepted as proof', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    const forged = await provider.verify({
      providerOrderId: intent.providerOrderId,
      providerPaymentId: 'forged',
      signature: 'f'.repeat(64),
    });
    expect(forged.verified).toBe(false);

    gateway.attempt(intent.providerOrderId, 'SUCCESS');
    const real = await provider.verify({ providerOrderId: intent.providerOrderId, providerPaymentId: 'x', signature: 'x' });
    expect(real).toMatchObject({ verified: true, status: 'CAPTURED', amountPaise: 25_300 });
  });

  it('refuses a payment-id-only status lookup', async () => {
    const { provider } = setup();
    await expect(provider.getStatus('123')).rejects.toBeInstanceOf(AppError);
  });
});

describe('parseWebhook — signature', () => {
  it('accepts a correctly signed success webhook and maps it to a capture', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    const payment = gateway.attempt(intent.providerOrderId, 'SUCCESS');
    const { raw, headers } = gateway.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', intent.providerOrderId, payment);

    const event = provider.parseWebhook(Buffer.from(raw), headers);
    expect(event.signatureValid).toBe(true);
    expect(event.status).toBe('CAPTURED');
    expect(event.providerOrderId).toBe(intent.providerOrderId);
    expect(event.providerPaymentId).toBe(payment.cf_payment_id);
    expect(event.amountPaise).toBe(25_300);
    expect(event.eventId).toBe(`PAYMENT_SUCCESS_WEBHOOK:${payment.cf_payment_id}`);
  });

  it('rejects a tampered body, a wrong timestamp, a wrong secret and missing headers', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    const payment = gateway.attempt(intent.providerOrderId, 'SUCCESS');
    const { raw, headers } = gateway.paymentWebhook('PAYMENT_SUCCESS_WEBHOOK', intent.providerOrderId, payment);

    const tampered = raw.replace('"payment_amount":253', '"payment_amount":1');
    expect(tampered).not.toBe(raw);
    expect(provider.parseWebhook(Buffer.from(tampered), headers).signatureValid).toBe(false);
    expect(
      provider.parseWebhook(Buffer.from(raw), { ...headers, 'x-webhook-timestamp': '1' }).signatureValid,
    ).toBe(false);
    expect(
      provider.parseWebhook(Buffer.from(raw), signCashfreeWebhook(raw, 'someone-elses-secret')).signatureValid,
    ).toBe(false);
    expect(provider.parseWebhook(Buffer.from(raw), {}).signatureValid).toBe(false);
  });

  it('verifies over the RAW bytes, so decimals like 10.10 still verify', () => {
    const { provider } = setup();
    const raw = '{"data":{"order":{"order_id":"X_1"},"payment":{"cf_payment_id":"1","payment_status":"SUCCESS","payment_amount":10.10}},"type":"PAYMENT_SUCCESS_WEBHOOK"}';
    const event = provider.parseWebhook(Buffer.from(raw), signCashfreeWebhook(raw));
    expect(event.signatureValid).toBe(true);
    expect(event.amountPaise).toBe(1_010);
  });

  it('maps failed and abandoned attempts to ATTEMPT_FAILED, never to an order failure', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    for (const [type, status] of [
      ['PAYMENT_FAILED_WEBHOOK', 'FAILED'],
      ['PAYMENT_USER_DROPPED_WEBHOOK', 'USER_DROPPED'],
    ] as const) {
      const payment = gateway.attempt(intent.providerOrderId, status);
      const { raw, headers } = gateway.paymentWebhook(type, intent.providerOrderId, payment);
      const event = provider.parseWebhook(Buffer.from(raw), headers);
      expect(event.status).toBe('ATTEMPT_FAILED');
      expect(event.signatureValid).toBe(true);
    }
  });

  it('maps a refund webhook back to our refund row id', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    gateway.attempt(intent.providerOrderId, 'SUCCESS');
    const ourRefundId = 'c0ffee00-1234-4abc-8def-0123456789ab';
    await provider.refund({
      providerPaymentId: 'x',
      providerOrderId: intent.providerOrderId,
      refundId: ourRefundId,
      amountPaise: 25_300,
      reason: 'Late payment',
    });
    gateway.settleRefund(cashfreeRefundId(ourRefundId), 'SUCCESS');

    const { raw, headers } = gateway.refundWebhook(cashfreeRefundId(ourRefundId));
    const event = provider.parseWebhook(Buffer.from(raw), headers);
    expect(event.signatureValid).toBe(true);
    expect(event.status).toBe('REFUND_UPDATE');
    expect(event.refund).toEqual({ refundId: ourRefundId, providerRefundId: '900001', status: 'COMPLETED' });
  });
});

describe('refund — idempotency', () => {
  it('uses our refund id as refund_id and idempotency key, and never refunds twice', async () => {
    const { gateway, provider } = setup();
    const intent = await openCheckout(provider);
    gateway.attempt(intent.providerOrderId, 'SUCCESS');
    const ourRefundId = 'c0ffee00-1234-4abc-8def-0123456789ab';
    const input = {
      providerPaymentId: 'x',
      providerOrderId: intent.providerOrderId,
      refundId: ourRefundId,
      amountPaise: 25_300,
      reason: 'Payment received after the order expired',
    };

    const first = await provider.refund(input);
    const request = gateway.requests.at(-1)!;
    expect(request.path).toBe(`/orders/${intent.providerOrderId}/refunds`);
    expect(request.body).toMatchObject({ refund_amount: 253, refund_id: cashfreeRefundId(ourRefundId) });
    expect(request.headers['x-idempotency-key']).toBe(cashfreeRefundId(ourRefundId));
    expect(first).toEqual({ providerRefundId: '900001', status: 'PENDING' });

    // A retry: Cashfree answers 409 and the existing refund is read back.
    const second = await provider.refund(input);
    expect(second).toEqual(first);
    expect(gateway.refunds.size).toBe(1);
  });

  it('refuses to refund without the Cashfree order id', async () => {
    const { provider } = setup();
    await expect(
      provider.refund({ providerPaymentId: 'x', amountPaise: 100, reason: 'x', refundId: 'y' }),
    ).rejects.toMatchObject({ code: ErrorCode.REFUND_FAILED });
  });
});
