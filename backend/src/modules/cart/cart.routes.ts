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

import * as service from "./cart.service";

const uuid = z.string().uuid();

const distanceQuery = z.object({
  distanceKm: z.coerce.number().finite().nonnegative().optional(),
});

export const cartRouter: Router = Router();

cartRouter.use(authenticate, requirePermission(Permission.CART_MANAGE));

/* -------------------------------------------------------------------------- */
/* GET CART                                                                   */
/* -------------------------------------------------------------------------- */

cartRouter.get(
  "/",
  validate({
    query: distanceQuery,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const distanceKm =
      req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;

    const result = await service.getCart(requireUser(req).id, {
      distanceKm,
    });

    ok(res, result.dto);
  }),
);

/* -------------------------------------------------------------------------- */
/* ADD ITEM                                                                   */
/* -------------------------------------------------------------------------- */

cartRouter.post(
  "/items",
  validate({
    query: distanceQuery,

    body: z.object({
      sellerListingId: uuid,

      // Bounded here as well as against the per-item limit.
      qty: z.number().int().positive().max(1000).default(1),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { sellerListingId, qty } = req.body as {
      sellerListingId: string;
      qty: number;
    };

    const distanceKm =
      req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;

    const result = await service.addItem(
      requireUser(req).id,
      sellerListingId,
      qty,
      distanceKm,
    );

    ok(res, result);
  }),
);

/* -------------------------------------------------------------------------- */
/* UPDATE ITEM QUANTITY                                                       */
/* -------------------------------------------------------------------------- */

cartRouter.patch(
  "/items/:id",
  validate({
    params: z.object({
      id: uuid,
    }),

    query: distanceQuery,

    // Zero is allowed and means "remove".
    body: z.object({
      qty: z.number().int().min(0).max(1000),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { qty } = req.body as {
      qty: number;
    };

    const distanceKm =
      req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;

    const result = await service.updateItemQty(
      requireUser(req).id,
      req.params["id"] as string,
      qty,
      distanceKm,
    );

    ok(res, result);
  }),
);

/* -------------------------------------------------------------------------- */
/* REMOVE ITEM                                                                */
/* -------------------------------------------------------------------------- */

cartRouter.delete(
  "/items/:id",
  validate({
    params: z.object({
      id: uuid,
    }),

    query: distanceQuery,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const distanceKm =
      req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;

    const result = await service.removeItem(
      requireUser(req).id,
      req.params["id"] as string,
      distanceKm,
    );

    ok(res, result);
  }),
);

/* -------------------------------------------------------------------------- */
/* CLEAR CART                                                                 */
/* -------------------------------------------------------------------------- */

cartRouter.delete(
  "/",
  validate({
    query: distanceQuery,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const distanceKm =
      req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;

    const result = await service.clearCart(requireUser(req).id, distanceKm);

    ok(res, result);
  }),
);

/* -------------------------------------------------------------------------- */
/* APPLY COUPON                                                               */
/* -------------------------------------------------------------------------- */

cartRouter.post(
  "/coupon",
  validate({
    query: distanceQuery,

    body: z.object({
      code: z.string().trim().min(2).max(40),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.body as {
      code: string;
    };

    const distanceKm =
      req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;

    const result = await service.applyCoupon(
      requireUser(req).id,
      code,
      distanceKm,
    );

    ok(res, result);
  }),
);

/* -------------------------------------------------------------------------- */
/* REMOVE COUPON                                                              */
/* -------------------------------------------------------------------------- */

cartRouter.delete(
  "/coupon",
  validate({
    query: distanceQuery,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const distanceKm =
      req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : null;

    const result = await service.removeCoupon(requireUser(req).id, distanceKm);

    ok(res, result);
  }),
);
