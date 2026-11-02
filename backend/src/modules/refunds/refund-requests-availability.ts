/**
 * Customer refund requests — TEMPORARILY SWITCHED OFF.
 *
 * While this is false:
 *   - POST /orders/:id/refund-requests and GET /refund-requests/:id answer
 *     403 REFUND_REQUESTS_DISABLED, before anything is read or uploaded;
 *   - the refunds summary for an order never offers a request
 *     (`request.eligible` false), and the service refuses one too;
 *   - the app shows no Refunds card or "Request a refund" (mobile
 *     lib/refunds.ts CUSTOMER_REFUNDS_ENABLED).
 *
 * Everything else is untouched: refund tables, migrations and records, the
 * admin refund screens and history, automatic refunds (a paid order
 * cancelled, a seller's rejection, a late payment), Cashfree refunds and
 * reconciliation. To bring customer requests back, set this to true (and
 * the app's flag) — nothing else was removed.
 */

import type { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';

export const CUSTOMER_REFUND_REQUESTS_ENABLED: boolean = false;

/** Express guard for the customer refund-request endpoints. */
export function refundRequestsAvailable(_req: Request, _res: Response, next: NextFunction): void {
  if (CUSTOMER_REFUND_REQUESTS_ENABLED) return next();
  next(
    new AppError(ErrorCode.REFUND_REQUESTS_DISABLED, {
      internalMessage: 'customer refund requests are switched off (refund-requests-availability.ts)',
    }),
  );
}
