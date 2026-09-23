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
import { storeRouter } from '../modules/stores/store.routes';
import { catalogRouter } from '../modules/catalog/catalog.routes';
import { adminRouter } from '../modules/admin/admin.routes';
import { cartRouter } from '../modules/cart/cart.routes';
import { addressRouter } from '../modules/addresses/address.routes';
import { checkoutRouter, orderRouter } from '../modules/orders/order.routes';
import { paymentRouter } from '../modules/payments/payment.routes';
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
apiRouter.use('/legal', legalRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/store', storeRouter);
apiRouter.use('/', catalogRouter);
apiRouter.use('/cart', cartRouter);
apiRouter.use('/addresses', addressRouter);
apiRouter.use('/checkout', checkoutRouter);
apiRouter.use('/orders', orderRouter);
apiRouter.use('/payments', paymentRouter);
apiRouter.use('/notifications', notificationRouter);
apiRouter.use('/devices', deviceRouter);
apiRouter.use('/referrals', referralRouter);
apiRouter.use('/rewards', rewardsRouter);
apiRouter.use('/admin', adminRouter);

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
