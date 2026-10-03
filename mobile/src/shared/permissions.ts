/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Role-based access control.
 *
 * V1 used CUSTOMER and ADMIN/STORE_OWNER only, with STORE_OWNER reusing
 * ADMIN's full permission set — that was fine when "the store owner" and
 * "the admin" were the same single-tenant deployment. V2 is a marketplace:
 * SELLER_OWNER/SELLER_MANAGER are now genuinely different from ADMIN — they
 * get a SELLER-scoped permission set, never the admin one, and BOTH are
 * useless without ownership. See the two-layer note below.
 *
 * IMPORTANT — TWO LAYERS, NEVER BLURRED:
 *   `roleHasPermission` — may this ROLE perform this KIND of action at all?
 *   ownership / seller-scoping — may this USER touch THIS record?
 *
 * For a seller role, ownership means "is the caller's user id present in
 * `SellerStaff` for the seller that owns this record?" — enforced by
 * `requireSellerAccess` (middleware/sellerAuth.ts) and re-checked in every
 * seller-scoped service function, never trusted from a route param alone.
 * A permission check alone (e.g. `SELLER_ORDER_UPDATE_STATUS`) proves the
 * caller is SOME seller's staff — it does NOT prove they own the specific
 * SellerOrder in the URL. Skipping the second check is the classic IDOR bug
 * this split exists to prevent.
 */

import { UserRole } from './enums';

export const Permission = {
  /* catalog (admin: the whole shared catalog) ---------------------------- */
  CATALOG_READ: 'catalog:read',
  CATALOG_WRITE: 'catalog:write',

  /* inventory (admin: any seller's) --------------------------------------- */
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',

  /* orders (admin: cross-seller) ------------------------------------------ */
  ORDER_CREATE: 'order:create',
  ORDER_READ_OWN: 'order:read_own',
  ORDER_READ_ALL: 'order:read_all',
  ORDER_CANCEL_OWN: 'order:cancel_own',
  ORDER_UPDATE_STATUS: 'order:update_status',
  ORDER_REFUND: 'order:refund',

  /* cart & addresses */
  CART_MANAGE: 'cart:manage',
  ADDRESS_MANAGE: 'address:manage',

  /* delivery (admin: assigns/manages the platform fleet) ------------------ */
  DELIVERY_AGENT_READ: 'delivery_agent:read',
  DELIVERY_AGENT_WRITE: 'delivery_agent:write',
  DELIVERY_ASSIGN: 'delivery:assign',
  DELIVERY_SELF_UPDATE: 'delivery:self_update',

  /* customers */
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_WRITE: 'customer:write',

  /* config & coupons (admin, platform-wide) -------------------------------- */
  CONFIG_READ: 'config:read',
  CONFIG_WRITE: 'config:write',
  COUPON_READ: 'coupon:read',
  COUPON_WRITE: 'coupon:write',

  /* reporting */
  DASHBOARD_READ: 'dashboard:read',

  /* seller management (admin only — sellers do not self-register) -------- */
  SELLER_MANAGE: 'seller:manage',
  SELLER_ONBOARDING_REVIEW: 'seller_onboarding:review',
  COMMISSION_MANAGE: 'commission:manage',
  SETTLEMENT_READ: 'settlement:read',
  SETTLEMENT_MANAGE: 'settlement:manage',

  /* catalog approval (admin reviews; seller submits) ----------------------- */
  PRODUCT_APPROVAL_REVIEW: 'product_approval:review',
  PRODUCT_APPROVAL_SUBMIT: 'product_approval:submit',

  /* seller self-service — every one of these is ADDITIONALLY scoped to the
   * caller's own seller(s) via SellerStaff; see the file header. */
  SELLER_PROFILE_MANAGE: 'seller_profile:manage_own',
  SELLER_CATALOG_MANAGE: 'seller_catalog:manage_own',
  SELLER_ORDER_READ_OWN: 'seller_order:read_own',
  SELLER_ORDER_UPDATE_STATUS: 'seller_order:update_status_own',
  SELLER_STAFF_MANAGE: 'seller_staff:manage_own',
  /// Read-only — creating/paying a settlement is always ADMIN
  /// (SETTLEMENT_MANAGE); a seller only ever views its own earnings/payouts.
  SELLER_SETTLEMENT_READ: 'seller_settlement:read_own',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const CUSTOMER_PERMISSIONS: readonly Permission[] = [
  Permission.CATALOG_READ,
  Permission.ORDER_CREATE,
  Permission.ORDER_READ_OWN,
  Permission.ORDER_CANCEL_OWN,
  Permission.CART_MANAGE,
  Permission.ADDRESS_MANAGE,
];

/**
 * A seller's own staff — scoped entirely to whichever seller(s) `SellerStaff`
 * links them to. Never gets ORDER_READ_ALL/CATALOG_WRITE/etc — those are
 * cross-seller admin permissions.
 *
 * Also carries every CUSTOMER_PERMISSIONS: `User.role` is a single field
 * (no multi-role support), and admin-seller-management.service's
 * `createSeller` promotes an EXISTING customer's own account in place when
 * their mobile number is reused as a seller owner. Without this, that one
 * login would silently lose its cart/addresses/own-order access the moment
 * it became a seller owner. Since sellers do not self-register, that reuse
 * is the normal path, not an edge case — so a seller account being ALSO a
 * shopper is intentional, not a leftover.
 */
const SELLER_STAFF_PERMISSIONS: readonly Permission[] = [
  ...CUSTOMER_PERMISSIONS,
  Permission.SELLER_PROFILE_MANAGE,
  Permission.SELLER_CATALOG_MANAGE,
  Permission.SELLER_ORDER_READ_OWN,
  Permission.SELLER_ORDER_UPDATE_STATUS,
  Permission.PRODUCT_APPROVAL_SUBMIT,
  Permission.SELLER_SETTLEMENT_READ,
];

const SELLER_MANAGER_PERMISSIONS: readonly Permission[] = [
  ...SELLER_STAFF_PERMISSIONS,
  Permission.SELLER_STAFF_MANAGE,
];

/** V1's STORE_STAFF_PERMISSIONS — admin-side staff who work across every
 * seller (order ops, inventory support), distinct from a seller's OWN staff
 * above. */
const ADMIN_STAFF_PERMISSIONS: readonly Permission[] = [
  Permission.CATALOG_READ,
  Permission.INVENTORY_READ,
  Permission.INVENTORY_WRITE,
  Permission.ORDER_READ_ALL,
  Permission.ORDER_UPDATE_STATUS,
  Permission.DELIVERY_AGENT_READ,
  Permission.DELIVERY_ASSIGN,
  Permission.DASHBOARD_READ,
  Permission.PRODUCT_APPROVAL_REVIEW,
  // Admin has full cross-seller visibility/control (#26) — including every
  // action a seller could take on its own SellerOrder.
  Permission.SELLER_ORDER_READ_OWN,
  Permission.SELLER_ORDER_UPDATE_STATUS,
];

const ADMIN_MANAGER_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_STAFF_PERMISSIONS,
  Permission.CATALOG_WRITE,
  Permission.DELIVERY_AGENT_WRITE,
  Permission.CUSTOMER_READ,
  Permission.COUPON_READ,
  Permission.CONFIG_READ,
  Permission.SELLER_ONBOARDING_REVIEW,
  Permission.SETTLEMENT_READ,
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_MANAGER_PERMISSIONS,
  Permission.ORDER_REFUND,
  Permission.CUSTOMER_WRITE,
  Permission.CONFIG_WRITE,
  Permission.COUPON_WRITE,
  Permission.SELLER_MANAGE,
  Permission.COMMISSION_MANAGE,
  Permission.SETTLEMENT_MANAGE,
];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  [UserRole.CUSTOMER]: CUSTOMER_PERMISSIONS,
  [UserRole.ADMIN]: ADMIN_PERMISSIONS,
  [UserRole.SUPER_ADMIN]: Object.values(Permission),
  [UserRole.SELLER_OWNER]: SELLER_MANAGER_PERMISSIONS,
  [UserRole.SELLER_MANAGER]: SELLER_MANAGER_PERMISSIONS,
  [UserRole.STAFF]: ADMIN_STAFF_PERMISSIONS,
  [UserRole.DELIVERY_AGENT]: [Permission.DELIVERY_SELF_UPDATE, Permission.ORDER_READ_ALL],
  [UserRole.PHARMACIST]: SELLER_STAFF_PERMISSIONS,
  [UserRole.RESTAURANT_MANAGER]: SELLER_MANAGER_PERMISSIONS,
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/** Roles allowed to sign in to the ADMIN panel — cross-seller, platform staff. */
export const ADMIN_PANEL_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
  UserRole.STAFF,
];

/** Roles allowed to sign in to the SELLER panel — scoped via SellerStaff. */
export const SELLER_PANEL_ROLES: readonly UserRole[] = [
  UserRole.SELLER_OWNER,
  UserRole.SELLER_MANAGER,
  UserRole.PHARMACIST,
  UserRole.RESTAURANT_MANAGER,
];

export function isAdminRole(role: UserRole): boolean {
  return ADMIN_PANEL_ROLES.includes(role);
}

export function isSellerRole(role: UserRole): boolean {
  return SELLER_PANEL_ROLES.includes(role);
}
