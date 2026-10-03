/**
 * Seller-scoped authorization (V2).
 *
 * IMPORTANT DISTINCTION, same split as middleware/auth.ts:
 *
 *   `requirePermission(SELLER_ORDER_*)` — may this ROLE perform this kind of
 *     action at all?
 *   `attachSellerContext` (this file) — WHICH seller may this specific
 *     request act as?
 *
 * Every seller-panel service function reads `req.sellerId` (never a
 * client-supplied `sellerId` in the body/params) when scoping its query —
 * that is what makes "one seller can never read/update another seller's
 * data" (#15/#27) a property of the request pipeline, not a convention.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode, isAdminRole } from '../shared';
import { AppError } from '../common/errors';
import { prisma } from '../infra/db/prisma';

/**
 * Resolves which seller the caller may act as and attaches it to
 * `req.sellerId`.
 *
 * Admin roles bypass the SellerStaff lookup entirely and may act as ANY
 * seller — they supply `:sellerId` as a route param instead (see the admin
 * mount of seller-order routes). A seller role always gets the seller(s)
 * their OWN `SellerStaff` row says they belong to; a client-supplied
 * `sellerId` from a seller-role caller is never consulted.
 *
 * A user staffing more than one seller (SellerStaff supports it, and
 * admin-seller-management.service's `createSeller` already allows adding an
 * existing seller owner/manager as another seller's owner — this is
 * reachable today, not hypothetical) is NOT resolved by picking whichever
 * row a query happens to return first: with no `ORDER BY`, Postgres does not
 * guarantee row order, so that pick could silently change between requests
 * and leak one seller's data into a request the caller intended for another
 * (#15/#27). Instead:
 *   - exactly one active membership -> used automatically (the common case,
 *     and every caller today, is unaffected);
 *   - more than one -> the caller MUST disambiguate with an `X-Seller-Id`
 *     header naming one of their own memberships, or the request is
 *     rejected. No seller-switching endpoint or session state exists (or is
 *     needed) for this — a header is the smallest thing that lets a future
 *     seller-panel client pick one explicitly, and nothing today sends
 *     multiple memberships for the same user through this path yet.
 */
export const attachSellerContext: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!req.user) {
        throw new AppError(ErrorCode.UNAUTHENTICATED, {
          internalMessage: 'attachSellerContext used without authenticate',
        });
      }

      if (isAdminRole(req.user.role)) {
        const paramSellerId = req.params['sellerId'];
        if (typeof paramSellerId === 'string') req.sellerId = paramSellerId;
        next();
        return;
      }

      // Already resolved for this request by the lifecycle gate
      // (middleware/sellerLifecycle.ts) — same lookup, same answer.
      if (!req.sellerId) req.sellerId = await resolveOwnSellerId(req);
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * The seller a seller-role caller acts as — from their OWN active SellerStaff
 * rows only (see `attachSellerContext` for the multi-membership rule).
 */
export async function resolveOwnSellerId(req: Request): Promise<string> {
  const user = req.user;
  if (!user) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, { internalMessage: 'resolveOwnSellerId without authenticate' });
  }

  const memberships = await prisma.sellerStaff.findMany({
    where: { userId: user.id, isActive: true },
    select: { sellerId: true },
    orderBy: { createdAt: 'asc' },
  });

  if (memberships.length === 0) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: 'Your account is not linked to a seller.',
      internalMessage: `user ${user.id} has no active SellerStaff row`,
    });
  }

  if (memberships.length === 1) return memberships[0]!.sellerId;

  const requestedSellerId = req.header('x-seller-id');
  const match = memberships.find((m) => m.sellerId === requestedSellerId);

  if (!match) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This account manages multiple sellers — specify which one with the X-Seller-Id header.',
      internalMessage: `user ${user.id} staffs ${memberships.length} sellers; X-Seller-Id was ${JSON.stringify(requestedSellerId)}`,
    });
  }

  return match.sellerId;
}

/** Reads `req.sellerId`, throwing if `attachSellerContext` never ran (or an
 * admin request never supplied `:sellerId`). Saves every controller writing
 * the same guard. */
export function requireSellerId(req: Request): string {
  if (!req.sellerId) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: 'No seller context for this request.',
      internalMessage: 'requireSellerId called without a resolved sellerId',
    });
  }
  return req.sellerId;
}
