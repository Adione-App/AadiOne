/**
 * Stable, enumerated API error codes.
 *
 * Contract with every client:
 *   - `code` is stable and switched on programmatically.
 *   - `message` is ALWAYS safe to display to an end user as-is.
 *   - Technical detail (stack, SQL, provider payloads) never crosses the wire;
 *     it is logged against `requestId`.
 *
 * This is what makes "user-friendly messages, not technical errors" a property
 * of the protocol rather than a pile of string mapping in each app.
 */

export const ErrorCode = {
  /* generic ------------------------------------------------------------- */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',

  /* auth ---------------------------------------------------------------- */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  MOBILE_ALREADY_REGISTERED: 'MOBILE_ALREADY_REGISTERED',
  PASSWORD_NOT_SET: 'PASSWORD_NOT_SET',

  /* otp ----------------------------------------------------------------- */
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_MAX_ATTEMPTS: 'OTP_MAX_ATTEMPTS',
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  OTP_RESEND_TOO_SOON: 'OTP_RESEND_TOO_SOON',
  OTP_SEND_FAILED: 'OTP_SEND_FAILED',

  /* location / store ---------------------------------------------------- */
  OUT_OF_SERVICE_AREA: 'OUT_OF_SERVICE_AREA',
  STORE_CLOSED: 'STORE_CLOSED',
  STORE_INACTIVE: 'STORE_INACTIVE',
  INVALID_COORDINATES: 'INVALID_COORDINATES',

  /* catalog / inventory ------------------------------------------------- */
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  ITEM_OUT_OF_STOCK: 'ITEM_OUT_OF_STOCK',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  QTY_LIMIT_EXCEEDED: 'QTY_LIMIT_EXCEEDED',

  /* cart / checkout ----------------------------------------------------- */
  CART_EMPTY: 'CART_EMPTY',
  PRICE_CHANGED: 'PRICE_CHANGED',
  MIN_ORDER_NOT_MET: 'MIN_ORDER_NOT_MET',
  COD_NOT_ALLOWED: 'COD_NOT_ALLOWED',
  COUPON_INVALID: 'COUPON_INVALID',
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_LIMIT_REACHED: 'COUPON_LIMIT_REACHED',
  COUPON_MIN_ORDER_NOT_MET: 'COUPON_MIN_ORDER_NOT_MET',

  /* referrals ------------------------------------------------------------ */
  REFERRAL_CODE_INVALID: 'REFERRAL_CODE_INVALID',
  REFERRAL_SELF_REFERRAL: 'REFERRAL_SELF_REFERRAL',
  REFERRAL_ALREADY_LINKED: 'REFERRAL_ALREADY_LINKED',

  /* address ------------------------------------------------------------- */
  ADDRESS_LIMIT_REACHED: 'ADDRESS_LIMIT_REACHED',
  ADDRESS_NOT_SERVICEABLE: 'ADDRESS_NOT_SERVICEABLE',

  /* orders -------------------------------------------------------------- */
  ORDER_IN_PROGRESS: 'ORDER_IN_PROGRESS',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  DELIVERY_AGENT_REQUIRED: 'DELIVERY_AGENT_REQUIRED',
  DELIVERY_OTP_INVALID: 'DELIVERY_OTP_INVALID',

  /* payments ------------------------------------------------------------ */
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  PAYMENT_ALREADY_CAPTURED: 'PAYMENT_ALREADY_CAPTURED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  REFUND_FAILED: 'REFUND_FAILED',

  /* uploads ------------------------------------------------------------- */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default HTTP status for each code. Overridable per throw site. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  RATE_LIMITED: 429,

  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  ACCOUNT_BLOCKED: 403,
  INVALID_CREDENTIALS: 401,
  EMAIL_ALREADY_REGISTERED: 409,
  MOBILE_ALREADY_REGISTERED: 409,
  PASSWORD_NOT_SET: 409,

  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_MAX_ATTEMPTS: 429,
  OTP_RATE_LIMITED: 429,
  OTP_RESEND_TOO_SOON: 429,
  OTP_SEND_FAILED: 502,

  OUT_OF_SERVICE_AREA: 422,
  STORE_CLOSED: 409,
  STORE_INACTIVE: 503,
  INVALID_COORDINATES: 400,

  PRODUCT_UNAVAILABLE: 409,
  ITEM_OUT_OF_STOCK: 409,
  INSUFFICIENT_STOCK: 409,
  QTY_LIMIT_EXCEEDED: 422,

  CART_EMPTY: 422,
  PRICE_CHANGED: 422,
  MIN_ORDER_NOT_MET: 422,
  COD_NOT_ALLOWED: 422,
  COUPON_INVALID: 422,
  COUPON_EXPIRED: 422,
  COUPON_LIMIT_REACHED: 422,
  COUPON_MIN_ORDER_NOT_MET: 422,

  REFERRAL_CODE_INVALID: 422,
  REFERRAL_SELF_REFERRAL: 422,
  REFERRAL_ALREADY_LINKED: 422,

  ADDRESS_LIMIT_REACHED: 422,
  ADDRESS_NOT_SERVICEABLE: 422,

  ORDER_IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_STATUS_TRANSITION: 409,
  ORDER_NOT_CANCELLABLE: 409,
  DELIVERY_AGENT_REQUIRED: 422,
  DELIVERY_OTP_INVALID: 400,

  PAYMENT_FAILED: 402,
  PAYMENT_VERIFICATION_FAILED: 400,
  PAYMENT_AMOUNT_MISMATCH: 400,
  PAYMENT_ALREADY_CAPTURED: 409,
  WEBHOOK_SIGNATURE_INVALID: 400,
  REFUND_FAILED: 502,

  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
};

/**
 * Default user-facing copy. Deliberately plain, non-technical and free of
 * jargon — these strings are read by first-time smartphone users.
 * A throw site may pass a more specific message (e.g. naming the actual item).
 */
export const ERROR_DEFAULT_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_ERROR: 'Please check the details you entered and try again.',
  NOT_FOUND: 'We could not find what you were looking for.',
  INTERNAL_ERROR: 'Something went wrong at our end. Please try again.',
  SERVICE_UNAVAILABLE: 'Service is temporarily unavailable. Please try again shortly.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',

  UNAUTHENTICATED: 'Please log in to continue.',
  TOKEN_EXPIRED: 'Your session has expired. Please log in again.',
  TOKEN_INVALID: 'Your session is no longer valid. Please log in again.',
  FORBIDDEN: 'You do not have permission to do this.',
  ACCOUNT_BLOCKED: 'This account has been blocked. Please contact support.',
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  EMAIL_ALREADY_REGISTERED: 'An account with this email already exists. Please log in.',
  MOBILE_ALREADY_REGISTERED:
    'An account with this mobile number already exists. Please log in.',
  PASSWORD_NOT_SET:
    'This account uses OTP login. Please continue with your mobile number.',

  OTP_INVALID: 'The OTP you entered is incorrect.',
  OTP_EXPIRED: 'This OTP has expired. Please request a new one.',
  OTP_MAX_ATTEMPTS: 'Too many incorrect attempts. Please request a new OTP.',
  OTP_RATE_LIMITED: 'Too many OTP requests. Please try again later.',
  OTP_RESEND_TOO_SOON: 'Please wait before requesting another OTP.',
  OTP_SEND_FAILED: 'We could not send the OTP right now. Please try again.',

  OUT_OF_SERVICE_AREA: 'Sorry, we do not deliver to this location yet.',
  STORE_CLOSED: 'The store is closed right now. Please order during working hours.',
  STORE_INACTIVE: 'The store is not accepting orders at the moment.',
  INVALID_COORDINATES: 'We could not read that location. Please try again.',

  PRODUCT_UNAVAILABLE: 'This item is not available right now.',
  ITEM_OUT_OF_STOCK: 'This item is out of stock.',
  INSUFFICIENT_STOCK: 'We do not have enough stock for this item.',
  QTY_LIMIT_EXCEEDED: 'You have reached the maximum quantity for this item.',

  CART_EMPTY: 'Your cart is empty.',
  PRICE_CHANGED: 'Some prices have changed. Please review your order.',
  MIN_ORDER_NOT_MET: 'Please add a little more to reach the minimum order value.',
  COD_NOT_ALLOWED: 'Cash on Delivery is not available for this order.',
  COUPON_INVALID: 'This coupon code is not valid.',
  COUPON_EXPIRED: 'This coupon has expired.',
  COUPON_LIMIT_REACHED: 'This coupon can no longer be used.',
  COUPON_MIN_ORDER_NOT_MET: 'Your order value is below this coupon’s minimum.',

  REFERRAL_CODE_INVALID: 'This referral code is not valid.',
  REFERRAL_SELF_REFERRAL: 'You cannot use your own referral code.',
  REFERRAL_ALREADY_LINKED: 'A referral code has already been applied to this account.',

  ADDRESS_LIMIT_REACHED: 'You can save up to 5 addresses.',
  ADDRESS_NOT_SERVICEABLE: 'We do not deliver to this address yet.',

  ORDER_IN_PROGRESS: 'Your order is already being placed. Please wait.',
  IDEMPOTENCY_KEY_REQUIRED: 'Something went wrong. Please try placing the order again.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already used for a different order.',
  INVALID_STATUS_TRANSITION: 'This order cannot be updated to that status.',
  ORDER_NOT_CANCELLABLE: 'This order can no longer be cancelled. Please call the store.',
  DELIVERY_AGENT_REQUIRED: 'Assign a delivery agent before marking the order out for delivery.',
  DELIVERY_OTP_INVALID: 'The delivery OTP is incorrect.',

  PAYMENT_FAILED: 'Payment failed. No money has been deducted, or it will be refunded.',
  PAYMENT_VERIFICATION_FAILED: 'We could not verify this payment. Please contact support.',
  PAYMENT_AMOUNT_MISMATCH: 'Payment amount did not match the order. Please contact support.',
  PAYMENT_ALREADY_CAPTURED: 'This payment has already been completed.',
  WEBHOOK_SIGNATURE_INVALID: 'Invalid request signature.',
  REFUND_FAILED: 'The refund could not be processed. Our team has been notified.',

  FILE_TOO_LARGE: 'That file is too large.',
  UNSUPPORTED_FILE_TYPE: 'That file type is not supported.',
};
