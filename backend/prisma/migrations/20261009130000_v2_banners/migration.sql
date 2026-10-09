-- Admin-managed banners. Additive: one enum, one table, one index.
-- `placement` is a free-form slug ("home_top", "food", "category:<id>", …) so
-- new placements need no schema change; images are optimised WebP in public
-- storage, exactly like every other content image.

-- CreateEnum
CREATE TYPE "BannerActionType" AS ENUM ('NONE', 'CATEGORY', 'PRODUCT', 'COUPON');

-- CreateTable
CREATE TABLE "banners" (
    "id" UUID NOT NULL,
    "placement" VARCHAR(60) NOT NULL,
    "title" VARCHAR(120),
    "subtitle" VARCHAR(200),
    "image_url" VARCHAR(500) NOT NULL,
    "image_width" INTEGER NOT NULL,
    "image_height" INTEGER NOT NULL,
    "action_type" "BannerActionType" NOT NULL DEFAULT 'NONE',
    "action_value" VARCHAR(120),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "banners_placement_is_active_display_order_idx" ON "banners"("placement", "is_active", "display_order");

-- Invariants the database enforces (Prisma cannot express CHECKs).
ALTER TABLE "banners"
  ADD CONSTRAINT "banners_placement_format" CHECK ("placement" ~ '^[a-z][a-z0-9_]*(:[A-Za-z0-9_-]+)?$'),
  ADD CONSTRAINT "banners_image_size_positive" CHECK ("image_width" > 0 AND "image_height" > 0),
  ADD CONSTRAINT "banners_action_value_matches_type" CHECK (("action_type" = 'NONE') = ("action_value" IS NULL));
