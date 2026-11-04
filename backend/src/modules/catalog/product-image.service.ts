/**
 * Product image rows — attach an uploaded object to a product, remove one.
 *
 * Used by the Seller Panel's own image endpoints (seller-image.service.ts),
 * which enforce ownership and the image limits before calling in here. Admin
 * has no product-image writes: sellers own their product images.
 *
 * `guard` runs inside the transaction that writes the image row, right before
 * the write — the caller's lock and "may this product still change?" check
 * (seller-image.service: not while it is under review). The slow part (image
 * processing and storage) stays outside that transaction; when the guard
 * refuses, the files just processed are removed again if nothing uses them.
 */

import type { Prisma } from '@prisma/client';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { processUploadedImage, removeProductImageFileIfUnused } from './uploaded-image.service';

async function audit(input: {
  actorUserId: string;
  action: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'ProductImage',
      entityId: input.entityId,
      before: (input.before ?? null) as Prisma.InputJsonValue,
      after: (input.after ?? null) as Prisma.InputJsonValue,
    },
  });
}

export type ProductImageGuard = (tx: Tx) => Promise<void>;

/** Removes freshly processed files a refused write left without a row (never one in use). */
export async function discardProcessedImage(processed: { url: string; thumbUrl: string }): Promise<void> {
  await removeProductImageFileIfUnused(processed.url);
  if (processed.thumbUrl !== processed.url) await removeProductImageFileIfUnused(processed.thumbUrl);
}

export async function attachProductImage(
  input: { productId: string; variantId?: string | null; key: string; altText?: string | null },
  actorUserId: string,
  guard?: ProductImageGuard,
): Promise<{ id: string }> {
  const { url, thumbUrl } = await processUploadedImage(input.key, 'product');
  let image: { id: string };
  try {
    image = await runInTransaction(async (tx) => {
      if (guard) await guard(tx);
      // After the current last image (not the count: once one was removed the
      // count can equal an existing position, and the first image — the primary
      // one — would become ambiguous).
      const last = await tx.productImage.aggregate({
        where: { productId: input.productId },
        _max: { displayOrder: true },
      });
      return tx.productImage.create({
        data: {
          productId: input.productId,
          variantId: input.variantId ?? null,
          url,
          thumbUrl,
          cardUrl: thumbUrl,
          altText: input.altText ?? null,
          displayOrder: (last._max.displayOrder ?? -1) + 1,
        },
        select: { id: true },
      });
    });
  } catch (error) {
    await discardProcessedImage({ url, thumbUrl });
    throw error;
  }

  await audit({
    actorUserId,
    action: 'product.image.attach',
    entityId: image.id,
    after: { productId: input.productId, key: input.key },
  });
  return { id: image.id };
}

export async function removeProductImage(id: string, actorUserId: string, guard?: ProductImageGuard): Promise<void> {
  const image = await runInTransaction(async (tx) => {
    if (guard) await guard(tx);
    const row = await tx.productImage.findUnique({ where: { id } });
    if (row) await tx.productImage.delete({ where: { id } });
    return row;
  });
  if (!image) return;

  // Never deletes a file another row still points at (the same upload can be
  // attached more than once; order items keep a snapshot of the URL), nor one
  // a retained bulk import still holds for a retry.
  await removeProductImageFileIfUnused(image.url);
  if (image.thumbUrl !== image.url) await removeProductImageFileIfUnused(image.thumbUrl);
  if (image.cardUrl !== image.url && image.cardUrl !== image.thumbUrl) await removeProductImageFileIfUnused(image.cardUrl);

  await audit({
    actorUserId,
    action: 'product.image.remove',
    entityId: id,
    before: image,
  });
}
