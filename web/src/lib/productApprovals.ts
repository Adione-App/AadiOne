/**
 * Admin product approvals — seller-submitted products reviewed in batches
 * (GET/PATCH /admin/approval-batches…). Every query key sits under one root,
 * so a decision refreshes the pending list, the open detail and the sidebar
 * count together, all from the server.
 */

import { useQuery } from '@tanstack/react-query';
import { ApprovalStatus, type CursorPage, type ProductApprovalBatchSummaryDto } from '@shared';
import { api, ApiRequestError } from '@/lib/api';

export const approvalKeys = {
  all: ['product-approvals'] as const,
  pending: ['product-approvals', 'pending'] as const,
  pendingCount: ['product-approvals', 'pending-count'] as const,
  detail: (batchId: string) => ['product-approvals', 'detail', batchId] as const,
};

export const PENDING_PAGE_SIZE = 25;

/** GET /admin/approval-batches for still-open (PENDING) batches, newest first. */
export function pendingBatchesPath(cursor: string | null, limit: number = PENDING_PAGE_SIZE): string {
  const query = new URLSearchParams({ status: ApprovalStatus.PENDING, limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return `/admin/approval-batches?${query.toString()}`;
}

/** A 403/404 will not fix itself on a retry. */
export const retryServerErrorsOnce = (count: number, error: Error): boolean =>
  !(error instanceof ApiRequestError && error.status < 500) && count < 1;

/**
 * Sidebar badge: products still awaiting review in the newest 100 open
 * batches (summed from each batch's own pending count — never its items). Fetched once and refreshed whenever a decision invalidates the
 * approvals root — deliberately no polling.
 */
export function usePendingApprovalCount() {
  return useQuery({
    queryKey: approvalKeys.pendingCount,
    queryFn: () => api.get<CursorPage<ProductApprovalBatchSummaryDto>>(pendingBatchesPath(null, 100)),
    select: (page) => ({
      count: page.items.reduce((sum, batch) => sum + batch.pendingCount, 0),
      more: page.hasMore,
    }),
    retry: retryServerErrorsOnce,
  });
}
