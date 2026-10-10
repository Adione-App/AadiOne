/**
 * Bulk import limits in force: the shared defaults (shared/product-import.ts),
 * with the two operator-tunable ones read from the environment.
 */

import { PRODUCT_IMPORT_LIMITS } from '../../shared';
import { env } from '../../config/env';

export function importLimits() {
  const maxArchiveBytes = env.PRODUCT_IMPORT_MAX_ARCHIVE_MB * 1024 * 1024;
  return {
    ...PRODUCT_IMPORT_LIMITS,
    maxRows: env.PRODUCT_IMPORT_MAX_ROWS,
    maxArchiveBytes,
    /** What the ZIP may claim to unpack to: images barely compress, so 4× is generous. */
    maxArchiveUncompressedBytes: Math.max(maxArchiveBytes * 4, 64 * 1024 * 1024),
  };
}

/** How long an unconfirmed preview is kept. */
export const PREVIEW_TTL_MS = 7 * 24 * 3600_000;
/** Row-level detail of finished imports is kept this long; the summary forever. */
export const ROW_RETENTION_MS = 90 * 24 * 3600_000;
/** A worker silent this long has died: analysis fails, processing resumes. */
export const STALE_ANALYSIS_MS = 15 * 60_000;
export const STALE_PROCESSING_MS = 2 * 60_000;
/** Rows written per transaction. */
export const PROCESS_BATCH_SIZE = 50;
/** Processing runs per import before it fails for good (each crash / unexpected error uses one). */
export const MAX_PROCESS_ATTEMPTS = 5;
/** A processing worker renews its lease this often (well inside STALE_PROCESSING_MS). */
export const LEASE_RENEW_MS = 20_000;
