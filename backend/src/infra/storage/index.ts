/**
 * StorageProvider port — product images.
 *
 * Images never go into the database (PRD §42) and never travel through the
 * JSON body. The admin panel asks for a presigned upload target, PUTs the file
 * directly to storage, and then sends us only the resulting key.
 *
 * `local` writes to disk and is served by the /static route in development.
 * `s3` targets any S3-compatible endpoint (AWS S3, Supabase Storage S3,
 * Cloudflare R2, MinIO).
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import { env, isProduction } from "../../config/env";
import { moduleLogger } from "../../common/logger";
import { AppError } from "../../common/errors";
import { ErrorCode } from "../../shared";

const log = moduleLogger("storage");

/** Renditions generated for every product image (PRD §10.5). */
export const IMAGE_RENDITIONS = {
  thumb: 200,
  card: 400,
  detail: 800,
} as const;

export type RenditionName = keyof typeof IMAGE_RENDITIONS;

export interface StoredImage {
  key: string;
  url: string;
  thumbUrl: string;
  cardUrl: string;
}

export interface PresignedUpload {
  /** Where the client PUTs the bytes. */
  uploadUrl: string;

  /** Opaque key the client returns to us afterwards. */
  key: string;

  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;

  expiresInSeconds: number;
}

export interface StorageProvider {
  readonly name: string;

  /** Direct upload — used by the local dev provider and tests. */
  put(key: string, body: Buffer, contentType: string): Promise<StoredImage>;

  createPresignedUpload(input: {
    folder: string;
    fileName: string;
    contentType: string;
    /** Local provider only: the API route that accepts the bytes (default: the admin one). */
    directUploadPath?: string;
  }): Promise<PresignedUpload>;

  remove(key: string): Promise<void>;

  publicUrl(key: string): string;
}

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function assertUploadable(
  contentType: string,
  sizeBytes?: number,
): void {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
      message: "Please upload a JPEG, PNG, WebP or AVIF image.",
      internalMessage: `rejected content type ${contentType}`,
    });
  }

  if (sizeBytes !== undefined && sizeBytes > MAX_IMAGE_BYTES) {
    throw new AppError(ErrorCode.FILE_TOO_LARGE, {
      message: "Images must be 5 MB or smaller.",
      internalMessage: `rejected size ${sizeBytes}`,
    });
  }
}

/**
 * Collision-proof, guessable-URL-proof object key.
 */
export function buildImageKey(folder: string, fileName: string): string {
  const extension = path.extname(fileName).toLowerCase() || ".jpg";

  const stamp = new Date().toISOString().slice(0, 10);

  return `${folder}/${stamp}/${randomUUID()}${extension}`;
}

/* -------------------------------------------------------------------------- */
/* Local storage                                                              */
/* -------------------------------------------------------------------------- */

class LocalStorageProvider implements StorageProvider {
  readonly name = "local";

  private readonly root = path.resolve(process.cwd(), "storage");

  publicUrl(key: string): string {
    return `${env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<StoredImage> {
    assertUploadable(contentType, body.byteLength);

    const target = path.join(this.root, key);

    await mkdir(path.dirname(target), { recursive: true });

    await writeFile(target, body);

    // Renditions are a production concern (sharp).
    // In development the same file is served for every size.
    const url = this.publicUrl(key);

    return {
      key,
      url,
      thumbUrl: url,
      cardUrl: url,
    };
  }

  async createPresignedUpload(input: {
    folder: string;
    fileName: string;
    contentType: string;
    directUploadPath?: string;
  }): Promise<PresignedUpload> {
    assertUploadable(input.contentType);

    const key = buildImageKey(input.folder, input.fileName);

    // No real signing locally.
    // The development upload route accepts the key directly.
    return {
      uploadUrl:
        `${env.API_BASE_URL}` +
        `${input.directUploadPath ?? '/api/v1/admin/uploads/direct'}?key=` +
        `${encodeURIComponent(key)}`,

      key,

      headers: {
        "Content-Type": input.contentType,
      },

      expiresInSeconds: 900,
    };
  }

  async remove(key: string): Promise<void> {
    await unlink(path.join(this.root, key)).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* S3-compatible storage                                                      */
/* -------------------------------------------------------------------------- */

/**
 * S3-compatible provider.
 *
 * Uses AWS Signature Version 4 presigned URLs.
 *
 * Supported targets include:
 * - Supabase Storage S3
 * - AWS S3
 * - Cloudflare R2
 * - MinIO
 */
class S3StorageProvider implements StorageProvider {
  readonly name = "s3";

  publicUrl(key: string): string {
    return `${env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
  }

  /**
   * AWS SigV4 HMAC helper.
   *
   * IMPORTANT:
   * This MUST use HMAC-SHA256.
   * A normal SHA256 hash is NOT equivalent to HMAC-SHA256.
   */
  private hmac(key: Buffer | string, data: string): Buffer {
    return createHmac("sha256", key).update(data).digest();
  }

  /**
   * AWS percent encoding.
   *
   * encodeURIComponent is close to AWS URI encoding,
   * but AWS requires "~" to remain unescaped.
   */
  private awsEncode(value: string): string {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }

  /**
   * Encode an S3 object key while preserving `/`
   * because `/` separates object-key path segments.
   */
  private encodeObjectKey(key: string): string {
    return key
      .split("/")
      .map((part) => this.awsEncode(part))
      .join("/");
  }

  /**
   * Create AWS Signature V4 presigned URL.
   *
   * For PUT:
   *   Signed headers = content-type;host
   *
   * For DELETE:
   *   Signed headers = host
   *
   * This is important because DELETE requests do not send
   * the same Content-Type header as image uploads.
   */
  sign(
    method: "PUT" | "DELETE" | "GET",
    key: string,
    contentType: string | undefined,
    expiresInSeconds: number,
    bucket: string | undefined = env.S3_BUCKET,
  ): string {
    if (!env.S3_ENDPOINT) {
      throw new Error("S3_ENDPOINT is required when STORAGE_PROVIDER=s3");
    }

    if (!env.S3_REGION) {
      throw new Error("S3_REGION is required when STORAGE_PROVIDER=s3");
    }

    if (!bucket) {
      throw new Error("S3_BUCKET is required when STORAGE_PROVIDER=s3");
    }

    if (!env.S3_ACCESS_KEY_ID) {
      throw new Error("S3_ACCESS_KEY_ID is required when STORAGE_PROVIDER=s3");
    }

    if (!env.S3_SECRET_ACCESS_KEY) {
      throw new Error(
        "S3_SECRET_ACCESS_KEY is required when STORAGE_PROVIDER=s3",
      );
    }

    const endpoint = new URL(env.S3_ENDPOINT);

    const host = endpoint.host;

    const now = new Date();

    /**
     * Example:
     * 20260911T083420Z
     */
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");

    const dateStamp = amzDate.slice(0, 8);

    const credentialScope =
      `${dateStamp}/` + `${env.S3_REGION}/` + `s3/aws4_request`;

    /**
     * S3-compatible endpoints such as Supabase:
     *
     * https://PROJECT.supabase.co/storage/v1/s3
     *
     * The endpoint pathname MUST be included in the
     * canonical URI.
     */
    const basePath = endpoint.pathname.replace(/\/$/, "");

    const encodedKey = this.encodeObjectKey(key);

    const canonicalUri =
      `${basePath}/` + `${this.awsEncode(bucket)}/` + `${encodedKey}`;

    /* ---------------------------------------------------------------------- */
    /* Signed headers                                                         */
    /* ---------------------------------------------------------------------- */

    const isPut = method === "PUT";

    const signedHeaders = isPut ? "content-type;host" : "host";

    let canonicalHeaders: string;

    if (isPut) {
      if (!contentType) {
        throw new Error("Content-Type is required for PUT presigned uploads");
      }

      canonicalHeaders = `content-type:${contentType}\n` + `host:${host}\n`;
    } else {
      canonicalHeaders = `host:${host}\n`;
    }

    /* ---------------------------------------------------------------------- */
    /* Query parameters                                                       */
    /* ---------------------------------------------------------------------- */

    const credential = `${env.S3_ACCESS_KEY_ID}/` + `${credentialScope}`;

    const queryParams: Array<[string, string]> = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", credential],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(expiresInSeconds)],
      ["X-Amz-SignedHeaders", signedHeaders],
    ];

    /**
     * AWS canonical query string:
     * - encode names
     * - encode values
     * - sort by encoded name
     * - then sort by encoded value
     */
    const canonicalQueryString = queryParams
      .map(
        ([name, value]) =>
          [this.awsEncode(name), this.awsEncode(value)] as const,
      )
      .sort(([nameA, valueA], [nameB, valueB]) => {
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;

        if (valueA < valueB) return -1;
        if (valueA > valueB) return 1;

        return 0;
      })
      .map(([name, value]) => `${name}=${value}`)
      .join("&");

    /* ---------------------------------------------------------------------- */
    /* Canonical request                                                      */
    /* ---------------------------------------------------------------------- */

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const canonicalRequestHash = createHash("sha256")
      .update(canonicalRequest)
      .digest("hex");

    /* ---------------------------------------------------------------------- */
    /* String to sign                                                         */
    /* ---------------------------------------------------------------------- */

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      canonicalRequestHash,
    ].join("\n");

    /* ---------------------------------------------------------------------- */
    /* Derive signing key                                                     */
    /* ---------------------------------------------------------------------- */

    const kDate = this.hmac(`AWS4${env.S3_SECRET_ACCESS_KEY}`, dateStamp);

    const kRegion = this.hmac(kDate, env.S3_REGION);

    const kService = this.hmac(kRegion, "s3");

    const signingKey = this.hmac(kService, "aws4_request");

    /* ---------------------------------------------------------------------- */
    /* Final signature                                                         */
    /* ---------------------------------------------------------------------- */

    const signature = createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");

    /**
     * Build the final URL using the same encoded values
     * used during canonical signing.
     */
    const finalQuery = queryParams
      .map(
        ([name, value]) =>
          [this.awsEncode(name), this.awsEncode(value)] as const,
      )
      .sort(([nameA, valueA], [nameB, valueB]) => {
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;

        if (valueA < valueB) return -1;
        if (valueA > valueB) return 1;

        return 0;
      })
      .map(([name, value]) => `${name}=${value}`)
      .join("&");

    return (
      `${endpoint.origin}` +
      `${canonicalUri}` +
      `?${finalQuery}` +
      `&X-Amz-Signature=${signature}`
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Direct server-side PUT                                                   */
  /* ------------------------------------------------------------------------ */

  async put(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<StoredImage> {
    assertUploadable(contentType, body.byteLength);

    const url = this.sign("PUT", key, contentType, 300);

    const response = await fetch(url, {
      method: "PUT",

      body: new Uint8Array(body),

      headers: {
        "Content-Type": contentType,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");

      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        internalMessage:
          `s3 upload failed: ` + `${response.status} ` + `${errorBody}`,
      });
    }

    const publicUrl = this.publicUrl(key);

    return {
      key,
      url: publicUrl,
      thumbUrl: publicUrl,
      cardUrl: publicUrl,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Browser presigned upload                                                  */
  /* ------------------------------------------------------------------------ */

  async createPresignedUpload(input: {
    folder: string;
    fileName: string;
    contentType: string;
  }): Promise<PresignedUpload> {
    assertUploadable(input.contentType);

    const key = buildImageKey(input.folder, input.fileName);

    const uploadUrl = this.sign("PUT", key, input.contentType, 900);

    return {
      uploadUrl,

      key,

      /**
       * The browser MUST send exactly the same
       * Content-Type that was used during signing.
       */
      headers: {
        "Content-Type": input.contentType,
      },

      expiresInSeconds: 900,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Delete                                                                    */
  /* ------------------------------------------------------------------------ */

  async remove(key: string): Promise<void> {
    try {
      const url = this.sign("DELETE", key, undefined, 300);

      const response = await fetch(url, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");

        log.warn(
          {
            key,
            status: response.status,
            errorBody,
          },
          "s3 delete failed",
        );
      }
    } catch (error) {
      log.warn(
        {
          err: error,
          key,
        },
        "s3 delete failed",
      );
    }
  }
}

/**
 * SigV4-presigned URL for any bucket — used by the PRIVATE seller-document
 * store (private-documents.ts) for its own bucket. Short-lived; never handed
 * to a browser.
 */
export function presignS3(
  method: "PUT" | "DELETE" | "GET",
  bucket: string,
  key: string,
  contentType: string | undefined,
  expiresInSeconds: number,
): string {
  return new S3StorageProvider().sign(method, key, contentType, expiresInSeconds, bucket);
}

/* -------------------------------------------------------------------------- */
/* Provider factory                                                            */
/* -------------------------------------------------------------------------- */

function createStorageProvider(): StorageProvider {
  const provider =
    env.STORAGE_PROVIDER === "s3"
      ? new S3StorageProvider()
      : new LocalStorageProvider();

  if (provider.name === "local" && isProduction) {
    throw new Error(
      "local storage is not durable and must not be used in production",
    );
  }

  log.info(
    {
      provider: provider.name,
    },
    "storage provider initialised",
  );

  return provider;
}

export const storage: StorageProvider = createStorageProvider();
