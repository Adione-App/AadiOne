-- Harden Supabase Data API (PostgREST) permissions on every application table.
--
-- WHY: the V2 database is a Supabase project, and Supabase publishes the
-- `public` schema over its REST Data API to the `anon` and `authenticated`
-- roles. No migration ever enabled Row-Level Security, so table access for
-- those roles rested on grants alone. The production audit (2026-10-21) found
-- NO read/write grants for them (no SELECT/INSERT/UPDATE/DELETE on any table)
-- — only TRUNCATE/REFERENCES/TRIGGER/MAINTAIN from Supabase's default
-- privileges, which the Data API cannot use. So this is defence-in-depth, not
-- the closing of a live exposure: with RLS on and the remaining privileges
-- revoked, a grant added by mistake later still exposes nothing.
--
-- Aadione never uses the Data API: the mobile app, web panels and admin only
-- talk to the backend, which connects as the table OWNER (Prisma). Row-Level
-- Security does not apply to a table's owner (it is not FORCEd here), so the
-- backend is unaffected; the Data API roles are denied.
--
--   1. RLS ON for every table in `public`, with NO policies: deny-all for any
--      role that is not the owner (or BYPASSRLS, e.g. Supabase service_role).
--   2. Revoke every privilege the Data API roles hold on `public` tables,
--      sequences and functions, and the default privileges that would grant
--      them access to tables created later. Only where those roles exist
--      (Supabase) — plain PostgreSQL (local, CI) has no such roles.
--
-- Additive and reversible; no data changes. ROLLBACK:
--   ALTER TABLE public.<each table> DISABLE ROW LEVEL SECURITY;  (and re-grant)
-- A new table in a later migration must `ENABLE ROW LEVEL SECURITY` too —
-- tests/integration/database-security.test.ts fails until it does.

BEGIN;

-- ENABLE ROW LEVEL SECURITY needs a brief exclusive lock on each table, held
-- until COMMIT. Fail (and roll back, changing nothing) rather than queue live
-- traffic behind a long-running query; re-run when it is quiet.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

DO $$
DECLARE
  r text;
  f record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      -- Only the application's own functions: extension functions in public
      -- (pg_trgm) belong to the platform role and are not ours to change.
      FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.sig, r);
      END LOOP;
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
