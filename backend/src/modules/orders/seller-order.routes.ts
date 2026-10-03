/**
 * Seller panel — a seller's own orders. Mounted at `/seller`.
 *
 * `attachSellerContext` resolves `req.sellerId` from the caller's own
 * `SellerStaff` row (or, for an admin caller, an explicit `?sellerId=`) —
 * every query below is scoped to it, never to anything the client sends
 * directly (#15/#27).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ActorType, PAGINATION_MAX_LIMIT, Permission, SellerOrderStatus, UserRole } from '../../shared';
import { asyncHandler, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './seller-order.service';
import type { ListSellerOrdersOptions } from './seller-order.service';
import { SELLER_ORDER_STAGES } from './seller-order-views';

const uuid = z.string().uuid();

export const sellerOrderRouter: Router = Router();

sellerOrderRouter.use(attachSellerContext);

const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.');

sellerOrderRouter.get(
  '/orders',
  requirePermission(Permission.SELLER_ORDER_READ_OWN),
  validate({
    query: z
      .object({
        status: z.nativeEnum(SellerOrderStatus).optional(),
        stage: z.enum(SELLER_ORDER_STAGES).optional(),
        q: z.string().trim().min(1).max(40).optional(),
        orderId: uuid.optional(),
        from: calendarDay.optional(),
        to: calendarDay.optional(),
        cursor: z.string().datetime().optional(),
        limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(25),
      })
      .refine((query) => !query.from || !query.to || query.from <= query.to, {
        message: 'The start date must be on or before the end date.',
        path: ['from'],
      }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<Omit<ListSellerOrdersOptions, 'cursor' | 'sellerId'> & { cursor?: string }>(req);
    okCursorPage(
      res,
      // `req.sellerId` is always set for a seller-role caller (attachSellerContext
      // throws otherwise); for an admin caller without `:sellerId` it's
      // undefined, giving the unrestricted cross-seller view (#26). Every
      // filter below narrows that scope — none widens it.
      await service.listSellerOrders(req.sellerId, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.stage ? { stage: query.stage } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
  }),
);

/** Dashboard order numbers. Seller callers only — no cross-seller view. */
sellerOrderRouter.get(
  '/orders/summary',
  requirePermission(Permission.SELLER_ORDER_READ_OWN),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getSellerOrderSummary(requireSellerId(req)));
  }),
);

sellerOrderRouter.get(
  '/orders/:id',
  requirePermission(Permission.SELLER_ORDER_READ_OWN),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getSellerOrderDetail(req.params['id'] as string, req.sellerId));
  }),
);

sellerOrderRouter.patch(
  '/orders/:id/status',
  requirePermission(Permission.SELLER_ORDER_UPDATE_STATUS),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      toStatus: z.nativeEnum(SellerOrderStatus),
      reason: z.string().trim().max(300).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { toStatus: SellerOrderStatus; reason?: string };
    const user = requireUser(req);
    await service.updateSellerOrderStatus({
      sellerOrderId: req.params['id'] as string,
      scopeSellerId: req.sellerId,
      toStatus: body.toStatus,
      actorUserId: user.id,
      actorType: user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN || user.role === UserRole.STAFF
        ? ActorType.ADMIN
        : ActorType.SELLER,
      reason: body.reason ?? null,
    });
    ok(res, { updated: true });
  }),
);
