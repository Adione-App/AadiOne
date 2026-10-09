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

export type UploadedImageKind = 'product' | 'category' | 'banner';

/** A banner narrower than this would look blurry on a phone held normally. */
export const BANNER_MIN_WIDTH = 600;

const PROFILE_FOR: Record<UploadedImageKind, (typeof IMAGE_PROFILES)[keyof typeof IMAGE_PROFILES]> = {
  product: IMAGE_PROFILES.product,
  category: IMAGE_PROFILES.category,
  banner: IMAGE_PROFILES.banner,
};

export interface ProcessedImage {
  url: string;
  /** Product card rendition; equals `url` for categories, small images, and with IMAGE_OPTIMIZE=false. */
  thumbUrl: string;
  /** Pixel size of the stored image; null when it was not (re)encoded here (reused upload, IMAGE_OPTIMIZE=false). */
  width: number | null;
  height: number | null;
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
    prisma.banner.findFirst({ where: { imageUrl: suffix }, select: { id: true } }),
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
    return { url, thumbUrl: url, width: null, height: null };
  }

  const { imageKey, thumbKey } = optimizedKeysFor(key);
  const imageUrl = storage.publicUrl(imageKey);
  const thumbUrl = storage.publicUrl(thumbKey);

  // The same upload attached a second time: its files already exist and are in
  // use — reuse them rather than re-encoding (and degrading) them.
  if (await isStorageKeyReferenced(imageKey)) {
    const thumbInUse = kind === 'product' && (await isStorageKeyReferenced(thumbKey));
    return { url: imageUrl, thumbUrl: thumbInUse ? thumbUrl : imageUrl, width: null, height: null };
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
    image = await optimizeFor(source, kind);
  } catch (error) {
    // Not a usable image: the raw upload is garbage nobody can attach.
    await removeStoredImageIfUnused(storage.publicUrl(key));
    throw error;
  }

  const stored = await storeOptimized(source, image, key, kind);
  if (key !== imageKey) await removeStoredImageIfUnused(storage.publicUrl(key));
  return stored;
}

/**
 * The same pipeline for bytes already in hand (a bulk-import ZIP entry):
 * validated by decoding, resized, stored as `<key without extension>.webp`
 * (+ the card thumbnail for products). Nothing raw is ever stored. `key` is
 * only a name — e.g. buildImageKey(sellerImageFolder(id), 'RB-250.jpg').
 */
export async function storeImageBuffer(source: Buffer, key: string, kind: UploadedImageKind): Promise<ProcessedImage> {
  if (source.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'Images must be 5 MB or smaller.' });
  }
  if (!env.IMAGE_OPTIMIZE) {
    // Optimisation switched off: still decode-checked, stored as uploaded.
    const image = await optimizeFor(source, kind);
    const contentType = `image/${image.inputFormat}`;
    await storage.put(key, source, contentType);
    const url = storage.publicUrl(key);
    return { url, thumbUrl: url, width: image.width, height: image.height };
  }
  return storeOptimized(source, await optimizeFor(source, kind), key, kind);
}

async function optimizeFor(source: Buffer, kind: UploadedImageKind) {
  const image = await optimizeImage(source, PROFILE_FOR[kind]);
  if (kind === 'banner' && image.width < BANNER_MIN_WIDTH) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Banner images must be at least ${BANNER_MIN_WIDTH} pixels wide.`,
      internalMessage: `banner too narrow: ${image.width}x${image.height}`,
    });
  }
  return image;
}

async function storeOptimized(
  source: Buffer,
  image: Awaited<ReturnType<typeof optimizeImage>>,
  key: string,
  kind: UploadedImageKind,
): Promise<ProcessedImage> {
  const { imageKey, thumbKey } = optimizedKeysFor(key);
  const imageUrl = storage.publicUrl(imageKey);
  const thumbUrl = storage.publicUrl(thumbKey);

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

  return { url: imageUrl, thumbUrl: needsThumb ? thumbUrl : imageUrl, width: image.width, height: image.height };
}
