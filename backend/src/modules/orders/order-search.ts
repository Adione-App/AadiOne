/**
 * Smart Search for order lists (admin Orders, seller Orders, admin seller
 * detail). One query box finds an order by any of:
 *
 *   order number   separators ignored: "ad 2611-06" finds AD261106…
 *   phone          any format: "+91 98765-43210", "98765", "43210"
 *   customer name  typo-tolerant: "rmesh" finds "Ramesh Kumar"
 *   what was sold  Smart Search over products: "aloo", "आलू", "potato",
 *                  "kela" find orders containing Potato / Banana — and the
 *                  line's own name snapshot, so an order of a product deleted
 *                  since still matches
 *
 * Returns Prisma conditions only; WHICH orders a caller may see (a seller's
 * own, placed ones…) stays in the caller's query, ANDed with these.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/db/prisma';
import { matchProductIds } from '../../infra/search';
import { normalizeIdentifier, normalizeSearchText } from '../../shared/search-text';
import { analyzeSearchQuery } from '../../shared/search-match';

/** Most orders a fuzzy name match narrows to — newest first. */
const NAME_MATCH_CAP = 500;
/** Most products an item match expands to. */
const PRODUCT_MATCH_CAP = 200;
/** Similarity a misspelt customer name needs (pg_trgm word_similarity). */
const NAME_SIMILARITY = 0.5;

export interface OrderSearchConditions {
  /** OR-ed conditions on the parent `Order`. */
  order: Prisma.OrderWhereInput[];
  /** OR-ed conditions on an order line (`OrderItem`). */
  item: Prisma.OrderItemWhereInput[];
}

/**
 * The match conditions for `term`. `sellerId` limits the fuzzy name lookup to
 * that seller's orders (an index scan of its own rows, never another
 * seller's names).
 */
export async function orderSearchConditions(term: string, options: { sellerId?: string | null } = {}): Promise<OrderSearchConditions> {
  const raw = term.trim();
  const identifier = normalizeIdentifier(raw);
  const digits = raw.replace(/\D/g, '');
  const normalized = normalizeSearchText(raw);
  const order: Prisma.OrderWhereInput[] = [];
  const item: Prisma.OrderItemWhereInput[] = [];
  if (!raw) return { order, item };

  if (identifier) order.push({ orderNumber: { contains: identifier, mode: 'insensitive' } });
  if (raw !== identifier) order.push({ orderNumber: { contains: raw, mode: 'insensitive' } });

  // A phone number in any format: the last ten digits (drops +91 / 0).
  if (digits.length > 0 && digits.length >= raw.replace(/[\s+()-]/g, '').length - 1) {
    order.push({ deliveryMobile: { contains: digits.length > 10 ? digits.slice(-10) : digits } });
  }

  if (normalized.length >= 2) {
    order.push({ deliveryFullName: { contains: raw, mode: 'insensitive' } });
    if (normalized.length >= 3) {
      const scope = options.sellerId
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM seller_orders so WHERE so.order_id = o.id AND so.seller_id = ${options.sellerId}::uuid)`
        : Prisma.empty;
      const named = await prisma.$queryRaw<{ id: string }[]>`
        SELECT o.id FROM orders o
        WHERE word_similarity(${normalized}, lower(o.delivery_full_name)) >= ${NAME_SIMILARITY} ${scope}
        ORDER BY o.created_at DESC
        LIMIT ${NAME_MATCH_CAP}`;
      if (named.length > 0) order.push({ id: { in: named.map((row) => row.id) } });
    }

    const analyzed = analyzeSearchQuery(raw);
    if (analyzed.searchable && !/^\d+$/.test(normalized.replace(/ /g, ''))) {
      const products = await matchProductIds(analyzed, Prisma.sql`TRUE`, PRODUCT_MATCH_CAP);
      if (products.size > 0) item.push({ variant: { productId: { in: [...products.keys()] } } });
      item.push({ productName: { contains: raw, mode: 'insensitive' } });
    }
  }
  return { order, item };
}

/** Conditions for an admin `Order` query: the order itself, or any of its lines. */
export async function adminOrderSearchWhere(term: string): Promise<Prisma.OrderWhereInput> {
  const { order, item } = await orderSearchConditions(term);
  const or: Prisma.OrderWhereInput[] = [...order];
  if (item.length > 0) or.push({ sellerOrders: { some: { items: { some: { OR: item } } } } });
  return or.length > 0 ? { OR: or } : {};
}

/** Conditions for a `SellerOrder` query: its parent order, or ITS OWN lines. */
export async function sellerOrderSearchWhere(term: string, sellerId: string | null): Promise<Prisma.SellerOrderWhereInput> {
  const { order, item } = await orderSearchConditions(term, { sellerId });
  const or: Prisma.SellerOrderWhereInput[] = order.map((condition) => ({ order: condition }));
  if (item.length > 0) or.push({ items: { some: { OR: item } } });
  return or.length > 0 ? { OR: or } : {};
}
