-- V2: a banner / top card can open the Food section (restaurants and cafes).
--
-- Additive: one new value of the BannerActionType enum, and the banners
-- check that ties action_value to action_type widened to it. FOOD carries no
-- target value (action_value NULL), like NONE. No row changes: every existing
-- banner already satisfies the new check (it only ADDS FOOD to the
-- no-target types).
--
-- The check compares action_type::text, so it does not use the new enum
-- value as a constant in the same transaction that adds it (Postgres refuses
-- that).
--
-- ROLLBACK: move FOOD banners to NONE (UPDATE banners SET action_type = 'NONE'
-- WHERE action_type = 'FOOD'), restore the previous check
--   CHECK (("action_type" = 'NONE') = ("action_value" IS NULL))
-- and leave the unused enum value in place (Postgres cannot drop one).

-- A brief lock on banners for the constraint swap; fail fast rather than queue live traffic.
SET LOCAL lock_timeout = '5s';

ALTER TYPE "BannerActionType" ADD VALUE IF NOT EXISTS 'FOOD';

ALTER TABLE "banners"
  DROP CONSTRAINT "banners_action_value_matches_type",
  ADD CONSTRAINT "banners_action_value_matches_type"
    CHECK (("action_type"::text IN ('NONE', 'FOOD')) = ("action_value" IS NULL));
