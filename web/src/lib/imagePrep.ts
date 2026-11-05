/**
 * Product photos are made upload-sized in the browser before they leave it.
 *
 * A phone photo is typically 3–8 MB at 4000 px; the server stores product
 * images at 1200 px (image-optimizer.ts, profile `product`) anyway. Sending
 * the full file cost the upload time of every one of those megabytes, then a
 * 12-megapixel decode on the server. Here the photo is scaled to at most
 * MAX_EDGE px — above the server's 1200 px, so the stored image is as sharp
 * as before and a card crop still has detail — and re-encoded as WebP (JPEG
 * where the browser cannot write WebP; a PNG with transparency stays PNG
 * then, so its transparency is never flattened).
 *
 * The server still checks and optimizes every upload exactly as before; this
 * only sends it fewer bytes. Any failure here (an old browser, a decode error)
 * falls back to the original file — never a blocked upload.
 */

export const MAX_EDGE = 1600;
export const WEBP_QUALITY = 0.86;
/** A file this small and already within MAX_EDGE is sent as it is. */
export const SMALL_ENOUGH_BYTES = 600 * 1024;

/** Upload size of a `width`×`height` image: scaled down to fit MAX_EDGE, never up. */
export function targetSize(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether the re-encoded file replaces the original: it must be smaller (a resize always counts). */
export function keepReencoded(original: { size: number }, reencoded: { size: number }, resized: boolean): boolean {
  return resized || reencoded.size < original.size;
}

const EXTENSION: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

export function renamed(fileName: string, type: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}.${EXTENSION[type] ?? 'img'}`;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function hasTransparency(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
  return false;
}

/**
 * The file to upload: `file` scaled to fit MAX_EDGE and re-encoded, or
 * `file` itself when it is already small or anything goes wrong.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bitmap: ImageBitmap | null = null;
  try {
    // EXIF orientation applied, so the pixels are upright like the server's .rotate().
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = targetSize(bitmap.width, bitmap.height);
    const resized = size.width !== bitmap.width || size.height !== bitmap.height;
    if (!resized && file.size <= SMALL_ENOUGH_BYTES) return file;

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    let blob = await canvasBlob(canvas, 'image/webp', WEBP_QUALITY);
    // A browser without a WebP encoder returns PNG for any type it cannot write.
    if (!blob || blob.type !== 'image/webp') {
      const keepAlpha = file.type === 'image/png' && hasTransparency(context, size.width, size.height);
      blob = keepAlpha ? await canvasBlob(canvas, 'image/png', 1) : await canvasBlob(canvas, 'image/jpeg', WEBP_QUALITY);
    }
    if (!blob || !keepReencoded(file, blob, resized)) return file;
    return new File([blob], renamed(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
