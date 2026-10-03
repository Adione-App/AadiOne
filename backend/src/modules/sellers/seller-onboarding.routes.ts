/**
 * Seller self-service onboarding — mounted at `/seller`, alongside
 * `seller-order.routes.ts` and `seller-catalog.routes.ts`. Every route reads
 * `req.sellerId` (from `attachSellerContext`) and never a client-supplied
 * seller id, same discipline as those two files.
 */

import { Router, type Request, type Response } from 'express';
import { ActorType, Permission } from '../../shared';
import { asyncHandler, created, ok } from '../../common/response';
import { validate } from '../../middleware/validate';
import { requirePermission, requireUser } from '../../middleware/auth';
import { attachSellerContext, requireSellerId } from '../../middleware/sellerAuth';
import * as service from './seller-onboarding.service';
import * as lifecycleService from './seller-lifecycle.service';
import { documentUpload } from '../../middleware/documentUpload';
import { sendDocumentFile } from './document-response';
import { z } from 'zod';
import {
  bankDetailSchema,
  documentSchema,
  profileSchema,
  restaurantProfileSchema,
} from './seller-onboarding.validation';

/** Every write here is the seller acting on its own record — audited as such. */
const sellerActor = (req: Request): service.OnboardingActor => ({
  userId: requireUser(req).id,
  type: ActorType.SELLER,
});

export const sellerOnboardingRouter: Router = Router();

sellerOnboardingRouter.use(attachSellerContext);

sellerOnboardingRouter.get(
  '/onboarding',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    const sellerId = requireSellerId(req);
    ok(res, await service.getSellerOnboardingView(sellerId));
  }),
);

sellerOnboardingRouter.put(
  '/onboarding/profile',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ body: profileSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.upsertSellerProfile(requireSellerId(req), req.body, sellerActor(req));
    ok(res, await service.getSellerOnboardingView(requireSellerId(req)));
  }),
);

sellerOnboardingRouter.put(
  '/onboarding/bank-detail',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ body: bankDetailSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.upsertBankDetail(requireSellerId(req), req.body, sellerActor(req));
    ok(res, await service.getSellerOnboardingView(requireSellerId(req)));
  }),
);

sellerOnboardingRouter.put(
  '/onboarding/restaurant-profile',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ body: restaurantProfileSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await service.upsertRestaurantProfile(requireSellerId(req), req.body, sellerActor(req));
    ok(res, await service.getSellerOnboardingView(requireSellerId(req)));
  }),
);

/** multipart/form-data: type, documentNumber, expiresAt? + the PDF as `file` (PDF only, ≤ 10 MB). */
sellerOnboardingRouter.post(
  '/onboarding/documents',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  documentUpload,
  validate({ body: documentSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const document = await service.addDocument(requireSellerId(req), req.body, req.file, sellerActor(req));
    created(res, document);
  }),
);

/** The seller's OWN uploaded PDF — another seller's document is NOT_FOUND. */
sellerOnboardingRouter.get(
  '/onboarding/documents/:documentId/file',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  validate({ params: z.object({ documentId: z.string().uuid() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const file = await service.getDocumentFile(requireSellerId(req), req.params['documentId'] as string, {
      type: 'SELLER',
      userId: requireUser(req).id,
    });
    sendDocumentFile(res, file);
  }),
);

sellerOnboardingRouter.get(
  '/onboarding/documents',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await service.listDocuments(requireSellerId(req)));
  }),
);

/** "Submit for Verification" (Gate 2 input) — answers with the new lifecycle state. */
sellerOnboardingRouter.post(
  '/onboarding/submit',
  requirePermission(Permission.SELLER_PROFILE_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await lifecycleService.submitForVerification(requireSellerId(req), requireUser(req).id));
  }),
);
