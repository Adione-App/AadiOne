/**
 * Seller "Forgot Password?" — an email reset link the seller uses to choose a
 * new password themselves. Nobody else (admin included) ever sets, sees or
 * resets a seller's password.
 *
 *   request  POST /auth/seller/forgot-password { email }
 *            Always the same answer, whether or not the email belongs to a
 *            seller account — the response never tells an attacker which
 *            emails exist. Only an active seller-role account with an active
 *            seller membership gets an email.
 *   reset    POST /auth/seller/reset-password { token, newPassword }
 *            The token is claimed ATOMICALLY (one UPDATE … WHERE used_at IS
 *            NULL AND expires_at > now()), so it works exactly once and only
 *            before it expires. The new password is bcrypt-hashed, every
 *            existing session of the account ends, and older unused links die.
 *
 * Only the SHA-256 of a token is stored (password_reset_tokens.token_hash);
 * the raw token exists only in the email. Neither the token nor any password
 * is ever logged or written to the audit log.
 */

import { randomBytes } from 'node:crypto';
import { ErrorCode, UserStatus, isSellerRole } from '../../shared';
import { AppError } from '../../common/errors';
import { hashPassword, sha256 } from '../../common/crypto';
import { moduleLogger } from '../../common/logger';
import { env } from '../../config/env';
import { runInTransaction } from '../../infra/db/prisma';
import { emailProvider, maskEmail } from '../../infra/email';
import * as repository from './auth.repository';
import * as tokenService from './token.service';
import { PASSWORD_AUDIT } from './auth.service';

const log = moduleLogger('password-reset');

export const PASSWORD_RESET_AUDIT = {
  REQUESTED: 'auth.password_reset_requested',
} as const;

/** The one answer to every forgot-password request. */
export const FORGOT_PASSWORD_MESSAGE =
  'If an Aadione seller account uses this email, we have sent it a link to reset the password. The link expires soon and works once.';

const INVALID_LINK_MESSAGE = 'This reset link is invalid, already used or expired. Request a new one from “Forgot Password?”.';

function resetLink(token: string): string {
  return `${env.SELLER_PANEL_URL.replace(/\/+$/, '')}/seller/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * POST /auth/seller/forgot-password. Resolves the same way for every email;
 * the email itself is sent without being awaited, so its delivery time does
 * not make a known address slower to answer than an unknown one.
 */
export async function requestSellerPasswordReset(email: string, context: { ip?: string | null } = {}): Promise<void> {
  const user = await repository.findUserByEmail(email);
  const eligible =
    user !== null &&
    user.deletedAt === null &&
    user.status === UserStatus.ACTIVE &&
    isSellerRole(user.role) &&
    (await repository.hasActiveSellerMembership(user.id));
  if (!user || !eligible) {
    log.info({ to: maskEmail(email) }, 'seller password reset requested for a non-seller email — nothing sent');
    return;
  }

  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await runInTransaction(async (tx) => {
    // A newer link replaces any older one still unused.
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
        requestedIp: context.ip ?? null,
      },
    });
    await tx.auditLog.create({
      data: { actorUserId: user.id, action: PASSWORD_RESET_AUDIT.REQUESTED, entityType: 'User', entityId: user.id, ip: context.ip ?? null },
    });
  });

  void emailProvider
    .send({
      to: user.email!,
      subject: 'Reset your Aadione seller password',
      text:
        `Hello${user.fullName ? ` ${user.fullName}` : ''},\n\n` +
        `Someone asked to reset the password of your Aadione Seller Panel account. ` +
        `To choose a new password, open this link within ${env.PASSWORD_RESET_TTL_MINUTES} minutes:\n\n` +
        `${resetLink(token)}\n\n` +
        `The link works once. If you did not ask for this, ignore this email — your password stays the same.`,
      sensitive: true,
    })
    .catch((error: unknown) => log.error({ err: error, userId: user.id }, 'password reset email failed'));

  log.info({ userId: user.id }, 'seller password reset link issued');
}

/**
 * POST /auth/seller/reset-password. Sets the seller's new password from a
 * valid, unused, unexpired link. Every existing session ends; the seller then
 * signs in with the new password.
 */
export async function resetSellerPassword(
  token: string,
  newPassword: string,
  context: { ip?: string | null } = {},
): Promise<void> {
  const invalid = (internalMessage: string) => new AppError(ErrorCode.VALIDATION_ERROR, { message: INVALID_LINK_MESSAGE, internalMessage });
  const passwordHash = await hashPassword(newPassword);

  const userId = await runInTransaction(async (tx) => {
    const [claimed] = await tx.$queryRaw<{ user_id: string }[]>`
      UPDATE password_reset_tokens
      SET used_at = now()
      WHERE token_hash = ${sha256(token)} AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`;
    if (!claimed) throw invalid('password reset: unknown, used or expired token');

    const user = await tx.user.findUnique({ where: { id: claimed.user_id } });
    if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE || !isSellerRole(user.role)) {
      throw invalid(`password reset: account ${claimed.user_id} is not an active seller account`);
    }

    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await tx.auditLog.create({
      data: { actorUserId: user.id, action: PASSWORD_AUDIT.RESET_BY_USER, entityType: 'User', entityId: user.id, ip: context.ip ?? null },
    });
    return user.id;
  });

  // Anything signed in with the old password is signed out.
  await tokenService.revokeAllSessions(userId);
  log.info({ userId }, 'seller password reset');
}
