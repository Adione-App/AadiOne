/**
 * The seller dashboard's "Recent activity" — read-only, built from records
 * the platform already keeps (nothing new is written anywhere):
 *
 *   ORDER       SellerOrderStatusHistory rows the seller's team made
 *               (accept / prepare / ready / reject / cancel)
 *   STOCK       StockLedger rows that are not order-driven (manual changes)
 *   PRICE       AuditLog `inventory.price.update` on the seller's listings
 *   VISIBILITY  AuditLog `seller_listing.shown` / `seller_listing.hidden`
 *   ADMIN       AuditLog `product.admin_disable` / `product.admin_enable`
 *               on the seller's own products
 *
 * New orders, cancellations by others, product reviews, refunds and
 * settlements already reach the seller as notifications; the panel shows
 * those from the notification feed, so they are not repeated here.
 *
 * Everything is scoped by the seller id the request was authorised for.
 * Who did it is reduced to "You" / "Your team" / "AdiOne" / "System" —
 * never another person's name or id.
 */

import { ActorType, SellerOrderStatus, StockLedgerReason } from '../../shared';
import { prisma } from '../../infra/db/prisma';
import { sellerVisibleOrderWhere } from '../orders/order-visibility';

export type ActivityActor = 'You' | 'Your team' | 'AdiOne' | 'System';

interface ActivityBase {
  id: string;
  at: string;
  by: ActivityActor;
}

export type SellerActivityItem =
  | (ActivityBase & { kind: 'ORDER'; orderNumber: string; toStatus: SellerOrderStatus; reason: string | null })
  | (ActivityBase & { kind: 'STOCK'; listingId: string; productName: string; delta: number; reason: string; note: string | null })
  | (ActivityBase & { kind: 'PRICE'; listingId: string; productName: string; fromPaise: number | null; toPaise: number | null })
  | (ActivityBase & { kind: 'VISIBILITY'; listingId: string; productName: string; onSale: boolean })
  | (ActivityBase & { kind: 'ADMIN'; productId: string; productName: string; action: 'DISABLED' | 'ENABLED'; reason: string | null });

/** Stock changes a person made — order reservations/sales are not "activity". */
const MANUAL_STOCK_REASONS: StockLedgerReason[] = [
  StockLedgerReason.MANUAL_ADJUST,
  StockLedgerReason.PURCHASE,
  StockLedgerReason.DAMAGE,
  StockLedgerReason.EXPIRY,
  StockLedgerReason.RETURN,
];

const LISTING_ACTIONS = ['inventory.price.update', 'seller_listing.shown', 'seller_listing.hidden'];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const asText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export async function listSellerActivity(sellerId: string, viewerUserId: string, limit = 20): Promise<SellerActivityItem[]> {
  const [staff, listings, ownProducts] = await Promise.all([
    prisma.sellerStaff.findMany({ where: { sellerId }, select: { userId: true } }),
    prisma.sellerListing.findMany({
      where: { sellerId },
      select: { id: true, variant: { select: { product: { select: { name: true } } } } },
    }),
    prisma.product.findMany({ where: { submittedBySellerId: sellerId }, select: { id: true, name: true } }),
  ]);
  const team = new Set(staff.map((member) => member.userId));
  const listingName = new Map(listings.map((listing) => [listing.id, listing.variant.product.name]));
  const productName = new Map(ownProducts.map((product) => [product.id, product.name]));
  const by = (actorUserId: string | null): ActivityActor =>
    actorUserId === null ? 'System' : actorUserId === viewerUserId ? 'You' : team.has(actorUserId) ? 'Your team' : 'AdiOne';

  const [orderRows, stockRows, listingAudits, productAudits] = await Promise.all([
    prisma.sellerOrderStatusHistory.findMany({
      where: { actorType: ActorType.SELLER, sellerOrder: { sellerId, order: sellerVisibleOrderWhere } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        toStatus: true,
        reason: true,
        actorUserId: true,
        sellerOrder: { select: { order: { select: { orderNumber: true } } } },
      },
    }),
    prisma.stockLedger.findMany({
      where: { sellerListing: { sellerId }, reason: { in: MANUAL_STOCK_REASONS } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, createdAt: true, sellerListingId: true, delta: true, reason: true, note: true, actorUserId: true },
    }),
    listings.length === 0
      ? Promise.resolve([])
      : prisma.auditLog.findMany({
          where: { entityType: 'SellerListing', entityId: { in: [...listingName.keys()] }, action: { in: LISTING_ACTIONS } },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, createdAt: true, action: true, entityId: true, before: true, after: true, actorUserId: true },
        }),
    ownProducts.length === 0
      ? Promise.resolve([])
      : prisma.auditLog.findMany({
          where: {
            entityType: 'Product',
            entityId: { in: [...productName.keys()] },
            action: { in: ['product.admin_disable', 'product.admin_enable'] },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, createdAt: true, action: true, entityId: true, after: true },
        }),
  ]);

  const items: SellerActivityItem[] = [
    ...orderRows.map((row): SellerActivityItem => ({
      kind: 'ORDER',
      id: `o-${row.id}`,
      at: row.createdAt.toISOString(),
      by: by(row.actorUserId),
      orderNumber: row.sellerOrder.order.orderNumber,
      toStatus: row.toStatus,
      reason: row.reason,
    })),
    ...stockRows.map((row): SellerActivityItem => ({
      kind: 'STOCK',
      id: `s-${row.id}`,
      at: row.createdAt.toISOString(),
      by: by(row.actorUserId),
      listingId: row.sellerListingId,
      productName: listingName.get(row.sellerListingId) ?? 'A product',
      delta: row.delta,
      reason: row.reason,
      // Seller notes are stored as "seller: <text>" (seller-listing.service).
      note: row.note?.startsWith('seller: ') ? row.note.slice('seller: '.length) : null,
    })),
    ...listingAudits.map((row): SellerActivityItem => {
      const listingId = row.entityId ?? '';
      const base = { at: row.createdAt.toISOString(), by: by(row.actorUserId), listingId, productName: listingName.get(listingId) ?? 'A product' };
      return row.action === 'inventory.price.update'
        ? {
            kind: 'PRICE',
            id: `a-${row.id}`,
            ...base,
            fromPaise: asNumber(asRecord(row.before)['pricePaise']),
            toPaise: asNumber(asRecord(row.after)['pricePaise']),
          }
        : { kind: 'VISIBILITY', id: `a-${row.id}`, ...base, onSale: row.action === 'seller_listing.shown' };
    }),
    ...productAudits.map((row): SellerActivityItem => {
      const productId = row.entityId ?? '';
      return {
        kind: 'ADMIN',
        id: `a-${row.id}`,
        at: row.createdAt.toISOString(),
        by: 'AdiOne',
        productId,
        productName: productName.get(productId) ?? 'A product',
        action: row.action === 'product.admin_disable' ? 'DISABLED' : 'ENABLED',
        reason: row.action === 'product.admin_disable' ? asText(asRecord(row.after)['reason']) : null,
      };
    }),
  ];

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
