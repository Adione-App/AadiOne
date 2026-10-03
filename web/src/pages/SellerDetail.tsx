/**
 * Seller detail — /sellers/:id (V2). Tabs (?tab=): Overview, Onboarding,
 * Availability, Categories and Products (read-only — the seller manages
 * them), Orders
 * (SELLER_ORDER_READ_OWN), Earnings (SETTLEMENT_READ), Commission
 * (COMMISSION_MANAGE), Restaurant (restaurants only), Documents; an unknown
 * or unavailable tab falls back to Overview.
 *
 * Overview reads ONLY the masked admin overview, GET /admin/sellers/:id (PAN,
 * Aadhaar and the account number are masked there; no document links). The
 * Onboarding tab adds the document list — see SellerOnboardingTab.tsx for how
 * the unmasked review view is sanitised before anything is cached or shown.
 *
 * Edit: PATCH /admin/sellers/:id with changed fields only. Trading switch:
 * the shared SellerStatusModal (admin `isActive` only). Every seller —
 * Aadione included — is managed here the same way.
 */

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { SellerStaffRole, SellerType, type AdminSellerDetailDto, type AdminUpdateSellerRequest } from '@shared';
import { ApiRequestError } from '@/lib/api';
import {
  adminSellerKeys,
  formatCommissionBp,
  sellerErrorMessage,
  useSellerDetail,
  useSellerPermissions,
  useUpdateSeller,
} from '@/lib/sellers';
import {
  ActivePill,
  CLOSED_REASON_LABEL,
  DetailRow,
  OnboardingPill,
  SELLER_TYPE_LABEL,
  SellerAvailability,
  StagePill,
  formatSellerDate,
} from '@/components/SellerBadges';
import { SellerStatusModal } from '@/components/SellerStatusModal';
import { Button, EmptyState, ErrorBanner, Field, Icon, Modal, Panel, Pill, Spinner, Surface, inputClass } from '@/components/ui';
import SellerAvailabilityTab from './SellerAvailabilityTab';
import { SellerCategoriesTab, SellerEarningsTab } from './SellerCatalogTabs';
import SellerCommissionTab from './SellerCommissionTab';
import SellerListingsTab from './SellerListingsTab';
import SellerOnboardingTab from './SellerOnboardingTab';
import SellerOrdersTab from './SellerOrdersTab';
import SellerRestaurantTab from './SellerRestaurantTab';
import { SellerLoginPanel } from './SellerLoginPanel';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TabKey =
  | 'overview'
  | 'onboarding'
  | 'availability'
  | 'categories'
  | 'products'
  | 'orders'
  | 'earnings'
  | 'commission'
  | 'restaurant'
  | 'settlements'
  | 'documents'
  | 'login'
  | 'activity';
type TabAccess = { canCommission: boolean; canSellerOrders: boolean; canEarnings: boolean; canManage: boolean };
/**
 * Catalogue tabs (Categories, Products) are for inspection: every seller —
 * Aadione included — manages its own categories, subcategories and products
 * in the Seller Panel. Admin moderates products (Products page).
 */
const TABS: { key: TabKey; label: string; restaurantOnly?: boolean; needs?: keyof TabAccess }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'onboarding', label: 'Onboarding' },
  // Same permission as the page (SELLER_ONBOARDING_REVIEW).
  { key: 'products', label: 'Products' },
  { key: 'categories', label: 'Categories' },
  // GET /admin/seller-orders needs SELLER_ORDER_READ_OWN.
  { key: 'orders', label: 'Orders', needs: 'canSellerOrders' },
  { key: 'availability', label: 'Availability' },
  { key: 'restaurant', label: 'Restaurant', restaurantOnly: true },
  // Every commission route (read included) needs COMMISSION_MANAGE.
  { key: 'commission', label: 'Commission', needs: 'canCommission' },
  // GET /admin/sellers/:id/earnings and /admin/settlements need SETTLEMENT_READ.
  { key: 'earnings', label: 'Earnings', needs: 'canEarnings' },
  { key: 'settlements', label: 'Settlements', needs: 'canEarnings' },
  { key: 'documents', label: 'Documents' },
  // Login credentials and owner assignment need SELLER_MANAGE.
  { key: 'login', label: 'Login', needs: 'canManage' },
  { key: 'activity', label: 'Activity' },
];

/** Which tabs this seller + this admin get. */
const visibleTabs = (isRestaurant: boolean, access: TabAccess) =>
  TABS.filter((t) => (!t.restaurantOnly || isRestaurant) && (!t.needs || access[t.needs]));

/** The tab named in ?tab=, if it is available here; otherwise Overview. (`listings` was the old Products tab.) */
function tabFrom(value: string | null, isRestaurant: boolean, access: TabAccess): TabKey {
  const wanted = value === 'listings' ? 'products' : value;
  return visibleTabs(isRestaurant, access).find((t) => t.key === wanted)?.key ?? 'overview';
}

/* -------------------------------------------------------------------------- */
/* shared bits                                                                 */
/* -------------------------------------------------------------------------- */

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex items-start justify-between gap-3 rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-600"
    >
      <span>{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss" className="text-brand-600/70 hover:text-brand-600">
        <Icon name="close" className="h-4 w-4" />
      </button>
    </div>
  );
}

const orDash = (value: string | null | undefined): string => (value && value.trim() ? value : '—');


export function formatSettlementCycle(hours: number): string {
  if (hours === 24) return 'Daily';
  if (hours === 168) return 'Weekly';
  if (hours === 360) return 'Every 15 days';
  return hours % 24 === 0 ? `Every ${hours / 24} days` : `Every ${hours} hours`;
}

/* -------------------------------------------------------------------------- */
/* page                                                                        */
/* -------------------------------------------------------------------------- */

/** Everything on the page belongs to one seller: a new :id remounts it, so a
 * notice, open dialog or tab filter never carries over to another seller. */
export default function SellerDetailPage() {
  const { id = '' } = useParams();
  return <SellerDetailView key={id} />;
}

function SellerDetailView() {
  const { id = '' } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const perms = useSellerPermissions();
  const validId = UUID_PATTERN.test(id);
  const detail = useSellerDetail(id, perms.canRead && validId);

  const [editing, setEditing] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isRestaurant = detail.data?.sellerType === SellerType.RESTAURANT;
  const tab = tabFrom(params.get('tab'), isRestaurant, perms);
  const setTab = (next: TabKey) =>
    setParams(next === 'overview' ? {} : { tab: next }, { replace: true, state: location.state });

  // "← Sellers" returns to the list exactly as it was filtered.
  const listSearch = (location.state as { listSearch?: string } | null)?.listSearch ?? '';
  const back = (
    <Link to={`/sellers${listSearch}`} className="inline-flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900">
      <span aria-hidden="true">←</span> Sellers
    </Link>
  );

  if (!perms.canRead) {
    return <EmptyState title="You don't have access to seller management." hint="Ask an administrator if you need it." />;
  }

  const notFound =
    !validId ||
    (detail.error instanceof ApiRequestError && (detail.error.status === 404 || detail.error.status === 400));
  if (notFound) {
    return (
      <div className="space-y-4">
        {back}
        <EmptyState title="Seller not found" hint="It may have been removed, or the link is wrong." />
      </div>
    );
  }

  if (detail.isPending) {
    return (
      <div className="space-y-4">
        {back}
        <Spinner label="Loading seller…" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorBanner message={sellerErrorMessage(detail.error, 'Could not load this seller.')} />
        <Button variant="secondary" onClick={() => void detail.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const seller = detail.data;

  return (
    <div className="space-y-5">
      {back}
      {notice && <Notice message={notice} onDismiss={() => setNotice(null)} />}

      <SellerHeader
        seller={seller}
        canManage={perms.canManage}
        onEdit={() => setEditing(true)}
        onToggleStatus={() => setStatusOpen(true)}
      />

      <div role="tablist" aria-label="Seller sections" className="-mx-4 flex gap-1 overflow-x-auto border-b border-gray-200 px-4 sm:mx-0 sm:px-0">
        {visibleTabs(isRestaurant, perms).map((item) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-semibold transition sm:px-4 ${
              tab === item.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Only the open tab is mounted, so a tab's request is made only when it is opened. */}
      {tab === 'overview' && (
        <OverviewTab seller={seller} canCommission={perms.canCommission} canManage={perms.canManage} />
      )}
      {tab === 'onboarding' && <SellerOnboardingTab seller={seller} onNotice={setNotice} />}
      {tab === 'availability' && <SellerAvailabilityTab seller={seller} />}
      {tab === 'categories' && <SellerCategoriesTab seller={seller} />}
      {tab === 'products' && (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-xl border border-info-500/20 bg-info-50 px-3.5 py-2.5 text-sm text-gray-700">
            <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-info-500" />
            <span>
              {seller.name} creates and edits its products, prices and stock in the <span className="font-semibold">Seller Panel</span>
. New products reach customers
              after Product Approvals. From here you can inspect them and disable one if needed.
            </span>
          </p>
          <SellerListingsTab seller={seller} />
        </div>
      )}
      {tab === 'orders' && perms.canSellerOrders && <SellerOrdersTab seller={seller} />}
      {tab === 'earnings' && perms.canEarnings && <SellerEarningsTab seller={seller} section="earnings" />}
      {tab === 'settlements' && perms.canEarnings && <SellerEarningsTab seller={seller} section="settlements" />}
      {tab === 'login' && perms.canManage && <SellerLoginTab seller={seller} onNotice={setNotice} />}
      {tab === 'activity' && <SellerActivityTab sellerId={seller.id} />}
      {tab === 'commission' && perms.canCommission && (
        <SellerCommissionTab seller={seller} canWrite={perms.canCommission} onNotice={setNotice} />
      )}
      {tab === 'restaurant' && isRestaurant && <SellerRestaurantTab seller={seller} />}
      {tab === 'documents' && <SellerOnboardingTab seller={seller} onNotice={setNotice} section="documents" />}

      {editing && (
        <EditSellerModal
          seller={seller}
          onClose={() => setEditing(false)}
          onSaved={(message) => {
            setEditing(false);
            setNotice(message);
          }}
        />
      )}

      {statusOpen && (
        <SellerStatusModal
          seller={seller}
          onClose={() => setStatusOpen(false)}
          onDone={(message) => {
            setStatusOpen(false);
            setNotice(message);
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* header                                                                      */
/* -------------------------------------------------------------------------- */

function SellerHeader({
  seller,
  canManage,
  onEdit,
  onToggleStatus,
}: {
  seller: AdminSellerDetailDto;
  canManage: boolean;
  onEdit: () => void;
  onToggleStatus: () => void;
}) {
  return (
    <Surface className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-gray-900">{seller.name}</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            {seller.code} · {SELLER_TYPE_LABEL[seller.sellerType] ?? seller.sellerType}
          </p>
          <div className="mt-3 flex flex-wrap items-start gap-x-5 gap-y-2 text-xs text-gray-500">
            <span className="flex items-center gap-2">
              Onboarding <OnboardingPill status={seller.onboardingStatus} />
            </span>
            <span className="flex items-center gap-2">
              Stage <StagePill stage={seller.stage} />
            </span>
            <span className="flex items-center gap-2">
              Admin switch <ActivePill isActive={seller.isActive} />
            </span>
            <span className="flex items-start gap-2">
              <span className="pt-1">Orders</span>
              <SellerAvailability
                facts={{
                  isActive: seller.isActive,
                  isAcceptingOrders: seller.isAcceptingOrders,
                  acceptingOrdersNow: seller.availability.acceptingOrdersNow,
                  isOpenNow: seller.availability.isOpenNow,
                  closedReason: seller.availability.closedReason,
                  onboardingStatus: seller.onboardingStatus,
                }}
              />
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
              <>
                <Button variant="secondary" onClick={onEdit}>
                  <Icon name="edit" className="h-4 w-4" />
                  Edit Seller
                </Button>
                <Button variant={seller.isActive ? 'ghost' : 'soft'} onClick={onToggleStatus}>
                  {seller.isActive ? 'Deactivate' : 'Activate'}
                </Button>
              </>
          )}
        </div>
      </div>
    </Surface>
  );
}

/* -------------------------------------------------------------------------- */
/* overview                                                                    */
/* -------------------------------------------------------------------------- */

function OverviewTab({
  seller,
  canCommission,
  canManage,
}: {
  seller: AdminSellerDetailDto;
  canCommission: boolean;
  canManage: boolean;
}) {
  const owners = seller.staff.filter((member) => member.role === SellerStaffRole.OWNER);
  const others = seller.staff.filter((member) => member.role !== SellerStaffRole.OWNER);
  const docs = seller.documentSummary;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel title="Business">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Seller name">{seller.name}</DetailRow>
          <DetailRow label="Seller type">{SELLER_TYPE_LABEL[seller.sellerType] ?? seller.sellerType}</DetailRow>
          <DetailRow label="Seller code">{seller.code}</DetailRow>
          {seller.sellerType === 'RESTAURANT' && (
            <DetailRow label="Restaurant profile">{seller.restaurantProfile ? 'Added' : 'Not added yet'}</DetailRow>
          )}
          <DetailRow label="Business phone">{orDash(seller.phone)}</DetailRow>
          <DetailRow label="Created">{formatSellerDate(seller.createdAt)}</DetailRow>
        </dl>
      </Panel>

      <Panel title="Owner / Contact">
        {owners.length === 0 && others.length === 0 && !seller.profile ? (
          <p className="text-sm text-gray-500">No owner or contact details yet.</p>
        ) : (
          <dl className="divide-y divide-gray-100">
            {owners.map((owner) => (
              <DetailRow key={owner.id} label="Owner login">
                {orDash(owner.fullName)} · {owner.mobile}
                {!owner.isActive && <span className="ml-1 text-xs text-gray-500">(inactive)</span>}
              </DetailRow>
            ))}
            {seller.profile && (
              <>
                <DetailRow label="Owner (business profile)">{seller.profile.ownerFullName}</DetailRow>
                <DetailRow label="Owner mobile">{seller.profile.ownerMobile}</DetailRow>
                <DetailRow label="Owner email">{orDash(seller.profile.ownerEmail)}</DetailRow>
              </>
            )}
            {others.map((member) => (
              <DetailRow key={member.id} label={`Staff (${member.role.toLowerCase()})`}>
                {orDash(member.fullName)} · {member.mobile}
              </DetailRow>
            ))}
          </dl>
        )}
      </Panel>

      <Panel title="Address">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Address">{seller.addressLine}</DetailRow>
          <DetailRow label="City">{seller.city}</DetailRow>
          <DetailRow label="State">{seller.state}</DetailRow>
          <DetailRow label="Pincode">{seller.pincode}</DetailRow>
          <DetailRow label="Location">
            {seller.latitude.toFixed(5)}, {seller.longitude.toFixed(5)}
          </DetailRow>
        </dl>
      </Panel>

      <Panel title="Onboarding">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Status">
            <OnboardingPill status={seller.onboardingStatus} />
          </DetailRow>
          <DetailRow label="Stage">
            <StagePill stage={seller.stage} />
          </DetailRow>
          <DetailRow label="Application">{seller.isComplete ? 'Complete' : 'Incomplete'}</DetailRow>
          <DetailRow label="Documents">
            {docs.total === 0
              ? 'None yet'
              : `${docs.total} (${docs.pending} pending, ${docs.verified} verified, ${docs.rejected} rejected)`}
          </DetailRow>
        </dl>
        {seller.lastRejectionReason && (
          <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm">
            <p className="font-medium text-gray-800">
              Last rejection{seller.lastRejectedAt ? ` · ${formatSellerDate(seller.lastRejectedAt)}` : ''}
            </p>
            <p className="mt-0.5 text-gray-600">{seller.lastRejectionReason}</p>
          </div>
        )}
      </Panel>

      <Panel title="Availability">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Admin switch">
            <ActivePill isActive={seller.isActive} />
          </DetailRow>
          <DetailRow label="Seller's accepting-orders switch">
            <Pill tone={seller.isAcceptingOrders ? 'brand' : 'gray'}>{seller.isAcceptingOrders ? 'On' : 'Off'}</Pill>
          </DetailRow>
          <DetailRow label="Right now">
            {seller.availability.isOpenNow
              ? 'Open'
              : seller.availability.closedReason
                ? `Closed — ${CLOSED_REASON_LABEL[seller.availability.closedReason] ?? seller.availability.closedReason}`
                : 'Closed'}
          </DetailRow>
          {seller.availability.nextOpenText && <DetailRow label="Next opening">{seller.availability.nextOpenText}</DetailRow>}
          <DetailRow label="Weekly hours">{seller.availability.hoursConfigured ? 'Set' : 'Not set (no hour restriction)'}</DetailRow>
          <DetailRow label="Timezone">{seller.availability.timezone}</DetailRow>
        </dl>
      </Panel>

      <Panel title="Commission / Settlement">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Default commission">{formatCommissionBp(seller.defaultCommissionBp)}</DetailRow>
          <DetailRow label="Settlement cycle">{formatSettlementCycle(seller.settlementCycleHours)}</DetailRow>
        </dl>
        {canCommission && (
          <p className="mt-2 text-xs text-gray-500">Product and category commission rules are on the Commission tab.</p>
        )}
      </Panel>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* edit                                                                        */
/* -------------------------------------------------------------------------- */

interface EditForm {
  name: string;
  phone: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  latitude: string;
  longitude: string;
}

function EditSellerModal({
  seller,
  onClose,
  onSaved,
}: {
  seller: AdminSellerDetailDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const update = useUpdateSeller();
  const [form, setForm] = useState<EditForm>({
    name: seller.name,
    phone: seller.phone ?? '',
    addressLine: seller.addressLine,
    city: seller.city,
    state: seller.state,
    pincode: seller.pincode,
    latitude: String(seller.latitude),
    longitude: String(seller.longitude),
  });
  const [errors, setErrors] = useState<Partial<Record<keyof EditForm, string>>>({});
  const [info, setInfo] = useState<string | null>(null);

  const set = (key: keyof EditForm) => (value: string) => {
    setInfo(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  /** Same limits as the backend's updateSellerSchema. */
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const next: Partial<Record<keyof EditForm, string>> = {};
    const text = (key: 'name' | 'addressLine' | 'city' | 'state', label: string, max: number) => {
      const value = form[key].trim();
      if (value.length < 2) next[key] = `${label} is required.`;
      else if (value.length > max) next[key] = `${label} must be at most ${max} characters.`;
      return value;
    };
    const name = text('name', 'Seller name', 120);
    const addressLine = text('addressLine', 'Address', 300);
    const city = text('city', 'City', 80);
    const state = text('state', 'State', 80);
    const pincode = form.pincode.trim();
    if (!/^\d{6}$/.test(pincode)) next.pincode = 'Pincode must be 6 digits.';
    const phone = form.phone.trim();
    if (phone && (phone.length < 10 || phone.length > 15)) next.phone = 'Phone must be 10–15 characters.';
    const latitude = Number(form.latitude);
    const longitude = Number(form.longitude);
    if (form.latitude.trim() === '' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      next.latitude = 'Latitude must be between -90 and 90.';
    }
    if (form.longitude.trim() === '' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      next.longitude = 'Longitude must be between -180 and 180.';
    }
    if (!next.latitude && !next.longitude && latitude === 0 && longitude === 0) {
      next.latitude = 'Those coordinates look wrong (0, 0).';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    // Only what changed. Coordinates travel as a pair.
    const body: AdminUpdateSellerRequest = {};
    if (name !== seller.name) body.name = name;
    if ((phone || null) !== seller.phone) body.phone = phone || null;
    if (addressLine !== seller.addressLine) body.addressLine = addressLine;
    if (city !== seller.city) body.city = city;
    if (state !== seller.state) body.state = state;
    if (pincode !== seller.pincode) body.pincode = pincode;
    if (latitude !== seller.latitude || longitude !== seller.longitude) {
      body.latitude = latitude;
      body.longitude = longitude;
    }

    if (Object.keys(body).length === 0) {
      setInfo('No changes to save.');
      return;
    }
    update.mutate({ sellerId: seller.id, body }, { onSuccess: (saved) => onSaved(`${saved.name} was updated.`) });
  };

  const input = (key: keyof EditForm, props: { inputMode?: 'numeric' | 'decimal' | 'tel' } = {}) => (
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
      title="Edit seller"
      subtitle="Basic details only. Type, onboarding, status and commission are changed elsewhere."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        {update.isError && <ErrorBanner message={sellerErrorMessage(update.error, 'Could not save the seller.')} />}
        {info && <p className="rounded-xl bg-gray-50 px-3.5 py-2.5 text-sm text-gray-600">{info}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Seller name" required>
            {input('name')}
          </Field>
          <Field label="Business phone" hint="Optional. Leave blank to remove.">
            {input('phone', { inputMode: 'tel' })}
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
            {input('pincode', { inputMode: 'numeric' })}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Latitude" required>
            {input('latitude', { inputMode: 'decimal' })}
          </Field>
          <Field label="Longitude" required>
            {input('longitude', { inputMode: 'decimal' })}
          </Field>
        </div>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* login                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The seller team's Seller Panel sign-in. A seller with no owner account
 * (e.g. one created before owner accounts were required) first gets one here
 * (POST /admin/sellers/:id/owner — refused if an owner already exists);
 * then the existing panel issues email + temporary-password credentials.
 */
function SellerLoginTab({ seller, onNotice }: { seller: AdminSellerDetailDto; onNotice: (message: string) => void }) {
  const queryClient = useQueryClient();
  const owner = seller.staff.find((member) => member.role === SellerStaffRole.OWNER && member.isActive);
  const [mobile, setMobile] = useState('');
  const [name, setName] = useState('');
  const assign = useMutation({
    mutationFn: () => api.post(`/admin/sellers/${seller.id}/owner`, { ownerMobile: mobile.trim(), ownerFullName: name.trim() }),
    onSuccess: () => {
      onNotice(`${name.trim()} is now the owner of ${seller.name}. Issue their Seller Panel login below.`);
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.detail(seller.id) });
    },
  });

  if (!owner) {
    const valid = /^\d{10}$/.test(mobile.replace(/\D/g, '').slice(-10)) && name.trim().length >= 2;
    return (
      <Panel title="Seller Panel access">
        <div className="max-w-lg space-y-4">
          <p className="text-sm text-gray-600">
            {seller.name} has no owner account yet, so nobody can sign in to its Seller Panel. Add the person who runs it — they then manage
            products, stock, orders and availability there, like every other seller.
          </p>
          <ErrorBanner message={assign.isError ? sellerErrorMessage(assign.error, 'Could not add the owner.') : null} />
          <Field label="Owner full name" required>
            <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className={inputClass} />
          </Field>
          <Field label="Owner mobile number" hint="They can sign in with an OTP to this number." required>
            <input value={mobile} inputMode="tel" maxLength={15} onChange={(event) => setMobile(event.target.value)} className={inputClass} placeholder="10-digit mobile" />
          </Field>
          <Button disabled={!valid || assign.isPending} onClick={() => assign.mutate()}>
            {assign.isPending ? 'Adding…' : 'Add owner account'}
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SellerLoginPanel sellerId={seller.id} suggestedEmail={seller.profile?.ownerEmail ?? null} />
      <Panel title="Owner">
        <dl className="divide-y divide-gray-100">
          <DetailRow label="Name">{orDash(owner.fullName)}</DetailRow>
          <DetailRow label="Mobile">{owner.mobile}</DetailRow>
          <DetailRow label="Since">{formatSellerDate(owner.createdAt)}</DetailRow>
        </dl>
      </Panel>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* activity                                                                    */
/* -------------------------------------------------------------------------- */

type ActivityItem = { id: string; at: string; by: 'You' | 'Your team' | 'AdiOne' | 'System' } & (
  | { kind: 'ORDER'; orderNumber: string; toStatus: string; reason: string | null }
  | { kind: 'STOCK'; productName: string; delta: number; reason: string; note: string | null }
  | { kind: 'PRICE'; productName: string; fromPaise: number | null; toPaise: number | null }
  | { kind: 'VISIBILITY'; productName: string; onSale: boolean }
  | { kind: 'ADMIN'; productName: string; action: 'DISABLED' | 'ENABLED'; reason: string | null }
);

const ORDER_VERB: Record<string, string> = {
  ACCEPTED: 'accepted',
  PREPARING: 'started preparing',
  READY_FOR_PICKUP: 'marked ready for pickup',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

/** Seen from the admin side: the seller team, Aadione (you or another admin), or the system. */
const actorName = (by: ActivityItem['by']) => (by === 'Your team' ? 'Seller team' : by === 'AdiOne' ? 'Aadione' : by);

function describeActivity(item: ActivityItem): { text: string; detail: string | null } {
  switch (item.kind) {
    case 'ORDER':
      return { text: `${actorName(item.by)} ${ORDER_VERB[item.toStatus] ?? item.toStatus.toLowerCase()} order #${item.orderNumber}`, detail: item.reason };
    case 'STOCK':
      return { text: `${actorName(item.by)} ${item.delta >= 0 ? 'added' : 'removed'} ${Math.abs(item.delta)} × ${item.productName}`, detail: item.note };
    case 'PRICE':
      return {
        text: `${actorName(item.by)} changed the price of ${item.productName}`,
        detail: item.fromPaise !== null && item.toPaise !== null ? `${formatPaise(item.fromPaise)} → ${formatPaise(item.toPaise)}` : null,
      };
    case 'VISIBILITY':
      return { text: `${actorName(item.by)} ${item.onSale ? 'put' : 'took'} ${item.productName} ${item.onSale ? 'on sale' : 'off sale'}`, detail: null };
    case 'ADMIN':
      return { text: `Aadione ${item.action === 'DISABLED' ? 'disabled' : 'enabled'} ${item.productName}`, detail: item.reason };
  }
}

/** GET /admin/sellers/:id/activity — the same feed the seller dashboard shows. */
function SellerActivityTab({ sellerId }: { sellerId: string }) {
  const activity = useQuery({
    queryKey: ['admin', 'sellers', sellerId, 'activity'],
    queryFn: () => api.get<ActivityItem[]>(`/admin/sellers/${sellerId}/activity?limit=50`),
  });
  if (activity.isPending) return <Spinner label="Loading activity…" />;
  if (activity.isError) return <ErrorBanner message={sellerErrorMessage(activity.error, 'Could not load activity.')} />;
  if (activity.data.length === 0) {
    return <EmptyState title="No activity yet" hint="Order actions, stock and price changes, and Aadione moderation appear here." />;
  }
  return (
    <Panel title="Recent activity">
      <ul className="divide-y divide-gray-100">
        {activity.data.map((item) => {
          const line = describeActivity(item);
          return (
            <li key={item.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
              <span className="min-w-0">
                <span className="block text-gray-900">{line.text}</span>
                {line.detail && <span className="block truncate text-xs text-gray-500">{line.detail}</span>}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{formatSellerDate(item.at)}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
