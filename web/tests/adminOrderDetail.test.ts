/**
 * The admin Orders page's complete order details (src/lib/v2Orders.ts
 * `toAdminOrderDetailView` + display rules, src/pages/AdminOrderDetail.tsx)
 * — run with `npm run test:unit`. The raw shape is GET /admin/orders/:id's;
 * the server side: backend tests/integration/admin-order-detail.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  customerRefunds,
  lineTotalMeasure,
  orderItemTotals,
  paymentMethodLabel,
  paymentStatusView,
  toAdminOrderDetailView,
} from '../src/lib/v2Orders.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/* Fixtures: the API's own field names ------------------------------------- */

const item = (over: Record<string, unknown>) => ({
  id: `item-${Math.random().toString(36).slice(2)}`,
  productName: 'Garlic',
  variantName: '500 g',
  brandName: null,
  imageUrl: 'https://cdn.example/garlic.webp',
  sku: 'GARLIC-500G',
  unitDisplay: '500 g',
  optionValues: {},
  qty: 2,
  mrpPaise: 7000,
  unitPricePaise: 6500,
  lineTotalPaise: 13000,
  commissionPaise: 650,
  measure: { unit: 'G', unitValue: 500 },
  ...over,
});

const history = (id: string, toStatus: string, at: string, actor: Record<string, unknown> | null = null, reason: string | null = null) => ({
  id,
  fromStatus: null,
  toStatus,
  actorType: actor ? 'ADMIN' : 'SYSTEM',
  actor,
  reason,
  metadata: { internal: true },
  createdAt: at,
});

function rawOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'AD2611070001',
    status: 'PROCESSING',
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    itemsSubtotalPaise: 52000,
    itemDiscountPaise: 4000,
    couponCode: null,
    couponDiscountPaise: 0,
    deliveryFeePaise: 2000,
    platformFeePaise: 500,
    taxPaise: 0,
    totalPaise: 54500,
    currentPayablePaise: 54500,
    deliveryFullName: 'Ravi Kumar',
    deliveryMobile: '9876543210',
    deliveryLabel: 'Home',
    deliveryAddressLine: '12 Station Road',
    deliveryLandmark: 'Near the temple',
    deliveryCity: 'Railmagra',
    deliveryDistrict: 'Rajsamand',
    deliveryState: 'Rajasthan',
    deliveryPincode: '313329',
    deliveryMode: 'SAVED_ADDRESS',
    deliveryLatitude: 25.0,
    deliveryLongitude: 74.1,
    notes: null,
    cancellationReason: null,
    deliveryOtpHash: 'f'.repeat(64),
    idempotencyKey: 'secret-key',
    placedAt: '2026-11-07T04:30:00.000Z',
    createdAt: '2026-11-07T04:29:00.000Z',
    user: { id: 'u1', fullName: 'Ravi Kumar', mobile: '9876543210', email: 'ravi@example.com' },
    deliveryTasks: [{ agent: { name: 'Mohan', mobile: '9000000000' } }],
    statusHistory: [history('h1', 'PROCESSING', '2026-11-07T04:30:00.000Z')],
    payments: [],
    refunds: [],
    sellerOrders: [
      {
        id: 'so-a',
        status: 'ACCEPTED',
        subtotalPaise: 25000,
        commissionPaise: 1250,
        seller: { id: 's1', name: 'Aadione Grocery Store' },
        items: [
          item({ productName: 'Garlic', variantName: '500 g', qty: 2, unitPricePaise: 6500, lineTotalPaise: 13000 }),
          item({ productName: 'Garlic', variantName: '1 kg', sku: 'GARLIC-1KG', qty: 1, unitPricePaise: 12000, lineTotalPaise: 12000, measure: { unit: 'KG', unitValue: 1 } }),
        ],
        statusHistory: [history('sh1', 'ACCEPTED', '2026-11-07T04:35:00.000Z', { fullName: 'Shop Owner', passwordHash: 'x' })],
      },
      {
        id: 'so-b',
        status: 'NEW',
        subtotalPaise: 27000,
        commissionPaise: 1350,
        seller: { id: 's2', name: 'Rice Mart' },
        items: [item({ productName: 'Basmati Rice', variantName: '1 kg', sku: 'RICE-1KG', qty: 3, unitPricePaise: 9000, lineTotalPaise: 27000, imageUrl: null, measure: { unit: 'KG', unitValue: 1 } })],
        statusHistory: [],
      },
    ],
    ...over,
  };
}

/* Tests -------------------------------------------------------------------- */

describe('order lines: the chosen size and the ordered quantity are separate', () => {
  const view = toAdminOrderDetailView(rawOrder());
  const lines = view.sellerOrders.flatMap((so) => so.items);

  it('keeps each line\'s snapshot as stored (image, name, size, SKU, qty, unit price, line total)', () => {
    assert.deepEqual(
      lines.map((line) => [line.productName, line.variantName, line.sku, line.qty, line.unitPricePaise, line.lineTotalPaise]),
      [
        ['Garlic', '500 g', 'GARLIC-500G', 2, 6500, 13000],
        ['Garlic', '1 kg', 'GARLIC-1KG', 1, 12000, 12000],
        ['Basmati Rice', '1 kg', 'RICE-1KG', 3, 9000, 27000],
      ],
    );
    assert.equal(lines[0]!.imageUrl, 'https://cdn.example/garlic.webp');
    // A missing image stays missing (the UI shows its placeholder), never another product's.
    assert.equal(lines[2]!.imageUrl, null);
  });

  it('the total weight / volume comes from the structured unit × the ordered quantity', () => {
    assert.equal(lineTotalMeasure(lines[0]!.measure, lines[0]!.qty), '1 kg'); // 500 g × 2
    assert.equal(lineTotalMeasure(lines[2]!.measure, lines[2]!.qty), '3 kg'); // 1 kg × 3
    assert.equal(lineTotalMeasure({ unit: 'ML', unitValue: 250 }, 3), '750 ml');
    assert.equal(lineTotalMeasure({ unit: 'G', unitValue: 750 }, 2), '1.5 kg');
    assert.equal(lineTotalMeasure({ unit: 'L', unitValue: 1 }, 2), '2 L');
    // Pieces / packs: the quantity already says it; unknown (variant changed): nothing.
    assert.equal(lineTotalMeasure({ unit: 'PIECE', unitValue: 1 }, 4), null);
    assert.equal(lineTotalMeasure(null, 2), null);
  });

  it('two sizes of the same product stay two lines; multi-seller items stay with their seller', () => {
    assert.deepEqual(view.sellerOrders.map((so) => [so.sellerName, so.items.length, so.subtotalPaise]), [
      ['Aadione Grocery Store', 2, 25000],
      ['Rice Mart', 1, 27000],
    ]);
    assert.deepEqual(orderItemTotals(view.sellerOrders), { products: 3, units: 6 });
    // One consolidated customer total, never a sum of per-seller totals plus fees twice.
    assert.equal(view.bill.totalPaise, 54500);
    assert.equal(view.sellerOrders.reduce((sum, so) => sum + so.subtotalPaise, 0), view.bill.itemsSubtotalPaise);
  });

  it('option picks are kept with their names', () => {
    const shirt = toAdminOrderDetailView(
      rawOrder({ sellerOrders: [{ id: 'so', status: 'NEW', subtotalPaise: 50000, seller: { name: 'Ram Dev Clothing' }, items: [item({ productName: 'Shirt', variantName: 'M / Black', optionValues: { Size: 'M', Color: 'Black' }, measure: null })], statusHistory: [] }] }),
    );
    assert.deepEqual(shirt.sellerOrders[0]!.items[0]!.options, [['Size', 'M'], ['Color', 'Black']]);
  });
});

describe('payment: method and status are separate; status is the server\'s', () => {
  it('COD not yet collected', () => {
    const view = toAdminOrderDetailView(rawOrder());
    assert.equal(paymentMethodLabel(view.paymentMethod, view.payments), 'Cash on Delivery');
    assert.deepEqual(paymentStatusView(view.paymentMethod, view.paymentStatus), { label: 'To collect on delivery', tone: 'amber' });
  });

  it('online, paid by UPI: the instrument and the gateway reference', () => {
    const view = toAdminOrderDetailView(
      rawOrder({
        paymentMethod: 'ONLINE',
        paymentStatus: 'PAID',
        payments: [
          { id: 'p0', provider: 'cashfree', method: null, status: 'FAILED', amountPaise: 54500, providerOrderId: 'cf_order_1', providerPaymentId: null, failureReason: 'User dropped', capturedAt: null, createdAt: '2026-11-07T04:29:10.000Z', rawPayload: { secret: true } },
          { id: 'p1', provider: 'cashfree', method: 'upi', status: 'CAPTURED', amountPaise: 54500, providerOrderId: 'cf_order_1', providerPaymentId: 'cf_pay_123', failureReason: null, capturedAt: '2026-11-07T04:30:00.000Z', createdAt: '2026-11-07T04:29:40.000Z', rawPayload: { secret: true } },
        ],
      }),
    );
    assert.equal(paymentMethodLabel(view.paymentMethod, view.payments), 'Online · UPI');
    assert.deepEqual(paymentStatusView(view.paymentMethod, view.paymentStatus), { label: 'Paid', tone: 'brand' });
    assert.deepEqual(view.payments.map((p) => [p.status, p.reference, p.failureReason]), [
      ['FAILED', 'cf_order_1', 'User dropped'],
      ['CAPTURED', 'cf_pay_123', null],
    ]);
  });

  it('online, failed: never shown as paid — even if an attempt says CAPTURED, the order\'s status decides', () => {
    const view = toAdminOrderDetailView(
      rawOrder({
        status: 'PAYMENT_FAILED',
        paymentMethod: 'ONLINE',
        paymentStatus: 'FAILED',
        payments: [{ id: 'p1', provider: 'cashfree', method: 'card', status: 'CAPTURED', amountPaise: 54500, providerOrderId: 'o', providerPaymentId: 'x', capturedAt: null, createdAt: '2026-11-07T04:29:40.000Z' }],
      }),
    );
    assert.deepEqual(paymentStatusView(view.paymentMethod, view.paymentStatus), { label: 'Failed', tone: 'red' });
    assert.equal(paymentMethodLabel(view.paymentMethod, view.payments), 'Online · Card');
    assert.equal(paymentMethodLabel('ONLINE', []), 'Online payment');
  });
});

describe('refunds as the customer received them', () => {
  const rows = (refunds: Record<string, unknown>[]) =>
    toAdminOrderDetailView(rawOrder({ paymentMethod: 'ONLINE', paymentStatus: 'PARTIALLY_REFUNDED', refunds })).refunds;
  const refund = (over: Record<string, unknown>) => ({ id: 'r', amountPaise: 0, status: 'COMPLETED', componentType: null, reason: null, failureReason: null, providerRefundId: null, groupId: null, retryOfId: null, createdAt: '2026-11-07T06:00:00.000Z', completedAt: null, ...over });

  it('partially refunded: one seller\'s items + its delivery share are ONE customer refund', () => {
    const summary = customerRefunds(
      rows([
        refund({ id: 'r1', amountPaise: 27000, componentType: 'SELLER_PRODUCT', groupId: 'g1', reason: 'Seller rejected' }),
        refund({ id: 'r2', amountPaise: 2000, componentType: 'DELIVERY_FEE', groupId: 'g1' }),
      ]),
    );
    assert.equal(summary.refunds.length, 1);
    assert.deepEqual([summary.refunds[0]!.amountPaise, summary.refunds[0]!.status, summary.refunds[0]!.parts], [29000, 'COMPLETED', ['Items', 'Delivery fee']]);
    assert.equal(summary.refundedPaise, 29000);
    assert.equal(summary.pendingPaise, 0);
  });

  it('fully refunded with a failed attempt that was retried: counted once, by the retry', () => {
    const summary = customerRefunds(
      rows([
        refund({ id: 'r1', amountPaise: 54500, componentType: 'FULL_ORDER', status: 'FAILED', failureReason: 'Gateway timeout' }),
        refund({ id: 'r2', amountPaise: 54500, componentType: 'FULL_ORDER', retryOfId: 'r1', providerRefundId: 'cf_ref_9' }),
      ]),
    );
    assert.equal(summary.refunds.length, 1);
    assert.deepEqual([summary.refunds[0]!.status, summary.refunds[0]!.reference], ['COMPLETED', 'cf_ref_9']);
    assert.equal(summary.refundedPaise, 54500);
  });

  it('in progress is shown apart from refunded', () => {
    const summary = customerRefunds(rows([refund({ id: 'r1', amountPaise: 12000, status: 'PROCESSING' })]));
    assert.deepEqual([summary.refundedPaise, summary.pendingPaise, summary.refunds[0]!.status], [0, 12000, 'PENDING']);
  });
});

describe('order information, cancellation, older orders', () => {
  it('customer, delivery address, rider, bill and a merged status history', () => {
    const view = toAdminOrderDetailView(rawOrder());
    assert.deepEqual(view.customer, { name: 'Ravi Kumar', mobile: '9876543210', email: 'ravi@example.com' });
    assert.equal(view.delivery.agentName, 'Mohan');
    assert.equal(view.delivery.landmark, 'Near the temple');
    assert.deepEqual(view.bill, {
      itemsSubtotalPaise: 52000,
      mrpSavingsPaise: 4000,
      couponCode: null,
      couponDiscountPaise: 0,
      deliveryFeePaise: 2000,
      platformFeePaise: 500,
      taxPaise: 0,
      totalPaise: 54500,
    });
    assert.deepEqual(view.history.map((entry) => [entry.scope, entry.toStatus, entry.actorName]), [
      ['Order', 'PROCESSING', null],
      ['Aadione Grocery Store', 'ACCEPTED', 'Shop Owner'],
    ]);
  });

  it('cancelled orders keep their reason and the payable after cancellations', () => {
    const view = toAdminOrderDetailView(rawOrder({ status: 'CANCELLED', cancellationReason: 'Customer asked', currentPayablePaise: 0 }));
    assert.equal(view.cancellationReason, 'Customer asked');
    assert.equal(view.currentPayablePaise, 0);
  });

  it('an older order without the newer fields still opens (0 / null, never NaN or a crash)', () => {
    const old = rawOrder();
    for (const key of ['itemDiscountPaise', 'platformFeePaise', 'taxPaise', 'deliveryLandmark', 'deliveryDistrict', 'deliveryMode', 'placedAt', 'payments', 'refunds', 'deliveryTasks', 'statusHistory', 'user']) {
      delete (old as Record<string, unknown>)[key];
    }
    (old.sellerOrders[0]!.items[0] as Record<string, unknown>)['measure'] = undefined;
    delete (old.sellerOrders[0]!.items[0] as Record<string, unknown>)['mrpPaise'];
    const view = toAdminOrderDetailView(old);
    assert.equal(view.bill.platformFeePaise, 0);
    assert.equal(view.placedAt, '2026-11-07T04:29:00.000Z');
    assert.equal(view.delivery.mode, 'SAVED_ADDRESS');
    assert.deepEqual([view.payments, view.refunds], [[], []]);
    assert.equal(view.sellerOrders[0]!.items[0]!.measure, null);
    assert.equal(view.sellerOrders[0]!.items[0]!.mrpPaise, 0);
  });

  it('nothing sensitive is kept: no OTP hash, idempotency key, payment payload or actor account fields', () => {
    const view = JSON.stringify(
      toAdminOrderDetailView(
        rawOrder({ payments: [{ id: 'p', provider: 'cashfree', method: 'upi', status: 'CAPTURED', amountPaise: 1, providerPaymentId: 'x', createdAt: '2026-11-07T04:29:40.000Z', rawPayload: { secret: 'payload' } }] }),
      ),
    );
    for (const secret of ['deliveryOtpHash', 'secret-key', 'payload', 'passwordHash', 'commissionPaise', '"metadata"']) {
      assert.equal(view.includes(secret), false, secret);
    }
  });
});

describe('the admin Orders page', () => {
  const orders = read('src/pages/Orders.tsx');
  const detail = read('src/pages/AdminOrderDetail.tsx');

  it('the expanded row is the complete order, with each seller\'s existing actions', () => {
    assert.match(orders, /<AdminOrderDetail\n\s*view=\{detail\.data\}\n\s*sellerActions=\{\(sellerOrder\) => \{/);
    assert.match(orders, /onClick=\{\(\) => onAction\(orderId, sellerOrder, SellerOrderStatus\.REJECTED\)\}/);
    assert.match(orders, /onClick=\{\(\) => onAction\(orderId, sellerOrder, next\.to\)\}/);
    // Display only: the detail component sends nothing.
    assert.doesNotMatch(detail, /api\.(get|post|patch|put|delete)|useMutation/);
  });

  it('list rows: products and units apart, the placed date, method and status apart', () => {
    assert.match(orders, /\{order\.lineItemCount\} product\{order\.lineItemCount === 1 \? "" : "s"\} · \{order\.itemCount\} unit/);
    assert.match(orders, /placedAtFormat\.format\(new Date\(order\.placedAt\)\)/);
    assert.match(orders, /\{order\.paymentMethod === PaymentMethod\.COD \? "COD" : manualPayments \? "UPI" : "Online"\}/);
    assert.match(orders, /paymentStatusView\(order\.paymentMethod, order\.paymentStatus\)\.label/);
  });

  it('every line shows its size and its ordered quantity as two values, with the photo uncropped', () => {
    assert.match(detail, /<Thumb src=\{item\.imageUrl\} alt=\{item\.productName\} size="lg" fit="contain" \/>/);
    assert.match(detail, /'Unit \/ size'/);
    assert.match(detail, /Quantity ordered/);
    assert.match(detail, /lineTotalMeasure\(item\.measure, item\.qty\)/);
    assert.match(read('src/components/ui.tsx'), /fit === 'contain' \? 'object-contain p-1' : 'object-cover'/);
  });

  it('one bill (the customer\'s total), the payment, refunds, customer & delivery and the history', () => {
    for (const label of ['Item subtotal', 'Delivery fee', 'Platform fee', 'Coupon', 'Total', 'Method', 'Status', 'Refunded', 'Customer &amp; delivery', 'Status history']) {
      assert.ok(detail.includes(label), label);
    }
  });
});
