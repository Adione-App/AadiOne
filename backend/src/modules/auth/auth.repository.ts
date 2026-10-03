/**
 * Auth data access. No decisions here — the service owns policy.
 */

import type { User } from '@prisma/client';
import { UserRole, UserStatus } from '../../shared';
import { prisma, type DbClient } from '../../infra/db/prisma';

export async function findUserByMobile(
  mobile: string,
  client: DbClient = prisma,
): Promise<User | null> {
  return client.user.findUnique({ where: { mobile } });
}

export async function findUserById(
  id: string,
  client: DbClient = prisma,
): Promise<User | null> {
  return client.user.findUnique({ where: { id } });
}

export async function findUserByEmail(
  email: string,
  client: DbClient = prisma,
): Promise<User | null> {
  // Case-insensitive: the unique index is on lower(email).
  return client.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
  });
}

export async function createCustomer(
  input: { mobile: string; referralCode: string },
  client: DbClient = prisma,
): Promise<User> {
  const now = new Date();
  return client.user.create({
    data: {
      mobile: input.mobile,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      referralCode: input.referralCode,
      lastLoginAt: now,
      // Created by a successful OTP verification, so the number is proven.
      mobileVerifiedAt: now,
    },
  });
}

/** Task 2.6 — email + password registration. */
export async function createCustomerWithPassword(
  input: {
    mobile: string;
    email: string;
    fullName: string;
    passwordHash: string;
    referralCode: string;
  },
  client: DbClient = prisma,
): Promise<User> {
  return client.user.create({
    data: {
      mobile: input.mobile,
      email: input.email.toLowerCase(),
      fullName: input.fullName,
      passwordHash: input.passwordHash,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      referralCode: input.referralCode,
      lastLoginAt: new Date(),
      // Deliberately NOT set: nobody has proven this number belongs to the
      // person signing up. One OTP login completes verification.
      mobileVerifiedAt: null,
    },
  });
}

/** Called after a successful OTP verification. */
export async function markMobileVerified(
  userId: string,
  client: DbClient = prisma,
): Promise<void> {
  await client.user.update({
    where: { id: userId },
    data: { mobileVerifiedAt: new Date() },
  });
}

export async function touchLastLogin(
  userId: string,
  client: DbClient = prisma,
): Promise<void> {
  await client.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  });
}

/** True when the user is an active staff member of at least one live seller. */
export async function hasActiveSellerMembership(
  userId: string,
  client: DbClient = prisma,
): Promise<boolean> {
  const count = await client.sellerStaff.count({
    where: { userId, isActive: true, deletedAt: null, seller: { deletedAt: null } },
  });
  return count > 0;
}

export async function updateProfile(
  userId: string,
  data: { fullName?: string; email?: string | null },
  client: DbClient = prisma,
): Promise<User> {
  return client.user.update({
    where: { id: userId },
    data: {
      ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
      ...(data.email !== undefined
        ? { email: data.email ? data.email.toLowerCase() : null }
        : {}),
    },
  });
}

export async function referralCodeExists(
  code: string,
  client: DbClient = prisma,
): Promise<boolean> {
  const found = await client.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
  return found !== null;
}

/* -------------------------------------------------------------------------- */
/* Refresh tokens                                                             */
/* -------------------------------------------------------------------------- */

export interface StoredRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function createRefreshToken(
  input: {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  },
  client: DbClient = prisma,
): Promise<StoredRefreshToken> {
  return client.refreshToken.create({
    data: {
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    },
    select: { id: true, userId: true, familyId: true, expiresAt: true, revokedAt: true },
  });
}

export async function findRefreshTokenByHash(
  tokenHash: string,
  client: DbClient = prisma,
): Promise<StoredRefreshToken | null> {
  return client.refreshToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, familyId: true, expiresAt: true, revokedAt: true },
  });
}

export async function revokeRefreshToken(
  id: string,
  client: DbClient = prisma,
): Promise<void> {
  await client.refreshToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revokes every live token in a family.
 *
 * Called on logout and — critically — on refresh-token reuse detection: if a
 * rotated token is presented again, either it was stolen or it was replayed,
 * and in both cases the safe response is to end the whole session.
 */
export async function revokeTokenFamily(
  familyId: string,
  client: DbClient = prisma,
): Promise<number> {
  const result = await client.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function revokeAllUserTokens(
  userId: string,
  client: DbClient = prisma,
): Promise<number> {
  const result = await client.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Housekeeping: drop tokens that expired more than a week ago. */
export async function deleteExpiredTokens(
  olderThan: Date,
  client: DbClient = prisma,
): Promise<number> {
  const result = await client.refreshToken.deleteMany({
    where: { expiresAt: { lt: olderThan } },
  });
  return result.count;
}
