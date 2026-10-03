/**
 * An in-memory stand-in for Cashfree's PG API, plugged into CashfreeProvider
 * through its `fetch` seam. It speaks the documented request/response shapes
 * (amounts in rupees, cf_payment_id strings, order/payment/refund statuses) so
 * the provider's real HTTP code runs — only the network is fake. It also signs
 * webhooks exactly as Cashfree does, so signature checks are exercised for real.
 */

import { createHmac, randomUUID } from 'node:crypto';

export const FAKE_CASHFREE_SECRET = 'cf_test_secret_do_not_use';

interface FakePayment {
  cf_payment_id: string;
  payment_status: string;
  payment_amount: number;
  payment_group: string;
  payment_message: string;
  payment_time: string;
}

interface FakeOrder {
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED';
  order_expiry_time: string;
  payment_session_id: string;
  order_tags: Record<string, string>;
  customer_details: Record<string, string>;
  payments: FakePayment[];
}

interface FakeRefund {
  cf_refund_id: string;
  refund_id: string;
  order_id: string;
  refund_amount: number;
  refund_status: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let clock = 0;
const nextTime = (): string => new Date(Date.UTC(2026, 8, 30, 6, 0, clock++)).toISOString();

export class FakeCashfree {
  readonly orders = new Map<string, FakeOrder>();
  readonly refunds = new Map<string, FakeRefund>();
  readonly requests: RecordedRequest[] = [];
  /** Set to make the next call fail with this status and Cashfree error body. */
  failNext: { status: number; code: string; message: string } | null = null;
  /** Status every newly created refund starts in (Cashfree: usually PENDING). */
  refundStartStatus = 'PENDING';

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url).pathname.replace(/^\/pg/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    this.requests.push({ method, url, path, headers, body });

    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = null;
      return json(failure.status, { message: failure.message, code: failure.code, type: 'invalid_request_error' });
    }
    if (headers['x-client-secret'] !== FAKE_CASHFREE_SECRET) {
      return json(401, { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' });
    }

    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    // POST /orders
    if (method === 'POST' && parts.length === 1 && parts[0] === 'orders') {
      // Cashfree's REAL rule (Sandbox, API 2025-01-01 and 2026-01-01): the
      // expiry must be more than 15 minutes and less than 30 days away.
      const expiry = body?.['order_expiry_time'];
      if (expiry !== undefined) {
        const msAway = Date.parse(String(expiry)) - Date.now();
        if (!(msAway > 15 * 60_000 && msAway < 30 * 86_400_000)) {
          return json(400, {
            message: 'order_expiry_time : Expiry time should be more than 15 min and less than 30 days',
            code: 'order_expiry_time_invalid',
            type: 'invalid_request_error',
          });
        }
      }
      const orderId = String(body?.['order_id']);
      if (this.orders.has(orderId)) {
        return json(409, { message: 'order with same id is already present', code: 'order_already_exists', type: 'invalid_request_error' });
      }
      const order: FakeOrder = {
        order_id: orderId,
        order_amount: Number(body?.['order_amount']),
        order_currency: String(body?.['order_currency'] ?? 'INR'),
        order_status: 'ACTIVE',
        order_expiry_time: String(body?.['order_expiry_time'] ?? ''),
        payment_session_id: `session_${randomUUID().replace(/-/g, '')}`,
        order_tags: (body?.['order_tags'] ?? {}) as Record<string, string>,
        customer_details: (body?.['customer_details'] ?? {}) as Record<string, string>,
        payments: [],
      };
      this.orders.set(orderId, order);
      return json(200, { ...orderView(order), cf_order_id: String(this.orders.size) });
    }

    const order = parts[0] === 'orders' && parts[1] ? this.orders.get(parts[1]) : undefined;
    if (!order) return json(404, { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' });

    // GET /orders/:id
    if (method === 'GET' && parts.length === 2) return json(200, orderView(order));
    // GET /orders/:id/payments
    if (method === 'GET' && parts.length === 3 && parts[2] === 'payments') {
      return json(200, order.payments.map((p) => ({ ...p, order_id: order.order_id, payment_currency: 'INR' })));
    }
    // POST /orders/:id/refunds
    if (method === 'POST' && parts.length === 3 && parts[2] === 'refunds') {
      const refundId = String(body?.['refund_id']);
      if (this.refunds.has(refundId)) {
        return json(409, { message: 'Refund with the same refund_id already exists', code: 'refund_already_exists', type: 'invalid_request_error' });
      }
      const refund: FakeRefund = {
        cf_refund_id: String(900000 + this.refunds.size + 1),
        refund_id: refundId,
        order_id: order.order_id,
        refund_amount: Number(body?.['refund_amount']),
        refund_status: this.refundStartStatus,
      };
      this.refunds.set(refundId, refund);
      return json(200, refund);
    }
    // GET /orders/:id/refunds/:refundId
    if (method === 'GET' && parts.length === 4 && parts[2] === 'refunds') {
      const refund = parts[3] ? this.refunds.get(parts[3]) : undefined;
      return refund ? json(200, refund) : json(404, { message: 'refund not found', code: 'refund_not_found', type: 'invalid_request_error' });
    }
    return json(404, { message: 'not found', code: 'not_found', type: 'invalid_request_error' });
  }) as typeof fetch;

  reset(): void {
    this.orders.clear();
    this.refunds.clear();
    this.requests.length = 0;
    this.failNext = null;
    this.refundStartStatus = 'PENDING';
  }

  /** The customer completes (or fails) one attempt in Cashfree's checkout. */
  attempt(
    orderId: string,
    status: 'SUCCESS' | 'FAILED' | 'USER_DROPPED' | 'PENDING',
    options: { amountRupees?: number } = {},
  ): FakePayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`fake cashfree: no order ${orderId}`);
    const payment: FakePayment = {
      cf_payment_id: String(5000000000 + Math.floor(Math.random() * 1e9)),
      payment_status: status,
      payment_amount: options.amountRupees ?? order.order_amount,
      payment_group: 'upi',
      payment_message: status === 'SUCCESS' ? 'Transaction Successful' : status === 'USER_DROPPED' ? 'User dropped' : 'Payment failed',
      payment_time: nextTime(),
    };
    order.payments.push(payment);
    if (status === 'SUCCESS') order.order_status = 'PAID';
    return payment;
  }

  expire(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && order.order_status === 'ACTIVE') order.order_status = 'EXPIRED';
  }

  settleRefund(refundId: string, status: 'SUCCESS' | 'CANCELLED'): FakeRefund {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`fake cashfree: no refund ${refundId}`);
    refund.refund_status = status;
    return refund;
  }

  /** A webhook body as Cashfree sends it, signed with the secret. */
  paymentWebhook(
    type: 'PAYMENT_SUCCESS_WEBHOOK' | 'PAYMENT_FAILED_WEBHOOK' | 'PAYMENT_USER_DROPPED_WEBHOOK',
    orderId: string,
    payment: FakePayment,
  ): { raw: string; headers: Record<string, string> } {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`fake cashfree: no order ${orderId}`);
    return signed({
      data: {
        order: { order_id: order.order_id, order_amount: order.order_amount, order_currency: 'INR', order_tags: order.order_tags },
        payment: { ...payment, payment_currency: 'INR' },
        customer_details: order.customer_details,
      },
      event_time: nextTime(),
      type,
    });
  }

  refundWebhook(refundId: string): { raw: string; headers: Record<string, string> } {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`fake cashfree: no refund ${refundId}`);
    return signed({
      data: { refund: { ...refund, refund_currency: 'INR', refund_type: 'MERCHANT_INITIATED' } },
      event_time: nextTime(),
      type: 'REFUND_STATUS_WEBHOOK',
    });
  }
}

/**
 * One instance per test file's module graph: a `vi.mock` factory builds the
 * app's provider on it, and the test drives the same instance.
 */
export const sharedFakeCashfree = new FakeCashfree();

/** Signs a raw body exactly as Cashfree does: base64(HMAC-SHA256(secret, ts + raw)). */
export function signCashfreeWebhook(
  raw: string,
  secret: string = FAKE_CASHFREE_SECRET,
  timestamp: string = String(Date.now()),
): Record<string, string> {
  const signature = createHmac('sha256', secret).update(timestamp + raw).digest('base64');
  return {
    'content-type': 'application/json',
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp,
    'x-webhook-version': '2025-01-01',
  };
}

function signed(payload: unknown): { raw: string; headers: Record<string, string> } {
  const raw = JSON.stringify(payload);
  return { raw, headers: signCashfreeWebhook(raw) };
}

function orderView(order: FakeOrder): Record<string, unknown> {
  const { payments: _payments, ...view } = order;
  return { ...view, entity: 'order' };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
