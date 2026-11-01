/**
 * Seller deductions — what a seller gives back because a refund AFTER
 * DELIVERY returned money to the customer (final approved policy):
 *
 *   - the COMMISSION on the refunded part is REVERSED: the seller gives back
 *     exactly its net settlement for that part (line total minus the line's
 *     commission), never the customer's full refund, never the Aadione-funded
 *     coupon share (refund-accounting.ts). ₹600 item, ₹60 commission, ₹600
 *     refunded -> ₹540 deducted, ₹60 commission reversed;
 *   - computed per ORDER ITEM from the figures the settlement itself used
 *     (OrderItem.lineTotalPaise / commissionPaise / couponDiscountPaise),
 *     cumulatively: every earlier deduction on the item counts, so partial
 *     refunds can never take more than the item's own net or commission.
 *     The item rows are locked while this is worked out;
 *   - recorded when the refund is actually done: a post-delivery Cashfree
 *     component COMPLETES (or is verified-corrected to completed), or a manual
 *     (COD) payout is CONFIRMED by a second admin — never on approval alone.
 *     One deduction per seller portion per refund group (unique), so a
 *     replayed webhook, a repeated confirmation or a correction never deducts
 *     twice; only THAT seller's portion, never a fee;
 *   - applied to the seller's NEXT settlements, oldest first, never beyond a
 *     settlement's payable, never below zero; the rest carries forward. A
 *     completed settlement is never modified;
 *   - every application is an immutable ledger row
 *     (seller_deduction_applications); DB CHECKs keep applied within
 *     [0, amount] and the status in step with it.
 */

import { Prisma, SellerDeductionStatus } from '@prisma/client';
import { NotificationType, Permission } from '../../shared';
import { moduleLogger } from '../../common/logger';
import { prisma, type Tx } from '../../infra/db/prisma';
import * as notificationService from '../notifications/notification.service';
import { reverseLine, type PriorReversals } from '../refunds/refund-accounting';

const log = moduleLogger('seller-deductions');

/** Allocation lines of a refund group: the customer refund per order item. */
interface AllocationLine {
  orderItemId: string;
  sellerOrderId: string;
  amountPaise: number;
}

function allocationOf(allocation: Prisma.JsonValue | null): AllocationLine[] {
  if (!Array.isArray(allocation)) return [];
  return allocation.filter(
    (l): l is Prisma.JsonObject & AllocationLine =>
      !!l &&
      typeof l === 'object' &&
      !Array.isArray(l) &&
      typeof l['orderItemId'] === 'string' &&
      typeof l['sellerOrderId'] === 'string' &&
      typeof l['amountPaise'] === 'number',
  );
}

/** The refund's split does not add up — never guessed (no SQL has run yet). */
class DeductionInputError extends Error {}

export interface RecordedDeduction {
  deductionId: string;
  sellerId: string;
  orderId: string;
  amountPaise: number;
  refundedPaise: number;
}

/**
 * Records ONE seller portion's deduction for a refund group (caller's
 * transaction). `lines` are the customer refund per order item of THIS
 * portion. Returns null when already recorded (idempotent) or when nothing
 * is recoverable (e.g. an item the coupon paid for in full).
 */
async function recordPortionDeduction(
  tx: Tx,
  input: {
    groupId: string;
    orderId: string;
    sellerOrderId: string;
    reason: string;
    refundId?: string;
    manualPayoutId?: string;
    lines: { orderItemId: string; amountPaise: number }[];
  },
  actorUserId: string | null,
): Promise<RecordedDeduction | null> {
  const existing = await tx.sellerDeduction.findUnique({
    where: { groupId_sellerOrderId: { groupId: input.groupId, sellerOrderId: input.sellerOrderId } },
    select: { id: true },
  });
  if (existing) return null;

  const perItem = new Map<string, number>();
  for (const line of input.lines) {
    if (line.amountPaise > 0) perItem.set(line.orderItemId, (perItem.get(line.orderItemId) ?? 0) + line.amountPaise);
  }
  if (perItem.size === 0) return null;
  const itemIds = [...perItem.keys()].sort();

  // Lock the refunded items (id order): two refunds of one item can never
  // both read the same earlier total.
  await tx.$queryRaw`SELECT id FROM order_items WHERE id = ANY(${itemIds}::uuid[]) ORDER BY id FOR UPDATE`;
  const items = await tx.orderItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, sellerOrderId: true, lineTotalPaise: true, commissionPaise: true, couponDiscountPaise: true },
  });
  // Per-seller separation: every item must belong to THIS seller portion.
  if (items.length !== itemIds.length || items.some((i) => i.sellerOrderId !== input.sellerOrderId)) {
    throw new DeductionInputError(`refund allocation for seller order ${input.sellerOrderId} names items outside it`);
  }
  const priorRows = await tx.sellerDeductionItem.groupBy({
    by: ['orderItemId'],
    where: { orderItemId: { in: itemIds } },
    _sum: { refundedPaise: true, sellerNetPaise: true, commissionPaise: true, couponPaise: true },
  });
  const prior = (id: string): PriorReversals => {
    const row = priorRows.find((r) => r.orderItemId === id);
    return {
      refundedPaise: row?._sum.refundedPaise ?? 0,
      sellerNetPaise: row?._sum.sellerNetPaise ?? 0,
      commissionPaise: row?._sum.commissionPaise ?? 0,
      couponPaise: row?._sum.couponPaise ?? 0,
    };
  };
  const reversals = items.map((item) => ({ orderItemId: item.id, ...reverseLine(item, prior(item.id), perItem.get(item.id)!) }));
  const sum = (key: 'refundedPaise' | 'sellerNetPaise' | 'commissionPaise' | 'couponPaise') =>
    reversals.reduce((total, r) => total + r[key], 0);
  const amountPaise = sum('sellerNetPaise');
  if (amountPaise <= 0) {
    log.warn({ groupId: input.groupId, sellerOrderId: input.sellerOrderId }, 'refund after delivery leaves nothing to recover from the seller');
    return null;
  }

  const sellerOrder = await tx.sellerOrder.findUniqueOrThrow({ where: { id: input.sellerOrderId }, select: { sellerId: true, orderId: true } });
  if (sellerOrder.orderId !== input.orderId) {
    throw new DeductionInputError(`seller order ${input.sellerOrderId} is not part of order ${input.orderId}`);
  }
  const deduction = await tx.sellerDeduction.create({
    data: {
      sellerId: sellerOrder.sellerId,
      orderId: input.orderId,
      sellerOrderId: input.sellerOrderId,
      groupId: input.groupId,
      refundId: input.refundId ?? null,
      manualPayoutId: input.manualPayoutId ?? null,
      amountPaise,
      refundedPaise: sum('refundedPaise'),
      commissionReversedPaise: sum('commissionPaise'),
      couponReversedPaise: sum('couponPaise'),
      reason: input.reason.slice(0, 300),
      items: {
        create: reversals.map((r) => ({
          orderItemId: r.orderItemId,
          refundedPaise: r.refundedPaise,
          sellerNetPaise: r.sellerNetPaise,
          commissionPaise: r.commissionPaise,
          couponPaise: r.couponPaise,
        })),
      },
    },
    select: { id: true },
  });
  await tx.auditLog.create({
    data: {
      actorUserId,
      action: 'seller_deduction.create',
      entityType: 'Seller',
      entityId: sellerOrder.sellerId,
      after: {
        deductionId: deduction.id,
        groupId: input.groupId,
        sellerOrderId: input.sellerOrderId,
        refundId: input.refundId ?? null,
        manualPayoutId: input.manualPayoutId ?? null,
        refundedPaise: sum('refundedPaise'),
        sellerNetDeductedPaise: amountPaise,
        commissionReversedPaise: sum('commissionPaise'),
        couponReversedPaise: sum('couponPaise'),
        items: reversals,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  log.info({ deductionId: deduction.id, sellerId: sellerOrder.sellerId, amountPaise, refundedPaise: sum('refundedPaise') }, 'seller deduction recorded');
  return { deductionId: deduction.id, sellerId: sellerOrder.sellerId, orderId: input.orderId, amountPaise, refundedPaise: sum('refundedPaise') };
}

/**
 * A refund component just COMPLETED (caller's transaction, under the
 * payment lock). Records the seller's deduction if — and only if — it is a
 * post-delivery refund of one seller's products. Its per-item split is the
 * group's allocation for that seller portion; if that does not match the
 * refunded amount the deduction is NOT guessed — admins are alerted after
 * commit and the refund's own recording is never blocked.
 */
export async function recordDeductionForCompletedRefund(tx: Tx, refundId: string, actorUserId: string | null = null): Promise<RecordedDeduction | null> {
  const refund = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    select: {
      id: true,
      status: true,
      amountPaise: true,
      orderId: true,
      componentType: true,
      sellerOrderId: true,
      groupId: true,
      group: { select: { postDelivery: true, reason: true, allocation: true } },
    },
  });
  if (refund.status !== 'COMPLETED' || refund.componentType !== 'SELLER_PRODUCT') return null;
  if (!refund.group?.postDelivery || !refund.groupId || !refund.sellerOrderId) return null;

  const lines = allocationOf(refund.group.allocation).filter((l) => l.sellerOrderId === refund.sellerOrderId);
  const allocated = lines.reduce((total, l) => total + l.amountPaise, 0);
  try {
    if (allocated !== refund.amountPaise) {
      throw new DeductionInputError(`allocated ${allocated} paise but refunded ${refund.amountPaise}`);
    }
    return await recordPortionDeduction(
      tx,
      {
        groupId: refund.groupId,
        orderId: refund.orderId,
        sellerOrderId: refund.sellerOrderId,
        reason: refund.group.reason,
        refundId: refund.id,
        lines,
      },
      actorUserId,
    );
  } catch (error) {
    if (!(error instanceof DeductionInputError)) throw error;
    // The refund itself is recorded regardless; the deduction is never guessed.
    log.error({ err: error, refundId, groupId: refund.groupId }, 'seller deduction NOT recorded — needs review');
    void notificationService.notifyAdmins(Permission.ORDER_REFUND, {
      type: NotificationType.ADMIN_REFUND_FAILED,
      dedupeKey: `refund:${refund.id}:deduction-review`,
      orderId: refund.orderId,
      context: { amountPaise: refund.amountPaise, reason: 'completed, but its seller deduction needs review' },
    });
    return null;
  }
}

/**
 * A manual (COD) payout was CONFIRMED (caller's transaction). One deduction
 * per seller portion in the group's allocation (per-item, commission
 * reversed). Idempotent (unique group + seller portion).
 */
export async function recordDeductionsForConfirmedPayout(
  tx: Tx,
  input: { payoutId: string; groupId: string; orderId: string; reason: string; lines: { orderItemId: string; sellerOrderId: string; amountPaise: number }[] },
  actorUserId: string,
): Promise<RecordedDeduction[]> {
  const portions = new Map<string, { orderItemId: string; amountPaise: number }[]>();
  for (const line of input.lines) {
    const list = portions.get(line.sellerOrderId) ?? [];
    list.push({ orderItemId: line.orderItemId, amountPaise: line.amountPaise });
    portions.set(line.sellerOrderId, list);
  }
  const recorded: RecordedDeduction[] = [];
  for (const [sellerOrderId, lines] of [...portions.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const deduction = await recordPortionDeduction(
      tx,
      { groupId: input.groupId, orderId: input.orderId, sellerOrderId, reason: input.reason, manualPayoutId: input.payoutId, lines },
      actorUserId,
    );
    if (deduction) recorded.push(deduction);
  }
  return recorded;
}

/** Tells each seller what a COD refund after delivery will take from its next payout (after commit). */
export async function announceDeductions(deductions: readonly RecordedDeduction[]): Promise<void> {
  for (const d of deductions) {
    const order = await prisma.order.findUnique({ where: { id: d.orderId }, select: { orderNumber: true } });
    await notificationService.notifySeller(d.sellerId, {
      type: NotificationType.SELLER_REFUND_ISSUED,
      dedupeKey: `deduction:${d.deductionId}:seller`,
      orderId: d.orderId,
      context: { orderNumber: order?.orderNumber, amountPaise: d.refundedPaise, deductionPaise: d.amountPaise, reason: 'POST_DELIVERY' },
    });
  }
}

/**
 * Applies the seller's outstanding deductions to a settlement being created
 * (caller's transaction, holding the seller's row lock — the lock every
 * settlement creation takes, so two can never apply the same deduction).
 * Oldest first, at most `budgetPaise`. Returns what was applied.
 */
export async function applyDeductionsToSettlement(tx: Tx, sellerId: string, settlementId: string, budgetPaise: number): Promise<number> {
  if (budgetPaise <= 0) return 0;
  const outstanding = await tx.$queryRaw<{ id: string; amount_paise: number; applied_paise: number }[]>`
    SELECT id, amount_paise, applied_paise FROM seller_deductions
    WHERE seller_id = ${sellerId}::uuid AND status <> 'APPLIED'
    ORDER BY created_at ASC, id ASC
    FOR UPDATE`;
  let left = budgetPaise;
  let applied = 0;
  for (const deduction of outstanding) {
    if (left <= 0) break;
    const take = Math.min(deduction.amount_paise - deduction.applied_paise, left);
    if (take <= 0) continue;
    const appliedPaise = deduction.applied_paise + take;
    await tx.sellerDeductionApplication.create({ data: { deductionId: deduction.id, settlementId, amountPaise: take } });
    await tx.sellerDeduction.update({
      where: { id: deduction.id },
      data: {
        appliedPaise,
        status: appliedPaise >= deduction.amount_paise ? SellerDeductionStatus.APPLIED : SellerDeductionStatus.PARTIALLY_APPLIED,
      },
    });
    left -= take;
    applied += take;
  }
  if (applied > 0) log.info({ sellerId, settlementId, applied }, 'seller deductions applied to settlement');
  return applied;
}

/** A seller's deductions: outstanding first, with where each was applied. */
export async function listSellerDeductions(sellerId: string) {
  const rows = await prisma.sellerDeduction.findMany({
    where: { sellerId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
    include: {
      sellerOrder: { select: { order: { select: { orderNumber: true } } } },
      applications: { select: { settlementId: true, amountPaise: true, createdAt: true } },
    },
  });
  return rows.map((d) => ({
    id: d.id,
    orderId: d.orderId,
    orderNumber: d.sellerOrder.order.orderNumber,
    sellerOrderId: d.sellerOrderId,
    groupId: d.groupId,
    /** The seller's net taken back for the refund (commission reversed). */
    amountPaise: d.amountPaise,
    refundedPaise: d.refundedPaise,
    commissionReversedPaise: d.commissionReversedPaise,
    appliedPaise: d.appliedPaise,
    remainingPaise: d.amountPaise - d.appliedPaise,
    status: d.status,
    reason: d.reason,
    createdAt: d.createdAt.toISOString(),
    applications: d.applications.map((a) => ({ settlementId: a.settlementId, amountPaise: a.amountPaise, appliedAt: a.createdAt.toISOString() })),
  }));
}

/** Outstanding (not yet applied) total for one seller. */
export async function outstandingDeductionsPaise(sellerId: string): Promise<number> {
  const agg = await prisma.sellerDeduction.aggregate({
    where: { sellerId, status: { not: SellerDeductionStatus.APPLIED } },
    _sum: { amountPaise: true, appliedPaise: true },
  });
  return (agg._sum.amountPaise ?? 0) - (agg._sum.appliedPaise ?? 0);
}
