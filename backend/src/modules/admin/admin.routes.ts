/**
 * Admin API surface.
 *
 * One gate at the top — authenticated, staff role, and a higher rate limit —
 * then each module's admin router underneath. Individual routes still declare
 * the specific permission they need.
 */

import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/auth';
import { authenticatedApiLimit } from '../../middleware/rateLimit';
import { adminCatalogRouter } from '../catalog/admin-catalog.routes';
import { adminInventoryRouter } from '../inventory/admin-inventory.routes';
import { adminStoreRouter } from '../stores/admin-store.routes';
import { adminReferralRouter } from '../referrals/admin-referral.routes';
import { adminOrderRouter } from './admin-order.routes';

export const adminRouter: Router = Router();

adminRouter.use(authenticate, requireAdmin, authenticatedApiLimit);

adminRouter.use('/', adminCatalogRouter);
adminRouter.use('/', adminInventoryRouter);
adminRouter.use('/', adminStoreRouter);
adminRouter.use('/', adminOrderRouter);
adminRouter.use('/', adminReferralRouter);
