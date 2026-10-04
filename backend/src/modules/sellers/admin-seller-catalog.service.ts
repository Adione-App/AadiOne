/**
 * Seller catalogue actions that need more than one module:
 *
 *   - `moderateSellerProduct` — admin moderation of a seller's own product
 *     (disable/enable only; never content edits).
 *   - `createSellerListing` — the Seller Panel's own listing path
 *     (`POST /seller/listings`): an APPROVED product under one of the seller's
 *     OWN categories only, never a duplicate listing. Admin does not create
 *     listings for any seller — Aadione included — they all manage their own.
 */

import { ErrorCode, ProductStatus, StockLedgerReason } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { assertSellerMayUseCategoryForProduct } from '../catalog/seller-category.service';

/**
 * Admin moderation of a seller's own product — the one admin action on seller
 * catalogue data besides approval review. It never edits content: DISABLE sets
 * Product.status = ARCHIVED (not buyable; the seller cannot lift it — see
 * seller-listing.service / product-approval.service), ENABLE returns it as
 * INACTIVE (hidden) so the seller decides when to show it again.
 */
export async function moderateSellerProduct(
  sellerId: string,
  productId: string,
  input: { action: 'DISABLE' | 'ENABLE'; reason?: string | null },
  actorUserId: string,
): Promise<{ productId: string; status: string }> {
  const product = await prisma.product.findFirst({
    where: { id: productId, submittedBySellerId: sellerId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!product) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found for this seller.' });

  if (input.action === 'DISABLE') {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Give the seller a reason (at least 3 characters).' });
    }
    if (product.status !== ProductStatus.ARCHIVED) {
      await prisma.product.update({ where: { id: productId }, data: { status: ProductStatus.ARCHIVED } });
    }
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action: 'product.admin_disable',
        entityType: 'Product',
        entityId: productId,
        before: { status: product.status },
        after: { status: ProductStatus.ARCHIVED, reason, sellerId },
      },
    });
    return { productId, status: ProductStatus.ARCHIVED };
  }

  if (product.status === ProductStatus.ARCHIVED) {
    await prisma.product.update({ where: { id: productId }, data: { status: ProductStatus.INACTIVE } });
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action: 'product.admin_enable',
        entityType: 'Product',
        entityId: productId,
        before: { status: product.status },
        after: { status: ProductStatus.INACTIVE, sellerId },
      },
    });
    return { productId, status: ProductStatus.INACTIVE };
  }
  return { productId, status: product.status };
}

export interface CreateSellerListingInput {
  variantId: string;
  mrpPaise: number;
  pricePaise: number;
  /** Defaults to 0 — an admin-created listing starts with nothing on the
   * shelf until stock is actually set, same default `createVariant` uses. */
  stockQty?: number;
  /** Defaults to true — matches `createVariant`'s own listing default. */
  isAvailable?: boolean;
}

export interface CreateSellerListingResult {
  id: string;
  sellerId: string;
  variantId: string;
  mrpPaise: number;
  pricePaise: number;
  stockQty: number;
  isAvailable: boolean;
}

export async function createSellerListing(
  sellerId: string,
  input: CreateSellerListingInput,
  actorUserId: string,
): Promise<CreateSellerListingResult> {
  if (input.pricePaise > input.mrpPaise) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Selling price cannot be higher than MRP.',
    });
  }

  // --- #1: seller must exist and be active/eligible ----------------------
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, isActive: true, deletedAt: true, sellerType: true },
  });

  if (!seller || seller.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  }
  if (!seller.isActive) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This seller is not active.',
      internalMessage: `seller ${sellerId} is inactive`,
    });
  }

  // --- #2/#3: variant must exist under one of the seller's OWN categories --
  // Approval is NOT required: price and stock are part of a complete product
  // BEFORE it is submitted for review (product-approval.service.ts). Nothing
  // sells early — customers only ever see APPROVED products (catalog and
  // orderability gate on approvalStatus).
  const variant = await prisma.productVariant.findUnique({
    where: { id: input.variantId },
    select: {
      id: true,
      deletedAt: true,
      product: { select: { id: true, deletedAt: true, category: { select: { id: true, sellerId: true } } } },
    },
  });

  if (!variant || variant.deletedAt || variant.product.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product variant not found.' });
  }
  // The product must sit under one of the seller's OWN categories
  // (seller-category.service.ts) — another seller's is reported as missing;
  // category status is not gated, as before.
  await assertSellerMayUseCategoryForProduct(sellerId, variant.product.category.id, {
    requireActive: false,
    notFoundMessage: 'Product variant not found.',
  });

  // --- #4/#5: no silent update — a pre-existing listing is a conflict, ---
  // not a target to overwrite. The schema's own `@@unique([sellerId,
  // variantId])` is the race-safe backstop (a concurrent duplicate surfaces
  // as the same 409/VALIDATION_ERROR shape via the generic Prisma P2002
  // handler in errorHandler.ts) — this check is only what makes the COMMON
  // case return a specific, friendly message instead of a generic one.
  const existing = await prisma.sellerListing.findUnique({
    where: { sellerId_variantId: { sellerId, variantId: input.variantId } },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 409,
      message: 'This seller already has a listing for this product variant.',
      internalMessage: `duplicate seller listing seller=${sellerId} variant=${input.variantId}`,
    });
  }

  const listing = await runInTransaction(async (tx) => {
    const created = await tx.sellerListing.create({
      data: {
        sellerId,
        variantId: input.variantId,
        mrpPaise: input.mrpPaise,
        pricePaise: input.pricePaise,
        stockQty: input.stockQty ?? 0,
        isAvailable: input.isAvailable ?? true,
      },
    });

    // The opening stock is the listing's first stock movement, so its
    // movement history (and the ledger's running balance) starts from it
    // rather than from the first later adjustment.
    if (created.stockQty > 0) {
      await tx.stockLedger.create({
        data: {
          sellerListingId: created.id,
          delta: created.stockQty,
          reason: StockLedgerReason.PURCHASE,
          balanceAfter: created.stockQty,
          actorUserId,
          note: 'Opening stock',
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'seller_listing.create',
        entityType: 'SellerListing',
        entityId: created.id,
        after: {
          sellerId,
          variantId: input.variantId,
          mrpPaise: created.mrpPaise,
          pricePaise: created.pricePaise,
          stockQty: created.stockQty,
          isAvailable: created.isAvailable,
        },
      },
    });

    return created;
  });

  return {
    id: listing.id,
    sellerId: listing.sellerId,
    variantId: listing.variantId,
    mrpPaise: listing.mrpPaise,
    pricePaise: listing.pricePaise,
    stockQty: listing.stockQty,
    isAvailable: listing.isAvailable,
  };
}
