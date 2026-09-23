/**
 * Refer & Earn — referral linkage and reward issuance.
 *
 * TWO ENTRY POINTS matter here:
 *
 *  1. `applyReferralCode` — called once, right after a brand-new account is
 *     created (see mobile's inline referral-code step in OtpVerifyScreen).
 *     Links the new user to their referrer. A user can only ever be linked
 *     once: `User.referredByUserId` is checked up front for a friendly error,
 *     and `Referral.referredUserId` being `@unique` is the DB-level backstop
 *     if two requests somehow race (falls through to the global Prisma
 *     P2002 handler as a generic "already exists" — acceptable for an edge
 *     case this rare, see errorHandler.ts).
 *
 *  2. `tryRewardForOrder` — called from INSIDE `order-state.service.ts`'s
 *     `transitionOrder` transaction, exactly when an order reaches DELIVERED.
 *     This is the one and only place a referral reward is minted. See its own
 *     doc comment for why no separate "is this the first order" query is
 *     needed, and why the `Coupon.issuedForReferralId` unique constraint
 *     (not application logic) is the real concurrency guarantee.
 */

import { ErrorCode, type ReferralAdminStatsDto, type ReferralSummaryDto } from '../../shared';
import * as configKeys from '../../shared/config-keys';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { generateRewardCouponCode } from '../../shared/text';
import * as configService from '../configuration/configuration.service';
import * as repository from './referral.repository';
import { deriveRewardCouponStatus, rewardCouponToDto } from './referral.mapper';

const log = moduleLogger('referrals');

/** Mirrors `allocateReferralCode` in auth.service.ts — same bounded-retry
 * reasoning, different alphabet/prefix (see `generateRewardCouponCode`). */
async function allocateRewardCouponCode(tx: Tx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRewardCouponCode();
    if (!(await repository.couponCodeExists(code, tx))) return code;
  }
  throw new AppError(ErrorCode.INTERNAL_ERROR, {
    internalMessage: 'could not allocate a unique reward coupon code after 5 attempts',
  });
}

/**
 * Links `userId` to whoever owns `code`, and creates the lifecycle-tracking
 * `Referral` row. Only ever succeeds once per user — see the file header.
 */
export async function applyReferralCode(userId: string, rawCode: string): Promise<void> {
  const code = rawCode.trim().toUpperCase();
  if (code.length === 0) {
    throw new AppError(ErrorCode.REFERRAL_CODE_INVALID);
  }

  const [user, referrer] = await Promise.all([
    repository.findUserById(userId),
    repository.findUserByReferralCode(code),
  ]);

  if (!user) {
    throw new AppError(ErrorCode.NOT_FOUND, { internalMessage: 'user not found' });
  }
  if (user.referredByUserId) {
    throw new AppError(ErrorCode.REFERRAL_ALREADY_LINKED);
  }
  if (!referrer) {
    throw new AppError(ErrorCode.REFERRAL_CODE_INVALID);
  }
  if (referrer.id === userId) {
    throw new AppError(ErrorCode.REFERRAL_SELF_REFERRAL);
  }

  await runInTransaction(async (tx) => {
    await repository.setReferredBy(userId, referrer.id, tx);
    await repository.createReferral(
      { referrerUserId: referrer.id, referredUserId: userId, referralCode: code },
      tx,
    );
  });

  log.info({ referrerUserId: referrer.id, referredUserId: userId }, 'referral code applied');
}

/**
 * Rewards the referrer if `order` is their referred friend's qualifying
 * first order. MUST be called from inside the same transaction that writes
 * the order's DELIVERED status (`tx` is that transaction's client) — see
 * order-state.service.ts. A no-op for every order that isn't a referred
 * user's very first qualifying one.
 *
 * "First eligible order" without re-deriving it from order history: this
 * function is the ONLY place `Referral.status` ever becomes `REWARD_ISSUED`,
 * and it runs on every single DELIVERED transition for every order. So by
 * induction, if `referral.status` is not already `REWARD_ISSUED` when this
 * order is being processed, no earlier order for this same referred user
 * ever qualified — this order is genuinely the first to reach DELIVERED at
 * or above the minimum. No separate "count prior qualifying orders" query
 * needed, and nothing to re-derive after the fact.
 */
export async function tryRewardForOrder(
  tx: Tx,
  order: { id: string; userId: string; itemsSubtotalPaise: number },
): Promise<{ referrerUserId: string; rewardCouponCode: string } | null> {
  const referral = await repository.lockForReward(order.userId, tx);
  if (!referral) return null; // this user was never referred
  if (referral.status === 'REWARD_ISSUED') return null; // already rewarded, nothing to do

  const [minOrderPaise, rewardPaise, expiryDays] = await Promise.all([
    configService.get(configKeys.ConfigKey.REFERRAL_MIN_ORDER_PAISE),
    configService.get(configKeys.ConfigKey.REFERRAL_REWARD_PAISE),
    configService.get(configKeys.ConfigKey.REFERRAL_COUPON_EXPIRY_DAYS),
  ]);

  if (order.itemsSubtotalPaise < minOrderPaise) {
    // Not this order — stays FIRST_ORDER_PENDING for a later one.
    return null;
  }

  const now = new Date();
  const validTo = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
  const code = await allocateRewardCouponCode(tx);

  await repository.createRewardCoupon(
    {
      code,
      issuedToUserId: referral.referrerUserId,
      referralId: referral.id,
      discountValuePaise: rewardPaise,
      minOrderPaise,
      validFrom: now,
      validTo,
    },
    tx,
  );

  await repository.markRewardIssued(
    referral.id,
    { firstEligibleOrderId: order.id, issuedAt: now },
    tx,
  );

  log.info(
    { referrerUserId: referral.referrerUserId, referredUserId: order.userId, orderId: order.id, code },
    'referral reward issued',
  );

  return { referrerUserId: referral.referrerUserId, rewardCouponCode: code };
}

/* -------------------------------------------------------------------------- */
/* Customer-facing reads                                                     */
/* -------------------------------------------------------------------------- */

export async function getMyCoupons(userId: string) {
  const rows = await repository.listMyCoupons(userId);
  return rows.map((row) => rewardCouponToDto(row));
}

export async function getMySummary(userId: string): Promise<ReferralSummaryDto> {
  const [user, referrals] = await Promise.all([
    repository.findUserById(userId),
    repository.listReferralsMade(userId),
  ]);

  const completedCount = referrals.filter(
    (r) => r.status === 'COMPLETED' || r.status === 'REWARD_ISSUED',
  ).length;
  const rewardsIssuedCount = referrals.filter((r) => r.status === 'REWARD_ISSUED').length;

  return {
    referralCode: user?.referralCode ?? null,
    referredCount: referrals.length,
    completedCount,
    rewardsIssuedCount,
    history: referrals.map((r) => ({
      referredDisplayName: r.referred.fullName?.trim() || 'A friend',
      status: r.status,
      rewardCouponCode: r.rewardCoupon?.code ?? null,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Admin reads                                                                */
/* -------------------------------------------------------------------------- */

export async function listForAdmin(page: number, limit: number) {
  const { rows, total } = await repository.listForAdmin(page, limit);
  return {
    items: rows.map((row) => {
      const rewardCouponStatus = row.rewardCoupon
        ? deriveRewardCouponStatus(
            row.rewardCoupon.redemptions[0] ? new Date() : null,
            row.rewardCoupon.validTo,
          )
        : null;

      return {
        id: row.id,
        referrerMobile: row.referrer.mobile,
        referrerName: row.referrer.fullName,
        referredMobile: row.referred.mobile,
        referredName: row.referred.fullName,
        referralCode: row.referralCode,
        status: row.status,
        firstEligibleOrderId: row.firstEligibleOrderId,
        rewardCouponCode: row.rewardCoupon?.code ?? null,
        rewardCouponStatus,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        rewardIssuedAt: row.rewardIssuedAt?.toISOString() ?? null,
      };
    }),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getAdminStats(): Promise<ReferralAdminStatsDto> {
  return repository.getAdminStats(prisma);
}
