/**
 * Product image rows — attach an uploaded object to a product, remove one.
 *
 * Used by the Seller Panel's own image endpoints (seller-image.service.ts),
 * which enforce ownership and the image limits before calling in here. Admin
 * has no product-image writes: sellers own their product images.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../infra/db/prisma';
import { storage } from '../../infra/storage';

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

export async function attachProductImage(
  input: { productId: string; variantId?: string | null; key: string; altText?: string | null },
  actorUserId: string,
): Promise<{ id: string }> {
  const url = storage.publicUrl(input.key);
  // After the current last image (not the count: once one was removed the
  // count can equal an existing position, and the first image — the primary
  // one — would become ambiguous).
  const last = await prisma.productImage.aggregate({
    where: { productId: input.productId },
    _max: { displayOrder: true },
  });

  const image = await prisma.productImage.create({
    data: {
      productId: input.productId,
      variantId: input.variantId ?? null,
      url,
      thumbUrl: url,
      cardUrl: url,
      altText: input.altText ?? null,
      displayOrder: (last._max.displayOrder ?? -1) + 1,
    },
  });

  await audit({
    actorUserId,
    action: 'product.image.attach',
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
  // costs the seller their time. Never delete a file another image row still
  // points at (the same upload can be attached more than once).
  const stillUsed = await prisma.productImage.count({ where: { url: image.url } });
  if (stillUsed === 0) {
    await storage.remove(image.url.split('/static/').pop() ?? image.url).catch(() => undefined);
  }

  await audit({
    actorUserId,
    action: 'product.image.remove',
    entityId: id,
    before: image,
  });
}
