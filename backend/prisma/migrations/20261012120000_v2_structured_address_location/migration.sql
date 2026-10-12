-- Structured Indian addresses + where coordinates came from.
-- ADDITIVE ONLY: every column is nullable, no default, no backfill. Existing
-- rows keep NULL, which the application reads as "not recorded" (legacy) —
-- never as a fabricated value.

-- Customer addresses: district, and the origin / accuracy of the coordinates.
ALTER TABLE "addresses" ADD COLUMN "district" VARCHAR(80);
ALTER TABLE "addresses" ADD COLUMN "location_source" VARCHAR(16);
ALTER TABLE "addresses" ADD COLUMN "location_accuracy_m" DOUBLE PRECISION;

-- Seller store addresses: locality, district and landmark beside the existing
-- address line (shop / street), city (village / city / town), state and PIN.
ALTER TABLE "sellers" ADD COLUMN "locality" VARCHAR(160);
ALTER TABLE "sellers" ADD COLUMN "district" VARCHAR(80);
ALTER TABLE "sellers" ADD COLUMN "landmark" VARCHAR(160);

-- Order delivery snapshot: the district of the address at placement time.
ALTER TABLE "orders" ADD COLUMN "delivery_district" VARCHAR(80);
