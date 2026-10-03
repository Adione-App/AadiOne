/**
 * Product Approvals — seller-submitted products waiting for admin review.
 *
 * List: GET /admin/approval-batches?status=PENDING (cursor pages of batches,
 * one row per product in them). Detail: GET /admin/approval-batches/:id,
 * which carries each item's product details. A decision is
 * PATCH /admin/approval-batches/:id/items/:itemId — its response is not used:
 * the list, the open detail and the sidebar count are re-fetched, and the
 * screen shows only what the server now says.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApprovalStatus,
  type CursorPage,
  type ProductApprovalBatchDto,
  type ProductApprovalBatchReviewDto,
  type ProductApprovalReviewItemDto,
} from '@shared';
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

const APPROVAL_LOOK: Record<string, { label: string; tone: Tone }> = {
  [ApprovalStatus.PENDING]: { label: 'Pending review', tone: 'amber' },
  [ApprovalStatus.APPROVED]: { label: 'Approved', tone: 'brand' },
  [ApprovalStatus.REJECTED]: { label: 'Rejected', tone: 'red' },
};

function ApprovalPill({ status }: { status: string }) {
  const look = APPROVAL_LOOK[status] ?? { label: status, tone: 'gray' as Tone };
  return <Pill tone={look.tone}>{look.label}</Pill>;
}

function ProductStatusPill({ status }: { status: string }) {
  return <Pill tone={status === 'ACTIVE' ? 'brand' : 'gray'}>{status.charAt(0) + status.slice(1).toLowerCase()}</Pill>;
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
  const [selected, setSelected] = useState<{ batchId: string; itemId: string } | null>(null);

  const pending = useInfiniteQuery({
    queryKey: approvalKeys.pending,
    queryFn: ({ pageParam }) => api.get<CursorPage<ProductApprovalBatchDto>>(pendingBatchesPath(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    retry: retryServerErrorsOnce,
  });

  // One row per product; a batch seen on two pages (same submittedAt) counts once.
  const { rows, batchCount } = useMemo(() => {
    const seen = new Set<string>();
    const batches = (pending.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((batch) => (seen.has(batch.id) ? false : (seen.add(batch.id), true)));
    return {
      batchCount: batches.length,
      rows: batches.flatMap((batch) => batch.items.map((item, index) => ({ batch, item, index }))),
    };
  }, [pending.data]);
  const waiting = rows.filter((row) => row.item.status === ApprovalStatus.PENDING).length;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: approvalKeys.pending });
    void queryClient.invalidateQueries({ queryKey: approvalKeys.pendingCount });
  };

  return (
    <div className="space-y-5">
      <Panel
        title="Waiting for review"
        bodyClass=""
        action={
          <Button variant="secondary" onClick={refresh} disabled={pending.isFetching}>
            {pending.isFetching && !pending.isFetchingNextPage && !pending.isPending ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        {pending.isPending ? (
          <Spinner label="Loading submissions…" />
        ) : pending.isError && rows.length === 0 ? (
          <div className="space-y-3 p-5 pt-0">
            <ErrorBanner message={errorMessage(pending.error, 'Could not load submissions.')} />
            <Button variant="secondary" onClick={() => void pending.refetch()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              title="No products waiting for review"
              hint="Products sellers submit for approval will appear here."
            />
          </div>
        ) : (
          <>
            <p className="px-5 pb-3 text-sm text-gray-500">
              {waiting} {waiting === 1 ? 'product' : 'products'} awaiting a decision across {batchCount}{' '}
              {batchCount === 1 ? 'submission' : 'submissions'}.
            </p>
            <div className="overflow-x-auto border-t border-gray-100">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <Th>Product</Th>
                    <Th>Seller</Th>
                    <Th>Submitted</Th>
                    <Th>Status</Th>
                    <Th>Submission</Th>
                    <Th className="text-right">Action</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map(({ batch, item, index }) => (
                    <tr key={item.id} className="transition hover:bg-gray-50/60">
                      <Td>
                        <p className="font-medium text-gray-900">{item.productName}</p>
                        {item.reviewNote && (
                          <p className="mt-0.5 max-w-xs truncate text-xs text-gray-500">Note: {item.reviewNote}</p>
                        )}
                      </Td>
                      <Td className="text-gray-700">{batch.sellerName}</Td>
                      <Td className="whitespace-nowrap text-gray-600">{formatDateTime(batch.submittedAt)}</Td>
                      <Td>
                        <ApprovalPill status={item.status} />
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-gray-500">
                        #{shortId(batch.id)}
                        {batch.items.length > 1 && (
                          <span className="block">
                            Item {index + 1} of {batch.items.length}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex justify-end">
                          <Button
                            variant={item.status === ApprovalStatus.PENDING ? 'soft' : 'ghost'}
                            onClick={() => setSelected({ batchId: batch.id, itemId: item.id })}
                          >
                            {item.status === ApprovalStatus.PENDING ? 'Review' : 'View'}
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
                {pending.isFetchNextPageError && (
                  <p className="mb-2 text-sm text-danger-600">Could not load more submissions.</p>
                )}
                <Button
                  variant="secondary"
                  disabled={pending.isFetchingNextPage}
                  onClick={() => void pending.fetchNextPage()}
                >
                  {pending.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>

      {selected && (
        <ReviewModal
          batchId={selected.batchId}
          focusItemId={selected.itemId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* review                                                                      */
/* -------------------------------------------------------------------------- */

type Decision = typeof ApprovalStatus.APPROVED | typeof ApprovalStatus.REJECTED;

function ReviewModal({
  batchId,
  focusItemId,
  onClose,
}: {
  batchId: string;
  focusItemId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<ProductApprovalReviewItemDto | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: approvalKeys.detail(batchId),
    queryFn: () => api.get<ProductApprovalBatchReviewDto>(`/admin/approval-batches/${batchId}`),
    // Always re-read on open: another admin may have decided since.
    refetchOnMount: 'always',
    retry: retryServerErrorsOnce,
  });

  const decide = useMutation({
    mutationFn: (input: { itemId: string; status: Decision; reviewNote?: string }) =>
      api.patch(
        `/admin/approval-batches/${batchId}/items/${input.itemId}`,
        input.status === ApprovalStatus.REJECTED
          ? { status: input.status, reviewNote: input.reviewNote }
          : { status: input.status },
      ),
  });

  /** List, this detail and the sidebar count — all re-read from the server. */
  const refreshFromServer = () => queryClient.invalidateQueries({ queryKey: approvalKeys.all });

  async function submitDecision(item: ProductApprovalReviewItemDto, status: Decision, reviewNote?: string) {
    setFeedback(null);
    setRejectError(null);
    try {
      await decide.mutateAsync({ itemId: item.id, status, ...(reviewNote ? { reviewNote } : {}) });
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 409 || error.status === 404)) {
        setRejecting(null);
        await refreshFromServer();
        setFeedback({
          ok: false,
          text:
            error.status === 409
              ? `"${item.productName}" was already reviewed. Showing its current status.`
              : 'This submission could not be found any more. The list has been refreshed.',
        });
        return;
      }
      const text = errorMessage(error, 'Could not save the decision. Please try again.');
      if (status === ApprovalStatus.REJECTED) setRejectError(text);
      else setFeedback({ ok: false, text });
      return;
    }
    await refreshFromServer();
    setRejecting(null);
    setFeedback({
      ok: true,
      text: status === ApprovalStatus.APPROVED ? `Approved "${item.productName}".` : `Rejected "${item.productName}".`,
    });
  }

  const batch = detail.data;

  return (
    <>
      <Modal
        wide
        title="Review submission"
        subtitle={batch ? `${batch.sellerName} · submitted ${formatDateTime(batch.submittedAt)}` : undefined}
        // While the reject dialog is open, Escape belongs to it alone.
        onClose={() => {
          if (!rejecting) onClose();
        }}
        footer={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="space-y-4">
          {feedback &&
            (feedback.ok ? (
              <div
                role="status"
                className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700"
              >
                {feedback.text}
              </div>
            ) : (
              <ErrorBanner message={feedback.text} />
            ))}

          {detail.isPending ? (
            <Spinner label="Loading submission…" />
          ) : detail.isError || !batch ? (
            <div className="space-y-3">
              <ErrorBanner message={errorMessage(detail.error, 'Could not load this submission.')} />
              <Button variant="secondary" onClick={() => void detail.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              <BatchSummary batch={batch} />
              {batch.items.map((item) => (
                <ReviewItemCard
                  key={item.id}
                  item={item}
                  focused={item.id === focusItemId && batch.items.length > 1}
                  busyItemId={decide.isPending ? (decide.variables?.itemId ?? null) : null}
                  onApprove={() => void submitDecision(item, ApprovalStatus.APPROVED)}
                  onReject={() => {
                    setRejectError(null);
                    setRejecting(item);
                  }}
                />
              ))}
            </>
          )}
        </div>
      </Modal>

      {rejecting && (
        <RejectModal
          productName={rejecting.productName}
          busy={decide.isPending}
          error={rejectError}
          onCancel={() => setRejecting(null)}
          onConfirm={(reason) => void submitDecision(rejecting, ApprovalStatus.REJECTED, reason)}
        />
      )}
    </>
  );
}

function BatchSummary({ batch }: { batch: ProductApprovalBatchReviewDto }) {
  return (
    <dl className="grid gap-3 rounded-xl bg-gray-50 p-4 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-gray-500">Seller</dt>
        <dd className="font-medium text-gray-900">{batch.sellerName}</dd>
      </div>
      <div>
        <dt className="text-gray-500">Submitted</dt>
        <dd className="font-medium text-gray-900">{formatDateTime(batch.submittedAt)}</dd>
      </div>
      <div>
        <dt className="text-gray-500">Submission</dt>
        <dd className="font-medium text-gray-900">
          #{shortId(batch.id)} · {batch.items.length} {batch.items.length === 1 ? 'product' : 'products'}
        </dd>
      </div>
      <div>
        <dt className="text-gray-500">Submission status</dt>
        <dd className="mt-0.5">
          <ApprovalPill status={batch.status} />
          {batch.reviewedAt && (
            <span className="ml-2 text-xs text-gray-500">Reviewed {formatDateTime(batch.reviewedAt)}</span>
          )}
        </dd>
      </div>
      {batch.reviewNote && (
        <div className="sm:col-span-2">
          <dt className="text-gray-500">Submission note</dt>
          <dd className="text-gray-900">{batch.reviewNote}</dd>
        </div>
      )}
    </dl>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{children}</dd>
    </div>
  );
}

function ReviewItemCard({
  item,
  focused,
  busyItemId,
  onApprove,
  onReject,
}: {
  item: ProductApprovalReviewItemDto;
  focused: boolean;
  busyItemId: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const product = item.product;
  const variant = product?.defaultVariant ?? null;
  const busy = busyItemId !== null;
  const pending = item.status === ApprovalStatus.PENDING;

  return (
    <section
      aria-label={item.productName}
      className={`rounded-2xl border bg-white p-4 ${focused ? 'border-brand-500/50 ring-2 ring-brand-100' : 'border-gray-200'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900">{product?.name ?? item.productName}</h3>
          {product?.nameHi && <p className="text-sm text-gray-500">{product.nameHi}</p>}
        </div>
        <ApprovalPill status={item.status} />
      </div>

      {!product ? (
        <p className="mt-3 text-sm text-gray-500">Product details are not available.</p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Detail label="Category">{product.category.name}</Detail>
            <Detail label="Subcategory">{product.subcategory?.name ?? '—'}</Detail>
            <Detail label="SKU">
              <span className="font-mono text-xs">{variant?.sku ?? '—'}</span>
            </Detail>
            <Detail label="Variant">{variant?.variantName ?? '—'}</Detail>
            <Detail label="Unit">{variant?.unit ?? '—'}</Detail>
            <Detail label="Unit value">{variant?.unitValue ?? '—'}</Detail>
            <Detail label="Product status">
              <ProductStatusPill status={product.status} />
            </Detail>
            <Detail label="Approval status">
              <ApprovalPill status={product.approvalStatus} />
            </Detail>
          </dl>

          <div className="mt-4">
            <p className="text-xs text-gray-500">Description</p>
            <p className="mt-0.5 whitespace-pre-line text-sm text-gray-800">
              {product.description?.trim() || <span className="text-gray-400">No description</span>}
            </p>
          </div>

          <div className="mt-4">
            <p className="text-xs text-gray-500">Images</p>
            {product.images.length === 0 ? (
              <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-dashed border-gray-300 px-3 py-4 text-sm text-gray-500">
                <Icon name="image" className="h-5 w-5 text-gray-400" />
                No images
              </div>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-2">
                {product.images.map((image) => (
                  <img
                    key={image.id}
                    src={imageSrc(image.thumbUrl ?? image.url)}
                    alt={image.altText ?? product.name}
                    className="h-24 w-24 rounded-xl border border-gray-200 object-cover"
                    loading="lazy"
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {item.reviewNote && (
        <div
          className={`mt-4 rounded-xl px-3.5 py-2.5 text-sm ${
            item.status === ApprovalStatus.REJECTED ? 'bg-danger-50 text-danger-600' : 'bg-gray-50 text-gray-700'
          }`}
        >
          <span className="font-semibold">Review note:</span> {item.reviewNote}
        </div>
      )}

      {pending && (
        <div className="mt-4 flex flex-wrap justify-end gap-3 border-t border-gray-100 pt-4">
          <Button variant="danger" onClick={onReject} disabled={busy}>
            Reject
          </Button>
          <Button onClick={onApprove} disabled={busy}>
            {busyItemId === item.id ? 'Approving…' : 'Approve'}
          </Button>
        </div>
      )}
    </section>
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
