/**
 * Customer refund requests are TEMPORARILY switched off
 * (src/modules/refunds/refund-requests-availability.ts) — checked with the
 * real switch (no mock), end to end:
 *
 *   - POST /orders/:id/refund-requests and GET /refund-requests/:id answer
 *     403 REFUND_REQUESTS_DISABLED with a clear message; nothing is written,
 *     no photo stored, no notification sent;
 *   - the order's refunds summary never offers a request;
 *   - everything else is untouched: the automatic refund of a cancelled paid
 *     order, existing request records, and the admin refund screens.
 */

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

import { ConfigKey, ErrorCode } from '../../src/shared';
import { api, bearer, expectError, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { CUSTOMER_REFUND_REQUESTS_ENABLED } from '../../src/modules/refunds/refund-requests-availability';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedStore } from '../helpers/fixtures';
import { PAID, cancelAsCustomer, deliver, panelToken, placeOrder, twoSellers } from '../helpers/refund-fixtures';

const CUSTOMER = '9400000491';
let storeId: string;

/** The first bytes of a PNG. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  cashfree.refundStartStatus = 'SUCCESS';
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
});

describe('customer refund requests are switched off', () => {
  it('the switch is off', () => {
    expect(CUSTOMER_REFUND_REQUESTS_ENABLED).toBe(false);
  });

  it('a delivered order: creating a request is refused with a clear 403 — nothing written, nothing notified', async () => {
    const { a, aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing, qty: 2 }], PAID);
    const admin = await panelToken();
    await deliver(admin.token, placed);
    const [item] = await placed.itemsOf(a);

    const res = await api()
      .post(`/api/v1/orders/${placed.orderId}/refund-requests`)
      .set('Authorization', bearer(placed.token))
      .field('category', 'DAMAGED_ITEM')
      .field('description', 'The packet arrived torn open.')
      .field('items', JSON.stringify([{ orderItemId: item!.id, qty: 1 }]))
      .attach('photos', PNG, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.REFUND_REQUESTS_DISABLED);
    expect(error.message).toMatch(/not available in the app right now/);
    expect(error.message).toMatch(/contact Aadione support/);

    expect(await prisma.refundRequest.count()).toBe(0);
    expect(await prisma.refundRequestEvidence.count()).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'ADMIN_REFUND_REQUEST' } })).toBe(0);

    // The summary never offers a request.
    const refunds = expectSuccess<{ request: { eligible: boolean } }>(
      (await api().get(`/api/v1/orders/${placed.orderId}/refunds`).set('Authorization', bearer(placed.token)).expect(200)).body,
    ).data;
    expect(refunds.request.eligible).toBe(false);
  });

  it('an old request link is answered clearly too; the existing record is kept and still visible to admins', async () => {
    const { a, aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    const admin = await panelToken();
    await deliver(admin.token, placed);
    const [item] = await placed.itemsOf(a);
    // A request made before the switch-off (written directly: the API refuses new ones).
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    const row = await prisma.orderItem.findUniqueOrThrow({ where: { id: item!.id } });
    const request = await prisma.refundRequest.create({
      data: {
        orderId: placed.orderId,
        userId: order.userId,
        category: 'MISSING_ITEM',
        description: 'One packet was missing from the bag.',
        requestedPaise: 1000,
        status: 'UNDER_REVIEW',
        items: [{ orderItemId: row.id, sellerOrderId: row.sellerOrderId, sellerId: a, qty: 1, amountPaise: 1000 }],
      },
    });

    const res = await api().get(`/api/v1/refund-requests/${request.id}`).set('Authorization', bearer(placed.token));
    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.REFUND_REQUESTS_DISABLED);

    expect(await prisma.refundRequest.count()).toBe(1);
    await api().get('/api/v1/admin/refund-requests').set('Authorization', bearer(admin.token)).expect(200);
    await api().get(`/api/v1/admin/refund-requests/${request.id}`).set('Authorization', bearer(admin.token)).expect(200);
  });

  it('automatic refunds are untouched: cancelling a paid order still refunds it in full', async () => {
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    await cancelAsCustomer(placed).expect(200);
    const refunded = await prisma.refund.aggregate({ where: { orderId: placed.orderId }, _sum: { amountPaise: true } });
    expect(refunded._sum.amountPaise).toBe(placed.totalPaise);
  });
});
