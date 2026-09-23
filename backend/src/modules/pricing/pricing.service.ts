/**
 * Pricing engine — the single implementation of the bill.
 *
 * Cart display, the checkout quote and order creation ALL call this. That is
 * the point: three separate implementations would eventually disagree, and the
 * disagreement would surface as a customer being charged something other than
 * what they were shown.
 *
 * Order of operations is fixed and documented in PRD §17.2. Every intermediate
 * value stays an integer number of paise; rounding happens only where a
 * percentage is applied.
 */

import {
  ConfigKey,
  CouponType,
  ErrorCode,
  type BillDto,
  type ConfigValues,
} from "../../shared";
import { extractInclusiveTaxPaise, percentOfPaise } from "../../shared/money";
import {
  resolveDeliveryFeePaise,
  toRoadDistanceKm,
} from "../../shared/distance";
import { AppError } from "../../common/errors";
import { prisma } from "../../infra/db/prisma";
import * as configService from "../configuration/configuration.service";
import { config } from "dotenv";

export interface PriceableItem {
  variantId: string;
  qty: number;
  mrpPaise: number;
  unitPricePaise: number;
  taxRateBp: number;
}

export interface ResolvedCoupon {
  id: string;
  code: string;
  type: CouponType;
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
}

export interface PricingInput {
  items: PriceableItem[];
  /** Straight-line km; the road factor is applied here, once. */
  distanceKm: number | null;
  coupon?: ResolvedCoupon | null;
}

export interface PricingResult {
  bill: BillDto;
  couponDiscountPaise: number;
  freeDeliveryReason: string | null;
}

type PricingConfig = Pick<
  ConfigValues,
  | "DELIVERY_FEE_SLABS"
  | "FREE_DELIVERY_THRESHOLD_PAISE"
  | "PLATFORM_FEE_PAISE"
  | "MIN_ORDER_VALUE_PAISE"
  | "ROAD_DISTANCE_FACTOR"
>;

async function loadConfig(): Promise<PricingConfig> {
  return configService.getMany([
    ConfigKey.DELIVERY_FEE_SLABS,
    ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE,
    ConfigKey.PLATFORM_FEE_PAISE,
    ConfigKey.MIN_ORDER_VALUE_PAISE,
    ConfigKey.ROAD_DISTANCE_FACTOR,
  ]);
}

export async function computeBill(input: PricingInput): Promise<PricingResult> {
  const config = await loadConfig();

  // 1-3. Line totals, subtotal and the MRP saving.
  let itemsSubtotalPaise = 0;
  let itemDiscountPaise = 0;
  let taxPaise = 0;
  let itemCount = 0;

  for (const item of input.items) {
    const lineTotal = item.unitPricePaise * item.qty;
    itemsSubtotalPaise += lineTotal;
    itemDiscountPaise += Math.max(
      0,
      (item.mrpPaise - item.unitPricePaise) * item.qty,
    );
    // Tax is EXTRACTED from the inclusive price, never added on top —
    // adding it would double-charge (PRD §2.1 C10).
    taxPaise += extractInclusiveTaxPaise(lineTotal, item.taxRateBp);
    itemCount += item.qty;
  }

  // 4. Coupon, capped.
  let couponDiscountPaise = 0;
  let couponWaivesDelivery = false;

  if (input.coupon) {
    if (itemsSubtotalPaise < input.coupon.minOrderPaise) {
      throw new AppError(ErrorCode.COUPON_MIN_ORDER_NOT_MET, {
        message: `This coupon needs a minimum order of ₹${Math.ceil(input.coupon.minOrderPaise / 100)}.`,
      });
    }

    switch (input.coupon.type) {
      case CouponType.PERCENT: {
        const raw = percentOfPaise(
          itemsSubtotalPaise,
          input.coupon.discountValue,
        );
        couponDiscountPaise = input.coupon.maxDiscountPaise
          ? Math.min(raw, input.coupon.maxDiscountPaise)
          : raw;
        break;
      }
      case CouponType.FLAT:
        // Never discount below zero — a ₹50 coupon on a ₹40 order is ₹40 off.
        couponDiscountPaise = Math.min(
          input.coupon.discountValue,
          itemsSubtotalPaise,
        );
        break;
      case CouponType.FREE_DELIVERY:
        couponWaivesDelivery = true;
        break;
    }
  }

  // 5. Delivery fee, from ROAD distance.
  const netItemsPaise = itemsSubtotalPaise - couponDiscountPaise;
  let deliveryFeePaise = 0;
  let freeDeliveryReason: string | null = null;

  if (input.distanceKm !== null) {
    const roadKm = toRoadDistanceKm(
      input.distanceKm,
      config.ROAD_DISTANCE_FACTOR,
    );
    deliveryFeePaise = resolveDeliveryFeePaise(
      roadKm,
      config.DELIVERY_FEE_SLABS,
    );

    if (couponWaivesDelivery) {
      deliveryFeePaise = 0;
      freeDeliveryReason = "Free delivery applied with your coupon";
    } else if (netItemsPaise >= config.FREE_DELIVERY_THRESHOLD_PAISE) {
      deliveryFeePaise = 0;
      freeDeliveryReason = `Free delivery on orders above ₹${Math.floor(
        config.FREE_DELIVERY_THRESHOLD_PAISE / 100,
      )}`;
    }
  }

  // 6. Platform fee — the line is hidden entirely when zero.
  const platformFeePaise = config.PLATFORM_FEE_PAISE;

  // 8. Total.
  const totalPaise = netItemsPaise + deliveryFeePaise + platformFeePaise;

  const bill: BillDto = {
    itemCount,
    itemsSubtotalPaise,
    itemDiscountPaise,
    couponCode: input.coupon?.code ?? null,
    couponDiscountPaise,
    deliveryFeePaise,
    deliveryFeeWaivedReason: freeDeliveryReason,
    platformFeePaise,
    taxPaise,
    totalPaise,
    totalSavingsPaise: itemDiscountPaise + couponDiscountPaise,
  };

  return { bill, couponDiscountPaise, freeDeliveryReason };
}

/** Shortfall to the configured minimum order, in paise. Zero when met. */
export async function minimumOrderShortfall(
  itemsSubtotalPaise: number,
): Promise<number> {
  const minimum = await configService.get(ConfigKey.MIN_ORDER_VALUE_PAISE);
  return Math.max(0, minimum - itemsSubtotalPaise);
}

/* -------------------------------------------------------------------------- */
/* Coupons                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Validates a coupon for a user.
 *
 * Called both at cart display and again INSIDE the order transaction. The
 * second call is the one that matters: usage limits can only be enforced
 * without a race if they are checked and consumed under the same transaction.
 */
export async function resolveCoupon(
  code: string,
  userId: string,
): Promise<ResolvedCoupon> {
  const enabled = await configService.get(ConfigKey.FEATURE_COUPONS_ENABLED);
  if (!enabled) {
    throw new AppError(ErrorCode.COUPON_INVALID, {
      message: "Coupons are not available right now.",
    });
  }

  const coupon = await prisma.coupon.findUnique({
    where: { code: code.trim().toUpperCase() },
  });

  if (!coupon || !coupon.isActive) {
    throw new AppError(ErrorCode.COUPON_INVALID);
  }

  // A coupon minted for one specific user (e.g. a Refer & Earn reward — see
  // referral.service.ts) is invisible/unusable to everyone else. Global promo
  // codes (`issuedToUserId === null`) are unaffected.
  if (coupon.issuedToUserId && coupon.issuedToUserId !== userId) {
    throw new AppError(ErrorCode.COUPON_INVALID);
  }

  const now = new Date();
  if (coupon.validFrom > now || (coupon.validTo && coupon.validTo < now)) {
    throw new AppError(ErrorCode.COUPON_EXPIRED);
  }

  if (
    coupon.usageLimitTotal !== null &&
    coupon.usedCount >= coupon.usageLimitTotal
  ) {
    throw new AppError(ErrorCode.COUPON_LIMIT_REACHED);
  }

  const usedByUser = await prisma.couponRedemption.count({
    where: { couponId: coupon.id, userId },
  });
  if (usedByUser >= coupon.usageLimitPerUser) {
    throw new AppError(ErrorCode.COUPON_LIMIT_REACHED, {
      message: "You have already used this coupon.",
    });
  }

  return {
    id: coupon.id,
    code: coupon.code,
    type: coupon.type,
    discountValue: coupon.discountValue,
    maxDiscountPaise: coupon.maxDiscountPaise,
    minOrderPaise: coupon.minOrderPaise,
  };
}
