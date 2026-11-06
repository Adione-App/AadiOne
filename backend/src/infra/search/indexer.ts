/**
 * Smart Search indexer — keeps `product_search_terms` in step with products.
 *
 * Correctness does NOT depend on anyone calling this at the right time:
 *
 *   1. DB triggers (v2_smart_search migration) set
 *      `products.search_index_stale = true` in the same transaction as any
 *      change to a product's searchable text, or a rename of its brand or
 *      category. No write path can skip that.
 *   2. While a product is stale, search ignores its old terms and matches its
 *      live name instead (engine.ts), so a renamed product is never found
 *      under its old name and a new one is findable at once.
 *   3. This module rebuilds stale products: right after a catalogue write (a
 *      debounced in-process request, see `requestSearchReindex`), and from
 *      the `search-index` sweep job every 30 s (jobs/index.ts) — which is
 *      the retry when a rebuild fails or the process dies mid-way.
 *
 * A rebuild locks the product rows first (`FOR NO KEY UPDATE` — compatible
 * with the FK checks of concurrent variant/listing writes), then reads them,
 * so it always indexes the latest committed text, and a write that commits
 * after it re-marks the product stale. Delete + insert of one product's terms
 * happen in that one transaction, so a reader sees the old set or the new
 * set, never half of each.
 */

import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db/prisma';
import { isTest } from '../../config/env';
import { moduleLogger } from '../../common/logger';
import { buildSearchTerms, type SearchField, type SearchTerm } from '../../shared/search-match';

const log = moduleLogger('search-index');

/** Products rebuilt per transaction. */
export const REINDEX_BATCH_SIZE = 200;

interface ProductSearchSourceRow {
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

/** What of a product is searchable — the one definition the index is built from. */
export function productSearchFields(row: {
  name: string;
  nameHi?: string | null;
  searchKeywords?: readonly string[] | null;
  brandName?: string | null;
  categoryName?: string | null;
  categoryNameHi?: string | null;
  parentCategoryName?: string | null;
  parentCategoryNameHi?: string | null;
}): SearchField[] {
  return [
    { text: row.name, source: 'NAME' },
    { text: row.nameHi, source: 'NAME_HI' },
    ...(row.searchKeywords ?? []).map((keyword): SearchField => ({ text: keyword, source: 'KEYWORD' })),
    { text: row.brandName, source: 'BRAND' },
    { text: row.categoryName, source: 'CATEGORY' },
    { text: row.categoryNameHi, source: 'CATEGORY' },
    { text: row.parentCategoryName, source: 'CATEGORY' },
    { text: row.parentCategoryNameHi, source: 'CATEGORY' },
  ];
}

export function productSearchTerms(row: ProductSearchSourceRow): SearchTerm[] {
  return buildSearchTerms(
    productSearchFields({
      name: row.name,
      nameHi: row.name_hi,
      searchKeywords: row.search_keywords,
      brandName: row.brand_name,
      categoryName: row.category_name,
      categoryNameHi: row.category_name_hi,
      parentCategoryName: row.parent_name,
      parentCategoryNameHi: row.parent_name_hi,
    }),
  );
}

const uuidList = (ids: readonly string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

export interface ReindexResult {
  /** Products whose terms were rebuilt. */
  indexed: number;
  /** Deleted products whose terms were removed. */
  cleared: number;
  /** Term rows written. */
  terms: number;
}

/**
 * Rebuilds the terms of the locked products in `tx`. `ids` must already be
 * locked by the caller's transaction.
 */
async function rebuildLocked(tx: Tx, ids: string[]): Promise<ReindexResult> {
  if (ids.length === 0) return { indexed: 0, cleared: 0, terms: 0 };

  const rows = await tx.$queryRaw<ProductSearchSourceRow[]>`
    SELECT p.id, p.name, p.name_hi, p.search_keywords, p.deleted_at,
           b.name AS brand_name,
           c.name AS category_name, c.name_hi AS category_name_hi,
           parent.name AS parent_name, parent.name_hi AS parent_name_hi
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN categories parent ON parent.id = c.parent_id
    WHERE p.id IN (${uuidList(ids)})`;

  await tx.$executeRaw`DELETE FROM product_search_terms WHERE product_id IN (${uuidList(ids)})`;

  const productIds: string[] = [];
  const terms: string[] = [];
  const keys: string[] = [];
  const sources: string[] = [];
  const weights: number[] = [];
  let cleared = 0;
  for (const row of rows) {
    // A deleted product is never searchable anywhere: no terms at all.
    if (row.deleted_at) {
      cleared += 1;
      continue;
    }
    for (const term of productSearchTerms(row)) {
      productIds.push(row.id);
      terms.push(term.term);
      keys.push(term.key);
      sources.push(term.source);
      weights.push(term.weight);
    }
  }

  // Bounded statements: a 200-product batch is ~10k rows.
  const CHUNK = 5000;
  for (let start = 0; start < productIds.length; start += CHUNK) {
    const end = start + CHUNK;
    await tx.$executeRaw`
      INSERT INTO product_search_terms (product_id, term, key, source, weight)
      SELECT * FROM unnest(
        ${productIds.slice(start, end)}::uuid[],
        ${terms.slice(start, end)}::varchar[],
        ${keys.slice(start, end)}::varchar[],
        ${sources.slice(start, end)}::varchar[],
        ${weights.slice(start, end)}::smallint[]
      )
      ON CONFLICT (product_id, term) DO NOTHING`;
  }

  await tx.$executeRaw`UPDATE products SET search_index_stale = false WHERE id IN (${uuidList(ids)})`;
  return { indexed: rows.length - cleared, cleared, terms: productIds.length };
}

const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

/**
 * Rebuilds these products' terms now (waiting for any write in progress on
 * them). Unknown ids are ignored. Used by the backfill and by tests; the app
 * normally relies on the stale queue instead.
 */
export async function reindexProducts(productIds: readonly string[]): Promise<ReindexResult> {
  const total: ReindexResult = { indexed: 0, cleared: 0, terms: 0 };
  const unique = [...new Set(productIds)].sort();
  for (let start = 0; start < unique.length; start += REINDEX_BATCH_SIZE) {
    const batch = unique.slice(start, start + REINDEX_BATCH_SIZE);
    const result = await prisma.$transaction(async (tx) => {
      // Sorted ids: concurrent batches lock in the same order (no deadlock).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM products WHERE id IN (${uuidList(batch)}) ORDER BY id FOR NO KEY UPDATE`;
      return rebuildLocked(tx, locked.map((row) => row.id));
    }, TX_OPTIONS);
    total.indexed += result.indexed;
    total.cleared += result.cleared;
    total.terms += result.terms;
  }
  return total;
}

/**
 * One batch of the stale queue. Rows another indexer (another request, the
 * sweep, a second instance) is already rebuilding are skipped, not waited on.
 */
export async function reindexStaleBatch(batchSize = REINDEX_BATCH_SIZE): Promise<ReindexResult & { picked: number }> {
  return prisma.$transaction(async (tx) => {
    const picked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM products WHERE search_index_stale
      ORDER BY id
      LIMIT ${batchSize}
      FOR NO KEY UPDATE SKIP LOCKED`;
    const result = await rebuildLocked(tx, picked.map((row) => row.id));
    return { ...result, picked: picked.length };
  }, TX_OPTIONS);
}

/** Drains the stale queue (bounded: at most `maxBatches` batches per call). */
export async function reindexStaleProducts(options: { batchSize?: number; maxBatches?: number } = {}): Promise<ReindexResult> {
  const batchSize = options.batchSize ?? REINDEX_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? 25;
  const total: ReindexResult = { indexed: 0, cleared: 0, terms: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await reindexStaleBatch(batchSize);
    total.indexed += result.indexed;
    total.cleared += result.cleared;
    total.terms += result.terms;
    if (result.picked < batchSize) break;
  }
  if (total.indexed + total.cleared > 0) log.info(total, 'search terms rebuilt');
  return total;
}

/** How many products are waiting to be (re)indexed. */
export async function countStaleProducts(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM products WHERE search_index_stale`;
  return Number(row?.count ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Rebuild soon after a catalogue write                                       */
/* -------------------------------------------------------------------------- */

const REQUEST_DEBOUNCE_MS = 400;
let requestTimer: NodeJS.Timeout | null = null;
let running: Promise<unknown> | null = null;
let rerun = false;
let autoReindex = !isTest;

/** Tests drive the indexer explicitly; this turns the write hook on/off. */
export function setAutoReindex(enabled: boolean): void {
  autoReindex = enabled;
}

/**
 * Asks for the stale queue to be drained shortly. Cheap and safe to call
 * from anywhere, any number of times: calls within 400 ms collapse into one
 * run, and a run already in progress is followed by exactly one more. Never
 * throws — a failure is logged and the sweep job retries.
 */
export function requestSearchReindex(): void {
  if (!autoReindex) return;
  if (requestTimer) return;
  requestTimer = setTimeout(() => {
    requestTimer = null;
    if (running) {
      rerun = true;
      return;
    }
    running = reindexStaleProducts()
      .catch((error) => log.warn({ err: error }, 'search reindex failed — the sweep job will retry'))
      .finally(() => {
        running = null;
        if (rerun) {
          rerun = false;
          requestSearchReindex();
        }
      });
  }, REQUEST_DEBOUNCE_MS);
  requestTimer.unref();
}

/**
 * Every Prisma write to a product, category or brand requests a rebuild.
 * The triggers decide WHAT is stale; this only makes the rebuild prompt.
 * Raw-SQL writes are not seen here — the sweep job picks those up.
 */
const WATCHED_MODELS = new Set(['Product', 'Category', 'Brand']);
const WRITE_ACTIONS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

let hookInstalled = false;
export function installSearchIndexHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  prisma.$use(async (params, next) => {
    const result = await next(params);
    if (params.model && WATCHED_MODELS.has(params.model) && WRITE_ACTIONS.has(params.action)) requestSearchReindex();
    return result;
  });
}
