/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Business configuration registry.
 *
 * Every business rule that a store owner might reasonably want to change lives
 * here and is stored in the `configurations` table. Nothing in the API, the
 * admin panel or the mobile app may hardcode any of these values.
 *
 * The literal `10` for the service radius appears in exactly one place in this
 * repository: `CONFIG_DEFAULTS.MAX_SERVICE_RADIUS_KM` below, which the seed
 * script writes into the database once.
 *
 * All money values are integer paise (₹1 = 100 paise).
 */

import { CodPolicy, OrderStatus } from "./enums";

export const ConfigKey = {
  /* serviceability */
  MAX_SERVICE_RADIUS_KM: "MAX_SERVICE_RADIUS_KM",
  ROAD_DISTANCE_FACTOR: "ROAD_DISTANCE_FACTOR",

  /* store */
  STORE_TIMEZONE: "STORE_TIMEZONE",
  ALLOW_ORDERS_WHEN_CLOSED: "ALLOW_ORDERS_WHEN_CLOSED",
  STORE_GSTIN: "STORE_GSTIN",
  ADIONE_UPI_ID: "ADIONE_UPI_ID",

  /* pricing */
  MIN_ORDER_VALUE_PAISE: "MIN_ORDER_VALUE_PAISE",
  DELIVERY_FEE_SLABS: "DELIVERY_FEE_SLABS",
  FREE_DELIVERY_THRESHOLD_PAISE: "FREE_DELIVERY_THRESHOLD_PAISE",
  PLATFORM_FEE_PAISE: "PLATFORM_FEE_PAISE",

  /* cash on delivery */
  DEFAULT_COD_POLICY: "DEFAULT_COD_POLICY",
  COD_MAX_ORDER_VALUE_PAISE: "COD_MAX_ORDER_VALUE_PAISE",
  COD_FIRST_ORDER_MAX_PAISE: "COD_FIRST_ORDER_MAX_PAISE",

  /* eta */
  BASE_PREPARATION_MINUTES: "BASE_PREPARATION_MINUTES",
  PER_ITEM_PICK_SECONDS: "PER_ITEM_PICK_SECONDS",
  AVG_DELIVERY_SPEED_KMPH: "AVG_DELIVERY_SPEED_KMPH",
  ORDERS_PER_RIDER_BATCH: "ORDERS_PER_RIDER_BATCH",
  BATCH_DELAY_MINUTES: "BATCH_DELAY_MINUTES",
  ETA_BUFFER_MINUTES: "ETA_BUFFER_MINUTES",

  /* orders */
  PAYMENT_HOLD_MINUTES: "PAYMENT_HOLD_MINUTES",
  CANCELLATION_ALLOWED_UNTIL: "CANCELLATION_ALLOWED_UNTIL",
  DEFAULT_MAX_QTY_PER_ORDER: "DEFAULT_MAX_QTY_PER_ORDER",
  MAX_ADDRESSES_PER_USER: "MAX_ADDRESSES_PER_USER",

  /* inventory */
  LOW_STOCK_THRESHOLD: "LOW_STOCK_THRESHOLD",

  /* delivery */
  DELIVERY_OTP_REQUIRED_FOR_COD: "DELIVERY_OTP_REQUIRED_FOR_COD",

  /* referral rewards */
  REFERRAL_REWARD_PAISE: "REFERRAL_REWARD_PAISE",
  REFERRAL_MIN_ORDER_PAISE: "REFERRAL_MIN_ORDER_PAISE",
  REFERRAL_COUPON_EXPIRY_DAYS: "REFERRAL_COUPON_EXPIRY_DAYS",

  /* feature flags */
  FEATURE_REFERRAL_ENABLED: "FEATURE_REFERRAL_ENABLED",
  FEATURE_COUPONS_ENABLED: "FEATURE_COUPONS_ENABLED",
  FEATURE_RATINGS_ENABLED: "FEATURE_RATINGS_ENABLED",
  FEATURE_WISHLIST_ENABLED: "FEATURE_WISHLIST_ENABLED",

  /* support & copy */
  SUPPORT_PHONE: "SUPPORT_PHONE",
  SUPPORT_WHATSAPP: "SUPPORT_WHATSAPP",
  SUPPORT_EMAIL: "SUPPORT_EMAIL",
  DELIVERY_PROMISE_TEXT: "DELIVERY_PROMISE_TEXT",
} as const;

export type ConfigKey = (typeof ConfigKey)[keyof typeof ConfigKey];

/** A delivery-fee band. The first slab whose `maxKm` covers the distance wins. */
export interface DeliveryFeeSlab {
  maxKm: number;
  feePaise: number;
}

export interface ConfigValues {
  MAX_SERVICE_RADIUS_KM: number;
  ROAD_DISTANCE_FACTOR: number;

  STORE_TIMEZONE: string;
  ALLOW_ORDERS_WHEN_CLOSED: boolean;
  STORE_GSTIN: string;
  ADIONE_UPI_ID: string;

  MIN_ORDER_VALUE_PAISE: number;
  DELIVERY_FEE_SLABS: DeliveryFeeSlab[];
  FREE_DELIVERY_THRESHOLD_PAISE: number;
  PLATFORM_FEE_PAISE: number;

  DEFAULT_COD_POLICY: CodPolicy;
  COD_MAX_ORDER_VALUE_PAISE: number;
  COD_FIRST_ORDER_MAX_PAISE: number;

  BASE_PREPARATION_MINUTES: number;
  PER_ITEM_PICK_SECONDS: number;
  AVG_DELIVERY_SPEED_KMPH: number;
  ORDERS_PER_RIDER_BATCH: number;
  BATCH_DELAY_MINUTES: number;
  ETA_BUFFER_MINUTES: number;

  PAYMENT_HOLD_MINUTES: number;
  CANCELLATION_ALLOWED_UNTIL: OrderStatus;
  DEFAULT_MAX_QTY_PER_ORDER: number;
  MAX_ADDRESSES_PER_USER: number;

  LOW_STOCK_THRESHOLD: number;

  DELIVERY_OTP_REQUIRED_FOR_COD: boolean;

  REFERRAL_REWARD_PAISE: number;
  REFERRAL_MIN_ORDER_PAISE: number;
  REFERRAL_COUPON_EXPIRY_DAYS: number;

  FEATURE_REFERRAL_ENABLED: boolean;
  FEATURE_COUPONS_ENABLED: boolean;
  FEATURE_RATINGS_ENABLED: boolean;
  FEATURE_WISHLIST_ENABLED: boolean;

  SUPPORT_PHONE: string;
  SUPPORT_WHATSAPP: string;
  SUPPORT_EMAIL: string;
  DELIVERY_PROMISE_TEXT: string;
}

/**
 * Fallback values, used to seed the database and as a last-resort default if a
 * key is somehow missing at runtime. The database is the source of truth once
 * seeded.
 */
export const CONFIG_DEFAULTS: ConfigValues = {
  MAX_SERVICE_RADIUS_KM: 12,

  ROAD_DISTANCE_FACTOR: 1.3,

  STORE_TIMEZONE: "Asia/Kolkata",
  ALLOW_ORDERS_WHEN_CLOSED: false,
  STORE_GSTIN: "",
  ADIONE_UPI_ID: "",

  MIN_ORDER_VALUE_PAISE: 9900,

  DELIVERY_FEE_SLABS: [
    { maxKm: 3, feePaise: 2000 },
    { maxKm: 6, feePaise: 3000 },
    { maxKm: 10, feePaise: 4000 },
  ],

  FREE_DELIVERY_THRESHOLD_PAISE: 29900,
  PLATFORM_FEE_PAISE: 500,

  DEFAULT_COD_POLICY: CodPolicy.ALLOW,
  COD_MAX_ORDER_VALUE_PAISE: 300000,
  COD_FIRST_ORDER_MAX_PAISE: 100000,

  BASE_PREPARATION_MINUTES: 10,
  PER_ITEM_PICK_SECONDS: 20,
  AVG_DELIVERY_SPEED_KMPH: 25,
  ORDERS_PER_RIDER_BATCH: 3,
  BATCH_DELAY_MINUTES: 8,
  ETA_BUFFER_MINUTES: 3,

  PAYMENT_HOLD_MINUTES: 10,
  CANCELLATION_ALLOWED_UNTIL: OrderStatus.PREPARING,
  DEFAULT_MAX_QTY_PER_ORDER: 10,
  MAX_ADDRESSES_PER_USER: 5,

  LOW_STOCK_THRESHOLD: 5,

  DELIVERY_OTP_REQUIRED_FOR_COD: true,

  REFERRAL_REWARD_PAISE: 5000,
  REFERRAL_MIN_ORDER_PAISE: 9900,
  REFERRAL_COUPON_EXPIRY_DAYS: 7,

  FEATURE_REFERRAL_ENABLED: false,
  FEATURE_COUPONS_ENABLED: true,
  FEATURE_RATINGS_ENABLED: false,
  FEATURE_WISHLIST_ENABLED: false,

  SUPPORT_PHONE: "",
  SUPPORT_WHATSAPP: "",
  SUPPORT_EMAIL: "support@adione.in",
  DELIVERY_PROMISE_TEXT: "in 30 minutes",
};

/**
 * Keys the mobile app is allowed to read without authentication via
 * `GET /config/public`. Anything not listed here never leaves the server.
 */
export const PUBLIC_CONFIG_KEYS: readonly ConfigKey[] = [
  ConfigKey.MAX_SERVICE_RADIUS_KM,
  ConfigKey.MIN_ORDER_VALUE_PAISE,
  ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE,
  ConfigKey.PLATFORM_FEE_PAISE,
  ConfigKey.DEFAULT_MAX_QTY_PER_ORDER,
  ConfigKey.MAX_ADDRESSES_PER_USER,
  ConfigKey.REFERRAL_REWARD_PAISE,
  ConfigKey.REFERRAL_MIN_ORDER_PAISE,
  ConfigKey.REFERRAL_COUPON_EXPIRY_DAYS,
  ConfigKey.FEATURE_REFERRAL_ENABLED,
  ConfigKey.FEATURE_COUPONS_ENABLED,
  ConfigKey.FEATURE_RATINGS_ENABLED,
  ConfigKey.FEATURE_WISHLIST_ENABLED,
  ConfigKey.SUPPORT_PHONE,
  ConfigKey.SUPPORT_WHATSAPP,
  ConfigKey.SUPPORT_EMAIL,
  ConfigKey.DELIVERY_PROMISE_TEXT,
  ConfigKey.STORE_TIMEZONE,
];

export type PublicConfig = Pick<
  ConfigValues,
  (typeof PUBLIC_CONFIG_KEYS)[number]
>;

/** Human-readable descriptions rendered on the admin Configuration screen. */
export const CONFIG_DESCRIPTIONS: Readonly<Record<ConfigKey, string>> = {
  MAX_SERVICE_RADIUS_KM:
    "Maximum straight-line delivery distance from the store, in km.",

  ROAD_DISTANCE_FACTOR:
    "Multiplier converting straight-line distance to road distance, used for ETA and delivery fee (typically 1.2–1.4).",

  STORE_TIMEZONE: "Timezone used to evaluate store opening hours.",

  ALLOW_ORDERS_WHEN_CLOSED:
    "Allow customers to place orders outside opening hours.",

  STORE_GSTIN:
    "GST registration number. When set, order receipts show a tax invoice breakdown.",

  ADIONE_UPI_ID:
    "Merchant UPI ID used for direct UPI payments, for example merchant@upi.",

  MIN_ORDER_VALUE_PAISE: "Minimum order value before delivery fees, in paise.",

  DELIVERY_FEE_SLABS: "Delivery fee bands by road distance, in paise.",

  FREE_DELIVERY_THRESHOLD_PAISE:
    "Order value above which delivery is free, in paise.",

  PLATFORM_FEE_PAISE:
    "Flat platform fee added to every order, in paise. Set 0 to hide the line.",

  DEFAULT_COD_POLICY:
    "COD policy used when no product, category or store rule applies.",

  COD_MAX_ORDER_VALUE_PAISE:
    "Maximum order value eligible for Cash on Delivery, in paise.",

  COD_FIRST_ORDER_MAX_PAISE:
    "Maximum COD value for a customer's first order, in paise.",

  BASE_PREPARATION_MINUTES:
    "Fixed picking and packing time per order, in minutes.",

  PER_ITEM_PICK_SECONDS: "Additional picking time per item, in seconds.",

  AVG_DELIVERY_SPEED_KMPH: "Average rider speed used for ETA, in km/h.",

  ORDERS_PER_RIDER_BATCH:
    "Active orders a rider handles before ETA is extended.",

  BATCH_DELAY_MINUTES:
    "Minutes added to ETA per additional batch of active orders.",

  ETA_BUFFER_MINUTES: "Safety buffer added to every ETA, in minutes.",

  PAYMENT_HOLD_MINUTES:
    "How long stock stays reserved for an unpaid online order before it is released.",

  CANCELLATION_ALLOWED_UNTIL:
    "Last order status at which a customer may still cancel by themselves.",

  DEFAULT_MAX_QTY_PER_ORDER: "Default maximum quantity of one item per order.",

  MAX_ADDRESSES_PER_USER: "Maximum saved addresses per customer.",

  LOW_STOCK_THRESHOLD:
    "Stock level at or below which an item appears in the low-stock report.",

  DELIVERY_OTP_REQUIRED_FOR_COD:
    "Require a delivery OTP before marking COD orders delivered.",

  REFERRAL_REWARD_PAISE:
    "Coupon value credited to the referrer once their referred friend completes a qualifying first order, in paise.",

  REFERRAL_MIN_ORDER_PAISE:
    "Minimum eligible order value (items subtotal) the referred friend's first order must reach to trigger the reward, in paise.",

  REFERRAL_COUPON_EXPIRY_DAYS:
    "Days after issuance before a referral reward coupon expires.",

  FEATURE_REFERRAL_ENABLED:
    "Show the Refer & Earn rewards programme in the app.",

  FEATURE_COUPONS_ENABLED: "Allow coupon codes at checkout.",

  FEATURE_RATINGS_ENABLED: "Show product ratings and reviews.",

  FEATURE_WISHLIST_ENABLED: "Show the wishlist / favourites feature.",

  SUPPORT_PHONE: "Phone number shown on Help & Support.",

  SUPPORT_WHATSAPP: "WhatsApp number shown on Help & Support.",

  SUPPORT_EMAIL: "Support email address.",

  DELIVERY_PROMISE_TEXT:
    'Marketing copy for delivery speed (e.g. "in 30 minutes"). Per-order ETA is always computed separately.',
};
