/**
 * Seller product removal and bulk actions (seller panel → Products).
 *
 *   DELETE /seller/products/:id     marketplace sellers: removeOwnProduct()
 *                                   (restaurants/cafes keep deleteOwnFoodItem)
 *   POST   /seller/products/bulk    hide / show / delete up to 100 of the
 *                                   seller's own products, each reported
 *
 * Removing a product never rewrites history:
 *
 *   in progress   an order with the product that is not finished yet (not
 *                 delivered, cancelled, failed or refunded, and the seller's
 *                 part not rejected/cancelled) blocks removal — hide it now,
 *                 remove it once those orders are done.
 *   DELETED       nothing else points at it (no order, no approval review, no
 *                 commission rule): the product, its variants, images,
 *                 listing, stock ledger, cart lines and back-in-stock
 *                 subscriptions are deleted, and image files nothing else
 *                 uses — no other row and no retained bulk import — are
 *                 removed from storage after the commit.
 *   ARCHIVED      it has order or review history: soft delete exactly like a
 *                 restaurant's food item (deletedAt, INACTIVE, listing
 *                 unavailable). Gone from the seller's catalogue and from
 *                 customers; orders, payments and reviews keep their rows.
 *
 * Checkout holds the listing row lock while it writes order items, so removal
 * locks the product's listings first: an order committing concurrently is
 * either seen (and blocks / archives) or waits and then finds no listing.
 * Another seller's product — or a missing one — is NOT_FOUND, never "not yours".
 */

import { ProductStatus } from '@prisma/client';
import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { changeOwnProductStatus, deleteOwnFoodItem, sellerIsFood } from './product-approval.service';
import { removeProductImageFileIfUnused } from './uploaded-image.service';

const log = moduleLogger('seller-product-removal');

export type ProductRemovalOutcome = 'DELETED' | 'ARCHIVED';

export interface ProductRemovalResult {
  id: string;
  name: string;
  outcome: ProductRemovalOutcome;
  message: string;
}

/** Order statuses after which the order no longer needs the product. */
const FINISHED_ORDER_STATUSES = ['DELIVERED', 'CANCELLED', 'PAYMENT_FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
const FINISHED_SELLER_ORDER_STATUSES = ['REJECTED', 'CANCELLED'];

export const BULK_PRODUCT_LIMIT = 100;

export async function removeOwnProduct(sellerId: string, productId: string, actorUserId: string): Promise<ProductRemovalResult> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, name: true, status: true, categoryId: true, submittedBySellerId: true },
  });
  if (!product || product.submittedBySellerId !== sellerId) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  }
  // Aadione's moderation lock is Aadione's to lift (same rule as show/hide).
  if (product.status === ProductStatus.ARCHIVED) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: 'Aadione has disabled this product, so it cannot be deleted. Contact Aadione if it should be removed.',
      internalMessage: `seller ${sellerId} tried to delete admin-disabled product ${productId}`,
    });
  }

  const imageUrls: string[] = [];
  const outcome = await runInTransaction(
    async (tx): Promise<ProductRemovalOutcome> => {
      // Same lock order as checkout (listing rows), then the product row.
      await tx.$queryRaw`
        SELECT sl.id FROM seller_listings sl JOIN product_variants v ON v.id = sl.variant_id
         WHERE v.product_id = ${productId}::uuid ORDER BY sl.id FOR UPDATE OF sl`;
      const locked = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
      if (!locked[0] || locked[0].deleted_at !== null) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });

      const [usage] = await tx.$queryRaw<{ open_orders: number; orders: number; reviews: number; rules: number }[]>`
        WITH vs AS (SELECT id FROM product_variants WHERE product_id = ${productId}::uuid),
             ls AS (SELECT id FROM seller_listings WHERE variant_id IN (SELECT id FROM vs)),
             items AS (
               SELECT oi.seller_order_id FROM order_items oi
                WHERE oi.variant_id IN (SELECT id FROM vs) OR oi.seller_listing_id IN (SELECT id FROM ls))
        SELECT
          (SELECT count(DISTINCT so.id)::int FROM items JOIN seller_orders so ON so.id = items.seller_order_id JOIN orders o ON o.id = so.order_id
            WHERE o.status::text <> ALL(${FINISHED_ORDER_STATUSES}) AND so.status::text <> ALL(${FINISHED_SELLER_ORDER_STATUSES})) AS open_orders,
          (SELECT count(*)::int FROM items) AS orders,
          (SELECT count(*)::int FROM product_approval_batch_items WHERE product_id = ${productId}::uuid) AS reviews,
          (SELECT count(*)::int FROM commission_rules WHERE product_id = ${productId}::uuid) AS rules`;
      if (usage!.open_orders > 0) {
        throw new AppError(ErrorCode.ORDER_IN_PROGRESS, {
          message: `${usage!.open_orders} order${usage!.open_orders === 1 ? '' : 's'} with this product ${usage!.open_orders === 1 ? 'is' : 'are'} still in progress. Hide the product now and delete it after ${usage!.open_orders === 1 ? 'that order is' : 'those orders are'} completed.`,
        });
      }

      const before = { name: product.name, categoryId: product.categoryId, status: product.status };
      if (usage!.orders > 0 || usage!.reviews > 0 || usage!.rules > 0) {
        await tx.product.update({ where: { id: productId }, data: { deletedAt: new Date(), status: ProductStatus.INACTIVE } });
        // The listing stays (order history points at it) but can never be bought again.
        await tx.sellerListing.updateMany({ where: { sellerId, variant: { productId } }, data: { isAvailable: false } });
        await tx.auditLog.create({
          data: { actorUserId, action: 'product.seller_delete', entityType: 'Product', entityId: productId, before, after: { deleted: true, kept: { orders: usage!.orders, reviews: usage!.reviews, rules: usage!.rules } } },
        });
        return 'ARCHIVED';
      }

      const [images, variants] = await Promise.all([
        tx.productImage.findMany({ where: { productId }, select: { url: true, thumbUrl: true, cardUrl: true } }),
        tx.productVariant.findMany({ where: { productId }, select: { sku: true, imageUrl: true } }),
      ]);
      for (const i of images) imageUrls.push(i.url, ...(i.thumbUrl ? [i.thumbUrl] : []), ...(i.cardUrl ? [i.cardUrl] : []));
      for (const v of variants) if (v.imageUrl) imageUrls.push(v.imageUrl);
      // Cascades: variants, images, listings, stock ledger, cart lines, back-in-stock subscriptions.
      await tx.product.delete({ where: { id: productId } });
      await tx.auditLog.create({
        data: { actorUserId, action: 'product.seller_delete_permanent', entityType: 'Product', entityId: productId, before: { ...before, skus: variants.map((v) => v.sku) }, after: { deleted: true } },
      });
      return 'DELETED';
    },
    { timeoutMs: 20_000 },
  );

  if (outcome === 'DELETED') {
    // Only files no other row (product, order snapshot, banner, …) still uses —
    // and no retained bulk import either: its failed rows can be retried and a
    // running import may still attach the same photo. Import retention
    // (releaseImportImages) removes those files once nothing uses them.
    for (const url of new Set(imageUrls)) await removeProductImageFileIfUnused(url);
  }
  log.info({ sellerId, productId, outcome }, 'seller removed product');
  return {
    id: productId,
    name: product.name,
    outcome,
    message:
      outcome === 'DELETED'
        ? `${product.name} was deleted permanently.`
        : `${product.name} was removed from your catalogue. It has order or review history, so that record is kept for your orders and payments.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Bulk                                                                        */
/* -------------------------------------------------------------------------- */

export type BulkProductAction = 'HIDE' | 'SHOW' | 'DELETE';
export type BulkItemOutcome = ProductRemovalOutcome | 'HIDDEN' | 'SHOWN' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';

export interface BulkProductResult {
  action: BulkProductAction;
  results: { productId: string; name: string | null; outcome: BulkItemOutcome; message: string }[];
  counts: Record<BulkItemOutcome, number>;
}

/**
 * One by one (each product is its own transaction), so one product's problem
 * never undoes the others and a repeated request is harmless: an already
 * removed product is SKIPPED, an already hidden one UNCHANGED.
 */
export async function bulkProductAction(sellerId: string, action: BulkProductAction, productIds: string[], actorUserId: string): Promise<BulkProductResult> {
  const ids = [...new Set(productIds)];
  const names = new Map(
    (await prisma.product.findMany({ where: { id: { in: ids }, submittedBySellerId: sellerId, deletedAt: null }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
  );
  const food = action === 'DELETE' && (await sellerIsFood(sellerId));
  const results: BulkProductResult['results'] = [];

  for (const productId of ids) {
    const name = names.get(productId) ?? null;
    if (name === null) {
      results.push({ productId, name, outcome: 'SKIPPED', message: 'Not found in your products (it may already be removed).' });
      continue;
    }
    try {
      if (action === 'DELETE') {
        if (food) {
          await deleteOwnFoodItem(sellerId, productId, actorUserId);
          results.push({ productId, name, outcome: 'ARCHIVED', message: `${name} was removed from your menu.` });
        } else {
          const removed = await removeOwnProduct(sellerId, productId, actorUserId);
          results.push({ productId, name, outcome: removed.outcome, message: removed.message });
        }
      } else {
        const status = action === 'HIDE' ? ProductStatus.INACTIVE : ProductStatus.ACTIVE;
        const changed = await changeOwnProductStatus(sellerId, productId, status, actorUserId);
        results.push({
          productId,
          name,
          outcome: changed ? (action === 'HIDE' ? 'HIDDEN' : 'SHOWN') : 'UNCHANGED',
          message: changed ? `${name} is now ${action === 'HIDE' ? 'hidden from' : 'shown to'} customers.` : `${name} was already ${action === 'HIDE' ? 'hidden' : 'shown'}.`,
        });
      }
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        results.push({ productId, name, outcome: 'SKIPPED', message: error.message });
      } else {
        log.error({ err: error, sellerId, productId, action }, 'bulk product action failed');
        results.push({ productId, name, outcome: 'FAILED', message: 'Something went wrong with this product. Try again.' });
      }
    }
  }

  const counts = { DELETED: 0, ARCHIVED: 0, HIDDEN: 0, SHOWN: 0, UNCHANGED: 0, SKIPPED: 0, FAILED: 0 } as Record<BulkItemOutcome, number>;
  for (const r of results) counts[r.outcome] += 1;
  return { action, results, counts };
}
