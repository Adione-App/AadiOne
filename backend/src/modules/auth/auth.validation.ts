/**
 * Request schemas for the auth module.
 *
 * The mobile schema normalises rather than merely validating: users paste
 * "+91 98765 43210", "098765 43210" and "9876543210" interchangeably, and the
 * rest of the system must only ever see the canonical 10 digits.
 */

import { z } from 'zod';
import { SellerType } from '../../shared/enums';
import { normalizeIndianMobile } from '../../shared/phone';
import { env } from '../../config/env';

export const mobileSchema = z
  .string({ required_error: 'Enter your mobile number' })
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeIndianMobile(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid 10-digit mobile number',
      });
      return z.NEVER;
    }
    return normalized;
  });

export const sendOtpSchema = z.object({
  mobile: mobileSchema,
});

export const verifyOtpSchema = z.object({
  mobile: mobileSchema,
  otp: z
    .string({ required_error: 'Enter the OTP' })
    .trim()
    .regex(
      new RegExp(`^\\d{${env.OTP_LENGTH}}$`),
      `Enter the ${env.OTP_LENGTH}-digit OTP`,
    ),
});

export const refreshSchema = z.object({
  refreshToken: z.string({ required_error: 'Missing refresh token' }).min(20),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(20).optional(),
});

export const emailSchema = z
  .string({ required_error: 'Enter your email' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(160, 'Email is too long');

/**
 * Password policy for NEW passwords.
 *
 * Length is the requirement that actually matters; a 12-character passphrase
 * beats "P@ss1!" comfortably. A modest character-class rule is kept because
 * this market's users overwhelmingly pick short lowercase words, but the
 * minimum is 8 rather than a maze of rules that pushes people to write the
 * password on the shop counter.
 */
export const newPasswordSchema = z
  .string({ required_error: 'Enter a password' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .refine((v) => /[a-zA-Z]/.test(v), 'Password must contain a letter')
  .refine((v) => /\d/.test(v), 'Password must contain a number');

/** Task 2.5 — login accepts any existing password; no policy applied. */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ required_error: 'Enter your password' }).min(1, 'Enter your password'),
});

/** Kept as a distinct name so the admin route reads clearly. */
export const adminLoginSchema = loginSchema;

/** Seller-panel email + password login — same shape as every login. */
export const sellerLoginSchema = loginSchema;

/** Change your own password: the current one proves it is you. */
export const changePasswordSchema = z.object({
  currentPassword: z
    .string({ required_error: 'Enter your current password' })
    .min(1, 'Enter your current password'),
  newPassword: newPasswordSchema,
});

/** Task 2.6 — signup. */
export const signupSchema = z.object({
  fullName: z
    .string({ required_error: 'Enter your name' })
    .trim()
    .min(2, 'Name must be at least 2 characters')
    .max(120, 'Name is too long'),
  email: emailSchema,
  password: newPasswordSchema,
  mobile: mobileSchema,
});

/**
 * Public seller application (POST /auth/seller/signup). Strict: commission,
 * status, address or anything else is a 400 — those are never the
 * applicant's to set. GENERAL is not a seller type (OTHER is).
 */
export const sellerSignupSchema = z
  .object({
    fullName: signupSchema.shape.fullName,
    mobile: mobileSchema,
    email: emailSchema,
    password: newPasswordSchema,
    businessName: z
      .string({ required_error: 'Enter your business or store name' })
      .trim()
      .min(2, 'Business name must be at least 2 characters')
      .max(120, 'Business name is too long'),
    sellerType: z.nativeEnum(SellerType, {
      errorMap: () => ({ message: 'Choose your seller type' }),
    }),
  })
  .strict();

export const updateProfileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Name must be at least 2 characters')
      .max(120, 'Name is too long')
      .optional(),
    // Explicit null clears the address; undefined leaves it untouched.
    email: z.string().trim().email('Enter a valid email address').nullable().optional(),
  })
  .refine((data) => data.fullName !== undefined || data.email !== undefined, {
    message: 'Nothing to update',
  });

export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type SellerLoginInput = z.infer<typeof sellerLoginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type SellerSignupInput = z.infer<typeof sellerSignupSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
