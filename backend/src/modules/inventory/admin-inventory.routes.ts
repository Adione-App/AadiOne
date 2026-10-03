/**
 * Admin inventory endpoints — READ ONLY.
 *
 * Every seller, Aadione included, manages its own price, stock and on-sale
 * switch in the Seller Panel (`/seller/listings/*`). Admin monitors stock
 * across the marketplace (GET /admin/marketplace/inventory) and can read any
 * listing's stock history here, but changes nothing.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Permission } from '../../shared';
import { asyncHandler, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import * as service from './inventory.service';

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

export const adminInventoryRouter: Router = Router();

adminInventoryRouter.get(
  '/seller-listings/:id/ledger',
  requirePermission(Permission.INVENTORY_READ),
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.getLedger(req.params['id'] as string));
  }),
);
