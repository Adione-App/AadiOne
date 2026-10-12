-- Parent product code for bulk import / export of products with several
-- variants (sizes, colours): rows that share a parent_sku become ONE product,
-- and a later import finds that product by it.
--
-- ADDITIVE ONLY: one nullable column, no default, no backfill (existing
-- products keep NULL), and one partial unique index. Nothing else changes.

-- AlterTable
ALTER TABLE "products" ADD COLUMN "parent_sku" VARCHAR(60);

-- A seller cannot give two of its live products the same parent code; a
-- removed (soft-deleted) product frees its code. Codes are stored upper-cased.
CREATE UNIQUE INDEX "products_seller_parent_sku_unique"
  ON "products" ("submitted_by_seller_id", "parent_sku")
  WHERE "parent_sku" IS NOT NULL AND "deleted_at" IS NULL;
