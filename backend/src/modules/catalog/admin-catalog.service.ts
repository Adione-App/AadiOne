/**
 * Admin catalogue management (Task 4.4).
 *
 * Two rules run through everything here:
 *   1. Nothing an order references is ever hard-deleted. Deactivate or
 *      soft-delete instead, so a six-month-old receipt still renders.
 *   2. Every mutation writes an audit row — who changed what, and what it
 *      looked like before.
 */

import type { Prisma } from '@prisma/client';
import {
  CodPolicy,
  ErrorCode,
  ProductStatus,
  type CatalogVertical,
  type CursorPage,
  type ProductSummaryDto,
  type UnitType,
} from '../../shared';
import { slugify } from '../../shared/text';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { storage, buildImageKey, assertUploadable } from '../../infra/storage';
import { moduleLogger } from '../../common/logger';
import * as storeService from '../stores/store.service';
import { invalidateCategoryCache, mapProducts } from './catalog.service';
import { PRODUCT_INCLUDE } from './catalog.repository';

const log = moduleLogger('admin:catalog');

async function audit(input: {
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: (input.before ?? null) as Prisma.InputJsonValue,
      after: (input.after ?? null) as Prisma.InputJsonValue,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

export interface UpsertCategoryInput {
  name: string;
  nameHi?: string | null;
  parentId?: string | null;
  imageUrl?: string | null;
  displayOrder?: number;
  isActive?: boolean;
  vertical?: CatalogVertical;
  allowCod?: CodPolicy;
}

export async function createCategory(
  input: UpsertCategoryInput,
  actorUserId: string,
): Promise<{ id: string }> {
  const slug = slugify(input.name);

  // depth and path are derived from the parent, never supplied by the client —
  // a wrong path would silently break every "everything under X" query.
  let depth = 0;
  let path = slug;

  if (input.parentId) {
    const parent = await prisma.category.findFirst({
      where: { id: input.parentId, deletedAt: null },
    });
    if (!parent) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Parent category not found.' });
    depth = parent.depth + 1;
    path = `${parent.path}/${slug}`;
  }

  const duplicate = await prisma.category.findFirst({
    where: { parentId: input.parentId ?? null, slug, deletedAt: null },
  });
  if (duplicate) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'A category with this name already exists here.',
    });
  }

  const category = await prisma.category.create({
    data: {
      name: input.name,
      nameHi: input.nameHi ?? null,
      slug,
      path,
      depth,
      parentId: input.parentId ?? null,
      imageUrl: input.imageUrl ?? null,
      displayOrder: input.displayOrder ?? 0,
      isActive: input.isActive ?? true,
      vertical: input.vertical ?? 'GROCERY',
      allowCod: input.allowCod ?? CodPolicy.INHERIT,
    },
  });

  invalidateCategoryCache();
  await audit({
    actorUserId,
    action: 'category.create',
    entityType: 'Category',
    entityId: category.id,
    after: category,
  });
  return { id: category.id };
}

export async function updateCategory(
  id: string,
  input: Partial<UpsertCategoryInput>,
  actorUserId: string,
): Promise<void> {
  const before = await prisma.category.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Category not found.' });

  await runInTransaction(async (tx) => {
    const after = await tx.category.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.nameHi !== undefined ? { nameHi: input.nameHi } : {}),
        ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.allowCod !== undefined ? { allowCod: input.allowCod } : {}),
        ...(input.vertical !== undefined ? { vertical: input.vertical } : {}),
      },
    });

    // Renaming changes the slug, and the slug is part of every descendant's
    // materialised path — so the subtree has to be rewritten in the same
    // transaction or "everything under X" silently stops matching.
    if (input.name !== undefined && slugify(input.name) !== before.slug) {
      const newSlug = slugify(input.name);
      const newPath = before.parentId
        ? `${before.path.slice(0, before.path.lastIndexOf('/'))}/${newSlug}`
        : newSlug;

      await tx.category.update({ where: { id }, data: { slug: newSlug, path: newPath } });
      await tx.$executeRaw`
        UPDATE categories
        SET path = ${newPath} || SUBSTRING(path FROM ${before.path.length + 1})
        WHERE path LIKE ${`${before.path}/%`}`;
    }

    return after;
  });

  invalidateCategoryCache();
  await audit({
    actorUserId,
    action: 'category.update',
    entityType: 'Category',
    entityId: id,
    before,
    after: input,
  });
}

/**
 * Soft-deletes a category.
 *
 * Refuses while products still hang off it: silently orphaning a catalogue is
 * far worse than an error the admin can act on.
 */
export async function deleteCategory(id: string, actorUserId: string): Promise<void> {
  const [productCount, childCount] = await Promise.all([
    prisma.product.count({ where: { categoryId: id, deletedAt: null } }),
    prisma.category.count({ where: { parentId: id, deletedAt: null } }),
  ]);

  if (productCount > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `This category still has ${productCount} product(s). Move or remove them first.`,
    });
  }
  if (childCount > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `This category still has ${childCount} subcategory(ies). Remove them first.`,
    });
  }

  await prisma.category.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
  invalidateCategoryCache();
  await audit({ actorUserId, action: 'category.delete', entityType: 'Category', entityId: id });
}

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Admin's own product list — deliberately NOT the customer-facing
 * `catalogService.listProducts`, which filters to `status = 'ACTIVE'` (and
 * optionally in-stock) so shoppers never see a draft or hidden product. An
 * admin managing the catalogue needs to see and toggle EVERY status,
 * including the ones a customer must never find, or a product switched to
 * "hidden" would also disappear from the admin's own list — making it
 * impossible to switch back on.
 */
export async function listProductsForAdmin(options: {
  categoryId?: string;
  limit: number;
}): Promise<CursorPage<ProductSummaryDto>> {
  const store = await storeService.getActiveStore();

  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    },
    include: PRODUCT_INCLUDE(store.id),
    orderBy: { createdAt: 'desc' },
    take: options.limit,
  });

  return {
    items: await mapProducts(products),
    hasMore: false,
    nextCursor: null,
  };
}

export interface UpsertProductInput {
  name: string;
  nameHi?: string | null;
  categoryId: string;
  brandId?: string | null;
  description?: string | null;
  descriptionHi?: string | null;
  searchKeywords?: string[];
  taxRateBp?: number;
  hsnCode?: string | null;
  allowCod?: CodPolicy;
  status?: ProductStatus;
  attributes?: Record<string, unknown>;
  isDailyEssential?: boolean;
  popularityScore?: number;
}

export async function createProduct(
  input: UpsertProductInput,
  actorUserId: string,
): Promise<{ id: string }> {
  const category = await prisma.category.findFirst({
    where: { id: input.categoryId, deletedAt: null },
  });
  if (!category) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Category not found.' });

  const product = await prisma.product.create({
    data: {
      name: input.name,
      nameHi: input.nameHi ?? null,
      slug: slugify(input.name),
      categoryId: input.categoryId,
      brandId: input.brandId ?? null,
      description: input.description ?? null,
      descriptionHi: input.descriptionHi ?? null,
      searchKeywords: input.searchKeywords ?? [],
      taxRateBp: input.taxRateBp ?? 0,
      hsnCode: input.hsnCode ?? null,
      allowCod: input.allowCod ?? CodPolicy.INHERIT,
      // New products start as DRAFT: a product with no variant and no price
      // must never be purchasable, and requiring an explicit publish makes
      // that impossible by accident.
      status: input.status ?? ProductStatus.DRAFT,
      attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
      isDailyEssential: input.isDailyEssential ?? false,
      popularityScore: input.popularityScore ?? 0,
    },
  });

  await audit({
    actorUserId,
    action: 'product.create',
    entityType: 'Product',
    entityId: product.id,
    after: product,
  });
  return { id: product.id };
}

export async function updateProduct(
  id: string,
  input: Partial<UpsertProductInput>,
  actorUserId: string,
): Promise<void> {
  const before = await prisma.product.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });

  if (input.status === ProductStatus.ACTIVE) {
    // Publishing needs at least one sellable offer, or the product appears in
    // listings and cannot be added to a cart.
    const sellable = await prisma.storeVariant.count({
      where: { variant: { productId: id, deletedAt: null } },
    });
    if (sellable === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Add at least one variant with a price before publishing this product.',
      });
    }
  }

  await prisma.product.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name, slug: slugify(input.name) } : {}),
      ...(input.nameHi !== undefined ? { nameHi: input.nameHi } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.brandId !== undefined ? { brandId: input.brandId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.descriptionHi !== undefined ? { descriptionHi: input.descriptionHi } : {}),
      ...(input.searchKeywords !== undefined ? { searchKeywords: input.searchKeywords } : {}),
      ...(input.taxRateBp !== undefined ? { taxRateBp: input.taxRateBp } : {}),
      ...(input.allowCod !== undefined ? { allowCod: input.allowCod } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.attributes !== undefined
        ? { attributes: input.attributes as Prisma.InputJsonValue }
        : {}),
      ...(input.isDailyEssential !== undefined
        ? { isDailyEssential: input.isDailyEssential }
        : {}),
      ...(input.popularityScore !== undefined
        ? { popularityScore: input.popularityScore }
        : {}),
    },
  });

  await audit({
    actorUserId,
    action: 'product.update',
    entityType: 'Product',
    entityId: id,
    before,
    after: input,
  });
}

/**
 * Soft-deletes a product and stops it being sold.
 *
 * Hard deletion is never offered: `order_items` snapshots the display fields
 * but keeps `variant_id` for reporting, and a customer's past order must keep
 * resolving.
 */
export async function deleteProduct(id: string, actorUserId: string): Promise<void> {
  await runInTransaction(async (tx) => {
    const now = new Date();
    await tx.product.update({
      where: { id },
      data: { deletedAt: now, status: ProductStatus.ARCHIVED },
    });
    await tx.productVariant.updateMany({
      where: { productId: id },
      data: { deletedAt: now, status: ProductStatus.ARCHIVED },
    });
    // Withdraw the offer so it disappears from listings immediately.
    await tx.storeVariant.updateMany({
      where: { variant: { productId: id } },
      data: { isAvailable: false },
    });
  });

  await audit({ actorUserId, action: 'product.delete', entityType: 'Product', entityId: id });
  log.info({ productId: id, actorUserId }, 'product archived');
}

/* -------------------------------------------------------------------------- */
/* Variants and store offers                                                  */
/* -------------------------------------------------------------------------- */

export interface CreateVariantInput {
  productId: string;
  sku: string;
  variantName: string;
  unit: UnitType;
  unitValue: number;
  isDefault?: boolean;
  displayOrder?: number;
  allowCod?: CodPolicy;
  /** The store-scoped offer created alongside the variant. */
  mrpPaise: number;
  pricePaise: number;
  stockQty?: number;
  maxQtyPerOrder?: number;
  lowStockThreshold?: number;
}

export async function createVariant(
  input: CreateVariantInput,
  actorUserId: string,
): Promise<{ id: string }> {
  if (input.pricePaise > input.mrpPaise) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Selling price cannot be higher than MRP.',
    });
  }

  const store = await storeService.getActiveStore();

  const variantId = await runInTransaction(async (tx) => {
    // Only one default per product, or the product card would be ambiguous.
    if (input.isDefault) {
      await tx.productVariant.updateMany({
        where: { productId: input.productId },
        data: { isDefault: false },
      });
    }

    const variant = await tx.productVariant.create({
      data: {
        productId: input.productId,
        sku: input.sku.toUpperCase(),
        variantName: input.variantName,
        unit: input.unit,
        unitValue: input.unitValue,
        isDefault: input.isDefault ?? false,
        displayOrder: input.displayOrder ?? 0,
        allowCod: input.allowCod ?? CodPolicy.INHERIT,
        status: ProductStatus.ACTIVE,
      },
    });

    await tx.storeVariant.create({
      data: {
        storeId: store.id,
        variantId: variant.id,
        mrpPaise: input.mrpPaise,
        pricePaise: input.pricePaise,
        stockQty: input.stockQty ?? 0,
        maxQtyPerOrder: input.maxQtyPerOrder ?? 10,
        lowStockThreshold: input.lowStockThreshold ?? 5,
        isAvailable: true,
      },
    });

    return variant.id;
  });

  await audit({
    actorUserId,
    action: 'variant.create',
    entityType: 'ProductVariant',
    entityId: variantId,
    after: input,
  });
  return { id: variantId };
}

export async function deleteVariant(id: string, actorUserId: string): Promise<void> {
  await runInTransaction(async (tx) => {
    await tx.productVariant.update({
      where: { id },
      data: { deletedAt: new Date(), status: ProductStatus.ARCHIVED },
    });
    await tx.storeVariant.updateMany({
      where: { variantId: id },
      data: { isAvailable: false },
    });
  });
  await audit({
    actorUserId,
    action: 'variant.delete',
    entityType: 'ProductVariant',
    entityId: id,
  });
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

export async function createUploadTarget(input: {
  fileName: string;
  contentType: string;
  folder?: 'products' | 'categories';
}): Promise<ReturnType<typeof storage.createPresignedUpload>> {
  assertUploadable(input.contentType);
  // Presigned upload: image bytes go straight to object storage and never
  // through the API's JSON body (PRD §42).
  return storage.createPresignedUpload({ folder: input.folder ?? 'products', ...input });
}

/**
 * A category has exactly one image (`Category.imageUrl`), not a gallery like
 * a product — so attaching one is just resolving the uploaded key to a
 * public URL and writing it straight onto the row, no join table needed.
 */
export async function attachCategoryImage(
  input: { categoryId: string; key: string },
  actorUserId: string,
): Promise<{ imageUrl: string }> {
  const category = await prisma.category.findFirst({
    where: { id: input.categoryId, deletedAt: null },
  });
  if (!category) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Category not found.' });

  const imageUrl = storage.publicUrl(input.key);

  await prisma.category.update({
    where: { id: input.categoryId },
    data: { imageUrl },
  });
  invalidateCategoryCache();

  await audit({
    actorUserId,
    action: 'category.image.attach',
    entityType: 'Category',
    entityId: input.categoryId,
    before: { imageUrl: category.imageUrl },
    after: { imageUrl },
  });

  return { imageUrl };
}

export async function attachProductImage(
  input: { productId: string; variantId?: string | null; key: string; altText?: string | null },
  actorUserId: string,
): Promise<{ id: string }> {
  const url = storage.publicUrl(input.key);
  const count = await prisma.productImage.count({ where: { productId: input.productId } });

  const image = await prisma.productImage.create({
    data: {
      productId: input.productId,
      variantId: input.variantId ?? null,
      url,
      thumbUrl: url,
      cardUrl: url,
      altText: input.altText ?? null,
      displayOrder: count,
    },
  });

  await audit({
    actorUserId,
    action: 'product.image.attach',
    entityType: 'ProductImage',
    entityId: image.id,
    after: { productId: input.productId, key: input.key },
  });
  return { id: image.id };
}

export async function removeProductImage(id: string, actorUserId: string): Promise<void> {
  const image = await prisma.productImage.findUnique({ where: { id } });
  if (!image) return;

  await prisma.productImage.delete({ where: { id } });
  // Best effort: a stale object costs a fraction of a paisa, a failed request
  // costs the admin their time.
  await storage.remove(image.url.split('/static/').pop() ?? image.url).catch(() => undefined);

  await audit({
    actorUserId,
    action: 'product.image.remove',
    entityType: 'ProductImage',
    entityId: id,
    before: image,
  });
}

/** Direct upload endpoint used only by the local development provider. */
export async function putDirect(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<{ url: string }> {
  const stored = await storage.put(key || buildImageKey('products', 'upload.jpg'), body, contentType);
  return { url: stored.url };
}
