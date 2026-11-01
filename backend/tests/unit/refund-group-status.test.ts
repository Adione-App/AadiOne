/**
 * Refund group status — derived from its components, never stored by hand
 * (src/modules/refunds/refund-group-status.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  customerRefundStatus,
  deriveGroupStatus,
  latestAttempts,
  summariseCashfreeGroup,
  summariseManualGroup,
  type ComponentAttempt,
} from '../../src/modules/refunds/refund-group-status';

const attempt = (id: string, status: ComponentAttempt['status'], amountPaise: number, retryOfId: string | null = null): ComponentAttempt => ({
  id,
  status,
  amountPaise,
  retryOfId,
});

describe('deriveGroupStatus', () => {
  it('a group with no component yet is APPROVED', () => {
    expect(deriveGroupStatus([])).toBe('APPROVED');
  });

  it('is PROCESSING while any component is in flight — Cashfree accepting a refund is not completion', () => {
    expect(deriveGroupStatus(['PENDING'])).toBe('PROCESSING');
    expect(deriveGroupStatus(['COMPLETED', 'PROCESSING'])).toBe('PROCESSING');
    expect(deriveGroupStatus(['COMPLETED', 'COMPLETED', 'PENDING'])).toBe('PROCESSING');
    // A failure with another component still in flight is not final yet.
    expect(deriveGroupStatus(['FAILED', 'PENDING'])).toBe('PROCESSING');
  });

  it('is SUCCESS only when every component COMPLETED', () => {
    expect(deriveGroupStatus(['COMPLETED'])).toBe('SUCCESS');
    expect(deriveGroupStatus(['COMPLETED', 'COMPLETED', 'COMPLETED'])).toBe('SUCCESS');
  });

  it('some completed and the rest definitively failed is PARTIAL_FAILURE; all failed is FAILED', () => {
    expect(deriveGroupStatus(['COMPLETED', 'FAILED', 'COMPLETED'])).toBe('PARTIAL_FAILURE');
    expect(deriveGroupStatus(['FAILED'])).toBe('FAILED');
    expect(deriveGroupStatus(['FAILED', 'FAILED'])).toBe('FAILED');
  });
});

describe('retried components', () => {
  it('only the latest attempt of a line counts; the failed attempt stays as history', () => {
    const attempts = [attempt('a', 'COMPLETED', 50000), attempt('b1', 'FAILED', 50000), attempt('b2', 'COMPLETED', 50000, 'b1'), attempt('fee', 'COMPLETED', 1000)];
    expect(latestAttempts(attempts).map((a) => a.id)).toEqual(['a', 'b2', 'fee']);
    expect(summariseCashfreeGroup(attempts)).toEqual({ status: 'SUCCESS', totalPaise: 101000, refundedPaise: 101000 });
  });

  it('a retry still in flight keeps the group PROCESSING; a chain of retries resolves to its last', () => {
    expect(summariseCashfreeGroup([attempt('a', 'COMPLETED', 500), attempt('b1', 'FAILED', 300), attempt('b2', 'PENDING', 300, 'b1')])).toEqual({
      status: 'PROCESSING',
      totalPaise: 800,
      refundedPaise: 500,
    });
    expect(
      summariseCashfreeGroup([attempt('b1', 'FAILED', 300), attempt('b2', 'FAILED', 300, 'b1'), attempt('b3', 'COMPLETED', 300, 'b2')]),
    ).toEqual({ status: 'SUCCESS', totalPaise: 300, refundedPaise: 300 });
  });

  it('the worked example: Seller A ₹500 + Seller B ₹500 + fee ₹10 — B fails, then its retry succeeds', () => {
    const first = [attempt('a', 'COMPLETED', 50000), attempt('b', 'FAILED', 50000), attempt('fee', 'COMPLETED', 1000)];
    expect(summariseCashfreeGroup(first)).toEqual({ status: 'PARTIAL_FAILURE', totalPaise: 101000, refundedPaise: 51000 });
    expect(summariseCashfreeGroup([...first, attempt('b-retry', 'COMPLETED', 50000, 'b')])).toEqual({
      status: 'SUCCESS',
      totalPaise: 101000,
      refundedPaise: 101000,
    });
  });
});

describe('manual (COD) groups', () => {
  it('approval alone is never success: approved -> recorded (processing) -> confirmed (success)', () => {
    expect(summariseManualGroup(20000, null)).toEqual({ status: 'APPROVED', totalPaise: 20000, refundedPaise: 0 });
    expect(summariseManualGroup(20000, { status: 'RECORDED', amountPaise: 20000 })).toEqual({ status: 'PROCESSING', totalPaise: 20000, refundedPaise: 0 });
    expect(summariseManualGroup(20000, { status: 'CONFIRMED', amountPaise: 20000 })).toEqual({ status: 'SUCCESS', totalPaise: 20000, refundedPaise: 20000 });
  });
});

describe('customerRefundStatus', () => {
  it('shows the request until it has a group, then the group', () => {
    expect(customerRefundStatus({ status: 'UNDER_REVIEW' }, null)).toBe('UNDER_REVIEW');
    expect(customerRefundStatus({ status: 'REJECTED' }, null)).toBe('REJECTED');
    expect(customerRefundStatus({ status: 'APPROVED' }, { status: 'PROCESSING' })).toBe('PROCESSING');
    expect(customerRefundStatus(null, { status: 'SUCCESS' })).toBe('SUCCESS');
  });
});
