/**
 * API route table.
 *
 * Versioned under /api/v1 because a mobile app already installed on a
 * customer's phone cannot be forced to upgrade — a breaking change must be
 * able to live alongside the old contract.
 *
 * Module routers are mounted here as each phase lands.
 */

import { Router } from 'express';
import { publicApiLimit } from '../middleware/rateLimit';
import { configurationRouter } from '../modules/configuration/configuration.routes';
import { legalRouter } from '../modules/legal/legal.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { sellerRouter } from '../modules/sellers/seller.routes';
import { catalogRouter } from '../modules/catalog/catalog.routes';
import { adminRouter } from '../modules/admin/admin.routes';
import { cartRouter } from '../modules/cart/cart.routes';
import { addressRouter } from '../modules/addresses/address.routes';
import { checkoutRouter, orderRouter } from '../modules/orders/order.routes';
import { sellerOrderRouter } from '../modules/orders/seller-order.routes';
import { sellerCatalogRouter } from '../modules/catalog/seller-catalog.routes';
import { sellerProductImportRouter } from '../modules/product-import/import.routes';
import { sellerOnboardingRouter } from '../modules/sellers/seller-onboarding.routes';
import { sellerSettlementRouter } from '../modules/sellers/seller-settlement.routes';
import { restaurantRouter, sellerRestaurantRouter } from '../modules/restaurants/restaurant.routes';
import { offerRouter } from '../modules/pricing/offer.routes';
import { bannerRouter } from '../modules/banners/banner.routes';
import { sellerAvailabilityRouter } from '../modules/sellers/seller-availability.routes';
import { sellerCommissionRouter } from '../modules/commission/commission.routes';
import { sellerNotificationRouter } from '../modules/notifications/notification.routes';
import { sellerActivityRouter } from '../modules/sellers/seller-activity.routes';
import { authenticate, requireSellerOrAdmin } from '../middleware/auth';
import { requireSellerLifecycleAccess } from '../middleware/sellerLifecycle';
import { sellerLifecycleRouter } from '../modules/sellers/seller-lifecycle.routes';
import { authenticatedApiLimit } from '../middleware/rateLimit';
import { paymentRouter } from '../modules/payments/payment.routes';
import { appVersionRouter } from '../modules/app-version/app-version.routes';
import { clientErrorRouter } from '../modules/client-errors/client-errors.routes';
import { contentRouter } from '../modules/content/content.routes';
import { platformAvailabilityRouter } from '../modules/platform/platform-availability.routes';
import { requireSupportedAppVersion, requireSupportedAppVersionForPayments } from '../middleware/appVersion';
import {
  deviceRouter,
  notificationRouter,
} from '../modules/notifications/notification.routes';
import { referralRouter, rewardsRouter } from '../modules/referrals/referral.routes';

export const apiRouter: Router = Router();

// Baseline per-IP limit across the whole API. Route-specific limiters (OTP,
// order creation) stack on top of this rather than replacing it.
apiRouter.use(publicApiLimit);

apiRouter.use('/config', configurationRouter);
// App-wide ordering availability, computed now (guests too).
apiRouter.use('/availability', platformAvailabilityRouter);
// Public, never version-gated: an app that must update has to learn that.
apiRouter.use('/app-version', appVersionRouter);
// Public: app crash reports (redacted, rate-limited, log-only).
apiRouter.use('/client-errors', clientErrorRouter);
apiRouter.use('/legal', legalRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/store', sellerRouter);
apiRouter.use('/', catalogRouter);
apiRouter.use('/restaurants', restaurantRouter);
apiRouter.use('/offers', offerRouter);
apiRouter.use('/banners', bannerRouter);
// Public: the published Home page layout (Admin Panel → Home Page Builder).
apiRouter.use('/content', contentRouter);
// Customer commerce routes refuse an app below the supported version
// (middleware/appVersion.ts — requests without app headers, i.e. the admin and
// seller panels, webhooks and integrations, pass untouched; payment
// verification and the gateway webhook are always open).
apiRouter.use('/cart', requireSupportedAppVersion, cartRouter);
apiRouter.use('/addresses', requireSupportedAppVersion, addressRouter);
apiRouter.use('/checkout', requireSupportedAppVersion, checkoutRouter);
apiRouter.use('/orders', requireSupportedAppVersion, orderRouter);
apiRouter.use('/payments', requireSupportedAppVersionForPayments, paymentRouter);
apiRouter.use('/notifications', notificationRouter);
apiRouter.use('/devices', deviceRouter);
apiRouter.use('/referrals', requireSupportedAppVersion, referralRouter);
apiRouter.use('/rewards', requireSupportedAppVersion, rewardsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use(
  '/seller',
  authenticate,
  requireSellerOrAdmin,
  authenticatedApiLimit,
  // Two-gate lifecycle: only ACTIVE sellers reach the operational routers;
  // applicants/onboarding sellers get /lifecycle + /onboarding only.
  requireSellerLifecycleAccess,
  sellerLifecycleRouter,
  sellerOrderRouter,
  sellerCatalogRouter,
  sellerProductImportRouter,
  sellerOnboardingRouter,
  sellerSettlementRouter,
  sellerRestaurantRouter,
  sellerAvailabilityRouter,
  sellerCommissionRouter,
  sellerNotificationRouter,
  sellerActivityRouter,
);

// Phase 9  — payments
// Phase 10 — delivery
// Phase 11 — notifications
// Phase 13 — admin

apiRouter.get('/', (_req, res) => {
  res.json({
    success: true,
    data: {
      name: 'AdiOne API',
      version: 'v1',
      documentation: '/docs/04-api-reference.md',
    },
    meta: { requestId: res.getHeader('x-request-id') ?? '' },
  });
});
