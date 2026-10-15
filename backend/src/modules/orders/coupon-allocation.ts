/**
 * Aadione-funded coupon allocation (approved policy, 2026-10-15: proportional
 * allocation; the coupon is Aadione's expense).
 *
 * An order-level coupon is split across the order's lines in proportion to
 * each line's `lineTotalPaise` — the amount the coupon was computed on (see
 * pricing.service.ts's computeBill: coupons apply to the items subtotal only,
 * never to delivery or platform fees). A seller's share is the exact sum of
 * its lines' shares.
 *
 * WHAT A SHARE MEANS
 *   - the customer paid `lineTotalPaise - share` for the line, so cancelling
 *     it refunds that, never the pre-coupon amount;
 *   - the seller is NOT charged for it: seller payable stays
 *     subtotalPaise - commissionPaise, and commission is still charged on
 *     the pre-coupon lineTotalPaise;
 *   - for Aadione it is promotional expense, reported next to the
 *     commission it earned on that portion.
 *
 * ROUNDING — largest remainder: every line gets floor(coupon * line / total),
 * and the few paise left over go one each to the lines with the largest
 * remainders (ties: earlier line first). The shares therefore sum EXACTLY to
 * the coupon, and no share ever exceeds its own line. Integer paise only;
 * BigInt for the products so no amount can lose precision.
 * The backfill in migration 20261015120000 applies the same rule to orders
 * placed before this existed (breaking ties by line id instead).
 */

export function allocateProportionally(totalPaise: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(totalPaise) || totalPaise < 0) {
    throw new Error(`allocateProportionally: invalid total ${totalPaise}`);
  }
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new Error('allocateProportionally: weights must be non-negative integers');
  }
  const weightTotal = weights.reduce((sum, w) => sum + BigInt(w), 0n);
  if (totalPaise === 0 || weights.length === 0) return weights.map(() => 0);
  if (weightTotal === 0n) throw new Error('allocateProportionally: nothing to allocate across');
  if (BigInt(totalPaise) > weightTotal) {
    throw new Error(`allocateProportionally: ${totalPaise} exceeds the allocation base ${weightTotal}`);
  }

  const total = BigInt(totalPaise);
  const base = weights.map((w) => (total * BigInt(w)) / weightTotal);
  const remainder = weights.map((w) => (total * BigInt(w)) % weightTotal);
  let leftover = Number(total - base.reduce((sum, b) => sum + b, 0n));

  const order = weights
    .map((_, index) => index)
    .sort((a, b) => (remainder[b]! > remainder[a]! ? 1 : remainder[b]! < remainder[a]! ? -1 : a - b));
  const shares = base.map(Number);
  for (const index of order) {
    if (leftover === 0) break;
    shares[index]! += 1;
    leftover -= 1;
  }
  return shares;
}

/** What the customer actually paid for a seller portion (or line) after its coupon share. */
export function customerPaidPaise(subtotalPaise: number, couponDiscountPaise: number): number {
  return Math.max(0, subtotalPaise - couponDiscountPaise);
}
