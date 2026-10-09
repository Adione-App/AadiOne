/**
 * Admin-managed category images — top categories, subcategories, and food
 * menus / menu sections (which are category rows of restaurant sellers).
 *
 * Categories belong to sellers; the customer app merges every seller's rows
 * with the same materialised path ("grocery/rice") into one category and shows
 * the first image among them (catalog.service.ts). So the admin sets the image
 * of a MERGED category: it is written to `imageUrl` of every live seller row
 * with that path, and that is the image customers see. A seller may still
 * change its own row's image afterwards in the Seller Panel, exactly as
 * before; setting it here again re-applies the admin's image everywhere.
 *
 * Uploads go through the shared image pipeline (uploaded-image.service.ts) —
 * validated, resized and stored as WebP; the raw upload is deleted.
 */

import { Prisma } from '@prisma/client';
import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { assertAdminKey } from '../admin/admin-upload.service';
import { invalidateCategoryCache } from './catalog.service';
import { processUploadedImage, removeStoredImageIfUnused } from './uploaded-image.service';

export interface AdminCategoryImageResult {
  /** The merged category this applied to. */
  path: string;
  imageUrl: string | null;
  /** Seller category rows updated (one per seller that has this category). */
  updatedCategories: number;
}

/** The category by id — any seller row of the merged category. */
async function loadCategory(categoryId: string): Promise<{ id: string; path: string; name: string }> {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null, sellerId: { not: null } },
    select: { id: true, path: true, name: true },
  });
  if (!category) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Category not found.' });
  return category;
}

async function applyImage(categoryId: string, imageUrl: string | null, actorUserId: string): Promise<AdminCategoryImageResult> {
  const category = await loadCategory(categoryId);

  const { previous, updated } = await prisma.$transaction(async (tx) => {
    const rows = await tx.category.findMany({
      where: { path: category.path, deletedAt: null, sellerId: { not: null } },
      select: { id: true, imageUrl: true },
    });
    const ids = rows.map((row) => row.id);
    const result = await tx.category.updateMany({ where: { id: { in: ids } }, data: { imageUrl } });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: imageUrl ? 'category.admin_image.set' : 'category.admin_image.remove',
        entityType: 'Category',
        entityId: category.id,
        before: { path: category.path, imageUrls: [...new Set(rows.map((row) => row.imageUrl))] } as Prisma.InputJsonValue,
        after: { path: category.path, imageUrl, categoryIds: ids } as Prisma.InputJsonValue,
      },
    });
    return { previous: rows.map((row) => row.imageUrl), updated: result.count };
  });

  // Files no row uses any more (a seller's own old image included) are freed.
  for (const url of new Set(previous)) if (url && url !== imageUrl) await removeStoredImageIfUnused(url);
  invalidateCategoryCache();
  return { path: category.path, imageUrl, updatedCategories: updated };
}

/** PUT /admin/categories/:id/image — from a key uploaded via POST /admin/uploads/presign. */
export async function setCategoryImage(categoryId: string, key: string, actorUserId: string): Promise<AdminCategoryImageResult> {
  assertAdminKey(key);
  await loadCategory(categoryId); // fail fast before the image is processed
  const { url } = await processUploadedImage(key, 'category');
  return applyImage(categoryId, url, actorUserId);
}

/** DELETE /admin/categories/:id/image — the merged category shows no image. */
export function removeCategoryImage(categoryId: string, actorUserId: string): Promise<AdminCategoryImageResult> {
  return applyImage(categoryId, null, actorUserId);
}
