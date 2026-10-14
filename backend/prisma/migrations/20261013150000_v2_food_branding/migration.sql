-- Food section branding (customer Food list + restaurant menu page).
--
-- ADDITIVE ONLY: three nullable columns, no default, no backfill. Existing
-- restaurant profiles and banners keep NULL (= no logo / no cover / no button),
-- which the app already handles. Nothing is dropped, renamed or rewritten.

-- AlterTable: a restaurant's own logo and cover photo (set from the Admin Panel).
ALTER TABLE "restaurant_profiles" ADD COLUMN "logo_url" VARCHAR(500),
ADD COLUMN "cover_image_url" VARCHAR(500);

-- AlterTable: optional button text on a banner (e.g. the Food hero's "Order now").
ALTER TABLE "banners" ADD COLUMN "cta_label" VARCHAR(40);
