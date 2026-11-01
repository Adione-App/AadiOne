/**
 * Refunds — the refund management dashboard (ORDER_REFUND).
 *
 *   Overview      what needs attention
 *   Requests      customer refund requests: review evidence, approve (all or
 *                 less), reject — every decision with a note, audited
 *   Refunds       refund groups (one per action): seller-wise parts, Cashfree
 *                 ids, failures, retry history, seller deductions, COD payouts
 *   All components  the raw Cashfree refund rows
 *
 * Money moves only through the backend's checks: a retry asks Cashfree first;
 * a COD refund is recorded and then confirmed, never sent through Cashfree.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { adminErrorMessage, shortDateTime, toQuery } from '@/lib/marketplace';
import {
  COMPONENT_LABEL,
  GROUP_STATUS,
  LINE_STATE,
  ORIGIN_LABEL,
  REQUEST_STATUS,
  refundKeys,
  rupeesToPaise,
  type GroupStatus,
  type RefundGroupDetail,
  type RefundGroupRow,
  type RefundOverview,
  type RefundRequestDetail,
  type RefundRequestRow,
  type CorrectionResult,
  type RetryResult,
} from '@/lib/refunds';
import { Button, ErrorBanner, Field, Modal, Pill, StatCard, Surface, inputClass } from '@/components/ui';
import { EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList } from '@/seller/sellerUi';
import { useDebouncedValue } from '@/seller/sellerQueries';
import { RefundComponentsTab } from './RefundComponents';

type Tab = 'requests' | 'groups' | 'components';
const TABS: { value: Tab; label: string }[] = [
  { value: 'requests', label: 'Requests' },
  { value: 'groups', label: 'Refunds' },
  { value: 'components', label: 'All components' },
];

const when = (iso: string | null | undefined) => (iso ? shortDateTime.format(new Date(iso)) : '—');

export default function RefundsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'requests') as Tab;
  const overview = useQuery({ queryKey: refundKeys.overview, queryFn: () => api.get<RefundOverview>('/admin/refund-overview') });

  return (
    <div className="space-y-5">
      {overview.data && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon="clipboard" label="Requests to review" value={overview.data.requestsUnderReview} tone="amber" />
          <StatCard
            icon="alert"
            label="Failed / partly failed"
            value={overview.data.failed + overview.data.partialFailures}
            tone="red"
            foot="Retry after Cashfree confirms"
          />
          <StatCard
            icon="clock"
            label="In progress"
            value={overview.data.processing + overview.data.approvedNotStarted}
            tone="blue"
            foot={`${overview.data.manualAwaitingPayout} COD to pay · ${overview.data.manualAwaitingConfirmation} to confirm`}
          />
          <StatCard
            icon="rupee"
            label="Seller deductions due"
            value={formatPaise(overview.data.outstandingSellerDeductionsPaise)}
            tone="purple"
            foot="Taken from the next settlements"
          />
        </div>
      )}

      <div role="tablist" aria-label="Refund views" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setParams({ tab: t.value }, { replace: true })}
            className={`min-h-11 rounded-xl px-4 text-sm font-semibold transition ${
              tab === t.value ? 'bg-brand-500 text-white shadow-sm' : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50'
            }`}
          >
            {t.label}
            {t.value === 'requests' && overview.data && overview.data.requestsUnderReview > 0 && (
              <span className="ml-2 rounded-full bg-white/90 px-2 text-xs text-warn-500">{overview.data.requestsUnderReview}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'requests' && <RequestsTab />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'components' && <RefundComponentsTab />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

const REQUEST_FILTER = [
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All' },
] as const;

function RequestsTab() {
  const [status, setStatus] = useState<(typeof REQUEST_FILTER)[number]['value']>('UNDER_REVIEW');
  const [openId, setOpenId] = useState<string | null>(null);
  const query = toQuery({ status: status === 'ALL' ? undefined : status, limit: 50 });
  const requests = useQuery({
    queryKey: refundKeys.requests(query),
    queryFn: () => api.get<{ items: RefundRequestRow[] }>(`/admin/refund-requests?${query}`),
  });

  return (
    <>
      <Surface className="grid gap-3 p-3 sm:grid-cols-[minmax(0,16rem)]">
        <FilterSelect label="Request status" value={status} options={REQUEST_FILTER} onChange={setStatus} />
      </Surface>
      {requests.isPending ? (
        <SkeletonList rows={4} label="Loading requests…" />
      ) : requests.isError ? (
        <LoadError message={adminErrorMessage(requests.error)} onRetry={() => void requests.refetch()} />
      ) : requests.data.items.length === 0 ? (
        <EmptyPanel icon="clipboard" title="No refund requests" hint={status === 'UNDER_REVIEW' ? 'Nothing is waiting for review.' : undefined} />
      ) : (
        <Surface className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <caption className="sr-only">Refund requests</caption>
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th scope="col" className="px-4 py-3">Received</th>
                  <th scope="col" className="px-3 py-3">Order</th>
                  <th scope="col" className="px-3 py-3">Issue</th>
                  <th scope="col" className="px-3 py-3 text-right">Requested</th>
                  <th scope="col" className="px-3 py-3 text-right">Approved</th>
                  <th scope="col" className="px-3 py-3">Status</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {requests.data.items.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-gray-50/60">
                    <td className="whitespace-nowrap px-4 py-3 text-gray-600">{when(r.createdAt)}</td>
                    <td className="px-3 py-3">
                      <span className="font-mono font-semibold text-gray-900">#{r.orderNumber}</span>
                      <span className="block text-xs text-gray-500">
                        {r.customerName ?? r.customerMobile} · {r.paymentMethod === 'COD' ? 'Cash on Delivery' : 'Online'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-gray-700">
                      {r.categoryLabel}
                      {r.photoCount > 0 && <span className="block text-xs text-gray-500">{r.photoCount} photo(s)</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatPaise(r.requestedPaise)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{r.approvedPaise !== null ? formatPaise(r.approvedPaise) : '—'}</td>
                    <td className="px-3 py-3">
                      <Pill tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Pill>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="soft" onClick={() => setOpenId(r.id)}>
                        {r.status === 'UNDER_REVIEW' ? 'Review' : 'View'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {openId && <RequestModal id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

/** An evidence photo — fetched with the admin session, never through a public URL. */
function EvidencePhoto({ requestId, evidenceId }: { requestId: string; evidenceId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    api
      .getBlob(`/admin/refund-requests/${requestId}/evidence/${evidenceId}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [requestId, evidenceId]);
  if (failed) return <div className="flex h-28 w-28 items-center justify-center rounded-xl bg-gray-100 text-xs text-gray-500">Could not load</div>;
  if (!url) return <div className="h-28 w-28 animate-pulse rounded-xl bg-gray-100" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      <img src={url} alt="Customer's evidence" className="h-28 w-28 rounded-xl object-cover ring-1 ring-gray-200" />
    </a>
  );
}

function RequestModal({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: refundKeys.request(id), queryFn: () => api.get<RefundRequestDetail>(`/admin/refund-requests/${id}`) });
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (detail.data && amount === '') setAmount((detail.data.approvablePaise / 100).toFixed(2));
    // Pre-fill once with what is approvable now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'refunds'] });
  };
  const approve = useMutation({
    mutationFn: (approvedPaise: number) => api.post(`/admin/refund-requests/${id}/approve`, { approvedPaise, decisionNote: note.trim() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => setError(adminErrorMessage(e)),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/admin/refund-requests/${id}/reject`, { decisionNote: note.trim() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => setError(adminErrorMessage(e)),
  });

  const d = detail.data;
  const approvedPaise = rupeesToPaise(amount);
  const noteOk = note.trim().length >= 5;
  const busy = approve.isPending || reject.isPending;

  return (
    <Modal
      wide
      title={d ? `Refund request · #${d.order.orderNumber}` : 'Refund request'}
      subtitle={d ? `${d.categoryLabel} · ${when(d.createdAt)}` : undefined}
      onClose={onClose}
      footer={
        d?.status === 'UNDER_REVIEW' ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={!noteOk || busy} onClick={() => reject.mutate()}>
              Reject
            </Button>
            <Button
              disabled={!noteOk || busy || approvedPaise === null || approvedPaise > d.approvablePaise}
              onClick={() => approvedPaise !== null && approve.mutate(approvedPaise)}
            >
              {approvedPaise !== null && approvedPaise < d.approvablePaise ? `Approve ${formatPaise(approvedPaise)}` : 'Approve'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {detail.isPending ? (
        <SkeletonList rows={3} label="Loading request…" />
      ) : detail.isError || !d ? (
        <LoadError message={adminErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <Info label="Customer" value={`${d.customer.name ?? '—'} · ${d.customer.mobile}`} />
            <Info label="Payment" value={`${d.order.paymentMethod === 'COD' ? 'Cash on Delivery' : 'Online'} · ${d.order.paymentStatus}`} />
            <Info label="Delivered" value={when(d.order.deliveredAt)} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">What the customer says</p>
            <p className="whitespace-pre-wrap rounded-xl bg-gray-50 p-3 text-sm text-gray-800">{d.description}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-2">Item</th>
                  <th className="py-2">Seller</th>
                  <th className="py-2 text-right">Qty</th>
                  <th className="py-2 text-right">Requested</th>
                  <th className="py-2 text-right">Still refundable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {d.lines.map((l) => (
                  <tr key={l.orderItemId}>
                    <td className="py-2">
                      {l.productName}
                      <span className="block text-xs text-gray-500">{l.variantName}</span>
                    </td>
                    <td className="py-2 text-gray-700">{l.sellerName ?? '—'}</td>
                    <td className="py-2 text-right">{l.qty}</td>
                    <td className="py-2 text-right tabular-nums">{formatPaise(l.amountPaise)}</td>
                    <td className="py-2 text-right tabular-nums">{formatPaise(l.stillRefundablePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.evidence.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Photos (private — opening one is logged)</p>
              <div className="flex flex-wrap gap-3">
                {d.evidence.map((e) => (
                  <EvidencePhoto key={e.id} requestId={d.id} evidenceId={e.id} />
                ))}
              </div>
            </div>
          )}

          {d.status === 'UNDER_REVIEW' ? (
            <div className="grid gap-3 rounded-2xl border border-gray-200 p-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <Field label="Amount to refund (₹)" hint={`At most ${formatPaise(d.approvablePaise)}`} required>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={inputClass} />
              </Field>
              <Field label="Decision note" hint="Shown to the customer if rejected. At least 5 characters." required>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={inputClass} />
              </Field>
              <p className="text-xs text-gray-500 sm:col-span-2">
                {d.order.paymentMethod === 'COD'
                  ? 'Cash on Delivery: approving opens a manual refund — you then record and confirm the UPI / bank transfer. Cashfree is never used.'
                  : 'Online: approving refunds the amount through Cashfree, split by seller. Each seller is deducted from their next settlement.'}
              </p>
              <div className="sm:col-span-2">
                <ErrorBanner message={error} />
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-gray-50 p-4 text-sm text-gray-700">
              <Pill tone={REQUEST_STATUS[d.status].tone}>{REQUEST_STATUS[d.status].label}</Pill>{' '}
              {d.approvedPaise !== null && <span className="font-semibold">{formatPaise(d.approvedPaise)}</span>} by {d.reviewedBy ?? '—'} on{' '}
              {when(d.reviewedAt)}
              {d.decisionNote && <p className="mt-2">“{d.decisionNote}”</p>}
              {d.group && (
                <p className="mt-2 text-xs text-gray-500">
                  Refund {GROUP_STATUS[d.group.status as GroupStatus]?.label ?? d.group.status} · {formatPaise(d.group.refundedPaise)} of{' '}
                  {formatPaise(d.group.totalPaise)} back
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="text-gray-900">{value}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Refund groups                                                              */
/* -------------------------------------------------------------------------- */

const GROUP_FILTER = [
  { value: 'ALL', label: 'Any status' },
  { value: 'PARTIAL_FAILURE', label: 'Partly failed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SUCCESS', label: 'Refunded' },
] as const;
const CHANNEL_FILTER = [
  { value: 'ALL', label: 'Cashfree and COD' },
  { value: 'CASHFREE', label: 'Cashfree' },
  { value: 'MANUAL', label: 'COD (manual)' },
] as const;

function GroupsTab() {
  const [status, setStatus] = useState<(typeof GROUP_FILTER)[number]['value']>('ALL');
  const [channel, setChannel] = useState<(typeof CHANNEL_FILTER)[number]['value']>('ALL');
  const [search, setSearch] = useState('');
  const orderNumber = useDebouncedValue(search.trim(), 350);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = toQuery({
    status: status === 'ALL' ? undefined : status,
    channel: channel === 'ALL' ? undefined : channel,
    orderNumber: orderNumber.length >= 2 ? orderNumber : undefined,
    limit: 50,
  });
  const groups = useQuery({
    queryKey: refundKeys.groups(query),
    queryFn: () => api.get<{ items: RefundGroupRow[] }>(`/admin/refund-groups?${query}`),
    placeholderData: (previous) => previous,
  });

  return (
    <>
      <Surface className="grid gap-3 p-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-end">
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Order</span>
          <SearchBox value={search} onChange={setSearch} placeholder="Order number…" label="Search refunds by order" />
        </div>
        <FilterSelect label="Status" value={status} options={GROUP_FILTER} onChange={setStatus} />
        <FilterSelect label="Channel" value={channel} options={CHANNEL_FILTER} onChange={setChannel} />
      </Surface>
      {groups.isPending ? (
        <SkeletonList rows={5} label="Loading refunds…" />
      ) : groups.isError ? (
        <LoadError message={adminErrorMessage(groups.error)} onRetry={() => void groups.refetch()} />
      ) : groups.data.items.length === 0 ? (
        <EmptyPanel icon="rupee" title="No refunds found" />
      ) : (
        <Surface className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <caption className="sr-only">Refund groups</caption>
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th scope="col" className="px-4 py-3">Created</th>
                  <th scope="col" className="px-3 py-3">Order</th>
                  <th scope="col" className="px-3 py-3">Origin</th>
                  <th scope="col" className="px-3 py-3 text-right">Total</th>
                  <th scope="col" className="px-3 py-3 text-right">Back</th>
                  <th scope="col" className="px-3 py-3">Status</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {groups.data.items.map((g) => (
                  <tr key={g.id} className="align-top hover:bg-gray-50/60">
                    <td className="whitespace-nowrap px-4 py-3 text-gray-600">{when(g.createdAt)}</td>
                    <td className="px-3 py-3">
                      <span className="font-mono font-semibold text-gray-900">#{g.orderNumber}</span>
                      <span className="block text-xs text-gray-500">{g.customerName ?? '—'}</span>
                    </td>
                    <td className="px-3 py-3 text-gray-700">
                      {ORIGIN_LABEL[g.origin]}
                      <span className="block text-xs text-gray-500">
                        {g.channel === 'MANUAL' ? 'COD — manual transfer' : `${g.components} Cashfree part(s)`}
                        {g.postDelivery ? ' · after delivery' : ''}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{formatPaise(g.totalPaise)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatPaise(g.refundedPaise)}</td>
                    <td className="px-3 py-3">
                      <Pill tone={GROUP_STATUS[g.status].tone}>{GROUP_STATUS[g.status].label}</Pill>
                      {g.retryable && <span className="mt-1 block text-xs text-danger-600">Retry available</span>}
                      {g.channel === 'MANUAL' && g.manualPayoutStatus !== 'CONFIRMED' && (
                        <span className="mt-1 block text-xs text-warn-500">{g.manualPayoutStatus === 'RECORDED' ? 'Confirm payout' : 'Record payout'}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="soft" onClick={() => setOpenId(g.id)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {openId && <GroupModal id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function GroupModal({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: refundKeys.group(id), queryFn: () => api.get<RefundGroupDetail>(`/admin/refund-groups/${id}`) });
  const [error, setError] = useState<string | null>(null);
  const [retryResult, setRetryResult] = useState<RetryResult | null>(null);
  const [payout, setPayout] = useState({ method: 'UPI' as 'UPI' | 'BANK_TRANSFER', reference: '', paidOn: todayIst(), proofNote: '' });
  const [confirming, setConfirming] = useState(false);
  const [correctionNote, setCorrectionNote] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin', 'refunds'] });
  const onError = (e: unknown) => setError(adminErrorMessage(e));
  const retry = useMutation({
    mutationFn: () => api.post<RetryResult>(`/admin/refund-groups/${id}/retry`),
    onSuccess: (result) => {
      setRetryResult(result);
      setError(null);
      refresh();
    },
    onError,
  });
  const reconcile = useMutation({
    mutationFn: () => api.post(`/admin/refund-groups/${id}/reconcile`),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const correct = useMutation({
    mutationFn: (refundId: string) => api.post<CorrectionResult>(`/admin/refunds/${refundId}/correct-from-cashfree`),
    onSuccess: (result) => {
      setError(null);
      setCorrectionNote(result.message);
      refresh();
    },
    onError,
  });
  const record = useMutation({
    mutationFn: () =>
      api.post(`/admin/refund-groups/${id}/cod-payout`, {
        method: payout.method,
        reference: payout.reference.trim(),
        paidOn: payout.paidOn,
        proofNote: payout.proofNote.trim() || null,
      }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const confirm = useMutation({
    mutationFn: () => api.post(`/admin/refund-groups/${id}/cod-payout/confirm`),
    onSuccess: () => {
      setError(null);
      setConfirming(false);
      refresh();
    },
    onError,
  });

  const g = detail.data;
  return (
    <Modal
      wide
      title={g ? `Refund · #${g.order.orderNumber}` : 'Refund'}
      subtitle={g ? `${ORIGIN_LABEL[g.origin]} · ${when(g.createdAt)}${g.createdBy ? ` · by ${g.createdBy}` : ''}` : undefined}
      onClose={onClose}
    >
      {detail.isPending ? (
        <SkeletonList rows={4} label="Loading refund…" />
      ) : detail.isError || !g ? (
        <LoadError message={adminErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <Pill tone={GROUP_STATUS[g.status].tone}>{GROUP_STATUS[g.status].label}</Pill>
            <span className="text-sm text-gray-700">
              <span className="font-semibold">{formatPaise(g.refundedPaise)}</span> of {formatPaise(g.totalPaise)} back with the customer
            </span>
            {g.postDelivery && <Pill tone="purple">After delivery</Pill>}
            <span className="text-sm text-gray-500">{g.customer.name ?? '—'} · {g.customer.mobile}</span>
          </div>
          <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-700">{g.reason}</p>
          <ErrorBanner message={error} />

          {g.channel === 'CASHFREE' && (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-gray-900">Cashfree refund parts</h3>
                <div className="flex gap-2">
                  {g.actions.canReconcile && (
                    <Button variant="secondary" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
                      Check with Cashfree
                    </Button>
                  )}
                  {g.actions.canRetry && (
                    <Button variant="danger" disabled={retry.isPending} onClick={() => retry.mutate()}>
                      Retry failed parts
                    </Button>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="py-2">Part</th>
                      <th className="py-2">Seller</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2">State</th>
                      <th className="py-2">Cashfree refund ID</th>
                      <th className="py-2">Created / done</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {g.components.map((c) => (
                      <tr key={c.id} className={c.state === 'RETRIED' ? 'text-gray-400' : ''}>
                        <td className="py-2">
                          {COMPONENT_LABEL[c.componentType ?? ''] ?? '—'}
                          {c.retryOfId && <span className="block text-xs text-gray-500">Retry of an earlier attempt</span>}
                        </td>
                        <td className="py-2">{c.sellerName ?? '—'}</td>
                        <td className="py-2 text-right tabular-nums">{formatPaise(c.amountPaise)}</td>
                        <td className="py-2">
                          <Pill tone={LINE_STATE[c.state].tone}>{LINE_STATE[c.state].label}</Pill>
                          {c.correction ? (
                            <span className="mt-1 block max-w-[16rem] text-xs text-gray-600">
                              Corrected from Cashfree ({c.correction.providerStatus}) by {c.correction.by}, {when(c.correction.at)}
                            </span>
                          ) : (
                            c.failureReason && <span className="mt-1 block max-w-[16rem] text-xs text-danger-600">{c.failureReason}</span>
                          )}
                          {c.state === 'FAILED_RETRYABLE' && (
                            <button
                              type="button"
                              disabled={correct.isPending}
                              onClick={() => correct.mutate(c.id)}
                              className="mt-1 block text-xs font-semibold text-brand-600 hover:underline disabled:opacity-50"
                            >
                              Correct from Cashfree
                            </button>
                          )}
                        </td>
                        <td className="max-w-[12rem] break-all py-2 font-mono text-xs">{c.providerRefundId ?? '—'}</td>
                        <td className="py-2 text-xs text-gray-500">
                          {when(c.createdAt)}
                          {c.completedAt && <span className="block">Done {when(c.completedAt)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {correctionNote && <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-700">{correctionNote}</p>}
              {retryResult && (
                <div className="rounded-xl bg-gray-50 p-3 text-sm">
                  <p>
                    Retried {retryResult.retried.length} part(s)
                    {retryResult.skipped.length > 0 ? `; ${retryResult.skipped.length} not retried:` : '.'}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-gray-600">
                    {retryResult.skipped.map((s) => (
                      <li key={s.refundId}>{s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-gray-500">
                A retry happens only for parts Cashfree definitively refused, and only after Cashfree confirms it holds no refund for them.
                Parts awaiting Cashfree are never retried — check with Cashfree instead. If Cashfree actually paid a part recorded as
                failed, "Correct from Cashfree" re-reads it and records it as paid — nothing is sent again.
              </p>
            </section>
          )}

          {g.channel === 'MANUAL' && (
            <section className="space-y-3">
              <h3 className="font-semibold text-gray-900">Cash on Delivery — manual transfer</h3>
              {g.allocation.length > 0 && (
                <ul className="text-sm text-gray-700">
                  {g.allocation.map((l) => (
                    <li key={l.orderItemId}>
                      {l.sellerName ?? 'Seller'}: {formatPaise(l.amountPaise)}
                    </li>
                  ))}
                </ul>
              )}
              {g.manualPayout ? (
                <div className="rounded-2xl border border-gray-200 p-4 text-sm">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Info label="Amount" value={formatPaise(g.manualPayout.amountPaise)} />
                    <Info label="Method" value={g.manualPayout.method === 'UPI' ? 'UPI' : 'Bank transfer'} />
                    <Info label="Reference" value={g.manualPayout.reference} />
                    <Info label="Paid on" value={g.manualPayout.paidOn} />
                    <Info label="Recorded by" value={`${g.manualPayout.recordedBy ?? '—'} · ${when(g.manualPayout.recordedAt)}`} />
                    <Info
                      label="Confirmed"
                      value={g.manualPayout.status === 'CONFIRMED' ? `${g.manualPayout.confirmedBy ?? '—'} · ${when(g.manualPayout.confirmedAt)}` : 'Not yet'}
                    />
                  </div>
                  {g.manualPayout.proofNote && <p className="mt-3 text-gray-600">Proof: {g.manualPayout.proofNote}</p>}
                  {g.actions.canConfirmPayout && (
                    <p className="mt-3 text-xs text-gray-500">A different admin from the one who recorded it must confirm this payout.</p>
                  )}
                  {g.actions.canConfirmPayout &&
                    (confirming ? (
                      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-warn-50 p-3">
                        <span className="text-sm text-gray-800">Confirm the customer received {formatPaise(g.manualPayout.amountPaise)}? This marks the refund successful.</span>
                        <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
                          Yes, confirm
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirming(false)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button className="mt-4" onClick={() => setConfirming(true)}>
                        Confirm payout received
                      </Button>
                    ))}
                </div>
              ) : g.actions.canRecordPayout ? (
                <div className="grid gap-3 rounded-2xl border border-gray-200 p-4 sm:grid-cols-2">
                  <Field label="Method" required>
                    <select
                      value={payout.method}
                      onChange={(e) => setPayout({ ...payout, method: e.target.value as 'UPI' | 'BANK_TRANSFER' })}
                      className={inputClass}
                    >
                      <option value="UPI">UPI</option>
                      <option value="BANK_TRANSFER">Bank transfer</option>
                    </select>
                  </Field>
                  <Field label="Transaction reference" hint="UPI transaction id or bank UTR" required>
                    <input value={payout.reference} onChange={(e) => setPayout({ ...payout, reference: e.target.value })} maxLength={120} className={inputClass} />
                  </Field>
                  <Field label="Paid on" required>
                    <input type="date" value={payout.paidOn} max={todayIst()} onChange={(e) => setPayout({ ...payout, paidOn: e.target.value })} className={inputClass} />
                  </Field>
                  <Field label="Proof" hint="Where the screenshot / receipt is kept. No account numbers.">
                    <input value={payout.proofNote} onChange={(e) => setPayout({ ...payout, proofNote: e.target.value })} maxLength={300} className={inputClass} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Button disabled={record.isPending || payout.reference.trim().length < 6} onClick={() => record.mutate()}>
                      Record transfer ({formatPaise(g.totalPaise)})
                    </Button>
                    <p className="mt-2 text-xs text-gray-500">
                      Recording does not complete the refund — a different admin confirms it in a second step.
                    </p>
                  </div>
                </div>
              ) : null}
            </section>
          )}

          {g.deductions.length > 0 && (
            <section>
              <h3 className="mb-2 font-semibold text-gray-900">Seller deductions</h3>
              <ul className="space-y-1 text-sm text-gray-700">
                {g.deductions.map((d) => (
                  <li key={d.id}>
                    {d.sellerName}: {formatPaise(d.amountPaise)} of the seller's earning taken back for a {formatPaise(d.refundedPaise)} refund
                    {d.commissionReversedPaise > 0 && <> ({formatPaise(d.commissionReversedPaise)} commission reversed)</>} —{' '}
                    {formatPaise(d.appliedPaise)} taken from settlements ({d.status.replace(/_/g, ' ').toLowerCase()})
                  </li>
                ))}
              </ul>
            </section>
          )}

          {g.request && (
            <section className="text-sm text-gray-700">
              <h3 className="mb-1 font-semibold text-gray-900">Customer request</h3>
              {g.request.categoryLabel} · requested {formatPaise(g.request.requestedPaise)}
              {g.request.approvedPaise !== null && ` · approved ${formatPaise(g.request.approvedPaise)}`}
              {g.request.decisionNote && <span className="block text-gray-500">“{g.request.decisionNote}”</span>}
            </section>
          )}

          <section>
            <h3 className="mb-2 font-semibold text-gray-900">History</h3>
            <ol className="space-y-1 text-xs text-gray-600">
              {g.audit.map((a) => (
                <li key={a.id}>
                  <span className="text-gray-400">{when(a.at)}</span> · {a.actor} · <span className="font-mono">{a.action}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Modal>
  );
}
