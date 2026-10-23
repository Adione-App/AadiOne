-- V2: admin storefront content documents (Home Page Builder, category display).
--
-- One new table, content_documents: per key ("home_layout" today) at most
-- ONE draft and ONE published row, plus archived earlier revisions that stay
-- restorable. Customers only ever read the published row.
--
-- Additive: a new enum, a new table and its indexes. No existing table,
-- column or row is touched. ROLLBACK (nothing else depends on it):
--   DROP TABLE public.content_documents; DROP TYPE "ContentDocumentStatus";

-- CreateEnum
CREATE TYPE "ContentDocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "content_documents" (
    "id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "status" "ContentDocumentStatus" NOT NULL,
    "revision" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "updated_by_user_id" UUID,
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_documents_pkey" PRIMARY KEY ("id"),
    -- Keys are slugs, like banner placements.
    CONSTRAINT "content_documents_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_]*$'),
    -- A draft records the revision it started from (0 = none yet); a published or archived row its own (1, 2, …).
    CONSTRAINT "content_documents_revision_valid" CHECK (
      ("status" = 'DRAFT' AND "revision" >= 0) OR ("status" <> 'DRAFT' AND "revision" >= 1)
    ),
    -- Only published (and later archived) rows carry a publication time.
    CONSTRAINT "content_documents_published_at_valid" CHECK (("status" = 'DRAFT') = ("published_at" IS NULL)),
    -- The document is always a JSON object.
    CONSTRAINT "content_documents_content_object" CHECK (jsonb_typeof("content") = 'object')
);

-- CreateIndex
CREATE INDEX "content_documents_key_status_revision_idx" ON "content_documents"("key", "status", "revision");

-- At most one draft and one published row per key (Prisma cannot express partial unique indexes).
CREATE UNIQUE INDEX "content_documents_one_draft_per_key" ON "content_documents"("key") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "content_documents_one_published_per_key" ON "content_documents"("key") WHERE "status" = 'PUBLISHED';
-- A revision number is used once per key.
CREATE UNIQUE INDEX "content_documents_key_revision_published" ON "content_documents"("key", "revision") WHERE "status" <> 'DRAFT';

-- Supabase Data API lock-down (see 20261021120000): every public table has
-- Row-Level Security on, and the anon / authenticated roles hold nothing.
-- The backend owns the table, so RLS does not restrict it.
ALTER TABLE "content_documents" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.content_documents FROM %I', r);
    END IF;
  END LOOP;
END $$;
