-- Banner campaigns: drafts, scheduling, presentation and more tap targets.
--
-- ADDITIVE ONLY. Existing banners become PUBLISHED with no schedule and an
-- empty layout ({} = the placement's defaults), so they keep showing exactly
-- as before. Nothing is dropped, renamed or rewritten; widening a VARCHAR is
-- a metadata-only change.

-- CreateEnum
CREATE TYPE "BannerStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterEnum: new tap targets (store page, restaurant menu, product rail, https link)
ALTER TYPE "BannerActionType" ADD VALUE 'STORE';
ALTER TYPE "BannerActionType" ADD VALUE 'RESTAURANT';
ALTER TYPE "BannerActionType" ADD VALUE 'RAIL';
ALTER TYPE "BannerActionType" ADD VALUE 'URL';

-- AlterTable
ALTER TABLE "banners" ADD COLUMN "status" "BannerStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN "starts_at" TIMESTAMPTZ(3),
ADD COLUMN "ends_at" TIMESTAMPTZ(3),
ADD COLUMN "layout" JSONB NOT NULL DEFAULT '{}',
ALTER COLUMN "action_value" SET DATA TYPE VARCHAR(500);

-- A schedule must end after it starts.
ALTER TABLE "banners" ADD CONSTRAINT "banners_schedule_order" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at");
