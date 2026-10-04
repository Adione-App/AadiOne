/**
 * The seller's restricted experience until both onboarding gates are passed
 * — shown by SellerApp INSTEAD of the Seller Panel whenever the lifecycle
 * (GET /seller/lifecycle) is not ACTIVE:
 *
 *   APPLICATION_PENDING         "Seller Application Pending"
 *   APPLICATION_REJECTED        application not approved (+ reason)
 *   ONBOARDING_PENDING          "Complete Your Seller Onboarding" (editable)
 *   ONBOARDING_CHANGES_REQUIRED "Changes Required" (+ reason, editable)
 *   ONBOARDING_PENDING_REVIEW   "Verification in Progress" (read-only)
 *   ONBOARDING_REJECTED         not approved (+ reason)
 *
 * The server enforces the same rule (middleware/sellerLifecycle.ts): even a
 * hand-typed URL or API call cannot reach orders, products, earnings… before
 * ACTIVE, and onboarding edits are refused while under review. Every write
 * here uses the existing seller onboarding APIs; numbers come back masked.
 */

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isFoodSellerType, type SellerLifecycleDto } from '@shared';
import { AadioneWordmark } from '@/components/PartnerLogin';
import { Button, ErrorBanner, Field, Icon, Modal, Panel, Pill, inputClass, type IconName, type Tone } from '@/components/ui';
import {
  DOCUMENT_TYPE_LABEL,
  DocumentNumber,
  ViewPdfButton,
  formatFileSize,
} from '@/components/SellerDocuments';
import { SELLER_TYPE_LABEL } from '@/components/SellerBadges';
import { sellerApi, sellerErrorMessage, toSellerOnboarding, type SellerOnboarding } from '../sellerApi';
import { sellerKeys, useSellerLifecycle } from '../sellerQueries';
import { useSellerAuth } from '../sellerAuth';
import { SkeletonBlock } from '../sellerUi';
import StoreLocationPanel from '../StoreLocationPanel';
import { BankDetailsModal, Note, RestaurantModal, Row, UploadDocumentModal } from './SellerProfile';

type Lifecycle = SellerLifecycleDto['lifecycleStatus'];

const STATUS_COPY: Record<Lifecycle, { title: string; badge: string; tone: Tone; icon: IconName; message: string }> = {
  APPLICATION_PENDING: {
    title: 'Seller Application Pending',
    badge: 'Pending Admin Approval',
    tone: 'amber',
    icon: 'clock',
    message: 'Our team will review your seller application. Once approved, you can complete your seller onboarding.',
  },
  APPLICATION_REJECTED: {
    title: 'Application Not Approved',
    badge: 'Application Rejected',
    tone: 'red',
    icon: 'alert',
    message: 'Aadione could not approve your seller application.',
  },
  ONBOARDING_PENDING: {
    title: 'Complete Your Seller Onboarding',
    badge: 'Onboarding',
    tone: 'blue',
    icon: 'clipboard',
    message:
      'Your application is approved. Fill in every section below, then submit your onboarding for verification.',
  },
  ONBOARDING_CHANGES_REQUIRED: {
    title: 'Changes Required',
    badge: 'Changes Required',
    tone: 'amber',
    icon: 'edit',
    message: 'Aadione reviewed your onboarding and needs some changes. Update the details below and submit again.',
  },
  ONBOARDING_PENDING_REVIEW: {
    title: 'Verification in Progress',
    badge: 'Under Review',
    tone: 'blue',
    icon: 'shield',
    message: 'Your onboarding is under review. You will get full access to the Seller Panel once Aadione approves it.',
  },
  ONBOARDING_REJECTED: {
    title: 'Seller Account Not Approved',
    badge: 'Rejected',
    tone: 'red',
    icon: 'alert',
    message: 'Aadione could not approve your seller onboarding.',
  },
  ACTIVE: {
    title: 'Your seller account is active',
    badge: 'Active',
    tone: 'brand',
    icon: 'check',
    message: 'Opening your Seller Panel…',
  },
};

/** The two gates as one line of steps. */
const STEPS: { label: string; reachedBy: Lifecycle[] }[] = [
  { label: 'Application', reachedBy: [] },
  { label: 'Approved', reachedBy: ['ONBOARDING_PENDING', 'ONBOARDING_CHANGES_REQUIRED', 'ONBOARDING_PENDING_REVIEW', 'ONBOARDING_REJECTED', 'ACTIVE'] },
  { label: 'Onboarding', reachedBy: ['ONBOARDING_PENDING_REVIEW', 'ONBOARDING_REJECTED', 'ACTIVE'] },
  { label: 'Verification', reachedBy: ['ACTIVE'] },
  { label: 'Active', reachedBy: ['ACTIVE'] },
];

function Stepper({ status }: { status: Lifecycle }) {
  // Index of the step the seller is working on now.
  const current = STEPS.findIndex((step, index) => index > 0 && !step.reachedBy.includes(status));
  const rejected = status === 'APPLICATION_REJECTED' || status === 'ONBOARDING_REJECTED';
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs font-semibold" aria-label="Seller onboarding progress">
      {STEPS.map((step, index) => {
        const done = current === -1 || index < current;
        const active = index === current;
        const cls = done
          ? 'bg-brand-50 text-brand-700'
          : active
            ? rejected
              ? 'bg-danger-50 text-danger-600'
              : 'bg-warn-50 text-warn-500'
            : 'bg-gray-100 text-gray-400';
        return (
          <li key={step.label} className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${cls}`} aria-current={active ? 'step' : undefined}>
              {done && <Icon name="check" className="h-3.5 w-3.5" />}
              {step.label}
            </span>
            {index < STEPS.length - 1 && <span className="text-gray-300" aria-hidden="true">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Shell({ sellerName, children }: { sellerName: string | null; children: ReactNode }) {
  const logout = useSellerAuth((state) => state.logout);
  const user = useSellerAuth((state) => state.user);
  const [signingOut, setSigningOut] = useState(false);
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <AadioneWordmark className="text-2xl" />
            <p className="truncate text-xs font-medium text-gray-500">
              Seller onboarding{sellerName ? ` · ${sellerName}` : ''}
              {user?.fullName ? ` · ${user.fullName}` : ''}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void logout().finally(() => setSigningOut(false));
            }}
          >
            <Icon name="lock" className="h-4 w-4" />
            {signingOut ? 'Signing out…' : 'Logout'}
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-5 px-3 pb-16 pt-5 sm:px-6">{children}</main>
    </div>
  );
}

export default function SellerOnboardingPage() {
  const lifecycle = useSellerLifecycle();

  if (lifecycle.isPending) {
    return (
      <Shell sellerName={null}>
        <SkeletonBlock lines={6} label="Loading your seller account…" />
      </Shell>
    );
  }
  if (lifecycle.isError) {
    return (
      <Shell sellerName={null}>
        <ErrorBanner message={sellerErrorMessage(lifecycle.error)} />
      </Shell>
    );
  }

  const data = lifecycle.data;
  const copy = STATUS_COPY[data.lifecycleStatus];
  const showsOnboarding =
    data.lifecycleStatus === 'ONBOARDING_PENDING' ||
    data.lifecycleStatus === 'ONBOARDING_CHANGES_REQUIRED' ||
    data.lifecycleStatus === 'ONBOARDING_PENDING_REVIEW';

  return (
    <Shell sellerName={data.sellerName}>
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm" aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <Icon name={copy.icon} className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-gray-900">{copy.title}</h1>
              <p className="mt-1 text-sm text-gray-600">{copy.message}</p>
            </div>
          </div>
          <Pill tone={copy.tone}>{copy.badge}</Pill>
        </div>

        {data.reason && data.lifecycleStatus !== 'ACTIVE' && (
          <div
            role="note"
            className={`mt-4 rounded-xl px-3.5 py-2.5 text-sm ${
              data.lifecycleStatus === 'ONBOARDING_CHANGES_REQUIRED' ? 'bg-warn-50 text-warn-600' : 'bg-danger-50 text-danger-600'
            }`}
          >
            <span className="font-semibold">
              {data.lifecycleStatus === 'ONBOARDING_CHANGES_REQUIRED' ? 'What to change: ' : 'Reason: '}
            </span>
            {data.reason}
          </div>
        )}

        <div className="mt-4">
          <Stepper status={data.lifecycleStatus} />
        </div>

        <dl className="mt-4 grid gap-x-6 text-sm sm:grid-cols-2">
          <Row label="Business" value={data.sellerName} />
          <Row label="Seller type" value={SELLER_TYPE_LABEL[data.sellerType] ?? data.sellerType} />
          {data.applicationSubmittedAt && <Row label="Applied on" value={formatDate(data.applicationSubmittedAt)} />}
          {data.onboardingSubmittedAt && <Row label="Submitted for verification" value={formatDate(data.onboardingSubmittedAt)} />}
        </dl>

        {(data.lifecycleStatus === 'APPLICATION_REJECTED' || data.lifecycleStatus === 'ONBOARDING_REJECTED') && (
          <p className="mt-3 text-sm text-gray-500">If you think this is a mistake, please contact Aadione support.</p>
        )}
      </section>

      {showsOnboarding && <OnboardingWorkspace lifecycle={data} />}
    </Shell>
  );
}

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/* -------------------------------------------------------------------------- */
/* Onboarding workspace                                                       */
/* -------------------------------------------------------------------------- */

const DOCUMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending review', tone: 'amber' },
  VERIFIED: { label: 'Verified', tone: 'brand' },
  REJECTED: { label: 'Rejected', tone: 'red' },
};

function OnboardingWorkspace({ lifecycle }: { lifecycle: SellerLifecycleDto }) {
  const queryClient = useQueryClient();
  const editable = lifecycle.canEditOnboarding;
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<'business' | 'bank' | 'restaurant' | null>(null);
  const [uploading, setUploading] = useState(false);

  const onboarding = useQuery({
    queryKey: sellerKeys.onboarding,
    queryFn: () => sellerApi.get<SellerOnboarding>('/seller/onboarding').then(toSellerOnboarding),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: sellerKeys.onboarding });
    void queryClient.invalidateQueries({ queryKey: sellerKeys.lifecycle });
  };

  const save = useMutation({
    mutationFn: (input: { path: string; body: unknown; done: string }) =>
      sellerApi.put<SellerOnboarding>(input.path, input.body).then(toSellerOnboarding),
    onSuccess: (data, input) => {
      queryClient.setQueryData(sellerKeys.onboarding, data);
      setEditing(null);
      setNotice(input.done);
    },
    onSettled: refresh,
  });

  const submit = useMutation({
    mutationFn: () => sellerApi.post<SellerLifecycleDto>('/seller/onboarding/submit', {}),
    onSuccess: (data) => {
      queryClient.setQueryData(sellerKeys.lifecycle, data);
      setNotice(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onSettled: refresh,
  });

  if (onboarding.isPending) return <SkeletonBlock lines={6} label="Loading your onboarding…" />;
  if (onboarding.isError) return <ErrorBanner message={sellerErrorMessage(onboarding.error)} />;

  const data = onboarding.data;
  const serverError = save.isError ? sellerErrorMessage(save.error) : null;
  const missing = lifecycle.checklist.filter((item) => !item.met);
  const isRestaurant = isFoodSellerType(lifecycle.sellerType);
  const open = (what: 'business' | 'bank' | 'restaurant') => {
    save.reset();
    setNotice(null);
    setEditing(what);
  };

  return (
    <>
      {notice && (
        <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-600">
          {notice}
        </div>
      )}

      {/* Checklist + submit */}
      <Panel
        title={editable ? 'Onboarding checklist' : 'Submitted details'}
        action={
          <span className="text-sm font-semibold text-gray-500">
            {lifecycle.checklist.length - missing.length}/{lifecycle.checklist.length} done
          </span>
        }
      >
        <ul className="divide-y divide-gray-100">
          {lifecycle.checklist.map((item) => (
            <li key={item.key} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">{item.label}</p>
                {!item.met && <p className="text-xs text-gray-500">{item.hint}</p>}
              </div>
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  item.met ? 'bg-brand-50 text-brand-700' : 'bg-warn-50 text-warn-500'
                }`}
              >
                <Icon name={item.met ? 'check' : 'clock'} className="h-3.5 w-3.5" />
                {item.met ? 'Done' : 'To do'}
              </span>
            </li>
          ))}
        </ul>
        {editable && (
          <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
            {submit.isError && <ErrorBanner message={sellerErrorMessage(submit.error)} />}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-gray-500">
                {lifecycle.canSubmit
                  ? 'Everything is in place. Submit to send your onboarding to Aadione for verification. You cannot edit it while it is being reviewed.'
                  : `Complete ${missing.length} more item${missing.length === 1 ? '' : 's'} to submit.`}
              </p>
              <Button disabled={!lifecycle.canSubmit || submit.isPending} onClick={() => submit.mutate()} className="shrink-0">
                {submit.isPending
                  ? 'Submitting…'
                  : lifecycle.lifecycleStatus === 'ONBOARDING_CHANGES_REQUIRED'
                    ? 'Resubmit for Verification'
                    : 'Submit for Verification'}
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {/* Business & contact & tax */}
      <Panel
        title="Business, contact & tax details"
        action={
          editable && (
            <Button variant="secondary" onClick={() => open('business')}>
              {data.profile ? 'Edit' : 'Add'}
            </Button>
          )
        }
      >
        {data.profile ? (
          <dl className="divide-y divide-gray-100">
            <Row label="Business name" value={data.profile.businessName} />
            <Row label="Business type" value={data.profile.businessType} />
            <Row label="Owner name" value={data.profile.ownerFullName} />
            <Row label="Mobile number" value={data.profile.ownerMobile} />
            <Row label="Email" value={data.profile.ownerEmail} />
            <Row label="PAN" value={data.profile.panNumber} />
            <Row label="Aadhaar" value={data.profile.aadhaarNumber} />
            <Row label="GST number" value={data.profile.gstNumber} />
            <Row label="FSSAI licence number" value={data.profile.fssaiNumber} />
          </dl>
        ) : (
          <Note>Add your business, contact and tax details.</Note>
        )}
      </Panel>

      {/* Store address + map point (GET/PATCH /seller/location) */}
      <StoreLocationPanel
        readOnly={!editable}
        onSaved={(message) => {
          setNotice(message);
          refresh();
        }}
      />

      {/* Bank */}
      <Panel
        title="Bank account"
        action={
          editable && (
            <Button variant="secondary" onClick={() => open('bank')}>
              {data.bankDetail ? 'Edit' : 'Add bank details'}
            </Button>
          )
        }
      >
        {data.bankDetail ? (
          <dl className="divide-y divide-gray-100">
            <Row label="Account holder" value={data.bankDetail.accountHolderName} />
            <Row label="Bank" value={data.bankDetail.bankName} />
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
          <Note>Add the bank account your settlements will be paid into.</Note>
        )}
      </Panel>

      {/* Documents */}
      <Panel
        title="Documents & licences"
        action={
          editable && (
            <Button variant="secondary" onClick={() => { setNotice(null); setUploading(true); }}>
              Upload document
            </Button>
          )
        }
      >
        {data.documents.length === 0 ? (
          <Note>No documents uploaded yet. Upload your PAN card as a PDF with its number.</Note>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.documents.map((document) => {
              const status = DOCUMENT_STATUS[document.status] ?? { label: document.status, tone: 'gray' as Tone };
              return (
                <li key={document.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-gray-900">
                      {DOCUMENT_TYPE_LABEL[document.type] ?? document.type}
                    </span>
                    <Pill tone={status.tone}>{status.label}</Pill>
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
                        : 'No file'}
                    </span>
                    {document.hasFile && (
                      <ViewPdfButton load={() => sellerApi.getBlob(`/seller/onboarding/documents/${document.id}/file`)} />
                    )}
                  </div>
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
          <Note>PDF only, up to 10 MB. To replace a document, upload a new one of the same type.</Note>
        </div>
      </Panel>

      {/* Restaurant details */}
      {isRestaurant && (
        <Panel
          title="Restaurant details"
          action={
            editable && (
              <Button variant="secondary" onClick={() => open('restaurant')}>
                {data.restaurantProfile ? 'Edit' : 'Add'}
              </Button>
            )
          }
        >
          {data.restaurantProfile ? (
            <dl className="divide-y divide-gray-100">
              <Row label="Cuisines" value={data.restaurantProfile.cuisine.join(', ')} />
              <Row label="Vegetarian only" value={data.restaurantProfile.isVegOnly ? 'Yes' : 'No'} />
              <Row
                label="Average preparation time"
                value={data.restaurantProfile.avgPrepMins ? `${data.restaurantProfile.avgPrepMins} min` : null}
              />
            </dl>
          ) : (
            <Note>Add your cuisines and average preparation time.</Note>
          )}
        </Panel>
      )}

      {editing === 'business' && (
        <BusinessModal
          initial={data}
          saving={save.isPending}
          serverError={serverError}
          onClose={() => setEditing(null)}
          onSave={(body) => save.mutate({ path: '/seller/onboarding/profile', body, done: 'Business details saved.' })}
        />
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
          onSave={(body) => save.mutate({ path: '/seller/onboarding/bank-detail', body, done: 'Bank details saved.' })}
        />
      )}

      {editing === 'restaurant' && (
        <RestaurantModal
          initial={data.restaurantProfile ?? { cuisine: [], isVegOnly: false, avgPrepMins: null }}
          saving={save.isPending}
          serverError={serverError}
          onClose={() => setEditing(null)}
          onSave={(body) => save.mutate({ path: '/seller/onboarding/restaurant-profile', body, done: 'Restaurant details saved.' })}
        />
      )}

      {uploading && (
        <UploadDocumentModal
          onClose={() => setUploading(false)}
          onDone={(label) => {
            setUploading(false);
            setNotice(`${label} uploaded.`);
            refresh();
          }}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Business details form                                                      */
/* -------------------------------------------------------------------------- */

/** PUT /seller/onboarding/profile. PAN and Aadhaar only ever come back
 * MASKED, so their inputs start empty: left empty, the saved value is kept
 * (the field is omitted); typed, it replaces it. */
function BusinessModal({
  initial,
  saving,
  serverError,
  onClose,
  onSave,
}: {
  initial: SellerOnboarding;
  saving: boolean;
  serverError: string | null;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const p = initial.profile;
  const [businessName, setBusinessName] = useState(p?.businessName ?? initial.sellerName);
  const [businessType, setBusinessType] = useState(p?.businessType ?? '');
  const [ownerFullName, setOwnerFullName] = useState(p?.ownerFullName ?? '');
  const [ownerMobile, setOwnerMobile] = useState(p?.ownerMobile ?? '');
  const [ownerEmail, setOwnerEmail] = useState(p?.ownerEmail ?? '');
  const [pan, setPan] = useState('');
  const [aadhaar, setAadhaar] = useState('');
  const [gst, setGst] = useState(p?.gstNumber ?? '');
  const [fssai, setFssai] = useState(p?.fssaiNumber ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(): void {
    if (businessName.trim().length < 2) return setProblem('Enter the business name.');
    if (ownerFullName.trim().length < 2) return setProblem("Enter the owner's full name.");
    if (ownerMobile.replace(/\D/g, '').length < 10) return setProblem('Enter a valid mobile number.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim())) return setProblem('Enter a valid email address.');
    if (!p?.panNumber && !pan.trim()) return setProblem('Enter your PAN.');
    if (pan.trim() && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.trim().toUpperCase())) return setProblem('Enter a valid PAN, e.g. ABCDE1234F.');
    setProblem(null);
    onSave({
      businessName: businessName.trim(),
      businessType: businessType.trim() || null,
      ownerFullName: ownerFullName.trim(),
      ownerMobile: ownerMobile.trim(),
      ownerEmail: ownerEmail.trim(),
      ...(pan.trim() ? { panNumber: pan.trim().toUpperCase() } : {}),
      ...(aadhaar.trim() ? { aadhaarNumber: aadhaar.replace(/\s/g, '') } : {}),
      gstNumber: gst.trim() ? gst.trim().toUpperCase() : null,
      fssaiNumber: fssai.trim() || null,
    });
  }

  return (
    <ModalShell title="Business, contact & tax details" onClose={onClose} saving={saving} onSave={submit}>
      <ErrorBanner message={problem ?? serverError} />
      <Field label="Business name" required>
        <input value={businessName} maxLength={160} onChange={(e) => setBusinessName(e.target.value)} className={inputClass} />
      </Field>
      <Field label="Business type" hint="e.g. Proprietorship, Partnership, Private Limited">
        <input value={businessType} maxLength={80} onChange={(e) => setBusinessType(e.target.value)} className={inputClass} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Owner full name" required>
          <input value={ownerFullName} maxLength={120} onChange={(e) => setOwnerFullName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Owner mobile" required>
          <input value={ownerMobile} inputMode="numeric" maxLength={15} onChange={(e) => setOwnerMobile(e.target.value)} className={inputClass} />
        </Field>
      </div>
      <Field label="Owner email" required>
        <input type="email" value={ownerEmail} maxLength={160} onChange={(e) => setOwnerEmail(e.target.value)} className={inputClass} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="PAN" required={!p?.panNumber} hint={p?.panNumber ? `Saved: ${p.panNumber} — leave empty to keep it.` : undefined}>
          <input value={pan} maxLength={10} autoComplete="off" onChange={(e) => setPan(e.target.value.toUpperCase())} className={inputClass} placeholder="ABCDE1234F" />
        </Field>
        <Field label="Aadhaar (optional)" hint={p?.aadhaarNumber ? `Saved: ${p.aadhaarNumber} — leave empty to keep it.` : undefined}>
          <input value={aadhaar} inputMode="numeric" maxLength={14} autoComplete="off" onChange={(e) => setAadhaar(e.target.value)} className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="GST number (if registered)" hint="If you enter a GSTIN, also upload the GST certificate.">
          <input value={gst} maxLength={15} onChange={(e) => setGst(e.target.value.toUpperCase())} className={inputClass} placeholder="08ABCDE1234F1Z5" />
        </Field>
        <Field label="FSSAI licence number" hint={'Required for restaurants (14 digits).'}>
          <input value={fssai} inputMode="numeric" maxLength={14} onChange={(e) => setFssai(e.target.value.replace(/\D/g, ''))} className={inputClass} />
        </Field>
      </div>
    </ModalShell>
  );
}


function ModalShell({
  title,
  onClose,
  saving,
  onSave,
  children,
}: {
  title: string;
  onClose: () => void;
  saving: boolean;
  onSave: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); onSave(); }} autoComplete="off">
        {children}
      </form>
    </Modal>
  );
}
