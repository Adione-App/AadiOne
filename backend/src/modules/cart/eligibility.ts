/**
 * Can THIS cart line be ordered right now — the one rule shared by the cart
 * (which lines count towards the bill and checkout), the checkout quote and
 * order placement (re-checked inside its transaction). Pure: the caller
 * supplies the seller's current status (store-availability.ts).
 *
 * A line that cannot be ordered STAYS in the cart, marked with why, until the
 * customer removes it or it becomes orderable again (store reopens, product
 * back on sale, restocked). Only a line whose product, variant or seller was
 * deleted is gone for good (`isGone`): nothing could ever make it orderable.
 *
 * Precedence: the store first (the customer can do nothing about it, and it
 * covers every line of that store), then the product, then stock.
 */

import { ApprovalStatus, type StoreClosedReason } from '../../shared';
import type { StoreStatus } from '../sellers/store-availability';

export type CartLineUnavailableReason = 'STORE_CLOSED' | 'PRODUCT_UNAVAILABLE' | 'OUT_OF_STOCK';

export interface CartLineInput {
  seller: { name: string; isActive: boolean; deletedAt: Date | null; onboardingStatus: string };
  product: { status: string; deletedAt: Date | null; approvalStatus: string };
  variant: { status: string; deletedAt: Date | null };
  listing: { isAvailable: boolean };
  /** Units that can be sold now; null = made to order (no stock count). */
  availableQty: number | null;
  /** The seller's current status (store-availability.ts). */
  store: StoreStatus;
  /** "Basmati Rice 1 kg" — for the messages. */
  displayName: string;
}

export interface CartLineEligibility {
  orderable: boolean;
  reason: CartLineUnavailableReason | null;
  /** Set when reason = STORE_CLOSED. */
  storeClosedReason: StoreClosedReason | null;
  /** Customer-facing sentence; null when orderable. */
  message: string | null;
}

/** Deleted product, variant or seller: the line can never be ordered again. */
export function isGone(input: Pick<CartLineInput, 'seller' | 'product' | 'variant'>): boolean {
  return input.seller.deletedAt !== null || input.product.deletedAt !== null || input.variant.deletedAt !== null;
}

export function cartLineEligibility(input: CartLineInput): CartLineEligibility {
  const unavailable = (
    reason: CartLineUnavailableReason,
    message: string,
    storeClosedReason: StoreClosedReason | null = null,
  ): CartLineEligibility => ({ orderable: false, reason, storeClosedReason, message });

  const { seller, product, variant, store } = input;
  // Admin deactivation and onboarding are the seller's trading state; the
  // availability rule already puts admin deactivation first.
  if (!store.acceptingOrders) {
    return unavailable('STORE_CLOSED', store.message ?? `${seller.name} is not taking orders right now.`, store.closedReason);
  }
  if (!seller.isActive || seller.onboardingStatus !== ApprovalStatus.APPROVED) {
    return unavailable('STORE_CLOSED', `${seller.name} is not taking orders right now.`, 'SELLER_INACTIVE');
  }
  if (
    product.status !== 'ACTIVE' ||
    product.approvalStatus !== ApprovalStatus.APPROVED ||
    variant.status !== 'ACTIVE'
  ) {
    return unavailable('PRODUCT_UNAVAILABLE', `${input.displayName} is not available right now.`);
  }
  if (!input.listing.isAvailable || (input.availableQty !== null && input.availableQty <= 0)) {
    return unavailable('OUT_OF_STOCK', `${input.displayName} is out of stock right now.`);
  }
  return { orderable: true, reason: null, storeClosedReason: null, message: null };
}
