-- =============================================================================
-- V2 seller type = broad business classification (14 values)
-- =============================================================================
--
-- SellerType becomes a plain classification of the seller's business. It does
-- NOT decide the seller's catalogue — every seller creates its own categories
-- and subcategories in the Seller Panel. RESTAURANT keeps its own behaviour.
--
-- GENERAL is retired; any existing GENERAL seller becomes OTHER. Postgres
-- cannot drop a value from an enum, so the type is recreated and the column
-- converted in place (existing rows keep their type; only GENERAL is mapped).

ALTER TYPE "SellerType" RENAME TO "SellerType_old";

CREATE TYPE "SellerType" AS ENUM (
  'GROCERY',
  'FASHION',
  'ELECTRONICS',
  'BEAUTY',
  'HOME',
  'PHARMACY',
  'RESTAURANT',
  'SPORTS',
  'BOOKS',
  'KIDS',
  'AUTOMOTIVE',
  'PETS',
  'SERVICES',
  'OTHER'
);

ALTER TABLE "sellers" ALTER COLUMN "seller_type" DROP DEFAULT;

ALTER TABLE "sellers"
  ALTER COLUMN "seller_type" TYPE "SellerType"
  USING (
    CASE "seller_type"::text
      WHEN 'GENERAL' THEN 'OTHER'
      ELSE "seller_type"::text
    END
  )::"SellerType";

ALTER TABLE "sellers" ALTER COLUMN "seller_type" SET DEFAULT 'OTHER';

DROP TYPE "SellerType_old";
