-- Two hot queries with no index leading on their filter column. Additive only:
-- no table, column or row is changed, and either index can be dropped again
-- with a plain DROP INDEX.

-- Product hydration loads every product card's offers with
-- `seller_listings.variant_id IN (…)` and no seller id; the existing
-- (seller_id, variant_id) unique key cannot serve that.
CREATE INDEX "seller_listings_variant_id_idx" ON "seller_listings"("variant_id");

-- Seller Panel product list (`submitted_by_seller_id = $1`) and the admin
-- "products of this seller" filter.
CREATE INDEX "products_submitted_by_seller_id_idx" ON "products"("submitted_by_seller_id");
