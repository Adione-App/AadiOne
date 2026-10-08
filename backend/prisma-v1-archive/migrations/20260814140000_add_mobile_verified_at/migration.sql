-- Records when a user's mobile number was last proven by OTP.
--
-- Needed because Task 2.6 adds email+password signup, where the customer types
-- a mobile number nobody has verified. The rider phones that number and COD
-- settlement depends on reaching a real person, so "verified" has to be a fact
-- we store rather than an assumption.
ALTER TABLE "users" ADD COLUMN "mobile_verified_at" TIMESTAMPTZ(3);

-- Backfill: every account that exists so far was created by a successful OTP
-- verification (password accounts did not exist before this migration), so
-- their numbers are verified as of account creation. Admin/staff rows created
-- by the seed carry a placeholder mobile and are deliberately left unverified.
UPDATE "users"
SET "mobile_verified_at" = "created_at"
WHERE "password_hash" IS NULL
  AND "role" = 'CUSTOMER';

-- Partial index for the "unverified customers" admin view and for any future
-- rule that gates COD on a verified number.
CREATE INDEX "users_unverified_mobile"
  ON "users" ("created_at")
  WHERE "mobile_verified_at" IS NULL AND "role" = 'CUSTOMER';
