-- =============================================================================
-- Hardening migration
--
-- Everything Prisma's schema language cannot express, but that this system
-- depends on for correctness and performance:
--
--   1. CHECK constraints  — invariants enforced by the database, so no code
--                           path (including a future one, or a manual UPDATE
--                           in psql) can violate them.
--   2. Partial indexes    — smaller, faster indexes over the rows queries
--                           actually touch.
--   3. Partial UNIQUE      — business rules like "exactly one default address"
--      indexes              and "one active cart" enforced structurally rather
--                           than by application logic that can race.
--   4. Full-text search   — tsvector column, trigger and GIN index, plus
--                           trigram indexes for typo tolerance.
--
-- These objects are invisible to Prisma Client, which is fine: they serve the
-- query planner and the integrity of the data, not the generated API.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. CHECK constraints
-- -----------------------------------------------------------------------------

-- The inventory invariants. `reserved_qty <= stock_qty` is the last line of
-- defence against overselling: even if a bug in the order transaction tried to
-- reserve more than exists, Postgres refuses the write and the transaction
-- rolls back rather than silently selling stock that is not on the shelf.
ALTER TABLE "store_variants"
  ADD CONSTRAINT "store_variants_price_lte_mrp"
    CHECK ("price_paise" <= "mrp_paise"),
  ADD CONSTRAINT "store_variants_money_nonneg"
    CHECK ("price_paise" >= 0 AND "mrp_paise" >= 0),
  ADD CONSTRAINT "store_variants_stock_nonneg"
    CHECK ("stock_qty" >= 0),
  ADD CONSTRAINT "store_variants_reserved_valid"
    CHECK ("reserved_qty" >= 0 AND "reserved_qty" <= "stock_qty"),
  ADD CONSTRAINT "store_variants_max_qty_positive"
    CHECK ("max_qty_per_order" > 0),
  ADD CONSTRAINT "store_variants_low_stock_nonneg"
    CHECK ("low_stock_threshold" >= 0);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_qty_positive" CHECK ("qty" > 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_qty_positive" CHECK ("qty" > 0),
  ADD CONSTRAINT "order_items_money_nonneg"
    CHECK ("unit_price_paise" >= 0 AND "mrp_paise" >= 0 AND "line_total_paise" >= 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_money_nonneg"
    CHECK (
      "items_subtotal_paise" >= 0 AND
      "item_discount_paise" >= 0 AND
      "coupon_discount_paise" >= 0 AND
      "delivery_fee_paise" >= 0 AND
      "platform_fee_paise" >= 0 AND
      "tax_paise" >= 0 AND
      "total_paise" >= 0
    );

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_paise" > 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount_paise" > 0);

-- Coordinates must be real coordinates. A zero/zero address (the classic
-- "GPS failed and the client sent 0,0" bug) would otherwise be ~6,000 km away
-- and silently unserviceable.
ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_lat_range" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "addresses_lng_range" CHECK ("longitude" BETWEEN -180 AND 180);

ALTER TABLE "stores"
  ADD CONSTRAINT "stores_lat_range" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "stores_lng_range" CHECK ("longitude" BETWEEN -180 AND 180);

ALTER TABLE "store_hours"
  ADD CONSTRAINT "store_hours_day_range" CHECK ("day_of_week" BETWEEN 0 AND 6);

ALTER TABLE "categories"
  ADD CONSTRAINT "categories_depth_nonneg" CHECK ("depth" >= 0),
  -- A category cannot be its own parent.
  ADD CONSTRAINT "categories_not_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");


-- -----------------------------------------------------------------------------
-- 2. Partial UNIQUE indexes — business rules enforced by the database
-- -----------------------------------------------------------------------------

-- Exactly one default address per user. Doing this in application code means
-- "unset the old default, set the new one", which two concurrent requests can
-- interleave into zero or two defaults. The database simply refuses.
CREATE UNIQUE INDEX "addresses_one_default_per_user"
  ON "addresses" ("user_id")
  WHERE "is_default" AND "deleted_at" IS NULL;

-- Address list — deleted rows are never listed, so they are excluded entirely.
CREATE INDEX "addresses_user_active"
  ON "addresses" ("user_id")
  WHERE "deleted_at" IS NULL;

-- One ACTIVE cart per (user, store).
CREATE UNIQUE INDEX "carts_one_active_per_user_store"
  ON "carts" ("user_id", "store_id")
  WHERE "status" = 'ACTIVE';

-- One live rider per order. A cancelled assignment may be replaced.
CREATE UNIQUE INDEX "delivery_assignments_one_active_per_order"
  ON "delivery_assignments" ("order_id")
  WHERE "status" <> 'CANCELLED';

-- Case-insensitive unique email, for admin login. Customers have a NULL email,
-- and NULLs are excluded, so any number of customers can have none.
CREATE UNIQUE INDEX "users_email_unique"
  ON "users" (lower("email"))
  WHERE "email" IS NOT NULL AND "deleted_at" IS NULL;

-- One open back-in-stock subscription per (user, variant).
CREATE UNIQUE INDEX "back_in_stock_one_open_per_user_variant"
  ON "back_in_stock_subscriptions" ("user_id", "variant_id")
  WHERE "notified_at" IS NULL;


-- -----------------------------------------------------------------------------
-- 3. Partial indexes — smaller indexes over the rows queries actually read
-- -----------------------------------------------------------------------------

-- Staff/admin listing. There will be a handful of these rows among many
-- thousands of customers, so the partial index is tiny.
CREATE INDEX "users_staff_roles"
  ON "users" ("role")
  WHERE "role" <> 'CUSTOMER';

-- The Home category row and the category sidebar.
CREATE INDEX "categories_active_tree"
  ON "categories" ("parent_id", "display_order")
  WHERE "is_active" AND "deleted_at" IS NULL;

-- Category listing / product grid: only live products are ever shown.
CREATE INDEX "products_category_active"
  ON "products" ("category_id", "popularity_score" DESC)
  WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL;

-- "Can this be bought right now?" — the single most frequent catalogue filter.
-- Out-of-stock rows are absent from this index altogether.
CREATE INDEX "store_variants_in_stock"
  ON "store_variants" ("store_id", "variant_id")
  WHERE "is_available" AND ("stock_qty" - "reserved_qty") > 0;

-- The admin dashboard's low-stock report reads a handful of rows rather than
-- scanning the whole catalogue.
CREATE INDEX "store_variants_low_stock"
  ON "store_variants" ("store_id", "stock_qty")
  WHERE ("stock_qty" - "reserved_qty") <= "low_stock_threshold";

-- The reservation-release job. Stays O(orders awaiting payment) forever,
-- rather than growing with total order history.
CREATE INDEX "orders_pending_payment_expiry"
  ON "orders" ("reservation_expires_at")
  WHERE "status" = 'PENDING_PAYMENT';

-- Admin "active orders" board — the tabs the store watches all day.
CREATE INDEX "orders_active_board"
  ON "orders" ("store_id", "created_at" DESC)
  WHERE "status" IN (
    'ORDER_PLACED', 'STORE_ACCEPTED', 'PREPARING',
    'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'
  );

-- Notification outbox drain.
CREATE INDEX "notifications_queued"
  ON "notifications" ("created_at")
  WHERE "status" = 'QUEUED';

-- Unread badge count in the app.
CREATE INDEX "notifications_unread"
  ON "notifications" ("user_id")
  WHERE "read_at" IS NULL;

-- Payment reconciliation sweep: payments left hanging by an abandoned checkout.
CREATE INDEX "payments_unsettled"
  ON "payments" ("created_at")
  WHERE "status" IN ('CREATED', 'PENDING', 'AUTHORIZED');


-- -----------------------------------------------------------------------------
-- 4. Product search
-- -----------------------------------------------------------------------------

-- Trigram matching for typo tolerance: "asirvad" -> "Aashirvaad".
-- Real users type product names on a phone keyboard, frequently in a second
-- language, and exact matching fails constantly.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "products" ADD COLUMN "search_vector" tsvector;

-- 'simple' rather than 'english' is deliberate. The corpus is brand names and
-- Hindi transliterations — "Aashirvaad", "atta", "namkeen". English stemming
-- mangles those and provides nothing useful in return. Typo tolerance comes
-- from the trigram index below instead.
CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."search_vector" :=
      setweight(to_tsvector('simple', coalesce(NEW."name", '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW."name_hi", '')), 'A')
    || setweight(
         to_tsvector(
           'simple',
           array_to_string(coalesce(NEW."search_keywords", ARRAY[]::text[]), ' ')
         ),
         'B'
       )
    || setweight(to_tsvector('simple', coalesce(NEW."description", '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_vector_trigger
  BEFORE INSERT OR UPDATE OF "name", "name_hi", "search_keywords", "description"
  ON "products"
  FOR EACH ROW
  EXECUTE FUNCTION products_search_vector_update();

-- Backfill any rows that already exist (none on a fresh database, but this
-- migration must also be correct when applied to a populated one).
UPDATE "products" SET "name" = "name";

CREATE INDEX "products_search_vector_idx"
  ON "products" USING GIN ("search_vector");

CREATE INDEX "products_name_trgm_idx"
  ON "products" USING GIN ("name" gin_trgm_ops);

CREATE INDEX "brands_name_trgm_idx"
  ON "brands" USING GIN ("name" gin_trgm_ops);
