-- Seller type "Home & Kitchen", distinct from "Home".
--
-- ADDITIVE ONLY: one new value in the SellerType enum, placed after HOME so
-- the admin dropdown order (the enum order) keeps Home and Home & Kitchen
-- together. No existing seller changes type; nothing is renamed or removed.
-- Moving a particular seller to HOME_KITCHEN is a separate, explicit data
-- update (an admin edit, or the reviewed one-row UPDATE in the release notes).

-- AlterEnum
ALTER TYPE "SellerType" ADD VALUE 'HOME_KITCHEN' AFTER 'HOME';
