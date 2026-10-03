/**
 * Data transfer objects — the exact shapes that cross the wire.
 *
 * These are the contract between the API and both clients. A client cannot
 * invent a field the server does not send without a compile error.
 *
 * Convention: every monetary field is an integer number of paise and its name
 * ends in `Paise`. Clients format; clients never compute.
 */

import type {
  ApprovalStatus,
  CodPolicy,
  CouponOrigin,
  CouponType,
  DeliveryTaskStatus,
  DocumentStatus,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  ProductStatus,
  ReferralStatus,
  SellerDocumentType,
  SellerLifecycleStatus,
  SellerOrderStatus,
  SellerStaffRole,
  SellerType,
  SettlementStatus,
  UnitType,
  UserRole,
} from './enums';
import type { CustomerTimelineStep } from './order-state-machine';

/* -------------------------------------------------------------------------- */
/* Auth & user                                                                */
/* -------------------------------------------------------------------------- */

export interface SendOtpRequest {
  /** 10-digit Indian mobile number, no country code. */
  mobile: string;
}

export interface SendOtpResponse {
  /** Seconds until a resend is permitted. */
  resendAfterSeconds: number;
  expiresInSeconds: number;
  /** Present in non-production environments only, to make dev testing possible. */
  devOtp?: string;
}

export interface VerifyOtpRequest {
  mobile: string;
  otp: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface UserDto {
  id: string;
  mobile: string;
  fullName: string | null;
  email: string | null;
  role: UserRole;
  referralCode: string | null;
  /**
   * False for accounts created by email+password signup until the customer
   * completes one OTP login. The app should prompt for verification before
   * checkout, since the rider phones this number.
   */
  mobileVerified: boolean;
  /** True when this request created the account. */
  isNewUser?: boolean;
  createdAt: string;
}

/** Task 2.6 — email + password registration. */
export interface SignupRequest {
  fullName: string;
  email: string;
  password: string;
  mobile: string;
}

/** Task 2.5 — email + password login. */
export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: UserDto;
  tokens: AuthTokens;
}

export interface AdminLoginRequest {
  email: string;
  password: string;
}

export interface UpdateProfileRequest {
  fullName?: string;
  email?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Seller & serviceability                                                    */
/* -------------------------------------------------------------------------- */

export interface SellerHoursDto {
  dayOfWeek: number; // 0 = Sunday
  opensAt: string; // "08:00"
  closesAt: string; // "22:00"
  isClosed: boolean;
}

/**
 * The customer-facing view of a seller — a product/menu page header. Every
 * seller is one of these; there is no special platform store.
 */
export interface SellerDto {
  id: string;
  name: string;
  sellerType: SellerType;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  latitude: number;
  longitude: number;
  phone: string | null;
  timezone: string;
  /** The owner's trading switch. False = paused from the seller/admin panel. */
  isActive: boolean;
  /** False when paused, closed for the day, or outside today's window. */
  isOpenNow: boolean;
  /** Local time the seller next opens, ISO-8601, when currently closed. */
  opensAt: string | null;
  closesAt: string | null;
  todayHours: SellerHoursDto | null;
}

/**
 * The seller/admin panel's view of trading: the switch plus the full weekly
 * schedule. Distinct from `SellerDto` because editing needs all seven days,
 * even while paused — the customer-facing DTO deliberately reports only
 * today, and reports nothing when paused.
 */
export interface SellerAvailabilityDto {
  isActive: boolean;
  isOpenNow: boolean;
  timezone: string;
  /** Exactly seven entries, Sunday (0) through Saturday (6). */
  hours: SellerHoursDto[];
  /** "Opens tomorrow at 8:00 AM" — null while paused or already open. */
  nextOpenText: string | null;
}

export interface UpdateSellerHoursRequest {
  hours: SellerHoursDto[];
}

export interface ServiceabilityQuery {
  lat: number;
  lng: number;
}

export interface ServiceabilityResult {
  serviceable: boolean;
  distanceKm: number;
  /** Configured limit, so the app can say "we deliver up to N km". */
  maxRadiusKm: number;
  /** Null when not serviceable. */
  etaMinutes: number | null;
  etaMinMinutes: number | null;
  etaMaxMinutes: number | null;
  deliveryFeePaise: number | null;
  /** Location check: at least one seller that delivers here is open now.
   * Checkout quote: every seller in the cart is open now. */
  sellerOpen: boolean;
}

/* -------------------------------------------------------------------------- */
/* Seller onboarding & self-service (admin creates; seller manages its own)  */
/* -------------------------------------------------------------------------- */

export interface SellerProfileDto {
  businessName: string;
  businessType: string | null;
  ownerFullName: string;
  ownerMobile: string;
  ownerEmail: string | null;
  /** Masked except for admin's own detail view — see the service layer. */
  panNumber: string | null;
  aadhaarNumber: string | null;
  gstNumber: string | null;
  fssaiNumber: string | null;
}

export interface UpsertSellerProfileRequest {
  businessName: string;
  businessType?: string | null;
  ownerFullName: string;
  ownerMobile: string;
  ownerEmail?: string | null;
  panNumber?: string | null;
  aadhaarNumber?: string | null;
  gstNumber?: string | null;
  fssaiNumber?: string | null;
}

export interface SellerBankDetailDto {
  id: string;
  /** Changes on every save of the account. The admin echoes it (with `id`)
   * back to PATCH …/bank-detail/verify, so only the exact account they
   * reviewed can be verified. Not sensitive. */
  updatedAt: string;
  accountHolderName: string;
  /** Masked to the last 4 digits except in admin's own verification view. */
  accountNumber: string;
  ifscCode: string;
  bankName: string | null;
  isVerified: boolean;
}

export interface UpsertSellerBankDetailRequest {
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  bankName?: string | null;
}

export interface SellerDocumentDto {
  id: string;
  type: SellerDocumentType;
  /** The number printed on the document, MASKED (e.g. `•••••••••F`). The full
   * number is only returned by the audited admin reveal endpoint. */
  documentNumberMasked: string | null;
  hasDocumentNumber: boolean;
  /** The uploaded PDF's (sanitised) file name — never a URL or storage key. */
  fileName: string | null;
  fileSizeBytes: number | null;
  /** An uploaded PDF exists (read it through the authorised file endpoint). */
  hasFile: boolean;
  /** A legacy record added as an external link before uploads existed. */
  legacyLink: boolean;
  status: DocumentStatus;
  rejectionReason: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * POST /seller/onboarding/documents and POST /admin/sellers/:id/onboarding/documents
 * are multipart/form-data: these text fields plus the PDF in the `file` field
 * (PDF only, at most 10 MB). There is no URL field.
 */
export interface UploadSellerDocumentRequest {
  type: SellerDocumentType;
  documentNumber?: string | null;
  expiresAt?: string | null;
}

/** GET /admin/sellers/:id/onboarding/documents/:documentId/number — the audited "Show". */
export interface RevealedDocumentNumberDto {
  documentId: string;
  type: SellerDocumentType;
  documentNumber: string | null;
}

export interface ReviewSellerDocumentRequest {
  status: DocumentStatus;
  rejectionReason?: string | null;
}

export interface RestaurantProfileDto {
  cuisine: string[];
  isVegOnly: boolean;
  avgPrepMins: number | null;
}

export interface UpsertRestaurantProfileRequest {
  cuisine: string[];
  isVegOnly?: boolean;
  avgPrepMins?: number | null;
}

/**
 * A seller's onboarding record: GET/PUT /seller/onboarding*, the admin review
 * view (GET /admin/sellers/:id/onboarding — unmasked) and the admin data-entry
 * responses (masked). `stage` is computed, never stored.
 */
export interface SellerOnboardingDetailDto {
  sellerId: string;
  sellerName: string;
  sellerType: SellerType;
  onboardingStatus: ApprovalStatus;
  lifecycleStatus: SellerLifecycleStatus;
  /** Seller-facing reason for a rejection or a request for changes. */
  lifecycleReason: string | null;
  stage: SellerOnboardingStage;
  /** Every required onboarding item is present (see `checklist`). */
  isComplete: boolean;
  checklist: SellerOnboardingChecklistItemDto[];
  profile: SellerProfileDto | null;
  bankDetail: SellerBankDetailDto | null;
  documents: SellerDocumentDto[];
  restaurantProfile: RestaurantProfileDto | null;
}

/** The three original parts of the onboarding completeness rule. The full
 * rule (store address/location, PAN, licences…) is `checklist`. */
export interface SellerOnboardingRequirementsDto {
  profile: boolean;
  bankDetail: boolean;
  /** A PAN document that is not rejected. */
  identityDocument: boolean;
}

/** One required onboarding item and whether it is satisfied — the same list
 * the seller sees before "Submit for Verification" and admin sees at Gate 2. */
export interface SellerOnboardingChecklistItemDto {
  key: string;
  label: string;
  met: boolean;
  /** What to do when not met. */
  hint: string;
}

/**
 * GET /seller/lifecycle — where the signed-in seller is in the two-gate
 * lifecycle and what it may do next. Available in EVERY lifecycle state (the
 * only seller endpoint that is), so the panel can always explain itself.
 */
export interface SellerLifecycleDto {
  sellerId: string;
  sellerName: string;
  sellerType: SellerType;
  lifecycleStatus: SellerLifecycleStatus;
  /** Seller-facing reason for a rejection or a request for changes. */
  reason: string | null;
  /** Full operational Seller Panel (ACTIVE). */
  panelUnlocked: boolean;
  /** Onboarding data may be edited now (ONBOARDING_PENDING / CHANGES_REQUIRED). */
  canEditOnboarding: boolean;
  /** Editable AND every checklist item met. */
  canSubmit: boolean;
  checklist: SellerOnboardingChecklistItemDto[];
  applicationSubmittedAt: string | null;
  onboardingSubmittedAt: string | null;
  activatedAt: string | null;
  lifecycleUpdatedAt: string | null;
}

/** POST /auth/seller/signup — the public seller application (Gate 1 input). */
export interface SellerSignupRequest {
  fullName: string;
  mobile: string;
  email: string;
  password: string;
  businessName: string;
  sellerType: SellerType;
}

/** One row of the admin Seller Applications view. Applicant contact details
 * are shown here (admin needs them to decide Gate 1) — never in the general
 * seller list. */
export interface AdminSellerApplicationDto {
  sellerId: string;
  businessName: string;
  sellerType: SellerType;
  applicantName: string | null;
  mobile: string | null;
  email: string | null;
  lifecycleStatus: SellerLifecycleStatus;
  lifecycleReason: string | null;
  applicationSubmittedAt: string | null;
  createdAt: string;
}

/** PATCH /admin/sellers/:id/application/review — Gate 1. */
export interface AdminReviewSellerApplicationRequest {
  decision: 'APPROVE' | 'REJECT';
  /** Required to reject; shown to the applicant. */
  reason?: string | null;
}

/** PATCH /admin/sellers/:id/verification/review — Gate 2. */
export interface AdminReviewSellerVerificationRequest {
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';
  /** Required for REQUEST_CHANGES and REJECT; shown to the seller. */
  reason?: string | null;
}

/** An onboarding document as the admin panel may show it: metadata, the
 * number MASKED, the file by name only — there is deliberately no link field. */
export interface AdminSellerOnboardingDocumentDto {
  id: string;
  type: SellerDocumentType;
  /** The number printed on the document, MASKED (e.g. `•••••••••F`). The full
   * number is only returned by the audited admin reveal endpoint. */
  documentNumberMasked: string | null;
  hasDocumentNumber: boolean;
  /** The uploaded PDF's (sanitised) file name — never a URL or storage key. */
  fileName: string | null;
  fileSizeBytes: number | null;
  /** An uploaded PDF exists (read it through the authorised file endpoint). */
  hasFile: boolean;
  /** A legacy record added as an external link before uploads existed. */
  legacyLink: boolean;
  status: DocumentStatus;
  rejectionReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** When it was verified or rejected; null while pending. */
  reviewedAt: string | null;
}

/**
 * GET /admin/sellers/:id/onboarding/summary — the Admin Web's onboarding read.
 * PAN, Aadhaar and the account number are MASKED; no document link is ever
 * included. `bankDetail.id` + `updatedAt` are what bank verification echoes.
 */
export interface AdminSellerOnboardingSummaryDto {
  sellerId: string;
  sellerName: string;
  sellerType: SellerType;
  onboardingStatus: ApprovalStatus;
  lifecycleStatus: SellerLifecycleStatus;
  lifecycleReason: string | null;
  onboardingSubmittedAt: string | null;
  stage: SellerOnboardingStage;
  isComplete: boolean;
  requirements: SellerOnboardingRequirementsDto;
  checklist: SellerOnboardingChecklistItemDto[];
  lastRejectionReason: string | null;
  lastRejectedAt: string | null;
  profile: SellerProfileDto | null;
  bankDetail: SellerBankDetailDto | null;
  documents: AdminSellerOnboardingDocumentDto[];
}

/** Admin's full seller record — onboarding review, seller directory. */
export interface AdminSellerDto extends SellerDto {
  onboardingStatus: ApprovalStatus;
  defaultCommissionBp: number;
  settlementCycleHours: number;
  profile: SellerProfileDto | null;
  bankDetail: SellerBankDetailDto | null;
  documents: SellerDocumentDto[];
  restaurantProfile: RestaurantProfileDto | null;
  createdAt: string;
}

export interface CreateSellerRequest {
  name: string;
  sellerType: SellerType;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  latitude: number;
  longitude: number;
  phone?: string | null;
  /** Login for the seller's first OWNER staff member — created alongside. */
  ownerMobile: string;
  ownerFullName: string;
  defaultCommissionBp?: number;
}

export interface ReviewSellerOnboardingRequest {
  status: ApprovalStatus;
  reason?: string | null;
}

export interface SellerStaffDto {
  id: string;
  userId: string;
  fullName: string | null;
  mobile: string;
  role: SellerStaffRole;
  isActive: boolean;
  createdAt: string;
}

export interface InviteSellerStaffRequest {
  mobile: string;
  fullName: string;
  role: SellerStaffRole;
}

/* -------------------------------------------------------------------------- */
/* Admin seller directory (V2) — GET /admin/sellers, GET /admin/sellers/:id   */
/* -------------------------------------------------------------------------- */

/**
 * Coarse onboarding progress, derived from `Seller.lifecycleStatus` (kept for
 * older screens): APPROVED = ACTIVE, REJECTED = either gate refused,
 * SUBMITTED = waiting for Gate 2 verification, PENDING = everything else.
 */
export type SellerOnboardingStage = 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

/** Admin seller-list filter: a lifecycle status, or SUSPENDED = ACTIVE but
 * switched off by admin (`isActive` false). */
export type SellerLifecycleFilter = SellerLifecycleStatus | 'SUSPENDED';

/** Why a seller cannot take an order right now, highest priority first. */
export type SellerClosedReason =
  | 'SELLER_DELETED'
  | 'SELLER_INACTIVE'
  | 'MANUALLY_CLOSED'
  | 'CLOSURE'
  | 'CLOSED_TODAY'
  | 'OUTSIDE_HOURS';

/** One row of the admin seller list. Carries no PII — no PAN, Aadhaar,
 * bank details, owner contact or document links. */
export interface AdminSellerListRowDto {
  id: string;
  code: string;
  name: string;
  sellerType: SellerType;
  city: string;
  state: string;
  onboardingStatus: ApprovalStatus;
  lifecycleStatus: SellerLifecycleStatus;
  stage: SellerOnboardingStage;
  /** Admin-controlled trading switch. */
  isActive: boolean;
  /** The seller's own Store Open / Store Closed switch. */
  isAcceptingOrders: boolean;
  isOpenNow: boolean;
  /** Whether an order could be placed now (open, or closed with orders allowed). */
  acceptingOrdersNow: boolean;
  closedReason: SellerClosedReason | null;
  createdAt: string;
}

export interface AdminSellerAvailabilitySummaryDto {
  timezone: string;
  isOpenNow: boolean;
  acceptingOrdersNow: boolean;
  closedReason: SellerClosedReason | null;
  nextOpenText: string | null;
  /** False when the seller has never saved a weekly schedule. */
  hoursConfigured: boolean;
}

/** Counts over every document row, superseded re-uploads included. */
export interface AdminSellerDocumentSummaryDto {
  total: number;
  pending: number;
  verified: number;
  rejected: number;
}

/** The admin seller overview. PAN, Aadhaar and the bank account number are
 * always MASKED here; document links are not included (the onboarding review
 * view, GET /admin/sellers/:id/onboarding, is where those are read). */
export interface AdminSellerDetailDto {
  id: string;
  code: string;
  name: string;
  sellerType: SellerType;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  latitude: number;
  longitude: number;
  phone: string | null;
  onboardingStatus: ApprovalStatus;
  lifecycleStatus: SellerLifecycleStatus;
  /** Seller-facing reason for the latest rejection / request for changes. */
  lifecycleReason: string | null;
  lifecycleUpdatedAt: string | null;
  /** Self-signup time; null for a seller created by admin. */
  applicationSubmittedAt: string | null;
  onboardingSubmittedAt: string | null;
  activatedAt: string | null;
  /** The applicant / owner account (Gate 1 review). */
  owner: { fullName: string | null; mobile: string; email: string | null } | null;
  stage: SellerOnboardingStage;
  /** Every required onboarding item is present. */
  isComplete: boolean;
  /** Reason given on the most recent onboarding rejection, if there was one —
   * kept after a resubmission or a later approval, as history. */
  lastRejectionReason: string | null;
  lastRejectedAt: string | null;
  isActive: boolean;
  isAcceptingOrders: boolean;
  availability: AdminSellerAvailabilitySummaryDto;
  defaultCommissionBp: number;
  settlementCycleHours: number;
  profile: SellerProfileDto | null;
  bankDetail: SellerBankDetailDto | null;
  restaurantProfile: RestaurantProfileDto | null;
  documentSummary: AdminSellerDocumentSummaryDto;
  staff: SellerStaffDto[];
  createdAt: string;
  updatedAt: string;
}

/** PATCH /admin/sellers/:id/status — the admin trading switch for any
 * seller. Never touches `isAcceptingOrders` or onboarding. */
export interface AdminSetSellerStatusRequest {
  isActive: boolean;
  /** Required; recorded in the audit log. */
  reason: string;
}

/** PATCH /admin/sellers/:id/onboarding/bank-detail/verify — identifies the
 * exact bank state the admin reviewed: `SellerBankDetailDto.id` and
 * `.updatedAt` as read. Anything changed since then is a 409. */
export interface AdminVerifyBankDetailRequest {
  bankDetailId: string;
  expectedUpdatedAt: string;
}

/** PATCH /admin/sellers/:id — basic details only. Latitude and longitude are
 * sent together or not at all. */
export interface AdminUpdateSellerRequest {
  name?: string;
  phone?: string | null;
  addressLine?: string;
  city?: string;
  state?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
}

/** One of a seller's own listings — GET /seller/listings and the admin view
 * GET /admin/sellers/:id/listings. */
export interface SellerListingDto {
  id: string;
  sellerId: string;
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  categoryId: string;
  categoryName: string;
  approvalStatus: ApprovalStatus;
  mrpPaise: number;
  pricePaise: number;
  stockQty: number;
  availableQty: number;
  isAvailable: boolean;
}

/* -------------------------------------------------------------------------- */
/* Commission                                                                 */
/* -------------------------------------------------------------------------- */

export interface CommissionRuleDto {
  id: string;
  sellerId: string;
  categoryId: string | null;
  productId: string | null;
  rateBp: number;
  isActive: boolean;
}

export interface UpsertCommissionRuleRequest {
  categoryId?: string | null;
  productId?: string | null;
  rateBp: number;
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

export interface CategoryDto {
  id: string;
  parentId: string | null;
  name: string;
  nameHi: string | null;
  slug: string;
  imageUrl: string | null;
  depth: number;
  displayOrder: number;
  productCount?: number;
  children?: CategoryDto[];
}

export interface ProductImageDto {
  id: string;
  url: string;
  thumbUrl: string | null;
  cardUrl: string | null;
  altText: string | null;
  displayOrder: number;
}

export interface VariantDto {
  id: string;
  sku: string;
  /** Display label such as "1 kg", "500 ml", "Pack of 6". */
  variantName: string;
  unit: UnitType;
  unitValue: number;
  imageUrl: string | null;
  isDefault: boolean;

  /* live, seller-scoped commercial data — always server-resolved */
  sellerListingId: string;
  sellerId: string;
  sellerName: string;
  mrpPaise: number;
  pricePaise: number;
  discountPercent: number;
  inStock: boolean;
  availableQty: number;
  maxQtyPerOrder: number;
  allowCod: boolean;
}

export interface ProductSummaryDto {
  id: string;
  name: string;
  nameHi: string | null;
  slug: string;
  brandName: string | null;
  categoryId: string;
  imageUrl: string | null;
  thumbUrl: string | null;
  /**
   * The best/default LISTING's commercial data, for cards and grids — "best"
   * meaning the lowest current price across every seller listing this
   * product has, so a card never has to name a seller just to show a price.
   * Null when no seller currently lists this product at all.
   */
  defaultVariant: VariantDto | null;
  variantCount: number;
  /** Distinct sellers currently listing at least one variant of this product. */
  sellerCount: number;
  /**
   * DRAFT/INACTIVE/ARCHIVED never reach a customer — every customer-facing
   * query filters to ACTIVE upstream, so this is always ACTIVE there. Admin's
   * product list is the one place this varies, driving the "Display on App"
   * toggle.
   */
  status: ProductStatus;
  approvalStatus: ApprovalStatus;
}

export interface ProductDetailDto extends ProductSummaryDto {
  description: string | null;
  descriptionHi: string | null;
  images: ProductImageDto[];
  variants: VariantDto[];
  /** Vertical-specific display attributes (shelf life, storage, origin, …). */
  attributes: Record<string, string | number | boolean | null>;
  categoryPath: { id: string; name: string; slug: string }[];
}

export interface ProductListQuery {
  categoryId?: string;
  subcategoryId?: string;
  brandId?: string;
  sellerId?: string;
  inStock?: boolean;
  sort?: 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'NEWEST' | 'POPULAR' | 'DISCOUNT';
  cursor?: string | null;
  limit?: number;
}

/** One call that fills the whole Home screen — see PRD §9.4. */
export interface HomeFeedDto {
  banners: {
    id: string;
    imageUrl: string;
    title: string | null;
    subtitle: string | null;
    actionType: 'CATEGORY' | 'PRODUCT' | 'COUPON' | 'NONE';
    actionValue: string | null;
  }[];
  categories: CategoryDto[];
  rails: {
    key: 'POPULAR' | 'DAILY_ESSENTIALS' | 'BEST_SELLERS' | 'RECENTLY_ADDED' | 'OFFERS';
    title: string;
    products: ProductSummaryDto[];
  }[];
  /**
   * One rail per top-level category ("Grocery", "Vegetables & Fruits", …),
   * so a newly added category gets its own visible shelf on Home instead of
   * competing for space in the generic popularity/recency rails above.
   */
  categoryRails: {
    categoryId: string;
    title: string;
    products: ProductSummaryDto[];
  }[];
}

/* -------------------------------------------------------------------------- */
/* Catalog approval — seller submissions reviewed by admin in batches         */
/* -------------------------------------------------------------------------- */

export interface ProductApprovalBatchItemDto {
  id: string;
  productId: string;
  productName: string;
  status: ApprovalStatus;
  reviewNote: string | null;
}

export interface ProductApprovalBatchDto {
  id: string;
  sellerId: string;
  sellerName: string;
  status: ApprovalStatus;
  submittedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  items: ProductApprovalBatchItemDto[];
}

/** A category reference: its id and display name. */
export interface CategoryRefDto {
  id: string;
  name: string;
}

export interface SubmittedProductVariantDto {
  id: string;
  variantName: string;
  sku: string;
  unit: UnitType;
  unitValue: number;
}

/**
 * A seller-submitted product as the seller and admin panels review it.
 * `categoryId` is the product's own category; when that category has a
 * parent, `category` is the parent and `subcategory` the product's own.
 */
export interface SubmittedProductDto {
  id: string;
  name: string;
  nameHi: string | null;
  description: string | null;
  status: ProductStatus;
  approvalStatus: ApprovalStatus;
  submittedBySellerId: string | null;
  categoryId: string;
  category: CategoryRefDto;
  subcategory: CategoryRefDto | null;
  /** The default variant (or the first live one); null only if none is left. */
  defaultVariant: SubmittedProductVariantDto | null;
  createdAt: string;
  updatedAt: string;
}

/** The seller's own SellerListing for a product's default variant. */
export interface SellerProductListingDto {
  id: string;
  mrpPaise: number;
  pricePaise: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  isAvailable: boolean;
}

/** The most recent approval-batch item for a product. */
export interface SellerProductApprovalDto {
  batchId: string;
  batchStatus: ApprovalStatus;
  itemId: string;
  status: ApprovalStatus;
  reviewNote: string | null;
  submittedAt: string;
}

/** GET /seller/products — one of the seller's own products. */
export interface SellerProductDto extends SubmittedProductDto {
  /** Null until the seller lists the (approved) default variant. */
  listing: SellerProductListingDto | null;
  /** Null when the product has never been submitted for approval. */
  latestApproval: SellerProductApprovalDto | null;
  /** The reason on the most recent REJECTED item, even after resubmission. */
  lastRejectionReason: string | null;
  /** In display order; the first is the product's primary image. */
  images: ProductReviewImageDto[];
}

export interface ProductReviewImageDto {
  id: string;
  url: string;
  thumbUrl: string | null;
  altText: string | null;
  displayOrder: number;
}

/** GET /admin/approval-batches/:id — an item with what the admin reviews. */
export interface ProductApprovalReviewItemDto extends ProductApprovalBatchItemDto {
  product: (SubmittedProductDto & { images: ProductReviewImageDto[] }) | null;
}

export interface ProductApprovalBatchReviewDto extends Omit<ProductApprovalBatchDto, 'items'> {
  items: ProductApprovalReviewItemDto[];
}

export interface SubmitProductApprovalBatchRequest {
  productIds: string[];
}

export interface ReviewProductApprovalBatchItemRequest {
  status: ApprovalStatus;
  reviewNote?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Cart                                                                       */
/* -------------------------------------------------------------------------- */

export interface CartItemDto {
  id: string;
  sellerListingId: string;
  variantId: string;
  productId: string;
  sellerId: string;
  sellerName: string;
  productName: string;
  variantName: string;
  brandName: string | null;
  imageUrl: string | null;
  qty: number;
  mrpPaise: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  lineDiscountPaise: number;
  inStock: boolean;
  availableQty: number;
  maxQtyPerOrder: number;
  allowCod: boolean;
}

/**
 * One seller's slice of a mixed cart — a convenience grouping so the app can
 * render "Seller A (3 items) — ₹240" sections without re-deriving the
 * grouping itself from the flat `items` list.
 */
export interface CartSellerGroupDto {
  sellerId: string;
  sellerName: string;
  items: CartItemDto[];
  subtotalPaise: number;
  /** False while the seller is closed (switch OFF, closure, outside hours):
   * its lines stay in the cart, but checkout is blocked until it reopens. */
  isOpen: boolean;
  /** Customer-facing reason when `isOpen` is false. */
  closedMessage: string | null;
}

/**
 * A correction the server applied during revalidation. The app renders these
 * as a notice strip rather than silently changing the customer's cart.
 */
export interface CartChangeDto {
  type:
    | 'ITEM_REMOVED_UNAVAILABLE'
    | 'ITEM_REMOVED_OUT_OF_STOCK'
    | 'QTY_REDUCED_STOCK'
    | 'QTY_REDUCED_LIMIT'
    | 'PRICE_INCREASED'
    | 'PRICE_DECREASED'
    | 'COUPON_REMOVED';
  variantId: string | null;
  productName: string | null;
  message: string;
  previousValue?: number;
  newValue?: number;
}

export interface BillDto {
  itemCount: number;
  itemsSubtotalPaise: number;
  itemDiscountPaise: number;
  couponCode: string | null;
  couponDiscountPaise: number;
  deliveryFeePaise: number;
  /** Set when delivery is free, explaining why. */
  deliveryFeeWaivedReason: string | null;
  platformFeePaise: number;
  /** Tax included within the item prices, extracted for display only. */
  taxPaise: number;
  totalPaise: number;
  totalSavingsPaise: number;
}

export interface CartDto {
  id: string;
  items: CartItemDto[];
  /** `items` grouped by seller — see `CartSellerGroupDto`. */
  sellerGroups: CartSellerGroupDto[];
  bill: BillDto;
  changes: CartChangeDto[];
  /** False with a reason when the cart cannot proceed to checkout. */
  checkoutEnabled: boolean;
  checkoutBlockedReason: string | null;
  minOrderValuePaise: number;
  shortfallPaise: number;
}

export interface AddCartItemRequest {
  /** The specific seller's listing — NOT the bare variant id, since the same
   * variant can be listed by more than one seller at different prices. */
  sellerListingId: string;
  qty: number;
}

export interface UpdateCartItemRequest {
  qty: number;
}

/* -------------------------------------------------------------------------- */
/* Address                                                                    */
/* -------------------------------------------------------------------------- */

export interface AddressDto {
  id: string;
  label: string;
  fullName: string;
  mobile: string;
  houseNo: string | null;
  street: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  landmark: string | null;
  latitude: number;
  longitude: number;
  isDefault: boolean;
  isServiceable: boolean;
  distanceKm: number | null;
  createdAt: string;
}

export type UpsertAddressRequest = Omit<
  AddressDto,
  'id' | 'isServiceable' | 'distanceKm' | 'createdAt'
> & { isDefault?: boolean };

/* -------------------------------------------------------------------------- */
/* Checkout & orders                                                          */
/* -------------------------------------------------------------------------- */

export interface CheckoutQuoteRequest {
  addressId: string;
  couponCode?: string | null;
}

export interface CheckoutQuoteResponse {
  bill: BillDto;
  changes: CartChangeDto[];
  serviceability: ServiceabilityResult;
  codAllowed: boolean;
  /** Names the item blocking COD, so the UI can explain rather than hide. */
  codBlockedReason: string | null;
  availablePaymentMethods: PaymentMethod[];
  etaMinutes: number;
  etaMinMinutes: number;
  etaMaxMinutes: number;
}

export interface PlaceOrderRequest {
  addressId: string;
  paymentMethod: PaymentMethod;
  couponCode?: string | null;
  notes?: string | null;
  /**
   * The total the customer saw. Purely a safety check — if it disagrees with
   * the server's recomputed total the order is rejected with PRICE_CHANGED so
   * the customer re-confirms. It is NEVER used as the charged amount.
   */
  expectedTotalPaise?: number;
  /**
   * Per-item prices the customer's cart was showing, keyed by seller
   * listing (not bare variant — the same variant can have a different price
   * per seller). Optional, and purely a safety check like
   * `expectedTotalPaise` above — the charged amount always comes from the
   * server's own live lookup, never from this. What this DOES enable: when a
   * price genuinely changed, the server can say WHICH product and by how
   * much (see PRICE_CHANGED's `details` in order.service.ts) instead of only
   * "the total didn't match" — there is nowhere to read an "old price" from
   * otherwise, since cart_items deliberately stores no price of its own (see
   * the CartItem model's own comment).
   */
  expectedItems?: { sellerListingId: string; unitPricePaise: number }[];
}

export interface OrderItemDto {
  id: string;
  variantId: string;
  productName: string;
  variantName: string;
  brandName: string | null;
  imageUrl: string | null;
  sku: string;
  qty: number;
  mrpPaise: number;
  unitPricePaise: number;
  lineDiscountPaise: number;
  lineTotalPaise: number;
}

export interface OrderTimelineEntryDto {
  step: CustomerTimelineStep;
  label: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'PENDING';
  at: string | null;
}

/** One row in the seller/admin seller-order list — the parent order's own
 * identity plus this one seller's slice of it. */
export interface SellerOrderListRowDto {
  id: string;
  orderId: string;
  orderNumber: string;
  status: SellerOrderStatus;
  statusLabel: string;
  subtotalPaise: number;
  itemCount: number;
  customerName: string | null;
  customerMobile: string;
  createdAt: string;
}

/** One seller's portion of a parent order — see SellerOrder in schema.prisma. */
export interface SellerOrderSummaryDto {
  id: string;
  sellerId: string;
  sellerName: string;
  status: SellerOrderStatus;
  statusLabel: string;
  subtotalPaise: number;
  itemCount: number;
  items: OrderItemDto[];
  rejectionReason: string | null;
  cancellationReason: string | null;
}

export interface OrderSummaryDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  statusLabel: string;
  bucket: 'ONGOING' | 'DELIVERED' | 'CANCELLED';
  paymentMethod: PaymentMethod;
  paymentStatus: OrderPaymentStatus;
  totalPaise: number;
  /** What the customer must actually still pay/has paid — drops below
   * `totalPaise` if a seller portion was cancelled. See Order.currentPayablePaise. */
  currentPayablePaise: number;
  /** Total units across all lines (e.g. 4 units of one product is 4, not 1). */
  itemCount: number;
  /** Number of distinct order lines — what "N thumbnails" should count. */
  lineItemCount: number;
  /** First few item thumbnails, for the My Orders list. */
  itemThumbnails: string[];
  /** How many distinct sellers this order actually involves. */
  sellerCount: number;
  placedAt: string;
  deliveredAt: string | null;
}

export interface OrderDetailDto extends OrderSummaryDto {
  items: OrderItemDto[];
  sellerOrders: SellerOrderSummaryDto[];
  bill: BillDto;
  deliveryAddress: AddressDto;
  distanceKm: number;
  etaMinutes: number | null;
  promisedAt: string | null;
  timeline: OrderTimelineEntryDto[];
  cancellationReason: string | null;
  canCancel: boolean;
  /** Only populated once a rider is assigned and out for delivery. */
  deliveryAgent: { name: string; mobile: string } | null;
  /** Shown to the customer to read out at the door on COD orders. */
  deliveryOtp: string | null;
  notes: string | null;
}

export interface CancelOrderRequest {
  reason: string;
}

/** Seller/admin action on one SellerOrder — accept, reject, prepare, ready, cancel. */
export interface UpdateSellerOrderStatusRequest {
  toStatus: SellerOrderStatus;
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreatePaymentRequest {
  orderId: string;
}

export interface CreatePaymentResponse {
  paymentId: string;
  provider: string;
  providerOrderId: string;
  publicKey: string;
  amountPaise: number;
  currency: string;
  /** Pre-filled customer details for the provider's checkout sheet. */
  prefill: { name: string | null; email: string | null; contact: string };

  /**
   * Direct-UPI mode only. A `upi://pay?...` link the phone hands to the
   * customer's UPI app.
   */
  upiIntentUrl?: string;
  upiVpa?: string;
  /**
   * True when no gateway will confirm this payment. The app must show
   * "I have paid" and tell the customer the store will verify — waiting for a
   * callback that never comes would leave them staring at a spinner.
   */
  requiresManualConfirmation?: boolean;
}

/** Customer's claim that they paid by UPI. Not proof — see the UPI provider. */
export interface ClaimUpiPaymentRequest {
  orderId: string;
  /** 12-digit UTR from the customer's payment receipt, if they have it. */
  utr?: string | null;
}

export interface VerifyPaymentRequest {
  orderId: string;
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface VerifyPaymentResponse {
  verified: boolean;
  orderStatus: OrderStatus;
  paymentStatus: OrderPaymentStatus;
}

/* -------------------------------------------------------------------------- */
/* Coupons                                                                    */
/* -------------------------------------------------------------------------- */

export interface CouponDto {
  code: string;
  description: string | null;
  type: CouponType;
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  validTo: string | null;
}

/* -------------------------------------------------------------------------- */
/* Referrals & reward coupons                                                 */
/* -------------------------------------------------------------------------- */

export type RewardCouponStatus = 'ACTIVE' | 'USED' | 'EXPIRED';

/**
 * A coupon issued to one specific user — a referral reward today, the same
 * shape a future user-targeted promo would use (see `origin`). Status is
 * always computed fresh from `validTo`/redemption state, never stored, so a
 * coupon that has simply aged past its expiry is never shown as usable.
 */
export interface RewardCouponDto {
  code: string;
  origin: CouponOrigin;
  status: RewardCouponStatus;
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  issuedAt: string;
  expiresAt: string | null;
  /** e.g. "Expires in 6 days" / "Expires tomorrow" / "Expires today". Null once USED/EXPIRED. */
  expiresInLabel: string | null;
  usedAt: string | null;
}

export interface ApplyReferralCodeRequest {
  code: string;
}

/** One row in "your referrals" — never exposes the referred user's full contact details. */
export interface ReferralHistoryRowDto {
  referredDisplayName: string;
  status: ReferralStatus;
  rewardCouponCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ReferralSummaryDto {
  referralCode: string | null;
  referredCount: number;
  completedCount: number;
  rewardsIssuedCount: number;
  history: ReferralHistoryRowDto[];
}

/** Admin's Referrals table row — full detail, unmasked (staff-only surface). */
export interface ReferralAdminRowDto {
  id: string;
  referrerMobile: string;
  referrerName: string | null;
  referredMobile: string;
  referredName: string | null;
  referralCode: string;
  status: ReferralStatus;
  firstEligibleOrderId: string | null;
  rewardCouponCode: string | null;
  rewardCouponStatus: RewardCouponStatus | null;
  createdAt: string;
  completedAt: string | null;
  rewardIssuedAt: string | null;
}

export interface ReferralAdminStatsDto {
  totalReferrals: number;
  completedReferrals: number;
  pendingReferrals: number;
  rewardsIssued: number;
  couponsUsed: number;
  couponsExpired: number;
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  orderId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface RegisterDeviceRequest {
  token: string;
  platform: 'ANDROID' | 'IOS' | 'WEB';
  appVersion?: string;
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

export interface AdminDashboardDto {
  /** The seller-local calendar day ("YYYY-MM-DD") this snapshot reports on. */
  date: string;
  /** False when `date` is a historical day rather than today. */
  isToday: boolean;
  todayOrderCount: number;
  todayRevenuePaise: number;
  totalOrderCount: number;
  totalRevenuePaise: number;
  ordersByStatus: { status: OrderStatus; count: number }[];
  pendingOrderCount: number;
  completedTodayCount: number;
  cancelledTodayCount: number;
  lowStockCount: number;
  lowStockItems: {
    sellerListingId: string;
    sellerName: string;
    productName: string;
    variantName: string;
    availableQty: number;
    lowStockThreshold: number;
  }[];
}

export interface AdminOrderSummaryDto extends OrderSummaryDto {
  customerName: string | null;
  customerMobile: string;
  distanceKm: number;
  addressSummary: string;
  deliveryAgentName: string | null;
  minutesSincePlaced: number;
  /**
   * Set when a customer has claimed a direct-UPI payment that no seller/admin
   * has yet confirmed. The UTR is what the shopkeeper matches against their
   * own UPI app — without it they are searching by amount and time alone.
   */
  paymentClaim: { utr: string | null; claimedAt: string | null } | null;
}

export interface UpdateOrderStatusRequest {
  toStatus: OrderStatus;
  reason?: string;
  /** Required when marking a COD order delivered and delivery OTP is enabled. */
  deliveryOtp?: string;
  cashCollectedPaise?: number;
}

export interface DeliveryAgentDto {
  id: string;
  name: string;
  mobile: string;
  vehicleNumber: string | null;
  isActive: boolean;
  isAvailable: boolean;
  activeOrderCount: number;
}

/** V1: DeliveryAssignmentDto. Belongs to the PARENT order, never a single seller. */
export interface DeliveryTaskDto {
  id: string;
  orderId: string;
  agentId: string;
  agentName: string;
  status: DeliveryTaskStatus;
  assignedAt: string;
  deliveredAt: string | null;
  cashCollectedPaise: number | null;
}

export interface UpsertSellerListingRequest {
  pricePaise?: number;
  mrpPaise?: number;
  stockQty?: number;
  isAvailable?: boolean;
  allowCod?: CodPolicy;
  maxQtyPerOrder?: number;
  lowStockThreshold?: number;
}

/* -------------------------------------------------------------------------- */
/* Settlement                                                                 */
/* -------------------------------------------------------------------------- */

export interface SellerSettlementDto {
  id: string;
  sellerId: string;
  sellerName: string;
  periodStart: string;
  periodEnd: string;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  status: SettlementStatus;
  paidAt: string | null;
}
