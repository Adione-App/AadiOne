-- =============================================================================
-- V2 Smart Search
-- =============================================================================
--
-- WHY: search matched only what a product's own text literally contained
-- (full-text + trigram on the English name), so "kela" never found
-- "Banana (केला)" unless someone had typed that keyword by hand, Hindi
-- queries only matched Hindi names, and every admin / seller screen used its
-- own exact `contains`. Smart Search indexes each product once, in every form
-- a person might type it, and every panel queries that one index
-- (src/infra/search, src/shared/search-*.ts).
--
-- WHAT:
--   * product_search_terms — one row per distinct normalised term of a
--     product (name, words, Hindi, transliteration, keywords, brand,
--     category, dictionary synonyms) with its phonetic key. Derived data,
--     rebuilt by the application indexer; FK ON DELETE CASCADE so a deleted
--     product can never leave terms behind; PK (product_id, term) so a term
--     can never be stored twice for one product.
--   * products.search_index_stale — the indexer's work queue. DB triggers
--     set it in the SAME transaction as any change to the searchable text
--     (name, name_hi, search_keywords, brand_id, category_id, deleted_at) and
--     when a product's brand or category is renamed, so no write path — API,
--     bulk import, script or psql — can leave terms silently out of date.
--     Search ignores a stale product's old terms and matches its live name
--     until the indexer has rebuilt them (seconds; a sweep job retries).
--   * Existing rows: the column defaults to TRUE, so every existing product
--     starts stale (still searchable through the live-name fallback) until
--     `npm run search:backfill:v2` — or the app's own sweep — indexes it.
--
-- Additive only: no existing column, index or row is changed or dropped.
-- No extension is added: pg_trgm already exists (v2_product_search); all
-- normalisation / transliteration runs in the application, so `unaccent` is
-- not needed.
--
-- ROLLBACK (data-safe; the table is derived):
--   DROP TRIGGER products_search_stale_insert ON products;
--   DROP TRIGGER products_search_stale_update ON products;
--   DROP TRIGGER categories_search_stale ON categories;
--   DROP TRIGGER brands_search_stale ON brands;
--   DROP FUNCTION products_mark_search_stale(), categories_mark_products_search_stale(),
--                 brands_mark_products_search_stale();
--   DROP TABLE product_search_terms;
--   DROP INDEX products_search_index_stale_idx;
--   ALTER TABLE products DROP COLUMN search_index_stale;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261106120000_v2_smart_search';
-- =============================================================================

BEGIN;

-- Adding the column / triggers takes a brief exclusive lock on products,
-- categories and brands. Fail (changing nothing) rather than queue live
-- traffic behind a long-running query; re-run when it is quiet.
SET LOCAL lock_timeout = '5s';

-- (generated) AlterTable — constant default: metadata-only, no table rewrite.
ALTER TABLE "products" ADD COLUMN     "search_index_stale" BOOLEAN NOT NULL DEFAULT true;

-- (generated) CreateTable
CREATE TABLE "product_search_terms" (
    "product_id" UUID NOT NULL,
    "term" VARCHAR(160) NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "weight" SMALLINT NOT NULL,

    CONSTRAINT "product_search_terms_pkey" PRIMARY KEY ("product_id","term")
);

-- (generated) CreateIndex
CREATE INDEX "product_search_terms_term_idx" ON "product_search_terms"("term");

-- (generated) CreateIndex
CREATE INDEX "product_search_terms_key_idx" ON "product_search_terms"("key");

-- (generated) CreateIndex
CREATE INDEX "product_search_terms_term_trgm_idx" ON "product_search_terms" USING GIN ("term" gin_trgm_ops);

-- (generated) CreateIndex
CREATE INDEX "product_search_terms_key_trgm_idx" ON "product_search_terms" USING GIN ("key" gin_trgm_ops);

-- (generated) AddForeignKey
ALTER TABLE "product_search_terms" ADD CONSTRAINT "product_search_terms_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the sources the ranking knows (shared/search-match.ts SearchTermSource).
ALTER TABLE "product_search_terms" ADD CONSTRAINT "product_search_terms_source_check" CHECK (
  "source" IN ('NAME', 'NAME_ALT', 'NAME_TOKEN', 'NAME_HI', 'NAME_SYNONYM', 'KEYWORD', 'BRAND', 'SYNONYM', 'TRANSLIT', 'CATEGORY')
);
ALTER TABLE "product_search_terms" ADD CONSTRAINT "product_search_terms_term_not_blank" CHECK (length(btrim("term")) > 0);

-- The work queue: tiny once the backfill has run (only products edited in
-- the last few seconds), so the sweep and the live-name fallback stay cheap.
CREATE INDEX "products_search_index_stale_idx" ON "products" ("id") WHERE "search_index_stale";

-- -----------------------------------------------------------------------------
-- Stale marking
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION products_mark_search_stale() RETURNS trigger AS $$
BEGIN
  NEW."search_index_stale" := true;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_stale_insert
  BEFORE INSERT ON "products"
  FOR EACH ROW
  EXECUTE FUNCTION products_mark_search_stale();

-- Only a real change of searchable text: an update that rewrites the same
-- name (Prisma sends whole objects in places) does not requeue the product.
CREATE TRIGGER products_search_stale_update
  BEFORE UPDATE OF "name", "name_hi", "search_keywords", "brand_id", "category_id", "deleted_at" ON "products"
  FOR EACH ROW
  WHEN (
       OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."name_hi" IS DISTINCT FROM NEW."name_hi"
    OR OLD."search_keywords" IS DISTINCT FROM NEW."search_keywords"
    OR OLD."brand_id" IS DISTINCT FROM NEW."brand_id"
    OR OLD."category_id" IS DISTINCT FROM NEW."category_id"
    OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"
  )
  EXECUTE FUNCTION products_mark_search_stale();

-- A product's terms include its category's and that category's parent's
-- names, so renaming (or moving) a category requeues the products directly
-- in it and in its direct subcategories.
CREATE OR REPLACE FUNCTION categories_mark_products_search_stale() RETURNS trigger AS $$
BEGIN
  UPDATE "products" p
     SET "search_index_stale" = true
   WHERE NOT p."search_index_stale"
     AND p."category_id" IN (
       SELECT c."id" FROM "categories" c WHERE c."id" = NEW."id" OR c."parent_id" = NEW."id"
     );
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER categories_search_stale
  AFTER UPDATE OF "name", "name_hi", "parent_id" ON "categories"
  FOR EACH ROW
  WHEN (
       OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."name_hi" IS DISTINCT FROM NEW."name_hi"
    OR OLD."parent_id" IS DISTINCT FROM NEW."parent_id"
  )
  EXECUTE FUNCTION categories_mark_products_search_stale();

CREATE OR REPLACE FUNCTION brands_mark_products_search_stale() RETURNS trigger AS $$
BEGIN
  UPDATE "products" p
     SET "search_index_stale" = true
   WHERE NOT p."search_index_stale" AND p."brand_id" = NEW."id";
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER brands_search_stale
  AFTER UPDATE OF "name" ON "brands"
  FOR EACH ROW
  WHEN (OLD."name" IS DISTINCT FROM NEW."name")
  EXECUTE FUNCTION brands_mark_products_search_stale();

-- -----------------------------------------------------------------------------
-- Supabase Data API: deny-all, like every other table
-- (20261021120000_v2_lock_down_supabase_data_api).
-- -----------------------------------------------------------------------------

ALTER TABLE "product_search_terms" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.product_search_terms FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.products_mark_search_stale() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.categories_mark_products_search_stale() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.brands_mark_products_search_stale() FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
