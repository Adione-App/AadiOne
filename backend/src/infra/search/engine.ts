/**
 * Smart Search engine — ranked product search over `product_search_terms`.
 *
 * The SQL twin of shared/search-match.ts: the query is analysed in
 * TypeScript (`analyzeSearchQuery`: words, phonetic keys, dictionary
 * synonyms, prefixes, typo keys), shipped as one parameter array of probes,
 * and matched against the indexed terms with the same tier rules as
 * `matchTier` — so the in-memory matcher and this engine agree on what
 * matches and in what order.
 *
 * Every value is a bound parameter (Prisma.sql); nothing from the query is
 * ever spliced into SQL text.
 *
 * What the engine does NOT decide: who may see a product. Every caller passes
 * a `where` predicate over `products p` (catalog/product-search-scope.ts) —
 * the customer's visibility rules, a seller's own products, the admin's
 * filters — and it is applied to every candidate, indexed or stale.
 *
 * Index use (EXPLAIN-checked, docs: SMART-SEARCH-IMPLEMENTATION.md):
 *   term = ANY(...)        product_search_terms_term_idx (btree)
 *   key  = ANY(...)        product_search_terms_key_idx (btree)
 *   term LIKE 'ban%' / '%anan%'   product_search_terms_term_trgm_idx (GIN)
 *   key  LIKE 'tam%', key % 'bana' product_search_terms_key_trgm_idx (GIN)
 *   stale fallback         products_search_index_stale_idx (partial)
 * Both CTEs are MATERIALIZED: inlined, the planner re-ran the candidate
 * index scan once per probe (EXPLAIN: loops=31, ~650 ms for "moong dal").
 * The trigram `%` operator only pre-filters at pg_trgm's default 0.3; the
 * real threshold is applied as `similarity() >= minsim`, so nothing depends
 * on a per-session `SET` (which a transaction pooler would not keep).
 */

import { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../db/prisma';
import {
  SEARCH_SOURCE_RULES,
  SEARCH_TIER,
  analyzeSearchQuery,
  coverageBonus,
  isSignificantToken,
  unitScore,
  type AnalyzedSearchQuery,
  type SearchProbe,
} from '../../shared/search-match';

export interface ProductSearchHit {
  productId: string;
  /** Higher is better; the thousands digit is the tier (8 exact name … 1 fuzzy). */
  rank: number;
  tier: number;
  /** With `priority`: 1 when the product meets it (listed first), else 0. Without: always 1. */
  priority: number;
}

export interface ProductSearchRequest {
  /** Raw text, or a query already analysed by the caller. */
  query: string | AnalyzedSearchQuery;
  /**
   * REQUIRED predicate over `products p`: visibility / ownership / filters.
   * Use Prisma.sql`TRUE` only where every product may be seen (admin).
   */
  where: Prisma.Sql;
  limit: number;
  /**
   * Optional predicate over `products p` that ranks ABOVE relevance: every
   * product meeting it comes before every product that does not, each group
   * best match first (customer search: in stock first, out of stock last).
   * Absent: one group — relevance only (admin / seller searches, unchanged).
   */
  priority?: Prisma.Sql;
  /** Keyset cursor: the last hit of the previous page (`priority` absent = 1). */
  after?: { rank: number; productId: string; priority?: number | null } | null;
}

/** Score of an exact match of the product's own name — always the top band. */
const EXACT_NAME_RANK = unitScore(SEARCH_TIER.EXACT_NAME, 100, 1) + coverageBonus(1);
/** A not-yet-indexed product matched by its live name: PARTIAL band. */
const STALE_BASE_RANK = SEARCH_TIER.PARTIAL * 1000;

/**
 * A CODE constant (probe kind, source name) as an SQL literal — never user
 * input; checked against a strict pattern. Bound parameters would hide these
 * from the planner: a cached generic plan for "moong dal" ran ~800 ms instead
 * of ~250 ms. Everything derived from the query stays a bound parameter.
 */
function sqlLiteral(constant: string): Prisma.Sql {
  if (!/^[A-Za-z_]+$/.test(constant)) throw new Error(`not a code constant: ${constant}`);
  return Prisma.raw(`'${constant}'`);
}

/** `LEAST(probe tier, source cap)`, generated from SEARCH_SOURCE_RULES so SQL and TS cannot drift. */
function tierCapSql(): Prisma.Sql {
  const cases = Object.entries(SEARCH_SOURCE_RULES)
    .filter(([source]) => source !== 'CATEGORY')
    .map(([source, rule]) => Prisma.sql`WHEN c.source = ${sqlLiteral(source)} THEN ${Prisma.raw(String(rule.cap))}`);
  return Prisma.sql`CASE
      WHEN c.source = 'CATEGORY' AND pr.kind IN ('prefix', 'keyprefix', 'fuzzy') THEN 1
      WHEN c.source = 'CATEGORY' THEN ${Prisma.raw(String(SEARCH_SOURCE_RULES.CATEGORY.cap))}
      ${Prisma.join(cases, ' ')}
      ELSE ${Prisma.raw(String(SEARCH_TIER.EXACT_ALIAS))} END`;
}

/**
 * The candidate term rows: a UNION of one single-condition lookup per probe,
 * each served by its own index. Not one OR of every condition — with
 * prepared statements PostgreSQL switches to a generic plan after five runs,
 * and for an OR it cannot estimate without the values that plan was a
 * parallel seq scan evaluating every condition on every row (~550 ms of an
 * 800 ms "moong dal"). A single `=` / `LIKE` / `%` per branch keeps the index
 * in the generic plan too. UNION also removes duplicate rows.
 */
function candidateRowsSql(probes: readonly SearchProbe[]): Prisma.Sql {
  const termValues = [...new Set(probes.filter((p) => p.kind === 'term').map((p) => p.value))];
  const keyValues = [...new Set(probes.filter((p) => p.kind === 'key' || p.kind === 'syn').map((p) => p.value))];
  const columns = Prisma.sql`SELECT t.product_id, t.term, t.key, t.source, t.weight FROM product_search_terms t WHERE`;
  const branches: Prisma.Sql[] = [];
  if (termValues.length > 0) branches.push(Prisma.sql`${columns} t.term = ANY(${termValues}::varchar[])`);
  if (keyValues.length > 0) branches.push(Prisma.sql`${columns} t.key = ANY(${keyValues}::varchar[])`);
  // Values are normalised to [a-z0-9 Devanagari], so they hold no LIKE
  // wildcard; they are still escaped in case that ever changes.
  const like = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
  const seen = new Set<string>();
  for (const probe of probes) {
    let branch: Prisma.Sql | null = null;
    let signature = '';
    switch (probe.kind) {
      case 'prefix':
      case 'nameprefix':
        signature = `tp:${probe.value}`;
        branch = Prisma.sql`${columns} t.term LIKE ${`${like(probe.value)}%`}`;
        break;
      case 'keyprefix':
        signature = `kp:${probe.value}`;
        branch = Prisma.sql`${columns} t.key LIKE ${`${like(probe.value)}%`}`;
        break;
      case 'partial':
        signature = `pa:${probe.value}`;
        branch = Prisma.sql`${columns} t.term LIKE ${`%${like(probe.value)}%`}`;
        break;
      case 'fuzzy':
        signature = `fz:${probe.value}`;
        branch = Prisma.sql`${columns} t.key % ${probe.value}`;
        break;
      default:
        break;
    }
    if (branch && !seen.has(signature)) {
      seen.add(signature);
      branches.push(branch);
    }
  }
  return branches.length > 0
    ? Prisma.join(branches, ' UNION ')
    : Prisma.sql`SELECT t.product_id, t.term, t.key, t.source, t.weight FROM product_search_terms t WHERE FALSE`;
}

/** A not-yet-indexed product's live text: every significant word must appear in it. */
function staleFilterSql(query: AnalyzedSearchQuery): Prisma.Sql {
  const words = query.tokens.filter((token) => token.length >= 2);
  if (words.length === 0) return Prisma.sql`FALSE`;
  const text = Prisma.sql`lower(p.name || ' ' || coalesce(p.name_hi, '') || ' ' || array_to_string(coalesce(p.search_keywords, ARRAY[]::text[]), ' '))`;
  const contains = Prisma.join(
    words.map((word) => Prisma.sql`strpos(${text}, ${word}) > 0`),
    ' AND ',
  );
  return Prisma.sql`((${contains}) OR word_similarity(${query.normalized}, lower(p.name)) >= 0.5)`;
}

/**
 * Every (candidate term, probe) match with its tier and similarity — one
 * join per probe kind, UNION ALL: equality kinds hash-join, and only the
 * prefix / partial / fuzzy probes are compared row by row. (One join with an
 * OR of all seven conditions evaluated every pair: ~190 ms of a 230 ms
 * "moong dal" on 5,000 products.)
 */
function scoredSql(): Prisma.Sql {
  const select = (similarity: Prisma.Sql) =>
    Prisma.sql`SELECT c.product_id, pr.unit, LEAST(pr.tier, ${tierCapSql()}) AS tier, c.weight, ${similarity} AS sim`;
  const kind = (name: SearchProbe['kind']) => Prisma.sql`(SELECT * FROM probe WHERE kind = ${sqlLiteral(name)})`;
  const branches = [
    Prisma.sql`${select(Prisma.sql`1.0::float8`)} FROM cand c JOIN ${kind('term')} pr ON c.term = pr.val`,
    Prisma.sql`${select(Prisma.sql`(CASE pr.kind WHEN 'key' THEN 0.95 ELSE 0.9 END)::float8`)}
      FROM cand c JOIN (SELECT * FROM probe WHERE kind IN ('key', 'syn')) pr ON c.key = pr.val`,
    Prisma.sql`${select(Prisma.sql`length(pr.val)::float8 / GREATEST(length(c.term), 1)`)}
      FROM cand c JOIN ${kind('prefix')} pr ON left(c.term, length(pr.val)) = pr.val`,
    Prisma.sql`${select(Prisma.sql`0.9 * length(pr.val)::float8 / GREATEST(length(c.key), 1)`)}
      FROM cand c JOIN ${kind('keyprefix')} pr ON left(c.key, length(pr.val)) = pr.val`,
    Prisma.sql`${select(Prisma.sql`0.5::float8`)}
      FROM cand c JOIN ${kind('nameprefix')} pr ON c.source IN ('NAME', 'NAME_TOKEN') AND left(c.term, length(pr.val)) = pr.val`,
    Prisma.sql`${select(Prisma.sql`length(pr.val)::float8 / GREATEST(length(c.term), 1)`)}
      FROM cand c JOIN ${kind('partial')} pr ON c.source <> 'CATEGORY' AND strpos(c.term, pr.val) > 0`,
    Prisma.sql`${select(Prisma.sql`similarity(pr.val, c.key)::float8`)}
      FROM cand c JOIN ${kind('fuzzy')} pr ON similarity(pr.val, c.key) >= pr.minsim`,
  ];
  return Prisma.join(branches, ' UNION ALL ');
}

/**
 * Ranked product ids matching `query` among the products `where` allows,
 * best first, deduplicated by product, keyset-paginated on (rank, id).
 */
export async function searchProductIds(request: ProductSearchRequest, client: DbClient = prisma): Promise<ProductSearchHit[]> {
  const query = typeof request.query === 'string' ? analyzeSearchQuery(request.query) : request.query;
  if (!query.searchable || request.limit <= 0) return [];

  const probes = query.probes;
  const significantUnits = query.tokens.flatMap((token, index) => (isSignificantToken(token) ? [index] : []));
  const singleToken = query.tokens.length === 1;
  const minSignificant = Math.ceil(query.significantTokens / 2);

  // The per-product rank: the best indexed / stale score, lifted to the
  // EXACT_NAME band when the name is exactly what was typed, plus a
  // popularity tie-break far smaller than any score step. Used by both the
  // SELECT and the keyset HAVING, so the two can never disagree.
  const rankSql = Prisma.sql`(GREATEST(MAX(r.rank), CASE WHEN lower(btrim(p.name)) = ${query.rawLower} THEN ${EXACT_NAME_RANK}::float8 ELSE 0 END)
    + LEAST(GREATEST(p.popularity_score, 0), 1000000)::float8 / 100000000.0)`;

  // The priority group (1 / 0) — a constant 1 without a priority predicate.
  const prioritySql = request.priority ? Prisma.sql`(CASE WHEN ${request.priority} THEN 1 ELSE 0 END)` : Prisma.sql`1`;
  const afterPriority = request.after?.priority === 0 ? 0 : 1;
  const after = request.after
    ? request.priority
      ? Prisma.sql`HAVING (${prioritySql} < ${afterPriority}
          OR (${prioritySql} = ${afterPriority} AND (${rankSql} < ${request.after.rank}::float8
            OR (${rankSql} = ${request.after.rank}::float8 AND r.product_id > ${request.after.productId}::uuid))))`
      : Prisma.sql`HAVING (${rankSql} < ${request.after.rank}::float8
          OR (${rankSql} = ${request.after.rank}::float8 AND r.product_id > ${request.after.productId}::uuid))`
    : Prisma.empty;

  const rows = await client.$queryRaw<{ product_id: string; rank: number; priority: number }[]>`
    WITH probe AS MATERIALIZED (
      SELECT * FROM unnest(
        ${probes.map((p) => p.unit)}::int[],
        ${probes.map((p) => p.kind)}::text[],
        ${probes.map((p) => p.value)}::text[],
        ${probes.map((p) => p.tier)}::int[],
        ${probes.map((p) => p.minSimilarity)}::float8[]
      ) AS pr(unit, kind, val, tier, minsim)
    ),
    cand AS MATERIALIZED (
      SELECT t.product_id, t.term, t.key, t.source, t.weight
      FROM (${candidateRowsSql(probes)}) t
      JOIN products sp ON sp.id = t.product_id AND NOT sp.search_index_stale
    ),
    scored AS (
      ${scoredSql()}
    ),
    per_unit AS (
      SELECT product_id, unit, MAX(tier * 1000 + weight * 4 + LEAST(sim, 1.0) * 100) AS score
      FROM scored
      WHERE tier > 0
      GROUP BY product_id, unit
    ),
    per_product AS (
      SELECT product_id,
        MAX(score) AS best,
        bool_or(unit = -1 OR (${singleToken} AND unit = 0)) AS whole,
        COUNT(*) FILTER (WHERE unit = ANY(${significantUnits}::int[])) AS matched_significant
      FROM per_unit
      GROUP BY product_id
    ),
    ranked AS (
      SELECT product_id,
        best + 400 * (CASE
          WHEN whole OR ${query.significantTokens}::int = 0 THEN 1.0
          ELSE matched_significant::float8 / ${query.significantTokens}::int
        END) AS rank
      FROM per_product
      WHERE whole OR ${query.significantTokens}::int = 0 OR matched_significant >= ${minSignificant}::int
      UNION ALL
      SELECT p.id AS product_id,
        ${STALE_BASE_RANK}::float8 + 100 * word_similarity(${query.normalized}, lower(p.name)) AS rank
      FROM products p
      WHERE p.search_index_stale AND ${staleFilterSql(query)}
    )
    SELECT r.product_id, ${rankSql} AS rank, ${prioritySql} AS priority
    FROM ranked r
    JOIN products p ON p.id = r.product_id
    WHERE ${request.where}
    GROUP BY r.product_id, p.id, p.name, p.popularity_score
    ${after}
    ORDER BY priority DESC, rank DESC, r.product_id ASC
    LIMIT ${request.limit}`;

  return rows.map((row) => {
    const rank = Number(row.rank);
    return { productId: row.product_id, rank, tier: Math.min(SEARCH_TIER.EXACT_NAME, Math.floor(rank / 1000)), priority: Number(row.priority) };
  });
}

/**
 * Up to `cap` ranked matches as a map — for lists that keep their own
 * pagination and sort (admin products, inventory, orders by item).
 */
export async function matchProductIds(
  query: string | AnalyzedSearchQuery,
  where: Prisma.Sql,
  cap = 500,
  client: DbClient = prisma,
): Promise<Map<string, number>> {
  const hits = await searchProductIds({ query, where, limit: cap }, client);
  return new Map(hits.map((hit) => [hit.productId, hit.rank]));
}

