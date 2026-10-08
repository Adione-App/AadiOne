-- =============================================================================
-- V2 seller documents: direct PDF uploads + document numbers
-- =============================================================================
--
-- Documents are now uploaded as PDF files into PRIVATE storage (file_key) and
-- carry the number printed on them (document_number). The old free-text link
-- (file_url) becomes optional: existing rows keep their link untouched as a
-- legacy record; new uploads never set it. Every row must still point at
-- something — an uploaded file or a legacy link.

ALTER TABLE "seller_documents" ALTER COLUMN "file_url" DROP NOT NULL;

ALTER TABLE "seller_documents"
  ADD COLUMN "document_number" VARCHAR(40),
  ADD COLUMN "file_key" VARCHAR(300),
  ADD COLUMN "file_name" VARCHAR(160),
  ADD COLUMN "file_size" INTEGER,
  ADD COLUMN "content_type" VARCHAR(80);

ALTER TABLE "seller_documents"
  ADD CONSTRAINT "seller_documents_file_present"
  CHECK ("file_key" IS NOT NULL OR "file_url" IS NOT NULL);

ALTER TABLE "seller_documents"
  ADD CONSTRAINT "seller_documents_file_size_limit"
  CHECK ("file_size" IS NULL OR ("file_size" > 0 AND "file_size" <= 10485760));
