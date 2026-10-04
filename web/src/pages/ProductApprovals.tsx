/**
 * Product Approvals — sellers submit their products in BATCHES (one per
 * "Submit for Approval", possibly 1000+ products), so admin reviews batches,
 * not single products.
 *
 *   List    GET  /admin/approval-batches?status=PENDING — one compact row per
 *                batch (seller, type, product and category counts, status).
 *   Review  GET  /admin/approval-batches/:id/summary and
 *           GET  /admin/approval-batches/:id/products?offset&limit — a compact
 *                table (name, category › subcategory, SKU, the seller's MRP,
 *                price and stock, thumbnail, status), 100 rows at a time.
 *   Decide  POST /admin/approval-batches/:id/approve — ONE action approves every
 *                still-pending product; PATCH .../items/:itemId rejects one
 *                product with a reason. Approval never changes the seller's
 *                price or stock.
 *
 * Responses of decisions are not trusted for display: the list, the open batch
 * and the sidebar count are re-fetched from the server.
 */

import { useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApprovalStatus,
  type ApproveProductBatchResultDto,
  type CursorPage,
  type ProductApprovalBatchProductRowDto,
  type ProductApprovalBatchProductsPageDto,
  type ProductApprovalBatchSummaryDto,
} from '@shared';
import { formatPaise } from '@shared/money';
import { api, ApiRequestError } from '@/lib/api';
import { imageSrc } from '@/lib/image';
import { approvalKeys, pendingBatchesPath, retryServerErrorsOnce } from '@/lib/productApprovals';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Icon,
  Modal,
  Panel,
  Pill,
  Spinner,
  Td,
  Th,
  inputClass,
  type Tone,
} from '@/components/ui';

/** Backend limit on a review note (reviewItemSchema: max 400). */
const REVIEW_NOTE_MAX = 400;
/** Rows per page of a batch's product table (backend max 200). */
const PRODUCT_PAGE = 100;

const APPROVAL_LOOK: Record<string, { label: string; tone: Tone }> = {
  [ApprovalStatus.PENDING]: { label: 'Pending review', tone: 'amber' },
  [ApprovalStatus.APPROVED]: { label: 'Approved', tone: 'brand' },
  [ApprovalStatus.REJECTED]: { label: 'Rejected', tone: 'red' },
};

function ApprovalPill({ status }: { status: string }) {
  const look = APPROVAL_LOOK[status] ?? { label: status, tone: 'gray' as Tone };
  return <Pill tone={look.tone}>{look.label}</Pill>;
}

const dateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});
const formatDateTime = (iso: string): string => dateTime.format(new Date(iso));
const shortId = (id: string): string => id.slice(0, 8).toUpperCase();
const titleCase = (value: string): string => value.charAt(0) + value.slice(1).toLowerCase();
const plural = (count: number, word: string): string => `${count.toLocaleString('en-IN')} ${word}${count === 1 ? '' : 's'}`;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return 'Your account does not have permission to review product approvals.';
    return error.message || fallback;
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/* -------------------------------------------------------------------------- */
/* page                                                                        */
/* -------------------------------------------------------------------------- */

export default function ProductApprovalsPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const pending = useInfiniteQuery({
    queryKey: approvalKeys.pending,
    queryFn: ({ pageParam }) => api.get<CursorPage<ProductApprovalBatchSummaryDto>>(pendingBatchesPath(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    retry: retryServerErrorsOnce,
  });

  // A batch seen on two pages (same submittedAt) is listed once.
  const seen = new Set<string>();
  const batches = (pending.data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((batch) => (seen.has(batch.id) ? false : (seen.add(batch.id), true)));
  const waiting = batches.reduce((sum, batch) => sum + batch.pendingCount, 0);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
  };

  return (
    <div className="space-y-5">
      <Panel
        title="Approval batches waiting for review"
        bodyClass=""
        action={
          <Button variant="secondary" onClick={refresh} disabled={pending.isFetching}>
            {pending.isFetching && !pending.isFetchingNextPage && !pending.isPending ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        {pending.isPending ? (
          <Spinner label="Loading batches…" />
        ) : pending.isError && batches.length === 0 ? (
          <div className="space-y-3 p-5 pt-0">
            <ErrorBanner message={errorMessage(pending.error, 'Could not load approval batches.')} />
            <Button variant="secondary" onClick={() => void pending.refetch()}>
              Try again
            </Button>
          </div>
        ) : batches.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No batches waiting for review" hint="When a seller submits products for approval, the batch appears here." />
          </div>
        ) : (
          <>
            <p className="px-5 pb-3 text-sm text-gray-500">
              {plural(waiting, 'product')} awaiting a decision in {plural(batches.length, 'batch')}.
            </p>
            <div className="overflow-x-auto border-t border-gray-100">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <Th>Batch ID</Th>
                    <Th>Seller</Th>
                    <Th>Product Count</Th>
                    <Th>Categories</Th>
                    <Th>Submitted</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {batches.map((batch) => (
                    <tr key={batch.id} className="transition hover:bg-gray-50/60">
                      <Td className="whitespace-nowrap font-mono text-xs text-gray-600">#{shortId(batch.id)}</Td>
                      <Td>
                        <p className="font-medium text-gray-900">{batch.sellerName}</p>
                        <p className="text-xs text-gray-500">{titleCase(batch.sellerType)}</p>
                      </Td>
                      <Td>
                        <p className="font-semibold text-gray-900">{batch.itemCount.toLocaleString('en-IN')}</p>
                        <p className="text-xs text-gray-500">
                          {batch.pendingCount.toLocaleString('en-IN')} pending
                          {batch.rejectedCount > 0 ? ` · ${batch.rejectedCount} rejected` : ''}
                        </p>
                      </Td>
                      <Td className="text-gray-700">{batch.categoryCount}</Td>
                      <Td className="whitespace-nowrap text-gray-600">{formatDateTime(batch.submittedAt)}</Td>
                      <Td>
                        <ApprovalPill status={batch.status} />
                      </Td>
                      <Td>
                        <div className="flex justify-end">
                          <Button variant="soft" onClick={() => setSelected(batch.id)}>
                            Review batch
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pending.hasNextPage && (
              <div className="border-t border-gray-100 p-4 text-center">
                {pending.isFetchNextPageError && <p className="mb-2 text-sm text-danger-600">Could not load more batches.</p>}
                <Button variant="secondary" disabled={pending.isFetchingNextPage} onClick={() => void pending.fetchNextPage()}>
                  {pending.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>

      {selected && <BatchModal batchId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* one batch                                                                   */
/* -------------------------------------------------------------------------- */

function BatchModal({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState<ProductApprovalBatchProductRowDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: [...approvalKeys.detail(batchId), 'summary'],
    queryFn: () => api.get<ProductApprovalBatchSummaryDto>(`/admin/approval-batches/${batchId}/summary`),
    retry: retryServerErrorsOnce,
  });
  const products = useInfiniteQuery({
    queryKey: [...approvalKeys.detail(batchId), 'products'],
    queryFn: ({ pageParam }) =>
      api.get<ProductApprovalBatchProductsPageDto>(`/admin/approval-batches/${batchId}/products?offset=${pageParam}&limit=${PRODUCT_PAGE}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    retry: retryServerErrorsOnce,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: approvalKeys.all });

  const approve = useMutation({
    mutationFn: () => api.post<ApproveProductBatchResultDto>(`/admin/approval-batches/${batchId}/approve`),
    onSuccess: (result) => {
      setConfirming(false);
      setNotice(
        `${plural(result.approvedCount, 'product')} approved and now live for customers (when in stock).` +
          (result.removedCount > 0 ? ` ${plural(result.removedCount, 'product')} removed by the seller were closed.` : ''),
      );
    },
    onSettled: () => refresh(),
  });
  const reject = useMutation({
    mutationFn: (input: { itemId: string; reviewNote: string }) =>
      api.patch(`/admin/approval-batches/${batchId}/items/${input.itemId}`, { status: ApprovalStatus.REJECTED, reviewNote: input.reviewNote }),
    onSuccess: () => setRejecting(null),
    onSettled: () => refresh(),
  });

  const batch = summary.data;
  const rows = (products.data?.pages ?? []).flatMap((page) => page.items);
  const total = products.data?.pages[0]?.total ?? batch?.itemCount ?? 0;
  const open = batch?.status === ApprovalStatus.PENDING && batch.pendingCount > 0;

  return (
    <Modal
      wide
      title={batch ? `Approval batch #${shortId(batch.id)}` : 'Approval batch'}
      subtitle={batch ? `${batch.sellerName} · ${plural(batch.itemCount, 'product')}` : undefined}
      onClose={() => {
        if (!approve.isPending) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={approve.isPending} className="w-full sm:w-auto">
            Close
          </Button>
          {open &&
            (confirming ? (
              <Button onClick={() => approve.mutate()} disabled={approve.isPending} className="w-full sm:w-auto">
                {approve.isPending ? 'Approving…' : `Yes, approve ${plural(batch.pendingCount, 'product')}`}
              </Button>
            ) : (
              <Button onClick={() => setConfirming(true)} className="w-full sm:w-auto">
                Approve Batch
              </Button>
            ))}
        </div>
      }
    >
      <div className="space-y-4">
        {summary.isPending ? (
          <Spinner label="Loading batch…" />
        ) : summary.isError ? (
          <ErrorBanner message={errorMessage(summary.error, 'Could not load this batch.')} />
        ) : (
          batch && (
            <dl className="grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-3.5 text-sm sm:grid-cols-4">
              <Fact label="Seller">
                {batch.sellerName}
                <span className="block text-xs font-normal text-gray-500">{titleCase(batch.sellerType)}</span>
              </Fact>
              <Fact label="Products">
                {batch.itemCount.toLocaleString('en-IN')}
                <span className="block text-xs font-normal text-gray-500">
                  {batch.pendingCount} pending · {batch.approvedCount} approved · {batch.rejectedCount} rejected
                </span>
              </Fact>
              <Fact label="Categories">{batch.categoryCount}</Fact>
              <Fact label="Status">
                <ApprovalPill status={batch.status} />
                <span className="mt-1 block text-xs font-normal text-gray-500">Submitted {formatDateTime(batch.submittedAt)}</span>
              </Fact>
            </dl>
          )
        )}

        {notice && (
          <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700">
            {notice}
          </div>
        )}
        {confirming && open && (
          <div className="rounded-xl border border-warn-500/40 bg-warn-50 px-3.5 py-3 text-sm text-gray-800">
            Approve all {plural(batch.pendingCount, 'pending product')} in this batch? They go live for customers with the seller’s own
            price and stock. Products you rejected individually stay rejected.{' '}
            <button type="button" className="font-semibold text-gray-600 underline" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        )}
        <ErrorBanner message={approve.error ? errorMessage(approve.error, 'Could not approve this batch.') : null} />

        {products.isPending ? (
          <Spinner label="Loading products…" />
        ) : products.isError && rows.length === 0 ? (
          <ErrorBanner message={errorMessage(products.error, 'Could not load the products in this batch.')} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full min-w-[940px] text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <Th>Product</Th>
                  <Th>SKU</Th>
                  <Th>Category</Th>
                  <Th>Subcategory</Th>
                  <Th className="text-right">MRP</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Stock</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <tr key={row.itemId}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <Thumb src={row.thumbUrl} alt={row.name} />
                        <div className="min-w-0">
                          <p className="max-w-[16rem] truncate font-medium text-gray-900">{row.name}</p>
                          {row.variantName && <p className="text-xs text-gray-500">{row.variantName}</p>}
                        </div>
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-xs text-gray-600">{row.sku ?? '—'}</Td>
                    <Td className="text-gray-700">{row.category}</Td>
                    <Td className="text-gray-700">{row.subcategory ?? '—'}</Td>
                    <Td className="whitespace-nowrap text-right text-gray-600">{row.mrpPaise !== null ? formatPaise(row.mrpPaise) : '—'}</Td>
                    <Td className="whitespace-nowrap text-right font-semibold text-gray-900">
                      {row.pricePaise !== null ? formatPaise(row.pricePaise) : '—'}
                    </Td>
                    <Td className="whitespace-nowrap text-right text-gray-700">{row.stockQty ?? '—'}</Td>
                    <Td>
                      {row.removed ? <Pill tone="gray">Removed by seller</Pill> : <ApprovalPill status={row.itemStatus} />}
                      {row.reviewNote && <p className="mt-0.5 max-w-[12rem] truncate text-xs text-gray-500">{row.reviewNote}</p>}
                    </Td>
                    <Td>
                      <div className="flex justify-end">
                        {row.itemStatus === ApprovalStatus.PENDING && !row.removed && (
                          <Button variant="ghost" onClick={() => setRejecting(row)}>
                            Reject
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3.5 py-2.5 text-xs text-gray-500">
              <span>
                Showing {rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}
              </span>
              {products.hasNextPage && (
                <Button variant="secondary" disabled={products.isFetchingNextPage} onClick={() => void products.fetchNextPage()}>
                  {products.isFetchingNextPage ? 'Loading…' : `Load next ${Math.min(PRODUCT_PAGE, total - rows.length)}`}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {rejecting && (
        <RejectModal
          productName={rejecting.name}
          busy={reject.isPending}
          error={reject.error ? errorMessage(reject.error, 'Could not reject this product.') : null}
          onCancel={() => {
            reject.reset();
            setRejecting(null);
          }}
          onConfirm={(reviewNote) => reject.mutate({ itemId: rejecting.itemId, reviewNote })}
        />
      )}
    </Modal>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 font-semibold text-gray-900">{children}</dd>
    </div>
  );
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const resolved = imageSrc(src);
  return resolved ? (
    <img src={resolved} alt={alt} loading="lazy" className="h-10 w-10 shrink-0 rounded-lg border border-gray-200 bg-white object-cover" />
  ) : (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
      <Icon name="products" className="h-4 w-4" />
    </span>
  );
}

function RejectModal({
  productName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  productName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const trimmed = reason.trim();
  const empty = trimmed.length === 0;

  return (
    <Modal
      title="Reject Product"
      subtitle={productName}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setTried(true);
              if (!empty) onConfirm(trimmed);
            }}
          >
            {busy ? 'Rejecting…' : 'Reject product'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label htmlFor="rejection-reason" className="block text-sm font-medium text-gray-700">
          Reason for rejection
        </label>
        <textarea
          id="rejection-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={REVIEW_NOTE_MAX}
          rows={4}
          placeholder="Tell the seller what to fix, e.g. the photo is blurry."
          aria-invalid={tried && empty}
          className={`${inputClass} min-h-24 py-2.5`}
        />
        <div className="flex items-center justify-between gap-3 text-xs">
          {tried && empty ? (
            <span className="text-danger-600">Enter a reason for rejection.</span>
          ) : (
            <span className="text-gray-500">The seller sees this reason.</span>
          )}
          <span className="text-gray-400">
            {reason.length}/{REVIEW_NOTE_MAX}
          </span>
        </div>
        <ErrorBanner message={error} />
      </div>
    </Modal>
  );
}
