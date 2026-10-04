-- V2 food sellers: CAFE joins RESTAURANT as a menu-based seller type, and a
-- food menu item's listing does not count stock (made to order).
-- Additive only: existing rows keep tracks_stock = true (unchanged behaviour).

ALTER TYPE "SellerType" ADD VALUE IF NOT EXISTS 'CAFE' AFTER 'RESTAURANT';

ALTER TABLE "seller_listings" ADD COLUMN "tracks_stock" BOOLEAN NOT NULL DEFAULT true;
