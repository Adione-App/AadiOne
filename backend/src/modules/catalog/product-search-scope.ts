/**
 * Who may find which products through Smart Search.
 *
 * The engine (infra/search/engine.ts) ranks; these predicates over
 * `products p` decide visibility, and every search call passes one. They
 * restate nothing new: each is the SAME rule the matching non-search list
 * already applies, so searching never shows more than browsing does.
 *
 *   marketplace   customer search — catalog.repository's LISTED_JOINS +
 *                 PUBLIC_PRODUCT_SQL (published product, live approved
 *                 variant, listed by a live non-food seller, switched-on
 *                 category and top category)
 *   food          customer food search — the same, for live restaurant/cafe
 *                 sellers (restaurant.service's menu rules)
 *   sellerOwn     a seller's own products (seller-product.service
 *                 findOwnProducts: submitted by that seller, not deleted)
 *   admin         every live product, optionally one seller's (submitted or
 *                 listed) — admin routes keep their own permission checks
 */

import { Prisma } from '@prisma/client';
import { MARKETPLACE_SELLER_SQL } from './catalog.repository';
import { hasStockToSellSql } from '../inventory/stock-rules';

const PUBLISHED = Prisma.sql`p.status = 'ACTIVE' AND p.deleted_at IS NULL AND p.approval_status = 'APPROVED'`;

export interface MarketplaceScopeOptions {
  inStockOnly?: boolean;
  /** The category and everything beneath it (materialised path). */
  categoryPath?: string | null;
  /** Only this seller's listings (a store page). */
  sellerId?: string | null;
}

/** Customer marketplace visibility, plus the listing's optional filters. */
export function marketplaceSearchScope(options: MarketplaceScopeOptions = {}): Prisma.Sql {
  return Prisma.sql`${PUBLISHED} AND EXISTS (
    SELECT 1
    FROM categories c
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id) AND top.is_active AND top.deleted_at IS NULL
    JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE' AND v.deleted_at IS NULL AND v.approval_status = 'APPROVED'
    JOIN seller_listings sl ON sl.variant_id = v.id
    JOIN sellers s ON s.id = sl.seller_id AND ${MARKETPLACE_SELLER_SQL}
    WHERE c.id = p.category_id AND c.is_active AND c.deleted_at IS NULL
      ${options.inStockOnly ? Prisma.sql`AND sl.is_available AND ${hasStockToSellSql('sl')}` : Prisma.empty}
      ${options.sellerId ? Prisma.sql`AND sl.seller_id = ${options.sellerId}::uuid` : Prisma.empty}
      ${
        options.categoryPath
          ? Prisma.sql`AND (c.path = ${options.categoryPath} OR c.path LIKE ${`${options.categoryPath.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`})`
          : Prisma.empty
      }
  )`;
}

/** Customer food visibility: menu items of live restaurants / cafes. */
export function foodSearchScope(options: { sellerIds?: readonly string[] } = {}): Prisma.Sql {
  const sellers =
    options.sellerIds === undefined
      ? Prisma.empty
      : options.sellerIds.length === 0
        ? Prisma.sql`AND FALSE`
        : Prisma.sql`AND sl.seller_id IN (${Prisma.join(options.sellerIds.map((id) => Prisma.sql`${id}::uuid`))})`;
  // The public menu's rule (restaurant.service loadMenu): the item's section
  // AND its menu (the section's parent) must be switched on, the section must
  // be that restaurant's own, and the listing must be switched on — a dish
  // the seller has turned off is not on the menu, so search must not find it.
  return Prisma.sql`${PUBLISHED} AND EXISTS (
    SELECT 1
    FROM categories c
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id) AND top.is_active AND top.deleted_at IS NULL
    JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE' AND v.deleted_at IS NULL AND v.approval_status = 'APPROVED'
    JOIN seller_listings sl ON sl.variant_id = v.id
    JOIN sellers s ON s.id = sl.seller_id
      AND s.deleted_at IS NULL AND s.is_active AND s.onboarding_status = 'APPROVED' AND s.seller_type IN ('RESTAURANT', 'CAFE')
    WHERE c.id = p.category_id AND c.is_active AND c.deleted_at IS NULL
      AND c.seller_id = sl.seller_id
      AND sl.is_available
      ${sellers}
  )`;
}

/** A seller's own products — never another seller's. */
export function sellerOwnSearchScope(sellerId: string): Prisma.Sql {
  return Prisma.sql`p.deleted_at IS NULL AND p.submitted_by_seller_id = ${sellerId}::uuid`;
}

/**
 * Admin: every live product, or one seller's — submitted by it or listed by
 * it (the two ways a product appears on the admin's seller-filtered lists).
 */
export function adminProductSearchScope(options: { sellerId?: string | null } = {}): Prisma.Sql {
  if (!options.sellerId) return Prisma.sql`p.deleted_at IS NULL`;
  return Prisma.sql`p.deleted_at IS NULL AND (
    p.submitted_by_seller_id = ${options.sellerId}::uuid
    OR EXISTS (
      SELECT 1 FROM product_variants v JOIN seller_listings sl ON sl.variant_id = v.id
      WHERE v.product_id = p.id AND sl.seller_id = ${options.sellerId}::uuid
    )
  )`;
}

/**
 * Products whose ORDER LINES a seller (or admin) may search by: any product,
 * deleted ones included — an old order still names what was sold. Order
 * visibility itself is enforced by the order query, not here.
 */
export const ORDER_ITEM_PRODUCT_SCOPE = Prisma.sql`TRUE`;
