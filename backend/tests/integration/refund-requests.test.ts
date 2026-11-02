/**
 * Refund management — Phase 3 (the customer's consolidated refunds) and
 * Phase 4 (customer refund requests, admin approval / rejection).
 *
 *   - GET /orders/:id/refunds: one entry per refund group — never seller-wise,
 *     never a Cashfree id; someone else's order is a 404; refunds issued
 *     before groups are shown one by one, never grouped after the fact;
 *   - requests: delivered orders only, inside the window; the server values
 *     the items (a client amount is ignored); photos for damaged / wrong /
 *     quality issues, stored privately; one request under review per order;
 *   - admin (ORDER_REFUND only): approve (all, or a lower amount), reject,
 *     with notes and an audit trail; approval revalidates what is still
 *     refundable and refunds through the existing Cashfree engine — or, for
 *     Cash on Delivery, opens a MANUAL group and never calls Cashfree.
 *
 * The fake Cashfree stands in for the gateway; nothing real is called.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Customer refund requests are switched off in the app for now
// (refund-requests-availability.ts); the implementation is kept, and these
// tests exercise it with the switch on.
vi.mock('../../src/modules/refunds/refund-requests-availability', () => ({
  CUSTOMER_REFUND_REQUESTS_ENABLED: true,
  refundRequestsAvailable: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

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

import { ConfigKey, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedStore } from '../helpers/fixtures';
import {
  COD,
  PAID,
  cancelAsCustomer,
  deliver,
  gatewayRefundedPaise,
  panelToken,
  placeOrder,
  twoSellers,
  type Placed,
} from '../helpers/refund-fixtures';

const CUSTOMER = '9400000411';
const OTHER = '9400000412';
let storeId: string;

/** The first bytes of a PNG — the server checks the bytes, not the claimed type. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  cashfree.refundStartStatus = 'SUCCESS';
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  // The worked example (₹1,600) exceeds the first-order COD cap.
  await configService.set({ key: ConfigKey.COD_FIRST_ORDER_MAX_PAISE, value: 300_000 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
});

interface OrderRefunds {
  refunds: { id: string; kind: string; status: string; title: string; amountPaise: number; refundedPaise: number; destination: string }[];
  request: { eligible: boolean; reason: string | null; refundableItemIds: string[]; windowEndsAt: string | null };
}

const refundsOf = async (placed: Placed, token = placed.token) =>
  expectSuccess<OrderRefunds>((await api().get(`/api/v1/orders/${placed.orderId}/refunds`).set('Authorization', bearer(token)).expect(200)).body)
    .data;

function submit(
  placed: Placed,
  body: { category: string; description: string; items: unknown; amountPaise?: number },
  photos: Buffer[] = [],
) {
  let req = api()
    .post(`/api/v1/orders/${placed.orderId}/refund-requests`)
    .set('Authorization', bearer(placed.token))
    .field('category', body.category)
    .field('description', body.description)
    .field('items', JSON.stringify(body.items));
  if (body.amountPaise !== undefined) req = req.field('amountPaise', String(body.amountPaise));
  for (const [i, photo] of photos.entries()) req = req.attach('photos', photo, { filename: `p${i}.png`, contentType: 'image/png' });
  return req;
}

/** A delivered two-seller order (Seller A ₹600 x2, Seller B ₹400). */
async function deliveredOrder(method = PAID) {
  const { a, b, aListing, bListing } = await twoSellers(storeId);
  const placed = await placeOrder(CUSTOMER, [{ listingId: aListing, qty: 2 }, { listingId: bListing }], method);
  const admin = await panelToken();
  await deliver(admin.token, placed);
  const [itemA] = await placed.itemsOf(a);
  const [itemB] = await placed.itemsOf(b);
  return { placed, admin, a, b, itemA: itemA!, itemB: itemB! };
}

/* -------------------------------------------------------------------------- */
/* Phase 3 — the customer's consolidated view                                 */
/* -------------------------------------------------------------------------- */

describe('GET /orders/:id/refunds', () => {
  it('a two-seller cancellation is ONE refund — no seller split, no Cashfree id', async () => {
    const { aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    await cancelAsCustomer(placed).expect(200);

    const res = await api().get(`/api/v1/orders/${placed.orderId}/refunds`).set('Authorization', bearer(placed.token)).expect(200);
    const data = expectSuccess<OrderRefunds>(res.body).data;
    expect(data.refunds).toHaveLength(1);
    expect(data.refunds[0]).toMatchObject({
      kind: 'REFUND',
      status: 'SUCCESS',
      statusLabel: 'Refunded',
      amountPaise: placed.totalPaise,
      refundedPaise: placed.totalPaise,
      destination: 'ORIGINAL_PAYMENT',
    });
    const raw = JSON.stringify(res.body);
    const refundRows = await prisma.refund.findMany({ where: { orderId: placed.orderId } });
    for (const r of refundRows) {
      expect(raw).not.toContain(r.id);
      if (r.providerRefundId) expect(raw).not.toContain(r.providerRefundId);
      if (r.sellerOrderId) expect(raw).not.toContain(r.sellerOrderId);
    }
    expect(raw).not.toMatch(/seller/i);
    // Not delivered: no request entry point, and no reason to show.
    expect(data.request).toMatchObject({ eligible: false, reason: null });
  });

  it("someone else's order is a 404", async () => {
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    await otpService.clearOtpState(OTHER);
    const other = await loginAs(OTHER);
    await api().get(`/api/v1/orders/${placed.orderId}/refunds`).set('Authorization', bearer(other.accessToken)).expect(404);
  });

  it('refunds issued before groups are listed one by one, exactly as issued — never grouped after the fact', async () => {
    const { aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    await cancelAsCustomer(placed).expect(200);
    // As the old code left them: no group.
    await prisma.$executeRawUnsafe(`UPDATE refunds SET group_id = NULL WHERE order_id = '${placed.orderId}'`);
    const rows = await prisma.refund.findMany({ where: { orderId: placed.orderId } });

    const data = await refundsOf(placed);
    const legacy = data.refunds.filter((r) => r.kind === 'LEGACY');
    expect(legacy).toHaveLength(rows.length);
    expect(legacy.map((r) => r.amountPaise).sort()).toEqual(rows.map((r) => r.amountPaise).sort());
    expect(legacy.every((r) => r.status === 'SUCCESS')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase 4 — customer requests                                                */
/* -------------------------------------------------------------------------- */

describe('customer refund requests', () => {
  it('a delivered order can ask — the server values the items and ignores any amount sent', async () => {
    const { placed, itemA } = await deliveredOrder();
    const before = await refundsOf(placed);
    expect(before.request.eligible).toBe(true);
    expect(before.request.refundableItemIds).toContain(itemA.id);

    const res = await submit(
      placed,
      { category: 'MISSING_ITEM', description: 'One packet was missing from the bag.', items: [{ orderItemId: itemA.id, qty: 1 }], amountPaise: 999_999 },
    ).expect(201);
    const request = expectSuccess<{ id: string; requestedPaise: number; status: string }>(res.body).data;
    // One of two ₹600 units: ₹600 — never the ₹9,999.99 the client sent.
    expect(request).toMatchObject({ requestedPaise: 60000, status: 'UNDER_REVIEW' });

    const after = await refundsOf(placed);
    expect(after.request).toMatchObject({ eligible: false, reason: expect.stringContaining('being reviewed') });
    expect(after.refunds).toEqual([expect.objectContaining({ kind: 'REQUEST', status: 'UNDER_REVIEW', amountPaise: 60000 })]);
    // Customer acknowledged, admins told.
    expect(await prisma.notification.count({ where: { dedupeKey: `refund-request:${request.id}:RECEIVED` } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'ADMIN_REFUND_REQUEST' } })).toBeGreaterThan(0);
  });

  it('damaged / wrong / quality issues need a photo; photos must really be images; stored privately', async () => {
    const { placed, itemB } = await deliveredOrder();
    const body = { category: 'DAMAGED_ITEM', description: 'The jar arrived cracked and leaking.', items: [{ orderItemId: itemB.id, qty: 1 }] };
    await submit(placed, body).expect(400);
    // A "PNG" that is not one.
    await submit(placed, body, [Buffer.from('definitely not an image at all')]).expect(415);

    const res = await submit(placed, body, [PNG, PNG]).expect(201);
    const id = expectSuccess<{ id: string; photoCount: number }>(res.body).data.id;
    const evidence = await prisma.refundRequestEvidence.findMany({ where: { requestId: id } });
    expect(evidence).toHaveLength(2);
    for (const e of evidence) {
      expect(e.storageKey).toMatch(new RegExp(`^refund-evidence/${id}/[0-9a-f-]{36}\\.png$`));
      expect(e.contentType).toBe('image/png');
    }
    // No URL to it anywhere in what the customer gets back.
    expect(JSON.stringify(res.body)).not.toContain('refund-evidence/');
  });

  it('one request under review per order — duplicates and concurrent submissions are refused', async () => {
    const { placed, itemA, itemB } = await deliveredOrder();
    const results = await Promise.all([
      submit(placed, { category: 'MISSING_ITEM', description: 'Missing one packet of this.', items: [{ orderItemId: itemA.id, qty: 1 }] }),
      submit(placed, { category: 'MISSING_ITEM', description: 'Missing one packet of that.', items: [{ orderItemId: itemB.id, qty: 1 }] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.refundRequest.count({ where: { orderId: placed.orderId } })).toBe(1);
  });

  it('not before delivery, not after the window, not for items of another order', async () => {
    const { aListing } = await twoSellers(storeId, ['9400000421', '9400000422']);
    const undelivered = await placeOrder(OTHER, [{ listingId: aListing }], PAID);
    const [item] = await prisma.orderItem.findMany({ where: { sellerOrder: { orderId: undelivered.orderId } } });
    await submit(undelivered, { category: 'OTHER', description: 'Something is not right here.', items: [{ orderItemId: item!.id, qty: 1 }] }).expect(400);

    const { placed, itemA } = await deliveredOrder();
    // Someone else's item id.
    await submit(placed, { category: 'OTHER', description: 'Something is not right here.', items: [{ orderItemId: item!.id, qty: 1 }] }).expect(400);
    // More than was bought.
    await submit(placed, { category: 'OTHER', description: 'Something is not right here.', items: [{ orderItemId: itemA.id, qty: 3 }] }).expect(400);

    await prisma.order.update({ where: { id: placed.orderId }, data: { deliveredAt: new Date(Date.now() - 8 * 24 * 3600_000) } });
    expect((await refundsOf(placed)).request).toMatchObject({ eligible: false, reason: expect.stringContaining('within 7 days') });
    await submit(placed, { category: 'OTHER', description: 'Something is not right here.', items: [{ orderItemId: itemA.id, qty: 1 }] }).expect(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase 4 — admin review                                                     */
/* -------------------------------------------------------------------------- */

async function requestOn(placed: Placed, items: { orderItemId: string; qty: number }[], category = 'MISSING_ITEM') {
  const res = await submit(placed, { category, description: 'Items were missing from the delivery.', items }, category === 'MISSING_ITEM' ? [] : [PNG]).expect(201);
  return expectSuccess<{ id: string; requestedPaise: number }>(res.body).data;
}

const approve = (token: string, id: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/admin/refund-requests/${id}/approve`).set('Authorization', bearer(token)).send(body);
const reject = (token: string, id: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/admin/refund-requests/${id}/reject`).set('Authorization', bearer(token)).send(body);

describe('admin review of refund requests', () => {
  it('STAFF cannot list, read, approve or reject (ORDER_REFUND only); a customer cannot either', async () => {
    const { placed, itemA } = await deliveredOrder();
    const request = await requestOn(placed, [{ orderItemId: itemA.id, qty: 1 }]);
    const staff = await panelToken(UserRole.STAFF);
    await api().get('/api/v1/admin/refund-requests').set('Authorization', bearer(staff.token)).expect(403);
    await api().get(`/api/v1/admin/refund-requests/${request.id}`).set('Authorization', bearer(staff.token)).expect(403);
    await approve(staff.token, request.id, { decisionNote: 'Looks fine to me.' }).expect(403);
    await reject(staff.token, request.id, { decisionNote: 'Not eligible at all.' }).expect(403);
    await approve(placed.token, request.id, { decisionNote: 'I approve my own.' }).expect(403);
    expect((await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('UNDER_REVIEW');
  });

  it('approving a LOWER amount across two sellers: one group, one component per seller, proportional, refunded through Cashfree', async () => {
    const { placed, admin, a, b, itemA, itemB } = await deliveredOrder();
    const request = await requestOn(placed, [
      { orderItemId: itemA.id, qty: 1 },
      { orderItemId: itemB.id, qty: 1 },
    ]);
    expect(request.requestedPaise).toBe(100000); // ₹600 + ₹400

    await approve(admin.token, request.id, { approvedPaise: 50000, decisionNote: 'Half — one item was found later.' }).expect(200);

    const row = await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row).toMatchObject({ status: 'APPROVED', approvedPaise: 50000, reviewedByUserId: admin.userId });
    const group = await prisma.refundGroup.findUniqueOrThrow({ where: { id: row.groupId! }, include: { refunds: true } });
    expect(group).toMatchObject({ origin: 'CUSTOMER_REQUEST', channel: 'CASHFREE', postDelivery: true, status: 'SUCCESS', totalPaise: 50000 });
    const bySeller = Object.fromEntries(group.refunds.map((r) => [r.sellerOrderId, r.amountPaise]));
    expect(bySeller).toEqual({ [placed.sellerOrderOf(a)]: 30000, [placed.sellerOrderOf(b)]: 20000 });
    expect(group.refunds.every((r) => r.componentType === 'SELLER_PRODUCT')).toBe(true);
    expect(gatewayRefundedPaise()).toBe(50000);
    // The order stays DELIVERED; its payment records the partial refund.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).toMatchObject({
      status: 'DELIVERED',
      paymentStatus: 'PARTIALLY_REFUNDED',
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'refund_request.approve', entityId: request.id } });
    expect(audit.actorUserId).toBe(admin.userId);
    expect(audit.after).toMatchObject({ approvedPaise: 50000, groupId: group.id });

    // The customer sees one refund for the request.
    const view = await refundsOf(placed);
    expect(view.refunds).toEqual([expect.objectContaining({ kind: 'REFUND', status: 'SUCCESS', amountPaise: 50000 })]);
    // Deciding again is refused.
    await approve(admin.token, request.id, { decisionNote: 'Approve again please.' }).expect(409);
    await reject(admin.token, request.id, { decisionNote: 'Changed my mind.' }).expect(409);
  });

  it('a later request is capped by what earlier approvals already gave back for the item', async () => {
    const { placed, admin, itemA } = await deliveredOrder();
    const first = await requestOn(placed, [{ orderItemId: itemA.id, qty: 2 }]);
    expect(first.requestedPaise).toBe(120000);
    await approve(admin.token, first.id, { approvedPaise: 100000, decisionNote: 'Most of it, fair enough.' }).expect(200);

    // ₹200 of that line is left.
    const second = await requestOn(placed, [{ orderItemId: itemA.id, qty: 2 }], 'QUALITY_ISSUE');
    expect(second.requestedPaise).toBe(20000);
    await approve(admin.token, second.id, { approvedPaise: 20001, decisionNote: 'A paisa too many.' }).expect(400);
    await approve(admin.token, second.id, { decisionNote: 'The rest of it.' }).expect(200);
    expect(gatewayRefundedPaise()).toBe(120000);

    // Nothing left for that line.
    const view = await refundsOf(placed);
    expect(view.request.refundableItemIds).not.toContain(itemA.id);
  });

  it('rejecting: a reason, an audit, a notice — and no money moves', async () => {
    const { placed, admin, itemA } = await deliveredOrder();
    const request = await requestOn(placed, [{ orderItemId: itemA.id, qty: 1 }]);
    await reject(admin.token, request.id, { decisionNote: 'x' }).expect(400);
    await reject(admin.token, request.id, { decisionNote: 'The delivery photo shows every item.' }).expect(200);

    expect(await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
      status: 'REJECTED',
      approvedPaise: null,
      groupId: null,
      decisionNote: 'The delivery photo shows every item.',
    });
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(0);
    expect(cashfree.refunds.size).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'refund_request.reject', entityId: request.id } })).toBe(1);
    const notice = await prisma.notification.findFirstOrThrow({ where: { dedupeKey: `refund-request:${request.id}:REJECTED` } });
    expect(notice.body).toContain('The delivery photo shows every item.');
    const view = await refundsOf(placed);
    expect(view.refunds).toEqual([expect.objectContaining({ kind: 'REQUEST', status: 'REJECTED', statusLabel: 'Not approved' })]);
    // A new request may follow a rejection.
    expect(view.request.eligible).toBe(true);
  });

  it('evidence photos are read only through the admin endpoint (audited), never by a customer', async () => {
    const { placed, admin, itemB } = await deliveredOrder();
    const request = await requestOn(placed, [{ orderItemId: itemB.id, qty: 1 }], 'DAMAGED_ITEM');
    const detail = expectSuccess<{ evidence: { id: string }[] }>(
      (await api().get(`/api/v1/admin/refund-requests/${request.id}`).set('Authorization', bearer(admin.token)).expect(200)).body,
    ).data;
    expect(detail.evidence).toHaveLength(1);
    const photo = await api()
      .get(`/api/v1/admin/refund-requests/${request.id}/evidence/${detail.evidence[0]!.id}`)
      .set('Authorization', bearer(admin.token))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(photo.headers['content-type']).toContain('image/png');
    expect(photo.headers['cache-control']).toContain('no-store');
    expect(Buffer.compare(photo.body as Buffer, PNG)).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'refund_request.evidence_view', entityId: request.id } })).toBe(1);
    await api()
      .get(`/api/v1/admin/refund-requests/${request.id}/evidence/${detail.evidence[0]!.id}`)
      .set('Authorization', bearer(placed.token))
      .expect(403);
  });

  it('Cash on Delivery: approval opens a MANUAL group (approved, not success) and never calls Cashfree', async () => {
    const { placed, admin, itemA } = await deliveredOrder(COD);
    const request = await requestOn(placed, [{ orderItemId: itemA.id, qty: 1 }]);
    const calls = cashfree.requests.length;
    await approve(admin.token, request.id, { decisionNote: 'Customer confirmed by phone.' }).expect(200);

    const row = await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    const group = await prisma.refundGroup.findUniqueOrThrow({ where: { id: row.groupId! } });
    expect(group).toMatchObject({ channel: 'MANUAL', status: 'APPROVED', totalPaise: 60000, refundedPaise: 0, postDelivery: true });
    expect(cashfree.requests.length).toBe(calls);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(0);
    const view = await refundsOf(placed);
    expect(view.refunds).toEqual([expect.objectContaining({ status: 'APPROVED', destination: 'BANK_TRANSFER', refundedPaise: 0 })]);
  });
});
