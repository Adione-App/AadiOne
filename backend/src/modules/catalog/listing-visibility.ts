/**
 * Can a customer buy this seller's product right now — and if not, why?
 *
 * The seller-panel answer to the same question cart/checkout ask. It REUSES
 * cart/orderability.ts's `unorderableReason` (store trading + product
 * sellable) rather than restating it, then adds the listing-level states the
 * existing out-of-stock handling covers (on-sale switch, available stock).
 * Pure: no I/O.
 *
 * Who controls what (never overridable from below):
 *   STORE_DEACTIVATED / STORE_NOT_APPROVED   admin (Seller.isActive, onboarding)
 *   DISABLED_BY_ADMIN                        admin (Product.status = ARCHIVED)
 *   PENDING_APPROVAL / REJECTED              admin review (approval workflow)
 *   HIDDEN_BY_SELLER                         seller (Product.status = INACTIVE)
 *   OFF_SALE                                 seller (SellerListing.isAvailable)
 *   OUT_OF_STOCK                             stock − reserved ≤ 0
 */

import { ApprovalStatus, ProductStatus } from '../../shared';
import { unorderableReason } from '../cart/orderability';

export type ListingVisibilityReason =
  | 'VISIBLE'
  | 'STORE_DEACTIVATED'
  | 'STORE_NOT_APPROVED'
  | 'DISABLED_BY_ADMIN'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'HIDDEN_BY_SELLER'
  | 'NOT_LISTED'
  | 'OFF_SALE'
  | 'OUT_OF_STOCK';

export interface ListingVisibility {
  /** True when a customer can buy it now (store hours and serviceability aside). */
  sellable: boolean;
  reason: ListingVisibilityReason;
  availableQty: number;
  /** In stock but at or below the listing's low-stock threshold. */
  lowStock: boolean;
}

export interface ListingVisibilityInput {
  store: { isActive: boolean; deletedAt: Date | null; onboardingStatus: string };
  product: { status: string; deletedAt: Date | null; approvalStatus: string };
  /** The default variant; absent only for a product with no live variant. */
  variant: { status: string; deletedAt: Date | null } | null;
  listing: { isAvailable: boolean; stockQty: number; reservedQty: number; lowStockThreshold: number } | null;
}

export function listingVisibility(input: ListingVisibilityInput): ListingVisibility {
  const availableQty = input.listing ? Math.max(0, input.listing.stockQty - input.listing.reservedQty) : 0;
  const lowStock =
    input.listing !== null && availableQty > 0 && availableQty <= input.listing.lowStockThreshold;
  const result = (reason: ListingVisibilityReason): ListingVisibility => ({
    sellable: reason === 'VISIBLE',
    reason,
    availableQty,
    lowStock,
  });

  const blocked = unorderableReason({
    seller: input.store,
    product: input.product,
    variant: input.variant ?? { status: ProductStatus.INACTIVE, deletedAt: null },
  });
  if (blocked === 'SELLER_NOT_TRADING') {
    return result(input.store.isActive && input.store.deletedAt === null ? 'STORE_NOT_APPROVED' : 'STORE_DEACTIVATED');
  }
  if (blocked === 'PRODUCT_NOT_SELLABLE') {
    if (input.product.status === ProductStatus.ARCHIVED || input.product.deletedAt !== null) return result('DISABLED_BY_ADMIN');
    if (input.product.approvalStatus === ApprovalStatus.REJECTED) return result('REJECTED');
    if (input.product.approvalStatus !== ApprovalStatus.APPROVED) return result('PENDING_APPROVAL');
    if (input.product.status === ProductStatus.INACTIVE) return result('HIDDEN_BY_SELLER');
    // Draft / no live variant: not something the seller can switch on.
    return result('DISABLED_BY_ADMIN');
  }
  if (!input.listing) return result('NOT_LISTED');
  if (!input.listing.isAvailable) return result('OFF_SALE');
  if (availableQty <= 0) return result('OUT_OF_STOCK');
  return result('VISIBLE');
}

/** An admin restriction the seller can't lift (the "can't override admin" rule). */
export function isAdminRestricted(reason: ListingVisibilityReason): boolean {
  return reason === 'STORE_DEACTIVATED' || reason === 'DISABLED_BY_ADMIN';
}
