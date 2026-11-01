/**
 * Admin refund management — refund groups (and, later in this module,
 * refund requests and manual COD payouts). Every route requires
 * ORDER_REFUND: ADMIN and SUPER_ADMIN only; STAFF never moves money.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PAGINATION_MAX_LIMIT, Permission } from '../../shared';
import { ManualPayoutMethod, RefundGroupChannel, RefundGroupOrigin, RefundGroupStatus, RefundRequestStatus } from '@prisma/client';
import { asyncHandler, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import * as paymentService from '../payments/payment.service';
import * as requestService from './admin-refund.service';
import { listSellerDeductions, outstandingDeductionsPaise } from '../sellers/seller-deduction.service';

const idParams = z.object({ id: z.string().uuid() });

export const adminRefundRouter: Router = Router();

/**
 * Retries the parts of a refund that DEFINITIVELY failed — each only after
 * Cashfree confirms no refund exists for the failed attempt. Completed and
 * uncertain parts are never retried; what was skipped is reported, with why.
 */
adminRefundRouter.post(
  '/refund-groups/:id/retry',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await paymentService.retryFailedRefundComponents(req.params['id'] as string, requireUser(req).id));
  }),
);

/**
 * Our record says FAILED but the money went back: re-reads the refund from
 * Cashfree directly and, only if Cashfree reports it SUCCESSFUL, records it
 * completed with an immutable correction record. Never sends a refund.
 */
adminRefundRouter.post(
  '/refunds/:id/correct-from-cashfree',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await paymentService.correctFailedRefund(req.params['id'] as string, requireUser(req).id));
  }),
);

/** Re-reads the in-flight parts of a refund from Cashfree now. */
adminRefundRouter.post(
  '/refund-groups/:id/reconcile',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await paymentService.reconcileRefundGroup(req.params['id'] as string));
  }),
);

/* -------------------------------------------------------------------------- */
/* Refund requests                                                            */
/* -------------------------------------------------------------------------- */

adminRefundRouter.get(
  '/refund-requests',
  requirePermission(Permission.ORDER_REFUND),
  validate({
    query: z.object({
      status: z.nativeEnum(RefundRequestStatus).optional(),
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(25),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{ status?: RefundRequestStatus; cursor?: string; limit: number }>(req);
    ok(res, await requestService.listRefundRequests({ status: query.status, cursor: query.cursor ?? null, limit: query.limit }));
  }),
);

adminRefundRouter.get(
  '/refund-requests/:id',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await requestService.getRefundRequestDetail(req.params['id'] as string));
  }),
);

/** One evidence photo — streamed after the permission check, never cached, audited. */
adminRefundRouter.get(
  '/refund-requests/:id/evidence/:evidenceId',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: z.object({ id: z.string().uuid(), evidenceId: z.string().uuid() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const photo = await requestService.readEvidence(req.params['id'] as string, req.params['evidenceId'] as string, requireUser(req).id);
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.status(200).send(photo.bytes);
  }),
);

const decisionNote = z.string().trim().min(5, 'Write a short note for the decision.').max(500);

/** Approve all that is still approvable, or a lower amount (never more than requested). */
adminRefundRouter.post(
  '/refund-requests/:id/approve',
  requirePermission(Permission.ORDER_REFUND),
  validate({
    params: idParams,
    body: z.object({ approvedPaise: z.number().int().positive().optional(), decisionNote }).strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { approvedPaise?: number; decisionNote: string };
    ok(res, await requestService.approveRefundRequest(req.params['id'] as string, requireUser(req).id, body));
  }),
);

adminRefundRouter.post(
  '/refund-requests/:id/reject',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: idParams, body: z.object({ decisionNote }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { decisionNote: string };
    ok(res, await requestService.rejectRefundRequest(req.params['id'] as string, requireUser(req).id, body.decisionNote));
  }),
);

/* -------------------------------------------------------------------------- */
/* Seller deductions                                                          */
/* -------------------------------------------------------------------------- */

/** A seller's deductions (refunds after delivery): outstanding, applied, and to which settlement. */
adminRefundRouter.get(
  '/sellers/:id/deductions',
  requirePermission(Permission.SETTLEMENT_READ),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const sellerId = req.params['id'] as string;
    ok(res, { outstandingPaise: await outstandingDeductionsPaise(sellerId), items: await listSellerDeductions(sellerId) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Refund groups — dashboard                                                  */
/* -------------------------------------------------------------------------- */

adminRefundRouter.get(
  '/refund-overview',
  requirePermission(Permission.ORDER_REFUND),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await requestService.refundOverview());
  }),
);

adminRefundRouter.get(
  '/refund-groups',
  requirePermission(Permission.ORDER_REFUND),
  validate({
    query: z.object({
      status: z.nativeEnum(RefundGroupStatus).optional(),
      channel: z.nativeEnum(RefundGroupChannel).optional(),
      origin: z.nativeEnum(RefundGroupOrigin).optional(),
      orderNumber: z.string().trim().min(2).max(40).optional(),
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(25),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{
      status?: RefundGroupStatus;
      channel?: RefundGroupChannel;
      origin?: RefundGroupOrigin;
      orderNumber?: string;
      cursor?: string;
      limit: number;
    }>(req);
    ok(res, await requestService.listRefundGroups({ ...query, cursor: query.cursor ?? null }));
  }),
);

/** Seller-wise components, Cashfree ids, failures, retry history, deductions, COD payout, audit. */
adminRefundRouter.get(
  '/refund-groups/:id',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await requestService.getRefundGroupDetail(req.params['id'] as string));
  }),
);

/* -------------------------------------------------------------------------- */
/* Cash on Delivery — manual payouts (never Cashfree)                          */
/* -------------------------------------------------------------------------- */

/** Step 1: record the UPI / bank transfer made. The refund is NOT successful yet. */
adminRefundRouter.post(
  '/refund-groups/:id/cod-payout',
  requirePermission(Permission.ORDER_REFUND),
  validate({
    params: idParams,
    body: z
      .object({
        method: z.nativeEnum(ManualPayoutMethod),
        reference: z
          .string()
          .trim()
          .min(6, 'Enter the UPI transaction id or bank UTR.')
          .max(120)
          // Spaces and separators are allowed as typed; duplicates are compared
          // on letters and digits only (admin-refund.service.ts › normalizeReference).
          .regex(/^[A-Za-z0-9][A-Za-z0-9 \-_/.]*$/, 'Use the transaction id exactly as the bank / UPI app shows it.'),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        proofNote: z.string().trim().max(300).nullable().optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { method: ManualPayoutMethod; reference: string; paidOn: string; proofNote?: string | null };
    ok(res, await requestService.recordManualPayout(req.params['id'] as string, requireUser(req).id, body));
  }),
);

/** Step 2: confirm the transfer reached the customer — only now is the refund SUCCESS. */
adminRefundRouter.post(
  '/refund-groups/:id/cod-payout/confirm',
  requirePermission(Permission.ORDER_REFUND),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await requestService.confirmManualPayout(req.params['id'] as string, requireUser(req).id));
  }),
);
