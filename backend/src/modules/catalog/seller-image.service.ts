/**
 * Seller product images — the admin catalogue's own storage flow (presign ->
 * PUT bytes -> attach the key; remove deletes the row and the stored file),
 * scoped to one seller:
 *
 *   - Every key a seller is issued lives under that seller's own folder,
 *     `products/s-<tag>/…`, where the tag is an HMAC of the seller id: keys
 *     carry no seller id, and nobody without the server secret can name
 *     another seller's folder. Direct upload and attach accept only keys under
 *     the caller's folder, so a seller can never overwrite, borrow — and then,
 *     by removing, delete — anyone else's file.
 *   - Attach and remove require the caller's own product in its editable
 *     window (never submitted, or rejected — `loadEditableOwnProduct`), the
 *     same rule as editing the product's details: an approved product's
 *     images cannot change without review.
 *
 * Content types, the 5 MB limit, key shape, URLs and file removal are the
 * storage layer's and the admin catalogue's, unchanged.
 */

import { createHmac } from 'node:crypto';
import { ErrorCode, type SellerProductDto } from '../../shared';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { prisma } from '../../infra/db/prisma';
import { assertUploadable, storage, type PresignedUpload } from '../../infra/storage';
import { attachProductImage, removeProductImage } from './product-image.service';
import { processUploadedImage, removeStoredImageIfUnused } from './uploaded-image.service';
import { loadEditableOwnProduct } from './product-approval.service';
import { getOwnProduct } from './seller-product.service';

export const SELLER_DIRECT_UPLOAD_PATH = '/api/v1/seller/uploads/direct';

/** The storage folder this seller's uploads live under. */
export function sellerImageFolder(sellerId: string): string {
  const tag = createHmac('sha256', env.JWT_SECRET).update(`seller-image-folder:${sellerId}`).digest('hex').slice(0, 24);
  return `products/s-${tag}`;
}

/** A product's gallery: image 1 is the PRIMARY one (lowest `displayOrder`). */
export const MAX_SELLER_PRODUCT_IMAGES = 8;

/** Throws unless `key` is a well-formed key under this seller's own folder. */
export function assertOwnSellerKey(sellerId: string, key: string): void {
  assertOwnKey(sellerId, key);
}

function assertOwnKey(sellerId: string, key: string): void {
  const folder = `${sellerImageFolder(sellerId)}/`;
  if (!key.startsWith(folder) || key.includes('..') || !/^[A-Za-z0-9/_.-]+$/.test(key)) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: 'This upload does not belong to your account.',
      internalMessage: `seller ${sellerId} used a key outside its folder`,
    });
  }
}

export function createSellerUploadTarget(
  sellerId: string,
  input: { fileName: string; contentType: string },
): Promise<PresignedUpload> {
  assertUploadable(input.contentType);
  return storage.createPresignedUpload({
    folder: sellerImageFolder(sellerId),
    fileName: input.fileName,
    contentType: input.contentType,
    directUploadPath: SELLER_DIRECT_UPLOAD_PATH,
  });
}

/** The local provider's upload route (production uploads go straight to object storage). */
export async function putSellerUpload(
  sellerId: string,
  key: string,
  body: unknown,
  contentType: string,
): Promise<{ url: string }> {
  assertOwnKey(sellerId, key);
  if (!Buffer.isBuffer(body)) {
    // express.raw only reads image/* bodies; anything else arrives unread.
    assertUploadable(contentType);
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, { message: 'Please upload a JPEG, PNG, WebP or AVIF image.' });
  }
  const stored = await storage.put(key, body, contentType);
  return { url: stored.url };
}

export async function attachSellerImage(
  sellerId: string,
  productId: string,
  input: { key: string; altText?: string | null },
  actorUserId: string,
): Promise<SellerProductDto> {
  await loadEditableOwnProduct(sellerId, productId);
  assertOwnKey(sellerId, input.key);
  const count = await prisma.productImage.count({ where: { productId } });
  if (count >= MAX_SELLER_PRODUCT_IMAGES) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `A product can have at most ${MAX_SELLER_PRODUCT_IMAGES} images. Remove one first.`,
    });
  }
  await attachProductImage({ productId, key: input.key, altText: input.altText ?? null }, actorUserId);
  return getOwnProduct(sellerId, productId);
}

/**
 * Replaces one image's file in place — same id, same position (so a replaced
 * main image stays the main image). The new key must be in the seller's own
 * folder; the old file is removed afterwards unless another image still uses
 * it. Same editable window as attach/remove.
 */
export async function replaceSellerImage(
  sellerId: string,
  productId: string,
  imageId: string,
  input: { key: string; altText?: string | null },
  actorUserId: string,
): Promise<SellerProductDto> {
  await loadEditableOwnProduct(sellerId, productId);
  assertOwnKey(sellerId, input.key);
  const image = await prisma.productImage.findFirst({
    where: { id: imageId, productId },
    select: { id: true, url: true, thumbUrl: true },
  });
  // Another product's image id is indistinguishable from a missing one.
  if (!image) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Image not found.' });

  const { url, thumbUrl } = await processUploadedImage(input.key, 'product');
  await prisma.productImage.update({
    where: { id: imageId },
    data: { url, thumbUrl, cardUrl: thumbUrl, ...(input.altText !== undefined ? { altText: input.altText } : {}) },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.image.replace',
      entityType: 'ProductImage',
      entityId: imageId,
      before: { url: image.url },
      after: { productId, key: input.key },
    },
  });
  await removeStoredImageIfUnused(image.url);
  if (image.thumbUrl !== image.url) await removeStoredImageIfUnused(image.thumbUrl);
  return getOwnProduct(sellerId, productId);
}

/**
 * Sets the gallery order; the first id becomes the PRIMARY image (the one
 * every product card shows — lowest `displayOrder`). Must list exactly this
 * product's images, each once. Same editable window as attach/remove.
 */
export async function reorderSellerImages(
  sellerId: string,
  productId: string,
  imageIds: string[],
  actorUserId: string,
): Promise<SellerProductDto> {
  await loadEditableOwnProduct(sellerId, productId);
  const images = await prisma.productImage.findMany({ where: { productId }, select: { id: true, displayOrder: true } });
  const current = new Set(images.map((image) => image.id));
  const wanted = new Set(imageIds);
  if (wanted.size !== imageIds.length || wanted.size !== current.size || imageIds.some((id) => !current.has(id))) {
    // An id of another product's image is indistinguishable from a wrong list.
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'The image list does not match this product’s images. Refresh and try again.',
    });
  }
  await prisma.$transaction(
    imageIds.map((id, index) => prisma.productImage.update({ where: { id }, data: { displayOrder: index } })),
  );
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.image.reorder',
      entityType: 'Product',
      entityId: productId,
      before: { order: [...images].sort((a, b) => a.displayOrder - b.displayOrder).map((image) => image.id) },
      after: { order: imageIds },
    },
  });
  return getOwnProduct(sellerId, productId);
}

export async function removeSellerImage(
  sellerId: string,
  productId: string,
  imageId: string,
  actorUserId: string,
): Promise<SellerProductDto> {
  await loadEditableOwnProduct(sellerId, productId);
  const image = await prisma.productImage.findFirst({ where: { id: imageId, productId }, select: { id: true } });
  if (!image) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Image not found.' });
  await removeProductImage(imageId, actorUserId);
  return getOwnProduct(sellerId, productId);
}
