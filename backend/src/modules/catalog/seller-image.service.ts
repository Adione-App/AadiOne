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
 *   - Attach, replace, reorder and remove require the caller's own product in
 *     its editable window (`loadEditableOwnProduct`: never submitted, rejected,
 *     or approved — never while it is under review), the same rule as editing
 *     the product's details. The check is repeated inside the transaction that
 *     writes the image rows, behind the lock a submission holds
 *     (`lockSellerForProductEdit`): an image can never change between "Submit
 *     for Approval" and the admin's decision, so the reviewer sees exactly the
 *     images that were submitted.
 *
 * Content types, the 5 MB limit, key shape, URLs and file removal are the
 * storage layer's and the admin catalogue's, unchanged.
 */

import { createHmac } from 'node:crypto';
import { ErrorCode, type SellerProductDto } from '../../shared';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { assertUploadable, storage, type PresignedUpload } from '../../infra/storage';
import { attachProductImage, discardProcessedImage, removeProductImage } from './product-image.service';
import { processUploadedImage, removeProductImageFileIfUnused } from './uploaded-image.service';
import { loadEditableOwnProduct, lockSellerForProductEdit } from './product-approval.service';
import { getOwnProduct } from './seller-product.service';

export const SELLER_DIRECT_UPLOAD_PATH = '/api/v1/seller/uploads/direct';

/** The storage folder this seller's uploads live under. */
export function sellerImageFolder(sellerId: string): string {
  // Its own key when set, so rotating JWT_SECRET does not move every seller's folder (env.ts).
  return sellerImageFolderFor(sellerId, env.SELLER_IMAGE_FOLDER_KEY ?? env.JWT_SECRET);
}

/** The folder name for `sellerId` under HMAC key `key` (pure; exported for tests). */
export function sellerImageFolderFor(sellerId: string, key: string): string {
  const tag = createHmac('sha256', key).update(`seller-image-folder:${sellerId}`).digest('hex').slice(0, 24);
  return `products/s-${tag}`;
}

/** A product's gallery: image 1 is the PRIMARY one (lowest `displayOrder`). */
export const MAX_SELLER_PRODUCT_IMAGES = 8;

/** Inside the image write: the submission lock, then "still editable?" again (see the header). */
async function assertStillEditable(tx: Tx, sellerId: string, productId: string): Promise<void> {
  await lockSellerForProductEdit(tx, sellerId);
  await loadEditableOwnProduct(sellerId, productId, tx);
}

function tooManyImages(): AppError {
  return new AppError(ErrorCode.VALIDATION_ERROR, {
    message: `A product can have at most ${MAX_SELLER_PRODUCT_IMAGES} images. Remove one first.`,
  });
}

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
  if ((await prisma.productImage.count({ where: { productId } })) >= MAX_SELLER_PRODUCT_IMAGES) throw tooManyImages();
  await attachProductImage({ productId, key: input.key, altText: input.altText ?? null }, actorUserId, async (tx) => {
    await assertStillEditable(tx, sellerId, productId);
    // Two uploads at once can't both take the last place.
    if ((await tx.productImage.count({ where: { productId } })) >= MAX_SELLER_PRODUCT_IMAGES) throw tooManyImages();
  });
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
  try {
    await runInTransaction(async (tx) => {
      await assertStillEditable(tx, sellerId, productId);
      await tx.productImage.update({
        where: { id: imageId },
        data: { url, thumbUrl, cardUrl: thumbUrl, ...(input.altText !== undefined ? { altText: input.altText } : {}) },
      });
    });
  } catch (error) {
    // Refused (now under review) or failed: the old image stays, the new files go.
    await discardProcessedImage({ url, thumbUrl });
    throw error;
  }
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
  await removeProductImageFileIfUnused(image.url);
  if (image.thumbUrl !== image.url) await removeProductImageFileIfUnused(image.thumbUrl);
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
  const images = await runInTransaction(async (tx) => {
    await assertStillEditable(tx, sellerId, productId);
    const rows = await tx.productImage.findMany({ where: { productId }, select: { id: true, displayOrder: true } });
    const current = new Set(rows.map((image) => image.id));
    const wanted = new Set(imageIds);
    if (wanted.size !== imageIds.length || wanted.size !== current.size || imageIds.some((id) => !current.has(id))) {
      // An id of another product's image is indistinguishable from a wrong list.
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'The image list does not match this product’s images. Refresh and try again.',
      });
    }
    for (const [index, id] of imageIds.entries()) await tx.productImage.update({ where: { id }, data: { displayOrder: index } });
    return rows;
  });
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
  await removeProductImage(imageId, actorUserId, (tx) => assertStillEditable(tx, sellerId, productId));
  return getOwnProduct(sellerId, productId);
}
