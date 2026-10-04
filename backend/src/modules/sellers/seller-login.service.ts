/**
 * Seller login account — what ADMIN may see and do about a seller's sign-in.
 *
 * A seller signs in to the Seller Panel with its EMAIL and PASSWORD only
 * (POST /auth/seller/login). The password belongs to the seller alone: it is
 * chosen at signup, changed in the panel (POST /auth/change-password) or reset
 * by the seller through "Forgot Password?" (auth/password-reset.service.ts).
 *
 * Admin therefore:
 *   - sees the owner's LOGIN EMAIL (and name / last sign-in) — never a
 *     password, a hash, or whether one is temporary;
 *   - may set the login email ONCE, for an owner account that has none yet
 *     (a seller AdiOne created without one). The seller then sets its own
 *     password with "Forgot Password?". An email that is already set is the
 *     seller's: admin cannot change it — changing it would let anyone with
 *     admin access take the account over through the reset email.
 *
 * There is deliberately no admin path that issues, resets, changes or reveals
 * a seller password (the former temporary-password issue route was removed).
 */

import { Prisma } from '@prisma/client';
import { ErrorCode, UserStatus, isSellerRole } from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction } from '../../infra/db/prisma';

const log = moduleLogger('seller-login');

export interface SellerLoginAccountDto {
  sellerId: string;
  ownerName: string | null;
  /** The owner's login email, or null until one is set. */
  email: string | null;
  lastLoginAt: string | null;
}

export const SELLER_LOGIN_AUDIT = {
  EMAIL_SET_BY_ADMIN: 'seller_login.email_set',
} as const;

async function loadOwner(sellerId: string) {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null },
    select: { id: true },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

  const owner = await prisma.sellerStaff.findFirst({
    where: { sellerId, role: 'OWNER', isActive: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { user: true },
  });
  if (!owner) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This seller has no active owner account to sign in with.',
    });
  }
  return owner.user;
}

function toDto(sellerId: string, user: { fullName: string | null; email: string | null; lastLoginAt: Date | null }): SellerLoginAccountDto {
  return {
    sellerId,
    ownerName: user.fullName,
    email: user.email,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** GET /admin/sellers/:sellerId/login-credentials — the login email; never a secret. */
export async function getSellerLoginAccount(sellerId: string): Promise<SellerLoginAccountDto> {
  return toDto(sellerId, await loadOwner(sellerId));
}

/**
 * PUT /admin/sellers/:sellerId/login-email — sets the owner's login email when
 * it has none. No password is created or touched: the seller sets its own with
 * "Forgot Password?". Refused once an email exists (see this file's comment).
 */
export async function setInitialSellerLoginEmail(
  sellerId: string,
  email: string,
  actorUserId: string,
): Promise<SellerLoginAccountDto> {
  const owner = await loadOwner(sellerId);
  if (!isSellerRole(owner.role)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'The owner account is not a seller account.',
      internalMessage: `owner ${owner.id} of seller ${sellerId} has role ${owner.role}`,
    });
  }
  if (owner.deletedAt || owner.status !== UserStatus.ACTIVE) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The owner account is blocked or deleted.' });
  }
  if (owner.email) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 409,
      message: 'This seller already has a login email. Only the seller manages its own login.',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  // Emails are unique case-insensitively across every account (the
  // users_email_unique index covers deleted rows too).
  const clash = await prisma.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' }, id: { not: owner.id } },
    select: { id: true },
  });
  if (clash) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'This email is already used by another account.' });
  }

  let updated;
  try {
    updated = await runInTransaction(async (tx) => {
      // Compare-and-set: never overwrite an email set meanwhile.
      const { count } = await tx.user.updateMany({ where: { id: owner.id, email: null }, data: { email: normalizedEmail } });
      if (count === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          status: 409,
          message: 'This seller already has a login email. Only the seller manages its own login.',
        });
      }
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: SELLER_LOGIN_AUDIT.EMAIL_SET_BY_ADMIN,
          entityType: 'User',
          entityId: owner.id,
          before: { email: null },
          after: { sellerId, email: normalizedEmail },
        },
      });
      return tx.user.findUniqueOrThrow({ where: { id: owner.id } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'This email is already used by another account.' });
    }
    throw error;
  }

  log.info({ sellerId, ownerUserId: owner.id, actorUserId }, 'seller login email set');
  return toDto(sellerId, updated);
}
