/**
 * Sellers — the admin seller directory (V2).
 *
 * List: GET /admin/sellers, filtered and cursor-paginated ON THE SERVER; the
 * filters live in the URL (?search=&type=&onboarding=&active=&stage=), so a
 * refresh or a shared link shows the same list, and any change starts again
 * from the first page. Create: POST /admin/sellers. Trading switch:
 * PATCH /admin/sellers/:id/status (reason required).
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
import { SellerType, normalizeIndianMobile, type AdminSellerListRowDto, type CreateSellerRequest } from '@shared';
import {
  ONBOARDING_STATUSES,
  SELLER_TYPES,
  STAGE_FILTERS,
  adminSellerKeys,
  sellerErrorMessage,
  useCreateSeller,
  useSellerList,
  useSellerPermissions,
  type SellerListFilters,
} from '@/lib/sellers';
import {
  ActivePill,
  ONBOARDING_LOOK,
  OnboardingPill,
  SELLER_TYPE_LABEL as TYPE_LABEL,
  SellerAvailability,
  StagePill,
  formatSellerDate,
} from '@/components/SellerBadges';
import { SellerStatusModal } from '@/components/SellerStatusModal';
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
/* labels                                                                      */
/* -------------------------------------------------------------------------- */

const STAGE_FILTER_LABEL: Record<string, string> = {
  PENDING: 'Pending (incomplete)',
  SUBMITTED: 'Submitted (ready for review)',
};

/* -------------------------------------------------------------------------- */
/* URL <-> filters                                                             */
/* -------------------------------------------------------------------------- */

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

/** Unknown or tampered values are ignored rather than sent to the server. */
function filtersFromParams(params: URLSearchParams): SellerListFilters {
  const search = params.get('search')?.trim().slice(0, 60) ?? '';
  const sellerType = pick(params.get('type'), SELLER_TYPES);
  const onboardingStatus = pick(params.get('onboarding'), ONBOARDING_STATUSES);
  const stage = pick(params.get('stage'), STAGE_FILTERS);
  const active = params.get('active');
  return {
    ...(search ? { search } : {}),
    ...(sellerType ? { sellerType } : {}),
    ...(onboardingStatus ? { onboardingStatus } : {}),
    ...(active === 'true' || active === 'false' ? { isActive: active === 'true' } : {}),
    ...(stage ? { stage } : {}),
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
            label="Onboarding"
            value={filters.onboardingStatus ?? ''}
            onChange={(value) => setParam('onboarding', value)}
            options={ONBOARDING_STATUSES.map((status) => ({ value: status, label: ONBOARDING_LOOK[status]?.label ?? status }))}
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
          <FilterSelect
            label="Stage"
            value={filters.stage ?? ''}
            onChange={(value) => setParam('stage', value)}
            options={STAGE_FILTERS.map((stage) => ({ value: stage, label: STAGE_FILTER_LABEL[stage] ?? stage }))}
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
                    <Th>Onboarding</Th>
                    <Th>Stage</Th>
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
        <OnboardingPill status={row.onboardingStatus} />
      </Td>
      <Td>
        <StagePill stage={row.stage} />
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
          `${body.name} was created. Onboarding is pending — it cannot take orders until its onboarding is approved.` +
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
      subtitle="Creates the seller with onboarding PENDING and its owner's login. Nothing is approved automatically."
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
            <Field label="Owner's mobile" required hint="Used to sign in to the Seller Panel with OTP">
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
