/**
 * Refund groups — ONE GROUP PER TRIGGERING ACTION (approved 2026-10-31).
 *
 * A customer cancelling a two-seller order issues three Cashfree refunds
 * (seller A's products, seller B's products, the delivery fee); the customer
 * sees ONE refund of their sum. A later, different action (another
 * cancellation, an approved refund request) makes its own group — groups are
 * never merged into one rolling refund.
 *
 * How the action is known: every entry point that can issue refunds runs
 * inside `withRefundAction` (an AsyncLocalStorage context). The refund
 * engine (payment.service.ts) calls `attachGroup` in the SAME transaction
 * that reserves each Refund row, so the group exists exactly when its first
 * component does — never an empty group, never a component without one. A
 * nested `withRefundAction` (a cancellation loop calling the per-portion
 * refund, which also wraps itself) joins the outer action.
 *
 * The group's status and totals are a cache, rewritten from its components
 * by `recomputeGroup` in the same transaction as every component change,
 * under the captured payment's row lock (the lock every refund of an order
 * already takes) — so the cache can never disagree with the components.
 *
 * Customer notices are per GROUP and stage (started / completed / delayed),
 * keyed `refund-group:<id>:<stage>`, and sent once the action has issued all
 * its components — so "Refund started" names the whole amount, once. Seller
 * and admin notices stay per component (payment.service.ts › announceRefund).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { RefundGroupChannel, RefundGroupOrigin, RefundGroupStatus, type Prisma } from '@prisma/client';
import { NotificationType } from '../../shared';
import { moduleLogger } from '../../common/logger';
import { prisma, type Tx } from '../../infra/db/prisma';
import * as notificationService from '../notifications/notification.service';
import { summariseCashfreeGroup, summariseManualGroup, type GroupTotals } from './refund-group-status';

const log = moduleLogger('refund-groups');

export interface RefundActionSpec {
  origin: RefundGroupOrigin;
  /** Shown to admins as the group's reason. */
  reason: string;
  /** Who triggered it; null for the system. */
  actorUserId: string | null;
  /** The order was delivered before this refund (a refund request). */
  postDelivery?: boolean;
  /**
   * Issue into this EXISTING group (an admin retry, an approved request whose
   * group was created up front) instead of starting a new one. Keyed by order.
   */
  existingGroups?: ReadonlyMap<string, string>;
}

interface ActionState extends RefundActionSpec {
  /** orderId -> the group this action opened (or was given) for it. */
  groups: Map<string, string>;
  /** Groups whose components changed — announced when the action ends. */
  changed: Set<string>;
}

const actionStore = new AsyncLocalStorage<ActionState>();

/**
 * Runs `fn` as ONE refund action: every refund it issues for an order lands
 * in the same group. Inside another action it simply joins that one.
 */
export async function withRefundAction<T>(spec: RefundActionSpec, fn: () => Promise<T>): Promise<T> {
  if (actionStore.getStore()) return fn();
  const state: ActionState = {
    ...spec,
    groups: new Map(spec.existingGroups ?? []),
    changed: new Set(),
  };
  try {
    return await actionStore.run(state, fn);
  } finally {
    for (const groupId of state.changed) await announceGroup(groupId);
  }
}

/**
 * The group the current action's refund for `orderId` belongs to — created
 * in the caller's transaction (the one reserving the Refund row) on first
 * use. Outside any action (a code path not yet wrapped) the refund gets a
 * group of its own rather than none.
 */
export async function attachGroup(tx: Tx, order: { id: string; userId: string }, fallbackReason: string): Promise<string> {
  const state = actionStore.getStore();
  const known = state?.groups.get(order.id);
  // The id may come from a transaction that later rolled back: trust it only
  // if the row exists.
  if (known && (await tx.refundGroup.findUnique({ where: { id: known }, select: { id: true } }))) {
    if (state) state.changed.add(known);
    return known;
  }
  if (!state) log.warn({ orderId: order.id }, 'refund issued outside a refund action — given its own group');
  const group = await tx.refundGroup.create({
    data: {
      orderId: order.id,
      userId: order.userId,
      origin: state?.origin ?? RefundGroupOrigin.AUTO,
      channel: RefundGroupChannel.CASHFREE,
      reason: (state?.reason ?? fallbackReason).slice(0, 300),
      postDelivery: state?.postDelivery ?? false,
      createdByUserId: state?.actorUserId ?? null,
    },
    select: { id: true },
  });
  if (state) {
    state.groups.set(order.id, group.id);
    state.changed.add(group.id);
  }
  return group.id;
}

/**
 * Rewrites a group's cached status and totals from its components. Call in
 * the SAME transaction as the component change; the caller holds the
 * captured payment's lock (every component of a group refunds one payment).
 */
export async function recomputeGroup(tx: Tx, groupId: string): Promise<GroupTotals> {
  await tx.$queryRaw`SELECT id FROM refund_groups WHERE id = ${groupId}::uuid FOR UPDATE`;
  const group = await tx.refundGroup.findUniqueOrThrow({
    where: { id: groupId },
    select: {
      channel: true,
      completedAt: true,
      allocation: true,
      refunds: { select: { id: true, status: true, amountPaise: true, retryOfId: true } },
      manualPayout: { select: { status: true, amountPaise: true } },
    },
  });
  const totals =
    group.channel === RefundGroupChannel.MANUAL
      ? summariseManualGroup(allocationTotal(group.allocation), group.manualPayout)
      : summariseCashfreeGroup(group.refunds);
  await tx.refundGroup.update({
    where: { id: groupId },
    data: {
      status: totals.status as RefundGroupStatus,
      totalPaise: totals.totalPaise,
      refundedPaise: totals.refundedPaise,
      completedAt: totals.status === 'SUCCESS' ? (group.completedAt ?? new Date()) : null,
    },
  });
  noteGroupChanged(groupId);
  return totals;
}

/** A MANUAL group's planned lines, summed. */
export function allocationTotal(allocation: Prisma.JsonValue | null): number {
  if (!Array.isArray(allocation)) return 0;
  return allocation.reduce<number>((sum, line) => {
    const amount = line && typeof line === 'object' && !Array.isArray(line) ? (line as { amountPaise?: unknown }).amountPaise : 0;
    return sum + (typeof amount === 'number' ? amount : 0);
  }, 0);
}

/**
 * A component changed: inside an action the group is announced when the
 * action ends (all its components issued); outside one (a webhook, the
 * reconciliation job) the caller announces after its transaction commits.
 */
function noteGroupChanged(groupId: string): void {
  actionStore.getStore()?.changed.add(groupId);
}

/** True while an action is collecting announcements (the caller need not announce). */
export function insideRefundAction(): boolean {
  return actionStore.getStore() !== undefined;
}

/**
 * The customer's ONE notice for where the group now stands — keyed by group
 * and stage, so repeated webhooks, retries and the reconciliation job never
 * notify twice. Read after the change committed; never affects it.
 *   SUCCESS                      -> "Refund complete" (the amount refunded)
 *   APPROVED / PROCESSING        -> "Refund started" (the group's total)
 *   PARTIAL_FAILURE / FAILED     -> "Refund delayed" (admins are alerted per component)
 */
export async function announceGroup(groupId: string): Promise<void> {
  try {
    const group = await prisma.refundGroup.findUnique({
      where: { id: groupId },
      select: { id: true, status: true, totalPaise: true, refundedPaise: true, orderId: true, userId: true, order: { select: { orderNumber: true } } },
    });
    if (!group || group.totalPaise <= 0) return;
    const base = { userId: group.userId, orderId: group.orderId };
    const orderNumber = group.order.orderNumber;
    if (group.status === RefundGroupStatus.SUCCESS) {
      await notificationService.notify({
        ...base,
        type: NotificationType.REFUND_COMPLETED,
        dedupeKey: `refund-group:${group.id}:COMPLETED`,
        context: { orderNumber, amountPaise: group.refundedPaise },
      });
    } else if (group.status === RefundGroupStatus.APPROVED || group.status === RefundGroupStatus.PROCESSING) {
      await notificationService.notify({
        ...base,
        type: NotificationType.REFUND_INITIATED,
        dedupeKey: `refund-group:${group.id}:INITIATED`,
        context: { orderNumber, amountPaise: group.totalPaise },
      });
    } else {
      await notificationService.notify({
        ...base,
        type: NotificationType.REFUND_UPDATE,
        dedupeKey: `refund-group:${group.id}:DELAYED`,
        context: { orderNumber, amountPaise: group.totalPaise - group.refundedPaise, refundStage: 'DELAYED' },
      });
    }
  } catch (error) {
    log.error({ err: error, groupId }, 'refund group announcement failed');
  }
}
