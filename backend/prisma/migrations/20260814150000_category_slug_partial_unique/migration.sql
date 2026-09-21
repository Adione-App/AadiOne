-- =============================================================================
-- Subcategory slug uniqueness must exclude soft-deleted rows
--
-- PROBLEM
-- `categories_parent_id_slug_key` (from schema.prisma's @@unique([parentId,
-- slug])) is a PLAIN composite unique index — it has no `deleted_at IS NULL`
-- filter. Category deletion is a soft delete (admin-catalog.service.ts sets
-- deletedAt, never a real DELETE), so a deleted subcategory's row is still
-- there, still holding its (parent_id, slug) pair. Re-creating a category
-- with the same name under the same parent then hits a genuine Postgres
-- unique-violation on the INSERT (Prisma error P2002) — the app-level
-- duplicate check in createCategory already correctly filters `deletedAt:
-- null` and finds nothing, so it falls through to the INSERT, which is what
-- actually fails. Surfaces to the admin as the generic "This already
-- exists." even though the category list correctly shows it as gone.
--
-- Root categories (parent_id IS NULL) don't have this problem:
-- categories_root_slug_unique (see the null_scope_unique migration) already
-- has a `deleted_at IS NULL` filter. This migration brings the non-root case
-- in line with that.
--
-- FIX
-- Replace the plain index with a partial one scoped to live, non-root rows.
-- Reusing the same index name keeps this a drop-in replacement — nothing
-- else references the index by name.
-- =============================================================================

DROP INDEX "categories_parent_id_slug_key";

CREATE UNIQUE INDEX "categories_parent_id_slug_key"
  ON "categories" ("parent_id", "slug")
  WHERE "parent_id" IS NOT NULL AND "deleted_at" IS NULL;
