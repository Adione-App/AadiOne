/**
 * A seller's OWN subcategories — Category rows with `sellerId` = the seller,
 * directly under one of the seller's own TOP categories (see
 * seller-category.service.ts for the ownership model).
 *
 * Reuses the Category table rather than a new one: the product pipeline,
 * commission resolution and COD chain already understand categories.
 *
 * Slugs are the plain name (`atta-rice-dal`): the live-row unique index is
 * (parent_id, slug) and the parent is the seller's own top category, so a
 * seller can't create the same name twice under one category while two
 * sellers' "Grocery › Rice" stay independent rows (merged only for display).
 */

import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { storage } from '../../infra/storage';
import { slugify } from '../../shared/text';
import { assertSellerMayCreateSubcategoryUnder } from './seller-category.service';
import { assertOwnSellerKey } from './seller-image.service';
import { invalidateCategoryCache } from './catalog.service';

export interface SellerSubcategoryDto {
  id: string;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  isActive: boolean;
  displayOrder: number;
  parent: { id: string; name: string };
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

const SUBCATEGORY_SELECT = {
  id: true,
  name: true,
  nameHi: true,
  imageUrl: true,
  isActive: true,
  displayOrder: true,
  parentId: true,
  sellerId: true,
  path: true,
  createdAt: true,
  updatedAt: true,
  parent: { select: { id: true, name: true, path: true } },
  _count: { select: { products: { where: { deletedAt: null } } } },
} as const;

type SubcategoryRow = NonNullable<Awaited<ReturnType<typeof findOwn>>>;

function toDto(row: SubcategoryRow): SellerSubcategoryDto {
  return {
    id: row.id,
    name: row.name,
    nameHi: row.nameHi,
    imageUrl: row.imageUrl,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    parent: { id: row.parent!.id, name: row.parent!.name },
    productCount: row._count.products,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function findOwn(sellerId: string, id: string) {
  return prisma.category.findFirst({
    where: { id, sellerId, parentId: { not: null }, deletedAt: null },
    select: SUBCATEGORY_SELECT,
  });
}

/** Own subcategory or NOT_FOUND — another seller's looks exactly like a missing one. */
async function loadOwnOrThrow(sellerId: string, id: string) {
  const row = await findOwn(sellerId, id);
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Subcategory not found.' });
  return row;
}

function subcategorySlug(name: string): string {
  return (slugify(name) || 'subcategory').slice(0, 140);
}

async function assertNoDuplicate(parentId: string, slug: string, exceptId?: string): Promise<void> {
  const clash = await prisma.category.findFirst({
    where: { parentId, slug, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 409,
      message: 'You already have a subcategory with this name in that category.',
    });
  }
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

/* -------------------------------------------------------------------------- */
/* Seller                                                                    */
/* -------------------------------------------------------------------------- */

export async function listOwnSubcategories(sellerId: string): Promise<SellerSubcategoryDto[]> {
  const rows = await prisma.category.findMany({
    where: { sellerId, parentId: { not: null }, deletedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select: SUBCATEGORY_SELECT,
  });
  return rows.map(toDto);
}

export interface CreateSubcategoryInput {
  parentId: string;
  name: string;
  nameHi?: string | null;
  displayOrder?: number;
}

export async function createOwnSubcategory(
  sellerId: string,
  input: CreateSubcategoryInput,
  actorUserId: string,
): Promise<SellerSubcategoryDto> {
  const { parent } = await assertSellerMayCreateSubcategoryUnder(sellerId, input.parentId);
  const slug = subcategorySlug(input.name);
  await assertNoDuplicate(parent.id, slug);

  const created = await prisma.category.create({
    data: {
      sellerId,
      parentId: parent.id,
      name: input.name,
      nameHi: input.nameHi ?? null,
      slug,
      path: `${parent.path}/${slug}`,
      depth: parent.depth + 1,
      displayOrder: input.displayOrder ?? 0,
      isActive: true,
      vertical: parent.vertical,
    },
    select: { id: true },
  });
  await audit(actorUserId, 'category.seller_subcategory.create', created.id, null, {
    sellerId,
    parentId: parent.id,
    name: input.name,
  });
  invalidateCategoryCache();
  return toDto(await loadOwnOrThrow(sellerId, created.id));
}

export interface UpdateSubcategoryInput {
  name?: string;
  nameHi?: string | null;
  isActive?: boolean;
  displayOrder?: number;
}

export async function updateOwnSubcategory(
  sellerId: string,
  id: string,
  input: UpdateSubcategoryInput,
  actorUserId: string,
): Promise<SellerSubcategoryDto> {
  const current = await loadOwnOrThrow(sellerId, id);

  const renamed = input.name !== undefined && input.name !== current.name;
  let slugData = {};
  if (renamed) {
    const slug = subcategorySlug(input.name!);
    await assertNoDuplicate(current.parentId!, slug, id);
    slugData = { slug, path: `${current.parent!.path}/${slug}` };
  }

  await prisma.category.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.nameHi !== undefined ? { nameHi: input.nameHi } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
      ...slugData,
    },
  });
  await audit(
    actorUserId,
    'category.seller_subcategory.update',
    id,
    { name: current.name, nameHi: current.nameHi, isActive: current.isActive, displayOrder: current.displayOrder },
    input,
  );
  invalidateCategoryCache();
  return toDto(await loadOwnOrThrow(sellerId, id));
}

/** Sets the image from a key already uploaded into this seller's own storage folder. */
export async function setOwnSubcategoryImage(
  sellerId: string,
  id: string,
  key: string,
  actorUserId: string,
): Promise<SellerSubcategoryDto> {
  const current = await loadOwnOrThrow(sellerId, id);
  assertOwnSellerKey(sellerId, key);
  const imageUrl = storage.publicUrl(key);
  await prisma.category.update({ where: { id }, data: { imageUrl } });
  await audit(actorUserId, 'category.seller_subcategory.image', id, { imageUrl: current.imageUrl }, { imageUrl });
  invalidateCategoryCache();
  return toDto(await loadOwnOrThrow(sellerId, id));
}
