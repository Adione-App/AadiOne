/**
 * SearchProvider port.
 *
 * PostgreSQL full-text search plus trigram fuzzy matching. Requires the
 * `products.search_vector` column + trigger and the `pg_trgm` extension —
 * in V2 these come from the `v2_product_search` migration (the V2 baseline
 * was generated from schema.prisma alone, so V1's hand-written search objects
 * never carried over). The
 * interface exists so Meilisearch or Elasticsearch can be swapped in later
 * (PRD §18.2) without touching the catalog module — but running another
 * container to search a few thousand SKUs would be pure overhead today.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../../config/env';
import { moduleLogger } from '../../common/logger';
import { expandSearchTerms } from './aliases';

const log = moduleLogger('search');

/**
 * Searches the customer marketplace: products listed by any live,
 * non-restaurant seller (not deleted, switched on, onboarding APPROVED — the
 * same rule as catalog.repository's MARKETPLACE_SELLER_SQL), under switched-on
 * categories. Restaurant menus are searched on /restaurants instead.
 */
export interface SearchQuery {
  term: string;
  limit: number;
  /** Product id to resume after, for cursor pagination. */
  afterRank?: number | null;
  inStockOnly?: boolean;
}

export interface SearchHit {
  productId: string;
  rank: number;
}

export interface SearchProvider {
  readonly name: string;
  search(query: SearchQuery): Promise<SearchHit[]>;
}

/**
 * Word-similarity threshold for the trigram fallback.
 *
 * The default (0.6) rejects real misspellings: measured on seed data,
 * "colgat" scores 0.86 and "maggie" 0.71, but heavier slips fall below.
 * 0.45 catches those without dragging in unrelated products — the value was
 * chosen by measuring, not guessed (docs/02-decisions.md D11a).
 */
const WORD_SIMILARITY_THRESHOLD = 0.45;

class PostgresSearchProvider implements SearchProvider {
  readonly name = 'postgres';

  /**
   * Several strategies combined, ranked, per term:
   *
   *   0. EXACT product-name match — highest tier, always wins.
   *   1. Full-text over name + Hindi name + search_keywords + description
   *      (see the `products_search_vector_update` DB trigger). This is what
   *      makes "cheeni" find Sugar and "doodh" find Milk for any product
   *      that was actually tagged with that keyword.
   *   2. Trigram word-similarity against name/brand — typo fallback, using
   *      `<%` (word_similarity) rather than `%` (whole-string similarity),
   *      which scores a short query against a long product name far too low
   *      to match.
   *   3. Category name — lower-weighted, catches "atta" surfacing an "Atta,
   *      Rice & Dal" shelf even if no single product's own name/keywords
   *      matched.
   *
   * `expandSearchTerms` (aliases.ts) is what makes strategies 1-3 also
   * catch a Hindi/Hinglish/typo variant a product's OWN data never listed —
   * "aloo"/"आलू"/"alu" all expand to include "potato" (and vice versa)
   * before any of the SQL above runs, so a customer doesn't need every
   * product to be manually tagged with every spelling to find it.
   */
  async search(query: SearchQuery): Promise<SearchHit[]> {
    const term = query.term.trim();
    if (term.length === 0) return [];

    const normalizedTerm = term.toLowerCase();
    const expandedTerms = expandSearchTerms(term);

    // One combined tsquery ORing every expanded term — a search for "aloo"
    // matches products indexed under "potato" (or vice versa) in the same
    // single query, not a second round trip.
    const tsQueryParts = expandedTerms.map(
      (t) => Prisma.sql`plainto_tsquery('simple', ${t})`,
    );
    const combinedTsQuery = Prisma.join(tsQueryParts, ' || ');

    const nameSimilarities = expandedTerms.map(
      (t) => Prisma.sql`word_similarity(${t}, p.name)`,
    );
    const brandSimilarities = expandedTerms.map(
      (t) => Prisma.sql`COALESCE(word_similarity(${t}, b.name), 0)`,
    );
    const categorySimilarities = expandedTerms.map(
      (t) => Prisma.sql`COALESCE(word_similarity(${t}, c.name), 0)`,
    );

    const nameTrgmGate = Prisma.join(
      expandedTerms.map((t) => Prisma.sql`${t} <% p.name`),
      ' OR ',
    );
    const brandTrgmGate = Prisma.join(
      expandedTerms.map((t) => Prisma.sql`${t} <% COALESCE(b.name, '')`),
      ' OR ',
    );
    const categoryTrgmGate = Prisma.join(
      expandedTerms.map((t) => Prisma.sql`${t} <% COALESCE(c.name, '')`),
      ' OR ',
    );

    const rows = await prisma.$queryRaw<{ product_id: string; rank: number }[]>`
      WITH matches AS (
        SELECT
          p.id AS product_id,
          GREATEST(
            CASE WHEN lower(p.name) = ${normalizedTerm} THEN 100 ELSE 0 END,
            ts_rank(p.search_vector, (${combinedTsQuery})) * 10,
            GREATEST(${Prisma.join(nameSimilarities)}),
            GREATEST(${Prisma.join(brandSimilarities)}) * 0.9,
            GREATEST(${Prisma.join(categorySimilarities)}) * 0.5
          ) AS rank
        FROM products p
        LEFT JOIN brands b ON b.id = p.brand_id
        JOIN categories c ON c.id = p.category_id AND c.is_active AND c.deleted_at IS NULL
        JOIN categories top ON top.id = COALESCE(c.parent_id, c.id) AND top.is_active AND top.deleted_at IS NULL
        WHERE p.status = 'ACTIVE'
          AND p.deleted_at IS NULL
          AND p.approval_status = 'APPROVED'
          AND (
            p.search_vector @@ (${combinedTsQuery})
            OR ${nameTrgmGate}
            OR ${brandTrgmGate}
            OR ${categoryTrgmGate}
          )
      )
      SELECT m.product_id, m.rank
      FROM matches m
      WHERE EXISTS (
        SELECT 1
        FROM product_variants v
        JOIN seller_listings sl ON sl.variant_id = v.id
        JOIN sellers s ON s.id = sl.seller_id
          AND s.deleted_at IS NULL AND s.is_active AND s.onboarding_status = 'APPROVED' AND s.seller_type NOT IN ('RESTAURANT', 'CAFE')
        WHERE v.product_id = m.product_id
          AND v.status = 'ACTIVE'
          AND v.deleted_at IS NULL
          ${
            query.inStockOnly
              ? Prisma.sql`AND sl.is_available AND (sl.stock_qty - sl.reserved_qty) > 0`
              : Prisma.empty
          }
      )
      ${query.afterRank != null ? Prisma.sql`AND m.rank < ${query.afterRank}` : Prisma.empty}
      ORDER BY m.rank DESC, m.product_id ASC
      LIMIT ${query.limit}`;

    return rows.map((row) => ({ productId: row.product_id, rank: Number(row.rank) }));
  }
}

/** Applied per connection; cheap and idempotent. */
export async function configureSearchThresholds(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `SET pg_trgm.word_similarity_threshold = ${WORD_SIMILARITY_THRESHOLD}`,
    );
  } catch (error) {
    log.warn({ err: error }, 'could not set trigram threshold — using the default');
  }
}

export const search: SearchProvider = new PostgresSearchProvider();

log.info({ provider: env.SEARCH_PROVIDER }, 'search provider initialised');
