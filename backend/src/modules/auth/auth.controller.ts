/**
 * Auth HTTP layer. Shape in, shape out — every decision lives in the service.
 */

import { SessionScope } from '@prisma/client';
import type { Request, Response } from 'express';
import type { SendOtpResponse } from '../../shared';
import { created, ok, noContent } from '../../common/response';
import { requireUser } from '../../middleware/auth';
import * as authService from './auth.service';
import * as sellerLifecycleService from '../sellers/seller-lifecycle.service';
import * as passwordResetService from './password-reset.service';
import type {
  AdminLoginInput,
  ChangePasswordInput,
  LoginInput,
  SellerForgotPasswordInput,
  SellerLoginInput,
  SellerResetPasswordInput,
  SellerSignupInput,
  SendOtpInput,
  SignupInput,
  UpdateProfileInput,
  VerifyOtpInput,
} from './auth.validation';

function contextOf(req: Request): { userAgent: string | null; ip: string | null } {
  return { userAgent: req.header('user-agent') ?? null, ip: req.ip ?? null };
}

/**
 * POST /auth/seller/signup — a seller APPLICATION. The account is signed in
 * straight away, but the lifecycle gate limits it to its application status
 * until admin approves (Gate 1) and verifies (Gate 2).
 */
export async function sellerSignup(req: Request, res: Response): Promise<void> {
  created(res, await sellerLifecycleService.signupSeller(req.body as SellerSignupInput, contextOf(req)));
}

/** POST /auth/send-otp */
export async function sendOtp(req: Request, res: Response): Promise<void> {
  const { mobile } = req.body as SendOtpInput;
  const outcome = await authService.sendOtp(mobile);

  const body: SendOtpResponse = {
    resendAfterSeconds: outcome.resendAfterSeconds,
    expiresInSeconds: outcome.expiresInSeconds,
    ...(outcome.devOtp ? { devOtp: outcome.devOtp } : {}),
  };
  ok(res, body);
}

/** POST /auth/verify-otp */
export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const { mobile, otp } = req.body as VerifyOtpInput;
  const result = await authService.verifyOtpAndAuthenticate(mobile, otp, contextOf(req));

  // 201 when the account was created by this call, 200 when it already existed.
  if (result.user.isNewUser) created(res, result);
  else ok(res, result);
}

/**
 * POST /auth/signup  (Task 2.6)
 *
 * Email + password + mobile + name. Returns 201 with tokens, so the customer
 * is logged in immediately rather than bounced back to a login screen.
 *
 * `user.mobileVerified` is false on the response: the number was typed, not
 * proven. The app should prompt for an OTP login before checkout.
 */
export async function signup(req: Request, res: Response): Promise<void> {
  const input = req.body as SignupInput;
  created(res, await authService.signup(input, contextOf(req)));
}

/** POST /auth/login  (Task 2.5) — email + password, any role. */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginInput;
  ok(res, await authService.loginWithPassword(email, password, contextOf(req)));
}

/**
 * POST /auth/admin/login
 *
 * Same credentials path, but additionally requires a staff role — a customer
 * with correct credentials must not get into the store panel.
 */
export async function adminLogin(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as AdminLoginInput;
  ok(
    res,
    await authService.loginWithPassword(email, password, contextOf(req), {
      requireStaffRole: true,
    }),
  );
}

/**
 * POST /auth/seller/login
 *
 * Same credentials path, but the ACCOUNT must be a seller-panel role with an
 * active seller membership. The login screen's Admin/Seller choice is only
 * which endpoint it calls — never an input to authorization.
 */
export async function sellerLogin(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as SellerLoginInput;
  ok(res, await authService.sellerLogin(email, password, contextOf(req)));
}

/**
 * POST /auth/seller/forgot-password — the same answer for every email, so it
 * never reveals whether a seller account exists.
 */
export async function sellerForgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = req.body as SellerForgotPasswordInput;
  await passwordResetService.requestSellerPasswordReset(email, contextOf(req));
  ok(res, { message: passwordResetService.FORGOT_PASSWORD_MESSAGE });
}

/** POST /auth/seller/reset-password — sets the new password from the emailed link. */
export async function sellerResetPassword(req: Request, res: Response): Promise<void> {
  const { token, newPassword } = req.body as SellerResetPasswordInput;
  await passwordResetService.resetSellerPassword(token, newPassword, contextOf(req));
  ok(res, { message: 'Your password has been changed. Sign in with your new password.' });
}

/** POST /auth/change-password — the signed-in user's own password. */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;
  const scope = user.sessionScope === 'customer' ? SessionScope.CUSTOMER : SessionScope.FULL;
  ok(res, await authService.changePassword(user.id, currentPassword, newPassword, scope, contextOf(req)));
}

/** GET /auth/password-status — has a password, and is it a temporary one? */
export async function passwordStatus(req: Request, res: Response): Promise<void> {
  ok(res, await authService.getPasswordStatus(requireUser(req).id));
}

/** POST /auth/refresh */
export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken: string };
  ok(res, await authService.refresh(refreshToken, contextOf(req)));
}

/**
 * POST /auth/logout
 *
 * Accepts the refresh token in the body (mobile) and falls back to the
 * authenticated session (admin cookie flow). Revoking is idempotent, so
 * logging out twice is not an error.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };

  if (refreshToken) {
    await authService.logout(refreshToken);
  } else if (req.user) {
    await authService.logoutEverywhere(req.user.id);
  }

  noContent(res);
}

/** GET /auth/me */
export async function me(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  ok(res, await authService.getProfile(user.id));
}

/** DELETE /auth/me */
export async function deleteMe(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  await authService.deleteAccount(user.id);
  noContent(res);
}

/** PATCH /auth/me */
export async function updateMe(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const data = req.body as UpdateProfileInput;
  ok(res, await authService.updateProfile(user.id, data));
}
