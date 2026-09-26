import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { OrderStatus, PaymentMethod, Permission, PAGINATION_MAX_LIMIT } from '../../shared';
import { asyncHandler, created, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { authenticate, requirePermission, requireUser } from '../../middleware/auth';
import { orderCreationPerUser } from '../../middleware/rateLimit';
import { idempotency } from '../../middleware/idempotency';
import * as service from './order.service';

const uuid = z.string().uuid();

export const checkoutRouter: Router = Router();
export const orderRouter: Router = Router();

/* -------------------------------------------------------------------------- */
/* Checkout                                                                   */
/* -------------------------------------------------------------------------- */

checkoutRouter.use(authenticate, requirePermission(Permission.ORDER_CREATE));

/**
 * POST /checkout/quote
 *
 * Side-effect-free preview running the SAME pricing engine as order creation.
 * It exists so the Review screen renders the server's bill — the app never
 * computes a total.
 */
checkoutRouter.post(
  '/quote',
  validate({
    body: z.object({
      addressId: uuid,
      couponCode: z.string().trim().min(2).max(40).nullable().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { addressId, couponCode } = req.body as {
      addressId: string;
      couponCode?: string | null;
    };
    ok(res, await service.getCheckoutQuote(requireUser(req).id, addressId, couponCode));
  }),
);

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

orderRouter.use(authenticate);

/**
 * POST /orders
 *
 * Order of middleware is deliberate:
 *   authenticate → permission → rate limit → validate → idempotency
 *
 * Idempotency runs LAST so a rejected or malformed request never consumes the
 * key — the customer must be able to fix the problem and retry with the same
 * key rather than being told the key is used.
 */
orderRouter.post(
  '/',
  requirePermission(Permission.ORDER_CREATE),
  orderCreationPerUser,
  validate({
    body: z.object({
      addressId: uuid,
      paymentMethod: z.nativeEnum(PaymentMethod),
      couponCode: z.string().trim().min(2).max(40).nullable().optional(),
      notes: z.string().trim().max(500).nullable().optional(),
      // A safety check only. Never used as the charged amount.
      expectedTotalPaise: z.number().int().min(0).optional(),
      // Same safety-check role, per item — see PlaceOrderRequest's own
      // comment in shared/dto.ts for why this is what lets PRICE_CHANGED
      // name which product changed instead of only "the total didn't
      // match".
      expectedItems: z
        .array(
          z.object({
            variantId: uuid,
            unitPricePaise: z.number().int().min(0),
          }),
        )
        .optional(),
    }),
  }),
  idempotency('POST /orders'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);
    const body = req.body as {
      addressId: string;
      paymentMethod: PaymentMethod;
      couponCode?: string | null;
      notes?: string | null;
      expectedTotalPaise?: number;
      expectedItems?: { variantId: string; unitPricePaise: number }[];
    };

    const result = await service.placeOrder({
      userId: user.id,
      addressId: body.addressId,
      paymentMethod: body.paymentMethod,
      couponCode: body.couponCode ?? null,
      notes: body.notes ?? null,
      expectedTotalPaise: body.expectedTotalPaise,
      expectedItems: body.expectedItems,
      idempotencyKey: req.idempotencyKey as string,
    });

    created(res, result);
  }),
);

orderRouter.get(
  '/',
  requirePermission(Permission.ORDER_READ_OWN),
  validate({
    query: z.object({
      status: z.nativeEnum(OrderStatus).optional(),
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(20),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{ status?: OrderStatus; cursor?: string; limit: number }>(req);
    okCursorPage(
      res,
      await service.listOrders(requireUser(req).id, {
        ...(query.status ? { status: query.status } : {}),
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
  }),
);

orderRouter.get(
  '/:id',
  requirePermission(Permission.ORDER_READ_OWN),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    // Ownership is enforced in the service, not by the route guard.
    ok(res, await service.getOrderDetail(requireUser(req).id, req.params['id'] as string));
  }),
);

orderRouter.post(
  '/:id/cancel',
  requirePermission(Permission.ORDER_CANCEL_OWN),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ reason: z.string().trim().min(2).max(300) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { reason } = req.body as { reason: string };
    ok(
      res,
      await service.cancelOrder(requireUser(req).id, req.params['id'] as string, reason),
    );
  }),
);
