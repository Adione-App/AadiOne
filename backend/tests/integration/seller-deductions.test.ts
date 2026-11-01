/**
 * Refund management — Phase 5: seller deductions after post-delivery refunds,
 * and settlement integration. FINAL POLICY: the commission on a refunded item
 * is reversed — the seller gives back its net settlement for the refunded
 * part (₹600 refund of a ₹600 item at 10% -> ₹540), never the coupon.
 *
 *   - a refund after delivery becomes a deduction for THAT seller only, once
 *     the refund is actually done (never on approval, never twice);
 *   - the delivered sale stays settleable (the deduction recovers the money —
 *     dropping the sale as well would take it twice);
 *   - deductions come out of the seller's NEXT settlements, oldest first,
 *     never beyond a settlement's payable, the rest carried forward;
 *   - a completed (PAID) settlement is never modified;
 *   - concurrent settlement creation applies a deduction once.
 *
 * The fake Cashfree stands in for the gateway; nothing real is called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { ConfigKey, formatPaise } from '../../src/shared';
import { api, bearer, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { SETTLEMENT_CLOSE_LAG_MS } from '../../src/modules/sellers/seller-settlement.service';
import { recordDeductionForCompletedRefund } from '../../src/modules/sellers/seller-deduction.service';
import { reconcileCheckoutPayments } from '../../src/modules/payments/payment.service';
import { runInTransaction } from '../../src/infra/db/prisma';
import { cashfreeRefundId } from '../../src/infra/payment/cashfree.provider';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedStore } from '../helpers/fixtures';
import { PAID, ageRefunds, deliver, listing, panelToken, placeOrder, settleAllGatewayRefunds, twoSellers, type Placed } from '../helpers/refund-fixtures';

const CUSTOMER = '9400000511';
let storeId: string;

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

afterEach(() => {
  vi.restoreAllMocks();
});

/** Moves only Date.now() (read by the settlement service) past the close lag; returns the period end it allows. */
function clockPastCloseLag(): Date {
  vi.restoreAllMocks();
  const real = Date.now();
  // The allowed period end is then exactly the real "now": everything
  // delivered so far is inside, nothing delivered later can be.
  vi.spyOn(Date, 'now').mockReturnValue(real + SETTLEMENT_CLOSE_LAG_MS);
  return new Date(real);
}

interface Settlement {
  id: string;
  grossSalesPaise: number;
  commissionPaise: number;
  deductionsPaise: number;
  netPayablePaise: number;
  periodEnd: string;
  sellerOrders: { sellerOrderId: string }[];
  deductions: { deductionId: string; amountPaise: number }[];
}

async function settle(token: string, sellerId: string, periodStart?: string): Promise<Settlement> {
  const periodEnd = clockPastCloseLag().toISOString();
  const body = periodStart ? { periodStart, periodEnd } : {};
  const res = await api().post(`/api/v1/admin/sellers/${sellerId}/settlements`).set('Authorization', bearer(token)).send(body);
  vi.restoreAllMocks();
  if (res.status !== 201 && res.status !== 200) throw new Error(`settlement failed: ${res.status} ${JSON.stringify(res.body)}`);
  return expectSuccess<Settlement>(res.body).data;
}

async function markPaid(token: string, settlementId: string): Promise<void> {
  for (const [status, reference] of [['PROCESSING', undefined], ['PAID', 'UTR123456']] as const) {
    await api()
      .patch(`/api/v1/admin/settlements/${settlementId}/status`)
      .set('Authorization', bearer(token))
      .send({ status, ...(reference ? { reference } : {}) })
      .expect(200);
  }
}

async function requestAndApprove(token: string, placed: Placed, items: { orderItemId: string; qty: number }[], approvedPaise?: number) {
  const res = await api()
    .post(`/api/v1/orders/${placed.orderId}/refund-requests`)
    .set('Authorization', bearer(placed.token))
    .field('category', 'MISSING_ITEM')
    .field('description', 'Items were missing from the delivery.')
    .field('items', JSON.stringify(items));
  if (res.status !== 201) throw new Error(`request failed: ${res.status} ${JSON.stringify(res.body)}`);
  const id = expectSuccess<{ id: string }>(res.body).data.id;
  await api()
    .post(`/api/v1/admin/refund-requests/${id}/approve`)
    .set('Authorization', bearer(token))
    .send({ decisionNote: 'Confirmed with the customer.', ...(approvedPaise ? { approvedPaise } : {}) })
    .expect(200);
  return id;
}

const deductionsOf = (sellerId: string) => prisma.sellerDeduction.findMany({ where: { sellerId }, orderBy: { createdAt: 'asc' } });

describe('a refund after delivery becomes a deduction for that seller only — commission reversed', () => {
  it('recorded once the refund completes — not on approval, never twice (replayed webhook, repeated sweep, direct replay)', async () => {
    cashfree.refundStartStatus = 'PENDING';
    const { a, b, aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    const { token } = await panelToken();
    await deliver(token, placed);
    const [itemA] = await placed.itemsOf(a);

    // ₹200 of A's ₹600 item (₹60 commission) refunded.
    await requestAndApprove(token, placed, [{ orderItemId: itemA!.id, qty: 1 }], 20000);
    // Approved and sent to Cashfree, but not completed: no deduction yet.
    expect(await prisma.sellerDeduction.count()).toBe(0);

    settleAllGatewayRefunds();
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: placed.orderId } });
    const hook = cashfree.refundWebhook(cashfreeRefundId(refund.id));
    await api().post('/api/v1/payments/webhook').set(hook.headers).send(hook.raw).expect(200);
    await api().post('/api/v1/payments/webhook').set(hook.headers).send(hook.raw).expect(200);
    await ageRefunds(placed.orderId, 5);
    await reconcileCheckoutPayments();
    expect(await runInTransaction((tx) => recordDeductionForCompletedRefund(tx, refund.id))).toBeNull();

    const deductions = await deductionsOf(a);
    expect(deductions).toHaveLength(1);
    // ₹200 / ₹600 of the seller's ₹540 net = ₹180; ₹20 commission reversed.
    expect(deductions[0]).toMatchObject({
      sellerOrderId: placed.sellerOrderOf(a),
      refundId: refund.id,
      refundedPaise: 20000,
      amountPaise: 18000,
      commissionReversedPaise: 2000,
      couponReversedPaise: 0,
      appliedPaise: 0,
      status: 'OUTSTANDING',
    });
    expect(await prisma.sellerDeductionItem.findMany({ where: { deductionId: deductions[0]!.id } })).toEqual([
      expect.objectContaining({ orderItemId: itemA!.id, refundedPaise: 20000, sellerNetPaise: 18000, commissionPaise: 2000, couponPaise: 0 }),
    ]);
    // Never another seller's; never a fee.
    expect(await deductionsOf(b)).toEqual([]);
    expect(await prisma.sellerDeduction.count()).toBe(1);
    // The seller is told the real deduction, not the customer's refund.
    const notice = await prisma.notification.findFirstOrThrow({ where: { type: 'SELLER_REFUND_ISSUED', sellerId: a } });
    expect(notice.body).toContain('commission reversed');
    expect(notice.body).toContain(formatPaise(18000));
    expect(notice.body).toContain(formatPaise(20000));
  });

  it('a cancellation refund (before delivery) never creates a deduction', async () => {
    const { aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    await api().post(`/api/v1/orders/${placed.orderId}/cancel`).set('Authorization', bearer(placed.token)).send({ reason: 'Changed my mind' }).expect(200);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId, status: 'COMPLETED' } })).toBeGreaterThan(0);
    expect(await prisma.sellerDeduction.count()).toBe(0);
  });

  it('the coupon example: ₹600 item, ₹30 Aadione coupon share — customer refunded ₹570, seller deducted ₹540, ₹60 commission reversed', async () => {
    await prisma.coupon.create({ data: { code: 'SAVE50', type: 'FLAT', discountValue: 5000, usageLimitPerUser: 100 } });
    const { a, b, aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID, 'SAVE50');
    const { token } = await panelToken();
    await deliver(token, placed);
    const [itemA] = await placed.itemsOf(a);
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemA!.id } });
    expect(item).toMatchObject({ lineTotalPaise: 60000, commissionPaise: 6000, couponDiscountPaise: 3000 });

    await requestAndApprove(token, placed, [{ orderItemId: itemA!.id, qty: 1 }]);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: placed.orderId, status: 'COMPLETED' } });
    expect(refund.amountPaise).toBe(57000);
    expect(await deductionsOf(a)).toEqual([
      expect.objectContaining({ refundedPaise: 57000, amountPaise: 54000, commissionReversedPaise: 6000, couponReversedPaise: 3000 }),
    ]);
    expect(await deductionsOf(b)).toEqual([]);
  });

  it('two sellers in one refund group: each deducted its own net only', async () => {
    const { a, b, aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    const { token } = await panelToken();
    await deliver(token, placed);
    const [itemA] = await placed.itemsOf(a);
    const [itemB] = await placed.itemsOf(b);
    await requestAndApprove(token, placed, [
      { orderItemId: itemA!.id, qty: 1 },
      { orderItemId: itemB!.id, qty: 1 },
    ]);
    const groups = await prisma.refundGroup.findMany({ where: { orderId: placed.orderId } });
    expect(groups).toHaveLength(1);
    expect(await deductionsOf(a)).toEqual([expect.objectContaining({ groupId: groups[0]!.id, refundedPaise: 60000, amountPaise: 54000, commissionReversedPaise: 6000 })]);
    expect(await deductionsOf(b)).toEqual([expect.objectContaining({ groupId: groups[0]!.id, refundedPaise: 40000, amountPaise: 36000, commissionReversedPaise: 4000 })]);
  });

  it('partial quantities and repeated refunds of one item: never more than the item’s net or commission, in total exactly the item', async () => {
    const { a, aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing, qty: 2 }], PAID); // line ₹1,200, commission ₹120, net ₹1,080
    const { token } = await panelToken();
    await deliver(token, placed);
    const [itemA] = await placed.itemsOf(a);

    await requestAndApprove(token, placed, [{ orderItemId: itemA!.id, qty: 1 }]); // ₹600
    await requestAndApprove(token, placed, [{ orderItemId: itemA!.id, qty: 2 }], 30000); // ₹300 of the ₹600 left
    await requestAndApprove(token, placed, [{ orderItemId: itemA!.id, qty: 2 }]); // the last ₹300

    const deductions = await deductionsOf(a);
    expect(deductions.map((d) => [d.refundedPaise, d.amountPaise, d.commissionReversedPaise])).toEqual([
      [60000, 54000, 6000],
      [30000, 27000, 3000],
      [30000, 27000, 3000],
    ]);
    const totals = await prisma.sellerDeductionItem.aggregate({
      where: { orderItemId: itemA!.id },
      _sum: { refundedPaise: true, sellerNetPaise: true, commissionPaise: true },
    });
    expect(totals._sum).toEqual({ refundedPaise: 120000, sellerNetPaise: 108000, commissionPaise: 12000 });
    // Nothing left to refund on that item — so nothing more can ever be deducted for it.
    const view = expectSuccess<{ request: { eligible: boolean } }>(
      (await api().get(`/api/v1/orders/${placed.orderId}/refunds`).set('Authorization', bearer(placed.token)).expect(200)).body,
    ).data;
    expect(view.request.eligible).toBe(false);
  });
});

describe('settlements apply deductions', () => {
  it('₹600 refunded after a PAID settlement: ₹540 deducted (₹60 commission reversed); a ₹90 payout takes ₹90, ₹450 carries forward; the PAID settlement is never touched', async () => {
    const { a, b, aListing, bListing } = await twoSellers(storeId);
    const smallA = await listing(storeId, a, 10000);
    const { token } = await panelToken();

    // Order 1 — delivered and settled (PAID) before any refund.
    const order1 = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    await deliver(token, order1);
    const s1 = await settle(token, a);
    expect(s1).toMatchObject({ grossSalesPaise: 60000, commissionPaise: 6000, deductionsPaise: 0, netPayablePaise: 54000 });
    await markPaid(token, s1.id);
    const s1Before = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: s1.id } });

    // The whole ₹600 item refunded after delivery.
    const [itemA] = await order1.itemsOf(a);
    await requestAndApprove(token, order1, [{ orderItemId: itemA!.id, qty: 1 }]);
    const [deduction] = await deductionsOf(a);
    expect(deduction).toMatchObject({ refundedPaise: 60000, amountPaise: 54000, commissionReversedPaise: 6000, status: 'OUTSTANDING' });
    // The delivered sale is still a sale: the row stays eligible (accounted once).
    const fin = expectSuccess<{ sellers: { sellerId: string; settlement: { eligible: boolean } }[] }>(
      (await api().get(`/api/v1/admin/orders/${order1.orderId}/financials`).set('Authorization', bearer(token)).expect(200)).body,
    ).data;
    expect(fin.sellers.find((s) => s.sellerId === a)!.settlement.eligible).toBe(true);

    // Order 2 — a ₹100 item: the next payout is ₹90.
    const order2 = await placeOrder(CUSTOMER, [{ listingId: smallA }], PAID);
    await deliver(token, order2);
    const s2 = await settle(token, a, s1.periodEnd);
    expect(s2).toMatchObject({ grossSalesPaise: 10000, commissionPaise: 1000, deductionsPaise: 9000, netPayablePaise: 0 });
    expect(s2.deductions).toEqual([expect.objectContaining({ deductionId: deduction!.id, amountPaise: 9000 })]);
    expect(await prisma.sellerDeduction.findUniqueOrThrow({ where: { id: deduction!.id } })).toMatchObject({
      appliedPaise: 9000,
      status: 'PARTIALLY_APPLIED',
    });

    // Order 3 — ₹600: the ₹450 still owed comes out of this one.
    const order3 = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    await deliver(token, order3);
    const s3 = await settle(token, a, s2.periodEnd);
    expect(s3).toMatchObject({ grossSalesPaise: 60000, commissionPaise: 6000, deductionsPaise: 45000, netPayablePaise: 9000 });
    expect(await prisma.sellerDeduction.findUniqueOrThrow({ where: { id: deduction!.id } })).toMatchObject({
      appliedPaise: 54000,
      status: 'APPLIED',
    });
    const applications = await prisma.sellerDeductionApplication.findMany({ where: { deductionId: deduction!.id } });
    expect(applications.reduce((sum, x) => sum + x.amountPaise, 0)).toBe(54000);

    // The historical, PAID settlement is unchanged.
    expect(await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: s1.id } })).toEqual(s1Before);
    // Seller B is never touched by Seller A's refund.
    const sb = await settle(token, b);
    expect(sb).toMatchObject({ grossSalesPaise: 40000, deductionsPaise: 0, netPayablePaise: 36000 });

    // Seller A over the three orders: earned 540 + 90 + 540, gave back exactly the refunded sale's 540.
    expect(s1.netPayablePaise + s2.netPayablePaise + s3.netPayablePaise).toBe(54000 + 9000 + 54000 - 54000);

    const summary = expectSuccess<{ deductionsAppliedPaise: number; outstandingDeductionsPaise: number }>(
      (await api().get(`/api/v1/admin/sellers/${a}/earnings`).set('Authorization', bearer(token)).expect(200)).body,
    ).data;
    expect(summary).toMatchObject({ deductionsAppliedPaise: 54000, outstandingDeductionsPaise: 0 });
    const ledger = expectSuccess<{ outstandingPaise: number; items: { commissionReversedPaise: number; applications: unknown[] }[] }>(
      (await api().get(`/api/v1/admin/sellers/${a}/deductions`).set('Authorization', bearer(token)).expect(200)).body,
    ).data;
    expect(ledger.outstandingPaise).toBe(0);
    expect(ledger.items[0]).toMatchObject({ commissionReversedPaise: 6000 });
    expect(ledger.items[0]!.applications).toHaveLength(2);
  });

  it('a delivered order refunded IN FULL settles once and its net is taken back once — the seller ends at zero, never negative', async () => {
    const { b, bListing } = await twoSellers(storeId);
    const { token } = await panelToken();
    const order = await placeOrder(CUSTOMER, [{ listingId: bListing }], PAID);
    await deliver(token, order);
    const [itemB] = await order.itemsOf(b);
    await requestAndApprove(token, order, [{ orderItemId: itemB!.id, qty: 1 }]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('DELIVERED');

    const s = await settle(token, b);
    // ₹400 sale - ₹40 commission = ₹360 payable; the ₹360 deduction takes exactly that.
    expect(s).toMatchObject({ grossSalesPaise: 40000, commissionPaise: 4000, deductionsPaise: 36000, netPayablePaise: 0 });
    expect(await deductionsOf(b)).toEqual([expect.objectContaining({ amountPaise: 36000, appliedPaise: 36000, status: 'APPLIED' })]);
  });

  it('two concurrent settlement runs apply a deduction once', async () => {
    const { a, aListing } = await twoSellers(storeId);
    const { token } = await panelToken();
    const order1 = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    await deliver(token, order1);
    const [itemA] = await order1.itemsOf(a);
    await requestAndApprove(token, order1, [{ orderItemId: itemA!.id, qty: 1 }], 20000); // -> ₹180 deduction

    const periodEnd = clockPastCloseLag().toISOString();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        api().post(`/api/v1/admin/sellers/${a}/settlements`).set('Authorization', bearer(token)).send({ periodEnd }),
      ),
    );
    vi.restoreAllMocks();
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(await prisma.sellerSettlement.count({ where: { sellerId: a } })).toBe(1);
    const applications = await prisma.sellerDeductionApplication.findMany();
    expect(applications).toHaveLength(1);
    expect(applications[0]!.amountPaise).toBe(18000);
    const settlement = await prisma.sellerSettlement.findFirstOrThrow({ where: { sellerId: a } });
    expect(settlement).toMatchObject({ grossSalesPaise: 60000, commissionPaise: 6000, deductionsPaise: 18000, netPayablePaise: 36000 });
  });
});
