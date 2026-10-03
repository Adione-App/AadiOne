/**
 * Whether a customer may buy a specific SellerListing right now — the ONE
 * rule shared by cart add, cart revalidation (which also backs the checkout
 * quote) and order placement (the authoritative, in-transaction check).
 *
 * Every condition comes from a rule the V2 schema/services already state;
 * none is new:
 *   - Seller.deletedAt   — soft-deleted sellers are gone.
 *   - Seller.isActive    — the seller's own trading switch (an inactive
 *                          seller cannot even receive new listings; see
 *                          admin-seller-catalog.service.ts).
 *   - Seller.onboardingStatus — "A seller cannot go live while this is not
 *                          APPROVED, even if `isActive` is set" (Seller model
 *                          doc comment). Listing creation for a not-yet-
 *                          approved seller stays allowed (admin can stage a
 *                          catalog); such a listing simply is not buyable.
 *   - Product.approvalStatus — "the single gate that matters downstream"
 *                          (product-approval.service.ts); an APPROVED product
 *                          sent back for review is not buyable meanwhile.
 *   - Product/Variant ACTIVE and not deleted — unchanged from before.
 *
 * Stock and `SellerListing.isAvailable` stay with the existing out-of-stock
 * handling (they are "temporarily unavailable", not "not sellable").
 */

import { ApprovalStatus } from '../../shared';

export interface OrderabilityInput {
  seller: { isActive: boolean; deletedAt: Date | null; onboardingStatus: string };
  product: { status: string; deletedAt: Date | null; approvalStatus: string };
  variant: { status: string; deletedAt: Date | null };
}

export type UnorderableReason = 'SELLER_NOT_TRADING' | 'PRODUCT_NOT_SELLABLE';

export function unorderableReason(input: OrderabilityInput): UnorderableReason | null {
  const { seller, product, variant } = input;
  if (seller.deletedAt !== null || !seller.isActive || seller.onboardingStatus !== ApprovalStatus.APPROVED) {
    return 'SELLER_NOT_TRADING';
  }
  if (
    product.status !== 'ACTIVE' ||
    product.deletedAt !== null ||
    product.approvalStatus !== ApprovalStatus.APPROVED ||
    variant.status !== 'ACTIVE' ||
    variant.deletedAt !== null
  ) {
    return 'PRODUCT_NOT_SELLABLE';
  }
  return null;
}

/** Customer-facing wording for a line that cannot be bought. */
export function unorderableMessage(reason: UnorderableReason, productName: string, sellerName: string): string {
  return reason === 'SELLER_NOT_TRADING'
    ? `${sellerName} isn't taking orders right now, so ${productName} can't be ordered.`
    : `${productName} is no longer available.`;
}
