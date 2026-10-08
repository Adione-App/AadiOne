-- =============================================================================
-- V2 hardening
-- =============================================================================
--
-- WHY: the V2 baseline was generated from schema.prisma alone. Everything V1
-- enforced in hand-written migrations (CHECK constraints, partial UNIQUE
-- indexes, partial indexes — V1 `hardening`, `null_scope_unique`,
-- `category_slug_partial_unique`) therefore never existed in V2, although the
-- V2 schema's own comments and the V2 code (cart, addresses, delivery,
-- configuration, commission, back-in-stock, auth) still rely on them.
--
-- This migration restores the ones that still apply to the V2 marketplace
-- model, adapted to V2 table/column names and V2 semantics (e.g. one ACTIVE
-- cart per USER rather than per (user, store); root-category slugs unique per
-- SCOPE, since two restaurants may both have a "Starters" menu section).
-- Everything here is invisible to Prisma Client and inexpressible in
-- schema.prisma, so it is hand-written (docs/02-decisions.md D10).
--
-- Existing V2 dev data was audited against every rule before this migration;
-- the only violations (two seller_listings with negative reserved_qty, caused
-- by the since-fixed release-instead-of-restock bug in transitionSellerOrder)
-- were repaired beforehand with ledger-backed corrections, not here.
--
-- One transaction: Prisma Migrate does not add one, and a half-applied set of
-- constraints is worse than none.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. CHECK constraints
-- -----------------------------------------------------------------------------

-- Inventory: `reserved_qty <= stock_qty` is the last line of defence against
-- overselling — a bug that reserves or releases the wrong amount makes the
-- transaction fail instead of silently corrupting stock.
ALTER TABLE "seller_listings"
  ADD CONSTRAINT "seller_listings_price_lte_mrp"      CHECK ("price_paise" <= "mrp_paise"),
  ADD CONSTRAINT "seller_listings_money_nonneg"       CHECK ("price_paise" >= 0 AND "mrp_paise" >= 0),
  ADD CONSTRAINT "seller_listings_stock_nonneg"       CHECK ("stock_qty" >= 0),
  ADD CONSTRAINT "seller_listings_reserved_valid"     CHECK ("reserved_qty" >= 0 AND "reserved_qty" <= "stock_qty"),
  ADD CONSTRAINT "seller_listings_max_qty_positive"   CHECK ("max_qty_per_order" > 0),
  ADD CONSTRAINT "seller_listings_low_stock_nonneg"   CHECK ("low_stock_threshold" >= 0);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_qty_positive" CHECK ("qty" > 0);

-- Order snapshots. `orders.current_payable_paise` is deliberately NOT
-- constrained: with a coupon larger than the fees, cancelling every seller
-- portion legitimately takes it below zero until coupon allocation per seller
-- is defined — a CHECK would turn that open business question into failed
-- cancellations.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_qty_positive" CHECK ("qty" > 0),
  ADD CONSTRAINT "order_items_money_nonneg" CHECK (
    "unit_price_paise" >= 0 AND "mrp_paise" >= 0 AND "line_total_paise" >= 0 AND
    "line_discount_paise" >= 0 AND "tax_paise" >= 0 AND "commission_paise" >= 0
  ),
  ADD CONSTRAINT "order_items_commission_bp_range" CHECK ("commission_bp" BETWEEN 0 AND 10000);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_money_nonneg" CHECK (
    "items_subtotal_paise" >= 0 AND
    "item_discount_paise" >= 0 AND
    "coupon_discount_paise" >= 0 AND
    "delivery_fee_paise" >= 0 AND
    "platform_fee_paise" >= 0 AND
    "tax_paise" >= 0 AND
    "total_paise" >= 0
  );

-- V2's per-seller money snapshot (V1 kept these on `orders`).
ALTER TABLE "seller_orders"
  ADD CONSTRAINT "seller_orders_money_nonneg" CHECK (
    "items_subtotal_paise" >= 0 AND "item_discount_paise" >= 0 AND "tax_paise" >= 0 AND
    "subtotal_paise" >= 0 AND "commission_paise" >= 0
  ),
  ADD CONSTRAINT "seller_orders_commission_bp_range" CHECK ("commission_bp" BETWEEN 0 AND 10000);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_paise" > 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount_paise" > 0);

-- Coordinates must be real coordinates (the "GPS failed, client sent 0,0" bug).
ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_lat_range" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "addresses_lng_range" CHECK ("longitude" BETWEEN -180 AND 180);

-- V1 `stores` -> V2 `sellers`.
ALTER TABLE "sellers"
  ADD CONSTRAINT "sellers_lat_range" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "sellers_lng_range" CHECK ("longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "sellers_default_commission_range" CHECK ("default_commission_bp" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "sellers_settlement_cycle_positive" CHECK ("settlement_cycle_hours" > 0);

-- V1 `store_hours` -> V2 `seller_hours`.
ALTER TABLE "seller_hours"
  ADD CONSTRAINT "seller_hours_day_range" CHECK ("day_of_week" BETWEEN 0 AND 6);

ALTER TABLE "categories"
  ADD CONSTRAINT "categories_depth_nonneg" CHECK ("depth" >= 0),
  ADD CONSTRAINT "categories_not_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

ALTER TABLE "commission_rules"
  ADD CONSTRAINT "commission_rules_rate_range" CHECK ("rate_bp" BETWEEN 0 AND 10000);

ALTER TABLE "seller_settlements"
  ADD CONSTRAINT "seller_settlements_period_valid" CHECK ("period_start" < "period_end"),
  ADD CONSTRAINT "seller_settlements_money_nonneg" CHECK (
    "gross_sales_paise" >= 0 AND "commission_paise" >= 0 AND "net_payable_paise" >= 0
  );


-- -----------------------------------------------------------------------------
-- 2. Partial UNIQUE indexes — business rules the code already relies on
-- -----------------------------------------------------------------------------

-- Case-insensitive unique email (auth.repository.ts looks up by lower(email)).
-- NULL emails (most customers) are excluded.
CREATE UNIQUE INDEX "users_email_unique"
  ON "users" (lower("email"))
  WHERE "email" IS NOT NULL AND "deleted_at" IS NULL;

-- Exactly one default address per user (address.service.ts unsets the old
-- default before setting a new one, inside one transaction).
CREATE UNIQUE INDEX "addresses_one_default_per_user"
  ON "addresses" ("user_id")
  WHERE "is_default" AND "deleted_at" IS NULL;

-- One ACTIVE cart per user — V2's cart is seller-agnostic (V1: per user+store).
-- cart.service.ts's getOrCreateCart relies on this to make a concurrent
-- duplicate create fail rather than produce two live carts.
CREATE UNIQUE INDEX "carts_one_active_per_user"
  ON "carts" ("user_id")
  WHERE "status" = 'ACTIVE';

-- One live rider task per order (delivery.service.ts cancels the old task
-- before creating a new one). V1: delivery_assignments.
CREATE UNIQUE INDEX "delivery_tasks_one_active_per_order"
  ON "delivery_tasks" ("order_id")
  WHERE "status" <> 'CANCELLED';

-- One open back-in-stock subscription per (user, seller listing) — V2 keys it
-- on the listing, not the bare variant.
CREATE UNIQUE INDEX "back_in_stock_one_open_per_user_listing"
  ON "back_in_stock_subscriptions" ("user_id", "seller_listing_id")
  WHERE "notified_at" IS NULL;

-- NULL-scope uniqueness: (key, seller_id) is unique for per-seller rows, but
-- NULLs are distinct, so the GLOBAL row needs its own partial unique
-- (configuration.repository.ts's find-then-write upsert relies on it).
CREATE UNIQUE INDEX "configurations_global_key_unique"
  ON "configurations" ("key")
  WHERE "seller_id" IS NULL;

-- At most one ACTIVE commission rule per (seller, product) and per (seller,
-- category) — commission.service.ts's resolution keys on exactly that.
CREATE UNIQUE INDEX "commission_rules_one_active_per_product"
  ON "commission_rules" ("seller_id", "product_id")
  WHERE "is_active" AND "product_id" IS NOT NULL;

CREATE UNIQUE INDEX "commission_rules_one_active_per_category"
  ON "commission_rules" ("seller_id", "category_id")
  WHERE "is_active" AND "product_id" IS NULL AND "category_id" IS NOT NULL;

-- Root-category slugs, unique per SCOPE. V1's single "unique root slug" rule
-- would reject two restaurants both having a "Starters" menu section, so V2
-- splits it: once across the shared taxonomy, once within each seller's menu.
CREATE UNIQUE INDEX "categories_root_slug_unique_shared"
  ON "categories" ("slug")
  WHERE "parent_id" IS NULL AND "seller_id" IS NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "categories_root_slug_unique_per_seller"
  ON "categories" ("seller_id", "slug")
  WHERE "parent_id" IS NULL AND "seller_id" IS NOT NULL AND "deleted_at" IS NULL;

-- Child-category slugs: the plain (parent_id, slug) unique from schema.prisma
-- also counts soft-deleted rows, so a deleted subcategory's name could never
-- be reused (V1 fixed this in category_slug_partial_unique). Same name, same
-- columns — scoped to live, non-root rows.
DROP INDEX "categories_parent_id_slug_key";
CREATE UNIQUE INDEX "categories_parent_id_slug_key"
  ON "categories" ("parent_id", "slug")
  WHERE "parent_id" IS NOT NULL AND "deleted_at" IS NULL;


-- -----------------------------------------------------------------------------
-- 3. Partial indexes — the ones V2's schema comments name
-- -----------------------------------------------------------------------------

-- Staff/admin listing: a handful of rows among many customers.
CREATE INDEX "users_staff_roles"
  ON "users" ("role")
  WHERE "role" <> 'CUSTOMER';

-- Address list (addresses had no user index at all in the V2 baseline).
CREATE INDEX "addresses_user_active"
  ON "addresses" ("user_id")
  WHERE "deleted_at" IS NULL;

-- Category tree / Home category row.
CREATE INDEX "categories_active_tree"
  ON "categories" ("parent_id", "display_order")
  WHERE "is_active" AND "deleted_at" IS NULL;

-- "Can this be bought right now?" — out-of-stock rows are absent entirely.
CREATE INDEX "seller_listings_in_stock"
  ON "seller_listings" ("seller_id")
  WHERE "is_available" AND ("stock_qty" - "reserved_qty") > 0;

-- Low-stock report.
CREATE INDEX "seller_listings_low_stock"
  ON "seller_listings" ("seller_id", "stock_qty")
  WHERE ("stock_qty" - "reserved_qty") <= "low_stock_threshold";

-- Reservation-expiry job: O(orders awaiting payment), not O(order history).
CREATE INDEX "orders_pending_payment_expiry"
  ON "orders" ("reservation_expires_at")
  WHERE "status" = 'PENDING_PAYMENT';

-- Notification outbox drain.
CREATE INDEX "notifications_queued"
  ON "notifications" ("created_at")
  WHERE "status" = 'QUEUED';

COMMIT;
