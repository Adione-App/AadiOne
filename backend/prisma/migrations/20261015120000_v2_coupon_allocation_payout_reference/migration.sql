-- Aadione-funded coupon accounting + payout references.
--
-- ADDITIVE ONLY. Two integer columns default to 0 (a metadata-only default on
-- Postgres 11+, no table rewrite) and one nullable column; nothing is
-- dropped, renamed or retyped, and existing reads are unchanged.
--
--   order_items.coupon_discount_paise   this line's share of the order's
--                                       coupon (proportional to
--                                       line_total_paise, largest remainder)
--   seller_orders.coupon_discount_paise exact sum of its lines' shares
--   seller_settlements.payout_reference bank/UPI reference of a PAID payout
--
-- The coupon is Aadione's expense: these shares never reduce what a seller
-- is paid (subtotal_paise - commission_paise). They are what the customer did
-- NOT pay for each portion, so cancelling a portion refunds
-- subtotal_paise - coupon_discount_paise, never the pre-coupon subtotal.
--
-- DEPLOYMENT ORDER: apply this migration BEFORE the code that reads these
-- columns is deployed (Railway does not run migrations).

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "coupon_discount_paise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "seller_orders" ADD COLUMN "coupon_discount_paise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "seller_settlements" ADD COLUMN "payout_reference" VARCHAR(80);

-- BACKFILL: orders placed with a coupon before this migration. Same rule as
-- the application (order.service.ts / coupon-allocation.ts): each line gets
-- floor(coupon * line / lines_total), and the paise left over go one each to
-- the lines with the largest remainders. Ties are broken by the line id here
-- (the application, allocating before ids exist, breaks them by line order);
-- either way the shares are deterministic and sum EXACTLY to the coupon.
-- Idempotent: only orders whose lines are all still unallocated are touched.
WITH lines AS (
  SELECT oi.id,
         o.id                                   AS order_id,
         o.coupon_discount_paise::bigint        AS coupon,
         oi.line_total_paise::bigint            AS line,
         SUM(oi.line_total_paise::bigint) OVER (PARTITION BY o.id) AS lines_total
  FROM order_items oi
  JOIN seller_orders so ON so.id = oi.seller_order_id
  JOIN orders o ON o.id = so.order_id
  WHERE o.coupon_discount_paise > 0
    AND NOT EXISTS (
      SELECT 1 FROM order_items oi2
      JOIN seller_orders so2 ON so2.id = oi2.seller_order_id
      WHERE so2.order_id = o.id AND oi2.coupon_discount_paise <> 0
    )
), shares AS (
  SELECT id, order_id, coupon,
         (coupon * line) / lines_total AS base,
         (coupon * line) % lines_total AS remainder
  FROM lines
  WHERE lines_total > 0
), ranked AS (
  SELECT id, base,
         coupon - SUM(base) OVER (PARTITION BY order_id) AS leftover,
         ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY remainder DESC, id ASC) AS rank
  FROM shares
)
UPDATE order_items oi
SET coupon_discount_paise = (ranked.base + CASE WHEN ranked.rank <= ranked.leftover THEN 1 ELSE 0 END)::int
FROM ranked
WHERE oi.id = ranked.id;

UPDATE seller_orders so
SET coupon_discount_paise = s.share
FROM (
  SELECT seller_order_id, SUM(coupon_discount_paise)::int AS share
  FROM order_items
  GROUP BY seller_order_id
) s
WHERE so.id = s.seller_order_id AND s.share > 0 AND so.coupon_discount_paise = 0;

-- A share can never be negative or exceed what it is a share of.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_coupon_discount_range"
  CHECK ("coupon_discount_paise" >= 0 AND "coupon_discount_paise" <= "line_total_paise");
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_coupon_discount_range"
  CHECK ("coupon_discount_paise" >= 0 AND "coupon_discount_paise" <= "subtotal_paise");
