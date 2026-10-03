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
import { adminInventoryRouter } from '../inventory/admin-inventory.routes';
import { adminSellerRouter } from '../sellers/admin-seller.routes';
import { adminReferralRouter } from '../referrals/admin-referral.routes';
import { adminOrderRouter } from './admin-order.routes';
import { adminProductApprovalRouter } from '../catalog/admin-product-approval.routes';
import { adminRestaurantRouter } from '../restaurants/restaurant.routes';
import { adminAvailabilityRouter } from '../sellers/seller-availability.routes';
import { adminCommissionRouter } from '../commission/commission.routes';
import { adminNotificationRouter } from '../notifications/notification.routes';
import { adminMarketplaceRouter } from './admin-marketplace.routes';

export const adminRouter: Router = Router();

adminRouter.use(authenticate, requireAdmin, authenticatedApiLimit);

adminRouter.use('/', adminInventoryRouter);
adminRouter.use('/', adminAvailabilityRouter);
adminRouter.use('/', adminCommissionRouter);
adminRouter.use('/', adminNotificationRouter);
adminRouter.use('/', adminSellerRouter);
adminRouter.use('/', adminOrderRouter);
adminRouter.use('/', adminReferralRouter);
adminRouter.use('/', adminProductApprovalRouter);
adminRouter.use('/', adminRestaurantRouter);
adminRouter.use('/', adminMarketplaceRouter);
