-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('REGISTERED', 'FIRST_ORDER_PENDING', 'COMPLETED', 'REWARD_ISSUED');

-- CreateEnum
CREATE TYPE "CouponOrigin" AS ENUM ('PROMO', 'REFERRAL_REWARD');

-- AlterTable
ALTER TABLE "coupons" ADD COLUMN "issued_to_user_id" UUID,
ADD COLUMN "issued_for_referral_id" UUID,
ADD COLUMN "origin" "CouponOrigin" NOT NULL DEFAULT 'PROMO';

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "referrer_user_id" UUID NOT NULL,
    "referred_user_id" UUID NOT NULL,
    "referral_code" VARCHAR(16) NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'REGISTERED',
    "first_eligible_order_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "reward_issued_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_user_id_key" ON "referrals"("referred_user_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_user_id_idx" ON "referrals"("referrer_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_issued_for_referral_id_key" ON "coupons"("issued_for_referral_id");

-- CreateIndex
CREATE INDEX "coupons_issued_to_user_id_idx" ON "coupons"("issued_to_user_id");

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_issued_to_user_id_fkey" FOREIGN KEY ("issued_to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_issued_for_referral_id_fkey" FOREIGN KEY ("issued_for_referral_id") REFERENCES "referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_fkey" FOREIGN KEY ("referrer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
