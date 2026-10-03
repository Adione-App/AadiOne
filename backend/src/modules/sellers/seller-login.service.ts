/**
 * Seller login credentials (admin-issued).
 *
 * Sellers never register themselves: AdiOne creates the seller and its owner
 * account (admin-seller-management.service's `createSeller` — mobile + name,
 * no password), then an admin issues the owner's panel login here — an email
 * plus a server-generated TEMPORARY password, shown to the admin exactly once
 * and handed to the seller. The seller signs in at the web login (Seller) and
 * is asked to change it (auth.service's `changePassword`).
 *
 * Issuing again is the reset path: a fresh temporary password, and every
 * existing session of that account ends.
 */

import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ErrorCode, UserStatus, isSellerRole } from '../../shared';
import { AppError } from '../../common/errors';
import { hashPassword } from '../../common/crypto';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { PASSWORD_AUDIT, isPasswordChangeRequired } from '../auth/auth.service';
import * as tokenService from '../auth/token.service';

const log = moduleLogger('seller-login');

export interface SellerLoginAccountDto {
  sellerId: string;
  ownerUserId: string;
  ownerName: string | null;
  /** The owner's login email, or null until credentials are issued. */
  email: string | null;
  hasPassword: boolean;
  /** Issued by AdiOne and not yet changed by the seller. */
  passwordChangeRequired: boolean;
  lastLoginAt: string | null;
}

export interface IssuedSellerCredentialsDto extends SellerLoginAccountDto {
  /** Shown to the admin ONCE — never stored in plain text, never logged. */
  temporaryPassword: string;
}

/** Letters and digits without look-alikes (0/O, 1/l/I). */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';

/** 14 characters, uniformly random, always meeting the password policy. */
function generateTemporaryPassword(): string {
  const alphabet = LETTERS + DIGITS;
  for (;;) {
    let password = '';
    for (let i = 0; i < 14; i += 1) password += alphabet[randomInt(alphabet.length)];
    if (/[A-Za-z]/.test(password) && /\d/.test(password)) return password;
  }
}

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

async function toDto(sellerId: string, user: {
  id: string;
  fullName: string | null;
  email: string | null;
  passwordHash: string | null;
  lastLoginAt: Date | null;
}): Promise<SellerLoginAccountDto> {
  return {
    sellerId,
    ownerUserId: user.id,
    ownerName: user.fullName,
    email: user.email,
    hasPassword: user.passwordHash !== null,
    passwordChangeRequired: user.passwordHash !== null && (await isPasswordChangeRequired(user.id)),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** GET /admin/sellers/:sellerId/login-credentials — status only, no secrets. */
export async function getSellerLoginAccount(sellerId: string): Promise<SellerLoginAccountDto> {
  return toDto(sellerId, await loadOwner(sellerId));
}

/**
 * POST /admin/sellers/:sellerId/login-credentials — sets the owner's login
 * email and a new temporary password. The password is returned once; only
 * its bcrypt hash is stored, and the audit entry records who issued it and
 * for which email, never the password.
 */
export async function issueSellerLoginCredentials(
  sellerId: string,
  email: string,
  actorUserId: string,
): Promise<IssuedSellerCredentialsDto> {
  const owner = await loadOwner(sellerId);
  if (!isSellerRole(owner.role)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'The owner account is not a seller account.',
      internalMessage: `owner ${owner.id} of seller ${sellerId} has role ${owner.role}`,
    });
  }
  if (owner.deletedAt || owner.status !== UserStatus.ACTIVE) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'The owner account is blocked or deleted.',
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
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This email is already used by another account.',
    });
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  let updated;
  try {
    updated = await runInTransaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: owner.id },
        data: { email: normalizedEmail, passwordHash },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: PASSWORD_AUDIT.ISSUED_BY_ADMIN,
          entityType: 'User',
          entityId: owner.id,
          before: { email: owner.email, hadPassword: owner.passwordHash !== null },
          after: { sellerId, email: normalizedEmail },
        },
      });
      return user;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'This email is already used by another account.',
      });
    }
    throw error;
  }

  // Whoever was signed in with the previous password (or a leaked temporary
  // one) is signed out.
  await tokenService.revokeAllSessions(owner.id);

  log.info({ sellerId, ownerUserId: owner.id, actorUserId }, 'seller login credentials issued');
  return { ...(await toDto(sellerId, updated)), temporaryPassword };
}
