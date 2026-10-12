/**
 * The two onboarding gates on the admin Seller Detail page.
 *
 *   APPLICATION → APPROVED → ONBOARDING → SUBMITTED → ADMIN VERIFICATION → ACTIVE
 *
 * Shows Application, Onboarding and Verification status separately, the
 * seller-facing reason of the latest rejection / request for changes, and
 * the decision buttons for whichever gate is open:
 *   Gate 1 (APPLICATION_PENDING)        Approve Application / Reject Application
 *   Gate 2 (ONBOARDING_PENDING_REVIEW)  Approve Seller / Request Changes / Reject Seller
 * Decisions go to PATCH /admin/sellers/:id/application/review and
 * .../verification/review; the server re-checks every rule. A rejected seller
 * can correct and resubmit (the application at Gate 1, the onboarding at
 * Gate 2), so a corrected submission comes back here for a new decision; the
 * review history lists every submission and decision with its reason.
 */

import { useState } from 'react';
import type { AdminSellerDetailDto, SellerLifecycleEventDto, SellerLifecycleStatus } from '@shared';
import { sellerErrorMessage, useReviewSellerApplication, useReviewSellerVerification } from '@/lib/sellers';
import { DetailRow, LifecyclePill, formatSellerDate } from '@/components/SellerBadges';
import { Button, ErrorBanner, Field, Icon, Modal, Pill, Surface, inputClass, type Tone } from '@/components/ui';

const STEPS: { label: string; done: (s: SellerLifecycleStatus) => boolean }[] = [
  { label: 'Application', done: () => true },
  { label: 'Approved', done: (s) => !['APPLICATION_PENDING', 'APPLICATION_REJECTED'].includes(s) },
  { label: 'Onboarding', done: (s) => ['ONBOARDING_PENDING_REVIEW', 'ACTIVE', 'ONBOARDING_REJECTED'].includes(s) },
  { label: 'Submitted', done: (s) => ['ONBOARDING_PENDING_REVIEW', 'ACTIVE', 'ONBOARDING_REJECTED'].includes(s) },
  { label: 'Admin verification', done: (s) => ['ACTIVE'].includes(s) },
  { label: 'Active', done: (s) => s === 'ACTIVE' },
];

function applicationStatus(seller: AdminSellerDetailDto): { label: string; tone: Tone } {
  switch (seller.lifecycleStatus) {
    case 'APPLICATION_PENDING':
      return { label: 'Pending admin approval', tone: 'amber' };
    case 'APPLICATION_REJECTED':
      return { label: 'Rejected', tone: 'red' };
    default:
      return seller.applicationSubmittedAt
        ? { label: 'Approved', tone: 'brand' }
        : { label: 'Created by admin', tone: 'brand' };
  }
}

function onboardingStatus(status: SellerLifecycleStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'APPLICATION_PENDING':
    case 'APPLICATION_REJECTED':
      return { label: 'Locked (application not approved)', tone: 'gray' };
    case 'ONBOARDING_PENDING':
      return { label: 'In progress', tone: 'blue' };
    case 'ONBOARDING_CHANGES_REQUIRED':
      return { label: 'Changes required', tone: 'amber' };
    case 'ONBOARDING_REJECTED':
      return { label: 'Rejected — seller may correct and resubmit', tone: 'red' };
    default:
      return { label: 'Submitted', tone: 'brand' };
  }
}

function verificationStatus(status: SellerLifecycleStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'ONBOARDING_PENDING_REVIEW':
      return { label: 'Awaiting verification', tone: 'purple' };
    case 'ONBOARDING_CHANGES_REQUIRED':
      return { label: 'Changes requested', tone: 'amber' };
    case 'ACTIVE':
      return { label: 'Verified', tone: 'brand' };
    case 'ONBOARDING_REJECTED':
      return { label: 'Rejected', tone: 'red' };
    default:
      return { label: 'Not submitted yet', tone: 'gray' };
  }
}

type Decision =
  | { gate: 1; decision: 'REJECT' }
  | { gate: 2; decision: 'REQUEST_CHANGES' | 'REJECT' };

export function SellerLifecyclePanel({
  seller,
  canReview,
  onNotice,
  onOpenOnboarding,
}: {
  seller: AdminSellerDetailDto;
  canReview: boolean;
  onNotice: (message: string) => void;
  /** Opens the Onboarding tab (the full submitted details). */
  onOpenOnboarding: () => void;
}) {
  const gate1 = useReviewSellerApplication();
  const gate2 = useReviewSellerVerification();
  const [asking, setAsking] = useState<Decision | null>(null);
  const status = seller.lifecycleStatus;
  const busy = gate1.isPending || gate2.isPending;
  const error = gate1.isError
    ? sellerErrorMessage(gate1.error, 'Could not record the decision.')
    : gate2.isError
      ? sellerErrorMessage(gate2.error, 'Could not record the decision.')
      : null;

  const app = applicationStatus(seller);
  const onb = onboardingStatus(status);
  const ver = verificationStatus(status);

  return (
    <Surface className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Seller lifecycle</h2>
          <p className="text-sm text-gray-500">Gate 1 approves the application; Gate 2 verifies the submitted onboarding.</p>
        </div>
        <LifecyclePill status={status} isActive={seller.isActive} />
      </div>

      <ol className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs font-semibold" aria-label="Lifecycle progress">
        {STEPS.map((step, index) => {
          const done = step.done(status);
          return (
            <li key={step.label} className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${
                  done ? 'bg-brand-50 text-brand-700' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {done && <Icon name="check" className="h-3.5 w-3.5" />}
                {step.label}
              </span>
              {index < STEPS.length - 1 && <span className="text-gray-300" aria-hidden="true">→</span>}
            </li>
          );
        })}
      </ol>

      <dl className="mt-4 grid gap-x-8 divide-y divide-gray-100 sm:grid-cols-3 sm:divide-y-0">
        <DetailRow label="Application">
          <Pill tone={app.tone}>{app.label}</Pill>
        </DetailRow>
        <DetailRow label="Onboarding">
          <Pill tone={onb.tone}>{onb.label}</Pill>
        </DetailRow>
        <DetailRow label="Verification">
          <Pill tone={ver.tone}>{ver.label}</Pill>
        </DetailRow>
      </dl>
      <dl className="grid gap-x-8 sm:grid-cols-3">
        <DetailRow label="Applied">{seller.applicationSubmittedAt ? formatSellerDate(seller.applicationSubmittedAt) : '—'}</DetailRow>
        <DetailRow label="Submitted for verification">
          {seller.onboardingSubmittedAt ? formatSellerDate(seller.onboardingSubmittedAt) : '—'}
        </DetailRow>
        <DetailRow label="Activated">{seller.activatedAt ? formatSellerDate(seller.activatedAt) : '—'}</DetailRow>
      </dl>

      {seller.lifecycleReason && (
        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm">
          <p className="font-medium text-gray-800">
            {status === 'ONBOARDING_CHANGES_REQUIRED' ? 'Changes requested' : 'Reason given to the seller'}
          </p>
          <p className="mt-0.5 text-gray-600">{seller.lifecycleReason}</p>
        </div>
      )}

      {seller.lifecycleHistory.length > 0 && <ReviewHistory events={seller.lifecycleHistory} />}

      {error && (
        <div className="mt-3">
          <ErrorBanner message={error} />
        </div>
      )}

      {canReview && status === 'APPLICATION_PENDING' && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
          <span className="mr-auto text-sm text-gray-600">Gate 1 — decide this application.</span>
          <Button variant="secondary" disabled={busy} onClick={() => setAsking({ gate: 1, decision: 'REJECT' })}>
            Reject Application
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              gate1.mutate(
                { sellerId: seller.id, body: { decision: 'APPROVE' } },
                { onSuccess: () => onNotice(`${seller.name}: application approved. The seller can now complete onboarding (not active yet).`) },
              )
            }
          >
            {gate1.isPending ? 'Saving…' : 'Approve Application'}
          </Button>
        </div>
      )}

      {canReview && status === 'ONBOARDING_PENDING_REVIEW' && (
        <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
          {!seller.isComplete && (
            <p className="rounded-xl bg-warn-50 px-3.5 py-2.5 text-sm text-warn-600">
              Some required onboarding items are missing — request changes instead of approving.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onOpenOnboarding} className="mr-auto text-sm font-semibold text-brand-600 hover:underline">
              Review submitted details, bank and documents →
            </button>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking({ gate: 2, decision: 'REJECT' })}>
              Reject Seller
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setAsking({ gate: 2, decision: 'REQUEST_CHANGES' })}>
              Request Changes
            </Button>
            <Button
              disabled={busy || !seller.isComplete}
              onClick={() =>
                gate2.mutate(
                  { sellerId: seller.id, body: { decision: 'APPROVE' } },
                  { onSuccess: () => onNotice(`${seller.name} is verified and ACTIVE — the full Seller Panel is unlocked.`) },
                )
              }
            >
              {gate2.isPending ? 'Saving…' : 'Approve Seller'}
            </Button>
          </div>
        </div>
      )}

      {asking && (
        <ReasonModal
          title={
            asking.gate === 1
              ? 'Reject application'
              : asking.decision === 'REQUEST_CHANGES'
                ? 'Request changes'
                : 'Reject seller'
          }
          subtitle={
            asking.gate === 1
              ? `${seller.name} — the applicant sees this reason and can correct and resubmit the application; onboarding stays locked until you approve it.`
              : asking.decision === 'REQUEST_CHANGES'
                ? `${seller.name} — tell the seller exactly what to fix. They edit and resubmit; no new application is needed.`
                : `${seller.name} — the seller sees this reason, stays inactive, and can correct the onboarding and resubmit it for final approval.`
          }
          confirmLabel={asking.gate === 2 && asking.decision === 'REQUEST_CHANGES' ? 'Send request' : 'Reject'}
          danger={!(asking.gate === 2 && asking.decision === 'REQUEST_CHANGES')}
          minLength={DECISION_REASON_MIN}
          busy={busy}
          error={error}
          onClose={() => setAsking(null)}
          onConfirm={(reason) => {
            const done = () => {
              setAsking(null);
              onNotice(
                asking.gate === 1
                  ? `${seller.name}: application rejected.`
                  : asking.decision === 'REQUEST_CHANGES'
                    ? `${seller.name}: changes requested. The seller can edit and resubmit.`
                    : `${seller.name}: seller rejected.`,
              );
            };
            if (asking.gate === 1) gate1.mutate({ sellerId: seller.id, body: { decision: 'REJECT', reason } }, { onSuccess: done });
            else gate2.mutate({ sellerId: seller.id, body: { decision: asking.decision, reason } }, { onSuccess: done });
          }}
        />
      )}
    </Surface>
  );
}

/** Lifecycle rejections / requests for changes: the server's MIN_DECISION_REASON_LENGTH. */
export const DECISION_REASON_MIN = 10;

const HISTORY_LABEL: Record<SellerLifecycleEventDto['event'], { label: string; tone: Tone }> = {
  APPLICATION_SUBMITTED: { label: 'Application submitted', tone: 'gray' },
  APPLICATION_RESUBMITTED: { label: 'Application resubmitted', tone: 'blue' },
  APPLICATION_APPROVED: { label: 'Application approved', tone: 'brand' },
  APPLICATION_REJECTED: { label: 'Application rejected', tone: 'red' },
  ONBOARDING_SUBMITTED: { label: 'Onboarding submitted', tone: 'gray' },
  ONBOARDING_RESUBMITTED: { label: 'Onboarding resubmitted', tone: 'blue' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'amber' },
  ONBOARDING_APPROVED: { label: 'Approved — active', tone: 'brand' },
  ONBOARDING_REJECTED: { label: 'Onboarding rejected', tone: 'red' },
};

/** Every submission and decision, newest first, with its time and reason. */
function ReviewHistory({ events }: { events: SellerLifecycleEventDto[] }) {
  return (
    <details className="mt-3 rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm" open={events.length <= 8}>
      <summary className="cursor-pointer font-medium text-gray-800">Review history ({events.length})</summary>
      <ol className="mt-2 space-y-2">
        {events.map((event, index) => (
          <li key={`${event.at}-${index}`} className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-3">
            <span className="shrink-0 text-xs text-gray-500 sm:w-40">
              {new Date(event.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
            </span>
            <span className="min-w-0">
              <Pill tone={HISTORY_LABEL[event.event].tone}>{HISTORY_LABEL[event.event].label}</Pill>
              {event.reason && <span className="ml-2 text-gray-600">“{event.reason}”</span>}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** A decision that needs a reason the seller will read. */
export function ReasonModal({
  title,
  subtitle,
  confirmLabel,
  busy,
  error,
  danger = true,
  minLength = 3,
  onClose,
  onConfirm,
}: {
  title: string;
  subtitle: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  danger?: boolean;
  /** Shortest reason accepted (the server enforces its own minimum too). */
  minLength?: number;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    if (reason.trim().length < minLength) {
      return setProblem(
        minLength > 3 ? `Write a clear reason the seller can act on (at least ${minLength} characters).` : 'Write a short reason the seller can act on.',
      );
    }
    setProblem(null);
    onConfirm(reason.trim());
  };
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner message={problem ?? error} />
        <Field label="Reason (shown to the seller)" required hint={`${reason.trim().length}/500${minLength > 3 ? ` · at least ${minLength} characters` : ''}`}>
          <textarea value={reason} maxLength={500} rows={4} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>
      </div>
    </Modal>
  );
}
