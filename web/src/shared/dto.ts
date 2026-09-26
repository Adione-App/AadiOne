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
  CodPolicy,
  CouponOrigin,
  CouponType,
  DeliveryAssignmentStatus,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  ProductStatus,
  ReferralStatus,
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
/* Store & serviceability                                                     */
/* -------------------------------------------------------------------------- */

export interface StoreHoursDto {
  dayOfWeek: number; // 0 = Sunday
  opensAt: string; // "08:00"
  closesAt: string; // "22:00"
  isClosed: boolean;
}

export interface StoreDto {
  id: string;
  name: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  latitude: number;
  longitude: number;
  phone: string | null;
  timezone: string;
  /** The owner's trading switch. False = paused from the admin panel. */
  isActive: boolean;
  /** False when paused, closed for the day, or outside today's window. */
  isOpenNow: boolean;
  /** Local time the store next opens, ISO-8601, when currently closed. */
  opensAt: string | null;
  closesAt: string | null;
  todayHours: StoreHoursDto | null;
}

/**
 * The admin panel's view of trading: the switch plus the full weekly schedule.
 *
 * Distinct from `StoreDto` because the admin needs all seven days to edit
 * them, and needs them even while the store is paused — the customer-facing
 * DTO deliberately reports only today, and reports nothing when paused.
 */
export interface StoreAvailabilityDto {
  isActive: boolean;
  isOpenNow: boolean;
  timezone: string;
  /** Exactly seven entries, Sunday (0) through Saturday (6). */
  hours: StoreHoursDto[];
  /** "Opens tomorrow at 8:00 AM" — null while paused or already open. */
  nextOpenText: string | null;
}

export interface UpdateStoreHoursRequest {
  hours: StoreHoursDto[];
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
  storeOpen: boolean;
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

  /* live, store-scoped commercial data — always server-resolved */
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
  /** The default variant's commercial data, for cards and grids. */
  defaultVariant: VariantDto | null;
  variantCount: number;
  /**
   * DRAFT/INACTIVE/ARCHIVED never reach a customer — every customer-facing
   * query filters to ACTIVE upstream, so this is always ACTIVE there. Admin's
   * product list is the one place this varies, driving the "Display on App"
   * toggle.
   */
  status: ProductStatus;
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
/* Cart                                                                       */
/* -------------------------------------------------------------------------- */

export interface CartItemDto {
  id: string;
  variantId: string;
  productId: string;
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
  bill: BillDto;
  changes: CartChangeDto[];
  /** False with a reason when the cart cannot proceed to checkout. */
  checkoutEnabled: boolean;
  checkoutBlockedReason: string | null;
  minOrderValuePaise: number;
  shortfallPaise: number;
}

export interface AddCartItemRequest {
  variantId: string;
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
   * Per-item prices the customer's cart was showing, keyed by variant.
   * Optional, and purely a safety check like `expectedTotalPaise` above — the
   * charged amount always comes from the server's own live lookup, never
   * from this. What this DOES enable: when a price genuinely changed, the
   * server can say WHICH product and by how much (see PRICE_CHANGED's
   * `details` in order.service.ts) instead of only "the total didn't
   * match" — there is nowhere to read an "old price" from otherwise, since
   * cart_items deliberately stores no price of its own (see the CartItem
   * model's own comment).
   */
  expectedItems?: { variantId: string; unitPricePaise: number }[];
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

export interface OrderSummaryDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  statusLabel: string;
  bucket: 'ONGOING' | 'DELIVERED' | 'CANCELLED';
  paymentMethod: PaymentMethod;
  paymentStatus: OrderPaymentStatus;
  totalPaise: number;
  /** Total units across all lines (e.g. 4 units of one product is 4, not 1). */
  itemCount: number;
  /** Number of distinct order lines — what "N thumbnails" should count. */
  lineItemCount: number;
  /** First few item thumbnails, for the My Orders list. */
  itemThumbnails: string[];
  placedAt: string;
  deliveredAt: string | null;
}

export interface OrderDetailDto extends OrderSummaryDto {
  items: OrderItemDto[];
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
  /** The store-local calendar day ("YYYY-MM-DD") this snapshot reports on. */
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
    storeVariantId: string;
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
   * Set when a customer has claimed a direct-UPI payment that the store has
   * not yet confirmed. The UTR is what the shopkeeper matches against their
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

export interface DeliveryAssignmentDto {
  id: string;
  orderId: string;
  agentId: string;
  agentName: string;
  status: DeliveryAssignmentStatus;
  assignedAt: string;
  deliveredAt: string | null;
  cashCollectedPaise: number | null;
}

export interface UpsertStoreVariantRequest {
  pricePaise?: number;
  mrpPaise?: number;
  stockQty?: number;
  isAvailable?: boolean;
  allowCod?: CodPolicy;
  maxQtyPerOrder?: number;
  lowStockThreshold?: number;
}
