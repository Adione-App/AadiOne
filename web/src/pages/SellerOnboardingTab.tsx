/**
 * Seller detail — Onboarding tab.
 *
 * ONE READ SOURCE: GET /admin/sellers/:id/onboarding/summary
 * (`useSellerOnboardingSummary`). The server returns it already safe: PAN,
 * Aadhaar and the account number MASKED, documents as metadata only (the
 * response has no link field at all), plus the completeness rule's parts and
 * the last rejection. This app never calls the older unmasked
 * GET /admin/sellers/:id/onboarding.
 *
 * READ-ONLY: onboarding data belongs to the seller. Admin can view it, open
 * the PDFs, Show a document number (audited) and decide — verify/reject a
 * document, verify the bank account — but never add, edit, upload or replace
 * anything (the server has no such admin route). Decision responses are
 * discarded and the summary + overview are re-read.
 *
 * The Gate 1 / Gate 2 decisions are on the Seller lifecycle panel above the
 * tabs (components/SellerLifecyclePanel.tsx); this tab shows the submitted
 * details admin verifies, with the same checklist the seller had to complete.
 */

import { useState } from 'react';
import {
  DocumentStatus,
  type AdminSellerDetailDto,
  type AdminVerifyBankDetailRequest,
  type SellerBankDetailDto,
} from '@shared';
import { ApiRequestError } from '@/lib/api';
import {
  sellerErrorMessage,
  sellersApi,
  useReviewSellerDocument,
  useSellerOnboardingSummary,
  useSellerPermissions,
  useVerifySellerBankDetail,
  type SafeSellerDocument,
} from '@/lib/sellers';
import { DetailRow, LifecyclePill, formatSellerDate } from '@/components/SellerBadges';
import {
  DOCUMENT_TYPE_LABEL,
  DocumentNumber,
  ViewPdfButton,
  formatFileSize,
} from '@/components/SellerDocuments';
import { Button, EmptyState, ErrorBanner, Field, Icon, Modal, Panel, Pill, Spinner, inputClass, type Tone } from '@/components/ui';

/* -------------------------------------------------------------------------- */
/* labels & limits (from the backend schemas)                                  */
/* -------------------------------------------------------------------------- */

const DOCUMENT_LOOK: Record<string, { label: string; tone: Tone }> = {
  [DocumentStatus.PENDING]: { label: 'Pending review', tone: 'amber' },
  [DocumentStatus.VERIFIED]: { label: 'Verified', tone: 'brand' },
  [DocumentStatus.REJECTED]: { label: 'Rejected', tone: 'red' },
};

const DOCUMENT_REASON_MAX = 300; // reviewDocumentSchema

export const STALE_BANK_MESSAGE =
  'Bank details changed after you reviewed them. Refresh the details and review again before verifying.';

const FieldError = ({ message }: { message?: string | undefined }) =>
  message ? <span className="mt-1 block text-xs text-danger-600">{message}</span> : null;

/* -------------------------------------------------------------------------- */
/* tab                                                                         */
/* -------------------------------------------------------------------------- */

type DocumentDecision = { document: SafeSellerDocument; action: 'VERIFY' | 'REJECT' };

export default function SellerOnboardingTab({
  seller,
  onNotice,
  section = 'all',
}: {
  /** The masked overview — used only for the seller's name and
   * owner (to prefill a first profile). Onboarding data comes from the summary. */
  seller: AdminSellerDetailDto;
  onNotice: (message: string) => void;
  /** 'documents' renders only the Documents panel (the Seller Detail Documents tab). */
  section?: 'all' | 'documents';
}) {
  const perms = useSellerPermissions();
  const summaryQuery = useSellerOnboardingSummary(seller.id);

  const [verifyOpen, setVerifyOpen] = useState(false);
  const [docDecision, setDocDecision] = useState<DocumentDecision | null>(null);

  if (summaryQuery.isPending) return <Spinner label="Loading onboarding…" />;
  if (summaryQuery.isError) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={sellerErrorMessage(summaryQuery.error, 'Could not load onboarding.')} />
        <Button variant="secondary" onClick={() => void summaryQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const summary = summaryQuery.data;
  const { profile, bankDetail, documents } = summary;

  return (
    <div className="space-y-5">
      {section === 'all' && (
      <>
      {/* ------------------------------------------ verification checklist */}
      <Panel title="Onboarding checklist" action={<LifecyclePill status={summary.lifecycleStatus} />}>
        <ul className="space-y-1.5 text-sm">
          {summary.checklist.map((item) => (
            <ChecklistItem key={item.key} done={item.met} label={item.label} />
          ))}
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          {summary.isComplete
            ? 'Every required item is present. Verify the documents and bank details below before approving the seller.'
            : 'Items marked missing must be completed by the seller before the seller can be approved.'}
          {summary.onboardingSubmittedAt ? ` Submitted ${formatSellerDate(summary.onboardingSubmittedAt)}.` : ''}
        </p>
        {summary.lastRejectionReason && (
          <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm">
            <p className="font-medium text-gray-800">
              Final rejection
              {summary.lastRejectedAt ? ` · ${formatSellerDate(summary.lastRejectedAt)}` : ''}
            </p>
            <p className="mt-0.5 text-gray-600">{summary.lastRejectionReason}</p>
          </div>
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------------- profile */}
        <Panel title="Business profile">
          {profile ? (
            <dl className="divide-y divide-gray-100">
              <DetailRow label="Business name">{profile.businessName}</DetailRow>
              <DetailRow label="Business type">{profile.businessType ?? '—'}</DetailRow>
              <DetailRow label="Owner name">{profile.ownerFullName}</DetailRow>
              <DetailRow label="Owner mobile">{profile.ownerMobile}</DetailRow>
              <DetailRow label="Owner email">{profile.ownerEmail ?? '—'}</DetailRow>
              <DetailRow label="PAN (masked)">{profile.panNumber ?? '—'}</DetailRow>
              <DetailRow label="Aadhaar (masked)">{profile.aadhaarNumber ?? '—'}</DetailRow>
              <DetailRow label="GST number">{profile.gstNumber ?? '—'}</DetailRow>
              <DetailRow label="FSSAI number">{profile.fssaiNumber ?? '—'}</DetailRow>
            </dl>
          ) : (
            <EmptyState title="No business profile yet" hint="The seller adds it during onboarding." />
          )}
        </Panel>

        {/* ---------------------------------------------------------- bank */}
        <Panel
          title="Bank details"
          action={
            perms.canVerifyBank &&
            bankDetail &&
            !bankDetail.isVerified && (
              <Button variant="soft" onClick={() => setVerifyOpen(true)}>
                Verify Bank
              </Button>
            )
          }
        >
          {bankDetail ? (
            <dl className="divide-y divide-gray-100">
              <DetailRow label="Account holder">{bankDetail.accountHolderName}</DetailRow>
              <DetailRow label="Bank">{bankDetail.bankName ?? '—'}</DetailRow>
              <DetailRow label="Account number">{bankDetail.accountNumber}</DetailRow>
              <DetailRow label="IFSC">{bankDetail.ifscCode}</DetailRow>
              <DetailRow label="Verification">
                <Pill tone={bankDetail.isVerified ? 'brand' : 'amber'}>
                  {bankDetail.isVerified ? 'Verified' : 'Not verified'}
                </Pill>
              </DetailRow>
            </dl>
          ) : (
            <EmptyState title="No bank details yet" hint="The seller adds them during onboarding." />
          )}
        </Panel>
      </div>
      </>
      )}

      {/* ------------------------------------------------------- documents */}
      <Panel title="Documents" bodyClass="">
        <p className="px-5 pb-3 text-xs text-gray-500">
          The seller uploads documents as PDFs; they are kept private and read-only here. Numbers are hidden until you
          choose Show; opening a PDF or showing a number is recorded in the audit log.
        </p>
        {documents.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No documents yet" hint="The seller uploads them during onboarding." />
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 border-t border-gray-100">
            {documents.map((document) => {
              const look = DOCUMENT_LOOK[document.status] ?? { label: document.status, tone: 'gray' as Tone };
              return (
                <li key={document.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-gray-900">{DOCUMENT_TYPE_LABEL[document.type] ?? document.type}</p>
                    <p className="text-sm text-gray-700">
                      <span className="text-gray-500">Number: </span>
                      <DocumentNumber
                        masked={document.documentNumberMasked}
                        {...(perms.canReview
                          ? {
                              onReveal: async () =>
                                (await sellersApi.revealDocumentNumber(seller.id, document.id)).documentNumber,
                            }
                          : {})}
                      />
                    </p>
                    <p className="text-sm text-gray-700">
                      <span className="text-gray-500">File: </span>
                      {document.hasFile ? (
                        <>
                          {document.fileName ?? 'document.pdf'}
                          {document.fileSizeBytes ? <span className="text-gray-500"> · {formatFileSize(document.fileSizeBytes)}</span> : null}
                        </>
                      ) : document.legacyLink ? (
                        <span className="text-warn-600">Added as a link before uploads — ask the seller to upload the PDF</span>
                      ) : (
                        <span className="text-gray-500">No file</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      Submitted {formatSellerDate(document.createdAt)}
                      {document.reviewedAt && ` · Reviewed ${formatSellerDate(document.reviewedAt)}`}
                      {document.expiresAt && ` · Expires ${formatSellerDate(document.expiresAt)}`}
                    </p>
                    {document.status === DocumentStatus.REJECTED && document.rejectionReason && (
                      <p className="mt-0.5 text-xs text-danger-600">Rejected: {document.rejectionReason}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {perms.canReview && document.hasFile && (
                      <ViewPdfButton load={() => sellersApi.documentFile(seller.id, document.id)} />
                    )}
                    <Pill tone={look.tone}>{look.label}</Pill>
                    {perms.canReview && document.status === DocumentStatus.PENDING && (
                      <>
                        <Button variant="soft" onClick={() => setDocDecision({ document, action: 'VERIFY' })}>
                          Verify
                        </Button>
                        <Button variant="ghost" onClick={() => setDocDecision({ document, action: 'REJECT' })}>
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {verifyOpen && bankDetail && (
        <VerifyBankModal
          sellerId={seller.id}
          bank={bankDetail}
          onClose={() => setVerifyOpen(false)}
          onVerified={() => {
            setVerifyOpen(false);
            onNotice('Bank account verified.');
          }}
        />
      )}
      {docDecision && (
        <DocumentDecisionModal
          sellerId={seller.id}
          decision={docDecision}
          onClose={() => setDocDecision(null)}
          onDone={(message) => {
            setDocDecision(null);
            onNotice(message);
          }}
        />
      )}
    </div>
  );
}

function ChecklistItem({ done, label, pending }: { done: boolean; label: string; pending?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
          pending ? 'bg-gray-100 text-gray-400' : done ? 'bg-brand-50 text-brand-600' : 'bg-gray-100 text-gray-400'
        }`}
        aria-hidden="true"
      >
        {done && !pending ? <Icon name="check" className="h-3.5 w-3.5" /> : '·'}
      </span>
      <span className={done && !pending ? 'text-gray-800' : 'text-gray-500'}>
        {label}
        {!pending && !done && ' — missing'}
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* bank verification (a review decision — the details stay the seller's)      */
/* -------------------------------------------------------------------------- */

function VerifyBankModal({
  sellerId,
  bank,
  onClose,
  onVerified,
}: {
  sellerId: string;
  /** The MASKED bank detail as shown when this dialog opened. */
  bank: SellerBankDetailDto;
  onClose: () => void;
  onVerified: () => void;
}) {
  const verify = useVerifySellerBankDetail(sellerId);
  // Captured once, on open: a later refetch never changes what is verified.
  const [reviewed] = useState(() => ({
    bank,
    request: {
      bankDetailId: bank.id,
      expectedUpdatedAt: bank.updatedAt,
    } satisfies AdminVerifyBankDetailRequest,
  }));
  const stale = verify.error instanceof ApiRequestError && verify.error.status === 409;

  return (
    <Modal
      title="Verify bank account"
      subtitle="Confirm you have checked these details against the seller's bank proof."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={verify.isPending}>
            {stale ? 'Close' : 'Cancel'}
          </Button>
          {!stale && (
            <Button onClick={() => verify.mutate(reviewed.request, { onSuccess: onVerified })} disabled={verify.isPending}>
              {verify.isPending ? 'Verifying…' : 'Verify account'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {stale ? (
          <ErrorBanner message={STALE_BANK_MESSAGE} />
        ) : (
          verify.isError && <ErrorBanner message={sellerErrorMessage(verify.error, 'Could not verify the account.')} />
        )}
        <dl className="divide-y divide-gray-100 rounded-xl border border-gray-200 px-4">
          <DetailRow label="Account holder">{reviewed.bank.accountHolderName}</DetailRow>
          <DetailRow label="Bank">{reviewed.bank.bankName ?? '—'}</DetailRow>
          <DetailRow label="Account number">{reviewed.bank.accountNumber}</DetailRow>
          <DetailRow label="IFSC">{reviewed.bank.ifscCode}</DetailRow>
        </dl>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* documents                                                                   */
/* -------------------------------------------------------------------------- */

function DocumentDecisionModal({
  sellerId,
  decision,
  onClose,
  onDone,
}: {
  sellerId: string;
  decision: DocumentDecision;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const review = useReviewSellerDocument(sellerId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rejecting = decision.action === 'REJECT';
  const label = DOCUMENT_TYPE_LABEL[decision.document.type] ?? decision.document.type;

  const confirm = () => {
    const trimmed = reason.trim();
    if (rejecting && !trimmed) {
      setError('A reason is required to reject a document.');
      return;
    }
    setError(null);
    review.mutate(
      {
        documentId: decision.document.id,
        status: rejecting ? DocumentStatus.REJECTED : DocumentStatus.VERIFIED,
        ...(rejecting ? { rejectionReason: trimmed } : {}),
      },
      { onSuccess: () => onDone(rejecting ? `${label} rejected.` : `${label} verified.`) },
    );
  };

  return (
    <Modal
      title={rejecting ? 'Reject document' : 'Verify document'}
      subtitle={`${label} · submitted ${formatSellerDate(decision.document.createdAt)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={review.isPending}>
            Cancel
          </Button>
          <Button variant={rejecting ? 'danger' : 'primary'} onClick={confirm} disabled={review.isPending}>
            {review.isPending ? 'Saving…' : rejecting ? 'Reject' : 'Verify'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {review.isError && <ErrorBanner message={sellerErrorMessage(review.error, 'Could not record the decision.')} />}
        <p className="text-sm text-gray-600">
          {rejecting
            ? 'The seller sees this reason and can submit a new document.'
            : 'Confirm you have checked this document against the seller’s original.'}
        </p>
        {rejecting && (
          <Field label="Reason" required hint={`${reason.trim().length}/${DOCUMENT_REASON_MAX}`}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, DOCUMENT_REASON_MAX))}
              rows={3}
              className={inputClass}
            />
            <FieldError message={error ?? undefined} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
