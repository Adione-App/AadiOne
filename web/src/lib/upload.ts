/**
 * Product image upload.
 *
 * Three steps, because image bytes never travel through the API's JSON body
 * (PRD §42):
 *
 *   1. ask the API for an upload target
 *   2. PUT the raw bytes directly to storage
 *   3. hand the resulting key back to the API to attach to a product
 *
 * With STORAGE_PROVIDER=local:
 *   - upload target points to our own API
 *   - bearer token is required
 *
 * With STORAGE_PROVIDER=s3:
 *   - upload target is a presigned Supabase/S3 URL
 *   - bearer token must NOT be sent
 */

import { getAccessToken } from "./api";

const API_BASE =
  (import.meta.env["VITE_API_URL"] as string | undefined) ?? "/api/v1";

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
}

/** 5 MB — mirrors MAX_IMAGE_BYTES on the server. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
];

/**
 * Validate an image before asking the backend for a presigned URL.
 */
export function validateImage(file: File): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return "Please choose a JPEG, PNG, WebP or AVIF image.";
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return "Images must be 5 MB or smaller.";
  }

  return null;
}

/**
 * Returns true when the upload target belongs to our own API.
 *
 * Local storage:
 *   /api/v1/admin/uploads/direct
 *
 * S3/Supabase:
 *   https://xxxxx.supabase.co/storage/v1/s3/...
 *
 * For S3/Supabase presigned URLs we must NOT send Authorization.
 */
function needsBearerToken(uploadUrl: string): boolean {
  try {
    const target = new URL(uploadUrl, window.location.origin);

    /**
     * Local development upload route.
     *
     * This route is protected by admin authentication.
     */
    if (
      target.pathname.includes("/admin/uploads/direct") ||
      target.pathname.includes("/seller/uploads/direct")
    ) {
      return true;
    }

    /**
     * If the upload URL belongs to our API origin,
     * treat it as an API upload.
     */
    return target.origin === new URL(API_BASE, window.location.origin).origin;
  } catch {
    return false;
  }
}

/**
 * Upload one product image.
 *
 * Flow:
 *
 *   Browser
 *      ↓
 *   POST /admin/uploads/presign
 *      ↓
 *   Backend creates signed URL
 *      ↓
 *   Browser PUTs image directly to Supabase/S3
 *      ↓
 *   return storage key
 *
 * The caller then sends that key to:
 *
 *   POST /admin/product-images
 */
export async function uploadProductImage(
  file: File,
  presign: (body: {
    fileName: string;
    contentType: string;
  }) => Promise<PresignedUpload>,
  /** The session that owns the upload — the admin one unless a caller (the seller panel) passes its own. */
  getToken: () => string | null = getAccessToken,
): Promise<string> {
  /* ---------------------------------------------------------------------- */
  /* 1. Validate image                                                      */
  /* ---------------------------------------------------------------------- */

  const invalid = validateImage(file);

  if (invalid) {
    throw new Error(invalid);
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Ask backend for presigned upload URL                                */
  /* ---------------------------------------------------------------------- */

  const target = await presign({
    fileName: file.name,
    contentType: file.type,
  });

  /* ---------------------------------------------------------------------- */
  /* 3. Prepare headers                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * IMPORTANT:
   *
   * target.headers contains the exact Content-Type used by the backend
   * while generating the S3 signature.
   *
   * Do not change it.
   */
  const headers: Record<string, string> = {
    ...target.headers,
  };

  /* ---------------------------------------------------------------------- */
  /* 4. Add bearer token ONLY for our local API upload route                */
  /* ---------------------------------------------------------------------- */

  const token = getToken();

  if (token && needsBearerToken(target.uploadUrl)) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Upload directly to storage                                         */
  /* ---------------------------------------------------------------------- */

  const response = await fetch(target.uploadUrl, {
    method: "PUT",

    /**
     * Do not manually set Content-Type here.
     *
     * It is already supplied by target.headers and MUST match the
     * value that was signed by the backend.
     */
    headers,

    body: file,
  });

  /* ---------------------------------------------------------------------- */
  /* 6. Handle upload errors                                                */
  /* ---------------------------------------------------------------------- */

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "The upload was rejected as unauthenticated. Check that API_BASE_URL in the " +
          "backend .env matches the address this panel talks to, then restart the API.",
      );
    }

    if (response.status === 403) {
      throw new Error(
        "The image upload was rejected by storage (403). " +
          "The presigned upload URL may be invalid or expired.",
      );
    }

    throw new Error(
      `Could not upload the image (${response.status}). Please try again.`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Return storage key                                                  */
  /* ---------------------------------------------------------------------- */

  return target.key;
}
