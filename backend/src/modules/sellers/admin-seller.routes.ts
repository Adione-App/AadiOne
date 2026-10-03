/**
 * Admin seller endpoints. Every seller — Aadione included — is managed the
 * same way here; there is no special platform store. Sellers own their
 * catalogue, hours and location in the Seller Panel; admin reads it and
 * moderates.
 *
 * Mounted under /api/v1/admin, which is already gated by `authenticate` +
 * `requireAdmin`; the route declares the specific permission it needs.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApprovalStatus, DocumentStatus, PAGINATION_MAX_LIMIT, Permission, SellerType } from '../../shared';
import { asyncHandler, created, ok, okCursorPage } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import * as managementService from './admin-seller-management.service';
import * as catalogService from './admin-seller-catalog.service';
import * as sellerCategoryService from '../catalog/seller-category.service';
import * as onboardingService from './seller-onboarding.service';
import * as settlementService from './seller-settlement.service';
import * as sellerLoginService from './seller-login.service';
import { documentUpload } from '../../middleware/documentUpload';
import { sendDocumentFile } from './document-response';
import { bankDetailSchema, documentSchema, profileSchema } from './seller-onboarding.validation';

const uuid = z.string().uuid();

/** Column sizes of `sellers.name/city/state` (prisma-v2/schema.prisma). The
 * schema must never accept more than the column holds — Prisma's P2000 would
 * otherwise surface as a 500 instead of a field-level 400. */
const SELLER_NAME_MAX = 120;
const SELLER_CITY_MAX = 80;
const SELLER_STATE_MAX = 80;

const createSellerSchema = z.object({
  name: z.string().trim().min(2).max(SELLER_NAME_MAX),
  sellerType: z.nativeEnum(SellerType),
  addressLine: z.string().trim().min(2).max(300),
  city: z.string().trim().min(2).max(SELLER_CITY_MAX),
  state: z.string().trim().min(2).max(SELLER_STATE_MAX),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits.'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  phone: z.string().trim().min(10).max(15).nullable().optional(),
  ownerMobile: z.string().trim().min(10).max(15),
  ownerFullName: z.string().trim().min(2).max(120),
  defaultCommissionBp: z.number().int().min(0).max(10_000).optional(),
});

/** Query strings arrive as text; `"true"` must become `true` (same shape as
 * catalog.validation.ts's own `booleanish`). */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1')
  .optional();

/** Strict: `isAcceptingOrders`, `onboardingStatus`, … are a 400, never ignored. */
const setSellerStatusSchema = z
  .object({
    isActive: z.boolean(),
    reason: z.string().trim().min(2).max(300),
  })
  .strict();

/** Basic details only — strict, so `sellerType`, `isActive`,
 * `onboardingStatus`, commission, bank fields, … are a 400. Same limits as
 * `createSellerSchema`. */
const updateSellerSchema = z
  .object({
    name: z.string().trim().min(2).max(SELLER_NAME_MAX).optional(),
    phone: z.string().trim().min(10).max(15).nullable().optional(),
    addressLine: z.string().trim().min(2).max(300).optional(),
    city: z.string().trim().min(2).max(SELLER_CITY_MAX).optional(),
    state: z.string().trim().min(2).max(SELLER_STATE_MAX).optional(),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits.').optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: 'Send latitude and longitude together.',
    path: ['latitude'],
  });

/** Identifies the bank state the admin reviewed — its id and version, never
 * account digits. Verification state itself is never taken from the client
 * (strict: `isVerified` is a 400). */
const verifyBankDetailSchema = z
  .object({
    bankDetailId: uuid,
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

const listSellersQuerySchema = z.object({
  search: z.string().trim().max(60).optional(),
  onboardingStatus: z.nativeEnum(ApprovalStatus).optional(),
  stage: z.enum(onboardingService.ONBOARDING_STAGES).optional(),
  isActive: booleanish,
  sellerType: z.nativeEnum(SellerType).optional(),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(25),
});

const reviewOnboardingSchema = z
  .object({
    status: z.enum([ApprovalStatus.APPROVED, ApprovalStatus.REJECTED]),
    reason: z.string().trim().max(400).nullable().optional(),
  })
  .refine((v) => v.status !== ApprovalStatus.REJECTED || !!v.reason?.trim(), {
    message: 'A reason is required when rejecting.',
    path: ['reason'],
  });

const reviewDocumentSchema = z
  .object({
    status: z.enum([DocumentStatus.VERIFIED, DocumentStatus.REJECTED]),
    rejectionReason: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => v.status !== DocumentStatus.REJECTED || !!v.rejectionReason?.trim(), {
    message: 'A reason is required when rejecting.',
    path: ['rejectionReason'],
  });

/** Both bounds optional — omitted ones default to the same period
 * `createSettlement` would use (see seller-settlement.service.ts). */
const settlementPeriodSchema = z.object({
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
});

export const adminSellerRouter: Router = Router();

/**
 * POST /admin/sellers
 *
 * The minimum required to onboard a new seller (#4): creates the Seller row
 * and its first SellerStaff (OWNER), linked, with basic duplicate-identity
 * validation, seeded at `onboardingStatus: PENDING`. The actual onboarding
 * portal (profile/bank/documents, submission, and the review decision that
 * moves it off PENDING) is seller-onboarding.service.ts, reviewed below.
 */
adminSellerRouter.post(
  '/sellers',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ body: createSellerSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await managementService.createSeller(req.body, requireUser(req).id));
  }),
);

/**
 * GET  /admin/sellers/:sellerId/login-credentials — the owner's panel-login
 *      status (email, has a password, still temporary?). Never a secret.
 * POST /admin/sellers/:sellerId/login-credentials — sets the owner's login
 *      email and a NEW temporary password (also the reset path). The password
 *      is in this one response only — hand it to the seller; it is not
 *      stored in plain text and cannot be shown again.
 */
const sellerIdParams = z.object({ sellerId: z.string().uuid() });

adminSellerRouter.get(
  '/sellers/:sellerId/login-credentials',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: sellerIdParams }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await sellerLoginService.getSellerLoginAccount(req.params['sellerId'] as string));
  }),
);

adminSellerRouter.post(
  '/sellers/:sellerId/login-credentials',
  requirePermission(Permission.SELLER_MANAGE),
  validate({
    params: sellerIdParams,
    body: z.object({ email: z.string().trim().email('Enter a valid email address').max(160) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(
      res,
      await sellerLoginService.issueSellerLoginCredentials(
        req.params['sellerId'] as string,
        (req.body as { email: string }).email,
        requireUser(req).id,
      ),
    );
  }),
);

/**
 * POST /admin/sellers/:sellerId/owner — give a seller with NO active owner an
 * owner account (e.g. Aadione's own store), so its team can use the Seller
 * Panel. Refused when an owner already exists.
 */
adminSellerRouter.post(
  '/sellers/:sellerId/owner',
  requirePermission(Permission.SELLER_MANAGE),
  validate({
    params: sellerIdParams,
    body: z
      .object({
        ownerMobile: z.string().trim().min(10).max(15),
        ownerFullName: z.string().trim().min(2).max(120),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { ownerMobile: string; ownerFullName: string };
    created(res, await managementService.assignSellerOwner(req.params['sellerId'] as string, body, requireUser(req).id));
  }),
);

/* -------------------------------------------------------------------------- */
/* Seller catalogue — read-only for admin. Sellers create their own top     */
/* categories, subcategories and products in the Seller Panel.              */
/* -------------------------------------------------------------------------- */

adminSellerRouter.get(
  '/sellers/:sellerId/categories',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await sellerCategoryService.listSellerCategoriesForAdmin(req.params['sellerId'] as string));
  }),
);

/**
 * Moderation only — disable (not buyable, the seller can't lift it) or
 * re-enable (returns hidden) one of the seller's own products. No content
 * edits: those stay the seller's, through the approval workflow.
 */
adminSellerRouter.patch(
  '/sellers/:sellerId/products/:productId/moderation',
  requirePermission(Permission.SELLER_MANAGE),
  validate({
    params: z.object({ sellerId: uuid, productId: uuid }),
    body: z
      .object({
        action: z.enum(['DISABLE', 'ENABLE']),
        reason: z.string().trim().max(300).nullable().optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { action: 'DISABLE' | 'ENABLE'; reason?: string | null };
    ok(
      res,
      await catalogService.moderateSellerProduct(
        req.params['sellerId'] as string,
        req.params['productId'] as string,
        { action: body.action, reason: body.reason ?? null },
        requireUser(req).id,
      ),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Onboarding review — cross-seller (#26), same scopeSellerId:undefined      */
/* pattern used by every other admin override in this codebase.              */
/* -------------------------------------------------------------------------- */

adminSellerRouter.get(
  '/sellers/onboarding',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({
    query: z.object({
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().int().positive().max(100).default(25),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<{ cursor?: string; limit: number }>(req);
    okCursorPage(
      res,
      await onboardingService.listOnboardingQueue({ cursor: query.cursor ?? null, limit: query.limit }),
    );
  }),
);

adminSellerRouter.get(
  '/sellers/:sellerId/onboarding',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await onboardingService.getOnboardingDetail(req.params['sellerId'] as string, undefined, true),
    );
  }),
);

/** The Admin Web's onboarding read — masked, no document links (see
 * `getOnboardingSummary`). The endpoint above stays as the unmasked review
 * view for now. */
adminSellerRouter.get(
  '/sellers/:sellerId/onboarding/summary',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await onboardingService.getOnboardingSummary(req.params['sellerId'] as string));
  }),
);

adminSellerRouter.patch(
  '/sellers/:sellerId/onboarding/review',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }), body: reviewOnboardingSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { status: typeof ApprovalStatus.APPROVED | typeof ApprovalStatus.REJECTED; reason?: string | null };
    ok(
      res,
      await onboardingService.reviewOnboarding(
        req.params['sellerId'] as string,
        body,
        requireUser(req).id,
      ),
    );
  }),
);

adminSellerRouter.patch(
  '/sellers/:sellerId/onboarding/documents/:documentId/review',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({
    params: z.object({ sellerId: uuid, documentId: uuid }),
    body: reviewDocumentSchema,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      status: typeof DocumentStatus.VERIFIED | typeof DocumentStatus.REJECTED;
      rejectionReason?: string | null;
    };
    await onboardingService.reviewDocument(
      req.params['sellerId'] as string,
      req.params['documentId'] as string,
      body.status,
      body.rejectionReason,
      requireUser(req).id,
    );
    ok(
      res,
      await onboardingService.getOnboardingDetail(req.params['sellerId'] as string, undefined, true),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Seller directory — the admin seller list and overview (read-only).        */
/*                                                                           */
/* ROUTE ORDER: `GET /sellers/:sellerId` must stay registered AFTER every    */
/* static one-segment path under /sellers — `/sellers/onboarding` above, and */
/* `/sellers/availability` (seller-availability.routes.ts, mounted before    */
/* this router in admin.routes.ts) — or it captures them and fails the uuid  */
/* check with a 400.                                                         */
/* -------------------------------------------------------------------------- */

adminSellerRouter.get(
  '/sellers',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ query: listSellersQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<z.infer<typeof listSellersQuerySchema>>(req);
    okCursorPage(
      res,
      await managementService.listSellers({
        ...(query.search ? { search: query.search } : {}),
        ...(query.onboardingStatus ? { onboardingStatus: query.onboardingStatus } : {}),
        ...(query.stage ? { stage: query.stage } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.sellerType ? { sellerType: query.sellerType } : {}),
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
  }),
);

adminSellerRouter.get(
  '/sellers/:sellerId',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await managementService.getSellerDetail(req.params['sellerId'] as string));
  }),
);

/* -------------------------------------------------------------------------- */
/* Seller management — writes. Every one 404s a missing or deleted seller;   */
/* every seller, Aadione included, goes through these same routes.          */
/* -------------------------------------------------------------------------- */

adminSellerRouter.patch(
  '/sellers/:sellerId/status',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: z.object({ sellerId: uuid }), body: setSellerStatusSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await managementService.setSellerStatus(req.params['sellerId'] as string, req.body, requireUser(req).id));
  }),
);

adminSellerRouter.patch(
  '/sellers/:sellerId',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: z.object({ sellerId: uuid }), body: updateSellerSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await managementService.updateSeller(req.params['sellerId'] as string, req.body, requireUser(req).id));
  }),
);

/** Admin onboarding data entry — for a seller that cannot fill it in itself. */
adminSellerRouter.put(
  '/sellers/:sellerId/onboarding/profile',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: z.object({ sellerId: uuid }), body: profileSchema.strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await managementService.upsertOnboardingProfile(req.params['sellerId'] as string, req.body, requireUser(req).id),
    );
  }),
);

adminSellerRouter.put(
  '/sellers/:sellerId/onboarding/bank-detail',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: z.object({ sellerId: uuid }), body: bankDetailSchema.strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await managementService.upsertOnboardingBankDetail(
        req.params['sellerId'] as string,
        req.body,
        requireUser(req).id,
      ),
    );
  }),
);

/** Verifying a payout account is both an onboarding review decision and a
 * payout-trust decision, so it needs both permissions. */
adminSellerRouter.patch(
  '/sellers/:sellerId/onboarding/bank-detail/verify',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW, Permission.SETTLEMENT_MANAGE),
  validate({ params: z.object({ sellerId: uuid }), body: verifyBankDetailSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await managementService.verifyBankDetail(req.params['sellerId'] as string, req.body, requireUser(req).id),
    );
  }),
);

/** A document the seller supplied out-of-band, uploaded by admin as a PDF
 * (multipart/form-data, same fields and checks as POST /seller/onboarding/
 * documents). Strict, so `status` etc. cannot be set — it starts PENDING. */
adminSellerRouter.post(
  '/sellers/:sellerId/onboarding/documents',
  requirePermission(Permission.SELLER_MANAGE),
  validate({ params: z.object({ sellerId: uuid }) }),
  documentUpload,
  validate({ body: documentSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await managementService.addOnboardingDocument(req.params['sellerId'] as string, req.body, req.file, requireUser(req).id),
    );
  }),
);

const documentParams = z.object({ sellerId: uuid, documentId: uuid });

/** The uploaded PDF, streamed from private storage (audited). */
adminSellerRouter.get(
  '/sellers/:sellerId/onboarding/documents/:documentId/file',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: documentParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const file = await onboardingService.getDocumentFile(req.params['sellerId'] as string, req.params['documentId'] as string, {
      type: 'ADMIN',
      userId: requireUser(req).id,
    });
    sendDocumentFile(res, file);
  }),
);

/** "Show": the full document number (audited, never cached). */
adminSellerRouter.get(
  '/sellers/:sellerId/onboarding/documents/:documentId/number',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: documentParams }),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    ok(
      res,
      await onboardingService.revealDocumentNumber(req.params['sellerId'] as string, req.params['documentId'] as string, requireUser(req).id),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Seller management — the seller's own catalogue, read-only.               */
/* -------------------------------------------------------------------------- */

adminSellerRouter.get(
  '/sellers/:sellerId/listings',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await managementService.listSellerListings(req.params['sellerId'] as string));
  }),
);

adminSellerRouter.get(
  '/sellers/:sellerId/products',
  requirePermission(Permission.SELLER_ONBOARDING_REVIEW),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await managementService.listSellerProducts(req.params['sellerId'] as string));
  }),
);

/* -------------------------------------------------------------------------- */
/* Earnings / settlement — per-seller admin actions. Cross-seller browsing   */
/* (GET /admin/settlements, /:id, PATCH .../status) lives in                 */
/* admin-order.routes.ts, next to the seller-orders cross-seller override.   */
/* -------------------------------------------------------------------------- */

adminSellerRouter.get(
  '/sellers/:sellerId/earnings',
  requirePermission(Permission.SETTLEMENT_READ),
  validate({ params: z.object({ sellerId: uuid }) }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await settlementService.getEarningsSummary(req.params['sellerId'] as string, undefined));
  }),
);

adminSellerRouter.get(
  '/sellers/:sellerId/settlements/eligible',
  requirePermission(Permission.SETTLEMENT_READ),
  validate({ params: z.object({ sellerId: uuid }), query: settlementPeriodSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<settlementService.SettlementPeriodInput>(req);
    ok(res, await settlementService.previewEligibleSettlement(req.params['sellerId'] as string, query));
  }),
);

adminSellerRouter.post(
  '/sellers/:sellerId/settlements',
  requirePermission(Permission.SETTLEMENT_MANAGE),
  validate({ params: z.object({ sellerId: uuid }), body: settlementPeriodSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await settlementService.createSettlement(req.params['sellerId'] as string, req.body);
    // 200 for an idempotent replay of an already-created period, 201 otherwise.
    (result.created ? created : ok)(res, result.settlement);
  }),
);
