/** Admin order board, delivery management and configuration endpoints. */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  AdminOrderTab,
  ConfigKey,
  OrderStatus,
  PAGINATION_MAX_LIMIT,
  Permission,
} from "../../shared";
import {
  asyncHandler,
  created,
  noContent,
  ok,
  okCursorPage,
} from "../../common/response";
import { validate, validatedQuery } from "../../middleware/validate";
import { requirePermission, requireUser } from "../../middleware/auth";
import { normalizeIndianMobile } from "../../shared/phone";
import * as storeService from "../stores/store.service";
import * as configService from "../configuration/configuration.service";
import * as deliveryService from "../delivery/delivery.service";
import * as paymentService from "../payments/payment.service";
import * as service from "./admin-order.service";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
/** "YYYY-MM-DD" — the admin dashboard's date picker sends this, unparsed. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const adminOrderRouter: Router = Router();

/* dashboard ---------------------------------------------------------------- */

adminOrderRouter.get(
  "/dashboard",
  requirePermission(Permission.DASHBOARD_READ),
  validate({
    query: z.object({
      date: calendarDate.optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{ date?: string }>(req);
    ok(res, await service.getDashboard(query.date));
  }),
);

/* orders ------------------------------------------------------------------- */

adminOrderRouter.get(
  "/orders",
  requirePermission(Permission.ORDER_READ_ALL),
  validate({
    query: z.object({
      tab: z.nativeEnum(AdminOrderTab).optional(),
      search: z.string().trim().max(60).optional(),
      cursor: z.string().datetime().optional(),
      date: calendarDate.optional(),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .max(PAGINATION_MAX_LIMIT)
        .default(25),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{
      tab?: AdminOrderTab;
      search?: string;
      cursor?: string;
      date?: string;
      limit: number;
    }>(req);
    okCursorPage(
      res,
      await service.listOrders({
        ...(query.tab ? { tab: query.tab } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.date ? { date: query.date } : {}),
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
  }),
);

adminOrderRouter.get(
  "/orders/:id",
  requirePermission(Permission.ORDER_READ_ALL),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getOrderForAdmin(req.params["id"] as string));
  }),
);

adminOrderRouter.patch(
  "/orders/:id/status",
  requirePermission(Permission.ORDER_UPDATE_STATUS),
  validate({
    params: idParams,
    body: z.object({
      toStatus: z.nativeEnum(OrderStatus),
      reason: z.string().trim().max(300).optional(),
      deliveryOtp: z
        .string()
        .trim()
        .regex(/^\d{4}$/)
        .optional(),
      cashCollectedPaise: z.number().int().min(0).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      toStatus: OrderStatus;
      reason?: string;
      deliveryOtp?: string;
      cashCollectedPaise?: number;
    };
    await service.updateOrderStatus({
      orderId: req.params["id"] as string,
      toStatus: body.toStatus,
      actorUserId: requireUser(req).id,
      reason: body.reason ?? null,
      cashCollectedPaise: body.cashCollectedPaise ?? null,
    });
    noContent(res);
  }),
);

adminOrderRouter.post(
  "/orders/:id/assign",
  requirePermission(Permission.DELIVERY_ASSIGN),
  validate({ params: idParams, body: z.object({ agentId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.body as { agentId: string };
    ok(
      res,
      await deliveryService.assignOrder(
        req.params["id"] as string,
        agentId,
        requireUser(req).id,
      ),
    );
  }),
);

/**
 * POST /admin/orders/:id/confirm-payment
 *
 * The store has seen the money in its UPI app. This is the verification step
 * for direct-UPI orders — deliberately admin-only, so nothing a customer sends
 * can reach it.
 */
adminOrderRouter.post(
  "/orders/:id/confirm-payment",
  requirePermission(Permission.ORDER_UPDATE_STATUS),
  validate({
    params: idParams,
    body: z.object({
      reference: z.string().trim().max(32).nullable().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { reference } = req.body as {
      reference?: string | null;
    };

    await paymentService.confirmPaymentManually(
      req.params["id"] as string,
      requireUser(req).id,
      reference ?? null,
    );

    noContent(res);
  }),
);

adminOrderRouter.post(
  "/orders/:id/refund",
  requirePermission(Permission.ORDER_REFUND),
  validate({
    params: idParams,
    body: z.object({ reason: z.string().trim().min(2).max(300) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { reason } = req.body as { reason: string };
    ok(
      res,
      await paymentService.refundOrder(
        req.params["id"] as string,
        reason,
        requireUser(req).id,
      ),
    );
  }),
);

/* delivery agents ---------------------------------------------------------- */

const agentBody = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const normalized = normalizeIndianMobile(value);
      if (!normalized) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Enter a valid mobile number",
        });
        return z.NEVER;
      }
      return normalized;
    }),
  vehicleNumber: z.string().trim().max(20).nullable().optional(),
});

adminOrderRouter.get(
  "/delivery-agents",
  requirePermission(Permission.DELIVERY_AGENT_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    const store = await storeService.getActiveStore();
    ok(res, await deliveryService.listAgents(store.id));
  }),
);

adminOrderRouter.post(
  "/delivery-agents",
  requirePermission(Permission.DELIVERY_AGENT_WRITE),
  validate({ body: agentBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const store = await storeService.getActiveStore();
    created(res, await deliveryService.createAgent(store.id, req.body));
  }),
);

/**
 * POST /admin/orders/:id/reject-payment
 *
 * Admin explicitly determines that a UPI payment was not received.
 *
 * This is different from "Keep Pending":
 * - Keep Pending performs no state change.
 * - Reject Payment deliberately moves the order to PAYMENT_FAILED.
 */
adminOrderRouter.post(
  "/orders/:id/reject-payment",
  requirePermission(Permission.ORDER_UPDATE_STATUS),
  validate({
    params: idParams,
    body: z.object({
      reason: z.string().trim().min(2).max(300),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { reason } = req.body as {
      reason: string;
    };

    await paymentService.rejectManualUpiPayment(
      req.params["id"] as string,
      requireUser(req).id,
      reason,
    );

    noContent(res);
  }),
);

adminOrderRouter.patch(
  "/delivery-agents/:id",
  requirePermission(Permission.DELIVERY_AGENT_WRITE),
  validate({
    params: idParams,
    body: agentBody.partial().extend({
      isActive: z.boolean().optional(),
      isAvailable: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    await deliveryService.updateAgent(req.params["id"] as string, req.body);
    noContent(res);
  }),
);

adminOrderRouter.delete(
  "/delivery-agents/:id",
  requirePermission(Permission.DELIVERY_AGENT_WRITE),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    await deliveryService.deleteAgent(req.params["id"] as string);
    noContent(res);
  }),
);

adminOrderRouter.get(
  "/delivery/cash-summary",
  requirePermission(Permission.DELIVERY_AGENT_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const store = await storeService.getActiveStore();
    const from = req.query["from"]
      ? new Date(String(req.query["from"]))
      : new Date(Date.now() - 86_400_000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();
    ok(res, await deliveryService.cashSummary(store.id, from, to));
  }),
);

/* configuration (Task 13.6) ------------------------------------------------ */

adminOrderRouter.get(
  "/config",
  requirePermission(Permission.CONFIG_READ),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await configService.listForAdmin());
  }),
);

adminOrderRouter.patch(
  "/config",
  requirePermission(Permission.CONFIG_WRITE),
  validate({
    body: z.object({
      key: z.nativeEnum(ConfigKey),
      value: z.unknown(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { key, value } = req.body as { key: ConfigKey; value: never };
    // The service validates the VALUE per key — a malformed fee slab or a
    // negative radius would otherwise silently corrupt every price.
    ok(res, {
      value: await configService.set({
        key,
        value,
        actorUserId: requireUser(req).id,
      }),
    });
  }),
);
