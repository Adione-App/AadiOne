/**
 * Admin review of seller-submitted product approval batches — cross-seller
 * (#26), mirroring admin-order.routes.ts's own seller-orders section: the
 * same service module as the seller-facing routes, called with
 * `scopeSellerId: undefined`.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApprovalStatus, Permission } from '../../shared';
import { asyncHandler, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import * as service from './product-approval.service';

const uuid = z.string().uuid();

const reviewItemSchema = z
  .object({
    status: z.enum([ApprovalStatus.APPROVED, ApprovalStatus.REJECTED]),
    reviewNote: z.string().trim().max(400).nullable().optional(),
  })
  .refine((v) => v.status !== ApprovalStatus.REJECTED || !!v.reviewNote?.trim(), {
    message: 'A reason is required when rejecting.',
    path: ['reviewNote'],
  });

export const adminProductApprovalRouter: Router = Router();

adminProductApprovalRouter.get(
  '/approval-batches',
  requirePermission(Permission.PRODUCT_APPROVAL_REVIEW),
  validate({
    query: z.object({
      /** Optional FILTER to one seller's batches (admin sees every seller's,
       * #26) — an unknown seller simply matches nothing. */
      sellerId: uuid.optional(),
      status: z.nativeEnum(ApprovalStatus).optional(),
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().int().positive().max(100).default(25),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{ sellerId?: string; status?: ApprovalStatus; cursor?: string; limit: number }>(req);
    okCursorPage(
      res,
      // The service's seller scope doubles as the filter: same query as the
      // seller panel's own "my submissions" list, just for any seller.
      await service.listApprovalBatches(query.sellerId, {
        ...(query.status ? { status: query.status } : {}),
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
  }),
);

adminProductApprovalRouter.get(
  '/approval-batches/:id',
  requirePermission(Permission.PRODUCT_APPROVAL_REVIEW),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getApprovalBatchReviewDetail(req.params['id'] as string));
  }),
);

adminProductApprovalRouter.post(
  '/approval-batches/:id/items',
  requirePermission(Permission.PRODUCT_APPROVAL_REVIEW),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ productId: uuid }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { productId } = req.body as { productId: string };
    ok(
      res,
      await service.addItemToBatch(req.params['id'] as string, productId, requireUser(req).id),
    );
  }),
);

adminProductApprovalRouter.patch(
  '/approval-batches/:id/items/:itemId',
  requirePermission(Permission.PRODUCT_APPROVAL_REVIEW),
  validate({
    params: z.object({ id: uuid, itemId: uuid }),
    body: reviewItemSchema,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { status: ApprovalStatus; reviewNote?: string | null };
    ok(
      res,
      await service.reviewBatchItem({
        batchId: req.params['id'] as string,
        itemId: req.params['itemId'] as string,
        status: body.status,
        reviewNote: body.reviewNote ?? null,
        actorUserId: requireUser(req).id,
      }),
    );
  }),
);
