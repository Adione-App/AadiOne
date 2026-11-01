/**
 * Admin refund management — refund requests (review, approve, reject).
 * Every caller holds ORDER_REFUND (admin-refund.routes.ts).
 *
 * APPROVAL never trusts an earlier number. Under the captured payment's lock
 * (online) and the request's lock it re-reads what is still refundable per
 * item (earlier approvals count), what remains captured, and only then:
 *   - spreads the approved amount over the items (exactly, never above any
 *     item's value), sums it per seller portion;
 *   - creates ONE refund group (origin CUSTOMER_REQUEST, after delivery);
 *   - online: one SELLER_PRODUCT component per seller portion, reserved in
 *     the same transaction and issued through the existing Cashfree engine;
 *   - COD: a MANUAL group — no Cashfree call ever; it is paid by the admin's
 *     own UPI / bank transfer, recorded and then confirmed (Phase 6).
 * Fees are never part of a request (they are not an item).
 */

import { ManualPayoutMethod, ManualPayoutStatus, Prisma, RefundGroupChannel, RefundGroupOrigin, RefundGroupStatus, RefundRequestStatus } from '@prisma/client';
import { ErrorCode, NotificationType, PaymentMethod } from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { privateDocuments } from '../../infra/storage/private-documents';
import * as notificationService from '../notifications/notification.service';
import * as paymentService from '../payments/payment.service';
import { announceGroup, attachGroup, recomputeGroup, withRefundAction } from './refund-action';
import { announceDeductions, recordDeductionsForConfirmedPayout } from '../sellers/seller-deduction.service';
import { REFUND_REQUEST_CATEGORY_LABELS, allocationLines, refundableItems, type AllocationLine } from './customer-refund.service';
import { allocateApproved, perSellerOrder } from './refund-request-rules';

const log = moduleLogger('admin-refunds');

interface StoredLine {
  orderItemId: string;
  sellerOrderId: string;
  sellerId: string;
  productName: string;
  variantName: string;
  qty: number;
  amountPaise: number;
}

function storedLines(items: Prisma.JsonValue): StoredLine[] {
  return Array.isArray(items) ? (items as unknown as StoredLine[]) : [];
}

/* -------------------------------------------------------------------------- */
/* List and detail                                                            */
/* -------------------------------------------------------------------------- */

export async function listRefundRequests(query: { status?: RefundRequestStatus; cursor?: string | null; limit: number }) {
  const rows = await prisma.refundRequest.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { createdAt: { lt: new Date(query.cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit + 1,
    include: {
      order: { select: { orderNumber: true, paymentMethod: true, user: { select: { fullName: true, mobile: true } } } },
      group: { select: { id: true, status: true } },
      _count: { select: { evidence: true } },
    },
  });
  const items = rows.slice(0, query.limit).map((r) => ({
    id: r.id,
    orderId: r.orderId,
    orderNumber: r.order.orderNumber,
    customerName: r.order.user.fullName,
    customerMobile: r.order.user.mobile,
    paymentMethod: r.order.paymentMethod,
    category: r.category,
    categoryLabel: REFUND_REQUEST_CATEGORY_LABELS[r.category],
    requestedPaise: r.requestedPaise,
    approvedPaise: r.approvedPaise,
    status: r.status,
    groupId: r.group?.id ?? null,
    groupStatus: r.group?.status ?? null,
    photoCount: r._count.evidence,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > query.limit && last ? last.createdAt : null };
}

export async function getRefundRequestDetail(requestId: string) {
  const request = await prisma.refundRequest.findUnique({
    where: { id: requestId },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentMethod: true,
          paymentStatus: true,
          totalPaise: true,
          deliveredAt: true,
          user: { select: { id: true, fullName: true, mobile: true } },
        },
      },
      evidence: { select: { id: true, contentType: true, sizeBytes: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      group: { select: { id: true, status: true, totalPaise: true, refundedPaise: true, channel: true } },
    },
  });
  if (!request) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Refund request not found.' });

  const items = new Map((await refundableItems(prisma, request.orderId)).map((i) => [i.id, i]));
  const lines = storedLines(request.items).map((line) => ({
    ...line,
    paidPaise: items.get(line.orderItemId)?.paidPaise ?? 0,
    stillRefundablePaise: items.get(line.orderItemId)?.remainingPaise ?? 0,
  }));
  const sellerIds = [...new Set(lines.map((l) => l.sellerId))];
  const sellers = new Map(
    (await prisma.seller.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]),
  );
  const reviewer = request.reviewedByUserId
    ? await prisma.user.findUnique({ where: { id: request.reviewedByUserId }, select: { fullName: true, email: true } })
    : null;

  return {
    id: request.id,
    status: request.status,
    category: request.category,
    categoryLabel: REFUND_REQUEST_CATEGORY_LABELS[request.category],
    description: request.description,
    requestedPaise: request.requestedPaise,
    approvedPaise: request.approvedPaise,
    // What could be approved right now (earlier approvals deducted).
    approvablePaise: Math.min(
      request.requestedPaise,
      lines.reduce((sum, l) => sum + Math.min(l.amountPaise, l.stillRefundablePaise), 0),
    ),
    decisionNote: request.decisionNote,
    reviewedBy: reviewer ? (reviewer.fullName ?? reviewer.email) : null,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    order: {
      id: request.order.id,
      orderNumber: request.order.orderNumber,
      status: request.order.status,
      paymentMethod: request.order.paymentMethod,
      paymentStatus: request.order.paymentStatus,
      totalPaise: request.order.totalPaise,
      deliveredAt: request.order.deliveredAt?.toISOString() ?? null,
    },
    customer: { id: request.order.user.id, name: request.order.user.fullName, mobile: request.order.user.mobile },
    lines: lines.map((l) => ({ ...l, sellerName: sellers.get(l.sellerId) ?? null })),
    evidence: request.evidence.map((e) => ({ id: e.id, contentType: e.contentType, sizeBytes: e.sizeBytes, createdAt: e.createdAt.toISOString() })),
    group: request.group,
  };
}

/** One evidence photo's bytes — read through this endpoint only (never a URL). Audited. */
export async function readEvidence(requestId: string, evidenceId: string, adminUserId: string) {
  const evidence = await prisma.refundRequestEvidence.findFirst({ where: { id: evidenceId, requestId } });
  if (!evidence) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Photo not found.' });
  const bytes = await privateDocuments.get(evidence.storageKey);
  await prisma.auditLog.create({
    data: {
      actorUserId: adminUserId,
      action: 'refund_request.evidence_view',
      entityType: 'RefundRequest',
      entityId: requestId,
      after: { evidenceId },
    },
  });
  return { bytes, contentType: evidence.contentType };
}

/* -------------------------------------------------------------------------- */
/* Approve                                                                    */
/* -------------------------------------------------------------------------- */

export interface ApproveInput {
  /** Defaults to everything still approvable. Never above the requested amount. */
  approvedPaise?: number;
  decisionNote: string;
}

export async function approveRefundRequest(requestId: string, adminUserId: string, input: ApproveInput) {
  const peek = await prisma.refundRequest.findUnique({
    where: { id: requestId },
    select: { orderId: true, category: true, order: { select: { paymentMethod: true } } },
  });
  if (!peek) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Refund request not found.' });
  const online = peek.order.paymentMethod === PaymentMethod.ONLINE;
  const reason = `Refund request approved: ${REFUND_REQUEST_CATEGORY_LABELS[peek.category]}`;

  return withRefundAction(
    { origin: RefundGroupOrigin.CUSTOMER_REQUEST, reason, actorUserId: adminUserId, postDelivery: true },
    async () => {
      const outcome = await runInTransaction(async (tx) => {
        // Lock order: the captured payment (as every refund does), then the request.
        const payment = online ? await paymentService.lockCapturedPaymentForRefund(tx, peek.orderId) : null;
        if (online && !payment) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'This order has no captured payment left to refund.' });
        }
        await tx.$queryRaw`SELECT id FROM refund_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
        const request = await tx.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
        if (request.status !== RefundRequestStatus.UNDER_REVIEW) {
          throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'This request has already been decided.' });
        }
        const order = await tx.order.findUniqueOrThrow({ where: { id: request.orderId }, select: { id: true, userId: true, status: true } });
        if (order.status !== 'DELIVERED') {
          throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'Only a delivered order can be refunded through a request.' });
        }

        // Revalidate: what is still refundable per item NOW.
        const items = new Map((await refundableItems(tx, order.id)).map((i) => [i.id, i]));
        const lines = storedLines(request.items).map((line) => ({
          ...line,
          amountPaise: Math.min(line.amountPaise, items.get(line.orderItemId)?.remainingPaise ?? 0),
        }));
        const approvable = Math.min(request.requestedPaise, lines.reduce((sum, l) => sum + l.amountPaise, 0));
        if (approvable <= 0) {
          throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'These items have already been refunded. Reject the request instead.' });
        }
        const approvedPaise = input.approvedPaise ?? approvable;
        if (!Number.isInteger(approvedPaise) || approvedPaise <= 0) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter an amount above zero.' });
        }
        if (approvedPaise > approvable) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, {
            message: `At most ₹${(approvable / 100).toFixed(2)} can be approved for these items.`,
          });
        }
        if (payment && approvedPaise > payment.remainingPaise) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, {
            message: `Only ₹${(payment.remainingPaise / 100).toFixed(2)} of the payment is left to refund.`,
          });
        }

        const allocated = allocateApproved(lines, approvedPaise).filter((l) => l.approvedPaise > 0);
        const allocation: AllocationLine[] = allocated.map((l) => ({
          orderItemId: l.orderItemId,
          sellerOrderId: l.sellerOrderId,
          sellerId: l.sellerId,
          amountPaise: l.approvedPaise,
        }));

        let groupId: string;
        const reserved: paymentService.ReservedGroupRefund[] = [];
        if (payment) {
          groupId = await attachGroup(tx, order, reason);
          await tx.refundGroup.update({ where: { id: groupId }, data: { allocation: allocation as unknown as Prisma.InputJsonValue } });
          for (const [sellerOrderId, amountPaise] of perSellerOrder(allocated)) {
            reserved.push(
              await paymentService.reserveGroupComponent(tx, {
                payment,
                orderId: order.id,
                groupId,
                sellerOrderId,
                componentType: 'SELLER_PRODUCT',
                amountPaise,
                reason,
                actorUserId: adminUserId,
              }),
            );
          }
        } else {
          // Cash on Delivery: nothing to refund through Cashfree — ever.
          const group = await tx.refundGroup.create({
            data: {
              orderId: order.id,
              userId: order.userId,
              origin: RefundGroupOrigin.CUSTOMER_REQUEST,
              channel: RefundGroupChannel.MANUAL,
              reason,
              postDelivery: true,
              allocation: allocation as unknown as Prisma.InputJsonValue,
              createdByUserId: adminUserId,
            },
          });
          groupId = group.id;
        }
        await recomputeGroup(tx, groupId);

        await tx.refundRequest.update({
          where: { id: requestId },
          data: {
            status: RefundRequestStatus.APPROVED,
            approvedPaise,
            decisionNote: input.decisionNote,
            reviewedByUserId: adminUserId,
            reviewedAt: new Date(),
            groupId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: adminUserId,
            action: 'refund_request.approve',
            entityType: 'RefundRequest',
            entityId: requestId,
            before: { status: request.status, requestedPaise: request.requestedPaise },
            after: {
              status: RefundRequestStatus.APPROVED,
              approvedPaise,
              groupId,
              channel: payment ? RefundGroupChannel.CASHFREE : RefundGroupChannel.MANUAL,
              allocation,
              decisionNote: input.decisionNote,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return { groupId, reserved, approvedPaise };
      });

      // Money moves only after the decision is committed.
      await paymentService.executeGroupRefunds(outcome.reserved);
      log.info({ requestId, groupId: outcome.groupId, approvedPaise: outcome.approvedPaise, online }, 'refund request approved');
      return getRefundRequestDetail(requestId);
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Reject                                                                     */
/* -------------------------------------------------------------------------- */

export async function rejectRefundRequest(requestId: string, adminUserId: string, decisionNote: string) {
  const request = await runInTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM refund_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
    const current = await tx.refundRequest.findUnique({ where: { id: requestId }, include: { order: { select: { orderNumber: true } } } });
    if (!current) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Refund request not found.' });
    if (current.status !== RefundRequestStatus.UNDER_REVIEW) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'This request has already been decided.' });
    }
    await tx.refundRequest.update({
      where: { id: requestId },
      data: { status: RefundRequestStatus.REJECTED, decisionNote, reviewedByUserId: adminUserId, reviewedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'refund_request.reject',
        entityType: 'RefundRequest',
        entityId: requestId,
        before: { status: current.status },
        after: { status: RefundRequestStatus.REJECTED, decisionNote },
      },
    });
    return current;
  });
  await notificationService.notify({
    userId: request.userId,
    type: NotificationType.REFUND_UPDATE,
    dedupeKey: `refund-request:${requestId}:REJECTED`,
    orderId: request.orderId,
    context: { orderNumber: request.order.orderNumber, refundStage: 'REQUEST_REJECTED', reason: decisionNote },
  });
  log.info({ requestId, adminUserId }, 'refund request rejected');
  return getRefundRequestDetail(requestId);
}

/* -------------------------------------------------------------------------- */
/* Cash on Delivery — manual UPI / bank payouts (never Cashfree)              */
/*                                                                            */
/* DUAL CONTROL (final approved policy): Admin A records the transfer, a      */
/* DIFFERENT Admin B confirms it. Only the confirmation makes the refund      */
/* successful, records the seller deductions and tells the customer.          */
/* -------------------------------------------------------------------------- */

export interface RecordPayoutInput {
  method: ManualPayoutMethod;
  /** The UPI transaction id / bank UTR, as entered (kept for display and audit). */
  reference: string;
  /** "YYYY-MM-DD" the transfer was made. */
  paidOn: string;
  /** Where the proof is kept (e.g. "screenshot in ticket #123"). Never bank details. */
  proofNote?: string | null;
}

/**
 * The reference as compared for duplicates: letters and digits only,
 * upper-case — "utr 1234-56" and "UTR123456" are the same transfer, under
 * any method. Same rule as the migration's backfill (and its CHECK).
 */
export function normalizeReference(reference: string): string {
  return reference.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

const NORMALIZED_REFERENCE = /^[A-Z0-9]{6,120}$/;

function todayInIndia(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

async function lockManualGroup(tx: Prisma.TransactionClient, groupId: string) {
  await tx.$queryRaw`SELECT id FROM refund_groups WHERE id = ${groupId}::uuid FOR UPDATE`;
  const group = await tx.refundGroup.findUnique({ where: { id: groupId }, include: { manualPayout: true } });
  if (!group) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Refund not found.' });
  if (group.channel !== RefundGroupChannel.MANUAL) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This refund goes back through Cashfree — a manual payout cannot be recorded for it.',
    });
  }
  return group;
}

/**
 * Step 1 (Admin A) — records the transfer made: method, reference, date,
 * proof. The group becomes PROCESSING — NOT successful: that needs a second
 * admin's confirmation (step 2). The amount is the approved amount, never typed.
 */
export async function recordManualPayout(groupId: string, adminUserId: string, input: RecordPayoutInput) {
  const reference = input.reference.trim();
  const referenceNormalized = normalizeReference(reference);
  if (!NORMALIZED_REFERENCE.test(referenceNormalized)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter the UPI transaction id or bank UTR (at least 6 letters or digits).' });
  }
  const paidOn = new Date(`${input.paidOn}T00:00:00.000Z`);
  if (Number.isNaN(paidOn.getTime()) || input.paidOn > todayInIndia()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter the date the transfer was made (not a future date).' });
  }
  try {
    await runInTransaction(async (tx) => {
      const group = await lockManualGroup(tx, groupId);
      if (group.manualPayout) {
        throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'A payout is already recorded for this refund.' });
      }
      if (group.createdAt.toISOString().slice(0, 10) > input.paidOn) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The transfer date is before the refund was approved.' });
      }
      const duplicate = await tx.manualRefundPayout.findUnique({ where: { referenceNormalized }, select: { id: true } });
      if (duplicate) throw duplicateReference();
      const amountPaise = allocationLines(group.allocation).reduce((sum, l) => sum + l.amountPaise, 0);
      if (amountPaise <= 0) throw new AppError(ErrorCode.INTERNAL_ERROR, { internalMessage: `manual group ${groupId} has no allocation` });
      const payout = await tx.manualRefundPayout.create({
        data: {
          groupId,
          orderId: group.orderId,
          userId: group.userId,
          amountPaise,
          method: input.method,
          reference,
          referenceNormalized,
          paidOn,
          proofNote: input.proofNote ?? null,
          recordedByUserId: adminUserId,
        },
      });
      await recomputeGroup(tx, groupId);
      await tx.auditLog.create({
        data: {
          actorUserId: adminUserId,
          action: 'refund.manual_payout_record',
          entityType: 'RefundGroup',
          entityId: groupId,
          // The reference identifies the transfer; no account or UPI handle is stored or logged.
          after: {
            payoutId: payout.id,
            amountPaise,
            method: input.method,
            reference,
            referenceNormalized,
            paidOn: input.paidOn,
            proofNote: input.proofNote ?? null,
            recordedByUserId: adminUserId,
          },
        },
      });
    });
  } catch (error) {
    // A concurrent record of the same transfer loses on the unique index.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw duplicateReference();
    throw error;
  }
  // The group is PROCESSING: the customer's "refund started" notice at most (deduplicated).
  await announceGroup(groupId);
  log.info({ groupId, adminUserId, method: input.method }, 'manual refund payout recorded');
  return getRefundGroupDetail(groupId);
}

function duplicateReference(): AppError {
  return new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
    message: 'This transaction reference is already recorded — for this or another refund, under any method.',
  });
}

/**
 * Step 2 (Admin B, never the recorder) — confirms the recorded transfer
 * reached the customer. The record is re-validated first (amount, reference,
 * date, state). Only now is the group SUCCESS, the sellers' deductions
 * recorded (one per seller portion, never twice) and the customer told.
 * Exactly once: the group row is locked and the status moves by
 * compare-and-set.
 */
export async function confirmManualPayout(groupId: string, adminUserId: string) {
  const outcome = await runInTransaction(async (tx) => {
    const group = await lockManualGroup(tx, groupId);
    const payout = group.manualPayout;
    if (!payout) throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'Record the transfer before confirming it.' });
    if (payout.status === ManualPayoutStatus.CONFIRMED) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'This payout is already confirmed.' });
    }
    if (payout.recordedByUserId === adminUserId) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'A different admin must confirm this payout — you recorded it.',
        internalMessage: `admin ${adminUserId} tried to confirm the payout they recorded (${payout.id})`,
      });
    }
    // The record must still be exactly what was approved.
    const allocated = allocationLines(group.allocation).reduce((sum, l) => sum + l.amountPaise, 0);
    const problems = [
      payout.amountPaise !== allocated || allocated <= 0 ? 'the amount does not match the approved refund' : null,
      payout.referenceNormalized !== normalizeReference(payout.reference) || !NORMALIZED_REFERENCE.test(payout.referenceNormalized)
        ? 'the transaction reference is not valid'
        : null,
      payout.paidOn.toISOString().slice(0, 10) > todayInIndia() ? 'the transfer date is in the future' : null,
      group.status !== 'PROCESSING' ? `the refund is ${group.status}, not awaiting confirmation` : null,
      payout.orderId !== group.orderId || payout.userId !== group.userId ? 'the record does not belong to this refund' : null,
    ].filter((p): p is string => p !== null);
    if (problems.length > 0) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: `This payout record cannot be confirmed: ${problems.join('; ')}.`,
      });
    }

    const confirmedAt = new Date();
    const confirmed = await tx.manualRefundPayout.updateMany({
      where: { id: payout.id, status: ManualPayoutStatus.RECORDED, recordedByUserId: { not: adminUserId } },
      data: { status: ManualPayoutStatus.CONFIRMED, confirmedByUserId: adminUserId, confirmedAt },
    });
    if (confirmed.count === 0) throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'This payout is already confirmed.' });
    await recomputeGroup(tx, groupId);
    const deductions = group.postDelivery
      ? await recordDeductionsForConfirmedPayout(
          tx,
          { payoutId: payout.id, groupId, orderId: group.orderId, reason: group.reason, lines: allocationLines(group.allocation) },
          adminUserId,
        )
      : [];
    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'refund.manual_payout_confirm',
        entityType: 'RefundGroup',
        entityId: groupId,
        before: { status: ManualPayoutStatus.RECORDED },
        after: {
          payoutId: payout.id,
          status: ManualPayoutStatus.CONFIRMED,
          amountPaise: payout.amountPaise,
          method: payout.method,
          reference: payout.reference,
          referenceNormalized: payout.referenceNormalized,
          paidOn: payout.paidOn.toISOString().slice(0, 10),
          proofNote: payout.proofNote,
          recordedByUserId: payout.recordedByUserId,
          recordedAt: payout.recordedAt.toISOString(),
          confirmedByUserId: adminUserId,
          confirmedAt: confirmedAt.toISOString(),
          deductions: deductions.map((d) => ({ deductionId: d.deductionId, sellerId: d.sellerId, amountPaise: d.amountPaise })),
        },
      },
    });
    return { deductions };
  });
  // After commit: the customer's completion notice and each seller's deduction notice.
  await announceGroup(groupId);
  await announceDeductions(outcome.deductions);
  log.info({ groupId, adminUserId }, 'manual refund payout confirmed');
  return getRefundGroupDetail(groupId);
}

/* -------------------------------------------------------------------------- */
/* Refund groups — overview, list, detail (admin dashboard)                   */
/* -------------------------------------------------------------------------- */

/** What needs attention, at a glance. */
export async function refundOverview() {
  const [underReview, byStatus, manualAwaitingPayout, manualAwaitingConfirmation, deductions] = await Promise.all([
    prisma.refundRequest.count({ where: { status: RefundRequestStatus.UNDER_REVIEW } }),
    prisma.refundGroup.groupBy({ by: ['status'], _count: { _all: true }, _sum: { totalPaise: true, refundedPaise: true } }),
    prisma.refundGroup.count({ where: { channel: RefundGroupChannel.MANUAL, manualPayout: { is: null } } }),
    prisma.manualRefundPayout.count({ where: { status: ManualPayoutStatus.RECORDED } }),
    prisma.sellerDeduction.aggregate({ where: { status: { not: 'APPLIED' } }, _sum: { amountPaise: true, appliedPaise: true } }),
  ]);
  const count = (status: string) => byStatus.find((s) => s.status === status)?._count._all ?? 0;
  return {
    requestsUnderReview: underReview,
    processing: count('PROCESSING'),
    approvedNotStarted: count('APPROVED'),
    partialFailures: count('PARTIAL_FAILURE'),
    failed: count('FAILED'),
    succeeded: count('SUCCESS'),
    manualAwaitingPayout,
    manualAwaitingConfirmation,
    outstandingSellerDeductionsPaise: (deductions._sum.amountPaise ?? 0) - (deductions._sum.appliedPaise ?? 0),
    totals: byStatus.map((s) => ({
      status: s.status,
      groups: s._count._all,
      totalPaise: s._sum.totalPaise ?? 0,
      refundedPaise: s._sum.refundedPaise ?? 0,
    })),
  };
}

export async function listRefundGroups(query: {
  status?: RefundGroupStatus;
  channel?: RefundGroupChannel;
  origin?: RefundGroupOrigin;
  orderNumber?: string;
  cursor?: string | null;
  limit: number;
}) {
  const rows = await prisma.refundGroup.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.origin ? { origin: query.origin } : {}),
      ...(query.orderNumber ? { order: { orderNumber: { contains: query.orderNumber.trim(), mode: 'insensitive' } } } : {}),
      ...(query.cursor ? { createdAt: { lt: new Date(query.cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit + 1,
    include: {
      order: { select: { orderNumber: true, paymentMethod: true, user: { select: { fullName: true, mobile: true } } } },
      refunds: { select: { id: true, status: true, retryOfId: true } },
      manualPayout: { select: { status: true } },
    },
  });
  const items = rows.slice(0, query.limit).map((g) => {
    const retried = new Set(g.refunds.map((r) => r.retryOfId).filter(Boolean));
    const latest = g.refunds.filter((r) => !retried.has(r.id));
    return {
      id: g.id,
      orderId: g.orderId,
      orderNumber: g.order.orderNumber,
      customerName: g.order.user.fullName,
      customerMobile: g.order.user.mobile,
      paymentMethod: g.order.paymentMethod,
      origin: g.origin,
      channel: g.channel,
      postDelivery: g.postDelivery,
      reason: g.reason,
      status: g.status,
      totalPaise: g.totalPaise,
      refundedPaise: g.refundedPaise,
      components: g.refunds.length,
      retryable: latest.some((r) => r.status === 'FAILED'),
      inFlight: latest.some((r) => r.status === 'PENDING' || r.status === 'PROCESSING'),
      manualPayoutStatus: g.manualPayout?.status ?? null,
      createdAt: g.createdAt.toISOString(),
      completedAt: g.completedAt?.toISOString() ?? null,
    };
  });
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > query.limit && last ? last.createdAt : null };
}

type LineState = 'COMPLETED' | 'IN_FLIGHT' | 'FAILED_RETRYABLE' | 'RETRIED';

async function userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email ?? 'Admin']));
}

export async function getRefundGroupDetail(groupId: string) {
  const group = await prisma.refundGroup.findUnique({
    where: { id: groupId },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentMethod: true,
          paymentStatus: true,
          totalPaise: true,
          user: { select: { id: true, fullName: true, mobile: true } },
        },
      },
      refunds: {
        orderBy: { createdAt: 'asc' },
        include: {
          sellerOrder: { select: { sellerId: true, seller: { select: { name: true } } } },
          correction: { select: { createdAt: true, actorUserId: true, providerStatus: true, previousFailureReason: true } },
        },
      },
      request: { select: { id: true, category: true, status: true, requestedPaise: true, approvedPaise: true, decisionNote: true } },
      manualPayout: true,
      deductions: { include: { seller: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!group) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Refund not found.' });

  const retriedIds = new Set(group.refunds.map((r) => r.retryOfId).filter((id): id is string => id !== null));
  const state = (r: { id: string; status: string }): LineState => {
    if (retriedIds.has(r.id)) return 'RETRIED';
    if (r.status === 'COMPLETED') return 'COMPLETED';
    if (r.status === 'FAILED') return 'FAILED_RETRYABLE';
    return 'IN_FLIGHT';
  };

  const allocation = allocationLines(group.allocation);
  const sellerIds = [...new Set(allocation.map((l) => l.sellerId))];
  const sellerNames = new Map(
    (await prisma.seller.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]),
  );

  const auditWhere: Prisma.AuditLogWhereInput[] = [
    { entityType: 'RefundGroup', entityId: groupId },
    { after: { path: ['groupId'], equals: groupId } },
    ...group.refunds.map((r) => ({ after: { path: ['refundId'], equals: r.id } })),
  ];
  if (group.manualPayout) auditWhere.push({ entityType: 'ManualRefundPayout', entityId: group.manualPayout.id });
  if (group.request) auditWhere.push({ entityType: 'RefundRequest', entityId: group.request.id });
  const audit = await prisma.auditLog.findMany({
    where: { OR: auditWhere },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: { id: true, action: true, actorUserId: true, createdAt: true, before: true, after: true },
  });
  const names = await userNames([
    group.createdByUserId,
    group.manualPayout?.recordedByUserId,
    group.manualPayout?.confirmedByUserId,
    ...audit.map((a) => a.actorUserId),
    ...group.refunds.map((r) => r.correction?.actorUserId),
  ]);
  const nameOf = (id: string | null | undefined) => (id ? (names.get(id) ?? 'Admin') : null);

  const components = group.refunds.map((r) => ({
    id: r.id,
    componentType: r.componentType,
    sellerOrderId: r.sellerOrderId,
    sellerId: r.sellerOrder?.sellerId ?? null,
    sellerName: r.sellerOrder?.seller.name ?? null,
    amountPaise: r.amountPaise,
    status: r.status,
    state: state(r),
    providerRefundId: r.providerRefundId,
    failureReason: r.failureReason,
    retryOfId: r.retryOfId,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    /** Recorded FAILED, then verified completed from Cashfree. */
    correction: r.correction
      ? {
          at: r.correction.createdAt.toISOString(),
          by: nameOf(r.correction.actorUserId) ?? 'System',
          providerStatus: r.correction.providerStatus,
          previousFailureReason: r.correction.previousFailureReason,
        }
      : null,
  }));

  const payout = group.manualPayout;
  return {
    id: group.id,
    status: group.status,
    origin: group.origin,
    channel: group.channel,
    postDelivery: group.postDelivery,
    reason: group.reason,
    totalPaise: group.totalPaise,
    refundedPaise: group.refundedPaise,
    createdBy: nameOf(group.createdByUserId),
    createdAt: group.createdAt.toISOString(),
    completedAt: group.completedAt?.toISOString() ?? null,
    order: {
      id: group.order.id,
      orderNumber: group.order.orderNumber,
      status: group.order.status,
      paymentMethod: group.order.paymentMethod,
      paymentStatus: group.order.paymentStatus,
      totalPaise: group.order.totalPaise,
    },
    customer: { id: group.order.user.id, name: group.order.user.fullName, mobile: group.order.user.mobile },
    request: group.request ? { ...group.request, categoryLabel: REFUND_REQUEST_CATEGORY_LABELS[group.request.category] } : null,
    components,
    allocation: allocation.map((l) => ({ ...l, sellerName: sellerNames.get(l.sellerId) ?? null })),
    manualPayout: payout
      ? {
          id: payout.id,
          amountPaise: payout.amountPaise,
          method: payout.method,
          reference: payout.reference,
          paidOn: payout.paidOn.toISOString().slice(0, 10),
          proofNote: payout.proofNote,
          status: payout.status,
          recordedBy: nameOf(payout.recordedByUserId),
          recordedAt: payout.recordedAt.toISOString(),
          confirmedBy: nameOf(payout.confirmedByUserId),
          confirmedAt: payout.confirmedAt?.toISOString() ?? null,
        }
      : null,
    deductions: group.deductions.map((d) => ({
      id: d.id,
      sellerId: d.sellerId,
      sellerName: d.seller.name,
      sellerOrderId: d.sellerOrderId,
      /** The seller's net taken back (commission reversed). */
      amountPaise: d.amountPaise,
      refundedPaise: d.refundedPaise,
      commissionReversedPaise: d.commissionReversedPaise,
      couponReversedPaise: d.couponReversedPaise,
      appliedPaise: d.appliedPaise,
      status: d.status,
    })),
    actions: {
      canRetry: group.channel === RefundGroupChannel.CASHFREE && components.some((c) => c.state === 'FAILED_RETRYABLE'),
      canReconcile: group.channel === RefundGroupChannel.CASHFREE && components.some((c) => c.state === 'IN_FLIGHT'),
      canRecordPayout: group.channel === RefundGroupChannel.MANUAL && !payout,
      canConfirmPayout: group.channel === RefundGroupChannel.MANUAL && payout?.status === ManualPayoutStatus.RECORDED,
    },
    audit: audit.map((a) => ({
      id: a.id,
      action: a.action,
      actor: nameOf(a.actorUserId) ?? 'System',
      at: a.createdAt.toISOString(),
      before: a.before,
      after: a.after,
    })),
  };
}
