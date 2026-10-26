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

// sharp 0.35 exports its types by name (its ESM declarations have no `sharp` namespace).
import sharp, { type Metadata, type OutputInfo } from 'sharp';

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

/**
 * Part of an upright image, as fractions (0–1) of its width and height — so
 * a frame found on one rendition applies to any other size of the same image.
 */
export interface ImageFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Side of the copy `cardFrame` analyses — plenty to find a product's edges. */
const FRAME_ANALYSIS_SIZE = 256;
/** Share of the border that must be the background colour for it to count as plain. */
const FRAME_FLAT_BORDER_SHARE = 0.97;
/** Channel difference still counted as the background (JPEG noise, gentle gradients). */
const FRAME_BACKGROUND_TOLERANCE = 18;
/**
 * Channel difference that marks a pixel as part of the product: just above
 * the photo's own background noise, within these bounds. Low on purpose — a
 * faint package outline or soft shadow counts as product, so the frame errs
 * towards keeping too much, never towards cutting an edge.
 */
const FRAME_CONTENT_THRESHOLD = { min: 12, max: 32, aboveNoise: 8 };
/** Margin kept around the product, as a share of its longer side. */
const FRAME_MARGIN = 0.08;
/** Not worth a separate card image when the frame keeps almost the whole picture. */
const FRAME_MIN_SAVING = 0.15;
/** Never frame down to fewer source pixels than this (longer side) — a blurry card is worse than a small product. */
const FRAME_MIN_SOURCE_PX = 240;

interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The product's bounds in one rendering of the analysis copy (`pixel(i)` =
 * the RGB of pixel i), or null when its border is not one plain colour.
 */
function productBounds(pixel: (i: number) => [number, number, number], w: number, h: number): PixelBox | 'empty' | null {
  // The background: the median colour of a thin band along all four edges.
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const border: Array<[number, number, number]> = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x < band || y < band || x >= w - band || y >= h - band) border.push(pixel(y * w + x));
    }
  }
  const middle = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;
  const background = [0, 1, 2].map((c) => middle(border.map((p) => p[c] ?? 0)));
  const distance = (p: [number, number, number]) => Math.max(...p.map((v, c) => Math.abs(v - (background[c] ?? 0))));
  const borderDistances = border.map(distance).sort((a, b) => a - b);
  const flat = borderDistances.filter((d) => d <= FRAME_BACKGROUND_TOLERANCE).length;
  if (flat < border.length * FRAME_FLAT_BORDER_SHARE) return null;
  const noise = borderDistances[Math.floor(borderDistances.length * 0.99)] ?? 0;
  const threshold = Math.min(FRAME_CONTENT_THRESHOLD.max, Math.max(FRAME_CONTENT_THRESHOLD.min, noise + FRAME_CONTENT_THRESHOLD.aboveNoise));

  // A row or column needs two clearly different pixels, so a stray speck of
  // dust does not stretch the bounds.
  const columns = new Array<number>(w).fill(0);
  const rows = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (distance(pixel(y * w + x)) > threshold) {
        columns[x] = (columns[x] ?? 0) + 1;
        rows[y] = (rows[y] ?? 0) + 1;
      }
    }
  }
  const x0 = columns.findIndex((n) => n >= 2);
  const y0 = rows.findIndex((n) => n >= 2);
  if (x0 === -1 || y0 === -1) return 'empty';
  return {
    x0,
    y0,
    x1: w - 1 - [...columns].reverse().findIndex((n) => n >= 2),
    y1: h - 1 - [...rows].reverse().findIndex((n) => n >= 2),
  };
}

/**
 * The card framing of a product photo: the product plus an even margin, when
 * the photo is a packshot on a plain background (white, cream, any single
 * colour, or transparent) with more empty space around the product than that.
 * Product cards show every image whole (`contain`) in the same box, so the
 * empty space a photo happens to have decides how small its product looks;
 * framing the CARD image evens that out. The background colour is kept (the
 * frame only crops it), and the full image is never touched.
 *
 * Null — show the photo as it is — for photos without a plain border
 * (lifestyle shots, gradients, products touching the edge), photos already
 * framed tightly, very small photos, and anything sharp cannot read.
 */
export async function cardFrame(input: Buffer): Promise<ImageFrame | null> {
  let raw: { data: Buffer; info: OutputInfo };
  let upright: { width: number; height: number };
  let hasAlpha: boolean;
  try {
    const metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const swap = (metadata.orientation ?? 1) >= 5;
    upright = { width: (swap ? metadata.height : metadata.width) ?? 0, height: (swap ? metadata.width : metadata.height) ?? 0 };
    hasAlpha = metadata.hasAlpha === true;
    raw = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: FRAME_ANALYSIS_SIZE, height: FRAME_ANALYSIS_SIZE, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }
  const { data, info } = raw;
  const { width: w, height: h, channels } = info;
  if (w < 16 || h < 16 || channels !== 4) return null;

  // The photo as the card shows it: transparency over white. A transparent
  // photo is also read over black — its white parts (a cap, a label) look
  // like the white background in the first rendering, never in both.
  const over = (background: number) => (i: number): [number, number, number] => {
    const o = i * 4;
    const alpha = (data[o + 3] ?? 255) / 255;
    return [0, 1, 2].map((c) => (data[o + c] ?? 0) * alpha + background * (1 - alpha)) as [number, number, number];
  };
  const renderings = hasAlpha ? [over(255), over(0)] : [over(255)];
  let box: PixelBox | null = null;
  for (const rendering of renderings) {
    const bounds = productBounds(rendering, w, h);
    if (bounds === null) return null;
    if (bounds === 'empty') continue;
    box = box
      ? { x0: Math.min(box.x0, bounds.x0), y0: Math.min(box.y0, bounds.y0), x1: Math.max(box.x1, bounds.x1), y1: Math.max(box.y1, bounds.y1) }
      : bounds;
  }
  if (!box) return null;

  const margin = Math.ceil(Math.max(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1) * FRAME_MARGIN);
  const left = Math.max(0, box.x0 - margin);
  const top = Math.max(0, box.y0 - margin);
  const right = Math.min(w, box.x1 + 1 + margin);
  const bottom = Math.min(h, box.y1 + 1 + margin);
  const frame = { left: left / w, top: top / h, width: (right - left) / w, height: (bottom - top) / h };

  if (frame.width * frame.height > 1 - FRAME_MIN_SAVING) return null;
  if (Math.max(frame.width * upright.width, frame.height * upright.height) < FRAME_MIN_SOURCE_PX) return null;
  return frame;
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
function isSupportedFormat(metadata: Metadata): boolean {
  if (metadata.format === 'heif') return metadata.compression === 'av1';
  return metadata.format === 'jpeg' || metadata.format === 'png' || metadata.format === 'webp';
}

/** `frame` crops the upright image to that part first (`cardFrame`). */
export async function optimizeImage(input: Buffer, profile: ImageProfile, frame?: ImageFrame | null): Promise<OptimizedImage> {
  let metadata: Metadata;
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

  // EXIF orientation 5–8 swaps the axes, so compare against the upright size.
  const orientation = metadata.orientation ?? 1;
  const uprightWidth = orientation >= 5 ? sourceHeight : sourceWidth;
  const uprightHeight = orientation >= 5 ? sourceWidth : sourceHeight;

  const region = frame ? frameRegion(frame, uprightWidth, uprightHeight) : null;
  const encode = (quality: number) => {
    const upright = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    // Called after rotate(): sharp then extracts from the upright image.
    return (region ? upright.extract(region) : upright)
      .resize({ width: profile.maxWidth, height: profile.maxHeight, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 5, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
  };

  let output: { data: Buffer; info: OutputInfo };
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

  const resized = output.info.width !== uprightWidth;

  // Re-encoding an already-compact WebP only loses quality. Keep its bytes
  // when nothing else changes (no crop, no resize, no rotation, no metadata to strip).
  const keepOriginal =
    !region &&
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

/** An `ImageFrame` in pixels of a `width`×`height` image, rounded outwards and kept inside it. */
function frameRegion(frame: ImageFrame, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.min(width - 1, Math.max(0, Math.floor(frame.left * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(frame.top * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((frame.left + frame.width) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((frame.top + frame.height) * height)));
  return { left, top, width: right - left, height: bottom - top };
}
