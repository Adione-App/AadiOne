/**
 * Guest browsing — the rules, kept free of React Native so they can be unit
 * tested with Node's own test runner (see tests/guestAccess.test.ts).
 *
 * Browsing (Home, categories, search, products, food menus, stores) needs no
 * account: those endpoints are public on the server. Only actions that belong
 * to a customer — the cart, checkout, orders, addresses, profile, rewards,
 * notifications — ask for a login, and only when the customer starts one.
 *
 * Nothing in this file may import a runtime module: Node strips the types and
 * runs it directly.
 */

/** Why a login was asked for — picks the line the login screen shows. */
export type AuthReason =
  | "account"
  | "cart"
  | "checkout"
  | "orders"
  | "addresses"
  | "profile"
  | "rewards"
  | "notifications"
  | "notify-me";

export const AUTH_REASON_COPY: Record<AuthReason, string> = {
  account: "Log in to see your orders, addresses and rewards.",
  cart: "Log in to add items to your cart.",
  checkout: "Log in to view your cart and place your order.",
  orders: "Log in to see and track your orders.",
  addresses: "Log in to save and manage delivery addresses.",
  profile: "Log in to manage your personal information.",
  rewards: "Log in to see your referral rewards and coupons.",
  notifications: "Log in to see updates about your orders.",
  "notify-me": "Log in to get an alert when this item is back in stock.",
};

/* -------------------------------------------------------------------------- */
/* The login gate                                                             */
/* -------------------------------------------------------------------------- */

export interface AuthGateDeps {
  isAuthenticated: () => boolean;
  /** Shows the login flow. False when it could not be shown (navigation not ready). */
  presentLogin: (reason: AuthReason) => boolean;
  /** Closes the login flow (after a successful login). */
  dismissLogin: () => void;
  /** Runs `fn` once the login flow has gone — never synchronously inside it. */
  defer: (fn: () => void) => void;
  onChange?: (state: AuthGateState) => void;
}

export interface AuthGateState {
  /** A login flow started by the gate is on screen. */
  open: boolean;
  reason: AuthReason | null;
}

export interface AuthGate {
  /**
   * Runs `action` now when signed in (returns true). Otherwise opens the
   * login flow — once: while one is open, further requests are ignored, so a
   * double tap never stacks two login screens — and keeps `action` IN MEMORY
   * ONLY, to run once after a successful login (returns false).
   */
  require: (reason: AuthReason, action?: () => void) => boolean;
  /** Login succeeded: close the flow, then run the waiting action exactly once. */
  completed: () => void;
  /** The flow went away without a login (back, swipe, "Not now"): drop the action. */
  closed: () => void;
  state: () => AuthGateState;
}

export function createAuthGate(deps: AuthGateDeps): AuthGate {
  let open = false;
  let reason: AuthReason | null = null;
  let pending: (() => void) | null = null;

  const notify = () => deps.onChange?.({ open, reason });

  return {
    require(nextReason, action) {
      if (deps.isAuthenticated()) {
        action?.();
        return true;
      }
      if (open) return false;
      if (!deps.presentLogin(nextReason)) return false;
      open = true;
      reason = nextReason;
      pending = action ?? null;
      notify();
      return false;
    },

    completed() {
      const action = pending;
      const wasOpen = open;
      pending = null;
      open = false;
      reason = null;
      if (wasOpen) notify();
      deps.dismissLogin();
      if (action && deps.isAuthenticated()) deps.defer(action);
    },

    closed() {
      if (!open && !pending) return;
      pending = null;
      open = false;
      reason = null;
      notify();
    },

    state: () => ({ open, reason }),
  };
}

/* -------------------------------------------------------------------------- */
/* Session failures                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a failed `POST /auth/refresh` means. Only the server saying no (a 4xx
 * other than timeout / rate limit) ends the session; no network, a timeout, a
 * 429 or a 5xx says nothing about the session, which must survive it.
 */
export function refreshFailureKind(status: number): "rejected" | "unavailable" {
  if (status === 0 || status === 408 || status === 429 || status >= 500) return "unavailable";
  return status >= 400 ? "rejected" : "unavailable";
}

/**
 * A 401 can only mean "your session ended" when the request carried one. A
 * guest's request has no token, so its 401 is just that request's answer —
 * never a reason to sign anyone out.
 */
export function isSessionLoss(status: number, sentToken: boolean): boolean {
  return sentToken && status === 401;
}

/* -------------------------------------------------------------------------- */
/* Add-to-cart that started before login                                      */
/* -------------------------------------------------------------------------- */

/** A guest's "Add" waits this long at most for login + the account's cart. */
export const DEFERRED_ADD_TTL_MS = 2 * 60_000;

export interface DeferredCartAdd<Snapshot = unknown> {
  variantId: string;
  snapshot: Snapshot | undefined;
  /** Date.now() when the guest tapped Add. */
  at: number;
}

/**
 * Decided only once the signed-in account's own cart has loaded — `POST
 * /cart/items` is additive, so adding before knowing what the account already
 * holds would double up. A variant already in that cart is left as it is:
 * the customer asked for it to be in the cart, and it is.
 */
export function deferredAddDecision(
  entry: DeferredCartAdd,
  now: number,
  qtyAlreadyInCart: number,
): "add" | "already-in-cart" | "expired" {
  if (now - entry.at > DEFERRED_ADD_TTL_MS) return "expired";
  return qtyAlreadyInCart > 0 ? "already-in-cart" : "add";
}

/* -------------------------------------------------------------------------- */
/* Private query data                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Query-cache roots holding one customer's own data. Never written to the
 * on-disk cache (AsyncStorage is plain text), and dropped from memory the
 * moment the app becomes signed out, so a guest — or the next account on a
 * shared phone — never sees them.
 */
export const PRIVATE_QUERY_ROOTS: readonly string[] = [
  "cart",
  "orders",
  "order",
  "notifications",
  "previously-ordered",
  "referral-summary",
  "my-coupons",
  "addresses",
  "checkout-quote",
  "payment-intent",
  "order-payment-status",
];

export function isPrivateQueryKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && PRIVATE_QUERY_ROOTS.includes(root);
}
