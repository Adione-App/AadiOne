/**
 * Smart Search — the one search engine every Aadione panel uses.
 *
 *   shared/search-text.ts        normalisation, Hindi -> Roman, phonetic key
 *   shared/search-dictionary.ts  English / Hinglish / Hindi synonym groups
 *   shared/search-match.ts       term generation, query analysis, tiers;
 *                                `smartSearch` for in-memory lists (web, app)
 *   infra/search/indexer.ts      product_search_terms maintenance
 *   infra/search/engine.ts       ranked SQL search over the index
 *   catalog/product-search-scope.ts  who may see which products (callers)
 *
 * PostgreSQL only (pg_trgm, already installed by v2_product_search); no
 * external search service and no per-request translation API. SEARCH_PROVIDER
 * stays "postgres" — the engine is the port a dedicated service could
 * replace later without touching the callers.
 */

export { searchProductIds, matchProductIds, type ProductSearchHit, type ProductSearchRequest } from './engine';
export {
  REINDEX_BATCH_SIZE,
  countStaleProducts,
  installSearchIndexHook,
  productSearchFields,
  reindexProducts,
  reindexStaleBatch,
  reindexStaleProducts,
  requestSearchReindex,
  setAutoReindex,
  type ReindexResult,
} from './indexer';
