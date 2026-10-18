-- One mobile number: a CUSTOMER account AND a partner account.
--
-- WHY: users.mobile was UNIQUE across every role, so one number could hold
-- only one account. A number that shopped in the customer app could not
-- register a seller in the Seller Panel, and the other way round. The two
-- portals keep SEPARATE accounts: a number may now have
--   - ONE customer account (role = 'CUSTOMER', the shopping app), and
--   - ONE partner account  (any other role: Seller Panel, admin, staff,
--     delivery).
-- A second account of the SAME type is still impossible. Email follows the
-- same split (a customer's profile email may equal their Seller Panel email).
--
-- SAFE ON EXISTING DATA: every number and email is already unique across ALL
-- users, so it is unique within each type; no row changes, nothing is
-- deleted or merged. Indexes only (small table: built in milliseconds).
-- Hand-written (partial indexes are inexpressible in schema.prisma, see
-- docs/02-decisions.md D10); schema.prisma lists them in a comment and keeps
-- a plain index for lookups (users_mobile_idx).
--
-- ROLLBACK (only while no number has two accounts):
--   DROP INDEX "users_customer_mobile_key"; DROP INDEX "users_partner_mobile_key";
--   DROP INDEX "users_customer_email_unique"; DROP INDEX "users_partner_email_unique";
--   DROP INDEX "users_mobile_idx";
--   CREATE UNIQUE INDEX "users_mobile_key" ON "users"("mobile");
--   CREATE UNIQUE INDEX "users_email_unique" ON "users" (lower("email"))
--     WHERE "email" IS NOT NULL AND "deleted_at" IS NULL;

BEGIN;

DROP INDEX "users_mobile_key";

CREATE UNIQUE INDEX "users_customer_mobile_key"
  ON "users" ("mobile")
  WHERE "role" = 'CUSTOMER';

CREATE UNIQUE INDEX "users_partner_mobile_key"
  ON "users" ("mobile")
  WHERE "role" <> 'CUSTOMER';

-- Lookups that span both types (an admin searching a number).
CREATE INDEX "users_mobile_idx" ON "users" ("mobile");

DROP INDEX "users_email_unique";

CREATE UNIQUE INDEX "users_customer_email_unique"
  ON "users" (lower("email"))
  WHERE "email" IS NOT NULL AND "deleted_at" IS NULL AND "role" = 'CUSTOMER';

CREATE UNIQUE INDEX "users_partner_email_unique"
  ON "users" (lower("email"))
  WHERE "email" IS NOT NULL AND "deleted_at" IS NULL AND "role" <> 'CUSTOMER';

COMMIT;
