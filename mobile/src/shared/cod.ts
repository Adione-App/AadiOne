/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Cash-on-Delivery eligibility resolution.
 *
 * Implements PRD §17.3. Fully data-driven: there is not a single category name
 * anywhere in this file. "Fresh vegetables are not COD" is expressed by
 * setting the Vegetables category's `allowCod` to DENY in the database.
 *
 * Two levels of decision:
 *   1. per line item — walk the hierarchy outward, first non-INHERIT wins
 *   2. per order     — most restrictive wins across all items + seller + caps
 */

import { CodPolicy } from './enums';

/**
 * COD policies for one line item, ordered from most specific to least.
 * `null` entries (e.g. a product with no parent category) are skipped.
 *
 * Order: sellerListing -> productVariant -> product -> category leaf..root -> seller
 */
export interface CodPolicyChain {
  sellerListing?: CodPolicy | null;
  productVariant?: CodPolicy | null;
  product?: CodPolicy | null;
  /** Leaf category first, then each ancestor up to the root. */
  categoryChain?: readonly (CodPolicy | null)[];
  seller?: CodPolicy | null;
}

/**
 * Resolves one line item's effective COD policy.
 * `defaultPolicy` comes from the `DEFAULT_COD_POLICY` configuration key and is
 * used only when every level says INHERIT.
 */
export function resolveItemCodPolicy(
  chain: CodPolicyChain,
  defaultPolicy: CodPolicy,
): CodPolicy {
  const levels: (CodPolicy | null | undefined)[] = [
    chain.sellerListing,
    chain.productVariant,
    chain.product,
    ...(chain.categoryChain ?? []),
    chain.seller,
  ];

  for (const level of levels) {
    if (level && level !== CodPolicy.INHERIT) return level;
  }
  return defaultPolicy === CodPolicy.INHERIT ? CodPolicy.ALLOW : defaultPolicy;
}

export function isCodAllowedForItem(chain: CodPolicyChain, defaultPolicy: CodPolicy): boolean {
  return resolveItemCodPolicy(chain, defaultPolicy) === CodPolicy.ALLOW;
}

export interface OrderCodInput {
  items: {
    productName: string;
    resolvedPolicy: CodPolicy;
  }[];
  sellerPolicy: CodPolicy;
  defaultPolicy: CodPolicy;
  orderTotalPaise: number;
  codMaxOrderValuePaise: number;
  /** True when the customer has never had an order delivered. */
  isFirstOrder: boolean;
  codFirstOrderMaxPaise: number;
  /** Set when the customer has been blocked from COD by an admin. */
  customerCodBlocked?: boolean;
}

export interface OrderCodResult {
  allowed: boolean;
  /** User-safe explanation. Null when COD is allowed. */
  reason: string | null;
  /** Machine-readable cause, for analytics and tests. */
  reasonCode:
    | 'ITEM_DENIED'
    | 'SELLER_DENIED'
    | 'OVER_MAX_VALUE'
    | 'OVER_FIRST_ORDER_LIMIT'
    | 'CUSTOMER_BLOCKED'
    | null;
}

/**
 * Order-level COD eligibility. Most restrictive wins — a single denied item
 * disables COD for the whole order.
 *
 * The reason is always returned so the UI can show COD disabled *with an
 * explanation naming the offending item*, rather than silently hiding the
 * option and leaving the customer confused (PRD §4.3).
 */
export function resolveOrderCodEligibility(input: OrderCodInput): OrderCodResult {
  if (input.customerCodBlocked) {
    return {
      allowed: false,
      reason: 'Cash on Delivery is not available on this account.',
      reasonCode: 'CUSTOMER_BLOCKED',
    };
  }

  const sellerEffective =
    input.sellerPolicy === CodPolicy.INHERIT ? input.defaultPolicy : input.sellerPolicy;
  if (sellerEffective === CodPolicy.DENY) {
    return {
      allowed: false,
      reason: 'Cash on Delivery is currently unavailable.',
      reasonCode: 'SELLER_DENIED',
    };
  }

  const denied = input.items.find((item) => item.resolvedPolicy !== CodPolicy.ALLOW);
  if (denied) {
    return {
      allowed: false,
      reason: `Cash on Delivery isn't available for ${denied.productName}.`,
      reasonCode: 'ITEM_DENIED',
    };
  }

  if (input.orderTotalPaise > input.codMaxOrderValuePaise) {
    return {
      allowed: false,
      reason: 'This order is above the Cash on Delivery limit. Please pay online.',
      reasonCode: 'OVER_MAX_VALUE',
    };
  }

  if (input.isFirstOrder && input.orderTotalPaise > input.codFirstOrderMaxPaise) {
    return {
      allowed: false,
      reason: 'Cash on Delivery is limited on your first order. Please pay online.',
      reasonCode: 'OVER_FIRST_ORDER_LIMIT',
    };
  }

  return { allowed: true, reason: null, reasonCode: null };
}
