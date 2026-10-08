/**
 * Public offers — the promo codes any customer may apply right now (Home's
 * "Offers & Coupons").
 *
 * The same rules `resolveCoupon` (pricing.service.ts) applies at checkout,
 * minus the per-user ones it can only check for a signed-in customer:
 * switched on, a global PROMO (never a code minted for one user, such as a
 * referral reward), inside its validity window, and not used up. Coupons
 * switched off globally (FEATURE_COUPONS_ENABLED) list nothing — showing a
 * code checkout would refuse is worse than showing none. An expired or
 * exhausted code drops out on the next request; nothing to clean up.
 */

import { ConfigKey, CouponOrigin, type OfferDto } from "../../shared";
import { prisma } from "../../infra/db/prisma";
import * as configService from "../configuration/configuration.service";

/** Enough for a Home strip; the list is admin-curated, not a catalogue. */
const MAX_OFFERS = 20;

export async function listPublicOffers(now: Date = new Date()): Promise<OfferDto[]> {
  if (!(await configService.get(ConfigKey.FEATURE_COUPONS_ENABLED))) return [];

  const coupons = await prisma.coupon.findMany({
    where: {
      isActive: true,
      origin: CouponOrigin.PROMO,
      issuedToUserId: null,
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gt: now } }],
    },
    orderBy: [{ createdAt: "desc" }],
    // Over-fetch: usage limits compare two columns, which Prisma cannot
    // express in a where clause, so exhausted codes are dropped below.
    take: MAX_OFFERS * 3,
  });

  return coupons
    .filter((coupon) => coupon.usageLimitTotal === null || coupon.usedCount < coupon.usageLimitTotal)
    .slice(0, MAX_OFFERS)
    .map((coupon) => ({
      code: coupon.code,
      description: coupon.description,
      type: coupon.type,
      discountValue: coupon.discountValue,
      maxDiscountPaise: coupon.maxDiscountPaise,
      minOrderPaise: coupon.minOrderPaise,
      validTo: coupon.validTo?.toISOString() ?? null,
    }));
}
