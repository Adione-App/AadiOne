/**
 * Customer refund endpoints.
 *
 *   GET  /orders/:id/refunds          the order's refunds, consolidated
 *   POST /orders/:id/refund-requests  ask for a refund (multipart; photos)
 *   GET  /refund-requests/:id         one of the customer's own requests
 *
 * Ownership is enforced in the service (someone else's order or request is
 * a plain 404). The amount is never read from the request.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ErrorCode, Permission, RefundRequestCategory } from '../../shared';
import { AppError } from '../../common/errors';
import { asyncHandler, created, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { authenticate, requirePermission, requireUser } from '../../middleware/auth';
import { evidenceUpload } from '../../middleware/evidenceUpload';
import * as service from './customer-refund.service';

const idParams = z.object({ id: z.string().uuid() });

const requestFields = z.object({
  category: z.nativeEnum(RefundRequestCategory),
  description: z.string().trim().min(10, 'Tell us a little more about the problem.').max(1000),
  items: z
    .array(z.object({ orderItemId: z.string().uuid(), qty: z.number().int().min(1).max(999) }).strict())
    .min(1, 'Choose at least one item.')
    .max(50),
});

/** Added to the customer order router (order.routes.ts), after its `authenticate`. */
export function registerOrderRefundRoutes(router: Router): void {
  router.get(
    '/:id/refunds',
    requirePermission(Permission.ORDER_READ_OWN),
    validate({ params: idParams }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await service.listOrderRefunds(requireUser(req).id, req.params['id'] as string));
    }),
  );

  router.post(
    '/:id/refund-requests',
    requirePermission(Permission.ORDER_CANCEL_OWN),
    validate({ params: idParams }),
    evidenceUpload,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      let items: unknown;
      try {
        items = typeof body['items'] === 'string' ? JSON.parse(body['items']) : body['items'];
      } catch {
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose at least one item.' });
      }
      // Any amount the client may have sent is simply never read.
      const parsed = requestFields.safeParse({ category: body['category'], description: body['description'], items });
      if (!parsed.success) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message: parsed.error.issues[0]?.message ?? 'Check the refund request and try again.' });
      }
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      created(
        res,
        await service.createRefundRequest(
          requireUser(req).id,
          req.params['id'] as string,
          parsed.data,
          files.map((f) => ({ buffer: f.buffer, size: f.size })),
        ),
      );
    }),
  );
}

export const customerRefundRequestRouter: Router = Router();
customerRefundRequestRouter.use(authenticate);

customerRefundRequestRouter.get(
  '/:id',
  requirePermission(Permission.ORDER_READ_OWN),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getRefundRequest(requireUser(req).id, req.params['id'] as string));
  }),
);
