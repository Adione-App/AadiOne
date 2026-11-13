-- 20261112120000_v2_legal_acceptances
--
-- legal_acceptances: one row each time a signed-in user explicitly accepts a
-- published legal document that asks for acceptance — today the Seller Terms
-- and the Seller Privacy Policy, accepted in the Seller Panel. (Customers'
-- acceptance of the Privacy Policy and Terms stays in legal_consents.)
--
-- Append-only history: rows are never updated or overwritten. Records the
-- document key, the published version (revision) and its content_documents
-- row, the seller account it was accepted for, the server's timestamp, the
-- platform and app version — no IP address, device id or other data.
--
-- Additive only: no existing column, row or rule changes.

BEGIN;

CREATE TABLE "legal_acceptances" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "seller_id" UUID,
  "document_key" VARCHAR(60) NOT NULL,
  "revision" INTEGER NOT NULL,
  "document_id" UUID NOT NULL,
  "source" VARCHAR(16) NOT NULL,
  "app_version" VARCHAR(20),
  "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_acceptances_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "legal_acceptances_source_check" CHECK ("source" IN ('ANDROID', 'IOS', 'WEB'))
);

CREATE INDEX "legal_acceptances_user_id_document_key_accepted_at_idx" ON "legal_acceptances" ("user_id", "document_key", "accepted_at");

ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The accepted text is never deleted while an acceptance points at it.
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "content_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Supabase Data API: deny-all, like every other table
-- (20261021120000_v2_lock_down_supabase_data_api).
-- -----------------------------------------------------------------------------

ALTER TABLE "legal_acceptances" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.legal_acceptances FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
