/**
 * Who already uses a mobile number — the ONE classification seller signup
 * decides on, so the answer always names the actual conflicting record
 * instead of a generic "already exists". One account can both shop and sell:
 * a CUSTOMER (or FORMER_SELLER) account applies while SIGNED IN — the store is
 * added to the account of that session (seller-lifecycle.service
 * applyToSellAsSignedInUser, POST /auth/seller/apply). The public signup form
 * never attaches to an existing account: it sends the applicant to sign in
 * (details.signInToApply). Admin seller creation
 * (admin-seller-management.service.ts) applies the same refusals (STAFF,
 * BLOCKED) and makes an existing CUSTOMER account the owner directly.
 *
 * Every account has one unique, canonical 10-digit mobile (users.mobile,
 * normalised by normalizeIndianMobile everywhere it is written), shared by
 * all roles: a number that ever signed in to the customer app (the first OTP
 * creates a CUSTOMER account) is already "taken" for seller self-signup.
 * Deleted accounts never hold a number (their mobile is tombstoned).
 *
 *   NONE           free
 *   SELLER         a seller staff account with a live store membership
 *   FORMER_SELLER  a seller-role account whose store memberships all ended
 *                  (store removed / membership deactivated)
 *   CUSTOMER       a shopping-app account
 *   STAFF          an admin / staff / delivery account
 *   BLOCKED        an account an admin blocked
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { ErrorCode, SellerLifecycleStatus, UserRole, UserStatus, isSellerRole, maskMobile } from '../../shared';
import { AppError } from '../../common/errors';

type Db = PrismaClient | Prisma.TransactionClient;

export type MobileConflictKind = 'NONE' | 'SELLER' | 'FORMER_SELLER' | 'CUSTOMER' | 'STAFF' | 'BLOCKED';

export interface MobileConflict {
  kind: MobileConflictKind;
  userId: string | null;
  /** SELLER: the live stores this account belongs to (names and states only). */
  sellers: { name: string; lifecycleStatus: SellerLifecycleStatus; isActive: boolean }[];
}

const STAFF_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF, UserRole.DELIVERY_AGENT];

/** `mobile` must already be the canonical 10-digit form (mobileSchema / normalizeIndianMobile). */
export async function findMobileConflict(db: Db, mobile: string): Promise<MobileConflict> {
  const user = await db.user.findUnique({
    where: { mobile },
    select: {
      id: true,
      role: true,
      status: true,
      deletedAt: true,
      sellerStaff: {
        where: { isActive: true, deletedAt: null, seller: { deletedAt: null } },
        select: { seller: { select: { name: true, lifecycleStatus: true, isActive: true } } },
      },
    },
  });
  if (!user) return { kind: 'NONE', userId: null, sellers: [] };
  if (user.status === UserStatus.BLOCKED) return { kind: 'BLOCKED', userId: user.id, sellers: [] };
  if (STAFF_ROLES.includes(user.role)) return { kind: 'STAFF', userId: user.id, sellers: [] };
  const sellers = user.sellerStaff.map((member) => member.seller);
  if (sellers.length > 0) return { kind: 'SELLER', userId: user.id, sellers };
  if (isSellerRole(user.role)) return { kind: 'FORMER_SELLER', userId: user.id, sellers: [] };
  return { kind: 'CUSTOMER', userId: user.id, sellers: [] };
}

const REJECTED: readonly SellerLifecycleStatus[] = [
  SellerLifecycleStatus.APPLICATION_REJECTED,
  SellerLifecycleStatus.ONBOARDING_REJECTED,
];

/** Accounts a signed-in seller application may be added to. */
export function canApplyWithExistingAccount(kind: MobileConflictKind): boolean {
  return kind === 'CUSTOMER' || kind === 'FORMER_SELLER';
}

/** The customer-facing message for a seller-signup conflict. */
export function sellerSignupConflictMessage(conflict: MobileConflict): string {
  switch (conflict.kind) {
    case 'SELLER':
      return conflict.sellers.some((seller) => REJECTED.includes(seller.lifecycleStatus))
        ? 'This mobile number already has a seller application. Sign in to the Seller Panel to correct and resubmit it.'
        : 'This mobile number is already registered as a seller on Aadione. Sign in to the Seller Panel instead.';
    case 'FORMER_SELLER':
      return 'This mobile number already has an Aadione account (its earlier store is closed). Sign in to the Aadione app with this number and open Account → Sell on Aadione to apply again on the same account.';
    case 'CUSTOMER':
      return 'This mobile number already has an Aadione shopping account. Sign in to the Aadione app with this number and open Account → Sell on Aadione — your store is added to the same account, and your orders, addresses and saved details stay as they are.';
    case 'STAFF':
      return 'This mobile number belongs to an Aadione staff or delivery account and cannot be used for a seller.';
    case 'BLOCKED':
      return 'This mobile number belongs to a blocked account. Contact Aadione support.';
    default:
      return 'This mobile number is already registered.';
  }
}

/** 409 MOBILE_ALREADY_REGISTERED with the real conflict type in details[0].conflict. */
export function sellerSignupConflictError(conflict: MobileConflict, mobile: string): AppError {
  const message = sellerSignupConflictMessage(conflict);
  return new AppError(ErrorCode.MOBILE_ALREADY_REGISTERED, {
    message,
    // signInToApply: not a dead end — the applicant signs in and applies from the app.
    details: [{ field: 'mobile', message, conflict: conflict.kind, signInToApply: canApplyWithExistingAccount(conflict.kind) }],
    internalMessage: `seller signup: mobile ${maskMobile(mobile)} already used by a ${conflict.kind} account (user ${conflict.userId})`,
  });
}
