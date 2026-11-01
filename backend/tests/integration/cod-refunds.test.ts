/**
 * Refund management — Cash on Delivery refunds, paid by an admin's own UPI /
 * bank transfer, under DUAL CONTROL (final approved policy):
 *
 *   - Admin A records the transfer; a DIFFERENT Admin B confirms it. The
 *     recorder confirming their own payout is refused (403); STAFF can do
 *     neither;
 *   - recording is never success; only the valid confirmation makes the
 *     refund successful, records the seller deductions (commission reversed)
 *     and tells the customer — exactly once, also under concurrent clicks;
 *   - a record that no longer matches the approval cannot be confirmed;
 *   - one transfer reference pays one refund, however typed, under any method;
 *   - never a Cashfree call.
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

import { ConfigKey, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { normalizeReference } from '../../src/modules/refunds/admin-refund.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedStore } from '../helpers/fixtures';
import { COD, deliver, panelToken, placeOrder, twoSellers, type Placed } from '../helpers/refund-fixtures';

const CUSTOMER = '9400000611';
let storeId: string;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configService.set({ key: ConfigKey.COD_FIRST_ORDER_MAX_PAISE, value: 300_000 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
});

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** A delivered two-seller COD order with an approved ₹1,000 refund request (A ₹600, B ₹400). */
async function approvedCodRefund(mobiles: [string, string] = ['9400000621', '9400000622'], customer = CUSTOMER) {
  const { a, b, aListing, bListing } = await twoSellers(storeId, mobiles);
  const placed: Placed = await placeOrder(customer, [{ listingId: aListing }, { listingId: bListing }], COD);
  const adminA = await panelToken();
  const adminB = await panelToken();
  await deliver(adminA.token, placed);
  const [itemA] = await placed.itemsOf(a);
  const [itemB] = await placed.itemsOf(b);
  const res = await api()
    .post(`/api/v1/orders/${placed.orderId}/refund-requests`)
    .set('Authorization', bearer(placed.token))
    .field('category', 'MISSING_ITEM')
    .field('description', 'Both items were missing from the bag.')
    .field('items', JSON.stringify([{ orderItemId: itemA!.id, qty: 1 }, { orderItemId: itemB!.id, qty: 1 }]));
  if (res.status !== 201) throw new Error(`request failed: ${res.status} ${JSON.stringify(res.body)}`);
  const requestId = expectSuccess<{ id: string }>(res.body).data.id;
  await api()
    .post(`/api/v1/admin/refund-requests/${requestId}/approve`)
    .set('Authorization', bearer(adminA.token))
    .send({ decisionNote: 'Customer confirmed by phone.' })
    .expect(200);
  const groupId = (await prisma.refundRequest.findUniqueOrThrow({ where: { id: requestId } })).groupId!;
  return { placed, adminA, adminB, a, b, groupId };
}

const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/admin/refund-groups/${groupId}/cod-payout`).set('Authorization', bearer(token)).send(body);
const confirm = (token: string, groupId: string) =>
  api().post(`/api/v1/admin/refund-groups/${groupId}/cod-payout/confirm`).set('Authorization', bearer(token));
const customerStatus = async (placed: Placed) =>
  expectSuccess<{ refunds: { status: string; refundedPaise: number; destination: string }[] }>(
    (await api().get(`/api/v1/orders/${placed.orderId}/refunds`).set('Authorization', bearer(placed.token)).expect(200)).body,
  ).data.refunds[0]!;
const completionNotices = (groupId: string) => prisma.notification.count({ where: { dedupeKey: `refund-group:${groupId}:COMPLETED` } });
const cashfreeRefundCalls = () => cashfree.requests.filter((r) => r.path.includes('/refunds')).length;

describe('COD refunds — dual control', () => {
  it('1, 5, 6: Admin A records, Admin B confirms — only then success, deductions (commission reversed) once, customer told once; never Cashfree', async () => {
    const { placed, adminA, adminB, a, b, groupId } = await approvedCodRefund();
    expect(await customerStatus(placed)).toMatchObject({ status: 'APPROVED', destination: 'BANK_TRANSFER', refundedPaise: 0 });

    const recorded = expectSuccess<{ status: string; manualPayout: { status: string; amountPaise: number; reference: string } }>(
      (await record(adminA.token, groupId, { method: 'UPI', reference: 'upi 4123-4567-8901', paidOn: today(), proofNote: 'Screenshot in ticket 812' }).expect(200))
        .body,
    ).data;
    expect(recorded.status).toBe('PROCESSING');
    // The entered reference is kept as typed; duplicates are compared normalized.
    expect(recorded.manualPayout).toMatchObject({ status: 'RECORDED', amountPaise: 100000, reference: 'upi 4123-4567-8901' });
    expect((await prisma.manualRefundPayout.findFirstOrThrow({ where: { groupId } })).referenceNormalized).toBe('UPI412345678901');

    // Recorded is not success: no completion notice, no seller charged.
    expect(await customerStatus(placed)).toMatchObject({ status: 'PROCESSING', refundedPaise: 0 });
    expect(await completionNotices(groupId)).toBe(0);
    expect(await prisma.sellerDeduction.count()).toBe(0);

    const done = expectSuccess<{ status: string; refundedPaise: number; manualPayout: { status: string; recordedBy: string; confirmedBy: string } }>(
      (await confirm(adminB.token, groupId).expect(200)).body,
    ).data;
    expect(done).toMatchObject({ status: 'SUCCESS', refundedPaise: 100000, manualPayout: { status: 'CONFIRMED' } });
    const payout = await prisma.manualRefundPayout.findFirstOrThrow({ where: { groupId } });
    expect(payout).toMatchObject({ recordedByUserId: adminA.userId, confirmedByUserId: adminB.userId, status: 'CONFIRMED' });
    expect(payout.confirmedAt).not.toBeNull();
    expect(await customerStatus(placed)).toMatchObject({ status: 'SUCCESS', refundedPaise: 100000 });
    expect(await completionNotices(groupId)).toBe(1);

    // The sellers give back their net (commission reversed): A 540 of 600, B 360 of 400.
    const deductions = await prisma.sellerDeduction.findMany({ orderBy: { amountPaise: 'desc' } });
    expect(deductions.map((d) => [d.sellerId, d.refundedPaise, d.amountPaise, d.commissionReversedPaise])).toEqual([
      [a, 60000, 54000, 6000],
      [b, 40000, 36000, 4000],
    ]);
    expect(await prisma.notification.count({ where: { type: 'SELLER_REFUND_ISSUED' } })).toBe(2);

    // 4: a second confirmation changes nothing.
    await confirm(adminB.token, groupId).expect(409);
    expect(await prisma.sellerDeduction.count()).toBe(2);
    expect(await completionNotices(groupId)).toBe(1);

    // The full trail: who recorded and who confirmed, amount, method, reference, proof.
    const recordAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'refund.manual_payout_record', entityId: groupId } });
    expect(recordAudit).toMatchObject({ actorUserId: adminA.userId });
    expect(recordAudit.after).toMatchObject({ amountPaise: 100000, method: 'UPI', reference: 'upi 4123-4567-8901', proofNote: 'Screenshot in ticket 812' });
    const confirmAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'refund.manual_payout_confirm', entityId: groupId } });
    expect(confirmAudit).toMatchObject({ actorUserId: adminB.userId });
    expect(confirmAudit.after).toMatchObject({ recordedByUserId: adminA.userId, confirmedByUserId: adminB.userId, amountPaise: 100000 });
    expect(cashfreeRefundCalls()).toBe(0);
    expect(await prisma.refund.count()).toBe(0);
  });

  it('2: the recorder cannot confirm their own payout (403) — nothing changes', async () => {
    const { placed, adminA, groupId } = await approvedCodRefund();
    await record(adminA.token, groupId, { method: 'BANK_TRANSFER', reference: 'UTR000000777', paidOn: today() }).expect(200);
    const res = await confirm(adminA.token, groupId).expect(403);
    expect(res.body.error.message).toMatch(/different admin/i);
    expect(await customerStatus(placed)).toMatchObject({ status: 'PROCESSING' });
    expect(await prisma.sellerDeduction.count()).toBe(0);
    expect(await completionNotices(groupId)).toBe(0);
    expect((await prisma.manualRefundPayout.findFirstOrThrow({ where: { groupId } })).status).toBe('RECORDED');
  });

  it('3: STAFF can neither record nor confirm', async () => {
    const { adminA, groupId } = await approvedCodRefund();
    const staff = await panelToken(UserRole.STAFF);
    await record(staff.token, groupId, { method: 'UPI', reference: 'UPI400000000001', paidOn: today() }).expect(403);
    await record(adminA.token, groupId, { method: 'UPI', reference: 'UPI400000000001', paidOn: today() }).expect(200);
    await confirm(staff.token, groupId).expect(403);
    expect((await prisma.manualRefundPayout.findFirstOrThrow({ where: { groupId } })).status).toBe('RECORDED');
  });

  it('7: a record that no longer matches the approval (or an invalid reference) cannot be confirmed; nor can an unrecorded one', async () => {
    const first = await approvedCodRefund();
    await confirm(first.adminB.token, first.groupId).expect(409); // nothing recorded yet
    await record(first.adminA.token, first.groupId, { method: 'UPI', reference: 'UPI400000000111', paidOn: today() }).expect(200);
    // The stored amount was tampered with after recording.
    await prisma.manualRefundPayout.updateMany({ where: { groupId: first.groupId }, data: { amountPaise: 99999 } });
    const res = await confirm(first.adminB.token, first.groupId).expect(409);
    expect(res.body.error.message).toMatch(/amount does not match/);

    const second = await approvedCodRefund(['9400000631', '9400000632'], '9400000612');
    await record(second.adminA.token, second.groupId, { method: 'UPI', reference: 'UPI400000000222', paidOn: today() }).expect(200);
    // The entered reference no longer matches its normalized form.
    await prisma.manualRefundPayout.updateMany({ where: { groupId: second.groupId }, data: { reference: 'SOMETHING-ELSE-1' } });
    expect((await confirm(second.adminB.token, second.groupId).expect(409)).body.error.message).toMatch(/reference is not valid/);
    expect(await prisma.sellerDeduction.count()).toBe(0);
  });

  it('8: concurrent confirmations — exactly one succeeds; deductions and notices once', async () => {
    const { adminA, adminB, groupId } = await approvedCodRefund();
    const adminC = await panelToken();
    await record(adminA.token, groupId, { method: 'UPI', reference: 'UPI400000000333', paidOn: today() }).expect(200);
    const results = await Promise.all([confirm(adminB.token, groupId), confirm(adminC.token, groupId), confirm(adminB.token, groupId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await prisma.sellerDeduction.count()).toBe(2);
    expect(await completionNotices(groupId)).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'refund.manual_payout_confirm', entityId: groupId } })).toBe(1);
  });
});

describe('COD transfer references', () => {
  it('normalized before the duplicate check: case, spaces and separators, and the same UTR under UPI or bank transfer, are one transfer', async () => {
    expect(normalizeReference('  utr 1234-56/78 ')).toBe('UTR12345678');
    const first = await approvedCodRefund();
    await record(first.adminA.token, first.groupId, { method: 'UPI', reference: 'abc', paidOn: today() }).expect(400);
    await record(first.adminA.token, first.groupId, { method: 'UPI', reference: 'UPI400000000001', paidOn: '2099-01-01' }).expect(400);
    await record(first.adminA.token, first.groupId, { method: 'UPI', reference: 'UTR4000-0000-0001', paidOn: today() }).expect(200);
    // Recorded once per refund.
    await record(first.adminA.token, first.groupId, { method: 'UPI', reference: 'UPI400000000002', paidOn: today() }).expect(409);

    const second = await approvedCodRefund(['9400000631', '9400000632'], '9400000612');
    for (const reference of ['utr400000000001', 'UTR 4000 0000 0001', 'utr-4000-0000-0001']) {
      await record(second.adminA.token, second.groupId, { method: 'UPI', reference, paidOn: today() }).expect(409);
      await record(second.adminA.token, second.groupId, { method: 'BANK_TRANSFER', reference, paidOn: today() }).expect(409);
    }
    // Enforced by the database too, not only the check above.
    await expect(
      prisma.manualRefundPayout.create({
        data: {
          groupId: second.groupId,
          orderId: second.placed.orderId,
          userId: second.placed.userId,
          amountPaise: 100000,
          method: 'BANK_TRANSFER',
          reference: 'utr400000000001',
          referenceNormalized: 'UTR400000000001',
          paidOn: new Date(),
          recordedByUserId: second.adminA.userId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await record(second.adminA.token, second.groupId, { method: 'BANK_TRANSFER', reference: 'UTR400000000009', paidOn: today() }).expect(200);
    expect(cashfreeRefundCalls()).toBe(0);
  });

  it('a manual refund is never retried through Cashfree', async () => {
    const { adminA, groupId } = await approvedCodRefund();
    await api().post(`/api/v1/admin/refund-groups/${groupId}/retry`).set('Authorization', bearer(adminA.token)).expect(400);
    expect(cashfree.requests).toEqual([]);
  });
});
