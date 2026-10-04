/**
 * Seller-submitted product catalog approval.
 *
 * A seller creates its own Product COMPLETE — details, category, SKU, and
 * its own listing (MRP, selling price, opening stock) in one go (PENDING by
 * construction — see `createSellerProduct`). It can save any number of them
 * as drafts, then "Submit for Approval" puts every complete, never-submitted
 * one into ONE `ProductApprovalBatch` (`submitApprovalBatch`). Admin approves
 * the whole batch in one transactional action (`approveBatch`) or decides
 * items individually (`reviewBatchItem`). Approval never touches the
 * seller's price or stock; it only flips `Product.approvalStatus`, which is
 * what makes the already-priced product visible to customers. `Product.approvalStatus` is the single gate that matters
 * downstream (catalog visibility and orderability show/sell only APPROVED
 * products) — this module is the ONLY code
 * permitted to move it away from its PENDING default, exactly mirroring how
 * `transitionSellerOrder` (order-state.service.ts) is the only code allowed
 * to write `seller_orders.status`.
 *
 * Every read/write that targets one seller's own data takes an optional
 * `scopeSellerId`, the same shape `seller-order.service.ts` already uses:
 * seller-panel routes always pass `req.sellerId` (from `attachSellerContext`),
 * turning a mismatched or missing id into a plain NOT_FOUND rather than ever
 * revealing that a DIFFERENT seller's product/batch exists (#15/#27); admin
 * routes pass `undefined` for full cross-seller access (#26).
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  ApprovalStatus,
  ErrorCode,
  NotificationType,
  Permission,
  ProductStatus,
  StockLedgerReason,
  UnitType as UnitTypeValue,
  isFoodSellerType,
  optionGroupsOf,
  optionValuesOf,
  type CursorPage,
  type FoodDiet,
  type ProductOptionGroupDto,
  type ProductApprovalBatchReviewDto,
  type UnitType,
} from '../../shared';
import * as notificationService from '../notifications/notification.service';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { slugify } from '../../shared/text';
import { assertSellerMayUseCategoryForProduct } from './seller-category.service';
import { getOwnProduct, loadReviewProducts } from './seller-product.service';
import { updateOwnListing } from './seller-listing.service';
import { createSellerListing } from '../sellers/admin-seller-catalog.service';
import { createVariantRows, normalizeVariantSet, type VariantInput } from './product-variant.service';
import type {
  ApproveProductBatchResultDto,
  ProductApprovalBatchProductsPageDto,
  ProductApprovalBatchSummaryDto,
} from '../../shared';

/* -------------------------------------------------------------------------- */
/* DTO mapping                                                                */
/* -------------------------------------------------------------------------- */

const BATCH_INCLUDE = {
  seller: { select: { name: true } },
  items: {
    orderBy: { createdAt: 'asc' as const },
    include: { product: { select: { name: true } } },
  },
} as const;

type BatchWithRelations = Awaited<ReturnType<typeof loadBatchOrThrow>>;

function toBatchDto(batch: BatchWithRelations) {
  return {
    id: batch.id,
    sellerId: batch.sellerId,
    sellerName: batch.seller.name,
    status: batch.status,
    submittedAt: batch.submittedAt.toISOString(),
    reviewedAt: batch.reviewedAt?.toISOString() ?? null,
    reviewNote: batch.reviewNote,
    items: batch.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      status: item.status,
      reviewNote: item.reviewNote,
    })),
  };
}

async function loadBatchOrThrow(batchId: string, scopeSellerId?: string, client: Tx | typeof prisma = prisma) {
  const batch = await client.productApprovalBatch.findUnique({
    where: { id: batchId },
    include: BATCH_INCLUDE,
  });
  if (!batch || (scopeSellerId && batch.sellerId !== scopeSellerId)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Approval batch not found.' });
  }
  return batch;
}

/* -------------------------------------------------------------------------- */
/* Seller — create a product (starts PENDING, owned by this seller)          */
/* -------------------------------------------------------------------------- */

export interface CreateSellerProductInput {
  categoryId: string;
  name: string;
  nameHi?: string | null;
  description?: string | null;
  /** Required for a marketplace product; a food item gets defaults (see foodDefaults). */
  sku?: string;
  variantName?: string;
  unit?: UnitType;
  unitValue?: number;
  /** The seller's own listing — part of a complete product, set BEFORE approval.
   * MRP and stock: marketplace products only (a food item has neither). */
  mrpPaise?: number;
  /** Required for a simple item; with `variants`, each variant has its own. */
  pricePaise?: number;
  stockQty?: number;
  /** Food items only. */
  diet?: FoodDiet | null;
  isAvailable?: boolean;
  /**
   * Optional options / variants (product-variant.service). When `variants` is
   * given, each variant carries its own price (and, for marketplace products,
   * SKU, MRP and opening stock) and the top-level price / SKU / MRP / stock
   * fields are not used. Omitted = the simple single-variant item, as before.
   */
  optionGroups?: ProductOptionGroupDto[];
  variants?: VariantInput[];
}

/**
 * The fixed capacity a made-to-order food listing (tracksStock = false)
 * carries: orders reserve against it but never use it up (inventory.service),
 * so availability is the seller's on/off switch alone. Equals the listing
 * routes' stock maximum.
 */
export const FOOD_ITEM_CAPACITY = 100_000;

/** A food item's variant: one portion, no seller-visible SKU or unit. */
function foodSku(): string {
  return `FOOD-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

async function sellerIsFood(sellerId: string): Promise<boolean> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { sellerType: true } });
  return isFoodSellerType(seller?.sellerType);
}

/** A marketplace product is complete only with all of these (route schema leaves them optional for food). */
function assertCompleteMarketplaceProduct(input: CreateSellerProductInput): asserts input is CreateSellerProductInput &
  Required<Pick<CreateSellerProductInput, 'sku' | 'variantName' | 'unit' | 'unitValue' | 'mrpPaise' | 'stockQty'>> {
  const missing = (
    [
      ['sku', 'SKU'],
      ['variantName', 'variant name'],
      ['unit', 'unit'],
      ['unitValue', 'unit value'],
      ['mrpPaise', 'MRP'],
      ['stockQty', 'opening stock'],
    ] as const
  ).filter(([key]) => input[key] === undefined);
  if (missing.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Enter the ${missing.map(([, label]) => label).join(', ')}.`,
      details: missing.map(([key, label]) => ({ field: key, message: `${label} is required.` })),
    });
  }
}

/** Above this, a seller's single "Submit for Approval" is split across clicks. */
export const MAX_BATCH_PRODUCTS = 5000;

export async function createSellerProduct(
  sellerId: string,
  input: CreateSellerProductInput,
  actorUserId: string,
): Promise<{ id: string; variantId: string; listingId: string }> {
  // Only the seller's OWN categories (top category, subcategory or — for a
  // restaurant — menu section); another seller's is indistinguishable from a
  // missing one (seller-category.service).
  await assertSellerMayUseCategoryForProduct(sellerId, input.categoryId);
  // Restaurant / cafe: a FOOD item — selling price + availability, no MRP and
  // no stock count (made to order). Everyone else: the complete marketplace
  // product, MRP + price + opening stock, exactly as before.
  const food = await sellerIsFood(sellerId);
  if (input.variants !== undefined) return createProductWithVariants(sellerId, input, food, actorUserId);
  if (input.pricePaise === undefined) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter the selling price.' });
  }
  let listingData: { mrpPaise: number; pricePaise: number; stockQty: number; tracksStock: boolean; isAvailable: boolean };
  let variantData: { sku: string; variantName: string; unit: UnitType; unitValue: number };
  if (food) {
    listingData = {
      mrpPaise: input.pricePaise,
      pricePaise: input.pricePaise,
      stockQty: FOOD_ITEM_CAPACITY,
      tracksStock: false,
      isAvailable: input.isAvailable ?? true,
    };
    variantData = {
      sku: input.sku?.trim() ? input.sku.trim().toUpperCase() : foodSku(),
      variantName: input.variantName?.trim() || 'Regular',
      unit: input.unit ?? UnitTypeValue.PIECE,
      unitValue: input.unitValue ?? 1,
    };
  } else {
    assertCompleteMarketplaceProduct(input);
    if (input.pricePaise > input.mrpPaise) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Selling price cannot be higher than MRP.' });
    }
    listingData = { mrpPaise: input.mrpPaise, pricePaise: input.pricePaise, stockQty: input.stockQty, tracksStock: true, isAvailable: true };
    variantData = { sku: input.sku.trim().toUpperCase(), variantName: input.variantName, unit: input.unit, unitValue: input.unitValue };
  }

  const created = await runInTransaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        name: input.name,
        nameHi: input.nameHi ?? null,
        // Not DB-unique (see Product's own schema comment), but a random
        // suffix keeps two sellers naming the same product from colliding.
        slug: `${slugify(input.name)}-${Math.random().toString(36).slice(2, 8)}`,
        categoryId: input.categoryId,
        description: input.description ?? null,
        searchKeywords: [],
        status: ProductStatus.ACTIVE,
        // Explicit, though it's also the schema default — this is the ONE
        // place a Product is deliberately born unapproved (see
        // admin-catalog.service.ts's createProduct, which is the opposite
        // case: admin-authored, pre-approved, no batch).
        approvalStatus: ApprovalStatus.PENDING,
        submittedBySellerId: sellerId,
        ...(food && input.diet ? { attributes: { diet: input.diet } } : {}),
      },
    });

    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        ...variantData,
        isDefault: true,
        status: ProductStatus.ACTIVE,
      },
    });

    // The seller's own price and stock, in the same transaction: a product
    // is never saved half-complete. Invisible to customers until approved
    // (catalog/orderability gate on approvalStatus), so nothing sells early.
    const listing = await tx.sellerListing.create({
      data: { sellerId, variantId: variant.id, ...listingData },
    });
    if (listing.tracksStock && listing.stockQty > 0) {
      await tx.stockLedger.create({
        data: {
          sellerListingId: listing.id,
          delta: listing.stockQty,
          reason: StockLedgerReason.PURCHASE,
          balanceAfter: listing.stockQty,
          actorUserId,
          note: 'Opening stock',
        },
      });
    }

    return { productId: product.id, variantId: variant.id, listingId: listing.id };
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.seller_create',
      entityType: 'Product',
      entityId: created.productId,
      after: {
        sellerId,
        name: input.name,
        categoryId: input.categoryId,
        listingId: created.listingId,
        ...(food
          ? { foodItem: true, pricePaise: listingData.pricePaise, isAvailable: listingData.isAvailable, diet: input.diet ?? null }
          : { mrpPaise: listingData.mrpPaise, pricePaise: listingData.pricePaise, stockQty: listingData.stockQty }),
      },
    },
  });

  return { id: created.productId, variantId: created.variantId, listingId: created.listingId };
}

/** createSellerProduct with an option/variant set: the product and every variant (+ listing) in one transaction. */
async function createProductWithVariants(
  sellerId: string,
  input: CreateSellerProductInput,
  food: boolean,
  actorUserId: string,
): Promise<{ id: string; variantId: string; listingId: string }> {
  const set = normalizeVariantSet({ optionGroups: input.optionGroups ?? [], variants: input.variants ?? [] }, food);
  const created = await runInTransaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        name: input.name,
        nameHi: input.nameHi ?? null,
        slug: `${slugify(input.name)}-${Math.random().toString(36).slice(2, 8)}`,
        categoryId: input.categoryId,
        description: input.description ?? null,
        searchKeywords: [],
        status: ProductStatus.ACTIVE,
        approvalStatus: ApprovalStatus.PENDING,
        submittedBySellerId: sellerId,
        optionGroups: set.optionGroups as unknown as Prisma.InputJsonValue,
        ...(food && input.diet ? { attributes: { diet: input.diet } } : {}),
      },
    });
    const rows = await createVariantRows(tx, {
      sellerId,
      productId: product.id,
      food,
      variants: set.variants,
      startOrder: 0,
      pendingReview: false,
      defaultUnit: { unit: input.unit ?? UnitTypeValue.PIECE, unitValue: input.unitValue ?? 1 },
      actorUserId,
    });
    await tx.productVariant.update({ where: { id: rows[0]!.variantId }, data: { isDefault: true } });
    return { productId: product.id, ...rows[0]! };
  });
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.seller_create',
      entityType: 'Product',
      entityId: created.productId,
      after: {
        sellerId,
        name: input.name,
        categoryId: input.categoryId,
        optionGroups: set.optionGroups as unknown as Prisma.InputJsonValue,
        variants: set.variants.map((v) => ({ name: v.variantName, pricePaise: v.pricePaise, stockQty: food ? null : (v.stockQty ?? null) })),
      },
    },
  });
  return { id: created.productId, variantId: created.variantId, listingId: created.listingId };
}

/* -------------------------------------------------------------------------- */
/* Seller — edit its own product                                            */
/* -------------------------------------------------------------------------- */

/**
 * When a seller may change its own product's content (name, description,
 * category / menu section, attributes, images, default variant):
 *
 *   never submitted / REJECTED   yes (a corrected REJECTED product stays
 *                                REJECTED until `submitApprovalBatch`)
 *   first review in progress     no — the admin must not review something that
 *                                changes underneath
 *   APPROVED                     yes, live, without a new review: the seller
 *                                manages its own content after approval. The
 *                                change is audit-logged (product.seller_update),
 *                                the product stays APPROVED and on sale, and
 *                                past orders keep their own copy of name,
 *                                variant, image and price (OrderItem).
 *
 * New sellable VARIANTS of an approved product are the one thing still
 * reviewed — per variant (product-variant.service). Missing and another
 * seller's product are reported identically (NOT_FOUND).
 */
export async function loadEditableOwnProduct(
  sellerId: string,
  productId: string,
  client: Tx | typeof prisma = prisma,
) {
  const product = await client.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, name: true, nameHi: true, description: true, categoryId: true, approvalStatus: true, submittedBySellerId: true },
  });
  if (!product || product.submittedBySellerId !== sellerId) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  }
  if (product.approvalStatus === ApprovalStatus.APPROVED) return product;
  const underReview = await client.productApprovalBatchItem.count({
    where: { productId, status: ApprovalStatus.PENDING },
  });
  if (underReview > 0) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: 'This product is under review. It can be edited again if it is rejected.',
    });
  }
  return product;
}

/** The same fields `createSellerProduct` accepts — nothing else is editable. */
export type UpdateSellerProductInput = Partial<CreateSellerProductInput>;

/**
 * The listing part of a product edit: updates the seller's own listing
 * (inventory.service rules: price <= MRP, ledgered stock), or creates it for
 * an older product that has none yet (then MRP, price and stock are all needed).
 */
async function applyListingChanges(
  sellerId: string,
  variantId: string | null,
  input: Pick<UpdateSellerProductInput, 'mrpPaise' | 'pricePaise' | 'stockQty'>,
  actorUserId: string,
): Promise<void> {
  if (input.mrpPaise === undefined && input.pricePaise === undefined && input.stockQty === undefined) return;
  if (!variantId) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'This product has no variant to price.' });
  const listing = await prisma.sellerListing.findUnique({
    where: { sellerId_variantId: { sellerId, variantId } },
    select: { id: true, tracksStock: true },
  });
  // A food item has a selling price only: MRP follows it, there is no stock.
  if (listing && !listing.tracksStock) {
    if (input.pricePaise === undefined) return;
    await updateOwnListing(sellerId, listing.id, { mrpPaise: input.pricePaise, pricePaise: input.pricePaise }, actorUserId);
    return;
  }
  if (!listing && (await sellerIsFood(sellerId))) {
    if (input.pricePaise === undefined) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter the selling price.' });
    }
    await prisma.sellerListing.create({
      data: {
        sellerId,
        variantId,
        mrpPaise: input.pricePaise,
        pricePaise: input.pricePaise,
        stockQty: FOOD_ITEM_CAPACITY,
        tracksStock: false,
        isAvailable: true,
      },
    });
    return;
  }
  if (listing) {
    await updateOwnListing(
      sellerId,
      listing.id,
      {
        ...(input.mrpPaise !== undefined ? { mrpPaise: input.mrpPaise } : {}),
        ...(input.pricePaise !== undefined ? { pricePaise: input.pricePaise } : {}),
        ...(input.stockQty !== undefined ? { stockQty: input.stockQty } : {}),
      },
      actorUserId,
    );
    return;
  }
  if (input.mrpPaise === undefined || input.pricePaise === undefined || input.stockQty === undefined) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter the MRP, selling price and stock together.' });
  }
  await createSellerListing(
    sellerId,
    { variantId, mrpPaise: input.mrpPaise, pricePaise: input.pricePaise, stockQty: input.stockQty, isAvailable: true },
    actorUserId,
  );
}

export async function updateSellerProduct(
  sellerId: string,
  productId: string,
  input: UpdateSellerProductInput,
  actorUserId: string,
) {
  // Options / variants have their own endpoint (PUT /seller/products/:id/variants).
  const { mrpPaise, pricePaise, stockQty, diet, isAvailable: _ignored, optionGroups: _groups, variants: _variants, ...productInput } = input;
  input = productInput;
  const current = await loadEditableOwnProduct(sellerId, productId);
  const variant = await prisma.productVariant.findFirst({
    where: { productId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, sku: true, variantName: true, unit: true, unitValue: true },
  });
  const variantChange =
    input.sku !== undefined || input.variantName !== undefined || input.unit !== undefined || input.unitValue !== undefined;
  if (variantChange && !variant) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'This product has no variant to edit.' });
  }

  if (input.categoryId !== undefined && input.categoryId !== current.categoryId) {
    // Same rule as creation.
    await assertSellerMayUseCategoryForProduct(sellerId, input.categoryId);
  }

  const sku = input.sku?.trim().toUpperCase();
  if (sku !== undefined && variant && sku !== variant.sku) {
    const clash = await prisma.productVariant.findFirst({ where: { sku, id: { not: variant.id } }, select: { id: true } });
    if (clash) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        status: 409,
        message: 'This SKU is already used by another product.',
      });
    }
  }

  const renamed = input.name !== undefined && input.name !== current.name;
  await runInTransaction(async (tx) => {
    // Re-checked inside the write: a submission or review racing this edit wins.
    await loadEditableOwnProduct(sellerId, productId, tx);
    await tx.product.update({
      where: { id: productId },
      data: {
        ...(renamed ? { name: input.name, slug: `${slugify(input.name!)}-${Math.random().toString(36).slice(2, 8)}` } : {}),
        ...(input.nameHi !== undefined ? { nameHi: input.nameHi } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(diet !== undefined && (await sellerIsFood(sellerId)) ? { attributes: diet ? { diet } : {} } : {}),
      },
    });
    if (variant && variantChange) {
      await tx.productVariant.update({
        where: { id: variant.id },
        data: {
          ...(sku !== undefined ? { sku } : {}),
          ...(input.variantName !== undefined ? { variantName: input.variantName } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.unitValue !== undefined ? { unitValue: input.unitValue } : {}),
        },
      });
    }
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.seller_update',
      entityType: 'Product',
      entityId: productId,
      before: {
        name: current.name,
        nameHi: current.nameHi,
        description: current.description,
        categoryId: current.categoryId,
        ...(variant ? { sku: variant.sku, variantName: variant.variantName, unit: variant.unit, unitValue: variant.unitValue } : {}),
      },
      after: { ...productInput, ...(sku !== undefined ? { sku } : {}) },
    },
  });

  await applyListingChanges(
    sellerId,
    variant?.id ?? null,
    {
      ...(mrpPaise !== undefined ? { mrpPaise } : {}),
      ...(pricePaise !== undefined ? { pricePaise } : {}),
      ...(stockQty !== undefined ? { stockQty } : {}),
    },
    actorUserId,
  );

  return getOwnProduct(sellerId, productId);
}

/**
 * DELETE /seller/products/:id — a restaurant / cafe removes one of its own
 * FOOD items from its menu. Soft delete only: the product leaves the menu, the
 * customer catalogue and every future order, while past orders keep their
 * rows. An item still waiting in an approval batch is simply dropped from the
 * review (approveBatch skips removed products). Marketplace products are not
 * deletable here (their lifecycle is approval + show/hide), and another
 * seller's item is NOT_FOUND.
 */
export async function deleteOwnFoodItem(sellerId: string, productId: string, actorUserId: string): Promise<{ id: string }> {
  if (!(await sellerIsFood(sellerId))) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Only restaurant and cafe food items can be deleted.' });
  }
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, name: true, categoryId: true, submittedBySellerId: true },
  });
  if (!product || product.submittedBySellerId !== sellerId) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Food item not found.' });
  }
  const now = new Date();
  await runInTransaction(async (tx) => {
    await tx.product.updateMany({ where: { id: productId, deletedAt: null }, data: { deletedAt: now, status: ProductStatus.INACTIVE } });
    // The listing stays (order history points at it) but can never be bought again.
    await tx.sellerListing.updateMany({ where: { sellerId, variant: { productId } }, data: { isAvailable: false } });
  });
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.seller_delete',
      entityType: 'Product',
      entityId: productId,
      before: { name: product.name, categoryId: product.categoryId },
      after: { deleted: true },
    },
  });
  return { id: productId };
}

/**
 * Active/inactive switch on the seller's own product. Allowed at any approval
 * stage — it only hides or shows the product; it never changes content, so it
 * needs no review. Approval still gates selling: a listing can only exist for
 * an APPROVED product (admin-seller-catalog.service's createSellerListing).
 */
export async function setOwnProductStatus(
  sellerId: string,
  productId: string,
  status: typeof ProductStatus.ACTIVE | typeof ProductStatus.INACTIVE,
  actorUserId: string,
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, status: true, submittedBySellerId: true },
  });
  if (!product || product.submittedBySellerId !== sellerId) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  }
  // ARCHIVED = disabled by AdiOne (admin moderation): the seller can't lift it.
  if (product.status === ProductStatus.ARCHIVED) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: 'AdiOne has disabled this product. It can’t be shown or hidden until AdiOne enables it again.',
      internalMessage: `seller ${sellerId} tried to change admin-disabled product ${productId}`,
    });
  }
  if (product.status !== status) {
    await prisma.product.update({ where: { id: productId }, data: { status } });
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action: 'product.seller_status',
        entityType: 'Product',
        entityId: productId,
        before: { status: product.status },
        after: { status },
      },
    });
  }
  return getOwnProduct(sellerId, productId);
}

/* -------------------------------------------------------------------------- */
/* Seller — submit a batch of its own products for review                    */
/* -------------------------------------------------------------------------- */

/**
 * A product the seller may submit: owned, not deleted, not approved, and
 * COMPLETE — a live variant with the seller's own listing (MRP, price,
 * stock). Price and stock are part of the product before review, never after.
 */
const COMPLETE_PRODUCT_WHERE = (sellerId: string) => ({
  variants: { some: { deletedAt: null, sellerListings: { some: { sellerId } } } },
});

/** An approved product with new variants awaiting review, and no review open. */
const NEW_VARIANTS_TO_REVIEW_WHERE = {
  approvalStatus: ApprovalStatus.APPROVED,
  variants: { some: { deletedAt: null, approvalStatus: ApprovalStatus.PENDING } },
  approvalBatchItems: { none: { status: ApprovalStatus.PENDING } },
};

/**
 * POST /seller/approval-batches — ONE batch for one "Submit for Approval".
 *
 *   no productIds  every complete product of this seller that was never
 *                  submitted (no batch item at all), oldest first, up to
 *                  MAX_BATCH_PRODUCTS — the normal flow;
 *   productIds     exactly those (resubmitting a fixed REJECTED product).
 *
 * Race-safe: the seller row is locked for the whole submission, and the
 * eligibility and "already awaiting review" checks run inside that lock, so
 * two clicks (or two tabs) can never put the same product into two batches.
 * Items are inserted in one statement, so 1000+ products is one round trip.
 */
export async function submitApprovalBatch(
  sellerId: string,
  productIds: string[] | undefined,
  actorUserId: string,
) {
  const batchId = await runInTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${sellerId}::uuid FOR UPDATE`;

    let ids: string[];
    if (productIds === undefined) {
      const ready = await tx.product.findMany({
        where: {
          submittedBySellerId: sellerId,
          deletedAt: null,
          OR: [
            // A complete product never submitted.
            { approvalStatus: ApprovalStatus.PENDING, approvalBatchItems: { none: {} }, ...COMPLETE_PRODUCT_WHERE(sellerId) },
            // An approved product with new variants waiting for review (and no open review).
            NEW_VARIANTS_TO_REVIEW_WHERE,
          ],
        },
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_BATCH_PRODUCTS,
      });
      if (ready.length === 0) {
        const incomplete = await tx.product.count({
          where: {
            submittedBySellerId: sellerId,
            deletedAt: null,
            approvalStatus: ApprovalStatus.PENDING,
            approvalBatchItems: { none: {} },
          },
        });
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message:
            incomplete > 0
              ? `Nothing is ready to submit: ${incomplete} draft product${incomplete === 1 ? ' needs' : 's need'} a price and stock first.`
              : 'Nothing to submit — every product has already been submitted for approval.',
        });
      }
      ids = ready.map((p) => p.id);
    } else {
      ids = [...new Set(productIds)];
      if (ids.length !== productIds.length) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The same product was listed more than once.' });
      }
      const products = await tx.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          submittedBySellerId: true,
          approvalStatus: true,
          deletedAt: true,
          variants: { where: { deletedAt: null, sellerListings: { some: { sellerId } } }, select: { id: true, approvalStatus: true } },
        },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      for (const id of ids) {
        const product = byId.get(id);
        // A missing id and one belonging to another seller are reported
        // IDENTICALLY — a seller must never learn that a product id merely
        // belonging to someone else exists (#15/#27).
        if (!product || product.deletedAt || product.submittedBySellerId !== sellerId) {
          throw new AppError(ErrorCode.NOT_FOUND, {
            message: 'One of the selected products could not be found.',
            internalMessage: `product ${id} not found or not owned by seller ${sellerId}`,
          });
        }
        // An approved product is submitted only for its new (PENDING) variants.
        if (product.approvalStatus === ApprovalStatus.APPROVED && !product.variants.some((v) => v.approvalStatus === ApprovalStatus.PENDING)) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `"${product.name}" is already approved — nothing to submit.` });
        }
        if (product.variants.length === 0) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, {
            message: `"${product.name}" is incomplete: add its MRP, selling price and stock before submitting it.`,
          });
        }
      }
      const openItems = await tx.productApprovalBatchItem.findMany({
        where: { productId: { in: ids }, status: ApprovalStatus.PENDING },
        select: { productId: true },
      });
      if (openItems.length > 0) {
        const names = openItems.map((i) => byId.get(i.productId)?.name ?? i.productId);
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          status: 409,
          message: `Already awaiting review: ${names.join(', ')}.`,
          internalMessage: `duplicate submission for products ${openItems.map((i) => i.productId).join(',')}`,
        });
      }
    }

    const created = await tx.productApprovalBatch.create({
      data: { sellerId, status: ApprovalStatus.PENDING, submittedByUserId: actorUserId },
      select: { id: true },
    });
    await tx.productApprovalBatchItem.createMany({
      data: ids.map((productId) => ({ batchId: created.id, productId, status: ApprovalStatus.PENDING })),
    });
    // A resubmitted REJECTED product goes back under review — never silently
    // APPROVED, and never left REJECTED while an item for it is pending. An
    // APPROVED product submitted for new variants stays APPROVED and on sale:
    // only those variants are under review.
    await tx.product.updateMany({
      where: { id: { in: ids }, approvalStatus: { not: ApprovalStatus.APPROVED } },
      data: { approvalStatus: ApprovalStatus.PENDING },
    });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'approval_batch.submit',
        entityType: 'ProductApprovalBatch',
        entityId: created.id,
        after: { sellerId, productCount: ids.length, submitAll: productIds === undefined },
      },
    });
    return created.id;
  });

  const batch = await loadBatchOrThrow(batchId);
  await notificationService.notifyAdmins(Permission.PRODUCT_APPROVAL_REVIEW, {
    type: NotificationType.ADMIN_PRODUCTS_SUBMITTED,
    dedupeKey: `approval-batch:${batch.id}:submitted`,
    context: { sellerName: batch.seller.name, count: batch.items.length },
  });

  return toBatchDto(batch);
}

/** Counts for a page of batches — one grouped query, never the items themselves. */
async function summarise(
  batches: { id: string; sellerId: string; status: ApprovalStatus; submittedAt: Date; reviewedAt: Date | null; reviewNote: string | null; seller: { name: string; sellerType: string } }[],
): Promise<ProductApprovalBatchSummaryDto[]> {
  if (batches.length === 0) return [];
  const ids = batches.map((b) => b.id);
  const [statusCounts, categoryCounts] = await Promise.all([
    prisma.productApprovalBatchItem.groupBy({ by: ['batchId', 'status'], where: { batchId: { in: ids } }, _count: { _all: true } }),
    prisma.$queryRaw<{ batch_id: string; categories: bigint }[]>`
      SELECT i.batch_id, COUNT(DISTINCT p.category_id) AS categories
      FROM product_approval_batch_items i JOIN products p ON p.id = i.product_id
      WHERE i.batch_id = ANY(${ids}::uuid[])
      GROUP BY i.batch_id`,
  ]);
  const count = (batchId: string, status?: ApprovalStatus) =>
    statusCounts
      .filter((row) => row.batchId === batchId && (!status || row.status === status))
      .reduce((sum, row) => sum + row._count._all, 0);
  const categories = new Map(categoryCounts.map((row) => [row.batch_id, Number(row.categories)]));
  return batches.map((batch) => ({
    id: batch.id,
    sellerId: batch.sellerId,
    sellerName: batch.seller.name,
    sellerType: batch.seller.sellerType,
    status: batch.status,
    submittedAt: batch.submittedAt.toISOString(),
    reviewedAt: batch.reviewedAt?.toISOString() ?? null,
    reviewNote: batch.reviewNote,
    itemCount: count(batch.id),
    pendingCount: count(batch.id, ApprovalStatus.PENDING),
    approvedCount: count(batch.id, ApprovalStatus.APPROVED),
    rejectedCount: count(batch.id, ApprovalStatus.REJECTED),
    categoryCount: categories.get(batch.id) ?? 0,
  }));
}

const SUMMARY_SELECT = {
  id: true,
  sellerId: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  reviewNote: true,
  seller: { select: { name: true, sellerType: true } },
} as const;

export async function getApprovalBatchSummary(batchId: string, scopeSellerId?: string): Promise<ProductApprovalBatchSummaryDto> {
  const batch = await prisma.productApprovalBatch.findUnique({ where: { id: batchId }, select: SUMMARY_SELECT });
  if (!batch || (scopeSellerId && batch.sellerId !== scopeSellerId)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Approval batch not found.' });
  }
  return (await summarise([batch]))[0]!;
}

/**
 * Admin — one page of a batch's products as a compact table row each:
 * name, category/subcategory, SKU, the seller's MRP/price/stock, thumbnail,
 * status. Built for batches of 1000+ products (offset pages, max 200 rows).
 */
export async function listBatchProducts(
  batchId: string,
  options: { offset: number; limit: number },
): Promise<ProductApprovalBatchProductsPageDto> {
  const batch = await prisma.productApprovalBatch.findUnique({ where: { id: batchId }, select: { sellerId: true } });
  if (!batch) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Approval batch not found.' });

  const [total, items] = await Promise.all([
    prisma.productApprovalBatchItem.count({ where: { batchId } }),
    prisma.productApprovalBatchItem.findMany({
      where: { batchId },
      // Items of one submission share their insert time: the products' own
      // creation order is what the seller will recognise.
      orderBy: [{ product: { createdAt: 'asc' } }, { id: 'asc' }],
      skip: options.offset,
      take: options.limit,
      select: {
        id: true,
        status: true,
        reviewNote: true,
        product: {
          select: {
            id: true,
            name: true,
            status: true,
            deletedAt: true,
            optionGroups: true,
            category: { select: { name: true, parent: { select: { name: true } } } },
            images: { orderBy: { displayOrder: 'asc' }, take: 1, select: { url: true, thumbUrl: true } },
            variants: {
              where: { deletedAt: null },
              orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
              select: {
                id: true,
                sku: true,
                variantName: true,
                optionValues: true,
                approvalStatus: true,
                sellerListings: {
                  where: { sellerId: batch.sellerId },
                  select: { mrpPaise: true, pricePaise: true, stockQty: true, tracksStock: true, isAvailable: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  return {
    total,
    offset: options.offset,
    items: items.map((item) => {
      const product = item.product;
      const variant = product.variants[0] ?? null;
      const listing = variant?.sellerListings[0] ?? null;
      const parent = product.category.parent;
      return {
        itemId: item.id,
        productId: product.id,
        itemStatus: item.status,
        reviewNote: item.reviewNote,
        name: product.name,
        category: parent ? parent.name : product.category.name,
        subcategory: parent ? product.category.name : null,
        sku: variant?.sku ?? null,
        variantName: variant?.variantName ?? null,
        mrpPaise: listing?.mrpPaise ?? null,
        pricePaise: listing?.pricePaise ?? null,
        stockQty: listing?.stockQty ?? null,
        thumbUrl: product.images[0]?.thumbUrl ?? product.images[0]?.url ?? null,
        productStatus: product.status,
        removed: product.deletedAt !== null,
        optionGroups: optionGroupsOf(product.optionGroups),
        variants: product.variants.map((v) => {
          const own = v.sellerListings[0] ?? null;
          return {
            id: v.id,
            variantName: v.variantName,
            optionValues: optionValuesOf(v.optionValues),
            approvalStatus: v.approvalStatus,
            pricePaise: own?.pricePaise ?? null,
            mrpPaise: own?.mrpPaise ?? null,
            stockQty: own?.stockQty ?? null,
            tracksStock: own?.tracksStock ?? true,
            isAvailable: own?.isAvailable ?? false,
          };
        }),
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Reads — shared by seller (scoped) and admin (unscoped)                    */
/* -------------------------------------------------------------------------- */

export async function listApprovalBatches(
  scopeSellerId: string | undefined,
  options: { status?: ApprovalStatus; cursor?: string | null; limit: number },
): Promise<CursorPage<ProductApprovalBatchSummaryDto>> {
  const batches = await prisma.productApprovalBatch.findMany({
    where: {
      ...(scopeSellerId ? { sellerId: scopeSellerId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.cursor ? { submittedAt: { lt: new Date(options.cursor) } } : {}),
    },
    select: SUMMARY_SELECT,
    orderBy: { submittedAt: 'desc' },
    take: options.limit + 1,
  });

  const hasMore = batches.length > options.limit;
  const page = hasMore ? batches.slice(0, options.limit) : batches;
  const last = page[page.length - 1];

  return {
    items: await summarise(page),
    hasMore,
    nextCursor: hasMore && last ? last.submittedAt.toISOString() : null,
  };
}

export async function getApprovalBatchDetail(batchId: string, scopeSellerId?: string) {
  return toBatchDto(await loadBatchOrThrow(batchId, scopeSellerId));
}

/**
 * Admin only — the batch plus what is being reviewed in each item (details,
 * category, default variant, any images already attached). Read-only; the
 * review itself stays in `reviewBatchItem`.
 */
export async function getApprovalBatchReviewDetail(batchId: string): Promise<ProductApprovalBatchReviewDto> {
  const batch = toBatchDto(await loadBatchOrThrow(batchId));
  const products = await loadReviewProducts(batch.items.map((item) => item.productId));
  return {
    ...batch,
    items: batch.items.map((item) => ({ ...item, product: products.get(item.productId) ?? null })),
  };
}

/* -------------------------------------------------------------------------- */
/* Admin — add an eligible, not-yet-batched product to an open batch         */
/* -------------------------------------------------------------------------- */

export async function addItemToBatch(batchId: string, productId: string, actorUserId: string) {
  const batch = await loadBatchOrThrow(batchId);

  if (batch.status !== ApprovalStatus.PENDING) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This batch has already been fully reviewed.',
    });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, submittedBySellerId: true, approvalStatus: true, deletedAt: true },
  });
  if (!product || product.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  }
  if (product.submittedBySellerId !== batch.sellerId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "This product was not submitted by this batch's seller.",
    });
  }
  if (product.approvalStatus === ApprovalStatus.APPROVED) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `"${product.name}" is already approved — nothing to add.`,
    });
  }

  const openElsewhere = await prisma.productApprovalBatchItem.findFirst({
    where: { productId, status: ApprovalStatus.PENDING, batchId: { not: batchId } },
  });
  if (openElsewhere) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 409,
      message: `"${product.name}" is already awaiting review in another batch.`,
    });
  }

  await runInTransaction(async (tx) => {
    await tx.productApprovalBatchItem.create({
      data: { batchId, productId, status: ApprovalStatus.PENDING },
    });
    await tx.product.update({
      where: { id: productId },
      data: { approvalStatus: ApprovalStatus.PENDING },
    });
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'approval_batch.add_item',
      entityType: 'ProductApprovalBatch',
      entityId: batchId,
      after: { productId },
    },
  });

  return getApprovalBatchDetail(batchId);
}

/* -------------------------------------------------------------------------- */
/* Admin — review one item (approve/reject)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Applies one review decision to products and their variants.
 *
 *   product not yet approved   the product takes the decision (as always);
 *                              on APPROVED its variants are approved with it
 *   product already APPROVED   it was submitted for NEW variants only: those
 *                              PENDING variants take the decision — APPROVED
 *                              ones go live (status ACTIVE), REJECTED ones stay
 *                              hidden — and the product itself stays APPROVED
 *                              and on sale either way.
 */
async function decideProducts(tx: Tx, productIds: string[], decision: ApprovalStatus): Promise<void> {
  if (productIds.length === 0) return;
  const approved = await tx.product.findMany({
    where: { id: { in: productIds }, approvalStatus: ApprovalStatus.APPROVED },
    select: { id: true },
  });
  const approvedIds = new Set(approved.map((p) => p.id));
  const firstReview = productIds.filter((id) => !approvedIds.has(id));
  if (firstReview.length > 0) {
    await tx.product.updateMany({ where: { id: { in: firstReview } }, data: { approvalStatus: decision } });
  }
  if (decision === ApprovalStatus.APPROVED) {
    await tx.productVariant.updateMany({
      where: { productId: { in: productIds }, deletedAt: null, approvalStatus: ApprovalStatus.PENDING },
      data: { approvalStatus: ApprovalStatus.APPROVED, status: ProductStatus.ACTIVE },
    });
  } else if (approvedIds.size > 0) {
    await tx.productVariant.updateMany({
      where: { productId: { in: [...approvedIds] }, deletedAt: null, approvalStatus: ApprovalStatus.PENDING },
      data: { approvalStatus: ApprovalStatus.REJECTED },
    });
  }
}

export interface ReviewBatchItemInput {
  batchId: string;
  itemId: string;
  status: ApprovalStatus;
  reviewNote?: string | null;
  actorUserId: string;
}

export async function reviewBatchItem(input: ReviewBatchItemInput) {
  if (input.status === ApprovalStatus.PENDING) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'A review must approve or reject — not revert to pending.',
    });
  }
  if (input.status === ApprovalStatus.REJECTED && !input.reviewNote?.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'A reason is required when rejecting.',
    });
  }

  await runInTransaction(async (tx) => {
    const item = await tx.productApprovalBatchItem.findUnique({ where: { id: input.itemId } });
    if (!item || item.batchId !== input.batchId) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Approval item not found.' });
    }

    // The ONLY legal transition is PENDING -> APPROVED/REJECTED. Once
    // decided, an item is terminal — see this module's own doc comment on
    // why a rejected product's only way back is a fresh submission
    // (`submitApprovalBatch`), never a direct flip of the old item.
    if (item.status !== ApprovalStatus.PENDING) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: `This item has already been ${item.status.toLowerCase()}.`,
        internalMessage: `illegal review transition ${item.status} -> ${input.status} on item ${item.id}`,
      });
    }

    await tx.productApprovalBatchItem.update({
      where: { id: item.id },
      data: { status: input.status, reviewNote: input.reviewNote?.trim() || null },
    });

    await decideProducts(tx, [item.productId], input.status);

    // Recompute the batch's own aggregate — same shape as
    // order-state.service.ts's `recomputeParentOrderStatus`: derived from
    // its children, never chosen directly. Stays PENDING while any item
    // still is; once every item is decided, APPROVED only if ALL of them
    // were, REJECTED if even one was not.
    const siblings = await tx.productApprovalBatchItem.findMany({
      where: { batchId: input.batchId },
      select: { status: true },
    });
    const stillPending = siblings.some((s) => s.status === ApprovalStatus.PENDING);
    if (!stillPending) {
      const allApproved = siblings.every((s) => s.status === ApprovalStatus.APPROVED);
      await tx.productApprovalBatch.update({
        where: { id: input.batchId },
        data: {
          status: allApproved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
          reviewedByUserId: input.actorUserId,
          reviewedAt: new Date(),
        },
      });
    }
  });

  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.status === ApprovalStatus.APPROVED ? 'approval_batch_item.approve' : 'approval_batch_item.reject',
      entityType: 'ProductApprovalBatchItem',
      entityId: input.itemId,
      after: { status: input.status, reviewNote: input.reviewNote ?? null },
    },
  });

  const detail = await getApprovalBatchDetail(input.batchId);
  // An item is decided exactly once (PENDING -> APPROVED/REJECTED only).
  await notificationService.notifySeller(detail.sellerId, {
    type: input.status === ApprovalStatus.APPROVED ? NotificationType.SELLER_PRODUCT_APPROVED : NotificationType.SELLER_PRODUCT_REJECTED,
    dedupeKey: `approval-item:${input.itemId}:${input.status}`,
    context: {
      productName: detail.items.find((i) => i.id === input.itemId)?.productName ?? 'Your product',
      reason: input.reviewNote ?? null,
    },
  });
  return detail;
}

/* -------------------------------------------------------------------------- */
/* Admin — approve a whole batch in one action                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /admin/approval-batches/:id/approve — every still-PENDING item of the
 * batch is approved in ONE transaction (the batch row locked, so a second
 * click or a concurrent item review cannot double-decide). Items already
 * decided one by one keep their decision. An item whose product the seller
 * deleted meanwhile is closed as REJECTED instead of approving a removed
 * product. Only `approvalStatus` changes: the seller's price, stock and
 * listing are never touched — approval just makes them visible.
 */
export async function approveBatch(batchId: string, actorUserId: string): Promise<ApproveProductBatchResultDto> {
  const outcome = await runInTransaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ status: ApprovalStatus; seller_id: string }[]>`
      SELECT status, seller_id FROM product_approval_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
    if (!locked) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Approval batch not found.' });
    if (locked.status !== ApprovalStatus.PENDING) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: 'This batch has already been fully reviewed.',
        internalMessage: `approve on batch ${batchId} in status ${locked.status}`,
      });
    }

    const pending = await tx.productApprovalBatchItem.findMany({
      where: { batchId, status: ApprovalStatus.PENDING },
      select: { id: true, productId: true, product: { select: { deletedAt: true } } },
    });
    const live = pending.filter((item) => item.product.deletedAt === null);
    const removed = pending.filter((item) => item.product.deletedAt !== null);

    if (live.length > 0) {
      await tx.productApprovalBatchItem.updateMany({
        where: { id: { in: live.map((item) => item.id) } },
        data: { status: ApprovalStatus.APPROVED },
      });
      await decideProducts(tx, live.map((item) => item.productId), ApprovalStatus.APPROVED);
    }
    if (removed.length > 0) {
      await tx.productApprovalBatchItem.updateMany({
        where: { id: { in: removed.map((item) => item.id) } },
        data: { status: ApprovalStatus.REJECTED, reviewNote: 'The seller removed this product before review.' },
      });
    }

    // Same aggregate rule as reviewBatchItem: APPROVED only if every item was.
    const rejected = await tx.productApprovalBatchItem.count({ where: { batchId, status: ApprovalStatus.REJECTED } });
    await tx.productApprovalBatch.update({
      where: { id: batchId },
      data: {
        status: rejected === 0 ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
        reviewedByUserId: actorUserId,
        reviewedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'approval_batch.approve',
        entityType: 'ProductApprovalBatch',
        entityId: batchId,
        after: { approvedCount: live.length, removedCount: removed.length },
      },
    });
    return { sellerId: locked.seller_id, approved: live.length, removed: removed.length };
  });

  // One notice for the whole batch, not one per product.
  if (outcome.approved > 0) {
    await notificationService.notifySeller(outcome.sellerId, {
      type: NotificationType.SELLER_PRODUCT_APPROVED,
      dedupeKey: `approval-batch:${batchId}:approved`,
      context: { count: outcome.approved },
    });
  }

  return {
    batch: await getApprovalBatchSummary(batchId),
    approvedCount: outcome.approved,
    removedCount: outcome.removed,
  };
}
