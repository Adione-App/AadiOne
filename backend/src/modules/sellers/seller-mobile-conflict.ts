/**
 * Does a mobile number already have a PARTNER account (Seller Panel, admin,
 * staff, delivery — account-type.ts)? The ONE classification seller signup
 * decides on, so a refusal names the actual conflicting account instead of a
 * generic "already exists".
 *
 * A number's CUSTOMER account (the shopping app) is a separate account and is
 * NEVER a conflict here: the same number registers a seller in the Seller
 * Panel and shops in the customer app, as two accounts — never merged. Admin
 * seller creation (admin-seller-management.service.ts) applies the same
 * refusals (STAFF, BLOCKED).
 *
 * Each account has a canonical 10-digit mobile (normalised by
 * normalizeIndianMobile everywhere it is written); deleted accounts never hold
 * a number (their mobile is tombstoned).
 *
 *   NONE           no partner account: seller signup can proceed
 *   SELLER         a seller staff account with a live store membership
 *   FORMER_SELLER  a seller-role account whose store memberships all ended
 *                  (store removed / membership deactivated)
 *   STAFF          an admin / staff / delivery account
 *   BLOCKED        a partner account an admin blocked
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { ErrorCode, SellerLifecycleStatus, UserRole, UserStatus, isSellerRole, maskMobile } from '../../shared';
import { AppError } from '../../common/errors';
import { PARTNER_ACCOUNT } from '../auth/account-type';

type Db = PrismaClient | Prisma.TransactionClient;

export type MobileConflictKind = 'NONE' | 'SELLER' | 'FORMER_SELLER' | 'STAFF' | 'BLOCKED';

export interface MobileConflict {
  kind: MobileConflictKind;
  userId: string | null;
  /** SELLER: the live stores this account belongs to (names and states only). */
  sellers: { name: string; lifecycleStatus: SellerLifecycleStatus; isActive: boolean }[];
}

const STAFF_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF, UserRole.DELIVERY_AGENT];

/** `mobile` must already be the canonical 10-digit form (mobileSchema / normalizeIndianMobile). */
export async function findMobileConflict(db: Db, mobile: string): Promise<MobileConflict> {
  const user = await db.user.findFirst({
    where: { mobile, ...PARTNER_ACCOUNT },
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
  if (sellers.length > 0 || !isSellerRole(user.role)) return { kind: 'SELLER', userId: user.id, sellers };
  return { kind: 'FORMER_SELLER', userId: user.id, sellers: [] };
}

const REJECTED: readonly SellerLifecycleStatus[] = [
  SellerLifecycleStatus.APPLICATION_REJECTED,
  SellerLifecycleStatus.ONBOARDING_REJECTED,
];

/** The applicant-facing message for a seller-signup conflict. */
export function sellerSignupConflictMessage(conflict: MobileConflict): string {
  switch (conflict.kind) {
    case 'SELLER':
      return conflict.sellers.some((seller) => REJECTED.includes(seller.lifecycleStatus))
        ? 'This mobile number already has a seller application. Sign in to the Seller Panel to correct and resubmit it.'
        : 'This mobile number is already registered as a seller on Aadione. Sign in to the Seller Panel instead.';
    case 'FORMER_SELLER':
      return 'This mobile number already has an Aadione seller account whose store is closed. Sign in to the Seller Panel with it, or contact Aadione support to reopen it.';
    case 'STAFF':
      return 'This mobile number belongs to an Aadione staff or delivery account and cannot be used for a seller.';
    case 'BLOCKED':
      return 'This mobile number belongs to a blocked seller account. Contact Aadione support.';
    default:
      return 'This mobile number is already registered.';
  }
}

/** 409 MOBILE_ALREADY_REGISTERED with the real conflict type in details[0].conflict. */
export function sellerSignupConflictError(conflict: MobileConflict, mobile: string): AppError {
  const message = sellerSignupConflictMessage(conflict);
  return new AppError(ErrorCode.MOBILE_ALREADY_REGISTERED, {
    message,
    details: [{ field: 'mobile', message, conflict: conflict.kind }],
    internalMessage: `seller signup: mobile ${maskMobile(mobile)} already used by a ${conflict.kind} partner account (user ${conflict.userId})`,
  });
}
