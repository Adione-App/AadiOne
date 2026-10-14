/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

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
  DeliveryMode,
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
  /** Configured preparation time in minutes; customers see prepTimeRange() of it. */
  avgPrepMins: number | null;
  /** Customer-facing images (see RestaurantDto); absent from older servers. */
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  menuImageUrl?: string | null;
}

/**
 * A restaurant's time as customers see it, from its configured preparation
 * time: that time − 5 to + 5 minutes (never below 1) — 30 → "25–35 min",
 * 20 → "15–25 min". The ONE rule for every customer-facing restaurant time
 * (Food list card, menu page, Home) and the panels' previews. Null when the
 * restaurant has not set a time — nothing is invented.
 */
export function prepTimeRange(avgPrepMins: number | null | undefined): { min: number; max: number; label: string } | null {
  if (typeof avgPrepMins !== 'number' || !Number.isFinite(avgPrepMins) || avgPrepMins <= 0) return null;
  const minutes = Math.round(avgPrepMins);
  const min = Math.max(1, minutes - 5);
  const max = minutes + 5;
  return { min, max, label: `${min}–${max} min` };
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
  /** Onboarding data may be edited now (ONBOARDING_PENDING / CHANGES_REQUIRED / REJECTED). */
  canEditOnboarding: boolean;
  /** Editable AND every checklist item met. */
  canSubmit: boolean;
  checklist: SellerOnboardingChecklistItemDto[];
  applicationSubmittedAt: string | null;
  onboardingSubmittedAt: string | null;
  activatedAt: string | null;
  lifecycleUpdatedAt: string | null;
  /** Owner name on the business profile — pre-fills a rejected applicant's resubmission. */
  ownerFullName: string | null;
}

/**
 * POST /seller/lifecycle/application — a rejected applicant corrects its
 * application (the signup's business fields) and sends it back to Gate 1.
 */
export interface SellerApplicationResubmitRequest {
  businessName: string;
  fullName: string;
  sellerType: SellerType;
}

/** One lifecycle event from the audit trail (admin review history). */
export interface SellerLifecycleEventDto {
  event:
    | 'APPLICATION_SUBMITTED'
    | 'APPLICATION_RESUBMITTED'
    | 'APPLICATION_APPROVED'
    | 'APPLICATION_REJECTED'
    | 'ONBOARDING_SUBMITTED'
    | 'ONBOARDING_RESUBMITTED'
    | 'CHANGES_REQUESTED'
    | 'ONBOARDING_APPROVED'
    | 'ONBOARDING_REJECTED';
  at: string;
  /** The reason given with a rejection / request for changes. */
  reason: string | null;
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
  /** Shop / building and street. */
  addressLine: string;
  locality?: string | null;
  /** Village / city / town. */
  city: string;
  district?: string | null;
  state: string;
  pincode: string;
  landmark?: string | null;
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
  locality: string | null;
  city: string;
  district: string | null;
  state: string;
  pincode: string;
  landmark: string | null;
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
  /** Every application / onboarding submission and decision, newest first (from the audit trail). */
  lifecycleHistory: SellerLifecycleEventDto[];
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
  /** false = made-to-order food item (restaurant/cafe): no stock count, availability only. */
  tracksStock: boolean;
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
  /** Display label such as "1 kg", "500 ml", "Pack of 6", "Large / Black". */
  variantName: string;
  /** This variant's option values ({} for a simple item); see ProductDto.optionGroups. */
  optionValues: ProductOptionValuesDto;
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
  /** Option groups to pick a variant by (e.g. Size: Half / Full); [] for a simple item. */
  optionGroups: ProductOptionGroupDto[];
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
/** A banner as customers receive it (GET /banners?placement=…, HomeFeedDto.banners). */
export interface BannerDto {
  id: string;
  imageUrl: string;
  /** Pixel size of the stored image — show it at this aspect ratio, uncropped. */
  imageWidth: number;
  imageHeight: number;
  title: string | null;
  subtitle: string | null;
  /** Optional button text drawn on the banner (e.g. "Order now"); null = no button. Absent from older servers. */
  ctaLabel?: string | null;
  actionType: BannerActionTypeDto;
  /**
   * What the tap opens, by actionType: a category / product / seller id, a
   * coupon code, a rail key (BANNER_RAIL_TARGETS) or an https URL; null for
   * NONE. Customers get NONE (non-interactive) when the target no longer exists.
   */
  actionValue: string | null;
  /** How the banner is drawn (see BannerLayoutDto); absent from older servers = the defaults. */
  layout?: BannerLayoutDto;
}

/** What tapping a banner does. NONE = a purely decorative image. */
export type BannerActionTypeDto = 'CATEGORY' | 'PRODUCT' | 'COUPON' | 'STORE' | 'RESTAURANT' | 'RAIL' | 'URL' | 'NONE';

/* -------------------------------------------------------------------------- */
/* Banner presentation — set per banner in the Admin Panel                    */
/* -------------------------------------------------------------------------- */

/**
 * banner  an image (optionally with title/subtitle under it); several in one
 *         placement become a swipeable carousel
 * card    a compact image card with its title and subtitle beside it
 * tile    a small image; several in one placement sit side by side
 * strip   a slim full-width announcement image
 * split   headline, subtitle and button on the left, image on the right
 *         (the Food hero)
 */
export const BANNER_VARIANTS = ['banner', 'card', 'tile', 'strip', 'split'] as const;
export type BannerVariant = (typeof BANNER_VARIANTS)[number];

export interface BannerLayoutDto {
  variant?: BannerVariant;
  /** Frame width ÷ height; null = the image's own shape. Ignored when `height` is set. */
  aspectRatio?: number | null;
  /** Fixed frame height in dp; null = from the aspect ratio. Clamped to BANNER_HEIGHT_LIMITS. */
  height?: number | null;
  /** full = edge to edge; content = inside the screen's side margins. */
  width?: 'full' | 'content';
  /** contain = the whole image, may leave empty space; cover = fills the frame, may crop. Never stretched. */
  fit?: 'contain' | 'cover';
  alignX?: 'left' | 'center' | 'right';
  alignY?: 'top' | 'center' | 'bottom';
  radius?: 'none' | 'sm' | 'md' | 'lg';
  /** Theme colors only. */
  background?: 'none' | 'white' | 'green' | 'grey';
}

export const BANNER_HEIGHT_LIMITS = { min: 48, max: 420 } as const;
export const BANNER_ASPECT_LIMITS = { min: 0.5, max: 6 } as const;

/** Ready-made frame shapes for the Admin Panel; null = the image's own shape. */
export const BANNER_ASPECT_PRESETS: readonly { label: string; value: number | null }[] = [
  { label: "Image's own shape", value: null },
  { label: 'Wide 16:9', value: 16 / 9 },
  { label: 'Banner 2:1', value: 2 },
  { label: 'Strip 4:1', value: 4 },
  { label: 'Card 4:3', value: 4 / 3 },
  { label: 'Square 1:1', value: 1 },
  { label: 'Portrait 4:5', value: 0.8 },
];

export type ResolvedBannerLayout = Required<BannerLayoutDto>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A banner's layout with every field filled in and every number within safe
 * limits — the ONE place defaults and clamping live (server, Admin Panel
 * preview and app all use it). `defaultVariant` comes from the placement.
 */
export function resolveBannerLayout(layout: BannerLayoutDto | null | undefined, defaultVariant: BannerVariant = 'banner'): ResolvedBannerLayout {
  const value = layout ?? {};
  const pick = <T extends string>(candidate: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(candidate as T) ? (candidate as T) : fallback;
  const aspect = typeof value.aspectRatio === 'number' && Number.isFinite(value.aspectRatio) ? value.aspectRatio : null;
  const height = typeof value.height === 'number' && Number.isFinite(value.height) ? value.height : null;
  return {
    variant: pick(value.variant, BANNER_VARIANTS, defaultVariant),
    aspectRatio: aspect === null ? null : clamp(aspect, BANNER_ASPECT_LIMITS.min, BANNER_ASPECT_LIMITS.max),
    height: height === null ? null : Math.round(clamp(height, BANNER_HEIGHT_LIMITS.min, BANNER_HEIGHT_LIMITS.max)),
    width: pick(value.width, ['full', 'content'] as const, 'content'),
    fit: pick(value.fit, ['contain', 'cover'] as const, 'contain'),
    alignX: pick(value.alignX, ['left', 'center', 'right'] as const, 'center'),
    alignY: pick(value.alignY, ['top', 'center', 'bottom'] as const, 'center'),
    radius: pick(value.radius, ['none', 'sm', 'md', 'lg'] as const, 'lg'),
    background: pick(value.background, ['none', 'white', 'green', 'grey'] as const, 'none'),
  };
}

/** Screen-edge margin the app keeps around a "content"-width banner (dp). */
export const BANNER_SIDE_MARGIN = 16;

/**
 * The frame one banner is drawn in, in dp — the SAME numbers in the app and
 * in the Admin Panel's phone preview. `screenWidth` is the full screen width;
 * `imageAspect` the stored image's width ÷ height; `count` how many banners
 * share the placement (tiles sit side by side, up to three per row).
 * The image is then drawn inside this frame with `fit` — never stretched.
 */
export function bannerFrameSize(
  layout: ResolvedBannerLayout,
  screenWidth: number,
  imageAspect: number,
  count = 1,
): { width: number; height: number; imageWidth: number } {
  const limit = (value: number) => Math.round(clamp(value, BANNER_HEIGHT_LIMITS.min, BANNER_HEIGHT_LIMITS.max));
  const shape = layout.aspectRatio ?? (imageAspect > 0 ? imageAspect : 2);
  const width = layout.width === 'full' && layout.variant !== 'tile' ? screenWidth : screenWidth - BANNER_SIDE_MARGIN * 2;
  switch (layout.variant) {
    case 'tile': {
      const perRow = Math.min(Math.max(count, 1), 3);
      const tile = (width - 10 * (perRow - 1)) / perRow;
      return { width: Math.floor(tile), height: limit(layout.height ?? tile / (layout.aspectRatio ?? 1)), imageWidth: Math.floor(tile) };
    }
    case 'card': {
      const imageWidth = Math.round(width * 0.32);
      return { width, height: limit(layout.height ?? clamp(imageWidth / shape, 72, 160)), imageWidth };
    }
    case 'split': {
      const imageWidth = Math.round(width * 0.45);
      return { width, height: limit(layout.height ?? clamp(imageWidth / shape, 130, 220)), imageWidth };
    }
    case 'strip':
      return { width, height: limit(layout.height ?? clamp(width / shape, 48, 96)), imageWidth: width };
    default:
      return { width, height: limit(layout.height ?? width / shape), imageWidth: width };
  }
}

/** Product listings a banner can open (the app's existing rails, by key). */
export const BANNER_RAIL_TARGETS: readonly { key: string; label: string }[] = [
  { key: 'OFFERS', label: 'Offers' },
  { key: 'POPULAR', label: 'Popular' },
  { key: 'BEST_SELLERS', label: 'Best sellers' },
  { key: 'TOP_PICKS', label: 'Top picks' },
  { key: 'DAILY_ESSENTIALS', label: 'Daily essentials' },
  { key: 'RECENTLY_ADDED', label: 'Recently added' },
];

/** GET/POST/PATCH /admin/banners — a banner with its management fields. */
export interface AdminBannerDto extends BannerDto {
  /** Where it shows: a slug such as "home_top", "food" or "categories_top" (see BANNER_PLACEMENTS). */
  placement: string;
  displayOrder: number;
  isActive: boolean;
  /** DRAFT = never shown; PUBLISHED = shown while on and inside its schedule; ARCHIVED = retired. Absent from older servers. */
  status?: BannerStatusDto;
  /** Optional schedule (ISO); null = no limit on that side. */
  startsAt?: string | null;
  endsAt?: string | null;
  /** What customers see right now, from status + switch + schedule. */
  visibility?: BannerVisibility;
  createdAt: string;
  updatedAt: string;
}

/**
 * The admin banner placements the customer Home page shows. A placement is a
 * free-form slug (see AdminBannerDto.placement); these are the ones Home asks
 * for, delivered in HomeFeedDto.
 *
 *   home_top       the main carousel under the search bar
 *   home_food      above the restaurants row
 *   home_category  directly above the shelf of the category the banner opens
 *                  (its CATEGORY action decides where it shows)
 *   home_explore   above "Explore more categories"
 *   home_bottom    the last banner on the page
 */
export const HOME_BANNER_PLACEMENTS = {
  TOP: 'home_top',
  FOOD: 'home_food',
  CATEGORY: 'home_category',
  EXPLORE: 'home_explore',
  BOTTOM: 'home_bottom',
} as const;

export type HomeBannerPlacement = (typeof HOME_BANNER_PLACEMENTS)[keyof typeof HOME_BANNER_PLACEMENTS];

export type BannerStatusDto = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type BannerVisibility = 'LIVE' | 'SCHEDULED' | 'ENDED' | 'OFF' | 'DRAFT' | 'ARCHIVED';

/** Whether customers see a banner right now (the server's own rule for GET /banners). */
export function bannerVisibility(
  banner: { status?: BannerStatusDto; isActive: boolean; startsAt?: string | null; endsAt?: string | null },
  now: Date = new Date(),
): BannerVisibility {
  if (banner.status === 'DRAFT') return 'DRAFT';
  if (banner.status === 'ARCHIVED') return 'ARCHIVED';
  if (!banner.isActive) return 'OFF';
  if (banner.startsAt && new Date(banner.startsAt) > now) return 'SCHEDULED';
  if (banner.endsAt && new Date(banner.endsAt) <= now) return 'ENDED';
  return 'LIVE';
}

/**
 * Every place the app shows admin banners — the registry the Admin Panel
 * offers and the server accepts (plus the per-category "home_category"
 * shelf banners). `defaultVariant` is how a banner there is drawn unless
 * the admin picks another; a placement with nothing live shows nothing at
 * all (no empty space).
 */
export interface BannerPlacementInfo {
  key: string;
  screen: 'Home' | 'Food' | 'Categories' | 'Store';
  label: string;
  hint: string;
  defaultVariant: BannerVariant;
}

export const BANNER_PLACEMENTS: readonly BannerPlacementInfo[] = [
  { key: 'home_top', screen: 'Home', label: 'Home — top carousel', hint: 'The swipeable banners at the top of Home.', defaultVariant: 'banner' },
  { key: 'home_food', screen: 'Home', label: 'Home — above the restaurants', hint: 'Shown above the Food section on Home.', defaultVariant: 'banner' },
  { key: 'home_category', screen: 'Home', label: 'Home — above a category shelf', hint: 'Must open a category; shown above that category\'s shelf.', defaultVariant: 'banner' },
  { key: 'home_explore', screen: 'Home', label: 'Home — explore more categories', hint: 'Shown above the subcategory grid.', defaultVariant: 'banner' },
  { key: 'home_bottom', screen: 'Home', label: 'Home — final banner (bottom)', hint: 'The last banner on the page.', defaultVariant: 'banner' },
  { key: 'food', screen: 'Food', label: 'Food — top hero', hint: 'The top of the Food screen. With none live, the screen starts straight with its filters.', defaultVariant: 'split' },
  { key: 'food_background', screen: 'Food', label: 'Food — header background', hint: 'An image only, behind the Food header. The first live one is used.', defaultVariant: 'banner' },
  { key: 'food_list', screen: 'Food', label: 'Food — between restaurants', hint: 'Shown after the second restaurant in the list.', defaultVariant: 'banner' },
  { key: 'categories_top', screen: 'Categories', label: 'Categories — top', hint: 'Above the main categories on the Categories screen.', defaultVariant: 'banner' },
  { key: 'categories_mid', screen: 'Categories', label: 'Categories — between sections', hint: 'After the second category section.', defaultVariant: 'banner' },
  { key: 'store_top', screen: 'Store', label: 'Store pages — top', hint: 'At the top of every store page.', defaultVariant: 'banner' },
];

export function bannerPlacementInfo(placement: string): BannerPlacementInfo | undefined {
  return BANNER_PLACEMENTS.find((entry) => entry.key === placement);
}

/**
 * The admin banner placements the customer Food screen shows
 * (GET /banners?placement=…):
 *
 *   food             the hero: image + headline (title), subtitle, optional
 *                    button (ctaLabel); several rotate
 *   food_background  an image-only backdrop behind the Food header and hero
 */
export const FOOD_BANNER_PLACEMENTS = {
  HERO: 'food',
  BACKGROUND: 'food_background',
  /** Banners between restaurants — after the second place. */
  LIST: 'food_list',
} as const;

/**
 * Home placements delivered as HomeFeedDto.sectionBanners — everything except
 * the top carousel (HomeFeedDto.banners) and the per-category banners
 * (HomeFeedDto.categoryBanners).
 */
export type HomeSectionBannerPlacement = Exclude<HomeBannerPlacement, 'home_top' | 'home_category'>;

export interface HomeFeedDto {
  /** The "home_top" placement's active banners, in order. */
  banners: BannerDto[];
  /**
   * Active banners of Home's other placements, in order — an empty or missing
   * placement shows nothing. Optional: absent from servers older than it.
   */
  sectionBanners?: Partial<Record<HomeSectionBannerPlacement, BannerDto[]>>;
  /**
   * "home_category" banners grouped under the top category whose shelf they
   * sit above (`categoryId` = that category's id in `categories`). The
   * server resolves the banner's target — any seller's row, or a subcategory —
   * to its top category; a banner whose category is not on Home is left out.
   * Optional: absent from servers older than it.
   */
  categoryBanners?: { categoryId: string; banners: BannerDto[] }[];
  /**
   * Top categories (merged by path, so their representative ids) in Home
   * order: the admin's HOME_CATEGORY_ORDER first, then every other live top
   * category. Children carry their own order.
   */
  categories: CategoryDto[];
  /**
   * The categories the admin placed first on Home (HOME_CATEGORY_ORDER), in
   * that order — Home shows their shelves among the main shopping sections
   * and the rest of the categories further down. Empty when none are set.
   * Optional: absent from servers older than it.
   */
  featuredCategoryIds?: string[];
  rails: {
    key: 'POPULAR' | 'DAILY_ESSENTIALS' | 'BEST_SELLERS' | 'RECENTLY_ADDED' | 'OFFERS' | 'TOP_PICKS';
    title: string;
    products: ProductSummaryDto[];
  }[];
  /**
   * One rail per top-level category with in-stock products, in the same order
   * as `categories`, so a newly added category gets its own visible shelf on
   * Home. Its products are spread across the category's subcategories: one
   * from each before a second from any (see getHomeFeed).
   */
  categoryRails: {
    categoryId: string;
    title: string;
    products: ProductSummaryDto[];
  }[];
}

/* -------------------------------------------------------------------------- */
/* Customer discovery — stores, restaurants, offers                           */
/* -------------------------------------------------------------------------- */

/** A live marketplace (non-food) seller as a customer browses it — GET /stores. */
export interface StoreSummaryDto {
  id: string;
  name: string;
  sellerType: SellerType;
  city: string;
  /** Customer-visible products this seller lists right now. */
  productCount: number;
  /** The seller's own top categories that have visible products, in its order (max 3). */
  categoryNames: string[];
  /** Real images of up to 3 of its products, for the store card. */
  previewImageUrls: string[];
  isOpen: boolean;
  nextOpenText: string | null;
  /** Straight-line km from the customer; null when no location was given. */
  distanceKm: number | null;
}

/** A live restaurant or cafe (the food seller types). */
export interface RestaurantDto {
  sellerId: string;
  sellerType: SellerType;
  name: string;
  addressLine: string;
  city: string;
  pincode: string;
  latitude: number;
  longitude: number;
  phone: string | null;
  cuisine: string[];
  isVegOnly: boolean;
  avgPrepMins: number | null;
  isOpen: boolean;
  nextOpenText: string | null;
  /** The restaurant's own logo (Admin Panel → Seller → Restaurant); null when none. Absent from older servers. */
  logoUrl?: string | null;
  /** The place itself (storefront / interior) — the Food list card; null when none was set. Absent from older servers. */
  coverImageUrl?: string | null;
  /** The food / menu hero at the top of its menu page — never the Food list card; null when none. Absent from older servers. */
  menuImageUrl?: string | null;
}

/** One row of GET /restaurants. */
export interface RestaurantSummaryDto extends RestaurantDto {
  menuItemCount: number;
  /** The restaurant's cover photo, else a real photo of one of its menu items; null when it has neither. */
  coverImageUrl: string | null;
  /** Straight-line km from the customer; null when no location was given. */
  distanceKm: number | null;
  /**
   * VEG = a pure-veg kitchen; NON_VEG = at least one live non-veg item on the
   * menu; null = neither is known. Absent from older servers.
   */
  diet?: FoodDiet | null;
  /**
   * What its live menu offers, from the veg / non-veg mark on each item (a
   * pure-veg kitchen serves veg): the card's green / red marks — a place with
   * both shows both — and what the Veg / Non-Veg filters mean. Absent from older servers.
   */
  servesVeg?: boolean;
  servesNonVeg?: boolean;
  /** Delivery fee to the customer's location (the configured fee slabs); null without a location. Absent from older servers. */
  deliveryFeePaise?: number | null;
  /** Delivery time range to the customer's location (the same estimate checkout promises); null without a location. */
  etaMinMinutes?: number | null;
  etaMaxMinutes?: number | null;
}

/** GET /restaurants filters. */
export interface RestaurantListQuery {
  /** VEG = places that serve veg (servesVeg); NON_VEG = places that serve non-veg (servesNonVeg). */
  diet?: FoodDiet;
  /** RESTAURANT or CAFE. */
  type?: 'RESTAURANT' | 'CAFE';
}

/** One orderable entry on a restaurant menu (one per sellable variant). */
export interface RestaurantMenuItemDto {
  sellerListingId: string;
  sellerId: string;
  restaurantName: string;
  productId: string;
  variantId: string;
  name: string;
  description: string | null;
  variantName: string;
  optionValues: ProductOptionValuesDto;
  optionGroups: ProductOptionGroupDto[];
  imageUrl: string | null;
  mrpPaise: number;
  pricePaise: number;
  inStock: boolean;
  diet: FoodDiet | null;
  maxQtyPerOrder: number;
}

export interface RestaurantMenuSectionDto {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isActive: boolean;
  /** The section's image (set from the Admin Panel's Marketplace Catalogue), if any. */
  imageUrl: string | null;
  menuId: string | null;
  menuName: string | null;
  items: RestaurantMenuItemDto[];
}

/** GET /restaurants/:sellerId — Menu → Menu Section → Food Item. */
export interface RestaurantMenuDto {
  restaurant: RestaurantDto;
  menus: { id: string; name: string; sections: RestaurantMenuSectionDto[] }[];
  sections: RestaurantMenuSectionDto[];
}

/** A promo code any customer may apply right now — GET /offers. */
export interface OfferDto {
  code: string;
  description: string | null;
  type: CouponType;
  /** PERCENT: whole percent. FLAT: paise. FREE_DELIVERY: unused. */
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  /** ISO-8601; null = no end date. */
  validTo: string | null;
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
 * A product's optional option group (Size, Portion, Color, Storage, Pack
 * Size…) and its values in display order. No groups = a simple item.
 */
export interface ProductOptionGroupDto {
  name: string;
  values: string[];
}

/** A variant's pick per option group, e.g. { Size: "Large" }; {} for a simple item. */
export type ProductOptionValuesDto = Record<string, string>;

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
  /** Option groups; [] for a simple item. */
  optionGroups: ProductOptionGroupDto[];
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
  /** false = made-to-order food item (restaurant/cafe): no MRP or stock, availability only. */
  tracksStock: boolean;
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
  /** Food items only (restaurant/cafe): veg / non-veg, when the seller set it. */
  diet: FoodDiet | null;
  /** Every live variant, default first — each with its own listing (price, stock, availability). */
  variants: SellerProductVariantDto[];
}

/** One sellable variant of a seller's own product. */
export interface SellerProductVariantDto extends SubmittedProductVariantDto {
  optionValues: ProductOptionValuesDto;
  isDefault: boolean;
  /** PENDING = added to an approved product, waiting for Aadione (hidden meanwhile). */
  approvalStatus: ApprovalStatus;
  listing: SellerProductListingDto | null;
}

export type FoodDiet = 'VEG' | 'NON_VEG';

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

/**
 * POST /seller/approval-batches. Without `productIds`: every complete,
 * never-submitted product of the seller goes into ONE new batch ("Submit for
 * Approval"). With `productIds`: exactly those (e.g. resubmitting a rejected
 * product after fixing it).
 */
export interface SubmitProductApprovalBatchRequest {
  productIds?: string[];
}

/** A batch in a list — counts only, never its (possibly 1000+) items. */
export interface ProductApprovalBatchSummaryDto extends Omit<ProductApprovalBatchDto, 'items'> {
  sellerType: string;
  itemCount: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  /** Distinct categories (top categories and subcategories) the products sit in. */
  categoryCount: number;
}

/** One product of a batch as admin scans it — compact, no full detail. */
export interface ProductApprovalBatchProductRowDto {
  itemId: string;
  productId: string;
  itemStatus: ApprovalStatus;
  reviewNote: string | null;
  name: string;
  /**
   * The product's brand (customers see it once the product is approved).
   * `isNew`: a seller's bulk import created this brand (audit log
   * `brand.import_create`) and no approved, live product uses it yet — so
   * approving this product is what makes the brand public.
   */
  brand: { id: string; name: string; isNew: boolean } | null;
  category: string;
  subcategory: string | null;
  sku: string | null;
  variantName: string | null;
  /** The seller's own price/stock, exactly as entered — review never changes them. */
  mrpPaise: number | null;
  pricePaise: number | null;
  stockQty: number | null;
  thumbUrl: string | null;
  productStatus: ProductStatus;
  /** The seller removed the product after submitting it. */
  removed: boolean;
  /** Option groups; [] for a simple item. */
  optionGroups: ProductOptionGroupDto[];
  /** Every live variant with the seller's own figures and its review state. */
  variants: ProductApprovalBatchVariantRowDto[];
}

export interface ProductApprovalBatchVariantRowDto {
  id: string;
  variantName: string;
  optionValues: ProductOptionValuesDto;
  /** PENDING = new variant of an approved product, decided by this review. */
  approvalStatus: ApprovalStatus;
  pricePaise: number | null;
  mrpPaise: number | null;
  stockQty: number | null;
  tracksStock: boolean;
  isAvailable: boolean;
}

export interface ProductApprovalBatchProductsPageDto {
  total: number;
  offset: number;
  items: ProductApprovalBatchProductRowDto[];
}

/** POST /admin/approval-batches/:id/approve — what one click decided. */
export interface ApproveProductBatchResultDto {
  batch: ProductApprovalBatchSummaryDto;
  approvedCount: number;
  /** Items whose product the seller deleted meanwhile — closed as rejected. */
  removedCount: number;
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
  /** Locality / mohalla / colony. */
  area: string;
  /** Village / city / town. */
  city: string;
  /** NULL on addresses saved before districts were collected. */
  district: string | null;
  state: string;
  pincode: string;
  landmark: string | null;
  latitude: number;
  longitude: number;
  /** GPS / MAP_PIN / GEOCODED (approximate); null = origin not recorded (older address). */
  locationSource: 'GPS' | 'MAP_PIN' | 'GEOCODED' | null;
  /** Reported accuracy radius of a GPS fix, metres. */
  locationAccuracyM: number | null;
  isDefault: boolean;
  isServiceable: boolean;
  /** Straight-line km to the nearest serving store (not a road distance). */
  distanceKm: number | null;
  createdAt: string;
}

export type UpsertAddressRequest = Omit<
  AddressDto,
  'id' | 'isServiceable' | 'distanceKm' | 'createdAt' | 'district' | 'locationSource' | 'locationAccuracyM'
> & {
  isDefault?: boolean;
  /** Optional for older app versions; the current forms always send it. */
  district?: string | null;
  locationSource?: 'GPS' | 'MAP_PIN' | 'GEOCODED' | null;
  locationAccuracyM?: number | null;
};

/* -------------------------------------------------------------------------- */
/* Checkout & orders                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A LIVE_LOCATION destination: the GPS point the customer is at, plus the
 * recipient and whatever address details they confirmed. Used for this
 * order only — never saved as an address. House / street, locality,
 * district and PIN may be missing (the customer may not know them); the
 * point is what the rider goes to.
 */
export interface LiveLocationInput {
  latitude: number;
  longitude: number;
  /** The device's accuracy radius for the fix, metres. */
  accuracyM?: number | null;
  fullName: string;
  mobile: string;
  houseNo?: string | null;
  street?: string | null;
  /** Locality / mohalla / colony. */
  area?: string | null;
  /** Village / city / town. */
  city: string;
  district?: string | null;
  state: string;
  pincode?: string | null;
}

/**
 * Checkout and order placement take exactly ONE destination: a saved
 * address the customer owns (`addressId`) or a live location
 * (`liveLocation`). Sending both, or neither, is rejected.
 */
export interface DeliveryDestinationRequest {
  addressId?: string;
  liveLocation?: LiveLocationInput;
}

export interface CheckoutQuoteRequest extends DeliveryDestinationRequest {
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

export interface PlaceOrderRequest extends DeliveryDestinationRequest {
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
  /** The product photo as it was when ordered (snapshot); null = none uploaded. */
  imageUrl: string | null;
  /** Option picks as ordered, e.g. { Size: "M", Color: "Black" }; {} for a simple item. */
  optionValues: ProductOptionValuesDto;
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
  /** SAVED_ADDRESS, or LIVE_LOCATION: delivered to `deliveryAddress`'s GPS point. */
  deliveryMode: DeliveryMode;
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

/**
 * One customer on the admin Customers page — GET /admin/customers. Counts and
 * spend follow the single sale definition (PLACED_ORDER_STATUSES /
 * COMPLETED_SALE_STATUSES): a cancelled, payment-failed or unpaid order is
 * never an order "had" and never money "spent".
 */
export interface AdminCustomerRowDto {
  userId: string;
  name: string | null;
  mobile: string;
  /** Placed orders that still stand (in progress or delivered). */
  orderCount: number;
  /** Of those, still in progress (not delivered yet). */
  activeOrderCount: number;
  /** Cancelled, payment-failed or refunded orders — shown, never counted as sales. */
  cancelledOrderCount: number;
  /** Delivered orders' value, net of cancelled seller portions. */
  totalSpentPaise: number;
  lastOrderAt: string;
}

export interface AdminCustomersDto {
  /** Over every customer, not just this page or search. */
  summary: {
    /** Customers with at least one placed order. */
    customerCount: number;
    /** Customers with two or more placed orders. */
    repeatCustomerCount: number;
    /** Sum of every customer's totalSpentPaise. */
    revenuePaise: number;
  };
  items: AdminCustomerRowDto[];
  total: number;
  page: number;
  pageSize: number;
}

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
  /** LIVE_LOCATION orders go to the GPS point below, not a saved address. */
  deliveryMode: DeliveryMode;
  deliveryLatitude: number;
  deliveryLongitude: number;
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
