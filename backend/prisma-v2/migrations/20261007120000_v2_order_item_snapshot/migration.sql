-- Order item snapshot: the variant's option picks (Size / Color / ...), so the
-- seller and customer see exactly what was ordered even after the product's
-- variants are edited later.
ALTER TABLE "order_items" ADD COLUMN "option_values" JSONB NOT NULL DEFAULT '{}';

-- One-time backfill for rows placed before the snapshot captured them.
-- Option picks: from the variant the row still points at.
UPDATE "order_items" AS oi
SET "option_values" = pv."option_values"
FROM "product_variants" AS pv
WHERE oi."variant_id" = pv."id"
  AND oi."option_values" = '{}'::jsonb
  AND pv."option_values" <> '{}'::jsonb;

-- Product photo: order creation used to read only the VARIANT's image, but
-- photos are uploaded at product level, so most rows stored NULL. Fill only
-- those NULLs, with the same preference order order creation now uses
-- (variant image, then a variant-specific photo, then the product's first
-- photo). Rows that already have an image are never touched.
UPDATE "order_items" AS oi
SET "image_url" = COALESCE(
  pv."image_url",
  (SELECT pi."url" FROM "product_images" AS pi WHERE pi."variant_id" = pv."id" ORDER BY pi."display_order" ASC LIMIT 1),
  (SELECT pi."url" FROM "product_images" AS pi WHERE pi."product_id" = pv."product_id" ORDER BY pi."display_order" ASC LIMIT 1)
)
FROM "product_variants" AS pv
WHERE oi."variant_id" = pv."id"
  AND oi."image_url" IS NULL;
