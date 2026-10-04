/**
 * A seller's own SellerListings — price/stock/availability are
 * "seller-controlled" (SellerListing.pricePaise's own doc comment, #11).
 *
 * Creation goes through admin-seller-catalog.service.ts's
 * `createSellerListing` (approved products under the seller's own categories);
 * updates reuse inventory.service.ts's existing operations, so stock changes
 * still write the StockLedger (who, when, why) and price changes the audit log.
 *
 * Ownership follows the seller-panel convention: another seller's listing is
 * reported exactly like a missing one (NOT_FOUND). An admin restriction —
 * AdiOne disabled the product (Product.status = ARCHIVED) — can't be lifted
 * from here: switching such a listing back on sale is refused.
 */

import { ErrorCode, ProductStatus, StockLedgerReason, type SellerListingDto } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import * as inventoryService from '../inventory/inventory.service';
import { listingVisibility, type ListingVisibility } from './listing-visibility';

const LISTING_SELECT = {
  id: true,
  sellerId: true,
  variantId: true,
  mrpPaise: true,
  pricePaise: true,
  stockQty: true,
  reservedQty: true,
  isAvailable: true,
  tracksStock: true,
  lowStockThreshold: true,
  maxQtyPerOrder: true,
  updatedAt: true,
  seller: { select: { isActive: true, deletedAt: true, onboardingStatus: true } },
  variant: {
    select: {
      variantName: true,
      status: true,
      deletedAt: true,
      product: {
        select: {
          id: true,
          name: true,
          status: true,
          deletedAt: true,
          approvalStatus: true,
          submittedBySellerId: true,
          category: { select: { id: true, name: true } },
          images: { orderBy: { displayOrder: 'asc' }, take: 1, select: { url: true, thumbUrl: true } },
        },
      },
    },
  },
} as const;

type ListingRow = NonNullable<Awaited<ReturnType<typeof loadOwnListing>>>;

/** The shared listing DTO plus the inventory/visibility figures the seller panel shows. */
export type SellerListingInventoryDto = SellerListingDto & {
  reservedQty: number;
  lowStockThreshold: number;
  maxQtyPerOrder: number;
  productStatus: string;
  /** True when this seller submitted the product (its details/images are then the seller's). */
  ownProduct: boolean;
  imageUrl: string | null;
  visibility: ListingVisibility;
  updatedAt: string;
};

function toDto(listing: ListingRow): SellerListingInventoryDto {
  const product = listing.variant.product;
  return {
    id: listing.id,
    sellerId: listing.sellerId,
    variantId: listing.variantId,
    productId: product.id,
    productName: product.name,
    variantName: listing.variant.variantName,
    categoryId: product.category.id,
    categoryName: product.category.name,
    approvalStatus: product.approvalStatus,
    mrpPaise: listing.mrpPaise,
    pricePaise: listing.pricePaise,
    stockQty: listing.stockQty,
    availableQty: Math.max(0, listing.stockQty - listing.reservedQty),
    isAvailable: listing.isAvailable,
    tracksStock: listing.tracksStock,
    reservedQty: listing.reservedQty,
    lowStockThreshold: listing.lowStockThreshold,
    maxQtyPerOrder: listing.maxQtyPerOrder,
    productStatus: product.status,
    ownProduct: product.submittedBySellerId === listing.sellerId,
    imageUrl: product.images[0]?.thumbUrl ?? product.images[0]?.url ?? null,
    visibility: listingVisibility({
      store: listing.seller,
      product: { status: product.status, deletedAt: product.deletedAt, approvalStatus: product.approvalStatus },
      variant: { status: listing.variant.status, deletedAt: listing.variant.deletedAt },
      listing,
    }),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

function loadOwnListing(listingId: string) {
  return prisma.sellerListing.findUnique({ where: { id: listingId }, select: LISTING_SELECT });
}

/** This seller's listing, or NOT_FOUND — another seller's looks exactly like a missing one. */
async function loadOwnListingOrThrow(sellerId: string, listingId: string): Promise<ListingRow> {
  const listing = await loadOwnListing(listingId);
  if (!listing || listing.sellerId !== sellerId) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Listing not found.' });
  }
  return listing;
}

export async function listOwnListings(sellerId: string) {
  const listings = await prisma.sellerListing.findMany({
    where: { sellerId },
    select: LISTING_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  return listings.map(toDto);
}

export async function getOwnListing(sellerId: string, listingId: string): Promise<SellerListingInventoryDto> {
  return toDto(await loadOwnListingOrThrow(sellerId, listingId));
}

export interface UpdateOwnListingInput {
  mrpPaise?: number;
  pricePaise?: number;
  stockQty?: number;
  isAvailable?: boolean;
}

export async function updateOwnListing(
  sellerId: string,
  listingId: string,
  input: UpdateOwnListingInput,
  actorUserId: string,
) {
  const listing = await loadOwnListingOrThrow(sellerId, listingId);
  const product = listing.variant.product;

  // An admin restriction is never lifted by the seller's on-sale switch.
  if (input.isAvailable === true && (product.status === ProductStatus.ARCHIVED || product.deletedAt !== null)) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: 'AdiOne has disabled this product, so it cannot be put back on sale. Contact support.',
      internalMessage: `seller ${sellerId} tried to re-enable admin-disabled listing ${listingId}`,
    });
  }

  // A made-to-order food item has a selling price only: its MRP mirrors it.
  if (!listing.tracksStock && input.pricePaise !== undefined) {
    input = { ...input, mrpPaise: input.pricePaise };
  }
  if (input.pricePaise !== undefined || input.mrpPaise !== undefined) {
    // Validates price <= MRP and writes the audit log (inventory.service).
    await inventoryService.updatePricing(
      listingId,
      {
        ...(input.pricePaise !== undefined ? { pricePaise: input.pricePaise } : {}),
        ...(input.mrpPaise !== undefined ? { mrpPaise: input.mrpPaise } : {}),
      },
      actorUserId,
    );
  }
  if (input.stockQty !== undefined) {
    await inventoryService.setStock(listingId, input.stockQty, actorUserId, 'seller stock update');
  }
  if (input.isAvailable !== undefined && input.isAvailable !== listing.isAvailable) {
    if (input.isAvailable) await inventoryService.markAvailable(listingId, actorUserId);
    else await inventoryService.markOutOfStock(listingId, actorUserId);
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action: input.isAvailable ? 'seller_listing.shown' : 'seller_listing.hidden',
        entityType: 'SellerListing',
        entityId: listingId,
        before: { isAvailable: listing.isAvailable },
        after: { isAvailable: input.isAvailable },
      },
    });
  }

  return toDto((await loadOwnListing(listingId))!);
}

/**
 * +/- on the seller's own listing: row-locked in inventory.service's
 * `adjustStock`, never below the reserved quantity or zero, never touching
 * `reservedQty`, and one StockLedger row (actor, time, note) per change.
 */
export async function adjustOwnStock(
  sellerId: string,
  listingId: string,
  delta: number,
  actorUserId: string,
  note?: string | null,
) {
  await loadOwnListingOrThrow(sellerId, listingId);
  await inventoryService.adjustStock(listingId, delta, actorUserId, note?.trim() ? `seller: ${note.trim()}` : 'seller stock +/-');
  return toDto((await loadOwnListing(listingId))!);
}

export interface StockMovementDto {
  id: string;
  at: string;
  delta: number;
  reason: string;
  /** Available stock (stock − reserved) after this movement. */
  balanceAfter: number;
  /**
   * Available stock just before it. A sale (ORDER_COMMIT) takes the goods
   * off the shelf AND out of the reservation together, so available stock
   * does not move then; every other movement changed it by `delta`.
   */
  availableBefore: number;
  note: string | null;
  /** "You" for this seller's own staff, else who/what made it. */
  by: string;
  orderLinked: boolean;
}

/** See StockMovementDto.availableBefore (inventory.service writes balanceAfter = stock − reserved). */
export function availableBefore(reason: string, delta: number, balanceAfter: number): number {
  return reason === StockLedgerReason.ORDER_COMMIT ? balanceAfter : balanceAfter - delta;
}

/** Recent stock movements of the seller's own listing (StockLedger). */
export async function listOwnStockMovements(sellerId: string, listingId: string, limit = 30): Promise<StockMovementDto[]> {
  await loadOwnListingOrThrow(sellerId, listingId);
  const [rows, staff] = await Promise.all([
    prisma.stockLedger.findMany({
      where: { sellerListingId: listingId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, createdAt: true, delta: true, reason: true, balanceAfter: true, note: true, actorUserId: true, sellerOrderId: true },
    }),
    prisma.sellerStaff.findMany({ where: { sellerId }, select: { userId: true } }),
  ]);
  const ownStaff = new Set(staff.map((member) => member.userId));
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt.toISOString(),
    delta: row.delta,
    reason: row.reason,
    balanceAfter: row.balanceAfter,
    availableBefore: availableBefore(row.reason, row.delta, row.balanceAfter),
    note: row.note,
    // Never another person's name: your team, AdiOne, or the order system.
    by: row.actorUserId ? (ownStaff.has(row.actorUserId) ? 'You' : 'AdiOne') : 'Orders',
    orderLinked: row.sellerOrderId !== null,
  }));
}
