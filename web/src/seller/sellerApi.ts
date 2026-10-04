/**
 * Seller panel — API client, V2 seller API types and the rules the pages
 * share (which actions a seller may take, how availability is explained).
 *
 * The seller panel has its OWN session (`createApiClient` with its own
 * refresh-token key), so a seller signing in never replaces an admin session
 * in the same browser, and vice versa. Every endpoint here is one of the
 * existing V2 `/seller/*` routes; the server scopes each one to the signed-in
 * seller (attachSellerContext), never to anything the client sends.
 */

import type { FoodDiet, SellerProductDto, UnitType } from '@shared';
import { createApiClient, ApiRequestError } from '@/lib/api';
import { uploadProductImage, type PresignedUpload } from '@/lib/upload';

export const sellerClient = createApiClient('adione.seller.refresh');
export const sellerApi = sellerClient.api;

/** Roles that may use the seller panel (backend SELLER_PANEL_ROLES). */
export const SELLER_ROLES: readonly string[] = [
  'SELLER_OWNER',
  'SELLER_MANAGER',
  'PHARMACIST',
  'RESTAURANT_MANAGER',
];

/** Every seller query lives under this key, so logout can drop them all. */
export const SELLER_QUERY_ROOT = 'seller' as const;

/**
 * A message safe to show a seller for any failed request. A 4xx carries the
 * server's own user-facing sentence; anything else gets plain wording —
 * never a stack trace, status code or request id.
 */
export function sellerErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return 'Too many requests right now. Please wait a moment and try again.';
    if (error.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
    return error.message;
  }
  return 'Could not reach Aadione. Check your connection and try again.';
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

/** GET /seller/orders row (backend SellerOrderListRowDto). */
export interface SellerOrderRow {
  id: string;
  orderId: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  subtotalPaise: number;
  itemCount: number;
  customerName: string;
  customerMobile: string;
  createdAt: string;
  /** ONLINE | COD — how the customer pays for the whole order. */
  paymentMethod: string;
  /** Once ready: is the rider still to come, or has the order been handed over? */
  handover: SellerOrderHandover | null;
}

export type SellerOrderHandover = 'AWAITING_PICKUP' | 'PICKED_UP' | 'OUT_FOR_DELIVERY' | 'DELIVERED';

export const HANDOVER_LABEL: Record<SellerOrderHandover, string> = {
  AWAITING_PICKUP: 'Waiting for rider',
  PICKED_UP: 'Picked up by rider',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
};

/** GET /seller/orders/summary — the dashboard's order numbers in one call. */
export interface SellerOrderSummary {
  today: string;
  timezone: string;
  todayOrders: number;
  counts: { NEW: number; ACCEPTED: number; PREPARING: number; READY: number };
}

/** GET /seller/earnings/today — the earnings summary's definitions, for today only. */
export interface SellerTodayEarnings {
  today: string;
  timezone: string;
  orderCount: number;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
}

/** GET /seller/activity — what the seller's team (and Aadione) changed recently. */
export type SellerActivityItem = { id: string; at: string; by: 'You' | 'Your team' | 'AdiOne' | 'System' } & (
  | { kind: 'ORDER'; orderNumber: string; toStatus: string; reason: string | null }
  | { kind: 'STOCK'; listingId: string; productName: string; delta: number; reason: string; note: string | null }
  | { kind: 'PRICE'; listingId: string; productName: string; fromPaise: number | null; toPaise: number | null }
  | { kind: 'VISIBILITY'; listingId: string; productName: string; onSale: boolean }
  | { kind: 'ADMIN'; productId: string; productName: string; action: 'DISABLED' | 'ENABLED'; reason: string | null }
);

export interface SellerOrderPage {
  items: SellerOrderRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SellerOrderItemView {
  id: string;
  productName: string;
  variantName: string;
  imageUrl: string | null;
  qty: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

export interface SellerOrderDetailView {
  id: string;
  orderNumber: string;
  status: string;
  subtotalPaise: number;
  customerName: string | null;
  customerMobile: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  items: SellerOrderItemView[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * GET /seller/orders/:id answers with the seller-order record itself —
 * including internal fields such as commission. Only what the Orders page
 * shows is kept.
 */
export function toSellerOrderDetailView(raw: unknown): SellerOrderDetailView {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') {
    throw new Error('This order came back in an unexpected format. Please refresh.');
  }
  const order = isRecord(raw['order']) ? raw['order'] : {};
  const items = Array.isArray(raw['items']) ? raw['items'] : [];
  return {
    id: raw['id'],
    orderNumber: text(order['orderNumber']) ?? '',
    status: text(raw['status']) ?? '',
    subtotalPaise: number(raw['subtotalPaise']),
    customerName: text(order['deliveryFullName']),
    customerMobile: text(order['deliveryMobile']),
    rejectionReason: text(raw['rejectionReason']),
    cancellationReason: text(raw['cancellationReason']),
    items: items.filter(isRecord).map((item) => ({
      id: text(item['id']) ?? '',
      productName: text(item['productName']) ?? 'Item',
      variantName: text(item['variantName']) ?? '',
      imageUrl: text(item['imageUrl']),
      qty: number(item['qty']),
      unitPricePaise: number(item['unitPricePaise']),
      lineTotalPaise: number(item['lineTotalPaise']),
    })),
  };
}

export type SellerOrderActionKind = 'advance' | 'reject' | 'cancel';

export interface SellerOrderAction {
  to: 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP' | 'REJECTED' | 'CANCELLED';
  label: string;
  kind: SellerOrderActionKind;
}

/**
 * What a SELLER may do in each state — the backend's
 * ALLOWED_SELLER_ORDER_TRANSITIONS filtered by SELLER_ORDER_TRANSITION_ACTORS.
 * READY_FOR_PICKUP -> CANCELLED is admin-only, so nothing is offered there.
 */
export const SELLER_ORDER_ACTIONS: Readonly<Record<string, readonly SellerOrderAction[]>> = {
  NEW: [
    { to: 'ACCEPTED', label: 'Accept', kind: 'advance' },
    { to: 'REJECTED', label: 'Reject', kind: 'reject' },
  ],
  ACCEPTED: [
    { to: 'PREPARING', label: 'Start preparing', kind: 'advance' },
    { to: 'CANCELLED', label: 'Cancel', kind: 'cancel' },
  ],
  PREPARING: [
    { to: 'READY_FOR_PICKUP', label: 'Mark ready for pickup', kind: 'advance' },
    { to: 'CANCELLED', label: 'Cancel', kind: 'cancel' },
  ],
};

/**
 * Orders-page tabs. `status` filters one seller-order status; `stage` one
 * of the server's grouped views (READY = waiting for the rider, COMPLETED =
 * handed over, CANCELLED = rejected or cancelled). Neither = everything.
 */
export const SELLER_ORDER_TABS = [
  { key: 'NEW', label: 'New', status: 'NEW', stage: null },
  { key: 'ACCEPTED', label: 'Accepted', status: 'ACCEPTED', stage: null },
  { key: 'PREPARING', label: 'Preparing', status: 'PREPARING', stage: null },
  { key: 'READY_FOR_PICKUP', label: 'Ready for Pickup', status: null, stage: 'READY' },
  { key: 'COMPLETED', label: 'Completed', status: null, stage: 'COMPLETED' },
  { key: 'CANCELLED', label: 'Cancelled', status: null, stage: 'CANCELLED' },
  { key: 'ALL', label: 'All', status: null, stage: null },
] as const;
export type SellerOrderTabKey = (typeof SELLER_ORDER_TABS)[number]['key'];

/* -------------------------------------------------------------------------- */
/* Listings                                                                   */
/* -------------------------------------------------------------------------- */

/** GET /seller/listings row. The API sends no product image. */
export interface SellerListing {
  id: string;
  productId: string;
  productName: string;
  variantName: string;
  categoryName: string;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  mrpPaise: number;
  pricePaise: number;
  stockQty: number;
  availableQty: number;
  isAvailable: boolean;
}

/** PATCH /seller/listings/:id body — only the fields that changed. */
export interface SellerListingUpdate {
  mrpPaise?: number;
  pricePaise?: number;
  stockQty?: number;
  isAvailable?: boolean;
}

/** POST /seller/listings body (backend createListingSchema) — price and stock
 * for one of the seller's own products that has none yet (an older draft). */
export interface CreateSellerListingRequest {
  variantId: string;
  mrpPaise: number;
  pricePaise: number;
  stockQty?: number;
  isAvailable?: boolean;
}

/** Backend limit on a listing's stock (create and update schemas). */
export const LISTING_MAX_STOCK = 100_000;

/* -------------------------------------------------------------------------- */
/* Own products (submissions)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * POST /seller/products body (backend createProductSchema). A product is
 * created COMPLETE — its own MRP, selling price and opening stock included —
 * and waits as a draft until the seller submits its drafts for approval.
 */
/**
 * POST /seller/products. A marketplace product sends everything below; a
 * restaurant / cafe FOOD item sends only category (menu section), name,
 * description, selling price, diet and availability — no SKU, unit, MRP or
 * stock (the backend fills the rest in).
 */
export interface CreateSellerProductRequest {
  categoryId: string;
  name: string;
  nameHi?: string | null;
  description?: string | null;
  sku?: string;
  variantName?: string;
  unit?: UnitType;
  unitValue?: number;
  mrpPaise?: number;
  pricePaise: number;
  stockQty?: number;
  diet?: FoodDiet | null;
  isAvailable?: boolean;
}

/**
 * PATCH /seller/products/:id body — the creation fields, only those that
 * changed (the backend refuses anything else). nameHi / description may be
 * cleared with null.
 */
export type UpdateSellerProductRequest = Partial<Omit<CreateSellerProductRequest, 'nameHi' | 'description' | 'isAvailable'>> & {
  nameHi?: string | null;
  description?: string | null;
};

/**
 * Uploads one image into this seller's own storage space (POST
 * /seller/uploads/presign, then the bytes) with the seller session, and
 * returns the key to attach with POST /seller/products/:id/images.
 */
export function uploadSellerImage(file: File): Promise<string> {
  return uploadProductImage(
    file,
    (body) => sellerApi.post<PresignedUpload>('/seller/uploads/presign', body),
    () => sellerClient.getAccessToken(),
  );
}

/** POST /seller/products — the new product, its default variant and its listing. */
export interface CreatedSellerProduct {
  id: string;
  variantId: string;
  listingId: string;
}

/** POST /seller/approval-batches — the new batch (one per "Submit for Approval"). */
export interface SubmittedApprovalBatch {
  id: string;
  status: string;
  items: { id: string; productId: string; productName: string; status: string }[];
}

/* -------------------------------------------------------------------------- */
/* The seller's own categories: top categories + subcategories                */
/* -------------------------------------------------------------------------- */

export interface SellerCatalogSubcategoryRef {
  id: string;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  isActive: boolean;
  displayOrder: number;
  productCount: number;
}

export interface SellerCatalogCategory extends SellerCatalogSubcategoryRef {
  /** Products attached directly to the top category (not to a subcategory). */
  subcategories: SellerCatalogSubcategoryRef[];
}

/**
 * GET /seller/categories (backend seller-category.service) — and the response
 * of POST/PATCH /seller/categories(/:id). Every category here is the seller's
 * own; nobody else can see or change them.
 */
export interface SellerCatalogCategories {
  /** Restaurants manage menu sections instead. */
  usesMenuSections: boolean;
  categories: SellerCatalogCategory[];
}

/** GET/POST/PATCH /seller/subcategories (backend seller-subcategory.service). */
export interface SellerSubcategory {
  id: string;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  isActive: boolean;
  displayOrder: number;
  parent: { id: string; name: string };
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A product's gallery holds at most this many images (backend MAX_SELLER_PRODUCT_IMAGES). */
export const MAX_PRODUCT_IMAGES = 8;

/* -------------------------------------------------------------------------- */
/* Inventory + visibility (backend listing-visibility.ts)                     */
/* -------------------------------------------------------------------------- */

export type ListingVisibilityReason =
  | 'VISIBLE'
  | 'STORE_DEACTIVATED'
  | 'STORE_NOT_APPROVED'
  | 'DISABLED_BY_ADMIN'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'HIDDEN_BY_SELLER'
  | 'NOT_LISTED'
  | 'OFF_SALE'
  | 'OUT_OF_STOCK';

export interface ListingVisibility {
  sellable: boolean;
  reason: ListingVisibilityReason;
  availableQty: number;
  lowStock: boolean;
}

/** GET /seller/products(/:id) — the shared DTO plus inventory figures and visibility. */
export type SellerProductInventory = Omit<SellerProductDto, 'listing'> & {
  listing: (NonNullable<SellerProductDto['listing']> & { lowStockThreshold: number; maxQtyPerOrder: number; updatedAt: string }) | null;
  visibility: ListingVisibility;
  adminDisabled: { reason: string | null; at: string } | null;
};

/** GET /seller/listings(/:id) — one of the seller's listings with its inventory figures. */
export interface SellerListingInventory {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  categoryId: string;
  categoryName: string;
  approvalStatus: string;
  mrpPaise: number;
  pricePaise: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  isAvailable: boolean;
  /** false = made-to-order food item: no stock count. */
  tracksStock: boolean;
  lowStockThreshold: number;
  maxQtyPerOrder: number;
  productStatus: string;
  ownProduct: boolean;
  imageUrl: string | null;
  visibility: ListingVisibility;
  updatedAt: string;
}

/** GET /seller/listings/:id/stock-movements — StockLedger rows. */
export interface StockMovement {
  id: string;
  at: string;
  delta: number;
  reason: string;
  balanceAfter: number;
  /** Available stock just before this movement (server-computed). */
  availableBefore: number;
  note: string | null;
  by: string;
  orderLinked: boolean;
}

/** Length limits from createProductSchema (the backend stays authoritative). */
export const PRODUCT_LIMITS = {
  name: { min: 2, max: 200 },
  nameHi: { max: 200 },
  description: { max: 4000 },
  sku: { min: 2, max: 60 },
  variantName: { min: 1, max: 80 },
} as const;

export const UNIT_OPTIONS: { value: UnitType; label: string }[] = [
  { value: 'G', label: 'Grams (g)' },
  { value: 'KG', label: 'Kilograms (kg)' },
  { value: 'ML', label: 'Millilitres (ml)' },
  { value: 'L', label: 'Litres (L)' },
  { value: 'PIECE', label: 'Piece' },
  { value: 'PACK', label: 'Pack' },
  { value: 'DOZEN', label: 'Dozen' },
  { value: 'BUNDLE', label: 'Bundle' },
];

/** GET /seller/menu-sections row — a restaurant's own categories. */
export interface SellerMenuSection {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isActive: boolean;
  /** Food items in the section (a section with items cannot be deleted). */
  itemCount: number;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

export interface SellerHours {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

export type SellerClosedReason =
  | 'SELLER_DELETED'
  | 'SELLER_INACTIVE'
  | 'MANUALLY_CLOSED'
  | 'CLOSURE'
  | 'CLOSED_TODAY'
  | 'OUTSIDE_HOURS';

/** GET /seller/availability (and every availability write's response). */
export interface SellerAvailability {
  sellerId: string;
  sellerName: string;
  /** GROCERY | RESTAURANT | PHARMACY | GENERAL — a RESTAURANT lists under its own menu sections. */
  sellerType: string;
  timezone: string;
  isActive: boolean;
  /** The seller's own ON/OFF switch. */
  isAcceptingOrders: boolean;
  isOpenNow: boolean;
  /** Whether customers can order right now, all rules combined. */
  acceptingOrdersNow: boolean;
  closedReason: SellerClosedReason | null;
  nextOpenText: string | null;
  /** Today's window as the server evaluated it ("HH:MM"), when one applies. */
  todayOpensAt: string | null;
  todayClosesAt: string | null;
  hoursConfigured: boolean;
  hours: SellerHours[];
  upcomingClosures: { id: string; date: string; reason: string | null }[];
}

/**
 * One sentence for the seller about why customers can or cannot order now —
 * keeping "you switched it off", "outside your hours" and "a closure you
 * scheduled" clearly apart.
 */
export function describeAvailability(a: SellerAvailability): { tone: 'open' | 'closed' | 'blocked'; text: string } {
  if (a.acceptingOrdersNow) {
    return { tone: 'open', text: 'Open — customers can place orders now.' };
  }
  const next = a.nextOpenText ? ` ${a.nextOpenText}.` : '';
  switch (a.closedReason) {
    case 'MANUALLY_CLOSED':
      return { tone: 'closed', text: 'Switched OFF by you — customers cannot place new orders until you turn it back on.' };
    case 'OUTSIDE_HOURS':
      return { tone: 'closed', text: `Outside your business hours.${next}` };
    case 'CLOSED_TODAY':
      return { tone: 'closed', text: `Closed today per your weekly hours.${next}` };
    case 'CLOSURE':
      return { tone: 'closed', text: `Closed today — scheduled closure.${next}` };
    case 'SELLER_INACTIVE':
      return { tone: 'blocked', text: 'Your store has been paused by Aadione. Please contact Aadione support.' };
    case 'SELLER_DELETED':
      return { tone: 'blocked', text: 'This store is no longer active on Aadione.' };
    default:
      return { tone: 'closed', text: `Not accepting orders right now.${next}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Onboarding / profile (GET /seller/onboarding and its PUT siblings)          */
/* -------------------------------------------------------------------------- */

/**
 * The seller's own onboarding record. The SERVER masks PAN, Aadhaar and the
 * bank account number for seller callers — the full values never reach the
 * browser, so nothing here can leak them.
 */
export interface SellerOnboarding {
  sellerName: string;
  sellerType: string;
  onboardingStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  /** The two-gate lifecycle (SellerLifecycleStatus). */
  lifecycleStatus: string;
  /** Aadione's reason for a rejection or a request for changes. */
  lifecycleReason: string | null;
  /** Every required onboarding item and whether it is done. */
  checklist: { key: string; label: string; met: boolean; hint: string }[];
  /** Computed by the server: PENDING (incomplete) / SUBMITTED / APPROVED / REJECTED. */
  stage: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | string;
  isComplete: boolean;
  profile: {
    businessName: string;
    businessType: string | null;
    ownerFullName: string;
    ownerMobile: string;
    ownerEmail: string | null;
    panNumber: string | null;
    aadhaarNumber: string | null;
    gstNumber: string | null;
    fssaiNumber: string | null;
  } | null;
  bankDetail: {
    accountHolderName: string;
    /** Masked by the server: only the last 4 digits are real. */
    accountNumber: string;
    ifscCode: string;
    bankName: string | null;
    isVerified: boolean;
  } | null;
  documents: {
    id: string;
    type: string;
    /** Masked (e.g. `•••••••••F`); the full number is never sent to the Seller Panel. */
    documentNumberMasked: string | null;
    fileName: string | null;
    fileSizeBytes: number | null;
    hasFile: boolean;
    legacyLink: boolean;
    status: 'PENDING' | 'VERIFIED' | 'REJECTED' | string;
    rejectionReason: string | null;
    expiresAt: string | null;
    createdAt: string;
  }[];
  restaurantProfile: { cuisine: string[]; isVegOnly: boolean; avgPrepMins: number | null } | null;
  /** The store address (read-only). Absent from older responses. */
  storeAddress?: { addressLine: string; city: string; state: string; pincode: string } | null;
}

/**
 * Keeps only what the Profile page shows. The API also returns each
 * document's storage URL and internal ids; those are dropped here so they
 * are never held in the query cache or rendered.
 */
export function toSellerOnboarding(raw: SellerOnboarding): SellerOnboarding {
  return {
    sellerName: raw.sellerName,
    sellerType: raw.sellerType,
    onboardingStatus: raw.onboardingStatus,
    lifecycleStatus: raw.lifecycleStatus,
    lifecycleReason: raw.lifecycleReason ?? null,
    checklist: (raw.checklist ?? []).map((item) => ({ key: item.key, label: item.label, met: item.met, hint: item.hint })),
    stage: raw.stage,
    isComplete: raw.isComplete,
    profile: raw.profile
      ? {
          businessName: raw.profile.businessName,
          businessType: raw.profile.businessType,
          ownerFullName: raw.profile.ownerFullName,
          ownerMobile: raw.profile.ownerMobile,
          ownerEmail: raw.profile.ownerEmail,
          panNumber: raw.profile.panNumber,
          aadhaarNumber: raw.profile.aadhaarNumber,
          gstNumber: raw.profile.gstNumber,
          fssaiNumber: raw.profile.fssaiNumber,
        }
      : null,
    bankDetail: raw.bankDetail
      ? {
          accountHolderName: raw.bankDetail.accountHolderName,
          accountNumber: raw.bankDetail.accountNumber,
          ifscCode: raw.bankDetail.ifscCode,
          bankName: raw.bankDetail.bankName,
          isVerified: raw.bankDetail.isVerified,
        }
      : null,
    documents: raw.documents.map((d) => ({
      id: d.id,
      type: d.type,
      documentNumberMasked: d.documentNumberMasked ?? null,
      fileName: d.fileName ?? null,
      fileSizeBytes: d.fileSizeBytes ?? null,
      hasFile: d.hasFile ?? false,
      legacyLink: d.legacyLink ?? false,
      status: d.status,
      rejectionReason: d.rejectionReason,
      expiresAt: d.expiresAt,
      createdAt: d.createdAt,
    })),
    restaurantProfile: raw.restaurantProfile
      ? {
          cuisine: raw.restaurantProfile.cuisine,
          isVegOnly: raw.restaurantProfile.isVegOnly,
          avgPrepMins: raw.restaurantProfile.avgPrepMins,
        }
      : null,
    storeAddress: raw.storeAddress
      ? {
          addressLine: raw.storeAddress.addressLine,
          city: raw.storeAddress.city,
          state: raw.storeAddress.state,
          pincode: raw.storeAddress.pincode,
        }
      : null,
  };
}

/** PUT /seller/onboarding/bank-detail body (backend bankDetailSchema). */
export interface SellerBankDetailInput {
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  bankName: string | null;
}

/** PUT /seller/onboarding/restaurant-profile body (backend restaurantProfileSchema). */
export interface SellerRestaurantProfileInput {
  cuisine: string[];
  isVegOnly: boolean;
  avgPrepMins: number | null;
}

/** Backend SellerDocumentType labels. */
export const DOCUMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  GST_CERTIFICATE: 'GST Certificate',
  FSSAI_LICENSE: 'FSSAI Licence',
  PAN_CARD: 'PAN Card',
  AADHAAR_CARD: 'Aadhaar Card',
  BUSINESS_LICENSE: 'Business Licence',
  BANK_PROOF: 'Bank Proof',
  OTHER: 'Other Document',
};

/** Same rule the backend applies (seller-onboarding.service IFSC_PATTERN). */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/* -------------------------------------------------------------------------- */
/* Earnings & settlements (read-only; the backend computes every amount)      */
/* -------------------------------------------------------------------------- */

/** GET /seller/earnings (backend SellerEarningsSummaryDto), in paise. */
export interface SellerEarningsSummary {
  settlementCycleHours: number;
  grossSalesPaise: number;
  commissionPaise: number;
  cancelledAmountPaise: number;
  refundedAmountPaise: number;
  netPayablePaise: number;
  notYetEligiblePaise: number;
  pendingSettlementPaise: number;
  inSettlementPaise: number;
  settledAmountPaise: number;
  lastSettlementPeriodEnd: string | null;
  nextSettlementDueAt: string | null;
}

/** GET /seller/commission/orders row — commission snapshot per seller order. */
export interface SellerOrderCommission {
  orderNumber: string;
  status: string;
  /** Delivery progress of a READY order (null otherwise). */
  handover: SellerOrderHandover | null;
  createdAt: string;
  subtotalPaise: number;
  commissionBp: number;
  commissionPaise: number;
  items: {
    productName: string;
    variantName: string;
    qty: number;
    lineTotalPaise: number;
    commissionBp: number;
    commissionPaise: number;
  }[];
}

/** GET /seller/settlements item. `id` is kept only to fetch its detail. */
export interface SellerSettlement {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | string;
  paidAt: string | null;
  createdAt: string;
}

/** One order a settlement paid for (backend SellerOrderEarningsRow, trimmed). */
export interface SellerSettlementOrder {
  orderNumber: string;
  deliveredAt: string | null;
  grossPaise: number;
  commissionPaise: number;
  refundedPaise: number;
  /** What this order contributes to the payout. */
  finalPayablePaise: number;
}

export interface SellerSettlementDetail extends SellerSettlement {
  orders: SellerSettlementOrder[];
}

export interface SellerSettlementPage {
  items: SellerSettlement[];
  hasMore: boolean;
  nextCursor: string | null;
}

// Mappers: keep the amounts and labels the page shows; drop internal ids
// (seller / order / seller-order ids) the seller has no use for.

export function toEarningsSummary(raw: SellerEarningsSummary): SellerEarningsSummary {
  return {
    settlementCycleHours: raw.settlementCycleHours,
    grossSalesPaise: raw.grossSalesPaise,
    commissionPaise: raw.commissionPaise,
    cancelledAmountPaise: raw.cancelledAmountPaise,
    refundedAmountPaise: raw.refundedAmountPaise,
    netPayablePaise: raw.netPayablePaise,
    notYetEligiblePaise: raw.notYetEligiblePaise,
    pendingSettlementPaise: raw.pendingSettlementPaise,
    inSettlementPaise: raw.inSettlementPaise,
    settledAmountPaise: raw.settledAmountPaise,
    lastSettlementPeriodEnd: raw.lastSettlementPeriodEnd,
    nextSettlementDueAt: raw.nextSettlementDueAt,
  };
}

export function toOrderCommissions(raw: SellerOrderCommission[]): SellerOrderCommission[] {
  return raw.map((row) => ({
    orderNumber: row.orderNumber,
    status: row.status,
    handover: row.handover ?? null,
    createdAt: row.createdAt,
    subtotalPaise: row.subtotalPaise,
    commissionBp: row.commissionBp,
    commissionPaise: row.commissionPaise,
    items: row.items.map((item) => ({
      productName: item.productName,
      variantName: item.variantName,
      qty: item.qty,
      lineTotalPaise: item.lineTotalPaise,
      commissionBp: item.commissionBp,
      commissionPaise: item.commissionPaise,
    })),
  }));
}

function toSettlement(raw: SellerSettlement): SellerSettlement {
  return {
    id: raw.id,
    periodStart: raw.periodStart,
    periodEnd: raw.periodEnd,
    grossSalesPaise: raw.grossSalesPaise,
    commissionPaise: raw.commissionPaise,
    netPayablePaise: raw.netPayablePaise,
    status: raw.status,
    paidAt: raw.paidAt,
    createdAt: raw.createdAt,
  };
}

export function toSettlementPage(raw: SellerSettlementPage): SellerSettlementPage {
  return { items: raw.items.map(toSettlement), hasMore: raw.hasMore, nextCursor: raw.nextCursor };
}

export function toSettlementDetail(raw: SellerSettlement & { sellerOrders: SellerSettlementOrder[] }): SellerSettlementDetail {
  return {
    ...toSettlement(raw),
    orders: raw.sellerOrders.map((o) => ({
      orderNumber: o.orderNumber,
      deliveredAt: o.deliveredAt,
      grossPaise: o.grossPaise,
      commissionPaise: o.commissionPaise,
      refundedPaise: o.refundedPaise,
      finalPayablePaise: o.finalPayablePaise,
    })),
  };
}

/** Weekly-hours display order: Monday first. */
export const WEEK = [
  { dayOfWeek: 1, name: 'Monday' },
  { dayOfWeek: 2, name: 'Tuesday' },
  { dayOfWeek: 3, name: 'Wednesday' },
  { dayOfWeek: 4, name: 'Thursday' },
  { dayOfWeek: 5, name: 'Friday' },
  { dayOfWeek: 6, name: 'Saturday' },
  { dayOfWeek: 0, name: 'Sunday' },
] as const;
