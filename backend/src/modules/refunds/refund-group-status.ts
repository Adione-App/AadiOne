/**
 * A refund group's status — DERIVED from its components, never set by hand.
 * Pure (unit-tested in tests/unit/refund-group-status.test.ts); the cached
 * copy on `refund_groups` is rewritten from this in the same transaction as
 * every component change (refund-action.ts › recomputeGroup).
 *
 * A component "line" is one thing the group pays back (one seller's products,
 * the delivery fee, ...). A line may have several attempts — a definitively
 * FAILED attempt retried by a new one (`retryOfId`) — and only its LATEST
 * attempt says where the line stands. The failed attempts stay as history.
 *
 *   no line yet                          -> APPROVED
 *   any line still in flight             -> PROCESSING
 *   (PENDING / PROCESSING — this includes an outcome Cashfree has not
 *   confirmed yet: accepted is never completed)
 *   every line COMPLETED                 -> SUCCESS
 *   every line FAILED                    -> FAILED
 *   some COMPLETED, the rest FAILED      -> PARTIAL_FAILURE
 *
 * A group is never SUCCESS while any line is pending or failed. UNDER_REVIEW
 * and REJECTED belong to the refund REQUEST (before any group exists) and are
 * combined in `customerRefundStatus`.
 *
 * MANUAL (COD) groups have no Cashfree lines: the admin's payout decides —
 * none recorded -> APPROVED, recorded -> PROCESSING, confirmed -> SUCCESS.
 * An admin's click on Approve never makes one SUCCESS.
 */

export type ComponentStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type GroupStatus = 'APPROVED' | 'PROCESSING' | 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILED';

export interface ComponentAttempt {
  id: string;
  status: ComponentStatus;
  amountPaise: number;
  retryOfId: string | null;
}

/** Each line's latest attempt: every attempt no other attempt retries. */
export function latestAttempts<T extends ComponentAttempt>(attempts: readonly T[]): T[] {
  const retried = new Set(attempts.map((a) => a.retryOfId).filter((id): id is string => id !== null));
  return attempts.filter((a) => !retried.has(a.id));
}

export function deriveGroupStatus(lineStatuses: readonly ComponentStatus[]): GroupStatus {
  if (lineStatuses.length === 0) return 'APPROVED';
  if (lineStatuses.some((s) => s === 'PENDING' || s === 'PROCESSING')) return 'PROCESSING';
  if (lineStatuses.every((s) => s === 'COMPLETED')) return 'SUCCESS';
  if (lineStatuses.every((s) => s === 'FAILED')) return 'FAILED';
  return 'PARTIAL_FAILURE';
}

export interface GroupTotals {
  status: GroupStatus;
  /** What the group pays back: every line's latest attempt. */
  totalPaise: number;
  /** What is confirmed paid back: the lines whose latest attempt COMPLETED. */
  refundedPaise: number;
}

export function summariseCashfreeGroup(attempts: readonly ComponentAttempt[]): GroupTotals {
  const lines = latestAttempts(attempts);
  return {
    status: deriveGroupStatus(lines.map((l) => l.status)),
    totalPaise: lines.reduce((sum, l) => sum + l.amountPaise, 0),
    refundedPaise: lines.filter((l) => l.status === 'COMPLETED').reduce((sum, l) => sum + l.amountPaise, 0),
  };
}

export function summariseManualGroup(
  allocatedPaise: number,
  payout: { status: 'RECORDED' | 'CONFIRMED'; amountPaise: number } | null,
): GroupTotals {
  if (!payout) return { status: 'APPROVED', totalPaise: allocatedPaise, refundedPaise: 0 };
  if (payout.status === 'RECORDED') return { status: 'PROCESSING', totalPaise: allocatedPaise, refundedPaise: 0 };
  return { status: 'SUCCESS', totalPaise: allocatedPaise, refundedPaise: payout.amountPaise };
}

export type CustomerRefundStatus = 'UNDER_REVIEW' | 'REJECTED' | GroupStatus;

/** What the customer sees: the request's state until it has a group, then the group's. */
export function customerRefundStatus(
  request: { status: 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' } | null,
  group: { status: GroupStatus } | null,
): CustomerRefundStatus {
  if (group) return group.status;
  if (request?.status === 'REJECTED') return 'REJECTED';
  if (request?.status === 'UNDER_REVIEW') return 'UNDER_REVIEW';
  return 'APPROVED';
}
