/**
 * Request schemas for seller onboarding data — the seller's own routes
 * (seller-onboarding.routes.ts). Admin has no write route for this data: it
 * is read-only for admin, who only reviews it. Every max length matches its
 * column in prisma/schema.prisma. Unknown keys are stripped.
 */

import { z } from 'zod';
import { SellerDocumentType } from '../../shared';

export const profileSchema = z.object({
  businessName: z.string().trim().min(2).max(160),
  businessType: z.string().trim().max(80).nullable().optional(),
  ownerFullName: z.string().trim().min(2).max(120),
  ownerMobile: z.string().trim().min(10).max(15),
  ownerEmail: z.string().trim().email().max(160).nullable().optional(),
  panNumber: z.string().trim().max(20).nullable().optional(),
  aadhaarNumber: z.string().trim().max(20).nullable().optional(),
  gstNumber: z.string().trim().max(20).nullable().optional(),
  fssaiNumber: z.string().trim().max(20).nullable().optional(),
});

export const bankDetailSchema = z.object({
  accountHolderName: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().min(6).max(40),
  ifscCode: z.string().trim().min(11).max(11),
  bankName: z.string().trim().max(120).nullable().optional(),
});

export const restaurantProfileSchema = z.object({
  cuisine: z.array(z.string().trim().min(1).max(40)).max(20),
  isVegOnly: z.boolean().optional(),
  avgPrepMins: z.number().int().positive().max(240).nullable().optional(),
});

/**
 * The TEXT fields of a document upload (multipart/form-data; the PDF itself
 * arrives as the `file` part and is checked by the service). Strict: a
 * `fileUrl`, `status` or anything else is a 400 — documents are uploaded,
 * never linked. The number's per-type format is checked by the service.
 */
export const documentSchema = z
  .object({
    type: z.nativeEnum(SellerDocumentType),
    documentNumber: z.string().trim().max(40).optional(),
    expiresAt: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/, 'Use a valid date.')
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .strict();
