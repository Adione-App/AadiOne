/**
 * Refund requests — the pure money rules (unit-tested in
 * tests/unit/refund-request-rules.test.ts). The customer never sets an
 * amount: they choose items and quantities, and the server values them.
 *
 *   - An item is worth what the customer PAID for it: its line total minus
 *     its share of the Aadione-funded coupon (a coupon is never refunded as
 *     cash). Part of a line: proportional, rounded down; the whole line: the
 *     exact line amount.
 *   - What is still refundable for an item = what was paid for it minus what
 *     earlier approved requests already allocated to it. Never negative.
 *   - An approval below the requested amount is spread over the items in
 *     proportion (largest remainder, so the parts sum EXACTLY to the
 *     approved amount, never more than any item's own value).
 */

/** How long after delivery a refund can be requested. A chosen default (see the refund report). */
export const REFUND_REQUEST_WINDOW_DAYS = 7;
export const REFUND_REQUEST_WINDOW_MS = REFUND_REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** At most this many evidence photos per request; each at most MAX_EVIDENCE_BYTES. */
export const MAX_EVIDENCE_PHOTOS = 4;
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

/** Categories where a photo is the evidence — at least one is required. A chosen default (see the refund report). */
export const PHOTO_REQUIRED_CATEGORIES: readonly ('DAMAGED_ITEM' | 'WRONG_ITEM' | 'QUALITY_ISSUE')[] = ['DAMAGED_ITEM', 'WRONG_ITEM', 'QUALITY_ISSUE'];

export interface ItemValueInput {
  qty: number;
  lineTotalPaise: number;
  couponDiscountPaise: number;
}

/** What the customer paid for the whole line. */
export function linePaidPaise(item: ItemValueInput): number {
  return Math.max(0, item.lineTotalPaise - item.couponDiscountPaise);
}

/** What the customer paid for `qty` units of the line. */
export function valueOfQty(item: ItemValueInput, qty: number): number {
  if (qty <= 0 || item.qty <= 0) return 0;
  if (qty >= item.qty) return linePaidPaise(item);
  return Math.floor((linePaidPaise(item) * qty) / item.qty);
}

export interface RequestedLine {
  orderItemId: string;
  sellerOrderId: string;
  qty: number;
  /** Server-computed: min(value of qty, what is still refundable for the item). */
  amountPaise: number;
}

/**
 * Spreads `approvedPaise` over the requested lines in proportion to their
 * amounts. Exact: the parts sum to `approvedPaise`; no part exceeds its line.
 */
export function allocateApproved<T extends { amountPaise: number }>(lines: readonly T[], approvedPaise: number): (T & { approvedPaise: number })[] {
  const requested = lines.reduce((sum, l) => sum + l.amountPaise, 0);
  if (approvedPaise <= 0 || requested <= 0) return lines.map((l) => ({ ...l, approvedPaise: 0 }));
  if (approvedPaise >= requested) return lines.map((l) => ({ ...l, approvedPaise: l.amountPaise }));
  const shares = lines.map((l, index) => {
    const exact = (l.amountPaise * approvedPaise) / requested;
    return { index, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = approvedPaise - shares.reduce((sum, s) => sum + s.floor, 0);
  const order = [...shares].sort((x, y) => y.remainder - x.remainder || x.index - y.index);
  for (const share of order) {
    if (left <= 0) break;
    if (share.floor < lines[share.index]!.amountPaise) {
      share.floor += 1;
      left -= 1;
    }
  }
  return lines.map((l, index) => ({ ...l, approvedPaise: shares[index]!.floor }));
}

/** Sums the approved lines per seller order — the refund components (and later deductions). */
export function perSellerOrder(lines: readonly { sellerOrderId: string; approvedPaise: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    if (line.approvedPaise > 0) out.set(line.sellerOrderId, (out.get(line.sellerOrderId) ?? 0) + line.approvedPaise);
  }
  return out;
}

/** Detects the image type from its first bytes — the client's claimed type is never trusted. */
export function sniffImageType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
