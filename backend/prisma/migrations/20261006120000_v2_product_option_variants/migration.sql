-- V2 product options / variants — an extension of the EXISTING variant model
-- (ProductVariant + its SellerListing per seller), not a second system.
--
--   products.option_groups          ordered option groups, e.g.
--                                   [{"name":"Size","values":["Half","Full"]}];
--                                   [] = simple item (one variant), as today
--   product_variants.option_values  this variant's pick per group, e.g.
--                                   {"Size":"Full"}; {} for a simple item
--   product_variants.approval_status per-variant review for a variant added
--                                   to an already-approved product
--
-- Additive and data-preserving: every existing product keeps [] option
-- groups and every existing variant {} option values and APPROVED, so all
-- products, listings, carts and orders behave exactly as before.

ALTER TABLE "products" ADD COLUMN "option_groups" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "product_variants" ADD COLUMN "option_values" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "product_variants" ADD COLUMN "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED';

-- A variant name is unique among the product's LIVE variants: a removed
-- (soft-deleted) variant no longer blocks its name — same pattern as the
-- categories' partial slug indexes. Same columns as before, narrower scope,
-- so no existing row can violate it.
DROP INDEX "product_variants_product_id_variant_name_key";
CREATE UNIQUE INDEX "product_variants_live_name_unique"
  ON "product_variants" ("product_id", "variant_name")
  WHERE "deleted_at" IS NULL;
