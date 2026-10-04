/**
 * Sellers — the admin seller directory (V2).
 *
 * List: GET /admin/sellers, filtered and cursor-paginated ON THE SERVER; the
 * filters live in the URL (?search=&type=&lifecycle=&active=), so a refresh or
 * a shared link shows the same list, and any change starts again from the
 * first page. Create: POST /admin/sellers. Trading switch:
 * PATCH /admin/sellers/:id/status (reason required).
 *
 * TWO GATES: `?view=applications` is the Seller Applications view (Gate 1 —
 * GET /admin/sellers/applications, approve/reject with
 * PATCH .../application/review). Gate 2 (verification of the submitted
 * onboarding) is decided on the seller's detail page.
 *
 * Two different switches, never confused here:
 *   isActive           — the ADMIN switch this page controls;
 *   isAcceptingOrders  — the SELLER's own Store Open/Closed switch, shown but
 *                        never changed from here.
 *
 * The list carries no PII (no PAN, Aadhaar, bank or document data) and this
 * page never calls the unmasked onboarding review endpoints.
 */

import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  SellerType,
  normalizeIndianMobile,
  type AdminSellerApplicationDto,
  type AdminSellerListRowDto,
  type CreateSellerRequest,
  type SellerLifecycleStatus,
} from '@shared';
import {
  LIFECYCLE_FILTERS,
  SELLER_TYPES,
  adminSellerKeys,
  sellerErrorMessage,
  useCreateSeller,
  useReviewSellerApplication,
  useSellerApplications,
  useSellerList,
  useSellerPermissions,
  type SellerListFilters,
} from '@/lib/sellers';
import {
  ActivePill,
  LIFECYCLE_LOOK,
  LifecyclePill,
  SELLER_TYPE_LABEL as TYPE_LABEL,
  SellerAvailability,
  formatSellerDate,
} from '@/components/SellerBadges';
import { SellerStatusModal } from '@/components/SellerStatusModal';
import { ReasonModal } from '@/components/SellerLifecyclePanel';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  Modal,
  Panel,
  SearchInput,
  Spinner,
  Td,
  Th,
  inputClass,
} from '@/components/ui';

/* -------------------------------------------------------------------------- */
/* URL <-> filters                                                             */
/* -------------------------------------------------------------------------- */

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

/** Unknown or tampered values are ignored rather than sent to the server. */
function filtersFromParams(params: URLSearchParams): SellerListFilters {
  const search = params.get('search')?.trim().slice(0, 60) ?? '';
  const sellerType = pick(params.get('type'), SELLER_TYPES);
  const lifecycle = pick(params.get('lifecycle'), LIFECYCLE_FILTERS);
  const active = params.get('active');
  return {
    ...(search ? { search } : {}),
    ...(sellerType ? { sellerType } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(active === 'true' || active === 'false' ? { isActive: active === 'true' } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* page                                                                        */
/* -------------------------------------------------------------------------- */

export default function SellersPage() {
  const { canRead, canManage } = useSellerPermissions();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const view = params.get('view') === 'applications' ? 'applications' : 'directory';
  const pendingApplications = useSellerApplications('APPLICATION_PENDING', canRead);
  const pendingCount = pendingApplications.data?.pages[0]?.items.length ?? 0;

  const [searchInput, setSearchInput] = useState(filters.search ?? '');
  const [creating, setCreating] = useState(false);
  const [statusTarget, setStatusTarget] = useState<AdminSellerListRowDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  // Search is sent to the server, debounced so typing is not one request per key.
  useEffect(() => {
    const value = searchInput.trim();
    if (value === (filters.search ?? '')) return;
    const timer = window.setTimeout(() => setParam('search', value || null), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Keep the box in step when the URL changes on its own (back button, clear).
  useEffect(() => {
    setSearchInput((current) => (current.trim() === (filters.search ?? '') ? current : filters.search ?? ''));
  }, [filters.search]);

  const list = useSellerList(filters, canRead);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  }, [list.data]);

  const hasFilters = Object.keys(filters).length > 0;
  const switchView = (next: 'directory' | 'applications') =>
    setParams(next === 'applications' ? new URLSearchParams({ view: 'applications' }) : new URLSearchParams(), { replace: true });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: adminSellerKeys.lists() });

  if (!canRead) {
    return <EmptyState title="You don't have access to seller management." hint="Ask an administrator if you need it." />;
  }

  return (
    <div className="space-y-5">
      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-600"
        >
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="text-brand-600/70 hover:text-brand-600">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
      )}

      <div role="tablist" aria-label="Seller views" className="flex flex-wrap gap-2">
        <ViewTab active={view === 'directory'} onClick={() => switchView('directory')}>
          All sellers
        </ViewTab>
        <ViewTab active={view === 'applications'} onClick={() => switchView('applications')}>
          Seller Applications
          {pendingCount > 0 && (
            <span className="ml-1.5 rounded-full bg-warn-50 px-2 py-0.5 text-xs font-semibold text-warn-500">
              {pendingApplications.hasNextPage ? `${pendingCount}+` : pendingCount} pending
            </span>
          )}
        </ViewTab>
      </div>

      {view === 'applications' ? (
        <ApplicationsPanel onNotice={setNotice} />
      ) : (
      <Panel
        title="Sellers"
        bodyClass=""
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={refresh} disabled={list.isFetching}>
              {list.isFetching && !list.isFetchingNextPage && !list.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
            {canManage && (
              <Button onClick={() => setCreating(true)}>
                <Icon name="plus" className="h-4 w-4" />
                Create Seller
              </Button>
            )}
          </div>
        }
      >
        {/* filters — every one goes to the server */}
        <div className="grid gap-3 px-5 pb-4 sm:grid-cols-2 lg:grid-cols-6">
          <SearchInput
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search name, code or city"
            className="sm:col-span-2 lg:col-span-2"
          />
          <FilterSelect
            label="Seller type"
            value={filters.sellerType ?? ''}
            onChange={(value) => setParam('type', value)}
            options={SELLER_TYPES.map((type) => ({ value: type, label: TYPE_LABEL[type] ?? type }))}
          />
          <FilterSelect
            label="Lifecycle"
            value={filters.lifecycle ?? ''}
            onChange={(value) => setParam('lifecycle', value)}
            options={LIFECYCLE_FILTERS.map((status) => ({ value: status, label: LIFECYCLE_LOOK[status]?.label ?? status }))}
          />
          <FilterSelect
            label="Active"
            value={filters.isActive === undefined ? '' : String(filters.isActive)}
            onChange={(value) => setParam('active', value)}
            options={[
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Inactive' },
            ]}
          />
        </div>
        {hasFilters && (
          <div className="-mt-1 px-5 pb-3">
            <button
              onClick={() => {
                setSearchInput('');
                setParams(new URLSearchParams(), { replace: true });
              }}
              className="text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              Clear filters
            </button>
          </div>
        )}

        {list.isPending ? (
          <Spinner label="Loading sellers…" />
        ) : list.isError && rows.length === 0 ? (
          <div className="space-y-3 p-5 pt-0">
            <ErrorBanner message={sellerErrorMessage(list.error, 'Could not load sellers.')} />
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              title={hasFilters ? 'No sellers match these filters' : 'No sellers yet'}
              hint={hasFilters ? 'Try a different search or clear the filters.' : 'Sellers you create will appear here.'}
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto border-t border-gray-100">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <Th>Seller</Th>
                    <Th>Type</Th>
                    <Th>City</Th>
                    <Th>Lifecycle</Th>
                    <Th>Active</Th>
                    <Th>Orders availability</Th>
                    <Th>Created</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => (
                    <SellerRow
                      key={row.id}
                      row={row}
                      canManage={canManage}
                      listSearch={location.search}
                      onToggleStatus={() => setStatusTarget(row)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 p-4">
              <p className="text-sm text-gray-500">
                Showing {rows.length} {rows.length === 1 ? 'seller' : 'sellers'}
                {list.hasNextPage ? ' — more available' : ''}
              </p>
              {list.hasNextPage && (
                <div className="text-right">
                  {list.isFetchNextPageError && (
                    <p className="mb-2 text-sm text-danger-600">Could not load more sellers.</p>
                  )}
                  <Button
                    variant="secondary"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </Panel>
      )}

      {creating && (
        <CreateSellerModal
          onClose={() => setCreating(false)}
          onCreated={(message) => {
            setCreating(false);
            setNotice(message);
          }}
        />
      )}

      {statusTarget && (
        <SellerStatusModal
          seller={statusTarget}
          onClose={() => setStatusTarget(null)}
          onDone={(message) => {
            setStatusTarget(null);
            setNotice(message);
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* table row                                                                   */
/* -------------------------------------------------------------------------- */

function SellerRow({
  row,
  canManage,
  listSearch,
  onToggleStatus,
}: {
  row: AdminSellerListRowDto;
  canManage: boolean;
  /** The list's current ?query, so "← Sellers" on the detail page returns here. */
  listSearch: string;
  onToggleStatus: () => void;
}) {
  const navigate = useNavigate();
  const to = `/sellers/${row.id}`;
  const state = { listSearch };

  // The whole row opens the seller; buttons and links inside keep their own clicks.
  const openRow = (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest('button, a')) return;
    navigate(to, { state });
  };

  return (
    <tr className="cursor-pointer transition hover:bg-gray-50/60" onClick={openRow}>
      <Td>
        <Link to={to} state={state} className="font-medium text-gray-900 hover:text-brand-600 hover:underline">
          {row.name}
        </Link>
        <p className="mt-0.5 text-xs text-gray-500">
          {row.code}
        </p>
      </Td>
      <Td className="whitespace-nowrap text-gray-700">{TYPE_LABEL[row.sellerType] ?? row.sellerType}</Td>
      <Td className="whitespace-nowrap text-gray-700">{row.city}</Td>
      <Td>
        <LifecyclePill status={row.lifecycleStatus} isActive={row.isActive} />
      </Td>
      <Td>
        <ActivePill isActive={row.isActive} />
      </Td>
      <Td>
        <SellerAvailability facts={row} />
      </Td>
      <Td className="whitespace-nowrap text-gray-600">{formatSellerDate(row.createdAt)}</Td>
      <Td>
        <div className="flex justify-end">
          {canManage ? (
            <Button variant={row.isActive ? 'ghost' : 'soft'} onClick={onToggleStatus}>
              {row.isActive ? 'Deactivate' : 'Activate'}
            </Button>
          ) : null}
        </div>
      </Td>
    </tr>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex min-h-10 items-center rounded-xl px-4 text-sm font-semibold transition ${
        active ? 'bg-brand-500 text-white shadow-sm' : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Seller Applications — Gate 1                                                */
/* -------------------------------------------------------------------------- */

const APPLICATION_FILTERS: { value: SellerLifecycleStatus | 'ALL'; label: string }[] = [
  { value: 'APPLICATION_PENDING', label: 'Pending approval' },
  { value: 'APPLICATION_REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All applications' },
];

function ApplicationsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const { canReview } = useSellerPermissions();
  const location = useLocation();
  const [filter, setFilter] = useState<SellerLifecycleStatus | 'ALL'>('APPLICATION_PENDING');
  const list = useSellerApplications(filter === 'ALL' ? null : filter);
  const [rejecting, setRejecting] = useState<AdminSellerApplicationDto | null>(null);
  const review = useReviewSellerApplication();
  const rows = (list.data?.pages ?? []).flatMap((page) => page.items);

  const approve = (row: AdminSellerApplicationDto) =>
    review.mutate(
      { sellerId: row.sellerId, body: { decision: 'APPROVE' } },
      { onSuccess: () => onNotice(`${row.businessName}: application approved. The seller can now complete onboarding — they are NOT active yet.`) },
    );

  return (
    <Panel
      title="Seller Applications"
      bodyClass=""
      action={
        <select aria-label="Application status" value={filter} onChange={(e) => setFilter(e.target.value as SellerLifecycleStatus | 'ALL')} className={`${inputClass} w-auto`}>
          {APPLICATION_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      }
    >
      <p className="px-5 pb-4 text-sm text-gray-500">
        Gate 1. Approving an application lets the applicant complete onboarding; the Seller Panel stays locked until you verify that onboarding (Gate 2) on the seller&apos;s page.
      </p>
      {review.isError && (
        <div className="px-5 pb-3">
          <ErrorBanner message={sellerErrorMessage(review.error, 'Could not record the decision.')} />
        </div>
      )}
      {list.isPending ? (
        <Spinner label="Loading applications…" />
      ) : list.isError ? (
        <div className="p-5 pt-0">
          <ErrorBanner message={sellerErrorMessage(list.error, 'Could not load applications.')} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-5 pt-0">
          <EmptyState
            title={filter === 'APPLICATION_PENDING' ? 'No applications waiting' : 'No applications'}
            hint="New seller applications appear here when sellers apply from the Seller sign-in page."
          />
        </div>
      ) : (
        <div className="overflow-x-auto border-t border-gray-100">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <Th>Applicant</Th>
                <Th>Business / store</Th>
                <Th>Contact</Th>
                <Th>Seller type</Th>
                <Th>Applied</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.sellerId}>
                  <Td className="font-medium text-gray-900">{row.applicantName ?? '—'}</Td>
                  <Td>
                    <Link to={`/sellers/${row.sellerId}`} state={{ listSearch: location.search }} className="font-medium text-gray-900 hover:text-brand-600 hover:underline">
                      {row.businessName}
                    </Link>
                  </Td>
                  <Td className="text-gray-700">
                    <span className="block whitespace-nowrap">{row.mobile ?? '—'}</span>
                    <span className="block break-all text-xs text-gray-500">{row.email ?? '—'}</span>
                  </Td>
                  <Td className="whitespace-nowrap text-gray-700">{TYPE_LABEL[row.sellerType] ?? row.sellerType}</Td>
                  <Td className="whitespace-nowrap text-gray-600">{formatSellerDate(row.applicationSubmittedAt ?? row.createdAt)}</Td>
                  <Td>
                    <LifecyclePill status={row.lifecycleStatus} />
                    {row.lifecycleStatus === 'APPLICATION_REJECTED' && row.lifecycleReason && (
                      <p className="mt-1 max-w-[16rem] text-xs text-gray-500">{row.lifecycleReason}</p>
                    )}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      {canReview && row.lifecycleStatus === 'APPLICATION_PENDING' ? (
                        <>
                          <Button variant="soft" disabled={review.isPending} onClick={() => approve(row)}>
                            Approve
                          </Button>
                          <Button variant="ghost" disabled={review.isPending} onClick={() => setRejecting(row)}>
                            Reject
                          </Button>
                        </>
                      ) : (
                        <Link to={`/sellers/${row.sellerId}`} className="text-sm font-semibold text-brand-600 hover:underline">
                          Open
                        </Link>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage && (
            <div className="border-t border-gray-100 p-4 text-right">
              <Button variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}

      {rejecting && (
        <ReasonModal
          title={`Reject application — ${rejecting.businessName}`}
          subtitle="The applicant sees this reason and cannot continue to onboarding."
          confirmLabel="Reject application"
          busy={review.isPending}
          error={review.isError ? sellerErrorMessage(review.error, 'Could not reject the application.') : null}
          onClose={() => setRejecting(null)}
          onConfirm={(reason) =>
            review.mutate(
              { sellerId: rejecting.sellerId, body: { decision: 'REJECT', reason } },
              {
                onSuccess: () => {
                  onNotice(`${rejecting.businessName}: application rejected.`);
                  setRejecting(null);
                },
              },
            )
          }
        />
      )}
    </Panel>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string | null) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value || null)}
      className={inputClass}
    >
      <option value="">{label}: All</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* -------------------------------------------------------------------------- */
/* create                                                                      */
/* -------------------------------------------------------------------------- */

interface CreateForm {
  name: string;
  sellerType: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  latitude: string;
  longitude: string;
  phone: string;
  ownerFullName: string;
  ownerMobile: string;
  commissionPercent: string;
}

const EMPTY_FORM: CreateForm = {
  name: '',
  sellerType: '',
  addressLine: '',
  city: '',
  state: '',
  pincode: '',
  latitude: '',
  longitude: '',
  phone: '',
  ownerFullName: '',
  ownerMobile: '',
  commissionPercent: '',
};

/** Mirrors the backend's createSellerSchema (lengths = the `sellers` columns).
 * The server re-validates everything; this only saves a round trip. */
function validateCreate(form: CreateForm): { body?: CreateSellerRequest; errors: Partial<Record<keyof CreateForm, string>> } {
  const errors: Partial<Record<keyof CreateForm, string>> = {};
  const text = (key: keyof CreateForm, label: string, min: number, max: number) => {
    const value = form[key].trim();
    if (value.length < min) errors[key] = `${label} is required.`;
    else if (value.length > max) errors[key] = `${label} must be at most ${max} characters.`;
    return value;
  };

  const name = text('name', 'Seller name', 2, 120);
  if (!SELLER_TYPES.includes(form.sellerType as SellerType)) errors.sellerType = 'Select a seller type.';
  const addressLine = text('addressLine', 'Address', 2, 300);
  const city = text('city', 'City', 2, 80);
  const state = text('state', 'State', 2, 80);
  const pincode = form.pincode.trim();
  if (!/^\d{6}$/.test(pincode)) errors.pincode = 'Pincode must be 6 digits.';

  const latitude = Number(form.latitude);
  const longitude = Number(form.longitude);
  if (form.latitude.trim() === '' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    errors.latitude = 'Latitude must be between -90 and 90.';
  }
  if (form.longitude.trim() === '' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    errors.longitude = 'Longitude must be between -180 and 180.';
  }

  const phone = form.phone.trim();
  if (phone && (phone.length < 10 || phone.length > 15)) errors.phone = 'Phone must be 10–15 characters.';

  const ownerFullName = text('ownerFullName', "Owner's full name", 2, 120);
  const ownerMobile = form.ownerMobile.trim();
  if (!normalizeIndianMobile(ownerMobile)) errors.ownerMobile = 'Enter a valid 10-digit Indian mobile number.';

  let defaultCommissionBp: number | undefined;
  if (form.commissionPercent.trim()) {
    const percent = Number(form.commissionPercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      errors.commissionPercent = 'Commission must be between 0 and 100%.';
    } else {
      defaultCommissionBp = Math.round(percent * 100);
    }
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    body: {
      name,
      sellerType: form.sellerType as SellerType,
      addressLine,
      city,
      state,
      pincode,
      latitude,
      longitude,
      ...(phone ? { phone } : {}),
      ownerFullName,
      ownerMobile,
      ...(defaultCommissionBp !== undefined ? { defaultCommissionBp } : {}),
    },
  };
}

function CreateSellerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (message: string) => void }) {
  const create = useCreateSeller();
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateForm, string>>>({});

  const set = (key: keyof CreateForm) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const result = validateCreate(form);
    setErrors(result.errors);
    if (!result.body) return;
    const body = result.body;
    create.mutate(body, {
      onSuccess: (created) =>
        onCreated(
          `${body.name} was created. Its owner can now complete onboarding — it cannot take orders until you verify that onboarding.` +
            (created.isNewOwnerAccount ? ' A new owner login was created.' : " An existing customer account was made the owner."),
        ),
    });
  };

  const input = (key: keyof CreateForm, props: { type?: string; inputMode?: 'numeric' | 'decimal' | 'tel'; placeholder?: string } = {}) => (
    <>
      <input
        value={form[key]}
        onChange={(event) => set(key)(event.target.value)}
        className={inputClass}
        aria-invalid={errors[key] ? true : undefined}
        {...props}
      />
      {errors[key] && <span className="mt-1 block text-xs text-danger-600">{errors[key]}</span>}
    </>
  );

  return (
    <Modal
      title="Create seller"
      subtitle="Creates the seller (application already approved — Onboarding Pending) and its owner's login. It still needs onboarding verification before going live."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create seller'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        {create.isError && <ErrorBanner message={sellerErrorMessage(create.error, 'Could not create the seller.')} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Seller name" required>
            {input('name')}
          </Field>
          <Field label="Seller type" required>
            <select
              value={form.sellerType}
              onChange={(event) => set('sellerType')(event.target.value)}
              className={inputClass}
              aria-invalid={errors.sellerType ? true : undefined}
            >
              <option value="">Select Seller Type</option>
              {SELLER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type] ?? type}
                </option>
              ))}
            </select>
            {errors.sellerType && <span className="mt-1 block text-xs text-danger-600">{errors.sellerType}</span>}
          </Field>
        </div>

        <Field label="Address" required>
          {input('addressLine')}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City" required>
            {input('city')}
          </Field>
          <Field label="State" required>
            {input('state')}
          </Field>
          <Field label="Pincode" required>
            {input('pincode', { inputMode: 'numeric', placeholder: '6 digits' })}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Latitude" required>
            {input('latitude', { inputMode: 'decimal', placeholder: 'e.g. 27.6094' })}
          </Field>
          <Field label="Longitude" required>
            {input('longitude', { inputMode: 'decimal', placeholder: 'e.g. 75.1399' })}
          </Field>
          <Field label="Store phone" hint="Optional">
            {input('phone', { inputMode: 'tel' })}
          </Field>
        </div>

        <div className="rounded-xl border border-gray-200 p-4">
          <p className="mb-3 text-sm font-semibold text-gray-900">Owner login</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Owner's full name" required>
              {input('ownerFullName')}
            </Field>
            <Field label="Owner's mobile" required hint="Contact number. The owner signs in with an email and password (set the login email on the seller page).">
              {input('ownerMobile', { inputMode: 'tel', placeholder: '10-digit mobile' })}
            </Field>
          </div>
        </div>

        <Field label="Default commission (%)" hint="Optional. Leave blank for 0%. Category and product rules can be set later.">
          {input('commissionPercent', { inputMode: 'decimal', placeholder: 'e.g. 12.5' })}
        </Field>
        {/* Lets Enter submit from any field. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
