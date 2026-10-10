-- V2 bulk product import (Seller Panel -> Products -> Bulk Import).
--
-- Additive only: three new tables (import jobs, their rows, their archive
-- images) and one partial index. No existing table or column changes.

-- CreateEnum
CREATE TYPE "ProductImportKind" AS ENUM ('PRODUCTS', 'IMAGES');

-- CreateEnum
CREATE TYPE "ProductImportMode" AS ENUM ('CREATE', 'UPDATE');

-- CreateEnum
CREATE TYPE "ProductImportStatus" AS ENUM ('ANALYZING', 'READY', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProductImportRowStatus" AS ENUM ('READY', 'INVALID', 'DUPLICATE', 'CONFLICT', 'EXCLUDED', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ProductImportRowAction" AS ENUM ('NONE', 'CREATE', 'UPDATE', 'ATTACH_IMAGES');

-- CreateEnum
CREATE TYPE "ProductImportImageStatus" AS ENUM ('PENDING', 'READY', 'INVALID', 'DUPLICATE_NAME', 'UNUSED');

-- CreateTable
CREATE TABLE "product_imports" (
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "kind" "ProductImportKind" NOT NULL,
    "mode" "ProductImportMode" NOT NULL DEFAULT 'CREATE',
    "status" "ProductImportStatus" NOT NULL DEFAULT 'ANALYZING',
    "file_name" VARCHAR(255),
    "archive_name" VARCHAR(255),
    "columns" JSONB NOT NULL DEFAULT '[]',
    "ignored_columns" JSONB NOT NULL DEFAULT '[]',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "ready_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "conflict_rows" INTEGER NOT NULL DEFAULT 0,
    "warning_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "analyzed_images" INTEGER NOT NULL DEFAULT 0,
    "error_summary" VARCHAR(500),
    "heartbeat_at" TIMESTAMPTZ(3),
    "worker_id" VARCHAR(80),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_import_rows" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" "ProductImportRowStatus" NOT NULL,
    "action" "ProductImportRowAction" NOT NULL DEFAULT 'NONE',
    "sku" VARCHAR(60),
    "raw_values" JSONB NOT NULL,
    "parsed" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "image_names" JSONB NOT NULL DEFAULT '[]',
    "decisions" JSONB NOT NULL DEFAULT '{}',
    "stages" JSONB NOT NULL DEFAULT '{}',
    "product_id" UUID,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_import_images" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "name_key" VARCHAR(255) NOT NULL,
    "status" "ProductImportImageStatus" NOT NULL,
    "error" VARCHAR(300),
    "sha256" VARCHAR(64),
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "url" VARCHAR(500),
    "thumb_url" VARCHAR(500),
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_import_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_imports_seller_id_created_at_idx" ON "product_imports"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "product_imports_status_heartbeat_at_idx" ON "product_imports"("status", "heartbeat_at");

-- CreateIndex
CREATE INDEX "product_import_rows_import_id_status_idx" ON "product_import_rows"("import_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_import_rows_import_id_row_number_key" ON "product_import_rows"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "product_import_images_import_id_name_key_idx" ON "product_import_images"("import_id", "name_key");

-- AddForeignKey
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "product_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_import_images" ADD CONSTRAINT "product_import_images_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "product_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Barcode matching (bulk import duplicate checks, images-only imports matched by
-- barcode). Partial: most variants have no barcode. Prisma cannot express a
-- partial index, so it lives here only (same pattern as the hardening migration).
CREATE INDEX "product_variants_barcode_idx" ON "product_variants"("barcode") WHERE "barcode" IS NOT NULL;
