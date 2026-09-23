/**
 * Coupon status is always DERIVED here, never stored — a coupon that has
 * simply aged past `validTo` must read as EXPIRED the instant anyone looks at
 * it (checkout, the Rewards page, admin), not only once some job gets around
 * to flipping a column (see requirement: backend must check `expiresAt >
 * currentTime` wherever the coupon is viewed/applied/validated).
 */

import type { RewardCouponDto, RewardCouponStatus } from '../../shared';
import type { CouponWithRedemptions } from './referral.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

export function deriveRewardCouponStatus(
  usedAt: Date | null,
  validTo: Date | null,
  now: Date = new Date(),
): RewardCouponStatus {
  if (usedAt) return 'USED';
  if (validTo && validTo < now) return 'EXPIRED';
  return 'ACTIVE';
}

/** "Expires in 6 days" / "Expires tomorrow" / "Expires today" — null once the
 * coupon is no longer usable, since a countdown on a used/expired coupon is
 * just noise. */
function expiresInLabel(validTo: Date | null, status: RewardCouponStatus, now: Date): string | null {
  if (status !== 'ACTIVE' || !validTo) return null;

  const daysLeft = Math.ceil((validTo.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft <= 0) return 'Expires today';
  if (daysLeft === 1) return 'Expires tomorrow';
  return `Expires in ${daysLeft} days`;
}

export function rewardCouponToDto(coupon: CouponWithRedemptions, now: Date = new Date()): RewardCouponDto {
  const usedAt = coupon.redemptions[0]?.createdAt ?? null;
  const status = deriveRewardCouponStatus(usedAt, coupon.validTo, now);

  return {
    code: coupon.code,
    origin: coupon.origin,
    status,
    discountValue: coupon.discountValue,
    maxDiscountPaise: coupon.maxDiscountPaise,
    minOrderPaise: coupon.minOrderPaise,
    issuedAt: coupon.createdAt.toISOString(),
    expiresAt: coupon.validTo?.toISOString() ?? null,
    expiresInLabel: expiresInLabel(coupon.validTo, status, now),
    usedAt: usedAt?.toISOString() ?? null,
  };
}
