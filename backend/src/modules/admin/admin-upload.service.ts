/**
 * Admin image uploads — the same flow as the Seller Panel's
 * (seller-image.service.ts): presign -> the browser PUTs the raw file straight
 * to storage -> an attach endpoint sends the key, and the server runs it
 * through the image pipeline (uploaded-image.service.ts: validate, resize,
 * WebP, raw upload deleted). Nothing here processes images itself.
 *
 * Admin keys live under their own folder, `admin/<purpose>/…`, and every
 * admin attach endpoint accepts only keys from there — so an admin endpoint
 * can never be pointed at a seller's upload, or the other way round.
 */

import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';
import { assertUploadable, storage, type PresignedUpload } from '../../infra/storage';

export const ADMIN_DIRECT_UPLOAD_PATH = '/api/v1/admin/uploads/direct';

/** What an admin upload is for — decides its storage folder. */
export const ADMIN_UPLOAD_PURPOSES = ['category', 'banner'] as const;
export type AdminUploadPurpose = (typeof ADMIN_UPLOAD_PURPOSES)[number];

const FOLDER: Record<AdminUploadPurpose, string> = {
  category: 'admin/categories',
  banner: 'admin/banners',
};

/** Throws unless `key` is a well-formed admin upload key. */
export function assertAdminKey(key: string): void {
  if (!key.startsWith('admin/') || key.includes('..') || !/^[A-Za-z0-9/_.-]+$/.test(key)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This upload was not made from the Admin Panel. Please upload the image again.',
      internalMessage: `admin attach with a non-admin key: ${key.slice(0, 80)}`,
    });
  }
}

export function createAdminUploadTarget(input: {
  fileName: string;
  contentType: string;
  purpose: AdminUploadPurpose;
}): Promise<PresignedUpload> {
  assertUploadable(input.contentType);
  return storage.createPresignedUpload({
    folder: FOLDER[input.purpose],
    fileName: input.fileName,
    contentType: input.contentType,
    directUploadPath: ADMIN_DIRECT_UPLOAD_PATH,
  });
}

/** The local provider's upload route (production uploads go straight to object storage). */
export async function putAdminUpload(key: string, body: unknown, contentType: string): Promise<{ url: string }> {
  assertAdminKey(key);
  if (!Buffer.isBuffer(body)) {
    // express.raw only reads image/* bodies; anything else arrives unread.
    assertUploadable(contentType);
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, { message: 'Please upload a JPEG, PNG, WebP or AVIF image.' });
  }
  const stored = await storage.put(key, body, contentType);
  return { url: stored.url };
}
