/**
 * Authentication and authorization middleware.
 *
 * IMPORTANT DISTINCTION, and the reason this file is small:
 *
 *   `authenticate`  — who is this?
 *   `requirePermission` — may this ROLE perform this kind of action?
 *   ownership checks — may this USER touch THIS record?
 *
 * The third is NOT here. It lives in each service, because only the service
 * knows what ownership means for its resource. A route guarded solely by
 * `requirePermission('order:read_all')` and no ownership check is the classic
 * IDOR bug, so the two are deliberately kept separate rather than blurred into
 * one convenient middleware.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ErrorCode,
  Permission,
  UserRole,
  roleHasPermission,
  isAdminRole,
  isSellerRole,
} from '../shared';
import { AppError } from '../common/errors';
import { setRequestContextValues } from '../common/request-context';
import { verifyAccessToken } from '../modules/auth/token.service';

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

function attach(req: Request, token: string): void {
  const claims = verifyAccessToken(token);
  req.user = {
    id: claims.sub,
    // For a customer-app session this is CUSTOMER whatever the account's
    // role (token.service.ts), so every check below treats it as a shopper.
    role: claims.role,
    mobile: claims.mobile,
    sessionId: claims.sid,
    sessionScope: claims.scp === 'customer' ? 'customer' : 'full',
  };
  // Every subsequent log line in this request carries the user id.
  setRequestContextValues({ userId: claims.sub, role: claims.role });
}

/** Requires a valid access token. */
export const authenticate: RequestHandler = (req, _res, next) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, {
        internalMessage: 'missing or malformed Authorization header',
      });
    }
    attach(req, token);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Attaches the user when a valid token is present, and does nothing when it is
 * absent or invalid.
 *
 * Used on catalogue routes: browsing works logged-out, but a logged-in
 * customer gets their cart badge and personalised rails from the same call.
 */
export const optionalAuthenticate: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req);
  if (!token) return next();
  try {
    attach(req, token);
  } catch {
    // Deliberately swallowed: an expired token on a public endpoint should
    // render the logged-out view, not a 401.
  }
  next();
};

export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(
        new AppError(ErrorCode.UNAUTHENTICATED, {
          internalMessage: 'requirePermission used without authenticate',
        }),
      );
    }

    const granted = permissions.every((permission) =>
      roleHasPermission(req.user!.role, permission),
    );

    if (!granted) {
      return next(
        new AppError(ErrorCode.FORBIDDEN, {
          internalMessage: `role ${req.user.role} lacks ${permissions.join(', ')}`,
        }),
      );
    }

    next();
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(
        new AppError(ErrorCode.UNAUTHENTICATED, {
          internalMessage: 'requireRole used without authenticate',
        }),
      );
    }
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(ErrorCode.FORBIDDEN, {
          internalMessage: `role ${req.user.role} not in [${roles.join(', ')}]`,
        }),
      );
    }
    next();
  };
}

/** Any staff role — the coarse gate on the whole /admin namespace. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    return next(
      new AppError(ErrorCode.UNAUTHENTICATED, {
        internalMessage: 'requireAdmin used without authenticate',
      }),
    );
  }
  if (!isAdminRole(req.user.role)) {
    return next(
      new AppError(ErrorCode.FORBIDDEN, {
        internalMessage: `role ${req.user.role} is not an admin role`,
      }),
    );
  }
  next();
};

/** Any seller-panel role — the coarse gate on the whole /seller namespace.
 * Admin roles ALSO pass this (they have full cross-seller access, #26) — see
 * middleware/sellerAuth.ts's `attachSellerContext` for how the two then
 * differ in which seller they may actually act as. */
export const requireSellerOrAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    return next(
      new AppError(ErrorCode.UNAUTHENTICATED, {
        internalMessage: 'requireSellerOrAdmin used without authenticate',
      }),
    );
  }
  if (!isSellerRole(req.user.role) && !isAdminRole(req.user.role)) {
    return next(
      new AppError(ErrorCode.FORBIDDEN, {
        internalMessage: `role ${req.user.role} is not a seller or admin role`,
      }),
    );
  }
  next();
};

/**
 * Reads the authenticated user, throwing if absent.
 * Saves every controller writing `if (!req.user) throw ...` after a route that
 * already guarantees it.
 */
export function requireUser(req: Request): NonNullable<Request['user']> {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, {
      internalMessage: 'requireUser called on an unauthenticated request',
    });
  }
  return req.user;
}
