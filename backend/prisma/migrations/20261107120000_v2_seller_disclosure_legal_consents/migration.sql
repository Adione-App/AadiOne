-- =============================================================================
-- V2 Seller disclosures + legal consent records
-- =============================================================================
--
-- 1. sellers.customer_care_phone / customer_care_email
--    The Consumer Protection (E-Commerce) Rules, 2020 require a marketplace to
--    show customers each seller's business name, geographic address and a
--    customer-care contact. `sellers.phone` is filled from the OWNER'S
--    personal mobile at sign-up, so it is never shown to customers. These
--    two optional columns hold the contact a seller (or an admin) chooses to
--    publish; while empty, customers see no seller contact and the admin
--    panel warns.
--
-- 2. legal_consents
--    One row each time a signed-in customer accepts the published Privacy
--    Policy and Terms (explicit action in the app — never inferred from a
--    sign-in). Append-only history: rows are never updated or overwritten.
--    Records the published versions accepted, the server's timestamp, the
--    platform and app version — no IP address, device id or other data.
--
-- Additive only: no existing column, row or rule changes.

BEGIN;

ALTER TABLE "sellers" ADD COLUMN "customer_care_phone" VARCHAR(15);
ALTER TABLE "sellers" ADD COLUMN "customer_care_email" VARCHAR(160);

CREATE TABLE "legal_consents" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "privacy_version" INTEGER NOT NULL,
  "terms_version" INTEGER NOT NULL,
  "privacy_document_id" UUID,
  "terms_document_id" UUID,
  "source" VARCHAR(16) NOT NULL,
  "app_version" VARCHAR(20),
  "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "legal_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_consents_versions_check" CHECK ("privacy_version" > 0 AND "terms_version" > 0),
  CONSTRAINT "legal_consents_source_check" CHECK ("source" IN ('ANDROID', 'IOS', 'WEB'))
);

CREATE INDEX "legal_consents_user_id_accepted_at_idx" ON "legal_consents" ("user_id", "accepted_at");

ALTER TABLE "legal_consents"
  ADD CONSTRAINT "legal_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Supabase Data API: deny-all, like every other table
-- (20261021120000_v2_lock_down_supabase_data_api).
-- -----------------------------------------------------------------------------

ALTER TABLE "legal_consents" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.legal_consents FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
