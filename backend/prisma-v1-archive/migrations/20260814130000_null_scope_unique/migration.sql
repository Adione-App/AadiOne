-- =============================================================================
-- NULL-scope uniqueness
--
-- PROBLEM
-- Two tables use a nullable column as part of a "unique within scope" key:
--
--   configurations (key, store_id)   store_id NULL = global setting
--   categories     (parent_id, slug) parent_id NULL = root category
--
-- A plain composite UNIQUE does NOT constrain those rows, because SQL treats
-- NULL as distinct from every value including another NULL. `UNIQUE (key,
-- store_id)` therefore happily accepts ten rows with key='MAX_SERVICE_RADIUS_KM'
-- and store_id=NULL, and the application would silently read whichever one the
-- planner returned first.
--
-- FIX
-- A partial unique index over the NULL case. Together with the existing
-- composite unique (which covers the non-NULL case) this gives genuine
-- "unique within scope" semantics.
--
-- Prisma cannot express partial indexes, and it also cannot target this index
-- in `upsert()` — so the configuration and category repositories implement
-- their upserts as an explicit find-then-write for the NULL-scope case.
-- =============================================================================

-- Exactly one global row per configuration key.
CREATE UNIQUE INDEX "configurations_global_key_unique"
  ON "configurations" ("key")
  WHERE "store_id" IS NULL;

-- Exactly one root category per slug.
CREATE UNIQUE INDEX "categories_root_slug_unique"
  ON "categories" ("slug")
  WHERE "parent_id" IS NULL AND "deleted_at" IS NULL;

-- NOTE on orders(user_id, idempotency_key): the same NULL-distinct behaviour
-- applies there, and there it is exactly what we want. Orders placed without
-- an idempotency key must not collide with each other, while two requests that
-- DO carry the same key are correctly rejected as duplicates.
