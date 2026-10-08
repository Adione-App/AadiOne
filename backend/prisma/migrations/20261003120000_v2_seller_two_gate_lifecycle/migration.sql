-- =============================================================================
-- V2 seller registration + two-gate onboarding lifecycle
-- =============================================================================
--
-- Sellers can now apply themselves. A seller moves through:
--
--   APPLICATION_PENDING --(Gate 1)--> ONBOARDING_PENDING --(submit)-->
--   ONBOARDING_PENDING_REVIEW --(Gate 2)--> ACTIVE
--
-- with APPLICATION_REJECTED / ONBOARDING_REJECTED as terminal refusals and
-- ONBOARDING_CHANGES_REQUIRED as the "fix and resubmit" loop of Gate 2.
--
-- `onboarding_status` (PENDING/APPROVED/REJECTED) stays the column every
-- "is this seller live" rule reads; it is kept in step with the lifecycle and
-- a CHECK makes the two impossible to disagree.
--
-- Additive only: no existing column, value or row is removed. Existing
-- sellers are mapped from their onboarding_status:
--   APPROVED -> ACTIVE
--   REJECTED -> ONBOARDING_CHANGES_REQUIRED (an old rejection could always be
--               corrected and resubmitted — that is exactly this state)
--   PENDING  -> ONBOARDING_PENDING (created by admin: Gate 1 already passed)

-- New notification types (appended; existing values untouched).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SELLER_APPLICATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SELLER_APPLICATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SELLER_ONBOARDING_CHANGES_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ADMIN_SELLER_APPLICATION_SUBMITTED';

CREATE TYPE "SellerLifecycleStatus" AS ENUM (
  'APPLICATION_PENDING',
  'APPLICATION_REJECTED',
  'ONBOARDING_PENDING',
  'ONBOARDING_PENDING_REVIEW',
  'ONBOARDING_CHANGES_REQUIRED',
  'ACTIVE',
  'ONBOARDING_REJECTED'
);

ALTER TABLE "sellers"
  ADD COLUMN "lifecycle_status" "SellerLifecycleStatus" NOT NULL DEFAULT 'APPLICATION_PENDING',
  ADD COLUMN "lifecycle_reason" VARCHAR(500),
  ADD COLUMN "lifecycle_updated_at" TIMESTAMPTZ(3),
  ADD COLUMN "application_submitted_at" TIMESTAMPTZ(3),
  ADD COLUMN "onboarding_submitted_at" TIMESTAMPTZ(3),
  ADD COLUMN "activated_at" TIMESTAMPTZ(3);

UPDATE "sellers"
SET "lifecycle_status" = CASE "onboarding_status"
      WHEN 'APPROVED' THEN 'ACTIVE'::"SellerLifecycleStatus"
      WHEN 'REJECTED' THEN 'ONBOARDING_CHANGES_REQUIRED'::"SellerLifecycleStatus"
      ELSE 'ONBOARDING_PENDING'::"SellerLifecycleStatus"
    END,
    "lifecycle_updated_at" = CURRENT_TIMESTAMP,
    "activated_at" = CASE WHEN "onboarding_status" = 'APPROVED' THEN "updated_at" ELSE NULL END;

-- The old REJECTED could be resubmitted; under the new lifecycle that is
-- CHANGES_REQUIRED, whose onboarding_status is PENDING.
UPDATE "sellers" SET "onboarding_status" = 'PENDING'
WHERE "lifecycle_status" = 'ONBOARDING_CHANGES_REQUIRED' AND "onboarding_status" = 'REJECTED';

ALTER TABLE "sellers"
  ADD CONSTRAINT "sellers_lifecycle_matches_onboarding"
  CHECK (
    ("lifecycle_status" = 'ACTIVE') = ("onboarding_status" = 'APPROVED')
    AND ("lifecycle_status" = 'ONBOARDING_REJECTED') = ("onboarding_status" = 'REJECTED')
  );

CREATE INDEX "sellers_lifecycle_status_created_at_idx" ON "sellers"("lifecycle_status", "created_at");
