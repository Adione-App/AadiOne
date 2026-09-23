/**
 * Referral data access. No decisions here — the service owns policy.
 */

import type { Coupon, Referral, User } from '@prisma/client';
import { CouponOrigin, ReferralStatus } from '../../shared';
import { prisma, type DbClient, type Tx } from '../../infra/db/prisma';

export async function findUserByReferralCode(
  code: string,
  client: DbClient = prisma,
): Promise<User | null> {
  return client.user.findUnique({ where: { referralCode: code } });
}

export async function findUserById(
  id: string,
  client: DbClient = prisma,
): Promise<User | null> {
  return client.user.findUnique({ where: { id } });
}

/** Sets the "who referred me" pointer — a plain user update, not the fuller
 * `Referral` lifecycle row (see `createReferral`, written alongside it). */
export async function setReferredBy(
  userId: string,
  referrerUserId: string,
  client: DbClient = prisma,
): Promise<void> {
  await client.user.update({
    where: { id: userId },
    data: { referredByUserId: referrerUserId },
  });
}

export async function createReferral(
  input: { referrerUserId: string; referredUserId: string; referralCode: string },
  client: DbClient = prisma,
): Promise<Referral> {
  return client.referral.create({
    data: {
      referrerUserId: input.referrerUserId,
      referredUserId: input.referredUserId,
      referralCode: input.referralCode,
      // See referral.service.ts's `applyReferralCode` doc comment — there is
      // no separate "invited" phase in this app, so REGISTERED and
      // FIRST_ORDER_PENDING collapse into this one write.
      status: ReferralStatus.FIRST_ORDER_PENDING,
    },
  });
}

export async function findByReferredUserId(
  referredUserId: string,
  client: DbClient = prisma,
): Promise<Referral | null> {
  return client.referral.findUnique({ where: { referredUserId } });
}

/**
 * Row-locked read for the reward-issuance transaction — see `tryRewardForOrder`.
 * `SELECT id ... FOR UPDATE` (raw, minimal columns only — a `SELECT *` would
 * come back with snake_case DB column names, not the Prisma model's camelCase
 * fields, exactly like `order-state.service.ts`'s own lock query) just holds
 * the row lock; the actual typed row is read normally right after, still
 * inside the same transaction/lock.
 */
export async function lockForReward(
  referredUserId: string,
  tx: Tx,
): Promise<Referral | null> {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM referrals WHERE referred_user_id = ${referredUserId}::uuid FOR UPDATE`;
  if (!locked) return null;
  return tx.referral.findUniqueOrThrow({ where: { id: locked.id } });
}

export async function markRewardIssued(
  referralId: string,
  data: { firstEligibleOrderId: string; issuedAt: Date },
  client: DbClient = prisma,
): Promise<void> {
  await client.referral.update({
    where: { id: referralId },
    data: {
      status: ReferralStatus.REWARD_ISSUED,
      firstEligibleOrderId: data.firstEligibleOrderId,
      completedAt: data.issuedAt,
      rewardIssuedAt: data.issuedAt,
    },
  });
}

export async function createRewardCoupon(
  input: {
    code: string;
    issuedToUserId: string;
    referralId: string;
    discountValuePaise: number;
    minOrderPaise: number;
    validFrom: Date;
    validTo: Date;
  },
  client: DbClient = prisma,
): Promise<Coupon> {
  return client.coupon.create({
    data: {
      code: input.code,
      description: 'Refer & Earn reward',
      type: 'FLAT',
      discountValue: input.discountValuePaise,
      minOrderPaise: input.minOrderPaise,
      validFrom: input.validFrom,
      validTo: input.validTo,
      usageLimitTotal: 1,
      usageLimitPerUser: 1,
      isActive: true,
      issuedToUserId: input.issuedToUserId,
      issuedForReferralId: input.referralId,
      origin: CouponOrigin.REFERRAL_REWARD,
    },
  });
}

export async function couponCodeExists(code: string, client: DbClient = prisma): Promise<boolean> {
  const found = await client.coupon.findUnique({ where: { code }, select: { id: true } });
  return found !== null;
}

/* -------------------------------------------------------------------------- */
/* Customer-facing reads                                                     */
/* -------------------------------------------------------------------------- */

export type CouponWithRedemptions = Coupon & { redemptions: { id: string; createdAt: Date }[] };

export async function listMyCoupons(
  userId: string,
  client: DbClient = prisma,
): Promise<CouponWithRedemptions[]> {
  return client.coupon.findMany({
    where: { issuedToUserId: userId },
    include: { redemptions: { select: { id: true, createdAt: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export type ReferralWithReferred = Referral & {
  referred: Pick<User, 'fullName'>;
  rewardCoupon: Pick<Coupon, 'code'> | null;
};

export async function listReferralsMade(
  referrerUserId: string,
  client: DbClient = prisma,
): Promise<ReferralWithReferred[]> {
  return client.referral.findMany({
    where: { referrerUserId },
    include: {
      referred: { select: { fullName: true } },
      rewardCoupon: { select: { code: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/* -------------------------------------------------------------------------- */
/* Admin reads                                                                */
/* -------------------------------------------------------------------------- */

export type ReferralAdminRow = Referral & {
  referrer: Pick<User, 'mobile' | 'fullName'>;
  referred: Pick<User, 'mobile' | 'fullName'>;
  rewardCoupon: Pick<Coupon, 'code' | 'validTo'> & { redemptions: { id: string }[] } | null;
};

export async function listForAdmin(
  page: number,
  limit: number,
  client: DbClient = prisma,
): Promise<{ rows: ReferralAdminRow[]; total: number }> {
  const [rows, total] = await Promise.all([
    client.referral.findMany({
      include: {
        referrer: { select: { mobile: true, fullName: true } },
        referred: { select: { mobile: true, fullName: true } },
        rewardCoupon: {
          select: { code: true, validTo: true, redemptions: { select: { id: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }) as Promise<ReferralAdminRow[]>,
    client.referral.count(),
  ]);

  return { rows, total };
}

export interface AdminReferralStats {
  totalReferrals: number;
  completedReferrals: number;
  pendingReferrals: number;
  rewardsIssued: number;
  couponsUsed: number;
  couponsExpired: number;
}

export async function getAdminStats(client: DbClient = prisma): Promise<AdminReferralStats> {
  const [total, rewardIssued, redeemedCount, expiredCount] = await Promise.all([
    client.referral.count(),
    client.referral.count({ where: { status: ReferralStatus.REWARD_ISSUED } }),
    client.coupon.count({
      where: { origin: CouponOrigin.REFERRAL_REWARD, redemptions: { some: {} } },
    }),
    client.coupon.count({
      where: {
        origin: CouponOrigin.REFERRAL_REWARD,
        validTo: { lt: new Date() },
        redemptions: { none: {} },
      },
    }),
  ]);

  return {
    totalReferrals: total,
    completedReferrals: rewardIssued,
    pendingReferrals: total - rewardIssued,
    rewardsIssued: rewardIssued,
    couponsUsed: redeemedCount,
    couponsExpired: expiredCount,
  };
}
