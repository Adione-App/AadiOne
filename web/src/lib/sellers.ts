/**
 * Admin seller management (V2) — the typed API calls, query keys and hooks
 * behind the Sellers pages. Every call goes through the ADMIN session client
 * (`api`, refresh key "adione.refresh"); the seller panel's own client
 * (seller/sellerApi.ts, "adione.seller.refresh") is never used here.
 *
 * Every key starts with ADMIN_SELLERS_ROOT ("admin-sellers"), distinct from
 * the seller panel's "seller" root and every other admin cache, so a write
 * here can invalidate exactly the seller caches and nothing else.
 *
 * The backend is the authority on permission: the helpers below only decide
 * which controls to SHOW.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApprovalStatus,
  DocumentStatus,
  Permission,
  SellerType,
  roleHasPermission,
  type AdminReviewSellerApplicationRequest,
  type AdminReviewSellerVerificationRequest,
  type AdminSellerApplicationDto,
  type AdminSellerDetailDto,
  type AdminSellerListRowDto,
  type AdminSetSellerStatusRequest,
  type AdminVerifyBankDetailRequest,
  type CreateSellerRequest,
  type CursorPage,
  type AdminSellerOnboardingDocumentDto,
  type AdminSellerOnboardingSummaryDto,
  type ProductApprovalBatchSummaryDto,
  type SellerClosedReason,
  type SellerHoursDto,
  type SellerLifecycleFilter,
  type SellerLifecycleStatus,
  type SellerListingDto,
  type SellerOnboardingStage,
  type SellerOrderListRowDto,
  type SellerOrderStatus,
  type SellerProductDto,
  type RevealedDocumentNumberDto,
  type UploadSellerDocumentRequest,
} from '@shared';
import { api, ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { retryServerErrorsOnce } from '@/lib/productApprovals';

/* -------------------------------------------------------------------------- */
/* list filters                                                               */
/* -------------------------------------------------------------------------- */

/** Every seller type, in the order the admin panel offers them. */
export const SELLER_TYPES: readonly SellerType[] = [
  SellerType.GROCERY,
  SellerType.FASHION,
  SellerType.ELECTRONICS,
  SellerType.BEAUTY,
  SellerType.HOME,
  SellerType.PHARMACY,
  SellerType.RESTAURANT,
  SellerType.CAFE,
  SellerType.SPORTS,
  SellerType.BOOKS,
  SellerType.KIDS,
  SellerType.AUTOMOTIVE,
  SellerType.PETS,
  SellerType.SERVICES,
  SellerType.OTHER,
];
export const ONBOARDING_STATUSES: readonly ApprovalStatus[] = [
  ApprovalStatus.PENDING,
  ApprovalStatus.APPROVED,
  ApprovalStatus.REJECTED,
];
/** The list's stage filter offers the two PENDING sub-stages; APPROVED and
 * REJECTED are already the onboarding filter. */
export const STAGE_FILTERS: readonly SellerOnboardingStage[] = ['PENDING', 'SUBMITTED'];

/** The lifecycle stages the Sellers list filters by — the two gates in order. */
export const LIFECYCLE_FILTERS: readonly SellerLifecycleFilter[] = [
  'APPLICATION_PENDING',
  'APPLICATION_REJECTED',
  'ONBOARDING_PENDING',
  'ONBOARDING_CHANGES_REQUIRED',
  'ONBOARDING_PENDING_REVIEW',
  'ACTIVE',
  'SUSPENDED',
  'ONBOARDING_REJECTED',
];

/** Everything the list can be filtered by. Sent to the server as-is. */
export interface SellerListFilters {
  search?: string;
  sellerType?: SellerType;
  onboardingStatus?: ApprovalStatus;
  isActive?: boolean;
  stage?: SellerOnboardingStage;
  lifecycle?: SellerLifecycleFilter;
}

export const SELLER_PAGE_SIZE = 25;

/** GET /admin/sellers with the filters and cursor as query parameters. */
export function sellerListPath(filters: SellerListFilters, cursor: string | null, limit = SELLER_PAGE_SIZE): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (filters.search) query.set('search', filters.search);
  if (filters.sellerType) query.set('sellerType', filters.sellerType);
  if (filters.onboardingStatus) query.set('onboardingStatus', filters.onboardingStatus);
  if (filters.isActive !== undefined) query.set('isActive', String(filters.isActive));
  if (filters.stage) query.set('stage', filters.stage);
  if (filters.lifecycle) query.set('lifecycle', filters.lifecycle);
  if (cursor) query.set('cursor', cursor);
  return `/admin/sellers?${query.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* API — exact backend routes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /admin/sellers/:id/availability — the seller's effective availability
 * (seller-availability.service.ts `getAvailability`; no shared DTO). `hours`
 * holds only the days the seller has saved; with a schedule configured, a
 * missing day is closed, and with none there is no hour restriction.
 */
export interface AdminSellerAvailability {
  sellerId: string;
  sellerName: string;
  sellerType: SellerType;
  timezone: string;
  isActive: boolean;
  isAcceptingOrders: boolean;
  isOpenNow: boolean;
  acceptingOrdersNow: boolean;
  closedReason: SellerClosedReason | null;
  nextOpenText: string | null;
  hoursConfigured: boolean;
  hours: SellerHoursDto[];
  upcomingClosures: { id: string; date: string; reason: string | null }[];
}

/**
 * GET /admin/restaurants/:sellerId — restaurant.service.ts
 * `getRestaurantForAdmin` (no shared DTO). Only the fields the panel shows are
 * typed here; the rest of the response is never rendered.
 */
export interface AdminRestaurantMenuItem {
  sellerListingId: string;
  productId: string;
  name: string;
  variantName: string;
  mrpPaise: number;
  pricePaise: number;
  inStock: boolean;
  isAvailable: boolean;
  approvalStatus: ApprovalStatus;
}
export interface AdminRestaurantSection {
  id: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
  items: AdminRestaurantMenuItem[];
}
export interface AdminRestaurantDetail {
  restaurant: {
    sellerId: string;
    name: string;
    cuisine: string[];
    isVegOnly: boolean;
    avgPrepMins: number | null;
    isOpen: boolean;
    isActive: boolean;
    onboardingStatus: ApprovalStatus;
  };
  sections: AdminRestaurantSection[];
}

/**
 * GET /admin/sellers/:id/commission — commission-management.service.ts
 * `getCommissionConfig` (no shared DTO). Resolution at order time is
 * PRODUCT rule -> exact CATEGORY rule -> seller default; only ACTIVE rules
 * are listed here.
 */
export interface AdminCommissionConfig {
  sellerId: string;
  sellerName: string;
  /** Always present (a required column; 0 = no default commission). */
  defaultCommissionBp: number;
  categoryRules: { ruleId: string; categoryId: string; categoryName: string | null; rateBp: number; since: string }[];
  productRules: { ruleId: string; productId: string; productName: string | null; rateBp: number; since: string }[];
}

/** GET /admin/sellers/:id/commission/history — every rule row, newest first
 * (inactive rows are replaced/removed rules). Not paginated; no names and no
 * actor; seller-default changes are not rules and are not listed. */
export interface AdminCommissionHistoryRow {
  ruleId: string;
  scope: 'PRODUCT' | 'CATEGORY';
  productId: string | null;
  categoryId: string | null;
  rateBp: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CommissionRuleScope = 'categories' | 'products';

/**
 * A GET /admin/seller-orders row as seller management keeps it: the endpoint
 * also returns the customer's name and mobile (it backs order operations), but
 * this view has no use for customer contact details, so they are dropped
 * before anything is cached or rendered.
 */
export type AdminSellerOrderRow = Pick<
  SellerOrderListRowDto,
  'id' | 'orderId' | 'orderNumber' | 'status' | 'statusLabel' | 'subtotalPaise' | 'itemCount' | 'createdAt'
>;

export const SELLER_ORDERS_PAGE_SIZE = 10;

const toAdminSellerOrderRow = (row: SellerOrderListRowDto): AdminSellerOrderRow => ({
  id: row.id,
  orderId: row.orderId,
  orderNumber: row.orderNumber,
  status: row.status,
  statusLabel: row.statusLabel,
  subtotalPaise: row.subtotalPaise,
  itemCount: row.itemCount,
  createdAt: row.createdAt,
});

/** Backend commission limits (commission.routes.ts rateBody): integer bp 0–10 000. */
export const COMMISSION_BP_MAX = 10_000;

/** 1250 -> "12.5%"; 500 -> "5%". Display only — never used for money. */
export function formatCommissionBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  if (fraction === 0) return `${whole}%`;
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`;
}

/**
 * "12.5" -> 1250, parsed as text so no floating point is involved. At most two
 * decimals (1 bp precision); null for anything that is not a number in 0–100.
 */
export function percentToBp(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp <= COMMISSION_BP_MAX ? bp : null;
}

/** POST /admin/sellers answers with ids only (no shared DTO for it). */
export interface CreateSellerResponse {
  sellerId: string;
  ownerUserId: string;
  /** False when an existing customer account was made the owner. */
  isNewOwnerAccount: boolean;
}

/** GET /admin/sellers/:id/onboarding/summary — PAN, Aadhaar and the account
 * number MASKED, documents as metadata only (no link field at all). */
export function getAdminSellerOnboardingSummary(sellerId: string): Promise<AdminSellerOnboardingSummaryDto> {
  return api.get<AdminSellerOnboardingSummaryDto>(`/admin/sellers/${sellerId}/onboarding/summary`);
}

export const sellersApi = {
  list: (filters: SellerListFilters, cursor: string | null) =>
    api.get<CursorPage<AdminSellerListRowDto>>(sellerListPath(filters, cursor)),
  /** Masked overview (PAN, Aadhaar, bank account never in full). */
  detail: (sellerId: string) => api.get<AdminSellerDetailDto>(`/admin/sellers/${sellerId}`),
  create: (body: CreateSellerRequest) => api.post<CreateSellerResponse>('/admin/sellers', body),
  setStatus: (sellerId: string, body: AdminSetSellerStatusRequest) =>
    api.patch<AdminSellerDetailDto>(`/admin/sellers/${sellerId}/status`, body),

  /** The onboarding read — masked, no document links. (The older unmasked
   * GET …/onboarding review view is deliberately not called from this app.) */
  onboardingSummary: (sellerId: string) => getAdminSellerOnboardingSummary(sellerId),
  /** "Show" — the full number of one document (audited server-side; never cached). */
  revealDocumentNumber: (sellerId: string, documentId: string) =>
    api.get<RevealedDocumentNumberDto>(`/admin/sellers/${sellerId}/onboarding/documents/${documentId}/number`),
  /** The uploaded PDF, fetched with the admin session (no public link exists). */
  documentFile: (sellerId: string, documentId: string) =>
    api.getBlob(`/admin/sellers/${sellerId}/onboarding/documents/${documentId}/file`),
  /** Send back the `id` and `updatedAt` of the bank detail that was reviewed;
   * a 409 means it changed since and must be reviewed again. */
  verifyBankDetail: (sellerId: string, body: AdminVerifyBankDetailRequest) =>
    api.patch<AdminSellerOnboardingSummaryDto>(`/admin/sellers/${sellerId}/onboarding/bank-detail/verify`, body),

  /** Document decision. The response is the UNMASKED review view, so it is
   * discarded — callers re-read through the sanitised queries instead. */
  reviewDocument: async (
    sellerId: string,
    documentId: string,
    body: { status: typeof DocumentStatus.VERIFIED | typeof DocumentStatus.REJECTED; rejectionReason?: string },
  ): Promise<void> => {
    await api.patch<unknown>(`/admin/sellers/${sellerId}/onboarding/documents/${documentId}/review`, body);
  },

  /** Seller Applications (Gate 1). No status = every self-signup application. */
  applications: (status: SellerLifecycleStatus | null, cursor: string | null, limit = SELLER_PAGE_SIZE) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (status) query.set('status', status);
    if (cursor) query.set('cursor', cursor);
    return api.get<CursorPage<AdminSellerApplicationDto>>(`/admin/sellers/applications?${query.toString()}`);
  },
  /** Gate 1 decision — answers with the (masked) seller overview. */
  reviewApplication: (sellerId: string, body: AdminReviewSellerApplicationRequest) =>
    api.patch<AdminSellerDetailDto>(`/admin/sellers/${sellerId}/application/review`, body),
  /** Gate 2 decision — answers with the (masked) seller overview. */
  reviewVerification: (sellerId: string, body: AdminReviewSellerVerificationRequest) =>
    api.patch<AdminSellerDetailDto>(`/admin/sellers/${sellerId}/verification/review`, body),

  /** Read-only effective availability (admin route — never /seller/availability). */
  availability: (sellerId: string) => api.get<AdminSellerAvailability>(`/admin/sellers/${sellerId}/availability`),
  /** Read-only restaurant profile + full menu. RESTAURANT sellers only (404 otherwise). */
  restaurant: (sellerId: string) => api.get<AdminRestaurantDetail>(`/admin/restaurants/${sellerId}`),

  /** Commission (all COMMISSION_MANAGE). Rates are integer basis points. */
  commission: (sellerId: string) => api.get<AdminCommissionConfig>(`/admin/sellers/${sellerId}/commission`),
  commissionHistory: (sellerId: string) =>
    api.get<AdminCommissionHistoryRow[]>(`/admin/sellers/${sellerId}/commission/history`),
  setDefaultCommission: (sellerId: string, rateBp: number) =>
    api.put<AdminCommissionConfig>(`/admin/sellers/${sellerId}/commission/default`, { rateBp }),
  setCommissionRule: (sellerId: string, scope: CommissionRuleScope, targetId: string, rateBp: number) =>
    api.put<unknown>(`/admin/sellers/${sellerId}/commission/${scope}/${targetId}`, { rateBp }),
  removeCommissionRule: (sellerId: string, scope: CommissionRuleScope, targetId: string) =>
    api.delete<AdminCommissionConfig>(`/admin/sellers/${sellerId}/commission/${scope}/${targetId}`),

  listings: (sellerId: string) => api.get<SellerListingDto[]>(`/admin/sellers/${sellerId}/listings`),
  products: (sellerId: string) => api.get<SellerProductDto[]>(`/admin/sellers/${sellerId}/products`),
  loginAccount: (sellerId: string) =>
    api.get<SellerLoginAccount>(`/admin/sellers/${sellerId}/login-credentials`),
  /** Sets the owner's login email once (only while it has none). No password is involved. */
  setLoginEmail: (sellerId: string, email: string) =>
    api.put<SellerLoginAccount>(`/admin/sellers/${sellerId}/login-email`, { email }),
  approvalBatches: (sellerId: string, cursor: string | null, limit = SELLER_PAGE_SIZE) => {
    const query = new URLSearchParams({ sellerId, limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return api.get<CursorPage<ProductApprovalBatchSummaryDto>>(`/admin/approval-batches?${query.toString()}`);
  },
  /** Admin's cross-seller seller-order list, filtered to this seller; newest
   * first, cursor pages. Customer name/mobile are stripped here. */
  sellerOrders: async (
    sellerId: string,
    status: SellerOrderStatus | null,
    cursor: string | null,
  ): Promise<CursorPage<AdminSellerOrderRow>> => {
    const query = new URLSearchParams({ sellerId, limit: String(SELLER_ORDERS_PAGE_SIZE) });
    if (status) query.set('status', status);
    if (cursor) query.set('cursor', cursor);
    const page = await api.get<CursorPage<SellerOrderListRowDto>>(`/admin/seller-orders?${query.toString()}`);
    return { items: page.items.map(toAdminSellerOrderRow), nextCursor: page.nextCursor, hasMore: page.hasMore };
  },
};

/* -------------------------------------------------------------------------- */
/* query keys                                                                  */
/* -------------------------------------------------------------------------- */

export const ADMIN_SELLERS_ROOT = 'admin-sellers' as const;

export const adminSellerKeys = {
  all: [ADMIN_SELLERS_ROOT] as const,
  lists: () => [ADMIN_SELLERS_ROOT, 'list'] as const,
  list: (filters: SellerListFilters) => [ADMIN_SELLERS_ROOT, 'list', filters] as const,
  details: () => [ADMIN_SELLERS_ROOT, 'detail'] as const,
  applications: (status: SellerLifecycleStatus | null) => [ADMIN_SELLERS_ROOT, 'list', 'applications', { status }] as const,
  detail: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'detail', sellerId] as const,
  /** Its own branch (not under `detail`): writes refresh it explicitly. */
  onboardingSummary: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'onboarding', 'summary', sellerId] as const,
  availability: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'availability', sellerId] as const,
  restaurant: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'restaurant', sellerId] as const,
  commission: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'commission', sellerId] as const,
  commissionHistory: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'commission-history', sellerId] as const,
  /** Own branches too: seller edits / status / onboarding writes invalidate
   * `detail(id)` by prefix, and none of them changes the catalogue. */
  listings: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'listings', sellerId] as const,
  products: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'products', sellerId] as const,
  loginAccount: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'login', sellerId] as const,
  /** This seller's seller orders — separate from the Orders board's
   * 'admin-orders' keys; the status filter is part of the key. */
  sellerOrdersAll: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'orders', sellerId] as const,
  sellerOrders: (sellerId: string, status: SellerOrderStatus | null) =>
    [ADMIN_SELLERS_ROOT, 'orders', sellerId, { status }] as const,
  approvalBatches: (sellerId: string) => [ADMIN_SELLERS_ROOT, 'detail', sellerId, 'approval-batches'] as const,
};

/* -------------------------------------------------------------------------- */
/* permissions (UI gating only)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Which seller-management controls this admin's role may see — the same
 * permissions each backend route requires:
 *   canRead       SELLER_ONBOARDING_REVIEW   list, detail, onboarding view
 *   canManage     SELLER_MANAGE              create, edit, status, data entry
 *   canReview     SELLER_ONBOARDING_REVIEW   document + onboarding decisions
 *   canVerifyBank SELLER_ONBOARDING_REVIEW + SETTLEMENT_MANAGE
 *   canCommission COMMISSION_MANAGE          every commission route, read AND write
 */
export function useSellerPermissions(): {
  canRead: boolean;
  canManage: boolean;
  canReview: boolean;
  canVerifyBank: boolean;
  canCommission: boolean;
  canSellerOrders: boolean;
  canEarnings: boolean;
} {
  const role = useAuth((state) => state.user?.role);
  const has = (permission: Permission) => (role ? roleHasPermission(role, permission) : false);
  return {
    // GET /admin/sellers/:id/earnings and /admin/settlements need SETTLEMENT_READ.
    canEarnings: has(Permission.SETTLEMENT_READ),
    canRead: has(Permission.SELLER_ONBOARDING_REVIEW),
    canManage: has(Permission.SELLER_MANAGE),
    canReview: has(Permission.SELLER_ONBOARDING_REVIEW),
    canVerifyBank: has(Permission.SELLER_ONBOARDING_REVIEW) && has(Permission.SETTLEMENT_MANAGE),
    canCommission: has(Permission.COMMISSION_MANAGE),
    // GET /admin/seller-orders; the Orders tab also needs the page's own gate.
    canSellerOrders: has(Permission.SELLER_ORDER_READ_OWN),
  };
}

/* -------------------------------------------------------------------------- */
/* hooks                                                                       */
/* -------------------------------------------------------------------------- */

/** Server-side filtered, cursor-paginated list. A filter change is a new key,
 * so it always starts again from the first page. */
export function useSellerList(filters: SellerListFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: adminSellerKeys.list(filters),
    queryFn: ({ pageParam }) => sellersApi.list(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

export function useCreateSeller() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSellerRequest) => sellersApi.create(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminSellerKeys.lists() }),
  });
}

/** The admin trading switch. Never touches the seller's own accepting-orders
 * switch — the server's answer is what the list then shows. */
export function useSetSellerStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sellerId: string } & AdminSetSellerStatusRequest) =>
      sellersApi.setStatus(input.sellerId, { isActive: input.isActive, reason: input.reason }),
    onSuccess: (detail) => {
      queryClient.setQueryData(adminSellerKeys.detail(detail.id), detail);
    },
    onSettled: (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.detail(input.sellerId) });
      // The admin switch is the first input to the availability rule.
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.availability(input.sellerId) });
    },
  });
}

/** Read-only availability for the Availability tab. */
export function useAdminSellerAvailability(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.availability(sellerId),
    queryFn: () => sellersApi.availability(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/* -------------------------------------------------------------------------- */
/* commission                                                                  */
/* -------------------------------------------------------------------------- */

export function useAdminSellerCommission(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.commission(sellerId),
    queryFn: () => sellersApi.commission(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

export function useAdminSellerCommissionHistory(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.commissionHistory(sellerId),
    queryFn: () => sellersApi.commissionHistory(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/** The seller's own listings (every one, not paginated) — the Listings tab,
 * and the products / categories a commission rule can target. */
export function useAdminSellerListings(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.listings(sellerId),
    queryFn: () => sellersApi.listings(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/**
 * GET/POST /admin/sellers/:sellerId/login-credentials (backend
 * seller-login.service) — the seller owner's panel login. Local types: not
 * part of the shared contract.
 */
/** GET /admin/sellers/:id/login-credentials — the login email only; never a password or its state. */
export interface SellerLoginAccount {
  sellerId: string;
  ownerName: string | null;
  email: string | null;
  lastLoginAt: string | null;
}

export function useSellerLoginAccount(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.loginAccount(sellerId),
    queryFn: () => sellersApi.loginAccount(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/** Sets the owner's login email when it has none (the seller then sets its own password). */
export function useSetSellerLoginEmail(sellerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => sellersApi.setLoginEmail(sellerId, email),
    onSuccess: (account) => {
      queryClient.setQueryData(adminSellerKeys.loginAccount(sellerId), account);
    },
  });
}

/** Master products this seller submitted (every one, not paginated), each with
 * its own listing and latest approval. */
export function useAdminSellerProducts(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.products(sellerId),
    queryFn: () => sellersApi.products(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/** This seller's seller orders, newest first, SELLER_ORDERS_PAGE_SIZE per page. */
export function useAdminSellerOrders(sellerId: string, status: SellerOrderStatus | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: adminSellerKeys.sellerOrders(sellerId, status),
    queryFn: ({ pageParam }) => sellersApi.sellerOrders(sellerId, status, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/** Refresh = back to the newest page: one request, rather than React Query
 * re-fetching every page already loaded. */
export function useResetSellerOrders(sellerId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.resetQueries({ queryKey: adminSellerKeys.sellerOrdersAll(sellerId) });
}

/** Commission writes re-read the commission config + history, and the
 * overview (it shows the default rate). Nothing else. */
function useCommissionMutation<TInput>(sellerId: string, run: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput): Promise<void> => {
      await run(input);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.commission(sellerId) });
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.commissionHistory(sellerId) });
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.detail(sellerId), exact: true });
    },
  });
}

export const useSetDefaultCommission = (sellerId: string) =>
  useCommissionMutation(sellerId, (rateBp: number) => sellersApi.setDefaultCommission(sellerId, rateBp));

export const useSetCommissionRule = (sellerId: string) =>
  useCommissionMutation(sellerId, (input: { scope: CommissionRuleScope; targetId: string; rateBp: number }) =>
    sellersApi.setCommissionRule(sellerId, input.scope, input.targetId, input.rateBp),
  );

export const useRemoveCommissionRule = (sellerId: string) =>
  useCommissionMutation(sellerId, (input: { scope: CommissionRuleScope; targetId: string }) =>
    sellersApi.removeCommissionRule(sellerId, input.scope, input.targetId),
  );

/** Read-only restaurant profile + menu. Callers enable it for RESTAURANT sellers only. */
export function useAdminRestaurant(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.restaurant(sellerId),
    queryFn: () => sellersApi.restaurant(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/** The masked admin overview (GET /admin/sellers/:id). */
export function useSellerDetail(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.detail(sellerId),
    queryFn: () => sellersApi.detail(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/* -------------------------------------------------------------------------- */
/* onboarding — the masked summary                                            */
/* -------------------------------------------------------------------------- */

/** A document row as returned by the summary (metadata only). */
export type SafeSellerDocument = AdminSellerOnboardingDocumentDto;

/**
 * Everything the Onboarding tab shows: status, stage, the completeness rule's
 * parts, last rejection, MASKED profile + bank (with the bank's id/updatedAt
 * for verification) and document metadata. Safe as delivered by the server —
 * no client-side filtering is needed or relied on.
 */
export function useSellerOnboardingSummary(sellerId: string, enabled = true) {
  return useQuery({
    queryKey: adminSellerKeys.onboardingSummary(sellerId),
    queryFn: () => getAdminSellerOnboardingSummary(sellerId),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/**
 * Onboarding writes. Their responses are never stored (the review ones are
 * unmasked; the data-entry ones carry document links) — each one re-reads the
 * safe onboarding summary and the seller overview and, when stage/status can
 * move, the list.
 */
function useSellerOnboardingMutation<TInput>(
  sellerId: string,
  run: (input: TInput) => Promise<unknown>,
  options: { refreshList: boolean },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput): Promise<void> => {
      await run(input);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.onboardingSummary(sellerId) });
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.detail(sellerId) });
      if (options.refreshList) void queryClient.invalidateQueries({ queryKey: adminSellerKeys.lists() });
    },
  });
}

export const useVerifySellerBankDetail = (sellerId: string) =>
  useSellerOnboardingMutation(
    sellerId,
    (body: AdminVerifyBankDetailRequest) => sellersApi.verifyBankDetail(sellerId, body),
    { refreshList: false },
  );

export const useReviewSellerDocument = (sellerId: string) =>
  useSellerOnboardingMutation(
    sellerId,
    (input: { documentId: string; status: typeof DocumentStatus.VERIFIED | typeof DocumentStatus.REJECTED; rejectionReason?: string }) =>
      sellersApi.reviewDocument(sellerId, input.documentId, {
        status: input.status,
        ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
      }),
    { refreshList: true },
  );

/** Seller Applications (Gate 1 queue), cursor-paginated. */
export function useSellerApplications(status: SellerLifecycleStatus | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: adminSellerKeys.applications(status),
    queryFn: ({ pageParam }) => sellersApi.applications(status, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    retry: retryServerErrorsOnce,
    enabled,
  });
}

/** A gate decision moves the seller's lifecycle: refresh every view of it. */
function useGateMutation<TInput>(run: (sellerId: string, input: TInput) => Promise<AdminSellerDetailDto>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sellerId: string; body: TInput }) => run(input.sellerId, input.body),
    onSuccess: (detail) => queryClient.setQueryData(adminSellerKeys.detail(detail.id), detail),
    onSettled: (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.detail(input.sellerId) });
      void queryClient.invalidateQueries({ queryKey: adminSellerKeys.onboardingSummary(input.sellerId) });
    },
  });
}

export const useReviewSellerApplication = () =>
  useGateMutation((sellerId, body: AdminReviewSellerApplicationRequest) => sellersApi.reviewApplication(sellerId, body));

export const useReviewSellerVerification = () =>
  useGateMutation((sellerId, body: AdminReviewSellerVerificationRequest) => sellersApi.reviewVerification(sellerId, body));

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

export function sellerErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return 'Your account does not have permission to manage sellers.';
    return error.message || fallback;
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/* -------------------------------------------------------------------------- */
/* Document uploads — shared by the admin and seller panels                    */
/* -------------------------------------------------------------------------- */

/** The upload limit for one document PDF (the server enforces it too). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** A friendly client-side pre-check; the server re-checks the actual bytes. */
export function documentFileProblem(file: File | null): string | null {
  if (!file) return 'Choose the PDF to upload.';
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) return 'Only PDF files can be uploaded.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_DOCUMENT_BYTES) return 'The PDF must be 10 MB or smaller.';
  return null;
}

export function documentFormData(body: UploadSellerDocumentRequest & { file: File }): FormData {
  const data = new FormData();
  data.append('type', body.type);
  if (body.documentNumber) data.append('documentNumber', body.documentNumber);
  if (body.expiresAt) data.append('expiresAt', body.expiresAt);
  data.append('file', body.file, body.file.name);
  return data;
}

/** Opens a fetched PDF in a new tab via a short-lived object URL (no server URL is exposed). */
export function openPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }));
  // Not the 'noopener' feature: with it window.open always returns null, which
  // would trigger the fallback too and open the PDF twice.
  const opened = window.open(url, '_blank');
  if (opened) {
    opened.opener = null;
  } else {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
