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
import { prepareImageForUpload } from "./imagePrep";
import { isRetryableStatus, withRetry } from "./retry";

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
 * A photo resized in the browser (imagePrep.ts) may start larger than
 * MAX_IMAGE_BYTES — what is uploaded is checked against that limit after the
 * resize. Past this, the file is refused before it is even decoded.
 */
export const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;

/**
 * Validate an image before asking the backend for a presigned URL.
 * `resizable`: the file is resized before upload, so only the source cap applies here.
 */
export function validateImage(file: File, resizable = false): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return "Please choose a JPEG, PNG, WebP or AVIF image.";
  }

  if (resizable ? file.size > MAX_SOURCE_IMAGE_BYTES : file.size > MAX_IMAGE_BYTES) {
    return resizable ? "Images must be 30 MB or smaller." : "Images must be 5 MB or smaller.";
  }

  return null;
}

export interface UploadOptions {
  /** Resize / re-encode in the browser first (product photos — imagePrep.ts). */
  optimize?: boolean;
  /** Upload progress of the bytes, 0..1. */
  onProgress?: (fraction: number) => void;
}

/** PUT with upload progress (fetch has none). Resolves to the HTTP status; rejects on a network error. */
function putWithProgress(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress?: (fraction: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    if (onProgress) {
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
      };
    }
    request.onload = () => resolve(request.status);
    // A TypeError, like fetch's network failure, so lib/retry.ts tries it again.
    request.onerror = () => reject(new TypeError("The image upload failed — check your connection and try again."));
    request.onabort = () => reject(new Error("The image upload was cancelled."));
    request.send(body);
  });
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
  options: UploadOptions = {},
): Promise<string> {
  /* ---------------------------------------------------------------------- */
  /* 1. Validate image                                                      */
  /* ---------------------------------------------------------------------- */

  const invalid = validateImage(file, options.optimize === true);

  if (invalid) {
    throw new Error(invalid);
  }

  if (options.optimize) {
    file = await prepareImageForUpload(file);

    // What is actually sent must fit the server's limit.
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error("This image is still over 5 MB after resizing. Please choose a smaller picture.");
    }
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

  /**
   * Do not manually set Content-Type here.
   *
   * It is already supplied by target.headers and MUST match the
   * value that was signed by the backend.
   */
  // A dropped connection or a storage hiccup (5xx / 408 / 429) is tried again
  // (lib/retry.ts) with the same signed target: the same key, the same bytes.
  const body = file;
  const status = await withRetry(async () => {
    const answer = options.onProgress
      ? await putWithProgress(target.uploadUrl, headers, body, options.onProgress)
      : (await fetch(target.uploadUrl, { method: "PUT", headers, body })).status;
    if (isRetryableStatus(answer)) throw Object.assign(new Error(`storage answered ${answer}`), { status: answer });
    return answer;
  }).catch((error: unknown) => {
    const failed = (error as { status?: unknown }).status;
    if (typeof failed === "number") return failed;
    throw error;
  });

  /* ---------------------------------------------------------------------- */
  /* 6. Handle upload errors                                                */
  /* ---------------------------------------------------------------------- */

  if (status < 200 || status >= 300) {
    if (status === 401) {
      throw new Error(
        "The upload was rejected as unauthenticated. Check that API_BASE_URL in the " +
          "backend .env matches the address this panel talks to, then restart the API.",
      );
    }

    if (status === 403) {
      throw new Error(
        "The image upload was rejected by storage (403). " +
          "The presigned upload URL may be invalid or expired.",
      );
    }

    throw new Error(
      `Could not upload the image (${status}). Please try again.`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Return storage key                                                  */
  /* ---------------------------------------------------------------------- */

  return target.key;
}
