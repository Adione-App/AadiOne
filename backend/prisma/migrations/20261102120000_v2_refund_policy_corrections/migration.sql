-- V2: refund policy corrections (final approved policies, 2026-11-02).
--
--   1. Commission reversal on refunds after delivery: a seller deduction is
--      the seller's NET settlement for the refunded part (commission
--      reversed), recorded per order item so repeated partial refunds can
--      never take more than the item's own figures.
--   2. Manual (COD) payout references compared normalized (letters and
--      digits, upper-case) and unique across ALL methods.
--   3. An immutable correction record for a refund our ledger had as FAILED
--      that Cashfree, re-read directly, reports as SUCCESSFUL.
--
-- ADDITIVE ONLY: three NOT NULL DEFAULT 0 columns and one backfilled column
-- on tables created by 20261101120000_v2_refund_groups, two NEW tables, new
-- unique indexes. No refund amount, status, Cashfree id, settlement value or
-- audit row is changed.
--
-- ORDER: after 20261101120000_v2_refund_groups; BEFORE deploying the code
-- that writes these columns (Railway does not run migrations).
--
-- ROLLBACK (after rolling the code back, only while the new tables hold no
-- records worth keeping): drop "refund_corrections", "seller_deduction_items",
-- the three seller_deductions columns, manual_refund_payouts.reference_normalized
-- and the two new unique indexes on existing tables.

-- 1. Deduction breakdown -------------------------------------------------------

ALTER TABLE "seller_deductions" ADD COLUMN     "commission_reversed_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "coupon_reversed_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refunded_paise" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "seller_deductions"
  ADD CONSTRAINT "seller_deductions_reversals_nonneg"
  CHECK ("refunded_paise" >= 0 AND "commission_reversed_paise" >= 0 AND "coupon_reversed_paise" >= 0);

-- One deduction per seller portion per refund group — never twice.
CREATE UNIQUE INDEX "seller_deductions_group_id_seller_order_id_key" ON "seller_deductions"("group_id", "seller_order_id");

CREATE TABLE "seller_deduction_items" (
    "id" UUID NOT NULL,
    "deduction_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "refunded_paise" INTEGER NOT NULL,
    "seller_net_paise" INTEGER NOT NULL,
    "commission_paise" INTEGER NOT NULL,
    "coupon_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_deduction_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seller_deduction_items_money_nonneg" CHECK (
      "refunded_paise" >= 0 AND "seller_net_paise" >= 0 AND "commission_paise" >= 0 AND "coupon_paise" >= 0
    )
);

CREATE INDEX "seller_deduction_items_order_item_id_idx" ON "seller_deduction_items"("order_item_id");
CREATE UNIQUE INDEX "seller_deduction_items_deduction_id_order_item_id_key" ON "seller_deduction_items"("deduction_id", "order_item_id");

ALTER TABLE "seller_deduction_items" ADD CONSTRAINT "seller_deduction_items_deduction_id_fkey" FOREIGN KEY ("deduction_id") REFERENCES "seller_deductions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "seller_deduction_items" ADD CONSTRAINT "seller_deduction_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Normalized payout reference --------------------------------------------------

ALTER TABLE "manual_refund_payouts" ADD COLUMN "reference_normalized" VARCHAR(120);

-- Same rule as the application (admin-refund.service.ts › normalizeReference).
UPDATE "manual_refund_payouts"
SET "reference_normalized" = upper(regexp_replace("reference", '[^A-Za-z0-9]', '', 'g'))
WHERE "reference_normalized" IS NULL;

ALTER TABLE "manual_refund_payouts" ALTER COLUMN "reference_normalized" SET NOT NULL;

ALTER TABLE "manual_refund_payouts"
  ADD CONSTRAINT "manual_refund_payouts_reference_normalized_valid"
  CHECK ("reference_normalized" ~ '^[A-Z0-9]{6,120}$');

-- One transfer pays one refund, whatever method it was recorded under.
CREATE UNIQUE INDEX "manual_refund_payouts_reference_normalized_key" ON "manual_refund_payouts"("reference_normalized");

-- 3. Refund corrections (FAILED -> COMPLETED, verified with the provider) -----

CREATE TABLE "refund_corrections" (
    "id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "group_id" UUID,
    "previous_status" VARCHAR(20) NOT NULL,
    "new_status" VARCHAR(20) NOT NULL,
    "previous_failure_reason" VARCHAR(300),
    "previous_provider_refund_id" VARCHAR(120),
    "provider_refund_id" VARCHAR(120) NOT NULL,
    "provider_status" VARCHAR(40) NOT NULL,
    "evidence" JSONB NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_corrections_pkey" PRIMARY KEY ("id"),
    -- The only correction allowed: a refund recorded FAILED that the provider completed.
    CONSTRAINT "refund_corrections_failed_to_completed" CHECK ("previous_status" = 'FAILED' AND "new_status" = 'COMPLETED')
);

CREATE UNIQUE INDEX "refund_corrections_refund_id_key" ON "refund_corrections"("refund_id");

ALTER TABLE "refund_corrections" ADD CONSTRAINT "refund_corrections_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same as every table since 20261021120000_v2_lock_down_supabase_data_api:
-- no access through the Supabase Data API (the backend's owner role bypasses RLS).
ALTER TABLE "seller_deduction_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_corrections" ENABLE ROW LEVEL SECURITY;
