-- Live-location orders: an order can be delivered to a GPS point given for
-- that order only, instead of a saved address.
--
-- ADDITIVE ONLY. Every existing order was placed to a saved address, so the
-- new mode column defaults to SAVED_ADDRESS (a metadata-only default on
-- Postgres 11+, no table rewrite). The accuracy and label columns are
-- nullable with NO backfill: copying today's address labels into old orders
-- would record a label they may never have had. Nothing is dropped, renamed
-- or rewritten; existing snapshots read exactly as before.

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('SAVED_ADDRESS', 'LIVE_LOCATION');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "delivery_mode" "DeliveryMode" NOT NULL DEFAULT 'SAVED_ADDRESS',
ADD COLUMN "delivery_location_accuracy_m" DOUBLE PRECISION,
ADD COLUMN "delivery_label" VARCHAR(30);

-- A live-location order never points at a saved address. (A saved-address
-- order's address_id may still become NULL through ON DELETE SET NULL.)
ALTER TABLE "orders" ADD CONSTRAINT "orders_live_location_has_no_address" CHECK ("delivery_mode" <> 'LIVE_LOCATION' OR "address_id" IS NULL);
