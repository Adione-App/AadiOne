-- A restaurant's / cafe's second image: the food / menu hero at the top of its
-- menu page, kept apart from its cover photo (the place itself, on the Food list).
--
-- ADDITIVE ONLY: one nullable column, no default, no backfill. Existing
-- profiles keep NULL (= no menu image yet), which the app already handles.

-- AlterTable
ALTER TABLE "restaurant_profiles" ADD COLUMN "menu_image_url" VARCHAR(500);
