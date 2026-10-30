-- V2: app-wide availability — global pauses and holidays.
--
-- Additive only: one enum and two NEW, EMPTY tables. No existing table or
-- row changes. With both tables empty (and the new configuration keys
-- PLATFORM_OPERATING_HOURS / PLATFORM_LOCATION absent, which read as "not
-- configured") the app behaves exactly as before: only ORDERING_ENABLED and
-- the sellers' own availability decide.
--
-- ORDER: apply this migration BEFORE deploying the code that reads these
-- tables (every order and cart request evaluates them).
--
-- ROLLBACK (after rolling the code back): DROP TABLE "platform_holidays";
-- DROP TABLE "platform_pauses"; DROP TYPE "PlatformPauseKind";

CREATE TYPE "PlatformPauseKind" AS ENUM ('IMMEDIATE', 'SCHEDULED', 'EMERGENCY');

CREATE TABLE "platform_pauses" (
    "id" UUID NOT NULL,
    "kind" "PlatformPauseKind" NOT NULL,
    "message" VARCHAR(200),
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_pauses_pkey" PRIMARY KEY ("id"),
    -- A window ends after it starts; a scheduled one always has an end.
    CONSTRAINT "platform_pauses_end_after_start" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
    CONSTRAINT "platform_pauses_scheduled_has_end" CHECK ("kind" <> 'SCHEDULED' OR "ends_at" IS NOT NULL)
);

CREATE INDEX "platform_pauses_starts_at_idx" ON "platform_pauses"("starts_at");

CREATE TABLE "platform_holidays" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "message" VARCHAR(200),
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_holidays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_holidays_end_not_before_start" CHECK ("end_date" >= "start_date")
);

CREATE INDEX "platform_holidays_end_date_idx" ON "platform_holidays"("end_date");

-- Same as every table since 20261021120000_v2_lock_down_supabase_data_api:
-- no access through the Supabase Data API (the backend's owner role bypasses RLS).
ALTER TABLE "platform_pauses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_holidays" ENABLE ROW LEVEL SECURITY;
