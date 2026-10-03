/**
 * Seller-submitted product catalog approval.
 *
 * A seller creates its own Product (PENDING by construction — see
 * `createSellerProduct`), bundles one or more of its own pending/rejected
 * products into a `ProductApprovalBatch`, and admin reviews each item
 * independently. `Product.approvalStatus` is the single gate that matters
 * downstream (see admin-seller-catalog.service.ts's `createSellerListing`,
 * which refuses anything not APPROVED) — this module is the ONLY code
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

import {
  ApprovalStatus,
  ErrorCode,
  NotificationType,
  Permission,
  ProductStatus,
  type CursorPage,
  type ProductApprovalBatchReviewDto,
  type UnitType,
} from '../../shared';
import * as notificationService from '../notifications/notification.service';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { slugify } from '../../shared/text';
import { assertSellerMayUseCategoryForProduct } from './seller-category.service';
import { getOwnProduct, loadReviewProducts } from './seller-product.service';

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
  sku: string;
  variantName: string;
  unit: UnitType;
  unitValue: number;
}

export async function createSellerProduct(
  sellerId: string,
  input: CreateSellerProductInput,
  actorUserId: string,
): Promise<{ id: string; variantId: string }> {
  // Only the seller's OWN categories (top category, subcategory or — for a
  // restaurant — menu section); another seller's is indistinguishable from a
  // missing one (seller-category.service).
  await assertSellerMayUseCategoryForProduct(sellerId, input.categoryId);

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
      },
    });

    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        sku: input.sku.trim().toUpperCase(),
        variantName: input.variantName,
        unit: input.unit,
        unitValue: input.unitValue,
        isDefault: true,
        status: ProductStatus.ACTIVE,
      },
    });

    return { productId: product.id, variantId: variant.id };
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.seller_create',
      entityType: 'Product',
      entityId: created.productId,
      after: { sellerId, name: input.name, categoryId: input.categoryId },
    },
  });

  return { id: created.productId, variantId: created.variantId };
}

/* -------------------------------------------------------------------------- */
/* Seller — correct its own product before (re)submission                    */
/* -------------------------------------------------------------------------- */

/**
 * The window in which a seller may change its own product's content (details,
 * default variant, images): while nobody is reviewing it and it is not yet
 * approved — never submitted (PENDING, no open item) or REJECTED. Approval is
 * final in this model (there is no re-approval flow), and an item under review
 * must not change underneath the admin. Edits never touch `approvalStatus`:
 * a corrected REJECTED product stays REJECTED until `submitApprovalBatch`.
 * Missing and another seller's product are reported identically (NOT_FOUND).
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
  if (product.approvalStatus === ApprovalStatus.APPROVED) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: 'An approved product can no longer be edited.',
    });
  }
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

export async function updateSellerProduct(
  sellerId: string,
  productId: string,
  input: UpdateSellerProductInput,
  actorUserId: string,
) {
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
      after: { ...input, ...(sku !== undefined ? { sku } : {}) },
    },
  });

  return getOwnProduct(sellerId, productId);
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

export async function submitApprovalBatch(
  sellerId: string,
  productIds: string[],
  actorUserId: string,
) {
  const uniqueIds = [...new Set(productIds)];
  if (uniqueIds.length !== productIds.length) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'The same product was listed more than once.',
    });
  }

  const products = await prisma.product.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true, submittedBySellerId: true, approvalStatus: true, deletedAt: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  for (const id of uniqueIds) {
    const product = byId.get(id);
    // A missing id and one belonging to another seller are reported
    // IDENTICALLY — a seller must never learn that a product id merely
    // belonging to someone else exists (#15/#27), same principle as
    // seller-order.service.ts's `loadOwned`.
    if (!product || product.deletedAt || product.submittedBySellerId !== sellerId) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'One of the selected products could not be found.',
        internalMessage: `product ${id} not found or not owned by seller ${sellerId}`,
      });
    }
    if (product.approvalStatus === ApprovalStatus.APPROVED) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `"${product.name}" is already approved — nothing to submit.`,
      });
    }
  }

  // Duplicate/pending guard: none of these may already be awaiting review in
  // ANOTHER open batch (a product's own `approvalStatus` doubles as "has an
  // open item" once submitted — see the PENDING write below — so this is the
  // one place that still has to ask the batch items directly, since a fresh,
  // never-submitted product is ALSO `PENDING` by schema default).
  const openItems = await prisma.productApprovalBatchItem.findMany({
    where: { productId: { in: uniqueIds }, status: ApprovalStatus.PENDING },
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

  const batch = await runInTransaction(async (tx) => {
    const created = await tx.productApprovalBatch.create({
      data: {
        sellerId,
        status: ApprovalStatus.PENDING,
        submittedByUserId: actorUserId,
        items: {
          create: uniqueIds.map((productId) => ({ productId, status: ApprovalStatus.PENDING })),
        },
      },
      include: BATCH_INCLUDE,
    });

    // Resubmission of a previously REJECTED product puts it back under
    // review — never silently APPROVED, and never left REJECTED while an
    // item for it is actively pending (see the duplicate guard above, which
    // relies on exactly this invariant).
    await tx.product.updateMany({
      where: { id: { in: uniqueIds } },
      data: { approvalStatus: ApprovalStatus.PENDING },
    });

    return created;
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'approval_batch.submit',
      entityType: 'ProductApprovalBatch',
      entityId: batch.id,
      after: { sellerId, productIds: uniqueIds },
    },
  });

  await notificationService.notifyAdmins(Permission.PRODUCT_APPROVAL_REVIEW, {
    type: NotificationType.ADMIN_PRODUCTS_SUBMITTED,
    dedupeKey: `approval-batch:${batch.id}:submitted`,
    context: { sellerName: batch.seller.name, count: batch.items.length },
  });

  return toBatchDto(batch);
}

/* -------------------------------------------------------------------------- */
/* Reads — shared by seller (scoped) and admin (unscoped)                    */
/* -------------------------------------------------------------------------- */

export async function listApprovalBatches(
  scopeSellerId: string | undefined,
  options: { status?: ApprovalStatus; cursor?: string | null; limit: number },
): Promise<CursorPage<ReturnType<typeof toBatchDto>>> {
  const batches = await prisma.productApprovalBatch.findMany({
    where: {
      ...(scopeSellerId ? { sellerId: scopeSellerId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.cursor ? { submittedAt: { lt: new Date(options.cursor) } } : {}),
    },
    include: BATCH_INCLUDE,
    orderBy: { submittedAt: 'desc' },
    take: options.limit + 1,
  });

  const hasMore = batches.length > options.limit;
  const page = hasMore ? batches.slice(0, options.limit) : batches;
  const last = page[page.length - 1];

  return {
    items: page.map(toBatchDto),
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

    await tx.product.update({
      where: { id: item.productId },
      data: { approvalStatus: input.status },
    });

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
