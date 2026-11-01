/**
 * Admin refund management — types and query keys for the Refunds dashboard
 * (backend: src/modules/refunds/admin-refund.routes.ts, all ORDER_REFUND).
 */

import type { Tone } from '@/components/ui';

export const refundKeys = {
  overview: ['admin', 'refunds', 'overview'] as const,
  requests: (q: string) => ['admin', 'refunds', 'requests', q] as const,
  request: (id: string) => ['admin', 'refunds', 'request', id] as const,
  groups: (q: string) => ['admin', 'refunds', 'groups', q] as const,
  group: (id: string) => ['admin', 'refunds', 'group', id] as const,
};

export interface RefundOverview {
  requestsUnderReview: number;
  processing: number;
  approvedNotStarted: number;
  partialFailures: number;
  failed: number;
  succeeded: number;
  manualAwaitingPayout: number;
  manualAwaitingConfirmation: number;
  outstandingSellerDeductionsPaise: number;
}

export interface RefundRequestRow {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  customerMobile: string;
  paymentMethod: string;
  categoryLabel: string;
  requestedPaise: number;
  approvedPaise: number | null;
  status: 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';
  groupId: string | null;
  groupStatus: string | null;
  photoCount: number;
  createdAt: string;
  reviewedAt: string | null;
}

export interface RefundRequestDetail {
  id: string;
  status: RefundRequestRow['status'];
  categoryLabel: string;
  description: string;
  requestedPaise: number;
  approvedPaise: number | null;
  approvablePaise: number;
  decisionNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  order: { id: string; orderNumber: string; status: string; paymentMethod: string; paymentStatus: string; totalPaise: number; deliveredAt: string | null };
  customer: { id: string; name: string | null; mobile: string };
  lines: {
    orderItemId: string;
    productName: string;
    variantName: string;
    qty: number;
    amountPaise: number;
    paidPaise: number;
    stillRefundablePaise: number;
    sellerName: string | null;
  }[];
  evidence: { id: string; contentType: string; sizeBytes: number }[];
  group: { id: string; status: string; totalPaise: number; refundedPaise: number; channel: string } | null;
}

export interface RefundGroupRow {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  paymentMethod: string;
  origin: 'AUTO' | 'ADMIN' | 'CUSTOMER_REQUEST';
  channel: 'CASHFREE' | 'MANUAL';
  postDelivery: boolean;
  reason: string;
  status: GroupStatus;
  totalPaise: number;
  refundedPaise: number;
  components: number;
  retryable: boolean;
  inFlight: boolean;
  manualPayoutStatus: 'RECORDED' | 'CONFIRMED' | null;
  createdAt: string;
}

export type GroupStatus = 'APPROVED' | 'PROCESSING' | 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILED';

export interface RefundGroupDetail {
  id: string;
  status: GroupStatus;
  origin: RefundGroupRow['origin'];
  channel: RefundGroupRow['channel'];
  postDelivery: boolean;
  reason: string;
  totalPaise: number;
  refundedPaise: number;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
  order: { id: string; orderNumber: string; status: string; paymentMethod: string; paymentStatus: string; totalPaise: number };
  customer: { id: string; name: string | null; mobile: string };
  request: { id: string; categoryLabel: string; status: string; requestedPaise: number; approvedPaise: number | null; decisionNote: string | null } | null;
  components: {
    id: string;
    componentType: string | null;
    sellerName: string | null;
    amountPaise: number;
    status: string;
    state: 'COMPLETED' | 'IN_FLIGHT' | 'FAILED_RETRYABLE' | 'RETRIED';
    providerRefundId: string | null;
    failureReason: string | null;
    retryOfId: string | null;
    createdAt: string;
    completedAt: string | null;
    correction: { at: string; by: string; providerStatus: string; previousFailureReason: string | null } | null;
  }[];
  allocation: { orderItemId: string; sellerName: string | null; amountPaise: number }[];
  manualPayout: {
    amountPaise: number;
    method: 'UPI' | 'BANK_TRANSFER';
    reference: string;
    paidOn: string;
    proofNote: string | null;
    status: 'RECORDED' | 'CONFIRMED';
    recordedBy: string | null;
    recordedAt: string;
    confirmedBy: string | null;
    confirmedAt: string | null;
  } | null;
  deductions: {
    id: string;
    sellerName: string;
    /** The seller's net taken back (commission reversed). */
    amountPaise: number;
    refundedPaise: number;
    commissionReversedPaise: number;
    appliedPaise: number;
    status: string;
  }[];
  actions: { canRetry: boolean; canReconcile: boolean; canRecordPayout: boolean; canConfirmPayout: boolean };
  audit: { id: string; action: string; actor: string; at: string; after: unknown }[];
}

export interface CorrectionResult {
  corrected: boolean;
  providerStatus: string;
  message: string;
}

export interface RetryResult {
  retried: { failedRefundId: string; refundId: string; status: string }[];
  skipped: { refundId: string; reason: string }[];
}

export const GROUP_STATUS: Record<GroupStatus, { label: string; tone: Tone }> = {
  APPROVED: { label: 'Approved', tone: 'blue' },
  PROCESSING: { label: 'Processing', tone: 'amber' },
  SUCCESS: { label: 'Refunded', tone: 'brand' },
  PARTIAL_FAILURE: { label: 'Partly failed', tone: 'red' },
  FAILED: { label: 'Failed', tone: 'red' },
};

export const REQUEST_STATUS: Record<RefundRequestRow['status'], { label: string; tone: Tone }> = {
  UNDER_REVIEW: { label: 'Under review', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'brand' },
  REJECTED: { label: 'Rejected', tone: 'gray' },
};

export const LINE_STATE: Record<RefundGroupDetail['components'][number]['state'], { label: string; tone: Tone }> = {
  COMPLETED: { label: 'Completed', tone: 'brand' },
  IN_FLIGHT: { label: 'Awaiting Cashfree', tone: 'amber' },
  FAILED_RETRYABLE: { label: 'Failed — can retry', tone: 'red' },
  RETRIED: { label: 'Failed — retried', tone: 'gray' },
};

export const COMPONENT_LABEL: Record<string, string> = {
  SELLER_PRODUCT: 'Seller products',
  DELIVERY_FEE: 'Delivery fee',
  PLATFORM_FEE: 'Platform fee',
  ORDER_FEES: 'Fees (before split)',
  FULL_ORDER: 'Whole order',
  ORPHAN_PAYMENT: 'Extra payment',
};

export const ORIGIN_LABEL: Record<RefundGroupRow['origin'], string> = {
  AUTO: 'Automatic',
  ADMIN: 'Admin',
  CUSTOMER_REQUEST: 'Customer request',
};

/** Rupees typed by an admin -> paise; null when not a valid positive amount. */
export function rupeesToPaise(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const paise = Math.round(Number(trimmed) * 100);
  return paise > 0 ? paise : null;
}
