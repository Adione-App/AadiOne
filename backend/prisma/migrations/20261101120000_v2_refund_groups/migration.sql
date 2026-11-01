-- V2: hybrid refund management — refund groups, component types, customer
-- refund requests, manual (COD) refund payouts, seller deductions, coupon
-- release.
--
-- ADDITIVE ONLY. New enums and NEW, EMPTY tables; nullable columns on
-- "refunds" and "coupon_redemptions"; "seller_settlements.deductions_paise"
-- defaults to 0. No existing row is deleted, no amount, status or Cashfree
-- refund id is changed.
--
-- BACKFILL (refunds.component_type only — classifying what each existing
-- refund already is, from data it already has):
--   seller_order_id set                       -> SELLER_PRODUCT
--   its payment is an orphan capture          -> ORPHAN_PAYMENT
--   the fee remainder (its exact fixed reason) -> ORDER_FEES
--   anything else (an order-level refund)     -> FULL_ORDER
-- refunds.group_id stays NULL for every existing refund: which refunds one
-- past action issued together was never recorded, so no grouping is
-- invented. The customer API shows those refunds as they are.
--
-- COMPATIBILITY: the old backend never reads or writes the new columns or
-- tables; with them empty / NULL / 0 it behaves exactly as before. Existing
-- settlements keep their amounts (deductions_paise = 0 means
-- net = gross - commission, as they were created).
--
-- ORDER: apply this migration BEFORE deploying the code that reads these
-- tables (Railway does not run migrations).
--
-- ROLLBACK (after rolling the code back, and only while the new tables hold
-- no financial records worth keeping): drop the six new tables, the three
-- new "refunds" columns, the two new "coupon_redemptions" columns,
-- "seller_settlements.deductions_paise" and the nine new enum types.

-- Two notification types: a customer's refund update (delayed; a request
-- received / decided) and the admins' "refund request to review". Old apps
-- show the server-rendered text with their generic icon.
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_REFUND_REQUEST';

-- CreateEnum
CREATE TYPE "RefundGroupOrigin" AS ENUM ('AUTO', 'ADMIN', 'CUSTOMER_REQUEST');

-- CreateEnum
CREATE TYPE "RefundGroupChannel" AS ENUM ('CASHFREE', 'MANUAL');

-- CreateEnum
CREATE TYPE "RefundGroupStatus" AS ENUM ('APPROVED', 'PROCESSING', 'SUCCESS', 'PARTIAL_FAILURE', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundComponentType" AS ENUM ('SELLER_PRODUCT', 'DELIVERY_FEE', 'PLATFORM_FEE', 'ORDER_FEES', 'FULL_ORDER', 'ORPHAN_PAYMENT');

-- CreateEnum
CREATE TYPE "RefundRequestCategory" AS ENUM ('MISSING_ITEM', 'DAMAGED_ITEM', 'WRONG_ITEM', 'QUALITY_ISSUE', 'DELIVERY_DISPUTE', 'OTHER');

-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ManualPayoutMethod" AS ENUM ('UPI', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "ManualPayoutStatus" AS ENUM ('RECORDED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "SellerDeductionStatus" AS ENUM ('OUTSTANDING', 'PARTIALLY_APPLIED', 'APPLIED');

-- AlterTable
ALTER TABLE "coupon_redemptions" ADD COLUMN     "release_reason" VARCHAR(120),
ADD COLUMN     "released_at" TIMESTAMPTZ(3);

-- A released use always says why.
ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_release_has_reason" CHECK ("released_at" IS NULL OR "release_reason" IS NOT NULL);

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "component_type" "RefundComponentType",
ADD COLUMN     "group_id" UUID,
ADD COLUMN     "retry_of_id" UUID;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_retry_not_self" CHECK ("retry_of_id" IS NULL OR "retry_of_id" <> "id");

-- AlterTable
ALTER TABLE "seller_settlements" ADD COLUMN     "deductions_paise" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "seller_settlements"
  ADD CONSTRAINT "seller_settlements_deductions_nonneg" CHECK ("deductions_paise" >= 0);

-- CreateTable
CREATE TABLE "refund_groups" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "origin" "RefundGroupOrigin" NOT NULL,
    "channel" "RefundGroupChannel" NOT NULL DEFAULT 'CASHFREE',
    "reason" VARCHAR(300) NOT NULL,
    "post_delivery" BOOLEAN NOT NULL DEFAULT false,
    "allocation" JSONB,
    "total_paise" INTEGER NOT NULL DEFAULT 0,
    "refunded_paise" INTEGER NOT NULL DEFAULT 0,
    "status" "RefundGroupStatus" NOT NULL DEFAULT 'APPROVED',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "refund_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refund_groups_money_valid" CHECK ("total_paise" >= 0 AND "refunded_paise" >= 0 AND "refunded_paise" <= "total_paise")
);

-- CreateTable
CREATE TABLE "refund_requests" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "RefundRequestCategory" NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "items" JSONB NOT NULL,
    "requested_paise" INTEGER NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'UNDER_REVIEW',
    "approved_paise" INTEGER,
    "decision_note" VARCHAR(500),
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "group_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refund_requests_requested_positive" CHECK ("requested_paise" > 0),
    -- An approval is a positive amount, never above what was requested;
    -- only an approved request has one.
    CONSTRAINT "refund_requests_approved_valid" CHECK (
      ("status" = 'APPROVED' AND "approved_paise" > 0 AND "approved_paise" <= "requested_paise")
      OR ("status" <> 'APPROVED' AND "approved_paise" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "refund_request_evidence" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_request_evidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refund_request_evidence_size_positive" CHECK ("size_bytes" > 0)
);

-- CreateTable
CREATE TABLE "manual_refund_payouts" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "method" "ManualPayoutMethod" NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "paid_on" DATE NOT NULL,
    "proof_note" VARCHAR(300),
    "status" "ManualPayoutStatus" NOT NULL DEFAULT 'RECORDED',
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_user_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),

    CONSTRAINT "manual_refund_payouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_refund_payouts_amount_positive" CHECK ("amount_paise" > 0),
    -- CONFIRMED always says who confirmed it and when.
    CONSTRAINT "manual_refund_payouts_confirmation_valid" CHECK (
      ("status" = 'CONFIRMED' AND "confirmed_by_user_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)
      OR ("status" = 'RECORDED' AND "confirmed_by_user_id" IS NULL AND "confirmed_at" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "seller_deductions" (
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "refund_id" UUID,
    "manual_payout_id" UUID,
    "amount_paise" INTEGER NOT NULL,
    "applied_paise" INTEGER NOT NULL DEFAULT 0,
    "status" "SellerDeductionStatus" NOT NULL DEFAULT 'OUTSTANDING',
    "reason" VARCHAR(300) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seller_deductions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seller_deductions_amount_positive" CHECK ("amount_paise" > 0),
    -- Never applied beyond its amount, never negative.
    CONSTRAINT "seller_deductions_applied_range" CHECK ("applied_paise" >= 0 AND "applied_paise" <= "amount_paise"),
    -- The status always matches what was applied.
    CONSTRAINT "seller_deductions_status_matches" CHECK (
      ("status" = 'OUTSTANDING' AND "applied_paise" = 0)
      OR ("status" = 'PARTIALLY_APPLIED' AND "applied_paise" > 0 AND "applied_paise" < "amount_paise")
      OR ("status" = 'APPLIED' AND "applied_paise" = "amount_paise")
    ),
    -- Exactly one source: a completed Cashfree refund component, or a
    -- confirmed manual payout.
    CONSTRAINT "seller_deductions_one_source" CHECK (("refund_id" IS NULL) <> ("manual_payout_id" IS NULL))
);

-- CreateTable
CREATE TABLE "seller_deduction_applications" (
    "id" UUID NOT NULL,
    "deduction_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_deduction_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seller_deduction_applications_amount_positive" CHECK ("amount_paise" > 0)
);

-- CreateIndex
CREATE INDEX "refund_groups_order_id_idx" ON "refund_groups"("order_id");

-- CreateIndex
CREATE INDEX "refund_groups_status_created_at_idx" ON "refund_groups"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refund_requests_group_id_key" ON "refund_requests"("group_id");

-- CreateIndex
CREATE INDEX "refund_requests_order_id_idx" ON "refund_requests"("order_id");

-- CreateIndex
CREATE INDEX "refund_requests_status_created_at_idx" ON "refund_requests"("status", "created_at");

-- At most ONE request under review per order (duplicate submissions, double
-- taps and concurrent requests become a constraint violation).
CREATE UNIQUE INDEX "refund_requests_one_under_review"
  ON "refund_requests"("order_id")
  WHERE "status" = 'UNDER_REVIEW';

-- CreateIndex
CREATE UNIQUE INDEX "refund_request_evidence_storage_key_key" ON "refund_request_evidence"("storage_key");

-- CreateIndex
CREATE INDEX "refund_request_evidence_request_id_idx" ON "refund_request_evidence"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "manual_refund_payouts_group_id_key" ON "manual_refund_payouts"("group_id");

-- CreateIndex
CREATE INDEX "manual_refund_payouts_order_id_idx" ON "manual_refund_payouts"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "manual_refund_payouts_method_reference_key" ON "manual_refund_payouts"("method", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "seller_deductions_refund_id_key" ON "seller_deductions"("refund_id");

-- CreateIndex
CREATE INDEX "seller_deductions_seller_id_status_created_at_idx" ON "seller_deductions"("seller_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "seller_deductions_group_id_idx" ON "seller_deductions"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_deductions_manual_payout_id_seller_order_id_key" ON "seller_deductions"("manual_payout_id", "seller_order_id");

-- CreateIndex
CREATE INDEX "seller_deduction_applications_settlement_id_idx" ON "seller_deduction_applications"("settlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_deduction_applications_deduction_id_settlement_id_key" ON "seller_deduction_applications"("deduction_id", "settlement_id");

-- CreateIndex
CREATE INDEX "refunds_group_id_idx" ON "refunds"("group_id");

-- A failed attempt is retried at most once (a further retry retries the retry).
CREATE UNIQUE INDEX "refunds_retry_of_id_key" ON "refunds"("retry_of_id");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "refund_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_retry_of_id_fkey" FOREIGN KEY ("retry_of_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_groups" ADD CONSTRAINT "refund_groups_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "refund_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_request_evidence" ADD CONSTRAINT "refund_request_evidence_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "refund_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_refund_payouts" ADD CONSTRAINT "manual_refund_payouts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "refund_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_deductions" ADD CONSTRAINT "seller_deductions_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_deductions" ADD CONSTRAINT "seller_deductions_seller_order_id_fkey" FOREIGN KEY ("seller_order_id") REFERENCES "seller_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_deductions" ADD CONSTRAINT "seller_deductions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "refund_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_deductions" ADD CONSTRAINT "seller_deductions_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_deductions" ADD CONSTRAINT "seller_deductions_manual_payout_id_fkey" FOREIGN KEY ("manual_payout_id") REFERENCES "manual_refund_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_deduction_applications" ADD CONSTRAINT "seller_deduction_applications_deduction_id_fkey" FOREIGN KEY ("deduction_id") REFERENCES "seller_deductions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_deduction_applications" ADD CONSTRAINT "seller_deduction_applications_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "seller_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same as every table since 20261021120000_v2_lock_down_supabase_data_api:
-- no access through the Supabase Data API (the backend's owner role bypasses RLS).
ALTER TABLE "refund_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_request_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_refund_payouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seller_deductions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seller_deduction_applications" ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- BACKFILL: refunds.component_type for refunds issued before this migration.
-- Only rows still unclassified are touched (idempotent). Amounts, statuses,
-- Cashfree ids and group ids are not changed.
-- -----------------------------------------------------------------------------

UPDATE "refunds" SET "component_type" = 'SELLER_PRODUCT'
WHERE "component_type" IS NULL AND "seller_order_id" IS NOT NULL;

UPDATE "refunds" r SET "component_type" = 'ORPHAN_PAYMENT'
FROM "payments" p
WHERE r."component_type" IS NULL
  AND r."payment_id" = p."id"
  AND p."failure_code" = 'ORPHAN_CAPTURE';

UPDATE "refunds" SET "component_type" = 'ORDER_FEES'
WHERE "component_type" IS NULL
  AND "reason" = 'Every seller portion was cancelled — refunding the remaining amount (delivery/platform fees).';

UPDATE "refunds" SET "component_type" = 'FULL_ORDER'
WHERE "component_type" IS NULL;
