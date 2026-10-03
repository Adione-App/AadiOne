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
 * Writes (profile, bank, verify, documents, reviews) are unchanged; their
 * responses are discarded and the summary + overview are re-read.
 *
 * PAN, Aadhaar and account numbers typed into the forms live only in
 * uncontrolled inputs (read once on submit), never in React state.
 *
 * States follow the backend exactly: PENDING (stage PENDING/SUBMITTED),
 * APPROVED (final), REJECTED (back to review only when the seller resubmits).
 */

import { useRef, useState, type FormEvent } from 'react';
import {
  ApprovalStatus,
  DocumentStatus,
  SellerDocumentType,
  SellerStaffRole,
  normalizeIndianMobile,
  type AdminSellerDetailDto,
  type AdminVerifyBankDetailRequest,
  type SellerBankDetailDto,
  type SellerProfileDto,
  type UpsertSellerProfileRequest,
} from '@shared';
import { ApiRequestError } from '@/lib/api';
import {
  sellerErrorMessage,
  sellersApi,
  useAddSellerDocument,
  useReviewSellerDocument,
  useReviewSellerOnboarding,
  useSellerOnboardingSummary,
  useSellerPermissions,
  useUpsertSellerBankDetail,
  useUpsertSellerProfile,
  useVerifySellerBankDetail,
  type SafeSellerDocument,
} from '@/lib/sellers';
import { DetailRow, OnboardingPill, StagePill, formatSellerDate } from '@/components/SellerBadges';
import {
  DOCUMENT_TYPE_LABEL,
  DocumentNumber,
  DocumentUploadFields,
  ViewPdfButton,
  formatFileSize,
  validateDocumentUpload,
  type DocumentUploadValue,
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

const ONBOARDING_REASON_MAX = 400; // reviewOnboardingSchema
const DOCUMENT_REASON_MAX = 300; // reviewDocumentSchema
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const [profileOpen, setProfileOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [addDocOpen, setAddDocOpen] = useState(false);
  const [docDecision, setDocDecision] = useState<DocumentDecision | null>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | null>(null);

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
  const { profile, bankDetail, documents, requirements } = summary;
  const status = summary.onboardingStatus;

  return (
    <div className="space-y-5">
      {section === 'all' && (
      <>
      {/* ------------------------------------------------ status + decision */}
      <Panel
        title="Onboarding status"
        action={
          perms.canReview &&
          status === ApprovalStatus.PENDING && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDecision('REJECT')}>
                Reject
              </Button>
              <Button onClick={() => setDecision('APPROVE')} disabled={!summary.isComplete}>
                Approve
              </Button>
            </div>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <OnboardingPill status={status} />
          <StagePill stage={summary.stage} />
          <span className="text-gray-600">{summary.isComplete ? 'Application complete' : 'Application incomplete'}</span>
        </div>

        {status === ApprovalStatus.PENDING && (
          <ul className="mt-4 space-y-1.5 text-sm">
            <ChecklistItem done={requirements.profile} label="Business profile" />
            <ChecklistItem done={requirements.bankDetail} label="Bank details" />
            <ChecklistItem done={requirements.identityDocument} label="PAN or Aadhaar document (not rejected)" />
            <li className="pt-1 text-xs text-gray-500">
              {summary.isComplete
                ? 'Ready for review. Whether it can be approved is decided by the server.'
                : 'Approval is available once the application is complete.'}
            </li>
          </ul>
        )}
        {status === ApprovalStatus.APPROVED && (
          <p className="mt-3 text-sm text-gray-600">Approved. An approval is final.</p>
        )}
        {status === ApprovalStatus.REJECTED && (
          <p className="mt-3 text-sm text-gray-600">
            Rejected. It comes back for review only when the seller resubmits its application.
          </p>
        )}
        {summary.lastRejectionReason && (
          <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm">
            <p className="font-medium text-gray-800">
              {status === ApprovalStatus.REJECTED ? 'Rejection reason' : 'Previous rejection'}
              {summary.lastRejectedAt ? ` · ${formatSellerDate(summary.lastRejectedAt)}` : ''}
            </p>
            <p className="mt-0.5 text-gray-600">{summary.lastRejectionReason}</p>
          </div>
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------------- profile */}
        <Panel
          title="Business profile"
          action={
            perms.canManage && (
              <Button variant="secondary" onClick={() => setProfileOpen(true)}>
                <Icon name="edit" className="h-4 w-4" />
                {profile ? 'Edit Profile' : 'Add Profile'}
              </Button>
            )
          }
        >
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
            <EmptyState title="No business profile yet" hint="Required before the application can be approved." />
          )}
        </Panel>

        {/* ---------------------------------------------------------- bank */}
        <Panel
          title="Bank details"
          action={
            <div className="flex flex-wrap gap-2">
              {perms.canVerifyBank && bankDetail && !bankDetail.isVerified && (
                <Button variant="soft" onClick={() => setVerifyOpen(true)}>
                  Verify Bank
                </Button>
              )}
              {perms.canManage && (
                <Button variant="secondary" onClick={() => setBankOpen(true)}>
                  <Icon name="edit" className="h-4 w-4" />
                  {bankDetail ? 'Edit Bank Details' : 'Add Bank Details'}
                </Button>
              )}
            </div>
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
            <EmptyState title="No bank details yet" hint="Required before the application can be approved." />
          )}
        </Panel>
      </div>
      </>
      )}

      {/* ------------------------------------------------------- documents */}
      <Panel
        title="Documents"
        bodyClass=""
        action={
          perms.canManage && (
            <Button variant="secondary" onClick={() => setAddDocOpen(true)}>
              <Icon name="plus" className="h-4 w-4" />
              Add Document
            </Button>
          )
        }
      >
        <p className="px-5 pb-3 text-xs text-gray-500">
          Documents are uploaded as PDFs and kept private. Numbers are hidden until you choose Show; opening a PDF or
          showing a number is recorded in the audit log.
        </p>
        {documents.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No documents yet" hint="A PAN or Aadhaar document is required for approval." />
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

      {profileOpen && (
        <ProfileModal
          seller={seller}
          profile={profile}
          onClose={() => setProfileOpen(false)}
          onSaved={() => {
            setProfileOpen(false);
            onNotice('Business profile saved.');
          }}
        />
      )}
      {bankOpen && (
        <BankModal
          sellerId={seller.id}
          bank={bankDetail}
          onClose={() => setBankOpen(false)}
          onSaved={() => {
            setBankOpen(false);
            onNotice('Bank details saved. The account is not verified until it is verified again.');
          }}
        />
      )}
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
      {addDocOpen && (
        <AddDocumentModal
          sellerId={seller.id}
          onClose={() => setAddDocOpen(false)}
          onSaved={(label) => {
            setAddDocOpen(false);
            onNotice(`${label} added — pending review.`);
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
      {decision && (
        <OnboardingDecisionModal
          seller={seller}
          action={decision}
          onClose={() => setDecision(null)}
          onDone={(message) => {
            setDecision(null);
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
/* profile                                                                     */
/* -------------------------------------------------------------------------- */

interface ProfileForm {
  businessName: string;
  businessType: string;
  ownerFullName: string;
  ownerMobile: string;
  ownerEmail: string;
  gstNumber: string;
  fssaiNumber: string;
}

function ProfileModal({
  seller,
  profile,
  onClose,
  onSaved,
}: {
  seller: AdminSellerDetailDto;
  /** The MASKED profile from the onboarding summary. */
  profile: SellerProfileDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const save = useUpsertSellerProfile(seller.id);
  const owner = seller.staff.find((member) => member.role === SellerStaffRole.OWNER);
  const [form, setForm] = useState<ProfileForm>({
    businessName: profile?.businessName ?? seller.name,
    businessType: profile?.businessType ?? '',
    ownerFullName: profile?.ownerFullName ?? owner?.fullName ?? '',
    ownerMobile: profile?.ownerMobile ?? owner?.mobile ?? '',
    ownerEmail: profile?.ownerEmail ?? '',
    gstNumber: profile?.gstNumber ?? '',
    fssaiNumber: profile?.fssaiNumber ?? '',
  });
  // PAN / Aadhaar: never prefilled (only masked values exist) and never in
  // state — blank keeps what is stored (backend keep-on-omit).
  const panRef = useRef<HTMLInputElement>(null);
  const aadhaarRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof ProfileForm | 'panNumber' | 'aadhaarNumber', string>>>({});

  const set = (key: keyof ProfileForm) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  /** Same limits as profileSchema (seller-onboarding.validation.ts). */
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const next: typeof errors = {};
    const businessName = form.businessName.trim();
    if (businessName.length < 2 || businessName.length > 160) next.businessName = 'Business name must be 2–160 characters.';
    const businessType = form.businessType.trim();
    if (businessType.length > 80) next.businessType = 'At most 80 characters.';
    const ownerFullName = form.ownerFullName.trim();
    if (ownerFullName.length < 2 || ownerFullName.length > 120) next.ownerFullName = "Owner's name must be 2–120 characters.";
    const ownerMobile = form.ownerMobile.trim();
    if (!normalizeIndianMobile(ownerMobile) || ownerMobile.length > 15) next.ownerMobile = 'Enter a valid 10-digit Indian mobile number.';
    const ownerEmail = form.ownerEmail.trim();
    if (ownerEmail && (!EMAIL_PATTERN.test(ownerEmail) || ownerEmail.length > 160)) next.ownerEmail = 'Enter a valid email.';
    const gstNumber = form.gstNumber.trim();
    if (gstNumber.length > 20) next.gstNumber = 'At most 20 characters.';
    const fssaiNumber = form.fssaiNumber.trim();
    if (fssaiNumber.length > 20) next.fssaiNumber = 'At most 20 characters.';
    const pan = panRef.current?.value.trim() ?? '';
    if (pan.length > 20) next.panNumber = 'At most 20 characters.';
    const aadhaar = aadhaarRef.current?.value.trim() ?? '';
    if (aadhaar.length > 20) next.aadhaarNumber = 'At most 20 characters.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: UpsertSellerProfileRequest = {
      businessName,
      businessType: businessType || null,
      ownerFullName,
      ownerMobile,
      ownerEmail: ownerEmail || null,
      gstNumber: gstNumber || null,
      fssaiNumber: fssaiNumber || null,
      ...(pan ? { panNumber: pan } : {}),
      ...(aadhaar ? { aadhaarNumber: aadhaar } : {}),
    };
    save.mutate(body, {
      onSuccess: () => {
        if (panRef.current) panRef.current.value = '';
        if (aadhaarRef.current) aadhaarRef.current.value = '';
        onSaved();
      },
    });
  };

  const text = (key: keyof ProfileForm, props: { inputMode?: 'tel' | 'email'; type?: string } = {}) => (
    <>
      <input
        value={form[key]}
        onChange={(event) => set(key)(event.target.value)}
        className={inputClass}
        aria-invalid={errors[key] ? true : undefined}
        {...props}
      />
      <FieldError message={errors[key]} />
    </>
  );

  return (
    <Modal
      title={profile ? 'Edit business profile' : 'Add business profile'}
      subtitle="Onboarding data the seller supplied. Saving does not change the seller's status or type."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save profile'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate autoComplete="off">
        {save.isError && <ErrorBanner message={sellerErrorMessage(save.error, 'Could not save the profile.')} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" required>
            {text('businessName')}
          </Field>
          <Field label="Business type" hint="Optional">
            {text('businessType')}
          </Field>
          <Field label="Owner's full name" required>
            {text('ownerFullName')}
          </Field>
          <Field label="Owner's mobile" required>
            {text('ownerMobile', { inputMode: 'tel' })}
          </Field>
          <Field label="Owner's email" hint="Optional">
            {text('ownerEmail', { inputMode: 'email', type: 'email' })}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="PAN"
            hint={profile?.panNumber ? `Leave blank to keep the current one (${profile.panNumber}).` : 'Optional.'}
          >
            <input ref={panRef} type="password" autoComplete="off" className={inputClass} />
            <FieldError message={errors.panNumber} />
          </Field>
          <Field
            label="Aadhaar"
            hint={profile?.aadhaarNumber ? `Leave blank to keep the current one (${profile.aadhaarNumber}).` : 'Optional.'}
          >
            <input ref={aadhaarRef} type="password" autoComplete="off" inputMode="numeric" className={inputClass} />
            <FieldError message={errors.aadhaarNumber} />
          </Field>
          <Field label="GST number" hint="Optional">
            {text('gstNumber')}
          </Field>
          <Field label="FSSAI number" hint="Optional — food sellers">
            {text('fssaiNumber')}
          </Field>
        </div>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* bank                                                                        */
/* -------------------------------------------------------------------------- */

function BankModal({
  sellerId,
  bank,
  onClose,
  onSaved,
}: {
  sellerId: string;
  /** The MASKED bank detail from the onboarding summary (null = none yet). */
  bank: SellerBankDetailDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const save = useUpsertSellerBankDetail(sellerId);
  const [holder, setHolder] = useState(bank?.accountHolderName ?? '');
  const [ifsc, setIfsc] = useState(bank?.ifscCode ?? '');
  const [bankName, setBankName] = useState(bank?.bankName ?? '');
  // The account number is never prefilled, never in state: read on submit.
  const accountRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** Same limits as bankDetailSchema + upsertBankDetail. */
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const next: Record<string, string> = {};
    const accountHolderName = holder.trim();
    if (accountHolderName.length < 2 || accountHolderName.length > 120) next.holder = 'Account holder must be 2–120 characters.';
    const accountNumber = accountRef.current?.value.trim() ?? '';
    if (!/^\d{6,20}$/.test(accountNumber)) next.account = 'Enter a valid account number (6–20 digits).';
    else if ((confirmRef.current?.value.trim() ?? '') !== accountNumber) next.confirm = 'The account numbers do not match.';
    const ifscCode = ifsc.trim().toUpperCase();
    if (!IFSC_PATTERN.test(ifscCode)) next.ifsc = 'Enter a valid 11-character IFSC code.';
    const name = bankName.trim();
    if (name.length > 120) next.bankName = 'At most 120 characters.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    save.mutate(
      { accountHolderName, accountNumber, ifscCode, bankName: name || null },
      {
        onSuccess: () => {
          if (accountRef.current) accountRef.current.value = '';
          if (confirmRef.current) confirmRef.current.value = '';
          onSaved();
        },
      },
    );
  };

  return (
    <Modal
      title={bank ? 'Edit bank details' : 'Add bank details'}
      subtitle="Saving always leaves the account NOT verified until it is verified again."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save bank details'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate autoComplete="off">
        {save.isError && <ErrorBanner message={sellerErrorMessage(save.error, 'Could not save the bank details.')} />}
        <Field label="Account holder name" required>
          <input value={holder} onChange={(e) => setHolder(e.target.value)} className={inputClass} />
          <FieldError message={errors['holder']} />
        </Field>
        <Field label="Account number" required hint={bank ? `Currently ${bank.accountNumber}. Enter the full number to change it.` : undefined}>
          <input ref={accountRef} type="password" autoComplete="off" inputMode="numeric" className={inputClass} />
          <FieldError message={errors['account']} />
        </Field>
        <Field label="Re-enter account number" required>
          <input ref={confirmRef} type="password" autoComplete="off" inputMode="numeric" className={inputClass} />
          <FieldError message={errors['confirm']} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="IFSC" required>
            <input value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} maxLength={11} className={inputClass} />
            <FieldError message={errors['ifsc']} />
          </Field>
          <Field label="Bank name" hint="Optional">
            <input value={bankName} onChange={(e) => setBankName(e.target.value)} className={inputClass} />
            <FieldError message={errors['bankName']} />
          </Field>
        </div>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/**
 * Verification of EXACTLY the account shown here: its id and version are
 * captured when this dialog opens and sent unchanged. If the seller (or
 * anyone) saved the account since, the server answers 409 and nothing is
 * verified; the data is re-read and the admin must review it again.
 */
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

function AddDocumentModal({
  sellerId,
  onClose,
  onSaved,
}: {
  sellerId: string;
  onClose: () => void;
  onSaved: (label: string) => void;
}) {
  const add = useAddSellerDocument(sellerId);
  const [value, setValue] = useState<DocumentUploadValue>({ type: '', documentNumber: '', file: null });
  const [expiresOn, setExpiresOn] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'type' | 'documentNumber' | 'file' | 'expiresOn', string>>>({});

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const next: Partial<Record<'type' | 'documentNumber' | 'file' | 'expiresOn', string>> = validateDocumentUpload(value);
    if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) next.expiresOn = 'Use a valid date.';
    setErrors(next);
    if (Object.keys(next).length > 0 || !value.file) return;

    add.mutate(
      {
        type: value.type as SellerDocumentType,
        documentNumber: value.documentNumber.trim() || null,
        file: value.file,
        ...(expiresOn ? { expiresAt: `${expiresOn}T00:00:00.000Z` } : {}),
      },
      { onSuccess: () => onSaved(DOCUMENT_TYPE_LABEL[value.type] ?? 'Document') },
    );
  };

  return (
    <Modal
      title="Add document"
      subtitle="Upload the PDF the seller supplied. It starts as pending review."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={add.isPending}>
            {add.isPending ? 'Uploading…' : 'Upload document'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate autoComplete="off">
        {add.isError && <ErrorBanner message={sellerErrorMessage(add.error, 'Could not upload the document.')} />}
        <DocumentUploadFields value={value} onChange={setValue} errors={errors} />
        <Field label="Expiry date" hint="Optional — licences that need renewal">
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className={inputClass} />
          <FieldError message={errors.expiresOn} />
        </Field>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

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

/* -------------------------------------------------------------------------- */
/* onboarding decision                                                         */
/* -------------------------------------------------------------------------- */

function OnboardingDecisionModal({
  seller,
  action,
  onClose,
  onDone,
}: {
  seller: AdminSellerDetailDto;
  action: 'APPROVE' | 'REJECT';
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const review = useReviewSellerOnboarding(seller.id);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rejecting = action === 'REJECT';

  const confirm = () => {
    const trimmed = reason.trim();
    if (rejecting && !trimmed) {
      setError('A reason is required to reject the application.');
      return;
    }
    setError(null);
    review.mutate(
      rejecting ? { status: ApprovalStatus.REJECTED, reason: trimmed } : { status: ApprovalStatus.APPROVED },
      {
        onSuccess: () =>
          onDone(
            rejecting
              ? `${seller.name}'s application was rejected.`
              : `${seller.name} is approved. It can take orders while its admin switch and its own switch are on.`,
          ),
      },
    );
  };

  return (
    <Modal
      title={rejecting ? 'Reject application' : 'Approve application'}
      subtitle={seller.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={review.isPending}>
            Cancel
          </Button>
          <Button variant={rejecting ? 'danger' : 'primary'} onClick={confirm} disabled={review.isPending}>
            {review.isPending ? 'Saving…' : rejecting ? 'Reject application' : 'Approve'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {review.isError && <ErrorBanner message={sellerErrorMessage(review.error, 'Could not record the decision.')} />}
        <p className="text-sm text-gray-600">
          {rejecting
            ? 'The seller is told the reason. The application comes back for review only when the seller resubmits it.'
            : 'Approval is final — it cannot be undone from the panel. The seller can then be switched off with the admin switch if needed.'}
        </p>
        {rejecting && (
          <Field label="Reason" required hint={`${reason.trim().length}/${ONBOARDING_REASON_MAX}`}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, ONBOARDING_REASON_MAX))}
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
