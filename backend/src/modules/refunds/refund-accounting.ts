/**
 * What a refund AFTER DELIVERY takes back from the seller — approved policy
 * (final): the commission on the refunded item is REVERSED, so the seller
 * gives back exactly the net settlement it received for that item, never
 * the customer's full refund. Pure; unit-tested in
 * tests/unit/refund-accounting.test.ts.
 *
 * The canonical figures are the ones the settlement itself used, stored per
 * order item at placement (order.service.ts › placeOrder):
 *   lineTotalPaise       the seller's tax-inclusive gross for the line
 *                        (SellerOrder.subtotalPaise = Σ lineTotalPaise)
 *   commissionPaise      the line's commission, exact
 *                        (SellerOrder.commissionPaise = Σ commissionPaise)
 *   couponDiscountPaise  the line's share of the Aadione-funded coupon —
 *                        Aadione's expense, never taken from the seller
 * so for one line:
 *   customer paid   = lineTotal - couponShare         (coupon-allocation.ts)
 *   seller net      = lineTotal - commission          (seller-settlement.service.ts)
 *
 * A refund of R paise for the line (R <= customer paid) reverses the
 * fraction R / customerPaid of the line: that fraction of the seller's net
 * (the deduction), of the commission (Aadione gives it up) and of the coupon
 * share (Aadione's coupon cost, no longer borne). Full refund -> exactly the
 * seller's net, the whole commission, the whole coupon share: everyone back
 * to zero; the coupon is never charged to the seller.
 *
 * Partial refunds are CUMULATIVE per line: after a refund the line has
 * R_total refunded, and its reversals are floor(figure * R_total / paid) —
 * exactly the figure itself once R_total reaches what was paid. This refund's
 * share is that minus what earlier refunds already took. So any number of
 * partial refunds sums exactly to the full figures and can never exceed them
 * (no commission reversed twice, no deduction above the seller's net).
 */

export interface LineMoney {
  lineTotalPaise: number;
  commissionPaise: number;
  couponDiscountPaise: number;
}

export interface LineReversal {
  /** The customer refund attributed to the line by this refund. */
  refundedPaise: number;
  /** Taken back from the seller (its net settlement for this part). */
  sellerNetPaise: number;
  /** Commission Aadione gives up for this part. */
  commissionPaise: number;
  /** Aadione-funded coupon share no longer borne for this part. */
  couponPaise: number;
}

export interface PriorReversals {
  refundedPaise: number;
  sellerNetPaise: number;
  commissionPaise: number;
  couponPaise: number;
}

export const NO_PRIOR: PriorReversals = { refundedPaise: 0, sellerNetPaise: 0, commissionPaise: 0, couponPaise: 0 };

export function customerPaidForLine(line: LineMoney): number {
  return Math.max(0, line.lineTotalPaise - line.couponDiscountPaise);
}

export function sellerNetForLine(line: LineMoney): number {
  return Math.max(0, line.lineTotalPaise - line.commissionPaise);
}

/** floor(figure * refunded / paid), exactly `figure` once everything paid is refunded. */
function share(figure: number, refundedTotal: number, paid: number): number {
  if (paid <= 0 || refundedTotal <= 0 || figure <= 0) return 0;
  if (refundedTotal >= paid) return figure;
  return Math.floor((figure * refundedTotal) / paid);
}

/**
 * The reversal for `refundedNow` more paise on a line that earlier refunds
 * already reversed `prior` of. Never negative; cumulative totals never exceed
 * the line's own figures; the refund is capped at what is still unrefunded.
 */
export function reverseLine(line: LineMoney, prior: PriorReversals, refundedNow: number): LineReversal {
  const paid = customerPaidForLine(line);
  const before = Math.min(Math.max(0, prior.refundedPaise), paid);
  const now = Math.max(0, Math.min(refundedNow, paid - before));
  const total = before + now;
  const take = (figure: number, already: number) => Math.max(0, Math.min(figure, share(figure, total, paid)) - Math.max(0, already));
  return {
    refundedPaise: now,
    sellerNetPaise: take(sellerNetForLine(line), prior.sellerNetPaise),
    commissionPaise: take(Math.max(0, line.commissionPaise), prior.commissionPaise),
    couponPaise: take(Math.max(0, line.couponDiscountPaise), prior.couponPaise),
  };
}
