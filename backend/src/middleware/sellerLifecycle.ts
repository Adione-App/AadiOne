/**
 * Seller lifecycle gate — runs on EVERY /seller request, before any seller
 * router (routes/index.ts).
 *
 * `requirePermission` says what a ROLE may do and `attachSellerContext` which
 * seller the caller acts as; this says whether that SELLER has passed both
 * onboarding gates. A seller that has only applied, or is still onboarding,
 * or is under review, gets its status/onboarding endpoints and nothing else —
 * see `sellerPanelAccess` (seller-lifecycle-rules.ts) for the exact table.
 * The React route guards mirror this, but this is the enforcement.
 *
 * Admin roles are not lifecycle-gated: they act on any seller through
 * `:sellerId` routes, exactly as before — with one hard exception: a seller's
 * onboarding data (profile, bank, documents, restaurant details, store
 * location, submission) is the seller's own. Admin views and reviews it but
 * can never write it, so every onboarding write here is refused for admin
 * roles (`isSellerOnboardingWrite`), whatever permissions the role holds.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode, isAdminRole, type SellerLifecycleStatus } from '../shared';
import { AppError } from '../common/errors';
import { prisma } from '../infra/db/prisma';
import { isSellerOnboardingWrite, sellerPanelAccess } from '../modules/sellers/seller-lifecycle-rules';
import { resolveOwnSellerId } from './sellerAuth';

const DENIAL_MESSAGE: Record<'NOT_ACTIVE' | 'UNDER_REVIEW' | 'NO_ONBOARDING', string> = {
  NOT_ACTIVE: 'Your seller account is not active yet. Complete your seller onboarding to use this.',
  UNDER_REVIEW: 'Your onboarding is under review — it cannot be changed until Aadione finishes the review.',
  NO_ONBOARDING: 'Your seller application has not been approved yet.',
};

export const requireSellerLifecycleAccess: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!req.user) {
        throw new AppError(ErrorCode.UNAUTHENTICATED, {
          internalMessage: 'requireSellerLifecycleAccess used without authenticate',
        });
      }
      if (isAdminRole(req.user.role)) {
        if (isSellerOnboardingWrite(req.method, req.path)) {
          throw new AppError(ErrorCode.FORBIDDEN, {
            message: 'Seller onboarding details can only be changed by the seller. Admin can review them and request changes.',
            internalMessage: `admin ${req.user.id} (${req.user.role}) tried ${req.method} /seller${req.path}`,
          });
        }
        next();
        return;
      }

      const sellerId = await resolveOwnSellerId(req);
      const seller = await prisma.seller.findFirst({
        where: { id: sellerId, deletedAt: null },
        select: { lifecycleStatus: true },
      });
      if (!seller) {
        throw new AppError(ErrorCode.FORBIDDEN, {
          message: 'Your account is not linked to a seller.',
          internalMessage: `seller ${sellerId} of user ${req.user.id} is missing or deleted`,
        });
      }

      const access = sellerPanelAccess(seller.lifecycleStatus as SellerLifecycleStatus, req.method, req.path);
      if (!access.allowed) {
        throw new AppError(ErrorCode.SELLER_ACCOUNT_NOT_ACTIVE, {
          message: DENIAL_MESSAGE[access.reason],
          internalMessage: `seller ${sellerId} (${seller.lifecycleStatus}) denied ${req.method} ${req.path}: ${access.reason}`,
        });
      }

      req.sellerId = sellerId;
      next();
    } catch (error) {
      next(error);
    }
  })();
};
