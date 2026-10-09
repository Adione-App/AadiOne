/**
 * Public banners. GET /banners?placement=home_top — the active banners of one
 * placement, in order. No authentication: banners are storefront content.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../common/response';
import { validate, validatedQuery } from '../../middleware/validate';
import * as service from './banner.service';

export const bannerRouter: Router = Router();

const listQuery = z.object({
  placement: z.string().trim().max(60).regex(service.PLACEMENT_PATTERN, 'invalid placement'),
});

bannerRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { placement } = validatedQuery<z.infer<typeof listQuery>>(req);
    ok(res, await service.listActiveBanners(placement));
  }),
);
