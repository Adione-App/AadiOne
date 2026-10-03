import { Router } from 'express';
import { asyncHandler } from '../../common/response';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import {
  adminLoginPerIp,
  changePasswordPerUser,
  sellerLoginPerIp,
  loginPerEmail,
  loginPerIp,
  otpPerIpHourly,
  otpPerMobileDaily,
  otpPerMobileHourly,
  signupPerIp,
  signupPerMobile,
  verifyOtpPerIp,
} from '../../middleware/rateLimit';
import * as controller from './auth.controller';
import {
  adminLoginSchema,
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  sellerLoginSchema,
  sendOtpSchema,
  signupSchema,
  updateProfileSchema,
  verifyOtpSchema,
} from './auth.validation';

export const authRouter: Router = Router();

/**
 * Validation runs BEFORE the per-mobile limiters, because those identify the
 * caller by `req.body.mobile` and must see the normalised 10-digit form —
 * otherwise "+91 98765 43210" and "9876543210" would get separate counters and
 * an attacker could reset the limit just by reformatting the number.
 */
authRouter.post(
  '/send-otp',
  validate({ body: sendOtpSchema }),
  otpPerMobileHourly,
  otpPerMobileDaily,
  otpPerIpHourly,
  asyncHandler(controller.sendOtp),
);

authRouter.post(
  '/verify-otp',
  validate({ body: verifyOtpSchema }),
  verifyOtpPerIp,
  asyncHandler(controller.verifyOtp),
);

/**
 * Task 2.6 — signup.
 * Validation first so the per-mobile limiter counts the normalised number.
 */
authRouter.post(
  '/signup',
  validate({ body: signupSchema }),
  signupPerMobile,
  signupPerIp,
  asyncHandler(controller.signup),
);

/**
 * Task 2.5 — email + password login.
 * Two limiters: per email defeats a dictionary attack on one known account;
 * per IP defeats credential stuffing across many accounts.
 */
authRouter.post(
  '/login',
  validate({ body: loginSchema }),
  loginPerEmail,
  loginPerIp,
  asyncHandler(controller.login),
);

authRouter.post(
  '/admin/login',
  validate({ body: adminLoginSchema }),
  loginPerEmail,
  adminLoginPerIp,
  asyncHandler(controller.adminLogin),
);

/**
 * Seller panel — email + password issued by AdiOne (sellers never register
 * themselves). The server checks the account's role and seller membership.
 */
authRouter.post(
  '/seller/login',
  validate({ body: sellerLoginSchema }),
  loginPerEmail,
  sellerLoginPerIp,
  asyncHandler(controller.sellerLogin),
);

authRouter.post(
  '/change-password',
  authenticate,
  changePasswordPerUser,
  validate({ body: changePasswordSchema }),
  asyncHandler(controller.changePassword),
);

authRouter.get('/password-status', authenticate, asyncHandler(controller.passwordStatus));

authRouter.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(controller.refresh),
);

authRouter.post(
  '/logout',
  validate({ body: logoutSchema }),
  asyncHandler(controller.logout),
);

authRouter.get('/me', authenticate, asyncHandler(controller.me));

authRouter.patch(
  '/me',
  authenticate,
  validate({ body: updateProfileSchema }),
  asyncHandler(controller.updateMe),
);

/**
 * DELETE /auth/me — account deletion.
 *
 * Google Play REQUIRES an in-app deletion path, and India's DPDP Act requires
 * erasure on request. A "Delete Account" button that does nothing is a store
 * listing rejection, so this actually erases.
 */
authRouter.delete('/me', authenticate, asyncHandler(controller.deleteMe));
