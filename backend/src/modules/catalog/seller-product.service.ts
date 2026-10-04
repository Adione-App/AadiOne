/**
 * A seller's own submitted products (GET /seller/products), and the product
 * view the admin reviews in an approval batch — one mapping for both.
 *
 * Ownership is `Product.submittedBySellerId`, the same column
 * product-approval.service.ts checks before a product may join a batch; the
 * seller id always comes from `attachSellerContext`, never the request. A
 * product created but never submitted is listed too — this is the only place
 * a seller can find it again.
 */

import type { Prisma } from '@prisma/client';
import {
  ApprovalStatus,
  ErrorCode,
  foodDietOf,
  ProductStatus as ProductStatusValue,
  type ProductReviewImageDto,
  type ProductStatus,
  type SellerProductDto,
  type SubmittedProductDto,
  type UnitType,
} from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { listingVisibility, type ListingVisibility } from './listing-visibility';

const VARIANT_FIELDS = {
  id: true,
  variantName: true,
  sku: true,
  unit: true,
  unitValue: true,
} as const;

/** Live variants, the default one first. */
const VARIANT_ORDER: Prisma.ProductVariantOrderByWithRelationInput[] = [
  { isDefault: 'desc' },
  { displayOrder: 'asc' },
  { createdAt: 'asc' },
];

const PRODUCT_FIELDS = {
  id: true,
  name: true,
  nameHi: true,
  description: true,
  status: true,
  approvalStatus: true,
  submittedBySellerId: true,
  categoryId: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
} as const;

/** The columns `toSubmittedProductDto` reads. */
interface SubmittedProductRow {
  id: string;
  name: string;
  nameHi: string | null;
  description: string | null;
  status: ProductStatus;
  approvalStatus: ApprovalStatus;
  submittedBySellerId: string | null;
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
  category: { id: string; name: string; parent: { id: string; name: string } | null };
  variants: { id: string; variantName: string; sku: string; unit: UnitType; unitValue: number }[];
}

export function toSubmittedProductDto(product: SubmittedProductRow): SubmittedProductDto {
  const own = { id: product.category.id, name: product.category.name };
  const parent = product.category.parent;
  const variant = product.variants[0] ?? null;
  return {
    id: product.id,
    name: product.name,
    nameHi: product.nameHi,
    description: product.description,
    status: product.status,
    approvalStatus: product.approvalStatus,
    submittedBySellerId: product.submittedBySellerId,
    categoryId: product.categoryId,
    category: parent ? { id: parent.id, name: parent.name } : own,
    subcategory: parent ? own : null,
    defaultVariant: variant
      ? {
          id: variant.id,
          variantName: variant.variantName,
          sku: variant.sku,
          unit: variant.unit,
          unitValue: variant.unitValue,
        }
      : null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Seller — own products                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The seller-panel product: the shared DTO plus inventory figures the shared
 * listing DTO doesn't carry, whether a customer can buy it right now (and if
 * not, why — listing-visibility.ts), and AdiOne's reason when it disabled it.
 */
export type SellerProductInventoryDto = Omit<SellerProductDto, 'listing'> & {
  listing:
    | (NonNullable<SellerProductDto['listing']> & { lowStockThreshold: number; maxQtyPerOrder: number; updatedAt: string })
    | null;
  visibility: ListingVisibility;
  /** Set while AdiOne has disabled the product (Product.status = ARCHIVED). */
  adminDisabled: { reason: string | null; at: string } | null;
};

export function listOwnProducts(sellerId: string): Promise<SellerProductInventoryDto[]> {
  return findOwnProducts(sellerId);
}

/** One own product; another seller's (or a missing one) is plain NOT_FOUND. */
export async function getOwnProduct(sellerId: string, productId: string): Promise<SellerProductInventoryDto> {
  const [product] = await findOwnProducts(sellerId, productId);
  if (!product) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  return product;
}

/** Why and when AdiOne last disabled each of these products (audit log). */
async function adminDisableNotes(productIds: string[]): Promise<Map<string, { reason: string | null; at: string }>> {
  if (productIds.length === 0) return new Map();
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'Product', entityId: { in: productIds }, action: 'product.admin_disable' },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true, after: true, createdAt: true },
  });
  const notes = new Map<string, { reason: string | null; at: string }>();
  for (const row of rows) {
    if (!row.entityId || notes.has(row.entityId)) continue;
    const reason = (row.after as { reason?: unknown } | null)?.reason;
    notes.set(row.entityId, { reason: typeof reason === 'string' ? reason : null, at: row.createdAt.toISOString() });
  }
  return notes;
}

async function findOwnProducts(sellerId: string, productId?: string): Promise<SellerProductInventoryDto[]> {
  const store = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { isActive: true, deletedAt: true, onboardingStatus: true },
  });
  const products = await prisma.product.findMany({
    where: { submittedBySellerId: sellerId, deletedAt: null, ...(productId ? { id: productId } : {}) },
    select: {
      ...PRODUCT_FIELDS,
      deletedAt: true,
      attributes: true,
      variants: {
        where: { deletedAt: null },
        orderBy: VARIANT_ORDER,
        select: {
          ...VARIANT_FIELDS,
          status: true,
          deletedAt: true,
          // Only ever this seller's own listing — never another seller's price.
          sellerListings: {
            where: { sellerId },
            select: {
              id: true,
              mrpPaise: true,
              pricePaise: true,
              stockQty: true,
              reservedQty: true,
              isAvailable: true,
              tracksStock: true,
              lowStockThreshold: true,
              maxQtyPerOrder: true,
              updatedAt: true,
            },
          },
        },
      },
      images: {
        orderBy: { displayOrder: 'asc' },
        select: { id: true, url: true, thumbUrl: true, altText: true, displayOrder: true },
      },
      approvalBatchItems: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          reviewNote: true,
          batch: { select: { id: true, status: true, submittedAt: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const disabledNotes = await adminDisableNotes(
    products.filter((product) => product.status === ProductStatusValue.ARCHIVED).map((product) => product.id),
  );

  return products.map((product) => {
    const variant = product.variants[0] ?? null;
    const listing = variant?.sellerListings[0] ?? null;
    const latest = product.approvalBatchItems[0] ?? null;
    const lastRejection = product.approvalBatchItems.find((item) => item.status === ApprovalStatus.REJECTED);
    return {
      ...toSubmittedProductDto(product),
      diet: foodDietOf(product.attributes),
      listing: listing
        ? {
            id: listing.id,
            mrpPaise: listing.mrpPaise,
            pricePaise: listing.pricePaise,
            stockQty: listing.stockQty,
            reservedQty: listing.reservedQty,
            availableQty: Math.max(0, listing.stockQty - listing.reservedQty),
            isAvailable: listing.isAvailable,
            tracksStock: listing.tracksStock,
            lowStockThreshold: listing.lowStockThreshold,
            maxQtyPerOrder: listing.maxQtyPerOrder,
            updatedAt: listing.updatedAt.toISOString(),
          }
        : null,
      visibility: listingVisibility({
        store: store ?? { isActive: false, deletedAt: new Date(0), onboardingStatus: 'REJECTED' },
        product: { status: product.status, deletedAt: product.deletedAt, approvalStatus: product.approvalStatus },
        variant: variant ? { status: variant.status, deletedAt: variant.deletedAt } : null,
        listing,
      }),
      adminDisabled:
        product.status === ProductStatusValue.ARCHIVED
          ? (disabledNotes.get(product.id) ?? { reason: null, at: product.updatedAt.toISOString() })
          : null,
      latestApproval: latest
        ? {
            batchId: latest.batch.id,
            batchStatus: latest.batch.status,
            itemId: latest.id,
            status: latest.status,
            reviewNote: latest.reviewNote,
            submittedAt: latest.batch.submittedAt.toISOString(),
          }
        : null,
      lastRejectionReason: lastRejection?.reviewNote ?? null,
      images: product.images,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Admin — the products in a batch, as reviewed                              */
/* -------------------------------------------------------------------------- */

export async function loadReviewProducts(
  productIds: string[],
): Promise<Map<string, SubmittedProductDto & { images: ProductReviewImageDto[] }>> {
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      ...PRODUCT_FIELDS,
      variants: { where: { deletedAt: null }, orderBy: VARIANT_ORDER, select: VARIANT_FIELDS },
      images: {
        orderBy: { displayOrder: 'asc' },
        select: { id: true, url: true, thumbUrl: true, altText: true, displayOrder: true },
      },
    },
  });
  return new Map(
    products.map((product) => [product.id, { ...toSubmittedProductDto(product), images: product.images }]),
  );
}
