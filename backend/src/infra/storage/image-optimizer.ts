/**
 * Image optimisation — every public image is stored as one resized WebP.
 *
 * The bytes a seller uploads are never served as-is: they are decoded (which
 * is the real validation — the client-chosen Content-Type proves nothing),
 * auto-rotated from EXIF, shrunk to fit the profile's box (never enlarged),
 * stripped of metadata (EXIF GPS included) and re-encoded as WebP.
 *
 * Inputs: JPEG, PNG, WebP and AVIF — the types the upload routes already
 * accept. HEIC is not decodable by sharp's prebuilt binaries and stays
 * rejected, as before. Animated inputs keep their first frame only.
 */

import sharp from 'sharp';

import { AppError } from '../../common/errors';
import { ErrorCode } from '../../shared';

// A server encodes one unrelated image after another; libvips' operation
// cache would only hold memory.
sharp.cache(false);

export interface ImageProfile {
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

/** Output sizes per kind of image. The box is a maximum; aspect ratio is kept. */
export const IMAGE_PROFILES = {
  /** Product gallery / detail page. */
  product: { maxWidth: 1200, maxHeight: 1200, quality: 82 },
  /** Product cards and grids (`thumbUrl`/`cardUrl`): ~160dp cards at 3x density. */
  productThumb: { maxWidth: 480, maxHeight: 480, quality: 80 },
  category: { maxWidth: 1200, maxHeight: 1200, quality: 82 },
  banner: { maxWidth: 1600, maxHeight: 1600, quality: 85 },
  profile: { maxWidth: 800, maxHeight: 800, quality: 80 },
} as const satisfies Record<string, ImageProfile>;

/**
 * A separate card thumbnail only pays for itself when the image is well above
 * card size; below 1.5x the thumbnail box it would be nearly as large as the
 * image itself, and the image serves the card fine.
 */
export function needsCardThumbnail(width: number, height: number): boolean {
  const box = IMAGE_PROFILES.productThumb;
  return width > box.maxWidth * 1.5 || height > box.maxHeight * 1.5;
}

/** Floor for the size-guard retry in `optimizeImage`. */
const MIN_RETRY_QUALITY = 65;

/**
 * Decompression-bomb guard: a 5 MB file can still claim to be 30000×30000.
 * 50 MP covers every phone camera's normal output.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

export interface OptimizedImage {
  data: Buffer;
  /** Always `image/webp`. */
  contentType: 'image/webp';
  width: number;
  height: number;
  /** Detected from the bytes, not from any header. */
  inputFormat: string;
  inputBytes: number;
  /** True when the input was already a WebP that re-encoding could not improve — its bytes are kept. */
  keptOriginal: boolean;
}

function invalidImage(internalMessage: string): AppError {
  return new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
    message: 'This file is not a valid JPEG, PNG, WebP or AVIF image. Please choose another picture.',
    internalMessage,
  });
}

/** AVIF decodes through libheif, so sharp reports it as `heif` with AV1 compression. */
function isSupportedFormat(metadata: sharp.Metadata): boolean {
  if (metadata.format === 'heif') return metadata.compression === 'av1';
  return metadata.format === 'jpeg' || metadata.format === 'png' || metadata.format === 'webp';
}

export async function optimizeImage(input: Buffer, profile: ImageProfile): Promise<OptimizedImage> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: false }).metadata();
  } catch (error) {
    throw invalidImage(`image metadata unreadable: ${(error as Error).message}`);
  }

  if (!isSupportedFormat(metadata)) {
    throw invalidImage(`unsupported image format ${metadata.format}/${metadata.compression ?? '-'}`);
  }
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (sourceWidth < 1 || sourceHeight < 1) throw invalidImage('image has no dimensions');
  if (sourceWidth * sourceHeight > MAX_INPUT_PIXELS) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This image is too large (over 50 megapixels). Please choose a smaller picture.',
      internalMessage: `rejected ${sourceWidth}x${sourceHeight}`,
    });
  }

  const encode = (quality: number) =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: profile.maxWidth, height: profile.maxHeight, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 5, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });

  let output: { data: Buffer; info: sharp.OutputInfo };
  try {
    output = await encode(profile.quality);
    // An upload that was already heavily compressed (low-quality JPEG, AVIF)
    // can come out larger at the profile quality: its own artifacts are what
    // gets preserved. One step down costs nothing visible there.
    const retryQuality = Math.max(profile.quality - 12, MIN_RETRY_QUALITY);
    if (output.data.byteLength > input.byteLength && retryQuality < profile.quality) {
      const retry = await encode(retryQuality);
      if (retry.data.byteLength < output.data.byteLength) output = retry;
    }
  } catch (error) {
    // Truncated or corrupt data fails here, past the header.
    throw invalidImage(`image decode failed: ${(error as Error).message}`);
  }

  // EXIF orientation 5–8 swaps the axes, so compare against the upright size.
  const orientation = metadata.orientation ?? 1;
  const uprightWidth = orientation >= 5 ? sourceHeight : sourceWidth;
  const resized = output.info.width !== uprightWidth;

  // Re-encoding an already-compact WebP only loses quality. Keep its bytes
  // when nothing else changes (no resize, no rotation, no metadata to strip).
  const keepOriginal =
    metadata.format === 'webp' &&
    !resized &&
    orientation === 1 &&
    !metadata.exif &&
    (metadata.pages ?? 1) === 1 &&
    output.data.byteLength >= input.byteLength;

  return {
    data: keepOriginal ? input : output.data,
    contentType: 'image/webp',
    width: output.info.width,
    height: output.info.height,
    inputFormat: metadata.format === 'heif' ? 'avif' : (metadata.format ?? 'unknown'),
    inputBytes: input.byteLength,
    keptOriginal: keepOriginal,
  };
}
