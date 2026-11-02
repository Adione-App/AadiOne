/**
 * Refund groups — Phase 1: historical compatibility and the group mechanics.
 *
 *   - the migration's backfill classifies every existing refund from data it
 *     already has, changes nothing else (amounts, statuses, Cashfree ids) and
 *     never invents a group for an old refund;
 *   - one group per triggering action: nested actions join, a separate action
 *     opens its own group, a rolled-back transaction leaves no stale group.
 *
 * The fake Cashfree stands in for the gateway; nothing real is called.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

import { ConfigKey, SellerOrderStatus, UserRole, formatPaise } from '../../src/shared';
import { api, bearer, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { runInTransaction } from '../../src/infra/db/prisma';
import * as configService from '../../src/modules/configuration/configuration.service';
import { attachGroup, withRefundAction } from '../../src/modules/refunds/refund-action';
import { reconcileCheckoutPayments } from '../../src/modules/payments/payment.service';
import { cashfreeRefundId } from '../../src/infra/payment/cashfree.provider';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedStore } from '../helpers/fixtures';
import {
  PAID,
  ageRefunds,
  cancelAsCustomer,
  deliver,
  gatewayRefundedPaise,
  panelToken,
  placeOrder,
  setSellerOrder,
  settleAllGatewayRefunds,
  twoSellers,
} from '../helpers/refund-fixtures';

const CUSTOMER = '9400000311';
let storeId: string;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  cashfree.refundStartStatus = 'SUCCESS';
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  // Charge a delivery fee on these orders, so both fee components exist.
  await configService.set({ key: ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE, value: 100_000_000 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
});

/** The fee-remainder reason the code used before refund groups (classified ORDER_FEES). */
const LEGACY_FEE_REASON = 'Every seller portion was cancelled — refunding the remaining amount (delivery/platform fees).';

/** The BACKFILL section of the migration, exactly as it will run on production. */
function backfillSql(): string[] {
  const file = path.resolve(__dirname, '../../prisma/migrations/20261101120000_v2_refund_groups/migration.sql');
  const sql = fs.readFileSync(file, 'utf8');
  const section = sql.slice(sql.indexOf('-- BACKFILL: refunds.component_type'));
  return section
    .split(';')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.startsWith('UPDATE'));
}

const fingerprint = async () =>
  (
    await prisma.refund.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, amountPaise: true, status: true, providerRefundId: true, sellerOrderId: true, paymentId: true, groupId: true, reason: true },
    })
  ).map((r) => JSON.stringify(r));

describe('migration backfill — existing refunds', () => {
  it('classifies seller portions, the fee remainder, whole-order and orphan refunds; changes nothing else; groups none', async () => {
    const { a, b, aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    await cancelAsCustomer(placed).expect(200);
    settleAllGatewayRefunds();

    // An orphan capture's refund and a pre-split whole-order refund, as old rows.
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: placed.orderId } });
    const orphan = await prisma.payment.create({
      data: {
        orderId: placed.orderId,
        provider: payment.provider,
        providerOrderId: `${payment.providerOrderId}_late`,
        providerPaymentId: `late_${randomUUID().slice(0, 8)}`,
        amountPaise: 5000,
        status: 'CAPTURED',
        failureCode: 'ORPHAN_CAPTURE',
      },
    });
    await prisma.refund.create({ data: { paymentId: orphan.id, orderId: placed.orderId, amountPaise: 5000, status: 'COMPLETED', reason: 'late payment' } });
    await prisma.refund.create({ data: { paymentId: payment.id, orderId: placed.orderId, amountPaise: 100, status: 'FAILED', reason: 'Order cancelled by admin' } });
    // The fee remainder as the code before refund groups issued it: one row, one fixed reason.
    await prisma.refund.create({ data: { paymentId: payment.id, orderId: placed.orderId, amountPaise: 200, status: 'FAILED', reason: LEGACY_FEE_REASON } });

    // Every row as it looked before the migration: no type, no group.
    await prisma.$executeRawUnsafe(`UPDATE refunds SET component_type = NULL, group_id = NULL`);
    const before = await fingerprint();

    for (const statement of backfillSql()) await prisma.$executeRawUnsafe(statement);
    // Idempotent: running it again changes nothing.
    for (const statement of backfillSql()) await prisma.$executeRawUnsafe(statement);

    expect(await fingerprint()).toEqual(before);
    const rows = await prisma.refund.findMany({ select: { sellerOrderId: true, componentType: true, reason: true, paymentId: true, groupId: true } });
    expect(rows.every((r) => r.groupId === null)).toBe(true);
    expect(rows.filter((r) => r.sellerOrderId === placed.sellerOrderOf(a)).map((r) => r.componentType)).toEqual(['SELLER_PRODUCT']);
    expect(rows.filter((r) => r.sellerOrderId === placed.sellerOrderOf(b)).map((r) => r.componentType)).toEqual(['SELLER_PRODUCT']);
    expect(rows.filter((r) => r.paymentId === orphan.id).map((r) => r.componentType)).toEqual(['ORPHAN_PAYMENT']);
    expect(rows.filter((r) => r.reason === 'Order cancelled by admin').map((r) => r.componentType)).toEqual(['FULL_ORDER']);
    expect(rows.filter((r) => r.reason === LEGACY_FEE_REASON).map((r) => r.componentType)).toEqual(['ORDER_FEES']);
    // (New fee refunds are written already typed DELIVERY_FEE / PLATFORM_FEE;
    // with their type artificially cleared here they read as order-level.)
    expect(rows.every((r) => r.componentType !== null)).toBe(true);
  });
});

describe('one refund group per triggering action', () => {
  async function twoOrders() {
    const { aListing, bListing } = await twoSellers(storeId);
    const first = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    const second = await placeOrder('9400000312', [{ listingId: bListing }], PAID);
    return [first, second] as const;
  }
  const orderOf = async (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, select: { id: true, userId: true } });

  it('every refund one action issues for an order shares one group; a nested action joins; another order gets its own', async () => {
    const [first, second] = await twoOrders();
    const o1 = await orderOf(first.orderId);
    const o2 = await orderOf(second.orderId);

    const ids = await withRefundAction({ origin: 'AUTO', reason: 'Order cancelled', actorUserId: null }, async () => {
      const g1 = await runInTransaction((tx) => attachGroup(tx, o1, 'x'));
      const g1again = await withRefundAction({ origin: 'ADMIN', reason: 'nested', actorUserId: null }, () =>
        runInTransaction((tx) => attachGroup(tx, o1, 'x')),
      );
      const g2 = await runInTransaction((tx) => attachGroup(tx, o2, 'x'));
      return { g1, g1again, g2 };
    });
    expect(ids.g1again).toBe(ids.g1);
    expect(ids.g2).not.toBe(ids.g1);
    const groups = await prisma.refundGroup.findMany({ orderBy: { createdAt: 'asc' } });
    expect(groups).toHaveLength(2);
    // The OUTER action's description wins: the nested call only joined it.
    expect(groups.every((g) => g.origin === 'AUTO' && g.reason === 'Order cancelled')).toBe(true);

    // A later, separate action for the same order: a new group, never merged.
    const later = await withRefundAction({ origin: 'ADMIN', reason: 'Later action', actorUserId: null }, () =>
      runInTransaction((tx) => attachGroup(tx, o1, 'x')),
    );
    expect(later).not.toBe(ids.g1);
    expect(await prisma.refundGroup.count({ where: { orderId: o1.id } })).toBe(2);
  });

  it('a group created in a transaction that rolled back is not reused — the next refund gets a real one', async () => {
    const [first] = await twoOrders();
    const o1 = await orderOf(first.orderId);
    const groupId = await withRefundAction({ origin: 'AUTO', reason: 'Rolled back', actorUserId: null }, async () => {
      await runInTransaction(async (tx) => {
        await attachGroup(tx, o1, 'x');
        throw new Error('boom');
      }).catch(() => undefined);
      expect(await prisma.refundGroup.count()).toBe(0);
      return runInTransaction((tx) => attachGroup(tx, o1, 'x'));
    });
    expect(await prisma.refundGroup.findUnique({ where: { id: groupId } })).not.toBeNull();
    expect(await prisma.refundGroup.count()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase 2 — the existing automatic refunds, grouped                          */
/* -------------------------------------------------------------------------- */

const customerRefundNotices = (userId: string) =>
  prisma.notification.findMany({
    where: { userId, type: { in: ['REFUND_INITIATED', 'REFUND_COMPLETED', 'REFUND_UPDATE'] } },
    orderBy: { createdAt: 'asc' },
    select: { type: true, dedupeKey: true, body: true },
  });

async function groupOf(orderId: string) {
  const groups = await prisma.refundGroup.findMany({ where: { orderId }, include: { refunds: { orderBy: { createdAt: 'asc' } } } });
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

const retry = (token: string, groupId: string) =>
  api().post(`/api/v1/admin/refund-groups/${groupId}/retry`).set('Authorization', bearer(token));

describe('a two-seller cancellation is ONE refund group', () => {
  it('Seller A + Seller B + delivery fee + platform fee: one group, typed components, one notice per stage', async () => {
    cashfree.refundStartStatus = 'PENDING';
    const { a, b, aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.deliveryFeePaise).toBeGreaterThan(0);
    expect(order.platformFeePaise).toBeGreaterThan(0);

    await cancelAsCustomer(placed).expect(200);

    const group = await groupOf(placed.orderId);
    expect(group).toMatchObject({ origin: 'AUTO', channel: 'CASHFREE', postDelivery: false, status: 'PROCESSING', refundedPaise: 0 });
    expect(group.totalPaise).toBe(order.totalPaise);
    const byType = Object.fromEntries(group.refunds.map((r) => [`${r.componentType}:${r.sellerOrderId ?? '-'}`, r.amountPaise]));
    expect(byType).toEqual({
      [`SELLER_PRODUCT:${placed.sellerOrderOf(a)}`]: 60000,
      [`SELLER_PRODUCT:${placed.sellerOrderOf(b)}`]: 40000,
      'DELIVERY_FEE:-': order.deliveryFeePaise,
      'PLATFORM_FEE:-': order.platformFeePaise,
    });
    // Accepted by Cashfree is not completion.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).paymentStatus).toBe('PAID');

    // ONE "refund started" for the whole amount — never one per seller or fee.
    let notices = await customerRefundNotices(placed.userId);
    expect(notices.map((n) => n.dedupeKey)).toEqual([`refund-group:${group.id}:INITIATED`]);
    expect(notices[0]!.body).toContain(formatRupees(order.totalPaise));

    // Cashfree completes them; the reconciliation job records it.
    settleAllGatewayRefunds();
    await ageRefunds(placed.orderId, 5);
    await reconcileCheckoutPayments();
    await reconcileCheckoutPayments(); // repeated sweeps notify nobody twice

    const done = await prisma.refundGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(done).toMatchObject({ status: 'SUCCESS', refundedPaise: order.totalPaise, totalPaise: order.totalPaise });
    expect(done.completedAt).not.toBeNull();
    notices = await customerRefundNotices(placed.userId);
    expect(notices.map((n) => n.dedupeKey)).toEqual([`refund-group:${group.id}:INITIATED`, `refund-group:${group.id}:COMPLETED`]);
    // Sellers still hear about their own portion; admins about nothing (no failure).
    expect(await prisma.notification.count({ where: { type: 'SELLER_REFUND_ISSUED' } })).toBe(2);
    expect(await prisma.notification.count({ where: { type: 'ADMIN_REFUND_FAILED' } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).paymentStatus).toBe('REFUNDED');
  });

  it('a later, separate cancellation of the second portion is a SEPARATE group', async () => {
    const { a, b, aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    const { token } = await panelToken();
    await setSellerOrder(token, placed.sellerOrderOf(a), SellerOrderStatus.CANCELLED).expect(204);
    await setSellerOrder(token, placed.sellerOrderOf(b), SellerOrderStatus.CANCELLED).expect(204);

    const groups = await prisma.refundGroup.findMany({ where: { orderId: placed.orderId }, include: { refunds: true }, orderBy: { createdAt: 'asc' } });
    expect(groups).toHaveLength(2);
    expect(groups[0]!.refunds.map((r) => r.componentType)).toEqual(['SELLER_PRODUCT']);
    // The last portion brings the fees with it — in ITS group.
    expect(groups[1]!.refunds.map((r) => r.componentType).sort()).toEqual(['DELIVERY_FEE', 'PLATFORM_FEE', 'SELLER_PRODUCT']);
    expect(groups.every((g) => g.origin === 'ADMIN' && g.status === 'SUCCESS')).toBe(true);
  });
});

describe('partial failure, the mislabel fix and component retry', () => {
  /** Customer cancels; Cashfree definitively refuses the FIRST refund call (a seller portion). */
  async function cancelWithOneRefusedPortion() {
    const { aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    const admin = await panelToken(); // an ORDER_REFUND holder to alert
    cashfree.failNext = { status: 400, code: 'refund_amount_invalid', message: 'invalid refund amount' };
    await cancelAsCustomer(placed).expect(200);
    const group = await groupOf(placed.orderId);
    const failed = group.refunds.find((r) => r.status === 'FAILED')!;
    return { placed, order, group, failed, admin };
  }

  it('one refused seller portion: PARTIAL_FAILURE, the fee refund is exactly the fees, one "delayed" notice, admins alerted', async () => {
    const { placed, order, group, failed } = await cancelWithOneRefusedPortion();
    expect(failed.componentType).toBe('SELLER_PRODUCT');
    expect(group.status).toBe('PARTIAL_FAILURE');

    // THE MISLABEL FIX: the failed portion's money is NOT swept into the fee refund.
    const fees = group.refunds.filter((r) => r.componentType === 'DELIVERY_FEE' || r.componentType === 'PLATFORM_FEE');
    expect(fees.reduce((s, r) => s + r.amountPaise, 0)).toBe(order.deliveryFeePaise + order.platformFeePaise);
    expect(gatewayRefundedPaise()).toBe(order.totalPaise - failed.amountPaise);

    expect((await customerRefundNotices(placed.userId)).map((n) => n.dedupeKey)).toEqual([`refund-group:${group.id}:DELAYED`]);
    expect(await prisma.notification.count({ where: { type: 'ADMIN_REFUND_FAILED' } })).toBeGreaterThan(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).paymentStatus).toBe('PARTIALLY_REFUNDED');
  });

  it('retry: only the failed part, after Cashfree confirms it holds no such refund; history kept; then SUCCESS, notified once', async () => {
    const { placed, order, group, failed, admin } = await cancelWithOneRefusedPortion();
    const { token, userId } = admin;

    const res = await retry(token, group.id).expect(200);
    const outcome = expectSuccess<{ retried: { failedRefundId: string; refundId: string; status: string }[]; skipped: unknown[] }>(res.body).data;
    expect(outcome.skipped).toEqual([]);
    expect(outcome.retried).toHaveLength(1);
    expect(outcome.retried[0]).toMatchObject({ failedRefundId: failed.id, status: 'COMPLETED' });
    // Cashfree was asked about the failed attempt BEFORE the new refund.
    const calls = cashfree.requests.map((r) => `${r.method} ${r.path}`);
    const asked = calls.lastIndexOf(`GET /orders/${placed.providerOrderId}/refunds/${cashfreeRefundId(failed.id)}`);
    const issued = calls.lastIndexOf(`POST /orders/${placed.providerOrderId}/refunds`);
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(issued);

    const after = await groupOf(placed.orderId);
    expect(after).toMatchObject({ status: 'SUCCESS', refundedPaise: order.totalPaise, totalPaise: order.totalPaise });
    // The failed attempt stays; the retry points at it; nothing else re-issued.
    expect(after.refunds.find((r) => r.id === failed.id)!.status).toBe('FAILED');
    const retryRow = after.refunds.find((r) => r.retryOfId === failed.id)!;
    expect(retryRow).toMatchObject({ status: 'COMPLETED', amountPaise: failed.amountPaise, sellerOrderId: failed.sellerOrderId, groupId: group.id });
    expect(after.refunds).toHaveLength(group.refunds.length + 1);
    expect(gatewayRefundedPaise()).toBe(order.totalPaise);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).paymentStatus).toBe('REFUNDED');

    expect((await customerRefundNotices(placed.userId)).map((n) => n.dedupeKey)).toEqual([
      `refund-group:${group.id}:DELAYED`,
      `refund-group:${group.id}:COMPLETED`,
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'payment.refund_retry' } });
    expect(audit).toMatchObject({ actorUserId: userId });
    expect(audit.after).toMatchObject({ retryOfId: failed.id, groupId: group.id });

    // Nothing left to retry: a successful component is never retried.
    await retry(token, group.id).expect(409);
  });

  it('concurrent retries create exactly one new attempt', async () => {
    const { placed, group, failed } = await cancelWithOneRefusedPortion();
    const { token } = await panelToken();
    const results = await Promise.all([retry(token, group.id), retry(token, group.id), retry(token, group.id)]);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(await prisma.refund.count({ where: { retryOfId: failed.id } })).toBe(1);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId, sellerOrderId: failed.sellerOrderId, status: 'COMPLETED' } })).toBe(1);
  });

  it('never retries an uncertain part: a refund whose response was lost stays in flight; retry finds nothing to do', async () => {
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    cashfree.refundStartStatus = 'PENDING';
    cashfree.loseNextResponse = true;
    await cancelAsCustomer(placed).expect(200);
    const group = await groupOf(placed.orderId);
    expect(group.status).toBe('PROCESSING');
    expect(group.refunds.some((r) => r.status === 'FAILED')).toBe(false);
    const { token } = await panelToken();
    await retry(token, group.id).expect(409);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(group.refunds.length);
  });

  it('never retries a part recorded FAILED that Cashfree actually completed — refused, admins alerted', async () => {
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    await cancelAsCustomer(placed).expect(200);
    const group = await groupOf(placed.orderId);
    const portion = group.refunds.find((r) => r.componentType === 'SELLER_PRODUCT')!;
    // Our record says FAILED, Cashfree says SUCCESS (a record gone wrong).
    await prisma.refund.update({ where: { id: portion.id }, data: { status: 'FAILED', completedAt: null } });

    const { token } = await panelToken();
    const res = await retry(token, group.id).expect(200);
    const outcome = expectSuccess<{ retried: unknown[]; skipped: { refundId: string; reason: string }[] }>(res.body).data;
    expect(outcome.retried).toEqual([]);
    expect(outcome.skipped).toEqual([{ refundId: portion.id, reason: expect.stringContaining('Cashfree reports this refund as COMPLETED') }]);
    expect(await prisma.refund.count({ where: { retryOfId: portion.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { dedupeKey: `refund:${portion.id}:RETRY_MISMATCH` } })).toBe(1);
  });

  it('STAFF cannot retry or reconcile (ORDER_REFUND only)', async () => {
    const { group } = await cancelWithOneRefusedPortion();
    const { token } = await panelToken(UserRole.STAFF);
    await retry(token, group.id).expect(403);
    await api().post(`/api/v1/admin/refund-groups/${group.id}/reconcile`).set('Authorization', bearer(token)).expect(403);
    expect(await prisma.refund.count({ where: { retryOfId: { not: null } } })).toBe(0);
  });

  it('a signed refund webhook moves the group (re-read from Cashfree) and announces it once', async () => {
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    cashfree.refundStartStatus = 'PENDING';
    await cancelAsCustomer(placed).expect(200);
    const group = await groupOf(placed.orderId);
    for (const refund of group.refunds) {
      cashfree.settleRefund(cashfreeRefundId(refund.id), 'SUCCESS');
      const hook = cashfree.refundWebhook(cashfreeRefundId(refund.id));
      await api().post('/api/v1/payments/webhook').set(hook.headers).send(hook.raw).expect(200);
      await api().post('/api/v1/payments/webhook').set(hook.headers).send(hook.raw).expect(200);
    }
    expect((await prisma.refundGroup.findUniqueOrThrow({ where: { id: group.id } })).status).toBe('SUCCESS');
    expect((await customerRefundNotices(placed.userId)).map((n) => n.dedupeKey)).toEqual([
      `refund-group:${group.id}:INITIATED`,
      `refund-group:${group.id}:COMPLETED`,
    ]);
  });
});

/** "₹1,035" — how notification bodies show money (formatPaise). */
function formatRupees(paise: number): string {
  return formatPaise(paise);
}

/* -------------------------------------------------------------------------- */
/* Phase 8 — admin dashboard reads                                            */
/* -------------------------------------------------------------------------- */

describe('admin refund dashboard', () => {
  it('list, detail (seller-wise parts, Cashfree ids, retry state, history) and overview — ORDER_REFUND only', async () => {
    const { aListing, bListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }, { listingId: bListing }], PAID);
    const admin = await panelToken();
    cashfree.failNext = { status: 400, code: 'refund_amount_invalid', message: 'invalid refund amount' };
    await cancelAsCustomer(placed).expect(200);
    const group = await groupOf(placed.orderId);

    const list = expectSuccess<{ items: { id: string; status: string; retryable: boolean; components: number }[] }>(
      (await api().get('/api/v1/admin/refund-groups?status=PARTIAL_FAILURE').set('Authorization', bearer(admin.token)).expect(200)).body,
    ).data;
    expect(list.items).toEqual([expect.objectContaining({ id: group.id, status: 'PARTIAL_FAILURE', retryable: true, components: 4 })]);

    const detail = expectSuccess<{
      components: { sellerName: string | null; componentType: string; state: string; providerRefundId: string | null; failureReason: string | null }[];
      actions: { canRetry: boolean; canReconcile: boolean; canRecordPayout: boolean };
      audit: { action: string }[];
      customer: { mobile: string };
    }>((await api().get(`/api/v1/admin/refund-groups/${group.id}`).set('Authorization', bearer(admin.token)).expect(200)).body).data;
    expect(detail.components).toHaveLength(4);
    const failed = detail.components.find((c) => c.state === 'FAILED_RETRYABLE')!;
    expect(failed).toMatchObject({ componentType: 'SELLER_PRODUCT', providerRefundId: null });
    expect(failed.failureReason).toBeTruthy();
    expect(detail.components.filter((c) => c.state === 'COMPLETED').every((c) => c.providerRefundId)).toBe(true);
    expect(detail.components.filter((c) => c.componentType === 'SELLER_PRODUCT').map((c) => c.sellerName).sort()).toEqual(['Seller A', 'Seller B']);
    expect(detail.actions).toMatchObject({ canRetry: true, canReconcile: false, canRecordPayout: false });
    expect(detail.audit.map((x) => x.action)).toEqual(expect.arrayContaining(['payment.refund_seller_portion', 'payment.refund_remainder']));

    const overview = expectSuccess<{ partialFailures: number; requestsUnderReview: number }>(
      (await api().get('/api/v1/admin/refund-overview').set('Authorization', bearer(admin.token)).expect(200)).body,
    ).data;
    expect(overview).toMatchObject({ partialFailures: 1, requestsUnderReview: 0 });

    const staff = await panelToken(UserRole.STAFF);
    await api().get('/api/v1/admin/refund-groups').set('Authorization', bearer(staff.token)).expect(403);
    await api().get(`/api/v1/admin/refund-groups/${group.id}`).set('Authorization', bearer(staff.token)).expect(403);
    await api().get('/api/v1/admin/refund-overview').set('Authorization', bearer(staff.token)).expect(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Correction: recorded FAILED, Cashfree completed it                         */
/* -------------------------------------------------------------------------- */

const correctFromCashfree = (token: string, refundId: string) =>
  api().post(`/api/v1/admin/refunds/${refundId}/correct-from-cashfree`).set('Authorization', bearer(token));
const cashfreeRefundPosts = () => cashfree.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/refunds')).length;

describe('correcting a refund recorded FAILED that Cashfree completed', () => {
  /** A cancelled single-seller order whose seller refund our ledger has as FAILED while Cashfree holds it SUCCESSFUL. */
  async function failedButPaid() {
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    cashfree.refundStartStatus = 'PENDING';
    await cancelAsCustomer(placed).expect(200);
    const group = await groupOf(placed.orderId);
    const portion = group.refunds.find((r) => r.componentType === 'SELLER_PRODUCT')!;
    // Our record went wrong: FAILED (and the group with it), while Cashfree paid it.
    await prisma.refund.update({ where: { id: portion.id }, data: { status: 'FAILED', failureReason: 'Provider reported the refund as failed.' } });
    await prisma.refundGroup.update({ where: { id: group.id }, data: { status: 'PARTIAL_FAILURE' } });
    cashfree.settleRefund(cashfreeRefundId(portion.id), 'SUCCESS');
    for (const r of group.refunds.filter((x) => x.id !== portion.id)) cashfree.settleRefund(cashfreeRefundId(r.id), 'SUCCESS');
    await ageRefunds(placed.orderId, 5);
    await reconcileCheckoutPayments(); // the fee parts complete; the FAILED one never moves on its own
    return { placed, group, portion };
  }

  it('re-reads Cashfree, records it completed with an immutable correction — no refund sent, group and payment corrected, notified once', async () => {
    const { placed, group, portion } = await failedButPaid();
    const admin = await panelToken();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: portion.id } })).status).toBe('FAILED');
    const postsBefore = cashfreeRefundPosts();

    const res = await correctFromCashfree(admin.token, portion.id).expect(200);
    expect(expectSuccess<{ corrected: boolean; providerStatus: string }>(res.body).data).toMatchObject({ corrected: true, providerStatus: 'SUCCESS' });

    // Never a second refund: nothing was sent to Cashfree, it was only read.
    expect(cashfreeRefundPosts()).toBe(postsBefore);
    expect(cashfree.requests.at(-1)).toMatchObject({ method: 'GET', path: `/orders/${placed.providerOrderId}/refunds/${cashfreeRefundId(portion.id)}` });

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: portion.id } });
    expect(refund.status).toBe('COMPLETED');
    expect(refund.failureReason).toBe('Provider reported the refund as failed.'); // history left in place
    const correction = await prisma.refundCorrection.findUniqueOrThrow({ where: { refundId: portion.id } });
    expect(correction).toMatchObject({
      previousStatus: 'FAILED',
      newStatus: 'COMPLETED',
      previousFailureReason: 'Provider reported the refund as failed.',
      providerStatus: 'SUCCESS',
      actorUserId: admin.userId,
      groupId: group.id,
    });
    expect(correction.evidence).toMatchObject({ refundId: portion.id, providerStatus: 'SUCCESS', mappedStatus: 'COMPLETED' });
    expect(await prisma.auditLog.count({ where: { action: 'refund.correction_failed_to_completed', entityId: placed.orderId } })).toBe(1);

    const after = await prisma.refundGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(after).toMatchObject({ status: 'SUCCESS', refundedPaise: placed.totalPaise });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).toMatchObject({ paymentStatus: 'REFUNDED', status: 'REFUNDED' });
    expect(await prisma.notification.count({ where: { dedupeKey: `refund-group:${group.id}:COMPLETED` } })).toBe(1);

    // Exactly once.
    await correctFromCashfree(admin.token, portion.id).expect(409);
    expect(await prisma.refundCorrection.count()).toBe(1);
  });

  it('changes nothing unless Cashfree itself reports SUCCESS; a verified completion for a FAILED refund alerts admins; STAFF cannot correct', async () => {
    const { aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    const admin = await panelToken();
    cashfree.failNext = { status: 400, code: 'refund_amount_invalid', message: 'invalid refund amount' };
    await cancelAsCustomer(placed).expect(200);
    const group = await groupOf(placed.orderId);
    const failed = group.refunds.find((r) => r.status === 'FAILED')!;

    // Cashfree never created it: nothing to correct.
    const notFound = expectSuccess<{ corrected: boolean; providerStatus: string }>((await correctFromCashfree(admin.token, failed.id).expect(200)).body).data;
    expect(notFound).toMatchObject({ corrected: false, providerStatus: 'NOT_FOUND' });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('FAILED');

    const staff = await panelToken(UserRole.STAFF);
    await correctFromCashfree(staff.token, failed.id).expect(403);
    // A refund that is not FAILED cannot be "corrected".
    const completed = group.refunds.find((r) => r.status === 'COMPLETED')!;
    await correctFromCashfree(admin.token, completed.id).expect(409);
    expect(await prisma.refundCorrection.count()).toBe(0);

    // A signed webhook saying a FAILED refund completed: never applied on its own word — admins are alerted.
    const paid = await failedButPaidWebhookCase();
    expect(await prisma.notification.count({ where: { dedupeKey: `refund:${paid}:RETRY_MISMATCH` } })).toBeGreaterThan(0);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: paid } })).status).toBe('FAILED');
  });

  /** A FAILED-recorded refund Cashfree reports SUCCESS, announced by a signed webhook. Returns its id. */
  async function failedButPaidWebhookCase(): Promise<string> {
    const { aListing } = await twoSellers(storeId, ['9400000341', '9400000342']);
    const placed = await placeOrder('9400000313', [{ listingId: aListing }], PAID);
    cashfree.refundStartStatus = 'PENDING';
    await cancelAsCustomer(placed).expect(200);
    const portion = (await groupOf(placed.orderId)).refunds.find((r) => r.componentType === 'SELLER_PRODUCT')!;
    await prisma.refund.update({ where: { id: portion.id }, data: { status: 'FAILED' } });
    cashfree.settleRefund(cashfreeRefundId(portion.id), 'SUCCESS');
    const hook = cashfree.refundWebhook(cashfreeRefundId(portion.id));
    await api().post('/api/v1/payments/webhook').set(hook.headers).send(hook.raw).expect(200);
    return portion.id;
  }

  it('after delivery: the corrected refund creates the seller deduction exactly once (commission reversed)', async () => {
    const { a, aListing } = await twoSellers(storeId);
    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    const admin = await panelToken();
    await deliver(admin.token, placed);
    const [itemA] = await placed.itemsOf(a);
    cashfree.refundStartStatus = 'PENDING';
    const req = await api()
      .post(`/api/v1/orders/${placed.orderId}/refund-requests`)
      .set('Authorization', bearer(placed.token))
      .field('category', 'MISSING_ITEM')
      .field('description', 'The item was missing from the bag.')
      .field('items', JSON.stringify([{ orderItemId: itemA!.id, qty: 1 }]))
      .expect(201);
    const requestId = expectSuccess<{ id: string }>(req.body).data.id;
    await api().post(`/api/v1/admin/refund-requests/${requestId}/approve`).set('Authorization', bearer(admin.token)).send({ decisionNote: 'Confirmed with the customer.' }).expect(200);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: placed.orderId } });
    await prisma.refund.update({ where: { id: refund.id }, data: { status: 'FAILED' } });
    cashfree.settleRefund(cashfreeRefundId(refund.id), 'SUCCESS');
    expect(await prisma.sellerDeduction.count()).toBe(0);

    await correctFromCashfree(admin.token, refund.id).expect(200);
    await correctFromCashfree(admin.token, refund.id).expect(409);
    const deductions = await prisma.sellerDeduction.findMany({ where: { sellerId: a } });
    expect(deductions).toEqual([expect.objectContaining({ refundId: refund.id, refundedPaise: 60000, amountPaise: 54000, commissionReversedPaise: 6000 })]);
    expect(await prisma.refundGroup.findUniqueOrThrow({ where: { id: refund.groupId! } })).toMatchObject({ status: 'SUCCESS' });
  });
});

/* -------------------------------------------------------------------------- */
/* Whole-order refund guard                                                   */
/* -------------------------------------------------------------------------- */

describe('a whole-order refund never covers a failed part awaiting retry', () => {
  it('blocked while a seller portion refund definitively failed; an unrelated failed refund of another payment does not block', async () => {
    // No fees, so the seller portion is the only part.
    await configService.set({ key: ConfigKey.PLATFORM_FEE_PAISE, value: 0 as never });
    await configService.set({ key: ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE, value: 0 as never });
    const { aListing } = await twoSellers(storeId);
    const admin = await panelToken();

    const placed = await placeOrder(CUSTOMER, [{ listingId: aListing }], PAID);
    cashfree.failNext = { status: 400, code: 'refund_amount_invalid', message: 'invalid refund amount' };
    await cancelAsCustomer(placed).expect(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect([order.status, order.paymentStatus]).toEqual(['CANCELLED', 'PAID']);
    const postsBefore = cashfreeRefundPosts();
    const blocked = await api()
      .post(`/api/v1/admin/orders/${placed.orderId}/refund`)
      .set('Authorization', bearer(admin.token))
      .send({ reason: 'Refund everything' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Retry it from Refunds/);
    expect(cashfreeRefundPosts()).toBe(postsBefore);
    expect(await prisma.refund.count({ where: { orderId: placed.orderId } })).toBe(1);

    // Another cancelled, still-paid order with a FAILED refund on a different (orphan) payment: not blocked.
    const other = await placeOrder('9400000314', [{ listingId: aListing }], PAID);
    await prisma.sellerOrder.updateMany({ where: { orderId: other.orderId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await prisma.order.update({ where: { id: other.orderId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    const captured = await prisma.payment.findFirstOrThrow({ where: { orderId: other.orderId, status: 'CAPTURED' } });
    const orphan = await prisma.payment.create({
      data: { orderId: other.orderId, provider: captured.provider, providerOrderId: `${captured.providerOrderId}_late`, providerPaymentId: 'late_1', amountPaise: 500, status: 'CAPTURED', failureCode: 'ORPHAN_CAPTURE' },
    });
    await prisma.refund.create({ data: { paymentId: orphan.id, orderId: other.orderId, amountPaise: 500, status: 'FAILED', componentType: 'ORPHAN_PAYMENT' } });
    await api().post(`/api/v1/admin/orders/${other.orderId}/refund`).set('Authorization', bearer(admin.token)).send({ reason: 'Refund everything' }).expect(200);
    expect(await prisma.refund.count({ where: { orderId: other.orderId, componentType: 'FULL_ORDER', status: 'COMPLETED' } })).toBe(1);
  });
});
