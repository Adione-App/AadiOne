-- Session scope: a customer-app (mobile OTP) session is CUSTOMER whatever the
-- account's role, so seller-owner and admin accounts can shop in the customer
-- app without that session ever reaching a management API. Panel logins
-- (email + password) are FULL.
--
-- Additive only. Sessions that exist before this migration are FULL — exactly
-- what they are today — so nobody signed in to a panel loses access; the
-- default for NEW rows is then the least privilege, CUSTOMER (the code always
-- passes the scope explicitly).

CREATE TYPE "SessionScope" AS ENUM ('FULL', 'CUSTOMER');

ALTER TABLE "refresh_tokens" ADD COLUMN "scope" "SessionScope" NOT NULL DEFAULT 'FULL';

ALTER TABLE "refresh_tokens" ALTER COLUMN "scope" SET DEFAULT 'CUSTOMER';
