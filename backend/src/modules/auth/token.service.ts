/**
 * Token issuing, verification and rotation.
 *
 * Design (PRD §13.2):
 *   ACCESS  — JWT, 15 minutes, HS256. Stateless: verified from the signature
 *             alone, so the hot path never touches the database.
 *   REFRESH — 256-bit opaque random, stored HASHED with a family id, rotated
 *             on every use, with reuse detection.
 *
 * Why not a long-lived JWT: it cannot be revoked. Why not a stateful access
 * token: every request would hit the database. The split gives revocable
 * sessions with a cheap request path, at the cost of a token being valid for
 * at most 15 minutes after a logout — an acceptable window for this system.
 */

import { randomUUID } from 'node:crypto';
import { SessionScope } from '@prisma/client';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { ErrorCode, UserRole, type AuthTokens } from '../../shared';
import { AppError } from '../../common/errors';
import { randomToken, sha256 } from '../../common/crypto';
import { env } from '../../config/env';
import { moduleLogger } from '../../common/logger';
import * as repository from './auth.repository';

const log = moduleLogger('auth:token');

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  role: UserRole;
  mobile: string;
  /** Session (refresh-token family) id, so a token maps to a revocable session. */
  sid: string;
  /**
   * Session scope. "customer" = a customer-app (OTP) session: `role` is then
   * CUSTOMER whatever the account's role, so every role/permission check
   * treats it as a shopper. Absent on tokens issued before scopes existed
   * (those carry the account's role, i.e. full).
   */
  scp?: 'customer' | 'full';
}

interface DecodedAccessToken extends AccessTokenClaims {
  iat: number;
  exp: number;
}

const ISSUER = 'adione';
const AUDIENCE = 'adione-app';

export function signAccessToken(claims: AccessTokenClaims): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  };
  return jwt.sign(claims, env.JWT_SECRET, options);
}

/**
 * Verifies an access token.
 *
 * `algorithms` is pinned to HS256. Without it, a token could declare
 * `"alg": "none"` and be accepted unsigned — the classic JWT vulnerability.
 */
export function verifyAccessToken(token: string): DecodedAccessToken {
  try {
    return jwt.verify(token, env.JWT_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }) as DecodedAccessToken;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      // Distinguished from an invalid token so the client knows to refresh
      // rather than to send the user back to the login screen.
      throw new AppError(ErrorCode.TOKEN_EXPIRED, { internalMessage: 'access token expired' });
    }
    throw new AppError(ErrorCode.TOKEN_INVALID, {
      internalMessage: `access token verification failed: ${String(error)}`,
    });
  }
}

function refreshExpiryDate(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function accessTtlSeconds(): number {
  const ttl = env.JWT_ACCESS_TTL;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 900;
  const value = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return value * multiplier;
}

export interface IssueTokensInput {
  userId: string;
  /** The ACCOUNT's role. A CUSTOMER-scope session never puts it in the token. */
  role: UserRole;
  mobile: string;
  /**
   * Required, never defaulted: CUSTOMER for the customer app (mobile OTP),
   * FULL only for a panel login (email + password).
   */
  scope: SessionScope;
  /** Continues an existing session on refresh; omit to start a new one. */
  familyId?: string;
  userAgent?: string | null;
  ip?: string | null;
}

export async function issueTokens(input: IssueTokensInput): Promise<AuthTokens> {
  const familyId = input.familyId ?? randomUUID();
  const refreshToken = randomToken(32);

  await repository.createRefreshToken({
    userId: input.userId,
    // Only the hash is stored: a database dump must not hand over live sessions.
    tokenHash: sha256(refreshToken),
    familyId,
    scope: input.scope,
    expiresAt: refreshExpiryDate(),
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });

  const customerSession = input.scope === SessionScope.CUSTOMER;
  const accessToken = signAccessToken({
    sub: input.userId,
    // The ONLY place a session's role is decided: a customer-app session of a
    // seller or admin account is a shopper — it can never open a management API.
    role: customerSession ? UserRole.CUSTOMER : input.role,
    mobile: input.mobile,
    sid: familyId,
    scp: customerSession ? 'customer' : 'full',
  });

  return { accessToken, refreshToken, expiresInSeconds: accessTtlSeconds() };
}

export interface RotateResult {
  tokens: AuthTokens;
  userId: string;
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one out.
 *
 * REUSE DETECTION: presenting a token that has already been revoked means
 * either it was stolen and replayed, or the legitimate client retried after a
 * successful rotation it never saw. Both are indistinguishable from the
 * server's position, so the safe response is to revoke the entire family and
 * force a fresh login. This is the standard defence against refresh-token
 * theft, and it is why `familyId` exists at all.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  context: { userAgent?: string | null; ip?: string | null } = {},
): Promise<RotateResult> {
  const tokenHash = sha256(presentedToken);
  const stored = await repository.findRefreshTokenByHash(tokenHash);

  if (!stored) {
    throw new AppError(ErrorCode.TOKEN_INVALID, {
      internalMessage: 'refresh token not found',
    });
  }

  if (stored.revokedAt) {
    const revokedCount = await repository.revokeTokenFamily(stored.familyId);
    log.warn(
      { userId: stored.userId, familyId: stored.familyId, revokedCount },
      'refresh token reuse detected — session family revoked',
    );
    throw new AppError(ErrorCode.TOKEN_INVALID, {
      message: 'Your session is no longer valid. Please log in again.',
      internalMessage: 'refresh token reuse detected',
    });
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw new AppError(ErrorCode.TOKEN_EXPIRED, {
      message: 'Your session has expired. Please log in again.',
      internalMessage: 'refresh token expired',
    });
  }

  const user = await repository.findUserById(stored.userId);
  if (!user || user.deletedAt) {
    throw new AppError(ErrorCode.TOKEN_INVALID, {
      internalMessage: 'refresh token belongs to a deleted user',
    });
  }
  if (user.status === 'BLOCKED') {
    throw new AppError(ErrorCode.ACCOUNT_BLOCKED, {
      internalMessage: `blocked user ${user.id} attempted refresh`,
    });
  }

  // Rotate: the presented token is spent before the replacement is issued, so
  // it can never be used twice even if the response is lost in transit.
  await repository.revokeRefreshToken(stored.id);

  const tokens = await issueTokens({
    userId: user.id,
    role: user.role,
    mobile: user.mobile,
    // The session keeps the scope it was opened with — a customer-app session
    // never comes back FULL just because the account is a seller or admin.
    scope: stored.scope,
    familyId: stored.familyId,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  return { tokens, userId: user.id };
}

/**
 * Logout. Revokes the whole family, so every device sharing this session ends.
 * Logout is a server-side act, not "the client deleted its copy".
 */
export async function revokeSession(presentedToken: string): Promise<void> {
  const stored = await repository.findRefreshTokenByHash(sha256(presentedToken));
  if (!stored) return; // Already gone — logging out twice is not an error.
  await repository.revokeTokenFamily(stored.familyId);
}

export async function revokeAllSessions(userId: string): Promise<number> {
  return repository.revokeAllUserTokens(userId);
}
