/**
 * Admin Financial Overview (modules/finance) — every figure checked against
 * the database rows it is built from, recomputed here independently:
 *
 *   - delivered + paid orders only; cancelled, unpaid, failed and in-progress
 *     orders are never revenue (reported separately);
 *   - COD vs Online are payment methods of the same revenue, never added twice;
 *   - delivery / platform fees and commission make Aadione's earnings; seller
 *     money and Aadione money never overlap (they reconcile to the paisa);
 *   - refunds after delivery (online + COD, full + partial) reduce revenue,
 *     seller earnings (deductions) and commission (reversed);
 *   - a seller's view: its own portions, fees only of orders where it is the
 *     only seller, multi-seller fees shown as shared — never duplicated;
 *   - date filters (incl. historical orders), pagination, the PDF (same
 *     figures), authorisation, and a large dataset.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Customer refund requests are switched off in the app for now; these tests
// exercise the refund-after-delivery accounting with the switch on.
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

import { randomUUID } from 'node:crypto';
import { ConfigKey, SellerOrderStatus, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedAddress, seedStore } from '../helpers/fixtures';
import { formatMoney } from '../../src/infra/pdf/branded-pdf';
import { buildFinanceReport, resolveFilter, type FinanceOverviewDto, type FinanceOrderRow } from '../../src/modules/finance/finance-overview.service';
import { renderFinanceReportPdf } from '../../src/modules/finance/finance-overview-pdf';
import { localDate, addDays } from '../../src/modules/finance/finance-period';
import {
  COD,
  PAID,
  cancelAsCustomer,
  deliver,
  panelToken,
  placeOrder,
  setSellerOrder,
  twoSellers,
  type Placed,
} from '../helpers/refund-fixtures';

let storeId: string;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  cashfree.refundStartStatus = 'SUCCESS';
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configService.set({ key: ConfigKey.COD_FIRST_ORDER_MAX_PAISE, value: 300_000 as never });
  // ₹1,000 and above delivers free; below pays the distance fee. ₹5 platform fee.
  await configService.set({ key: ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE, value: 100_000 as never });
  await configService.set({ key: ConfigKey.PLATFORM_FEE_PAISE, value: 500 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Query = Record<string, string>;
const qs = (q: Query) => new URLSearchParams(q).toString();
const overview = async (token: string, q: Query = { period: 'LIFETIME' }) =>
  expectSuccess<FinanceOverviewDto>((await api().get(`/api/v1/admin/finance/overview?${qs(q)}`).set('Authorization', bearer(token)).expect(200)).body).data;
const orderPage = async (token: string, q: Query) =>
  expectSuccess<{ items: FinanceOrderRow[]; total: number; totalPages: number }>(
    (await api().get(`/api/v1/admin/finance/orders?${qs(q)}`).set('Authorization', bearer(token)).expect(200)).body,
  ).data;

async function allOrders(token: string, q: Query) {
  const rows: FinanceOrderRow[] = [];
  for (let page = 1; ; page++) {
    const p = await orderPage(token, { ...q, page: String(page), pageSize: '2' });
    rows.push(...p.items);
    if (page >= p.totalPages) return { rows, total: p.total };
  }
}

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function refundRequest(placed: Placed, items: { orderItemId: string; qty: number }[]) {
  const res = await api()
    .post(`/api/v1/orders/${placed.orderId}/refund-requests`)
    .set('Authorization', bearer(placed.token))
    .field('category', 'MISSING_ITEM')
    .field('description', 'The item was missing from the bag.')
    .field('items', JSON.stringify(items));
  if (res.status !== 201) throw new Error(`refund request failed: ${res.status} ${JSON.stringify(res.body)}`);
  return expectSuccess<{ id: string }>(res.body).data.id;
}

/**
 * Seller A ₹600 and Seller B ₹400 (10% commission), seven orders:
 *   O1 online A+B ₹1,000 (free delivery, multi-seller), delivered
 *   O2 COD    A   ₹600, delivered
 *   O3 online A   ₹600, delivered, then ₹300 refunded (partial, Cashfree)
 *   O4 COD    B   ₹400, delivered, then refunded in full (manual payout, two admins)
 *   O5 online A+B, B rejected BEFORE delivery (refunded then), delivered with A only
 *   O6 COD    A, cancelled by the customer — never revenue
 *   O7 online B, paid, still in progress — not revenue yet
 */
async function scenario() {
  const { a, b, aListing, bListing } = await twoSellers(storeId, ['9400000801', '9400000802']);
  const admin = await panelToken();
  const admin2 = await panelToken();

  const o1 = await placeOrder('9400000811', [{ listingId: aListing }, { listingId: bListing }], PAID);
  await deliver(admin.token, o1);
  const o2 = await placeOrder('9400000812', [{ listingId: aListing }], COD);
  await deliver(admin.token, o2);
  const o3 = await placeOrder('9400000813', [{ listingId: aListing }], PAID);
  await deliver(admin.token, o3);
  const o4 = await placeOrder('9400000814', [{ listingId: bListing }], COD);
  await deliver(admin.token, o4);
  const o5 = await placeOrder('9400000815', [{ listingId: aListing }, { listingId: bListing }], PAID);
  await setSellerOrder(admin.token, o5.sellerOrderOf(b), SellerOrderStatus.REJECTED).expect(204);
  await deliver(admin.token, o5);
  const o6 = await placeOrder('9400000816', [{ listingId: aListing }], COD);
  await cancelAsCustomer(o6).expect(200);
  const o7 = await placeOrder('9400000817', [{ listingId: bListing }], PAID);

  // O3: ₹300 of A's ₹600 refunded after delivery (completes at once in the fake gateway).
  const [itemA3] = await o3.itemsOf(a);
  const r3 = await refundRequest(o3, [{ orderItemId: itemA3!.id, qty: 1 }]);
  await api().post(`/api/v1/admin/refund-requests/${r3}/approve`).set('Authorization', bearer(admin.token)).send({ approvedPaise: 30000, decisionNote: 'Half of it was missing.' }).expect(200);

  // O4: COD, refunded in full by a manual transfer — recorded by one admin, confirmed by another.
  const [itemB4] = await o4.itemsOf(b);
  const r4 = await refundRequest(o4, [{ orderItemId: itemB4!.id, qty: 1 }]);
  await api().post(`/api/v1/admin/refund-requests/${r4}/approve`).set('Authorization', bearer(admin.token)).send({ decisionNote: 'Whole item missing.' }).expect(200);
  const group4 = (await prisma.refundRequest.findUniqueOrThrow({ where: { id: r4 } })).groupId!;
  await api().post(`/api/v1/admin/refund-groups/${group4}/cod-payout`).set('Authorization', bearer(admin.token)).send({ method: 'UPI', reference: `UTR ${randomUUID().slice(0, 8)}`, paidOn: today() }).expect(200);
  await api().post(`/api/v1/admin/refund-groups/${group4}/cod-payout/confirm`).set('Authorization', bearer(admin2.token)).expect(200);

  return { a, b, admin, admin2, o1, o2, o3, o4, o5, o6, o7 };
}

/** The expected figures recomputed from the raw rows (the documented formula). */
async function expected(sellerId: string | null, deliveredFrom?: Date, deliveredTo?: Date) {
  const orders = await prisma.order.findMany({
    where: {
      status: 'DELIVERED',
      paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
      deliveredAt: { not: null, ...(deliveredFrom ? { gte: deliveredFrom } : {}), ...(deliveredTo ? { lt: deliveredTo } : {}) },
    },
    include: { sellerOrders: true, refunds: { include: { group: true } } },
  });
  const manual = await prisma.refundGroup.findMany({ where: { channel: 'MANUAL', postDelivery: true, manualPayout: { is: { status: 'CONFIRMED' } } } });
  const deductions = await prisma.sellerDeduction.findMany();
  const e = { orders: 0, collected: 0, cod: 0, online: 0, sellerPrice: 0, coupon: 0, commission: 0, delivery: 0, platform: 0, refunded: 0, deducted: 0, commissionReversed: 0, sharedDelivery: 0, sharedPlatform: 0 };
  for (const o of orders) {
    const active = o.sellerOrders.filter((so) => so.status !== 'CANCELLED' && so.status !== 'REJECTED');
    const mine = sellerId ? active.filter((so) => so.sellerId === sellerId) : active;
    if (sellerId && mine.length === 0) continue;
    const ownsFees = !sellerId || active.length === 1;
    const products = mine.reduce((s, so) => s + so.subtotalPaise, 0);
    const coupon = mine.reduce((s, so) => s + so.couponDiscountPaise, 0);
    const collected = sellerId ? products - coupon + (ownsFees ? o.deliveryFeePaise + o.platformFeePaise : 0) : o.currentPayablePaise;
    e.orders += 1;
    e.collected += collected;
    if (o.paymentMethod === 'COD') e.cod += collected;
    else e.online += collected;
    e.sellerPrice += products;
    e.coupon += coupon;
    e.commission += mine.reduce((s, so) => s + so.commissionPaise, 0);
    if (ownsFees) {
      e.delivery += o.deliveryFeePaise;
      e.platform += o.platformFeePaise;
    } else {
      e.sharedDelivery += o.deliveryFeePaise;
      e.sharedPlatform += o.platformFeePaise;
    }
    const ids = new Set(mine.map((so) => so.id));
    e.refunded += o.refunds.filter((r) => r.status === 'COMPLETED' && r.group?.postDelivery && r.sellerOrderId && ids.has(r.sellerOrderId)).reduce((s, r) => s + r.amountPaise, 0);
    for (const g of manual.filter((g) => g.orderId === o.id)) {
      for (const line of g.allocation as { sellerOrderId: string; amountPaise: number }[]) if (ids.has(line.sellerOrderId)) e.refunded += line.amountPaise;
    }
    for (const d of deductions.filter((d) => ids.has(d.sellerOrderId))) {
      e.deducted += d.amountPaise;
      e.commissionReversed += d.commissionReversedPaise;
    }
  }
  return e;
}

/* -------------------------------------------------------------------------- */
/* tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('Financial Overview — all sellers', () => {
  it('lifetime: revenue, COD / Online, fees, commission, refunds and Aadione earnings equal the recorded orders, and reconcile to the paisa', async () => {
    const s = await scenario();
    const view = await overview(s.admin.token);
    const e = await expected(null);
    const f = view.figures;

    expect(view.measures.orders).toBe(5); // O1–O5; O6 cancelled and O7 in progress are not revenue
    expect(e.orders).toBe(5);
    expect(f.grossRevenuePaise).toBe(e.collected);
    expect(view.byMethod.COD.grossRevenuePaise).toBe(e.cod);
    expect(view.byMethod.ONLINE.grossRevenuePaise).toBe(e.online);
    // Payment methods split the same revenue — never added on top of it.
    expect(view.byMethod.COD.grossRevenuePaise + view.byMethod.ONLINE.grossRevenuePaise).toBe(f.grossRevenuePaise);
    expect(view.measures.codOrders + view.measures.onlineOrders).toBe(5);

    expect(f.sellerPricePaise).toBe(e.sellerPrice);
    expect(f.sellerPricePaise).toBe(60000 + 40000 + 60000 + 60000 + 40000 + 60000); // O1 A+B, O2, O3, O4, O5 A
    expect(f.commissionPaise).toBe(e.commission);
    expect(f.commissionPaise).toBe(f.sellerPricePaise / 10);
    expect(f.deliveryPaise).toBe(e.delivery);
    expect(f.platformPaise).toBe(e.platform);
    expect(f.platformPaise).toBe(5 * 500);
    expect(f.aadioneGrossPaise).toBe(e.delivery + e.platform + e.commission);
    // Seller product money is never Aadione income.
    expect(f.sellerPayablePaise).toBe(e.sellerPrice - e.commission);

    // Free delivery is ₹0: O1 and O5 were ₹1,000 at checkout (O5 keeps its free
    // delivery after B's portion was rejected); O2–O4 pay the distance fee.
    const fees = await prisma.order.findMany({ where: { status: 'DELIVERED' }, select: { id: true, deliveryFeePaise: true } });
    const free = new Set([s.o1.orderId, s.o5.orderId]);
    expect(fees.filter((o) => free.has(o.id)).every((o) => o.deliveryFeePaise === 0)).toBe(true);
    expect(fees.filter((o) => !free.has(o.id)).every((o) => o.deliveryFeePaise > 0)).toBe(true);
    expect(view.measures.freeDeliveryOrders).toBe(2);
    expect(view.measures.ordersWithDeliveryFee).toBe(3);
    expect(view.measures.ordersWithPlatformFee).toBe(5);
    expect(view.measures.multiSellerOrders).toBe(1); // O5 has one active seller left

    // Refunds after delivery: ₹300 (O3, partial online) + ₹400 (O4, full COD).
    expect(f.refundsPaise).toBe(70000);
    expect(e.refunded).toBe(70000);
    expect(view.byMethod.ONLINE.refundsPaise).toBe(30000);
    expect(view.byMethod.COD.refundsPaise).toBe(40000);
    // O5's rejected portion was refunded BEFORE delivery: not a reversal of revenue.
    expect(f.unclassifiedRefundsPaise).toBe(0);
    expect(f.netRevenuePaise).toBe(e.collected - 70000);
    // Seller deductions: O3 ₹270 (= 300 × 540/600), O4 ₹360; commission reversed ₹30 + ₹40.
    expect(f.sellerDeductionsPaise).toBe(27000 + 36000);
    expect(f.commissionReversedPaise).toBe(3000 + 4000);
    expect(f.sellerNetPaise).toBe(e.sellerPrice - e.commission - e.deducted);
    expect(f.aadioneNetPaise).toBe(e.delivery + e.platform + e.commission - e.commissionReversed);
    expect(f.refundCostBeyondReversalsPaise).toBe(0);

    // Seller money + Aadione money − coupons = what customers paid, exactly.
    expect(f.reconciliationGapPaise).toBe(0);
    expect(view.dataQuality.payableMismatch.orders).toBe(0);
    expect(view.dataQuality.notes).toEqual([]);

    // Not revenue: O6 cancelled, O7 still on its way.
    expect(view.pipeline.cancelled.orders).toBe(1);
    expect(view.pipeline.inProgress).toMatchObject({ orders: 1, onlineOrders: 1, codOrders: 0 });
    expect(view.pipeline.inProgress.onlinePaidPaise).toBe((await prisma.order.findUniqueOrThrow({ where: { id: s.o7.orderId } })).currentPayablePaise);
    expect(view.pipeline.refundsPendingPaise).toBe(0);
  });

  it('seller breakdown rows add up to the totals; multi-seller fees stay unallocated, never duplicated', async () => {
    const s = await scenario();
    const view = await overview(s.admin.token);
    const sum = (k: 'sellerPricePaise' | 'commissionPaise' | 'sellerNetPaise' | 'deductionsPaise' | 'deliveryPaise' | 'platformPaise') =>
      view.sellers.reduce((acc, r) => acc + r[k], 0);
    expect(view.sellers.map((r) => r.sellerId).sort()).toEqual([s.a, s.b].sort());
    expect(sum('sellerPricePaise')).toBe(view.figures.sellerPricePaise);
    expect(sum('commissionPaise')).toBe(view.figures.commissionPaise);
    expect(sum('sellerNetPaise')).toBe(view.figures.sellerNetPaise);
    expect(sum('deductionsPaise')).toBe(view.figures.sellerDeductionsPaise);
    expect(sum('deliveryPaise') + view.unallocatedFees!.deliveryPaise).toBe(view.figures.deliveryPaise);
    expect(sum('platformPaise') + view.unallocatedFees!.platformPaise).toBe(view.figures.platformPaise);
    expect(view.unallocatedFees).toEqual({ orders: 1, deliveryPaise: 0, platformPaise: 500 }); // O1
    const a = view.sellers.find((r) => r.sellerId === s.a)!;
    expect(a).toMatchObject({ orders: 4, sellerPricePaise: 240000, commissionPaise: 24000, deductionsPaise: 27000, sharedOrders: 1 });
  });

  it('pending and failed online payments are reported, never counted as revenue', async () => {
    const s = await scenario();
    const before = await overview(s.admin.token);
    // An online checkout that is never paid.
    const customer = await loginAs('9400000818');
    const addressId = await seedAddress(customer.userId);
    const listingId = (await prisma.sellerListing.findFirstOrThrow({ where: { sellerId: s.a } })).id;
    await api().post('/api/v1/cart/items').set('Authorization', bearer(customer.accessToken)).send({ sellerListingId: listingId, qty: 1 }).expect(200);
    const res = await api().post('/api/v1/orders').set('Authorization', bearer(customer.accessToken)).set('Idempotency-Key', randomUUID()).send({ addressId, paymentMethod: 'ONLINE' });
    expect(res.status).toBe(201);
    const unpaidId = expectSuccess<{ order: { id: string } }>(res.body).data.order.id;
    const unpaid = await prisma.order.findUniqueOrThrow({ where: { id: unpaidId } });
    expect(unpaid.status).toBe('PENDING_PAYMENT');

    const awaiting = await overview(s.admin.token);
    expect(awaiting.pipeline.awaitingPayment).toEqual({ orders: 1, amountPaise: unpaid.totalPaise });
    expect(awaiting.figures).toEqual(before.figures);

    await prisma.order.update({ where: { id: unpaidId }, data: { status: 'PAYMENT_FAILED', paymentStatus: 'FAILED' } });
    const failed = await overview(s.admin.token);
    expect(failed.pipeline.paymentFailed).toEqual({ orders: 1, amountPaise: unpaid.totalPaise });
    expect(failed.pipeline.awaitingPayment.orders).toBe(0);
    expect(failed.figures).toEqual(before.figures);
  });

  it('a delivered order without a recorded payment is excluded and flagged, not guessed', async () => {
    const s = await scenario();
    const before = await overview(s.admin.token);
    await prisma.order.update({ where: { id: s.o2.orderId }, data: { paymentStatus: 'PENDING' } });
    const after = await overview(s.admin.token);
    expect(after.measures.orders).toBe(before.measures.orders - 1);
    expect(after.dataQuality.deliveredUnpaid.orders).toBe(1);
    expect(after.dataQuality.notes.join(' ')).toMatch(/no recorded payment/);
    expect(after.figures.reconciliationGapPaise).toBe(0);
  });
});

describe('Financial Overview — one seller', () => {
  it("a seller's view has only its own portions; fees only where it is the sole seller; shared fees shown, not added", async () => {
    const s = await scenario();
    const all = await overview(s.admin.token);
    const viewA = await overview(s.admin.token, { period: 'LIFETIME', sellerId: s.a });
    const viewB = await overview(s.admin.token, { period: 'LIFETIME', sellerId: s.b });
    const eA = await expected(s.a);
    const eB = await expected(s.b);

    expect(viewA.seller).toMatchObject({ id: s.a });
    for (const [view, e] of [[viewA, eA], [viewB, eB]] as const) {
      expect(view.measures.orders).toBe(e.orders);
      expect(view.figures.grossRevenuePaise).toBe(e.collected);
      expect(view.byMethod.COD.grossRevenuePaise).toBe(e.cod);
      expect(view.byMethod.ONLINE.grossRevenuePaise).toBe(e.online);
      expect(view.figures.sellerPricePaise).toBe(e.sellerPrice);
      expect(view.figures.commissionPaise).toBe(e.commission);
      expect(view.figures.deliveryPaise).toBe(e.delivery);
      expect(view.figures.platformPaise).toBe(e.platform);
      expect(view.figures.refundsPaise).toBe(e.refunded);
      expect(view.figures.sellerDeductionsPaise).toBe(e.deducted);
      expect(view.figures.commissionReversedPaise).toBe(e.commissionReversed);
      expect(view.figures.reconciliationGapPaise).toBe(0);
      expect(view.sharedFees).toEqual({ orders: 1, deliveryPaise: e.sharedDelivery, platformPaise: e.sharedPlatform });
    }
    expect(viewA.figures.sellerPricePaise).toBe(240000); // O1, O2, O3, O5
    expect(viewB.figures.sellerPricePaise).toBe(80000); // O1, O4 (O5 portion rejected)
    expect(viewA.measures.orders).toBe(4);
    expect(viewB.measures.orders).toBe(2);

    // The seller views and the shared fees add up to the whole — nothing counted twice.
    expect(viewA.figures.grossRevenuePaise + viewB.figures.grossRevenuePaise + viewA.sharedFees!.deliveryPaise + viewA.sharedFees!.platformPaise).toBe(
      all.figures.grossRevenuePaise,
    );
    expect(viewA.figures.aadioneNetPaise + viewB.figures.aadioneNetPaise + all.unallocatedFees!.deliveryPaise + all.unallocatedFees!.platformPaise).toBe(
      all.figures.aadioneNetPaise,
    );
    expect(viewA.figures.sellerNetPaise + viewB.figures.sellerNetPaise).toBe(all.figures.sellerNetPaise);

    // B's portion of O5 was rejected: not B's sale (O5 is not one of B's orders) —
    // reported as B's rejected seller order; for all sellers, a cancelled portion
    // inside a delivered order.
    expect(viewB.pipeline.cancelled.orders).toBe(1);
    expect(all.measures.cancelledPortions).toBe(1);
    expect(viewB.sellers).toHaveLength(1);
    expect(viewB.sellers[0]).toMatchObject({ sellerId: s.b, sellerPricePaise: 80000 });
  });
});

describe('Financial Overview — dates', () => {
  it('today, yesterday, a historical custom range and lifetime split the same orders without overlap', async () => {
    const s = await scenario();
    const tz = 'Asia/Kolkata';
    const yesterday = addDays(localDate(new Date(), tz), -1);
    // O2 delivered in March 2024 (historical); O4 yesterday (with its refund).
    await prisma.order.update({ where: { id: s.o2.orderId }, data: { deliveredAt: new Date('2024-03-15T06:00:00.000Z') } });
    await prisma.order.update({ where: { id: s.o4.orderId }, data: { deliveredAt: new Date(`${yesterday}T06:00:00.000Z`) } });

    const lifetime = await overview(s.admin.token, { period: 'LIFETIME' });
    const todayView = await overview(s.admin.token, { period: 'TODAY' });
    const yesterdayView = await overview(s.admin.token, { period: 'YESTERDAY' });
    const march = await overview(s.admin.token, { period: 'CUSTOM', from: '2024-03-01', to: '2024-03-31' });
    const thisYear = await overview(s.admin.token, { period: 'THIS_YEAR' });
    const last7 = await overview(s.admin.token, { period: 'LAST_7_DAYS' });

    expect(lifetime.measures.orders).toBe(5);
    expect(todayView.measures.orders).toBe(3); // O1, O3, O5
    expect(yesterdayView.measures.orders).toBe(1); // O4
    expect(march.measures.orders).toBe(1); // O2
    expect(march.period).toMatchObject({ preset: 'CUSTOM', fromDate: '2024-03-01', toDate: '2024-03-31' });
    expect(last7.measures.orders).toBe(4);
    expect(thisYear.measures.orders).toBe(yesterday.slice(0, 4) === localDate(new Date(), tz).slice(0, 4) ? 4 : 3);

    for (const key of ['grossRevenuePaise', 'refundsPaise', 'sellerNetPaise', 'aadioneNetPaise', 'commissionPaise', 'deliveryPaise', 'platformPaise'] as const) {
      expect(todayView.figures[key] + yesterdayView.figures[key] + march.figures[key]).toBe(lifetime.figures[key]);
    }
    // O4's refund follows its order: it is in yesterday's view.
    expect(yesterdayView.figures.refundsPaise).toBe(40000);
    expect(march.figures).toMatchObject(await (async () => {
      const e = await expected(null, new Date('2024-02-29T18:30:00.000Z'), new Date('2024-03-31T18:30:00.000Z'));
      return { grossRevenuePaise: e.collected, commissionPaise: e.commission, deliveryPaise: e.delivery };
    })());

    // Trends: the historical month is its own bucket; buckets add up to the period.
    const march2024 = lifetime.trend.monthly.find((p) => p.start === '2024-03-01')!;
    expect(march2024.grossRevenuePaise).toBe(march.figures.grossRevenuePaise);
    for (const series of [lifetime.trend.daily, lifetime.trend.weekly, lifetime.trend.monthly]) {
      expect(series.reduce((acc, p) => acc + p.grossRevenuePaise, 0)).toBe(lifetime.figures.grossRevenuePaise);
      expect(series.reduce((acc, p) => acc + p.aadioneNetPaise, 0)).toBe(lifetime.figures.aadioneNetPaise);
    }
    expect(lifetime.trend.weekly.every((p) => new Date(`${p.start}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
  });

  it('refuses a bad filter on the server', async () => {
    const admin = await panelToken();
    const bad = (q: string) => api().get(`/api/v1/admin/finance/overview?${q}`).set('Authorization', bearer(admin.token));
    await bad('period=FOREVER').expect(400);
    await bad('period=CUSTOM').expect(400);
    await bad('period=CUSTOM&from=2026-05-10&to=2026-05-01').expect(400);
    await bad('period=CUSTOM&from=2026-02-30&to=2026-03-01').expect(400);
    await bad('period=LIFETIME&sellerId=not-a-uuid').expect(400);
    await bad(`period=LIFETIME&sellerId=${randomUUID()}`).expect(404);
    await api().get('/api/v1/admin/finance/orders?period=LIFETIME&pageSize=500').set('Authorization', bearer(admin.token)).expect(400);
  });
});

describe('Financial Overview — orders, PDF and access', () => {
  it('the paginated order list carries the same figures as the overview (all sellers and one seller)', async () => {
    const s = await scenario();
    for (const q of [{ period: 'LIFETIME' }, { period: 'LIFETIME', sellerId: s.a }]) {
      const view = await overview(s.admin.token, q);
      const { rows, total } = await allOrders(s.admin.token, q);
      expect(total).toBe(view.measures.orders);
      expect(new Set(rows.map((r) => r.orderId)).size).toBe(total);
      const sum = (k: keyof FinanceOrderRow) => rows.reduce((acc, r) => acc + (r[k] as number), 0);
      expect(sum('grossRevenuePaise')).toBe(view.figures.grossRevenuePaise);
      expect(sum('refundedPaise')).toBe(view.figures.refundsPaise);
      expect(sum('sellerNetPaise')).toBe(view.figures.sellerNetPaise);
      expect(sum('aadioneNetPaise')).toBe(view.figures.aadioneNetPaise);
      expect(sum('commissionPaise')).toBe(view.figures.commissionPaise);
      // Latest delivery first.
      const times = rows.map((r) => r.deliveredAt);
      expect([...times].sort().reverse()).toEqual(times);
    }
  });

  it('the PDF shows exactly the selected view: same totals, every order, the seller and period, page numbers', async () => {
    const s = await scenario();
    const q = { period: 'LIFETIME', sellerId: s.a };
    const view = await overview(s.admin.token, q);
    const data = await buildFinanceReport(await resolveFilter({ period: 'LIFETIME', sellerId: s.a }));
    expect(data.overview.figures).toEqual(view.figures);
    const drawn: string[] = [];
    const pdf = await renderFinanceReportPdf(data, { compress: false, trace: (t) => drawn.push(t) });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = drawn.join('\n');
    for (const amount of [view.figures.grossRevenuePaise, view.figures.sellerNetPaise, view.figures.aadioneNetPaise, view.figures.commissionPaise, view.figures.refundsPaise]) {
      expect(text).toContain(formatMoney(amount));
    }
    expect(text).toContain('Seller A');
    expect(text).toContain('Lifetime (all time)');
    expect(text).toMatch(/Page 1 of \d+/);
    for (const row of data.orders) expect(drawn).toContain(row.orderNumber);
    expect(data.orders).toHaveLength(view.measures.orders);
    expect(drawn.some((t) => t.includes('…') && /₹|AD\d/.test(t))).toBe(false);

    // The download endpoint: an attachment named after the view.
    const res = await api()
      .get(`/api/v1/admin/finance/overview.pdf?${qs({ period: 'CUSTOM', from: '2024-01-01', to: today(), sellerId: s.a })}`)
      .set('Authorization', bearer(s.admin.token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Aadione-Financial-Overview-SEL-[A-Z0-9-]+-2024-01-01-to-\d{4}-\d{2}-\d{2}\.pdf"/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('admin only: STAFF, sellers, customers and anonymous callers are refused on every finance route', async () => {
    const staff = await panelToken(UserRole.STAFF);
    const sellerId = (await twoSellers(storeId, ['9400000851', '9400000852'])).a;
    const seller = await loginAs('9400000851');
    const customer = await loginAs('9400000853');
    const routes = ['/api/v1/admin/finance/overview?period=LIFETIME', '/api/v1/admin/finance/orders?period=LIFETIME', '/api/v1/admin/finance/overview.pdf?period=LIFETIME', '/api/v1/admin/finance/sellers'];
    for (const route of routes) {
      await api().get(route).expect(401);
      await api().get(route).set('Authorization', bearer(staff.token)).expect(403);
      await api().get(route).set('Authorization', bearer(seller.accessToken)).expect(403);
      await api().get(route).set('Authorization', bearer(customer.accessToken)).expect(403);
    }
    const admin = await panelToken();
    const options = expectSuccess<{ id: string }[]>((await api().get('/api/v1/admin/finance/sellers').set('Authorization', bearer(admin.token)).expect(200)).body).data;
    expect(options.map((o) => o.id)).toContain(sellerId);
  });
});

describe('Financial Overview — large history', () => {
  it('2,500 historical orders: totals exact, fast, paginated; the PDF lists the latest 2,000 and says so', async () => {
    const { aListing } = await twoSellers(storeId, ['9400000861', '9400000862']);
    const admin = await panelToken();
    const template = await placeOrder('9400000871', [{ listingId: aListing }], COD);
    await deliver(admin.token, template);
    const t = await prisma.order.findUniqueOrThrow({ where: { id: template.orderId }, include: { sellerOrders: true } });

    // 2,499 copies of the delivered order, spread over the last ~3 years.
    const cols = async (table: string, skip: string[]) =>
      (await prisma.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position`))
        .map((c) => c.column_name)
        .filter((c) => !skip.includes(c));
    const orderCols = await cols('orders', ['id', 'order_number', 'idempotency_key', 'delivered_at']);
    const soCols = await cols('seller_orders', ['id', 'order_id']);
    await prisma.$executeRawUnsafe(`
      WITH copies AS (
        INSERT INTO orders (id, order_number, idempotency_key, delivered_at, ${orderCols.map((c) => `"${c}"`).join(', ')})
        SELECT gen_random_uuid(), 'BK' || lpad(g::text, 6, '0'), NULL, now() - (g * interval '10 hours'), ${orderCols.map((c) => `o."${c}"`).join(', ')}
        FROM orders o, generate_series(1, 2499) g WHERE o.id = '${t.id}'
        RETURNING id
      )
      INSERT INTO seller_orders (id, order_id, ${soCols.map((c) => `"${c}"`).join(', ')})
      SELECT gen_random_uuid(), copies.id, ${soCols.map((c) => `so."${c}"`).join(', ')}
      FROM copies, seller_orders so WHERE so.order_id = '${t.id}'`);

    const started = Date.now();
    const view = await overview(admin.token);
    const took = Date.now() - started;
    expect(view.measures.orders).toBe(2500);
    expect(view.figures.grossRevenuePaise).toBe(2500 * t.currentPayablePaise);
    expect(view.figures.commissionPaise).toBe(2500 * t.sellerOrders[0]!.commissionPaise);
    expect(view.figures.deliveryPaise).toBe(2500 * t.deliveryFeePaise);
    expect(view.figures.reconciliationGapPaise).toBe(0);
    expect(view.trend.monthly.reduce((acc, p) => acc + p.orders, 0)).toBe(2500);
    expect(took, `overview of 2,500 orders took ${took} ms`).toBeLessThan(10_000);

    const page = await orderPage(admin.token, { period: 'LIFETIME', page: '125', pageSize: '20' });
    expect(page).toMatchObject({ total: 2500, totalPages: 125 });
    expect(page.items).toHaveLength(20);

    const data = await buildFinanceReport(await resolveFilter({ period: 'LIFETIME' }));
    expect(data).toMatchObject({ ordersTotal: 2500, ordersTruncated: true });
    expect(data.orders).toHaveLength(2000);
    const drawn: string[] = [];
    await renderFinanceReportPdf(data, { trace: (text) => drawn.push(text) });
    expect(drawn.join('\n')).toContain('Order details (first 2000 of 2500, latest first)');
    expect(drawn.join('\n')).toContain(formatMoney(view.figures.grossRevenuePaise));
  }, 180_000);
});
