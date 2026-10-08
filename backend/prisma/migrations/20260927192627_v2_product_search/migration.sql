-- =============================================================================
-- V2 product search
-- =============================================================================
--
-- WHY: `GET /products/search` runs PostgreSQL full-text search over
-- `products.search_vector` plus pg_trgm typo matching (`word_similarity`,
-- `<%`) — see src/infra/search/index.ts. The V2 baseline migration was
-- generated from schema.prisma alone, so none of V1's hand-written search
-- objects (they lived only in V1's `hardening` migration, never in the Prisma
-- schema) exist in V2: no extension, no column, no trigger, no indexes — and
-- every search request failed with `column p.search_vector does not exist`.
--
-- WHAT:
--   * `products.search_vector` and the three GIN indexes are now DECLARED in
--     schema.prisma (Unsupported("tsvector") + @@index type: Gin) — the
--     statements marked (generated) below are exactly what
--     `prisma migrate diff` produced for that schema change.
--   * The extension, trigger function, trigger and backfill cannot be
--     expressed in Prisma, so they are hand-written here.
--
-- Wrapped in one transaction: Prisma Migrate does not add one itself, and a
-- half-applied search setup (column without trigger) would silently index
-- nothing.
-- =============================================================================

BEGIN;

-- Trigram operators: word_similarity(), `<%`, gin_trgm_ops. IF NOT EXISTS keeps
-- this a no-op where the extension is already installed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- (generated) AlterTable
ALTER TABLE "products" ADD COLUMN     "search_vector" tsvector;

-- 'simple' rather than 'english': the corpus is brand names and Hindi
-- transliterations ("Aashirvaad", "atta", "namkeen") that English stemming
-- mangles. Typo tolerance comes from the trigram indexes instead.
CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."search_vector" :=
      setweight(to_tsvector('simple', coalesce(NEW."name", '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW."name_hi", '')), 'A')
    || setweight(
         to_tsvector(
           'simple',
           array_to_string(coalesce(NEW."search_keywords", ARRAY[]::text[]), ' ')
         ),
         'B'
       )
    || setweight(to_tsvector('simple', coalesce(NEW."description", '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_vector_trigger
  BEFORE INSERT OR UPDATE OF "name", "name_hi", "search_keywords", "description"
  ON "products"
  FOR EACH ROW
  EXECUTE FUNCTION products_search_vector_update();

-- Backfill rows that already exist: re-assigning `name` fires the trigger
-- above, so the vector is built by the one function, not a second copy of
-- its expression. No other column changes (updated_at is app-maintained).
UPDATE "products" SET "name" = "name";

-- (generated) CreateIndex
CREATE INDEX "brands_name_trgm_idx" ON "brands" USING GIN ("name" gin_trgm_ops);

-- (generated) CreateIndex
CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("search_vector");

-- (generated) CreateIndex
CREATE INDEX "products_name_trgm_idx" ON "products" USING GIN ("name" gin_trgm_ops);

COMMIT;
