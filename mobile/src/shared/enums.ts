/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Domain enums shared by the API, the admin panel and the mobile app.
 *
 * These are declared as `const` objects + derived union types rather than TS
 * `enum`s so that:
 *   - the runtime value is a plain string (interoperates directly with the
 *     Postgres enums Prisma generates),
 *   - the type can be used in `isolatedModules` builds without emit hazards,
 *   - clients can switch exhaustively on them.
 *
 * RULE: no status string is ever typed as a literal anywhere else in the
 * codebase. Import from here.
 */

/* -------------------------------------------------------------------------- */
/* Users & access                                                             */
/* -------------------------------------------------------------------------- */

export const UserRole = {
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  STORE_OWNER: 'STORE_OWNER',
  /** Reserved for future versions — declared now so RBAC is extensible. */
  SUPER_ADMIN: 'SUPER_ADMIN',
  STORE_MANAGER: 'STORE_MANAGER',
  DELIVERY_AGENT: 'DELIVERY_AGENT',
  STAFF: 'STAFF',
  PHARMACIST: 'PHARMACIST',
  RESTAURANT_MANAGER: 'RESTAURANT_MANAGER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Roles that exist in V1. Everything else is reserved. */
export const V1_ROLES: readonly UserRole[] = [
  UserRole.CUSTOMER,
  UserRole.ADMIN,
  UserRole.STORE_OWNER,
];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED',
  DELETED: 'DELETED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The commercial vertical a category belongs to. Future vertical-specific
 * behaviour branches on THIS, never on a category name.
 */
export const CatalogVertical = {
  GROCERY: 'GROCERY',
  VEGETABLES: 'VEGETABLES',
  FRUITS: 'FRUITS',
  DAIRY: 'DAIRY',
  CAFE: 'CAFE',
  FOOD: 'FOOD',
  PHARMACY: 'PHARMACY',
  CLOTHING: 'CLOTHING',
  ELECTRONICS: 'ELECTRONICS',
  HOUSEHOLD: 'HOUSEHOLD',
  OTHER: 'OTHER',
} as const;
export type CatalogVertical = (typeof CatalogVertical)[keyof typeof CatalogVertical];

export const ProductStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/** Unit a variant is sold in. Weight-based selling (V2) builds on this. */
export const UnitType = {
  G: 'G',
  KG: 'KG',
  ML: 'ML',
  L: 'L',
  PIECE: 'PIECE',
  PACK: 'PACK',
  DOZEN: 'DOZEN',
  BUNDLE: 'BUNDLE',
} as const;
export type UnitType = (typeof UnitType)[keyof typeof UnitType];

/* -------------------------------------------------------------------------- */
/* Cash on delivery policy                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Three-state COD policy, present at every level of the catalog hierarchy and
 * on the store. `INHERIT` defers to the next level outward.
 *
 * Resolution order (first non-INHERIT wins):
 *   storeVariant -> productVariant -> product -> category(leaf..root) -> store
 *   -> DEFAULT_COD_POLICY config
 *
 * Order-level eligibility is the AND of every resolved line item plus the
 * store policy plus the value caps — i.e. most restrictive wins.
 */
export const CodPolicy = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  INHERIT: 'INHERIT',
} as const;
export type CodPolicy = (typeof CodPolicy)[keyof typeof CodPolicy];

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

export const OrderStatus = {
  /** Online payment initiated, stock reserved, awaiting confirmation. */
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  /** Payment verified server-side. Transient — auto-advances to ORDER_PLACED. */
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  /** Visible to the store, awaiting acceptance. */
  ORDER_PLACED: 'ORDER_PLACED',
  STORE_ACCEPTED: 'STORE_ACCEPTED',
  PREPARING: 'PREPARING',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  REJECTED: 'REJECTED',
  REFUNDED: 'REFUNDED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.PAYMENT_FAILED,
  OrderStatus.REJECTED,
  OrderStatus.REFUNDED,
];

/** Statuses the store still has to act on — drives the admin "active" tabs. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.ORDER_PLACED,
  OrderStatus.STORE_ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.OUT_FOR_DELIVERY,
];

export const PaymentMethod = {
  ONLINE: 'ONLINE',
  COD: 'COD',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

/** Payment state at the ORDER level (the money view of an order). */
export const OrderPaymentStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type OrderPaymentStatus =
  (typeof OrderPaymentStatus)[keyof typeof OrderPaymentStatus];

/** Payment state at the ATTEMPT level (one row per provider interaction). */
export const PaymentStatus = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const RefundStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

/** Who caused a state change. Recorded on every order_status_history row. */
export const ActorType = {
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  DELIVERY_AGENT: 'DELIVERY_AGENT',
  SYSTEM: 'SYSTEM',
  PAYMENT_WEBHOOK: 'PAYMENT_WEBHOOK',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

export const CancelledBy = {
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
} as const;
export type CancelledBy = (typeof CancelledBy)[keyof typeof CancelledBy];

/* -------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* -------------------------------------------------------------------------- */

/** Why stock moved. Every change to stock writes one ledger row. */
export const StockLedgerReason = {
  PURCHASE: 'PURCHASE',
  MANUAL_ADJUST: 'MANUAL_ADJUST',
  ORDER_RESERVE: 'ORDER_RESERVE',
  ORDER_RELEASE: 'ORDER_RELEASE',
  ORDER_COMMIT: 'ORDER_COMMIT',
  ORDER_CANCEL_RESTOCK: 'ORDER_CANCEL_RESTOCK',
  DAMAGE: 'DAMAGE',
  EXPIRY: 'EXPIRY',
  RETURN: 'RETURN',
} as const;
export type StockLedgerReason =
  (typeof StockLedgerReason)[keyof typeof StockLedgerReason];

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

export const DeliveryAssignmentStatus = {
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  PICKED_UP: 'PICKED_UP',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
} as const;
export type DeliveryAssignmentStatus =
  (typeof DeliveryAssignmentStatus)[keyof typeof DeliveryAssignmentStatus];

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

export const NotificationType = {
  ORDER_PLACED: 'ORDER_PLACED',
  ORDER_ACCEPTED: 'ORDER_ACCEPTED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_PREPARING: 'ORDER_PREPARING',
  ORDER_READY: 'ORDER_READY',
  ORDER_OUT_FOR_DELIVERY: 'ORDER_OUT_FOR_DELIVERY',
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  REFUND_INITIATED: 'REFUND_INITIATED',
  REFUND_COMPLETED: 'REFUND_COMPLETED',
  BACK_IN_STOCK: 'BACK_IN_STOCK',
} as const;
export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

export const NotificationChannel = {
  PUSH: 'PUSH',
  SMS: 'SMS',
  WHATSAPP: 'WHATSAPP',
  EMAIL: 'EMAIL',
  IN_APP: 'IN_APP',
} as const;
export type NotificationChannel =
  (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationStatus = {
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  READ: 'READ',
} as const;
export type NotificationStatus =
  (typeof NotificationStatus)[keyof typeof NotificationStatus];

export const DevicePlatform = {
  ANDROID: 'ANDROID',
  IOS: 'IOS',
  WEB: 'WEB',
} as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];

/* -------------------------------------------------------------------------- */
/* Coupons                                                                    */
/* -------------------------------------------------------------------------- */

export const CouponType = {
  PERCENT: 'PERCENT',
  FLAT: 'FLAT',
  FREE_DELIVERY: 'FREE_DELIVERY',
} as const;
export type CouponType = (typeof CouponType)[keyof typeof CouponType];

/** Distinguishes a coupon minted for one specific user (`REFERRAL_REWARD`,
 * see `issuedToUserId`/`issuedForReferralId`) from today's global promo
 * codes (`PROMO`, unchanged behaviour). */
export const CouponOrigin = {
  PROMO: 'PROMO',
  REFERRAL_REWARD: 'REFERRAL_REWARD',
} as const;
export type CouponOrigin = (typeof CouponOrigin)[keyof typeof CouponOrigin];

/* -------------------------------------------------------------------------- */
/* Referrals (Refer & Earn)                                                   */
/* -------------------------------------------------------------------------- */

export const ReferralStatus = {
  REGISTERED: 'REGISTERED',
  FIRST_ORDER_PENDING: 'FIRST_ORDER_PENDING',
  COMPLETED: 'COMPLETED',
  REWARD_ISSUED: 'REWARD_ISSUED',
} as const;
export type ReferralStatus = (typeof ReferralStatus)[keyof typeof ReferralStatus];

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

export const IdempotencyStatus = {
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
} as const;
export type IdempotencyStatus =
  (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];
