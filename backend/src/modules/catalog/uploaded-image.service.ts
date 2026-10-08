/**
 * Uploaded images -> the optimised files the catalogue stores.
 *
 * Browsers still PUT the raw file straight to storage (presigned URL, so the
 * bytes never cross the API), and still hand back only its key. Attaching that
 * key is where the server takes over:
 *
 *   raw upload  products/s-<tag>/<date>/<uuid>.jpg
 *     -> decode + validate -> resize -> WebP          (image-optimizer.ts)
 *     -> products/s-<tag>/<date>/<uuid>.webp           the stored image (`url`)
 *     -> products/s-<tag>/<date>/<uuid>-thumb.webp     product cards (`thumbUrl`/`cardUrl`)
 *     -> raw upload deleted
 *
 * One image, one file (plus the card thumbnail for products) — the same
 * folder, the same UUID, only the extension changes.
 *
 * Files are only ever deleted when no row anywhere still points at them:
 * order items keep a snapshot of the image URL, so an order placed before a
 * product's image was replaced keeps showing the picture the customer bought.
 */

import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { env } from '../../config/env';
import { prisma } from '../../infra/db/prisma';
import { MAX_IMAGE_BYTES, storage, storageKeyFromUrl } from '../../infra/storage';
import { IMAGE_PROFILES, needsCardThumbnail, optimizeImage } from '../../infra/storage/image-optimizer';
import { ErrorCode } from '../../shared';

const log = moduleLogger('uploaded-image');

export type UploadedImageKind = 'product' | 'category';

export interface ProcessedImage {
  url: string;
  /** Product card rendition; equals `url` for categories, small images, and with IMAGE_OPTIMIZE=false. */
  thumbUrl: string;
}

/** `a/b/<uuid>.jpg` -> `a/b/<uuid>` */
function withoutExtension(key: string): string {
  return key.replace(/\.[A-Za-z0-9]+$/, '');
}

export function optimizedKeysFor(key: string): { imageKey: string; thumbKey: string } {
  const base = withoutExtension(key);
  return { imageKey: `${base}.webp`, thumbKey: `${base}-thumb.webp` };
}

/**
 * True when any stored row still points at this key. Matches on the key
 * (UUID-named, so unambiguous) rather than the full URL, so rows saved under
 * another host name for the same local file count too.
 */
export async function isStorageKeyReferenced(key: string): Promise<boolean> {
  const suffix = { endsWith: `/${key}` };
  const hits = await Promise.all([
    prisma.productImage.findFirst({
      where: { OR: [{ url: suffix }, { thumbUrl: suffix }, { cardUrl: suffix }] },
      select: { id: true },
    }),
    prisma.category.findFirst({ where: { imageUrl: suffix }, select: { id: true } }),
    prisma.orderItem.findFirst({ where: { imageUrl: suffix }, select: { id: true } }),
    prisma.productVariant.findFirst({ where: { imageUrl: suffix }, select: { id: true } }),
    prisma.brand.findFirst({ where: { logoUrl: suffix }, select: { id: true } }),
  ]);
  return hits.some(Boolean);
}

/**
 * Deletes the stored file behind `url` unless something still uses it.
 * Best effort — a stale object costs a fraction of a paisa, a failed request
 * costs the seller their time. URLs that are not ours are left alone.
 */
export async function removeStoredImageIfUnused(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const key = storageKeyFromUrl(url);
  if (!key) return;
  try {
    if (await isStorageKeyReferenced(key)) return;
    await storage.remove(key);
  } catch (error) {
    log.warn({ err: error, key }, 'stored image cleanup failed');
  }
}

/**
 * Turns a raw upload into the stored, optimised image and returns the URLs to
 * save. Call BEFORE writing the row; the raw upload is removed here.
 */
export async function processUploadedImage(key: string, kind: UploadedImageKind): Promise<ProcessedImage> {
  if (!env.IMAGE_OPTIMIZE) {
    const url = storage.publicUrl(key);
    return { url, thumbUrl: url };
  }

  const { imageKey, thumbKey } = optimizedKeysFor(key);
  const imageUrl = storage.publicUrl(imageKey);
  const thumbUrl = storage.publicUrl(thumbKey);

  // The same upload attached a second time: its files already exist and are in
  // use — reuse them rather than re-encoding (and degrading) them.
  if (await isStorageKeyReferenced(imageKey)) {
    const thumbInUse = kind === 'product' && (await isStorageKeyReferenced(thumbKey));
    return { url: imageUrl, thumbUrl: thumbInUse ? thumbUrl : imageUrl };
  }

  const source = await storage.get(key, MAX_IMAGE_BYTES);
  if (!source) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'The uploaded image could not be found. Please upload it again.',
      internalMessage: `no stored object for key ${key}`,
    });
  }

  let image;
  try {
    image = await optimizeImage(source, kind === 'product' ? IMAGE_PROFILES.product : IMAGE_PROFILES.category);
  } catch (error) {
    // Not a usable image: the raw upload is garbage nobody can attach.
    await removeStoredImageIfUnused(storage.publicUrl(key));
    throw error;
  }

  if (!(image.keptOriginal && key === imageKey)) {
    await storage.put(imageKey, image.data, image.contentType);
  }

  const needsThumb = kind === 'product' && needsCardThumbnail(image.width, image.height);
  let thumbBytes: number | null = null;
  if (needsThumb) {
    const thumb = await optimizeImage(source, IMAGE_PROFILES.productThumb);
    await storage.put(thumbKey, thumb.data, thumb.contentType);
    thumbBytes = thumb.data.byteLength;
  }

  if (key !== imageKey) await removeStoredImageIfUnused(storage.publicUrl(key));

  log.info(
    {
      key: imageKey,
      inputFormat: image.inputFormat,
      inputBytes: image.inputBytes,
      outputBytes: image.data.byteLength,
      thumbBytes,
      width: image.width,
      height: image.height,
      keptOriginal: image.keptOriginal,
    },
    'uploaded image optimised',
  );

  return { url: imageUrl, thumbUrl: needsThumb ? thumbUrl : imageUrl };
}
