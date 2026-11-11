-- Seller settlement payment proof (screenshot / receipt) — additive only.
--
-- The transaction / UPI reference already exists (payout_reference). These
-- columns hold an OPTIONAL proof file the admin attaches when recording a
-- manual payout. The file itself lives in PRIVATE storage (storage-private/ or
-- the S3 private bucket) under a server-generated key; nothing here changes
-- any amount, status or rule of a settlement.

ALTER TABLE "seller_settlements"
  ADD COLUMN "payout_proof_key" VARCHAR(255),
  ADD COLUMN "payout_proof_content_type" VARCHAR(40),
  ADD COLUMN "payout_proof_uploaded_at" TIMESTAMPTZ(3);
