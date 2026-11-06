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

import { createHmac, randomUUID } from 'node:crypto';
import { ErrorCode, type SellerProductDto } from '../../shared';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { assertUploadable, storage, type PresignedUpload } from '../../infra/storage';
import { discardProcessedImage, removeProductImage } from './product-image.service';
import { plannedImageUrls, processUploadedImage, removeProductImageFileIfUnused } from './uploaded-image.service';
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

/** How many uploads one attach processes at once (download + decode + encode + store each). */
const PARALLEL_IMAGE_PROCESSING = 3;

/** An upload that could not be attached, and why (the seller is told, and can pick it again). */
export interface FailedImageAttach {
  key: string;
  message: string;
}

/**
 * The product's editable window and free gallery places, in ONE query (the
 * same answers and messages as loadEditableOwnProduct + a count) — checked
 * BEFORE any image work, so a refused attach costs no processing.
 */
async function assertImagesCanBeAdded(
  sellerId: string,
  productId: string,
  adding: number,
  client: Tx | typeof prisma = prisma,
  /** Image URLs these uploads will be stored under: the ones this product already shows are reported, not counted. */
  plannedUrls: string[] = [],
): Promise<Set<string>> {
  const [product] = await client.$queryRaw<
    { seller_id: string | null; approved: boolean; under_review: boolean; images: number; attached: string[] | null }[]
  >`
    SELECT p.submitted_by_seller_id AS seller_id,
           p.approval_status = 'APPROVED' AS approved,
           EXISTS (SELECT 1 FROM product_approval_batch_items i WHERE i.product_id = p.id AND i.status = 'PENDING') AS under_review,
           (SELECT count(*) FROM product_images pi WHERE pi.product_id = p.id)::int AS images,
           (SELECT array_agg(pi.url) FROM product_images pi WHERE pi.product_id = p.id AND pi.url = ANY(${plannedUrls}::text[])) AS attached
      FROM products p
     WHERE p.id = ${productId}::uuid AND p.deleted_at IS NULL`;
  if (!product || product.seller_id !== sellerId) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  if (!product.approved && product.under_review) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: 'This product is under review. It can be edited again if it is rejected.',
    });
  }
  const attached = new Set(product.attached ?? []);
  if (product.images + adding - attached.size > MAX_SELLER_PRODUCT_IMAGES) throw tooManyImages();
  return attached;
}

/** `items` through `run`, at most `limit` at a time; results in input order, failures included. */
async function settleLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Attaches one or more uploads (the seller's photos, in the order chosen) in
 * ONE request — the slow part done once for all of them:
 *
 *   1. one query: own product, editable, room in the gallery (fail fast);
 *   2. every upload processed in parallel (up to PARALLEL_IMAGE_PROCESSING):
 *      download, validate by decoding, WebP + card thumbnail, store — the same
 *      pipeline as always (processUploadedImage);
 *   3. one transaction: the submission lock, then ONE guarded INSERT of all
 *      the rows in the chosen order after the current last image — refused
 *      whole if the product went under review or the gallery filled meanwhile;
 *   4. the audit rows and the answer — the product's gallery, in order — in
 *      parallel. Attaching photos changes nothing else of the product, so the
 *      panel merges the gallery into the product it already shows (the whole
 *      product would cost six more sequential reads).
 *
 * An upload that fails step 2 never stops the others; it is reported in
 * `failed` (and nothing of it is left behind). When none can be attached the
 * first failure is thrown, so a single attach behaves exactly as before. A
 * refused step 3 removes every file just processed (never one in use).
 */
export async function attachSellerImages(
  sellerId: string,
  productId: string,
  inputs: readonly { key: string; altText?: string | null }[],
  actorUserId: string,
): Promise<{ images: SellerProductDto['images']; failed: FailedImageAttach[] }> {
  // A retried attach (its answer was lost on the way) finds its photos
  // already on the product: they count as attached — never a second row.
  const planned = inputs.map((input) => plannedImageUrls(input.key).url);
  const already = await assertImagesCanBeAdded(sellerId, productId, inputs.length, prisma, planned);
  for (const input of inputs) assertOwnKey(sellerId, input.key);
  if (new Set(inputs.map((input) => input.key)).size !== inputs.length) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The same upload was sent twice.' });
  }
  const todo = inputs.filter((_, index) => !already.has(planned[index]!));
  if (todo.length === 0) return { images: await galleryOf(productId), failed: [] };

  const processed = await settleLimited(todo, PARALLEL_IMAGE_PROCESSING, (input) => processUploadedImage(input.key, 'product'));
  const ready = todo.flatMap((input, index) => {
    const result = processed[index]!;
    return result.status === 'fulfilled' ? [{ ...input, ...result.value, id: randomUUID() }] : [];
  });
  const failed = todo.flatMap((input, index) => {
    const result = processed[index]!;
    if (result.status === 'fulfilled') return [];
    const reason = result.reason;
    return [{ key: input.key, message: reason instanceof AppError ? reason.message : 'This image could not be processed. Please try again.', reason }];
  });
  if (ready.length === 0) throw failed[0]!.reason;

  try {
    await runInTransaction(async (tx) => {
      await lockSellerForProductEdit(tx, sellerId);
      // Read after the lock (a fresh snapshot): a submission that just
      // committed is seen, and the rows go after the current last image.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO product_images (id, product_id, variant_id, url, thumb_url, card_url, alt_text, display_order, created_at)
        SELECT n.id, p.id, NULL, n.url, n.thumb, n.thumb, n.alt,
               COALESCE((SELECT max(pi.display_order) FROM product_images pi WHERE pi.product_id = p.id), -1) + n.ord::int,
               now()
          FROM products p
         CROSS JOIN unnest(
               ${ready.map((image) => image.id)}::uuid[],
               ${ready.map((image) => image.url)}::text[],
               ${ready.map((image) => image.thumbUrl)}::text[],
               ${ready.map((image) => image.altText ?? null)}::text[]
             ) WITH ORDINALITY AS n(id, url, thumb, alt, ord)
         WHERE p.id = ${productId}::uuid
           AND p.deleted_at IS NULL
           AND p.submitted_by_seller_id = ${sellerId}::uuid
           AND (p.approval_status = 'APPROVED'
                OR NOT EXISTS (SELECT 1 FROM product_approval_batch_items i WHERE i.product_id = p.id AND i.status = 'PENDING'))
           AND (SELECT count(*) FROM product_images pi WHERE pi.product_id = p.id) + ${ready.length} <= ${MAX_SELLER_PRODUCT_IMAGES}
        RETURNING id`;
      if (inserted.length !== ready.length) {
        // Refused: say why, exactly as before (product gone / under review / gallery full).
        await assertImagesCanBeAdded(sellerId, productId, ready.length, tx);
        throw tooManyImages();
      }
    });
  } catch (error) {
    await Promise.all(ready.map((image) => discardProcessedImage(image)));
    throw error;
  }

  const [images] = await Promise.all([
    galleryOf(productId),
    // One audit row per photo, as before (before = JSON null), in ONE statement:
    // createMany would wrap it in a transaction of its own (three round trips).
    prisma.$executeRaw`
      INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, before, after, created_at)
      SELECT n.id, ${actorUserId}::uuid, 'product.image.attach', 'ProductImage', n.image_id, 'null'::jsonb,
             jsonb_build_object('productId', ${productId}::text, 'key', n.key), now()
        FROM unnest(${ready.map(() => randomUUID())}::uuid[], ${ready.map((image) => image.id)}::text[], ${ready.map((image) => image.key)}::text[])
             AS n(id, image_id, key)`,
  ]);
  return { images, failed: failed.map(({ key, message }) => ({ key, message })) };
}

/** A product's photos as the seller's product answer lists them (image 1 = the main one). */
function galleryOf(productId: string): Promise<SellerProductDto['images']> {
  return prisma.productImage.findMany({
    where: { productId },
    orderBy: { displayOrder: 'asc' },
    select: { id: true, url: true, thumbUrl: true, altText: true, displayOrder: true },
  });
}

/** One upload — attachSellerImages with a single key; answers with the whole product, as this route always has. */
export async function attachSellerImage(
  sellerId: string,
  productId: string,
  input: { key: string; altText?: string | null },
  actorUserId: string,
): Promise<SellerProductDto> {
  await attachSellerImages(sellerId, productId, [input], actorUserId);
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
