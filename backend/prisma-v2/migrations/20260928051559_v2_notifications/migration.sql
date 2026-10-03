-- =============================================================================
-- V2 notifications: audience-scoped feeds + duplicate protection
-- =============================================================================
--
-- * NotificationType gains seller- and admin-facing events; the new
--   NotificationAudience (CUSTOMER / SELLER / ADMIN) separates the feeds —
--   a seller's staff user is also a shopper on the same login, so the customer
--   app and the seller panel must never show each other's notifications.
--   Every existing row is a customer order update -> DEFAULT 'CUSTOMER'.
-- * `seller_id` scopes SELLER rows to the seller they are about.
-- * `dedupe_key` + UNIQUE (user_id, dedupe_key): each business event has a
--   deterministic key, so a retried/repeated operation cannot notify the same
--   user twice. NULLs are distinct, so legacy rows (NULL key) are unaffected.
--
-- Everything down to the foreign key is exactly what `prisma migrate diff`
-- generated from the schema change. The final CHECK is hand-written (Prisma
-- cannot express CHECK constraints). PostgreSQL 17: ADD VALUE is allowed in a
-- transaction block (the new values are not used inside it).
-- =============================================================================

BEGIN;

-- CreateEnum
CREATE TYPE "NotificationAudience" AS ENUM ('CUSTOMER', 'SELLER', 'ADMIN');

-- AlterEnum


ALTER TYPE "NotificationType" ADD VALUE 'SELLER_NEW_ORDER';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_ORDER_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_ORDER_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_REFUND_ISSUED';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_ONBOARDING_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_ONBOARDING_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_PRODUCT_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_PRODUCT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_SETTLEMENT_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_SETTLEMENT_PROCESSING';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_SETTLEMENT_PAID';
ALTER TYPE "NotificationType" ADD VALUE 'SELLER_SETTLEMENT_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_ONBOARDING_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_PRODUCTS_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_REFUND_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_SETTLEMENT_FAILED';

-- DropIndex
DROP INDEX "notifications_user_id_created_at_idx";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "audience" "NotificationAudience" NOT NULL DEFAULT 'CUSTOMER',
ADD COLUMN     "dedupe_key" VARCHAR(160),
ADD COLUMN     "seller_id" UUID;

-- CreateIndex
CREATE INDEX "notifications_user_id_audience_created_at_idx" ON "notifications"("user_id", "audience", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: a SELLER notification always names its seller; no other
-- audience carries one.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_seller_scope"
    CHECK (("audience" = 'SELLER') = ("seller_id" IS NOT NULL));

COMMIT;
