/**
 * Seller-owned catalogue categories.
 *
 * Every seller — Aadione included — owns its whole category tree:
 *
 *   TOP CATEGORY   a Category row with `sellerId` = seller and `parentId` null
 *                  ("Grocery", "Electronics", a restaurant's "Starters").
 *   SUBCATEGORY    a Category row with `sellerId` = seller directly under one
 *                  of that seller's own top categories ("Atta, Rice & Dal").
 *   PRODUCT        `Product.submittedBySellerId` = seller, attached to one of
 *                  the seller's own categories (top or sub).
 *
 * There is no admin-owned taxonomy and no assignment step: a seller creates
 * the categories it needs and nobody else can see or touch them in the
 * Seller Panel. Two sellers may both have "Grocery › Rice" — the customer
 * catalogue and the admin catalogue explorer merge them by name for display,
 * while each row stays owned by its seller.
 *
 * Restaurants keep their existing shape: their menu sections ARE their own
 * top categories (managed via /seller/menu-sections), with no subcategories.
 *
 * Everything is decided server-side from the seller id `attachSellerContext`
 * resolved from the caller's own membership. Another seller's category is
 * reported exactly like a missing one (NOT_FOUND).
 *
 * DELETION is a soft delete, refused while any product is still attached
 * (see `deleteOwnTopCategory`) — a category is never the reason a product,
 * listing or order disappears.
 */

import type { CatalogVertical } from '@prisma/client';
import { ErrorCode, SellerType, isFoodSellerType } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { processUploadedImage, removeStoredImageIfUnused } from './uploaded-image.service';
import { slugify } from '../../shared/text';
import { assertOwnSellerKey } from './seller-image.service';
import { invalidateCategoryCache } from './catalog.service';

/* -------------------------------------------------------------------------- */
/* Pure decision                                                             */
/* -------------------------------------------------------------------------- */

export interface AccessSeller {
  id: string;
  sellerType: SellerType | string;
}

export interface AccessCategory {
  id: string;
  sellerId: string | null;
  parentId: string | null;
  isActive: boolean;
}

export type CategoryAccessDenial = 'NOT_FOUND' | 'INACTIVE' | 'NOT_A_MENU_SECTION' | 'NOT_A_TOP_CATEGORY';

export type CategoryAccess = { ok: true } | { ok: false; reason: CategoryAccessDenial };

/**
 * May `seller` use `category`?
 *
 *   purpose 'product'             attach a product (or list one) under it
 *   purpose 'subcategory-parent'  create its own subcategory directly under it
 *
 * `root` is the top category `category` sits under (the category itself when
 * it is a top category). `requireActive` is false only for listing an
 * existing product, which never gated on category status.
 *
 * The one ownership rule: the category must be the seller's OWN. A category
 * with no owner (legacy shared taxonomy) or another seller's is NOT_FOUND.
 *
 * A FOOD seller (restaurant / cafe) uses the same two-level tree as a menu:
 * top category = MENU, subcategory = MENU SECTION, product = FOOD ITEM — and
 * a food item always sits in a menu section, never directly on a menu.
 */
export function decideCategoryAccess(input: {
  seller: AccessSeller;
  category: AccessCategory | null;
  root: AccessCategory | null;
  purpose: 'product' | 'subcategory-parent';
  requireActive?: boolean;
}): CategoryAccess {
  const { seller, category, root, purpose } = input;
  const requireActive = input.requireActive ?? true;

  if (!category || category.sellerId !== seller.id) return { ok: false, reason: 'NOT_FOUND' };

  if (purpose === 'subcategory-parent') {
    if (category.parentId !== null) return { ok: false, reason: 'NOT_A_TOP_CATEGORY' };
    if (requireActive && !category.isActive) return { ok: false, reason: 'INACTIVE' };
    return { ok: true };
  }

  if (!root || root.sellerId !== seller.id || root.parentId !== null) return { ok: false, reason: 'NOT_FOUND' };
  if (isFoodSellerType(seller.sellerType) && category.parentId === null) return { ok: false, reason: 'NOT_A_MENU_SECTION' };
  if (requireActive && (!category.isActive || !root.isActive)) return { ok: false, reason: 'INACTIVE' };
  return { ok: true };
}

const DENIAL: Record<CategoryAccessDenial, { code: ErrorCode; message: string }> = {
  NOT_FOUND: { code: ErrorCode.NOT_FOUND, message: 'Category not found.' },
  INACTIVE: { code: ErrorCode.VALIDATION_ERROR, message: 'This category is switched off. Switch it on first.' },
  NOT_A_MENU_SECTION: {
    code: ErrorCode.VALIDATION_ERROR,
    message: 'Add food items to a menu section (e.g. Roti, Sabji) inside one of your menus.',
  },
  NOT_A_TOP_CATEGORY: {
    code: ErrorCode.VALIDATION_ERROR,
    message: 'Subcategories can only be created directly under one of your top categories.',
  },
};

function throwDenial(reason: CategoryAccessDenial, internal: string): never {
  const { code, message } = DENIAL[reason];
  throw new AppError(code, { message, internalMessage: internal });
}

/* -------------------------------------------------------------------------- */
/* DB-backed checks                                                          */
/* -------------------------------------------------------------------------- */

const CATEGORY_ACCESS_SELECT = {
  id: true,
  sellerId: true,
  parentId: true,
  isActive: true,
  path: true,
  depth: true,
  name: true,
  vertical: true,
} as const;

async function loadSellerForAccess(sellerId: string) {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null },
    select: { id: true, sellerType: true, code: true },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return seller;
}

/** The seller's own live top category a category sits under (itself for a top category). */
async function loadOwnRootOf(sellerId: string, category: { parentId: string | null; id: string }) {
  return prisma.category.findFirst({
    where: { id: category.parentId ?? category.id, sellerId, parentId: null, deletedAt: null },
    select: CATEGORY_ACCESS_SELECT,
  });
}

/**
 * Throws unless `sellerId` may put a product under `categoryId` (creation, a
 * category change, or — with `requireActive: false` — listing an existing
 * product): it must be one of the seller's own categories.
 */
export async function assertSellerMayUseCategoryForProduct(
  sellerId: string,
  categoryId: string,
  options: { requireActive?: boolean; notFoundMessage?: string } = {},
): Promise<void> {
  const [seller, category] = await Promise.all([
    loadSellerForAccess(sellerId),
    prisma.category.findFirst({ where: { id: categoryId, deletedAt: null }, select: CATEGORY_ACCESS_SELECT }),
  ]);
  const root = category && category.sellerId === sellerId ? await loadOwnRootOf(sellerId, category) : null;
  const decision = decideCategoryAccess({
    seller,
    category,
    root,
    purpose: 'product',
    ...(options.requireActive !== undefined ? { requireActive: options.requireActive } : {}),
  });
  if (!decision.ok) {
    if (decision.reason === 'NOT_FOUND' && options.notFoundMessage) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: options.notFoundMessage,
        internalMessage: `seller ${sellerId} may not use category ${categoryId}`,
      });
    }
    throwDenial(decision.reason, `seller ${sellerId} may not use category ${categoryId}: ${decision.reason}`);
  }
}

/** Throws unless `sellerId` may create a subcategory directly under `parentId`. Returns the parent. */
export async function assertSellerMayCreateSubcategoryUnder(sellerId: string, parentId: string) {
  const [seller, parent] = await Promise.all([
    loadSellerForAccess(sellerId),
    prisma.category.findFirst({ where: { id: parentId, deletedAt: null }, select: CATEGORY_ACCESS_SELECT }),
  ]);
  const decision = decideCategoryAccess({ seller, category: parent, root: parent, purpose: 'subcategory-parent' });
  if (!decision.ok) throwDenial(decision.reason, `seller ${sellerId} may not create a subcategory under ${parentId}: ${decision.reason}`);
  return { seller, parent: parent! };
}

/* -------------------------------------------------------------------------- */
/* The seller's own tree                                                     */
/* -------------------------------------------------------------------------- */

export interface SellerCatalogSubcategoryDto {
  id: string;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  isActive: boolean;
  displayOrder: number;
  productCount: number;
}

export interface SellerCatalogCategoryDto {
  id: string;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  isActive: boolean;
  displayOrder: number;
  /** Products attached directly to the top category (not to a subcategory). */
  productCount: number;
  subcategories: SellerCatalogSubcategoryDto[];
}

export interface SellerCatalogCategoriesDto {
  /** Restaurant / cafe: this tree is the MENU — top categories are menus,
   * subcategories are menu sections, products are food items. */
  usesMenuSections: boolean;
  categories: SellerCatalogCategoryDto[];
}

const TREE_SELECT = {
  id: true,
  name: true,
  nameHi: true,
  imageUrl: true,
  isActive: true,
  displayOrder: true,
  parentId: true,
  _count: { select: { products: { where: { deletedAt: null } } } },
} as const;

async function loadTree(sellerId: string): Promise<SellerCatalogCategoryDto[]> {
  const rows = await prisma.category.findMany({
    where: { sellerId, deletedAt: null },
    orderBy: [{ depth: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }],
    select: TREE_SELECT,
  });
  const roots = rows.filter((row) => row.parentId === null);
  return roots.map((root) => ({
    id: root.id,
    name: root.name,
    nameHi: root.nameHi,
    imageUrl: root.imageUrl,
    isActive: root.isActive,
    displayOrder: root.displayOrder,
    productCount: root._count.products,
    subcategories: rows
      .filter((row) => row.parentId === root.id)
      .map((row) => ({
        id: row.id,
        name: row.name,
        nameHi: row.nameHi,
        imageUrl: row.imageUrl,
        isActive: row.isActive,
        displayOrder: row.displayOrder,
        productCount: row._count.products,
      })),
  }));
}

/** GET /seller/categories — the seller's own top categories with their subcategories. */
export async function listSellerCatalogCategories(sellerId: string): Promise<SellerCatalogCategoriesDto> {
  const seller = await loadSellerForAccess(sellerId);
  return { usesMenuSections: isFoodSellerType(seller.sellerType), categories: await loadTree(sellerId) };
}

/** Admin, read-only: the same tree for one seller (Seller detail → Categories). */
export async function listSellerCategoriesForAdmin(sellerId: string): Promise<SellerCatalogCategoriesDto> {
  return listSellerCatalogCategories(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Seller writes — top categories                                            */
/* -------------------------------------------------------------------------- */

/** The catalogue vertical a seller's new categories default to. */
function verticalFor(sellerType: string): CatalogVertical {
  switch (sellerType) {
    case SellerType.RESTAURANT:
    case SellerType.CAFE:
      return 'FOOD';
    case SellerType.PHARMACY:
      return 'PHARMACY';
    case SellerType.GROCERY:
      return 'GROCERY';
    default:
      return 'OTHER';
  }
}

function topSlug(name: string): string {
  return (slugify(name) || 'category').slice(0, 140);
}

async function assertNoDuplicateTop(sellerId: string, slug: string, exceptId?: string): Promise<void> {
  const clash = await prisma.category.findFirst({
    where: { sellerId, parentId: null, slug, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 409,
      message: 'You already have a top category with this name.',
    });
  }
}

async function loadOwnTopOrThrow(sellerId: string, id: string) {
  const row = await prisma.category.findFirst({
    where: { id, sellerId, parentId: null, deletedAt: null },
    select: { id: true, name: true, nameHi: true, slug: true, path: true, isActive: true, displayOrder: true, imageUrl: true },
  });
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Category not found.' });
  return row;
}

async function audit(actorUserId: string, action: string, entityId: string, before: unknown, after: unknown) {
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action,
      entityType: 'Category',
      entityId,
      before: (before ?? undefined) as never,
      after: (after ?? undefined) as never,
    },
  });
}

export interface CreateTopCategoryInput {
  name: string;
  nameHi?: string | null;
  displayOrder?: number;
}

/** POST /seller/categories — a new top category owned by this seller. */
export async function createOwnTopCategory(
  sellerId: string,
  input: CreateTopCategoryInput,
  actorUserId: string,
): Promise<SellerCatalogCategoriesDto> {
  const seller = await loadSellerForAccess(sellerId);
  const slug = topSlug(input.name);
  await assertNoDuplicateTop(sellerId, slug);

  const created = await prisma.category.create({
    data: {
      sellerId,
      parentId: null,
      name: input.name,
      nameHi: input.nameHi ?? null,
      slug,
      path: slug,
      depth: 0,
      displayOrder: input.displayOrder ?? 0,
      isActive: true,
      vertical: verticalFor(seller.sellerType),
    },
    select: { id: true },
  });
  await audit(actorUserId, 'category.seller_category.create', created.id, null, { sellerId, name: input.name });
  invalidateCategoryCache();
  return listSellerCatalogCategories(sellerId);
}

export interface UpdateTopCategoryInput {
  name?: string;
  nameHi?: string | null;
  isActive?: boolean;
  displayOrder?: number;
}

/**
 * PATCH /seller/categories/:id — rename, reorder or switch a top category
 * on/off. A rename moves the materialised path of the category AND of every
 * subcategory under it, in one transaction.
 */
export async function updateOwnTopCategory(
  sellerId: string,
  id: string,
  input: UpdateTopCategoryInput,
  actorUserId: string,
): Promise<SellerCatalogCategoriesDto> {
  const current = await loadOwnTopOrThrow(sellerId, id);
  const renamed = input.name !== undefined && input.name !== current.name;
  const slug = renamed ? topSlug(input.name!) : current.slug;
  if (renamed && slug !== current.slug) await assertNoDuplicateTop(sellerId, slug, id);

  await runInTransaction(async (tx) => {
    await tx.category.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.nameHi !== undefined ? { nameHi: input.nameHi } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(slug !== current.slug ? { slug, path: slug } : {}),
      },
    });
    if (slug !== current.slug) {
      const children = await tx.category.findMany({
        where: { parentId: id, sellerId, deletedAt: null },
        select: { id: true, slug: true },
      });
      for (const child of children) {
        await tx.category.update({ where: { id: child.id }, data: { path: `${slug}/${child.slug}` } });
      }
    }
  });
  await audit(
    actorUserId,
    'category.seller_category.update',
    id,
    { name: current.name, nameHi: current.nameHi, isActive: current.isActive, displayOrder: current.displayOrder },
    input,
  );
  invalidateCategoryCache();
  return listSellerCatalogCategories(sellerId);
}

/** POST /seller/categories/:id/image — from a key already uploaded into this seller's own folder. */
export async function setOwnTopCategoryImage(
  sellerId: string,
  id: string,
  key: string,
  actorUserId: string,
): Promise<SellerCatalogCategoriesDto> {
  const current = await loadOwnTopOrThrow(sellerId, id);
  assertOwnSellerKey(sellerId, key);
  const { url: imageUrl } = await processUploadedImage(key, 'category');
  await prisma.category.update({ where: { id }, data: { imageUrl } });
  await audit(actorUserId, 'category.seller_category.image', id, { imageUrl: current.imageUrl }, { imageUrl });
  if (current.imageUrl !== imageUrl) await removeStoredImageIfUnused(current.imageUrl);
  invalidateCategoryCache();
  return listSellerCatalogCategories(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Seller deletes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The refusal when products are still attached. Deleting never touches a
 * product: approved products cannot be moved by the seller, so the seller
 * either moves its editable products elsewhere or hides the category.
 */
export function linkedProductsError(kind: 'category' | 'subcategory', count: number, food = false): AppError {
  // A food seller's tree is its menu: top category = menu, subcategory = menu section.
  const what = food ? (kind === 'category' ? 'menu' : 'menu section') : kind;
  const items = food ? `food item${count === 1 ? ' is' : 's are'} in` : `product${count === 1 ? ' is' : 's are'} linked to`;
  return new AppError(ErrorCode.VALIDATION_ERROR, {
    status: 409,
    message:
      `${count} ${items} this ${what}, so it cannot be deleted. ` +
      `Move ${count === 1 ? 'it' : 'them'} to another ${food ? 'menu section' : 'category'} first, or switch the ${what} off to hide it from customers.`,
    details: [{ field: 'linkedProducts', message: String(count) }],
  });
}

export interface DeletedCategoryDto {
  id: string;
  /** Subcategories (all empty) deleted together with a top category. */
  deletedSubcategoryIds: string[];
}

/**
 * DELETE /seller/categories/:id — deletes one of the seller's own top
 * categories, together with its (empty) subcategories.
 *
 * SAFE BY CONSTRUCTION:
 *   - refused (409) while ANY product — approved, pending, draft, inactive —
 *     is attached to the category or one of its subcategories; products are
 *     never deleted, moved or touched here;
 *   - a SOFT delete (`deletedAt`), never a row delete, so nothing that
 *     references the category (products' history, commission rules, audit)
 *     loses its row and no FK cascade can fire; orders snapshot their items
 *     and never read the category;
 *   - another seller's category is NOT_FOUND, exactly like a missing one;
 *   - restaurants' top categories are their menu sections — not deletable here.
 */
export async function deleteOwnTopCategory(
  sellerId: string,
  id: string,
  actorUserId: string,
): Promise<DeletedCategoryDto> {
  const seller = await loadSellerForAccess(sellerId);
  const current = await loadOwnTopOrThrow(sellerId, id);

  const deleted = await runInTransaction(async (tx) => {
    // Lock the category row so two deletes (or a delete and a rename) of the
    // same category serialise.
    await tx.$queryRaw`SELECT id FROM categories WHERE id = ${id}::uuid FOR UPDATE`;
    const subcategories = await tx.category.findMany({
      where: { sellerId, parentId: id, deletedAt: null },
      select: { id: true },
    });
    const ids = [id, ...subcategories.map((s) => s.id)];
    const linked = await tx.product.count({ where: { categoryId: { in: ids }, deletedAt: null } });
    if (linked > 0) throw linkedProductsError('category', linked, isFoodSellerType(seller.sellerType));

    await tx.category.updateMany({
      where: { id: { in: ids }, sellerId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return subcategories.map((s) => s.id);
  });

  await audit(actorUserId, 'category.seller_category.delete', id, { sellerId, name: current.name, path: current.path }, {
    deleted: true,
    deletedSubcategoryIds: deleted,
  });
  invalidateCategoryCache();
  return { id, deletedSubcategoryIds: deleted };
}
