/**
 * Smart Search backfill — (re)builds `product_search_terms` for EVERY
 * product, in keyset-ordered batches, without ever loading the catalogue
 * into memory. Run after the v2_smart_search migration, and again after a
 * dictionary change (shared/search-dictionary.ts) so existing products pick
 * up the new synonyms. CLI: scripts/search-backfill.ts.
 *
 * Idempotent: each batch replaces exactly its products' rows inside one
 * transaction (PK product_id+term), so running it twice — or alongside the
 * app's own indexer — leaves the same rows, never duplicates. Product ids and
 * every other column are untouched; only `search_index_stale` is cleared.
 */

import { prisma } from '../db/prisma';
import { productSearchTerms, reindexProducts, REINDEX_BATCH_SIZE } from './indexer';

export interface BackfillOptions {
  /** Count and preview only: nothing is written. */
  dryRun?: boolean;
  batchSize?: number;
  /** Progress callback (the CLI prints it). */
  onProgress?: (progress: BackfillProgress) => void;
}

export interface BackfillProgress {
  processed: number;
  total: number;
  indexed: number;
  cleared: number;
  terms: number;
  failedBatches: number;
}

export interface BackfillReport extends BackfillProgress {
  dryRun: boolean;
  staleBefore: number;
  staleAfter: number;
  /** First id of each failed batch, for a targeted re-run. */
  failures: { firstProductId: string; size: number; error: string }[];
  /** Dry run only: a few products and the terms they would get. */
  preview: { productId: string; name: string; termCount: number; sampleTerms: string[] }[];
}

interface SourceRow {
  id: string;
  name: string;
  name_hi: string | null;
  search_keywords: string[] | null;
  deleted_at: Date | null;
  brand_name: string | null;
  category_name: string | null;
  category_name_hi: string | null;
  parent_name: string | null;
  parent_name_hi: string | null;
}

async function countProducts(): Promise<{ total: number; stale: number }> {
  const [row] = await prisma.$queryRaw<{ total: bigint; stale: bigint }[]>`
    SELECT count(*) AS total, count(*) FILTER (WHERE search_index_stale) AS stale FROM products`;
  return { total: Number(row?.total ?? 0), stale: Number(row?.stale ?? 0) };
}

async function nextIds(lastId: string | null, batchSize: number): Promise<string[]> {
  const rows = lastId
    ? await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE id > ${lastId}::uuid ORDER BY id LIMIT ${batchSize}`
    : await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM products ORDER BY id LIMIT ${batchSize}`;
  return rows.map((row) => row.id);
}

export async function runSearchBackfill(options: BackfillOptions = {}): Promise<BackfillReport> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? REINDEX_BATCH_SIZE, 1000));
  const before = await countProducts();
  const report: BackfillReport = {
    dryRun: options.dryRun ?? false,
    total: before.total,
    staleBefore: before.stale,
    staleAfter: before.stale,
    processed: 0,
    indexed: 0,
    cleared: 0,
    terms: 0,
    failedBatches: 0,
    failures: [],
    preview: [],
  };

  let lastId: string | null = null;
  for (;;) {
    const ids = await nextIds(lastId, batchSize);
    if (ids.length === 0) break;
    lastId = ids[ids.length - 1]!;

    if (report.dryRun) {
      const rows = await prisma.$queryRaw<SourceRow[]>`
        SELECT p.id, p.name, p.name_hi, p.search_keywords, p.deleted_at,
               b.name AS brand_name, c.name AS category_name, c.name_hi AS category_name_hi,
               parent.name AS parent_name, parent.name_hi AS parent_name_hi
        FROM products p
        LEFT JOIN brands b ON b.id = p.brand_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN categories parent ON parent.id = c.parent_id
        WHERE p.id = ANY(${ids}::uuid[])`;
      for (const row of rows) {
        if (row.deleted_at) {
          report.cleared += 1;
          continue;
        }
        const terms = productSearchTerms(row);
        report.indexed += 1;
        report.terms += terms.length;
        if (report.preview.length < 10) {
          report.preview.push({
            productId: row.id,
            name: row.name,
            termCount: terms.length,
            sampleTerms: terms.slice(0, 12).map((term) => term.term),
          });
        }
      }
    } else {
      try {
        const result = await reindexProducts(ids);
        report.indexed += result.indexed;
        report.cleared += result.cleared;
        report.terms += result.terms;
      } catch (error) {
        report.failedBatches += 1;
        report.failures.push({
          firstProductId: ids[0]!,
          size: ids.length,
          error: error instanceof Error ? error.message.split('\n')[0]! : String(error),
        });
      }
    }
    report.processed += ids.length;
    options.onProgress?.({ ...report });
  }

  report.staleAfter = (await countProducts()).stale;
  return report;
}
