/**
 * Seller profile — onboarding status, business information, address, bank
 * details, documents and (restaurants only) restaurant details.
 *
 * Every read is GET /seller/onboarding, which the server scopes to the
 * signed-in seller and returns with PAN, Aadhaar and the bank account number
 * already masked. Writes use only the existing seller onboarding APIs:
 * PUT /seller/onboarding/bank-detail and PUT /seller/onboarding/restaurant-profile.
 * The store address and map point are the seller's own to set
 * (GET/PATCH /seller/location — StoreLocationPanel).
 *
 * Documents: the seller uploads PDFs (POST /seller/onboarding/documents,
 * multipart) and opens its own (GET …/documents/:id/file); numbers are shown
 * masked.
 *
 * Deliberately read-only here, because the V2 seller API does not support it:
 *   - business information: PUT /onboarding/profile replaces EVERY field,
 *     while PAN/Aadhaar only ever come back masked — an edit form would erase
 *     or corrupt them;
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  ErrorBanner,
  Field,
  Modal,
  Panel,
  Pill,
  Toggle,
  inputClass,
  type Tone,
} from '@/components/ui';
import {
  IFSC_PATTERN,
  sellerApi,
  sellerErrorMessage,
  toSellerOnboarding,
  type SellerBankDetailInput,
  type SellerOnboarding,
  type SellerRestaurantProfileInput,
} from '../sellerApi';
import { sellerKeys } from '../sellerQueries';
import { useSellerAuth } from '../sellerAuth';
import { CheckState, SkeletonBlock } from '../sellerUi';
import StoreLocationPanel from '../StoreLocationPanel';
import {
  DOCUMENT_TYPE_LABEL,
  DocumentNumber,
  DocumentUploadFields,
  ViewPdfButton,
  formatFileSize,
  validateDocumentUpload,
  type DocumentUploadValue,
} from '@/components/SellerDocuments';
import { documentFormData } from '@/lib/sellers';
import type { SellerDocumentType } from '@shared';

/**
 * Sign-in & password: change the password Aadione issued (POST
 * /auth/change-password). Signing in elsewhere ends on a change; this device
 * stays signed in.
 */
export function PasswordPanel() {
  const password = useSellerAuth((state) => state.password);
  const changePassword = useSellerAuth((state) => state.changePassword);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!password?.hasPassword) {
    return (
      <Panel title="Sign-in & Password">
        <Note>
          You sign in with a mobile OTP. To sign in with an email and password instead, ask Aadione to issue your seller login.
        </Note>
      </Panel>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(sellerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Sign-in & Password"
      action={password.passwordChangeRequired ? <Pill tone="amber">Temporary password</Pill> : undefined}
    >
      <form id="password" onSubmit={(event) => void submit(event)} className="max-w-md space-y-4">
        <Note>
          {password.passwordChangeRequired
            ? 'You are signed in with the temporary password Aadione gave you. Choose your own password now.'
            : 'Change the password you use to sign in to the Seller Panel.'}
        </Note>
        <ErrorBanner message={error} />
        {done && (
          <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-600">
            Password changed. Any other device signed in to your account has been signed out.
          </div>
        )}
        <Field label="Current password">
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} autoComplete="current-password" required />
        </Field>
        <Field label="New password" hint="At least 8 characters, with a letter and a number.">
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} autoComplete="new-password" minLength={8} required />
        </Field>
        <Field label="Confirm new password">
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} autoComplete="new-password" required />
        </Field>
        <Button type="submit" disabled={busy || !current || next.length < 8 || !confirm}>
          {busy ? 'Changing…' : 'Change Password'}
        </Button>
      </form>
    </Panel>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'brand' },
  REJECTED: { label: 'Rejected', tone: 'red' },
};

const DOCUMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'amber' },
  VERIFIED: { label: 'Approved', tone: 'brand' },
  REJECTED: { label: 'Rejected', tone: 'red' },
};

type CheckStateValue = 'complete' | 'pending' | 'attention';

/**
 * Account checklist — one line per area, from the onboarding record alone:
 * Complete / Pending / Needs attention, and what to do about it.
 */
function Checklist({ data, onAddBank, onEditRestaurant }: { data: SellerOnboarding; onAddBank: () => void; onEditRestaurant: () => void }) {
  const docs = data.documents;
  const restaurantDone = data.restaurantProfile !== null && data.restaurantProfile.cuisine.length > 0 && data.restaurantProfile.avgPrepMins !== null;
  const items: { label: string; state: CheckStateValue; detail: string; action?: { label: string; onClick: () => void } }[] = [
    {
      label: 'Onboarding',
      state: data.stage === 'APPROVED' ? 'complete' : data.stage === 'REJECTED' ? 'attention' : 'pending',
      detail:
        data.stage === 'APPROVED'
          ? 'Approved by Aadione.'
          : data.stage === 'REJECTED'
            ? 'Not approved — please contact Aadione support.'
            : data.stage === 'SUBMITTED'
              ? 'Waiting for review by Aadione.'
              : 'Some details are still missing.',
    },
    {
      label: 'Business details',
      state: data.profile ? 'complete' : 'attention',
      detail: data.profile ? 'Business name, owner and tax details on file.' : 'Not added yet — please contact Aadione.',
    },
    {
      label: 'Bank account',
      state: !data.bankDetail ? 'attention' : data.bankDetail.isVerified ? 'complete' : 'pending',
      detail: !data.bankDetail ? 'Add the account your settlements are paid into.' : data.bankDetail.isVerified ? 'Verified.' : 'Waiting for Aadione to verify it.',
      ...(!data.bankDetail ? { action: { label: 'Add bank details', onClick: onAddBank } } : {}),
    },
    {
      label: 'Documents',
      state: docs.length === 0 || docs.some((d) => d.status === 'REJECTED') ? 'attention' : docs.every((d) => d.status === 'VERIFIED') ? 'complete' : 'pending',
      detail:
        docs.length === 0
          ? 'No documents submitted yet — please send them to Aadione.'
          : docs.some((d) => d.status === 'REJECTED')
            ? 'A document was rejected — see Documents below.'
            : docs.every((d) => d.status === 'VERIFIED')
              ? `${docs.length} verified.`
              : 'Waiting for Aadione to verify.',
    },
    ...(data.restaurantProfile
      ? [
          {
            label: 'Restaurant profile',
            state: (restaurantDone ? 'complete' : 'attention') as CheckStateValue,
            detail: restaurantDone ? 'Cuisines and preparation time set.' : 'Add your cuisines and average preparation time.',
            ...(restaurantDone ? {} : { action: { label: 'Complete it', onClick: onEditRestaurant } }),
          },
        ]
      : []),
  ];
  return (
    <Panel title="Account status">
      <ul className="divide-y divide-gray-100">
        {items.map((item) => (
          <li key={item.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900">{item.label}</p>
              <p className="text-xs text-gray-500">{item.detail}</p>
            </div>
            <div className="flex items-center gap-2">
              {item.action && (
                <button
                  type="button"
                  onClick={item.action.onClick}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  {item.action.label}
                </button>
              )}
              <CheckState state={item.state} />
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2.5">
      <dt className="text-sm text-gray-500">{label}</dt>
      <dd className="text-sm font-medium text-gray-900">{value ? value : '—'}</dd>
    </div>
  );
}

export function Note({ children }: { children: string }) {
  return <p className="text-sm text-gray-500">{children}</p>;
}

export default function SellerProfilePage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<'bank' | 'restaurant' | null>(null);
  const [uploading, setUploading] = useState(false);

  const onboarding = useQuery({
    queryKey: sellerKeys.onboarding,
    queryFn: () => sellerApi.get<SellerOnboarding>('/seller/onboarding').then(toSellerOnboarding),
  });

  /** Both PUTs answer with the full (masked) onboarding record. */
  const save = useMutation({
    mutationFn: (input: { path: string; body: unknown; done: string }) =>
      sellerApi.put<SellerOnboarding>(input.path, input.body).then(toSellerOnboarding),
    onSuccess: (data, input) => {
      queryClient.setQueryData(sellerKeys.onboarding, data);
      setEditing(null);
      setNotice(input.done);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: sellerKeys.onboarding }),
  });

  if (onboarding.isPending) return <SkeletonBlock lines={6} label="Loading your profile…" />;
  if (onboarding.isError) return <ErrorBanner message={sellerErrorMessage(onboarding.error)} />;

  const data = onboarding.data;
  const status = STATUS[data.onboardingStatus] ?? { label: data.onboardingStatus, tone: 'gray' as Tone };
  const serverError = save.isError ? sellerErrorMessage(save.error) : null;

  const statusText =
    data.stage === 'APPROVED'
      ? 'Your seller account is approved by Aadione.'
      : data.stage === 'REJECTED'
        ? 'Aadione did not approve your application. The reason is not shown in the Seller Panel yet — please contact Aadione support.'
        : data.stage === 'SUBMITTED'
          ? 'Your details are complete and waiting for review by Aadione.'
          : 'Your details are incomplete. Aadione needs your business details, bank details and a PAN or Aadhaar document.';

  return (
    <div className="space-y-5">
      {notice && (
        <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-600">
          {notice}
        </div>
      )}

      <Checklist
        data={data}
        onAddBank={() => { save.reset(); setNotice(null); setEditing('bank'); }}
        onEditRestaurant={() => { save.reset(); setNotice(null); setEditing('restaurant'); }}
      />

      <PasswordPanel />

      {/* 1. Onboarding status */}
      <Panel title="Onboarding Status" action={<Pill tone={status.tone}>{status.label}</Pill>}>
        <Note>{statusText}</Note>
      </Panel>

      {/* 2. Business information (read-only) */}
      <Panel title="Business Information">
        {data.profile ? (
          <>
            <dl className="divide-y divide-gray-100">
              <Row label="Store name" value={data.sellerName} />
              <Row label="Business name" value={data.profile.businessName} />
              <Row label="Business type" value={data.profile.businessType} />
              <Row label="Contact name" value={data.profile.ownerFullName} />
              <Row label="Mobile number" value={data.profile.ownerMobile} />
              <Row label="Email" value={data.profile.ownerEmail} />
              <Row label="PAN" value={data.profile.panNumber} />
              <Row label="Aadhaar" value={data.profile.aadhaarNumber} />
              <Row label="GST number" value={data.profile.gstNumber} />
              <Row label="FSSAI number" value={data.profile.fssaiNumber} />
            </dl>
            <div className="mt-3">
              <Note>To change these details, please contact Aadione.</Note>
            </div>
          </>
        ) : (
          <>
            <dl className="divide-y divide-gray-100">
              <Row label="Store name" value={data.sellerName} />
            </dl>
            <div className="mt-3">
              <Note>Your business details have not been added yet. Please contact Aadione to add them.</Note>
            </div>
          </>
        )}
      </Panel>

      {/* 3. Store address + map point — the seller's own */}
      <StoreLocationPanel onSaved={setNotice} />

      {/* 4. Bank details */}
      <Panel
        title="Bank Details"
        action={
          <Button variant="secondary" onClick={() => { save.reset(); setNotice(null); setEditing('bank'); }}>
            {data.bankDetail ? 'Edit Bank Details' : 'Add Bank Details'}
          </Button>
        }
      >
        {data.bankDetail ? (
          <dl className="divide-y divide-gray-100">
            <Row label="Account holder" value={data.bankDetail.accountHolderName} />
            <Row label="Bank" value={data.bankDetail.bankName} />
            {/* Masked by the server — only the last 4 digits are real. */}
            <Row label="Account number" value={data.bankDetail.accountNumber} />
            <Row label="IFSC" value={data.bankDetail.ifscCode} />
            <div className="flex justify-between py-2.5">
              <dt className="text-sm text-gray-500">Status</dt>
              <dd>
                <Pill tone={data.bankDetail.isVerified ? 'brand' : 'amber'}>
                  {data.bankDetail.isVerified ? 'Verified' : 'Not verified yet'}
                </Pill>
              </dd>
            </div>
          </dl>
        ) : (
          <Note>No bank details added yet. Settlements are paid into this account.</Note>
        )}
      </Panel>

      {/* 5. Documents — upload PDFs, see status; numbers masked */}
      <Panel
        title="Documents"
        action={
          <Button variant="secondary" onClick={() => { setNotice(null); setUploading(true); }}>
            Upload document
          </Button>
        }
      >
        {data.documents.length === 0 ? (
          <Note>No documents uploaded yet. A PAN or Aadhaar document is required for approval.</Note>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.documents.map((document) => {
              const docStatus = DOCUMENT_STATUS[document.status] ?? { label: document.status, tone: 'gray' as Tone };
              return (
                <li key={document.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-gray-900">
                      {DOCUMENT_TYPE_LABEL[document.type] ?? document.type}
                    </span>
                    <Pill tone={docStatus.tone}>{docStatus.label}</Pill>
                  </div>
                  <p className="text-sm text-gray-700">
                    <span className="text-gray-500">Number: </span>
                    <DocumentNumber masked={document.documentNumberMasked} />
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-700">
                    <span className="min-w-0 truncate">
                      <span className="text-gray-500">File: </span>
                      {document.hasFile
                        ? `${document.fileName ?? 'document.pdf'}${document.fileSizeBytes ? ` · ${formatFileSize(document.fileSizeBytes)}` : ''}`
                        : document.legacyLink
                          ? 'Sent earlier as a link — please upload the PDF'
                          : 'No file'}
                    </span>
                    {document.hasFile && (
                      <ViewPdfButton load={() => sellerApi.getBlob(`/seller/onboarding/documents/${document.id}/file`)} />
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    Submitted {formatDate(document.createdAt)}
                    {document.expiresAt && ` · Expires ${formatDate(document.expiresAt)}`}
                  </p>
                  {document.status === 'REJECTED' && (
                    <p className="text-sm text-danger-600">
                      Rejected{document.rejectionReason ? `: ${document.rejectionReason}` : ''} — upload a new PDF to replace it.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3">
          <Note>PDF only, up to 10 MB. To replace a document, upload a new one of the same type — Aadione reviews the latest.</Note>
        </div>
      </Panel>

      {uploading && (
        <UploadDocumentModal
          onClose={() => setUploading(false)}
          onDone={(label) => {
            setUploading(false);
            setNotice(`${label} uploaded. Aadione will review it.`);
            void queryClient.invalidateQueries({ queryKey: sellerKeys.onboarding });
          }}
        />
      )}

      {/* 6. Restaurant details — a restaurant profile only exists for restaurant sellers */}
      {data.restaurantProfile && (
        <Panel
          title="Restaurant Details"
          action={
            <Button variant="secondary" onClick={() => { save.reset(); setNotice(null); setEditing('restaurant'); }}>
              Edit
            </Button>
          }
        >
          <dl className="divide-y divide-gray-100">
            <div className="flex flex-wrap justify-between gap-2 py-2.5">
              <dt className="text-sm text-gray-500">Cuisines</dt>
              <dd className="flex flex-wrap justify-end gap-1.5">
                {data.restaurantProfile.cuisine.length > 0
                  ? data.restaurantProfile.cuisine.map((c) => <Pill key={c}>{c}</Pill>)
                  : <span className="text-sm font-medium text-gray-900">—</span>}
              </dd>
            </div>
            <Row label="Vegetarian only" value={data.restaurantProfile.isVegOnly ? 'Yes' : 'No'} />
            <Row
              label="Average preparation time"
              value={data.restaurantProfile.avgPrepMins ? `${data.restaurantProfile.avgPrepMins} min` : null}
            />
          </dl>
        </Panel>
      )}

      {editing === 'bank' && (
        <BankDetailsModal
          hasExisting={data.bankDetail !== null}
          initialHolder={data.bankDetail?.accountHolderName ?? ''}
          initialBank={data.bankDetail?.bankName ?? ''}
          initialIfsc={data.bankDetail?.ifscCode ?? ''}
          saving={save.isPending}
          serverError={serverError}
          onClose={() => setEditing(null)}
          onSave={(body) => save.mutate({ path: '/seller/onboarding/bank-detail', body, done: 'Bank details saved. Aadione will verify them.' })}
        />
      )}

      {editing === 'restaurant' && data.restaurantProfile && (
        <RestaurantModal
          initial={data.restaurantProfile}
          saving={save.isPending}
          serverError={serverError}
          onClose={() => setEditing(null)}
          onSave={(body) => save.mutate({ path: '/seller/onboarding/restaurant-profile', body, done: 'Restaurant details saved.' })}
        />
      )}
    </div>
  );
}

/**
 * The account number is typed fresh (twice) every time: the current one only
 * ever arrives masked, and it lives in this dialog's state alone — never in
 * the query cache, a URL, browser storage or a log.
 */
export function BankDetailsModal({
  hasExisting,
  initialHolder,
  initialBank,
  initialIfsc,
  saving,
  serverError,
  onClose,
  onSave,
}: {
  hasExisting: boolean;
  initialHolder: string;
  initialBank: string;
  initialIfsc: string;
  saving: boolean;
  serverError: string | null;
  onClose: () => void;
  onSave: (body: SellerBankDetailInput) => void;
}) {
  const [holder, setHolder] = useState(initialHolder);
  const [bankName, setBankName] = useState(initialBank);
  const [account, setAccount] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ifsc, setIfsc] = useState(initialIfsc);
  const [problem, setProblem] = useState<string | null>(null);

  function submit(): void {
    const accountHolderName = holder.trim();
    const accountNumber = account.trim();
    const ifscCode = ifsc.trim().toUpperCase();
    if (accountHolderName.length < 2) return setProblem('Enter the account holder name.');
    if (!/^\d{6,20}$/.test(accountNumber)) return setProblem('Enter a valid account number (6–20 digits).');
    if (accountNumber !== confirm.trim()) return setProblem('The account numbers do not match.');
    if (!IFSC_PATTERN.test(ifscCode)) return setProblem('Enter a valid 11-character IFSC code (e.g. SBIN0001234).');
    setProblem(null);
    onSave({ accountHolderName, accountNumber, ifscCode, bankName: bankName.trim() || null });
  }

  return (
    <Modal
      title={hasExisting ? 'Edit Bank Details' : 'Add Bank Details'}
      subtitle="Your settlements are paid into this account."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={submit}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }} autoComplete="off">
        <ErrorBanner message={problem ?? serverError} />
        {hasExisting && (
          <p className="rounded-xl bg-warn-50 px-3.5 py-2.5 text-sm text-warn-500">
            Saving new bank details marks them unverified until Aadione verifies them again.
          </p>
        )}
        <Field label="Account holder name" required>
          <input value={holder} maxLength={120} onChange={(e) => setHolder(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Bank name">
          <input value={bankName} maxLength={120} onChange={(e) => setBankName(e.target.value)} className={inputClass} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account number" required>
            <input
              value={account}
              inputMode="numeric"
              maxLength={20}
              autoComplete="off"
              onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))}
              className={inputClass}
            />
          </Field>
          <Field label="Confirm account number" required>
            <input
              value={confirm}
              inputMode="numeric"
              maxLength={20}
              autoComplete="off"
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="IFSC code" required>
          <input
            value={ifsc}
            maxLength={11}
            onChange={(e) => setIfsc(e.target.value.toUpperCase())}
            className={inputClass}
            placeholder="SBIN0001234"
          />
        </Field>
      </form>
    </Modal>
  );
}

export function RestaurantModal({
  initial,
  saving,
  serverError,
  onClose,
  onSave,
}: {
  initial: { cuisine: string[]; isVegOnly: boolean; avgPrepMins: number | null };
  saving: boolean;
  serverError: string | null;
  onClose: () => void;
  onSave: (body: SellerRestaurantProfileInput) => void;
}) {
  const [cuisines, setCuisines] = useState(initial.cuisine.join(', '));
  const [vegOnly, setVegOnly] = useState(initial.isVegOnly);
  const [prep, setPrep] = useState(initial.avgPrepMins?.toString() ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(): void {
    const cuisine = cuisines.split(',').map((c) => c.trim()).filter(Boolean);
    if (cuisine.length > 20) return setProblem('Add at most 20 cuisines.');
    if (cuisine.some((c) => c.length > 40)) return setProblem('Each cuisine can be at most 40 characters.');
    let avgPrepMins: number | null = null;
    if (prep.trim()) {
      avgPrepMins = Number(prep);
      if (!Number.isInteger(avgPrepMins) || avgPrepMins < 1 || avgPrepMins > 240) {
        return setProblem('Preparation time must be a whole number of minutes, 1–240.');
      }
    }
    setProblem(null);
    onSave({ cuisine, isVegOnly: vegOnly, avgPrepMins });
  }

  return (
    <Modal
      title="Edit Restaurant Details"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={submit}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={problem ?? serverError} />
        <Field label="Cuisines" hint="Separate with commas, e.g. North Indian, Mughlai">
          <input value={cuisines} onChange={(e) => setCuisines(e.target.value)} className={inputClass} />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-gray-700">Vegetarian only</span>
          <Toggle checked={vegOnly} label="Vegetarian only" onChange={setVegOnly} />
        </div>
        <Field label="Average preparation time (minutes)" hint="Leave empty if not set.">
          <input value={prep} inputMode="numeric" onChange={(e) => setPrep(e.target.value.replace(/\D/g, ''))} className={inputClass} />
        </Field>
      </div>
    </Modal>
  );
}

/** POST /seller/onboarding/documents — multipart: type, number and the PDF. */
export function UploadDocumentModal({ onClose, onDone }: { onClose: () => void; onDone: (label: string) => void }) {
  const [value, setValue] = useState<DocumentUploadValue>({ type: '', documentNumber: '', file: null });
  const [errors, setErrors] = useState<Partial<Record<'type' | 'documentNumber' | 'file', string>>>({});
  const upload = useMutation({
    mutationFn: (file: File) =>
      sellerApi.postForm('/seller/onboarding/documents', documentFormData({
        type: value.type as SellerDocumentType,
        documentNumber: value.documentNumber.trim() || null,
        file,
      })),
    onSuccess: () => onDone(DOCUMENT_TYPE_LABEL[value.type] ?? 'Document'),
  });

  function submit(): void {
    const next = validateDocumentUpload(value);
    setErrors(next);
    if (Object.keys(next).length > 0 || !value.file) return;
    upload.mutate(value.file);
  }

  return (
    <Modal
      title="Upload document"
      subtitle="Upload a clear PDF of the document and enter the number printed on it."
      onClose={() => {
        if (!upload.isPending) onClose();
      }}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button variant="secondary" onClick={onClose} disabled={upload.isPending} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button onClick={submit} disabled={upload.isPending} className="w-full sm:w-auto">
            {upload.isPending ? 'Uploading…' : 'Upload document'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {upload.isError && <ErrorBanner message={sellerErrorMessage(upload.error)} />}
        <DocumentUploadFields value={value} onChange={setValue} errors={errors} />
      </div>
    </Modal>
  );
}
