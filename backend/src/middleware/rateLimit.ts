/**
 * Rate limiting.
 *
 * Fixed-window counters in the cache store. The window's TTL is set only when
 * the counter is created, so a caller cannot extend their own window by making
 * more requests — which is the classic way a naive implementation becomes a
 * no-op under load.
 *
 * Several limiters usually stack on one route. `/auth/send-otp` carries three:
 * per mobile per hour, per mobile per day, and per IP per hour. Per-mobile
 * alone lets one attacker SMS-bomb many numbers; per-IP alone is defeated by a
 * mobile network's shared NAT, where thousands of genuine users share an
 * address. Together they cover both.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode } from '../shared';
import { AppError } from '../common/errors';
import { cache, CacheKey } from '../infra/cache';
import { moduleLogger } from '../common/logger';

const log = moduleLogger('rate-limit');

export interface RateLimitOptions {
  /** Namespace, so two limiters never share a counter. */
  scope: string;
  limit: number;
  windowSeconds: number;
  /**
   * Identifies the caller. Defaults to IP. Returning null skips the limiter
   * (e.g. a per-mobile limit on a request whose body has no mobile — the
   * validator will reject it a moment later anyway).
   */
  identify?: (req: Request) => string | null;
  /** Error code to raise; lets OTP routes return OTP_RATE_LIMITED. */
  errorCode?: ErrorCode;
  message?: string;
}

function defaultIdentify(req: Request): string {
  return req.ip ?? 'unknown';
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const identify = options.identify ?? defaultIdentify;
  const errorCode = options.errorCode ?? ErrorCode.RATE_LIMITED;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identifier = identify(req);
      if (identifier === null) return next();

      const key = CacheKey.rateLimit(options.scope, identifier);
      const count = await cache.increment(key, options.windowSeconds);

      const remaining = Math.max(0, options.limit - count);
      res.setHeader('X-RateLimit-Limit', String(options.limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));

      if (count > options.limit) {
        const ttl = await cache.ttl(key);
        const retryAfter = ttl > 0 ? ttl : options.windowSeconds;

        log.warn(
          { scope: options.scope, count, limit: options.limit },
          'rate limit exceeded',
        );

        throw new AppError(errorCode, {
          retryAfterSeconds: retryAfter,
          ...(options.message !== undefined ? { message: options.message } : {}),
          internalMessage: `rate limit ${options.scope} exceeded: ${count}/${options.limit}`,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Shared identifiers                                                         */
/* -------------------------------------------------------------------------- */

/** Rate-limits by the mobile number in the request body. */
export const byMobile = (req: Request): string | null => {
  const mobile = (req.body as { mobile?: unknown } | undefined)?.mobile;
  return typeof mobile === 'string' && mobile.length > 0 ? mobile : null;
};

/** Rate-limits by authenticated user, falling back to IP for anonymous calls. */
export const byUser = (req: Request): string => req.user?.id ?? req.ip ?? 'unknown';

/** Rate-limits by the email in the request body (login, signup). */
export const byEmail = (req: Request): string | null => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.length > 0 ? email.toLowerCase() : null;
};

/* -------------------------------------------------------------------------- */
/* Named limiters (PRD §13.3)                                                 */
/* -------------------------------------------------------------------------- */

const HOUR = 3600;
const DAY = 86_400;
const MINUTE = 60;

export const otpPerMobileHourly = rateLimit({
  scope: 'otp:mobile:hour',
  limit: 3,
  windowSeconds: HOUR,
  identify: byMobile,
  errorCode: ErrorCode.OTP_RATE_LIMITED,
});

export const otpPerMobileDaily = rateLimit({
  scope: 'otp:mobile:day',
  limit: 10,
  windowSeconds: DAY,
  identify: byMobile,
  errorCode: ErrorCode.OTP_RATE_LIMITED,
});

export const otpPerIpHourly = rateLimit({
  scope: 'otp:ip:hour',
  limit: 10,
  windowSeconds: HOUR,
  errorCode: ErrorCode.OTP_RATE_LIMITED,
});

/** Guards brute-forcing the verify endpoint across many numbers from one host. */
export const verifyOtpPerIp = rateLimit({
  scope: 'otp:verify:ip',
  limit: 30,
  windowSeconds: HOUR,
  errorCode: ErrorCode.OTP_RATE_LIMITED,
});

export const orderCreationPerUser = rateLimit({
  scope: 'orders:create',
  limit: 10,
  windowSeconds: HOUR,
  identify: byUser,
});

export const authenticatedApiLimit = rateLimit({
  scope: 'api:user',
  limit: 300,
  windowSeconds: MINUTE,
  identify: byUser,
});

export const publicApiLimit = rateLimit({
  scope: 'api:ip',
  limit: 120,
  windowSeconds: MINUTE,
});

export const adminLoginPerIp = rateLimit({
  scope: 'admin:login:ip',
  limit: 10,
  windowSeconds: 15 * MINUTE,
  errorCode: ErrorCode.RATE_LIMITED,
});

/* --- Task 2.5 / 2.6: password login and signup ---------------------------- */

/**
 * Per-account limit. Stops an attacker grinding one known email with a
 * dictionary, which is the realistic attack against a password login.
 */
export const loginPerEmail = rateLimit({
  scope: 'login:email',
  limit: 8,
  windowSeconds: 15 * MINUTE,
  identify: byEmail,
  message: 'Too many login attempts for this account. Please try again in a few minutes.',
});

/**
 * Per-source limit. Stops credential stuffing — many different emails, one
 * password each — which the per-email limiter alone would never see.
 * Deliberately more generous, because a mobile network NATs many genuine
 * users behind one address.
 */
export const loginPerIp = rateLimit({
  scope: 'login:ip',
  limit: 40,
  windowSeconds: 15 * MINUTE,
});

/** Signup is heavily throttled per source: it creates rows and sends nothing. */
export const signupPerIp = rateLimit({
  scope: 'signup:ip',
  limit: 5,
  windowSeconds: HOUR,
});

export const signupPerMobile = rateLimit({
  scope: 'signup:mobile',
  limit: 3,
  windowSeconds: HOUR,
  identify: byMobile,
});

/* --- Referrals -------------------------------------------------------------- */

/** Guards a new account from grinding through referral codes to find a valid one. */
export const referralApplyPerUser = rateLimit({
  scope: 'referral:apply:user',
  limit: 5,
  windowSeconds: HOUR,
  identify: byUser,
});
