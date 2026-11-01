/**
 * Coupon release on an eligible cancellation (approved policy 2026-10-31).
 *
 * When a WHOLE order is cancelled — every seller portion cancelled or
 * rejected, or cancelled before it was ever paid — or its payment fails, the
 * coupon use it consumed is given back:
 *   - the redemption row is KEPT (history) and stamped released_at /
 *     release_reason by ONE conditional update (`released_at IS NULL`), so a
 *     repeated event, a webhook replay or two concurrent cancellations
 *     release it exactly once — the second waits on the row lock and then
 *     matches nothing;
 *   - the coupon's used_count is decremented for exactly the rows released
 *     (never below zero); per-user limits ignore released rows;
 *   - the coupon itself is untouched: same expiry, same limits, same code —
 *     no new coupon is issued, nothing is extended.
 * A partial cancellation releases nothing (the coupon still discounts the
 * portions being delivered). Referral rewards and reversals are unchanged.
 *
 * Runs inside the transaction that moves the order to CANCELLED /
 * PAYMENT_FAILED (order-state.service.ts).
 */

import { moduleLogger } from '../../common/logger';
import type { Tx } from '../../infra/db/prisma';

const log = moduleLogger('coupon-release');

export type CouponReleaseReason = 'ORDER_CANCELLED' | 'PAYMENT_FAILED';

export async function releaseCouponRedemptions(tx: Tx, orderId: string, reason: CouponReleaseReason): Promise<number> {
  const released = await tx.$queryRaw<{ id: string; coupon_id: string }[]>`
    UPDATE coupon_redemptions
    SET released_at = now(), release_reason = ${reason}
    WHERE order_id = ${orderId}::uuid AND released_at IS NULL
    RETURNING id, coupon_id`;
  for (const row of released) {
    await tx.$executeRaw`
      UPDATE coupons SET used_count = used_count - 1, updated_at = now()
      WHERE id = ${row.coupon_id}::uuid AND used_count > 0`;
  }
  if (released.length > 0) {
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        action: 'coupon.redemption_release',
        entityType: 'Order',
        entityId: orderId,
        after: { reason, redemptions: released.map((r) => ({ redemptionId: r.id, couponId: r.coupon_id })) },
      },
    });
    log.info({ orderId, reason, released: released.length }, 'coupon use given back');
  }
  return released.length;
}
