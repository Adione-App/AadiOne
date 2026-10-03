import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { Permission } from "../../shared";
import { asyncHandler, ok } from "../../common/response";
import { validate } from "../../middleware/validate";
import {
  authenticate,
  requirePermission,
  requireUser,
} from "../../middleware/auth";
import { idempotency } from "../../middleware/idempotency";
import { prisma } from "../../infra/db/prisma";
import * as service from "./payment.service";

const uuid = z.string().uuid();

export const paymentRouter: Router = Router();

/**
 * POST /payments/webhook
 *
 * PUBLIC and unauthenticated.
 *
 * The PSP has no auth token, so webhook authenticity must be verified
 * using the HMAC over the RAW request body.
 *
 * express.raw() is mounted for this path in app.ts before the JSON parser.
 */
paymentRouter.post(
  "/webhook",
  asyncHandler(async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));

    ok(
      res,
      await service.handleWebhook(
        rawBody,
        req.headers as Record<string, string>,
      ),
    );
  }),
);

/**
 * All authenticated customer payment routes below this point require
 * ORDER_CREATE permission.
 */
paymentRouter.use(authenticate, requirePermission(Permission.ORDER_CREATE));

/**
 * POST /payments/create
 *
 * Idempotent:
 * A double tap on "Pay" must not create multiple payment intents.
 */
paymentRouter.post(
  "/create",
  validate({
    body: z.object({
      orderId: uuid,
    }),
  }),
  idempotency("POST /payments/create"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orderId } = req.body as {
      orderId: string;
    };

    ok(res, await service.createPayment(requireUser(req).id, orderId));
  }),
);

/**
 * POST /payments/verify
 *
 * Provider verification route.
 */
paymentRouter.post(
  "/verify",
  validate({
    body: z.object({
      orderId: uuid,
      providerOrderId: z.string().min(4).max(120),
      providerPaymentId: z.string().min(4).max(120),
      signature: z.string().min(16).max(512),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.verifyPayment(requireUser(req).id, req.body));
  }),
);

/**
 * POST /payments/claim
 *
 * The customer says they paid by UPI.
 *
 * IMPORTANT:
 * This only records the customer's claim.
 * It does NOT mark the payment as paid.
 *
 * The store/admin must independently verify the merchant UPI/bank
 * transaction before confirming payment.
 */
paymentRouter.post(
  "/claim",
  validate({
    body: z.object({
      orderId: uuid,

      /*
       * UTR / RRN from the customer's UPI receipt.
       *
       * Optional because the customer may not have the reference number.
       */
      utr: z
        .string()
        .trim()
        .regex(/^\d{12}$/, "The UPI reference number is 12 digits")
        .nullable()
        .optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      orderId: string;
      utr?: string | null;
    };

    ok(res, await service.claimUpiPayment(requireUser(req).id, body));
  }),
);

/**
 * POST /payments/:orderId/refresh
 *
 * Hosted checkout (Cashfree): the app calls this when the gateway sheet
 * closes, whatever the SDK callback said. The server asks the gateway itself
 * and settles only on its answer — the callback is never trusted. Scoped to
 * the caller's own order (404 otherwise).
 */
paymentRouter.post(
  "/:orderId/refresh",
  validate({
    params: z.object({
      orderId: uuid,
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await service.refreshPayment(
        requireUser(req).id,
        req.params["orderId"] as string,
      ),
    );
  }),
);

/**
 * GET /payments/:orderId/status
 *
 * Returns the customer's current payment/order status.
 */
paymentRouter.get(
  "/:orderId/status",
  validate({
    params: z.object({
      orderId: uuid,
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const user = requireUser(req);

    const order = await prisma.order.findFirst({
      where: {
        id: req.params["orderId"] as string,
        userId: user.id,
      },
      select: {
        status: true,
        paymentStatus: true,
        totalPaise: true,
      },
    });

    ok(res, order ?? null);
  }),
);
