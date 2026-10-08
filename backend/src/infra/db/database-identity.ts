/**
 * Startup guard: the API only ever runs against a migrated V2 database.
 *
 * The migration commands are already guarded (scripts/assert-v2-database.mjs),
 * but the server is not a migration command: on a machine whose backend/.env
 * still carries the V1 configuration, a plain `npm run dev` would boot the V2
 * API against the V1 database and start writing to it (jobs run at startup).
 * This check runs before the server listens or starts jobs, and refuses:
 *
 *   - a database with any V1 migration recorded (V1 history), or the V1-only
 *     `stores` table without the V2 `sellers` table;
 *   - a database without the V2 baseline migration (empty, or not migrated —
 *     run `prisma migrate deploy` first).
 */

import { prisma } from './prisma';

export const V2_BASELINE_MIGRATION = '20260926140446_v2_baseline';

/**
 * The frozen V1 history (prisma-v1-archive/migrations) — the same list as
 * KNOWN_V1_MIGRATIONS in scripts/assert-v2-database.mjs. The archive is not
 * part of the production image, so the names are built in.
 */
export const V1_MIGRATIONS: readonly string[] = [
  '20260814125023_init_core',
  '20260814125142_drop_indexes_replaced_by_partial',
  '20260814125200_hardening',
  '20260814130000_null_scope_unique',
  '20260814140000_add_mobile_verified_at',
  '20260814150000_category_slug_partial_unique',
  '20260923120000_add_referrals_and_reward_coupons',
];

export interface DatabaseFacts {
  hasMigrationsTable: boolean;
  hasV1StoresTable: boolean;
  hasV2SellersTable: boolean;
  /** Finished, not rolled back. */
  appliedMigrations: string[];
}

export type DatabaseIdentityCheck = { ok: true } | { ok: false; reason: 'V1_DATABASE' | 'NOT_MIGRATED'; message: string };

const HINT =
  'Point DATABASE_URL at a V2 database (for development: `npm run dev:v2`, which loads backend/.env.v2) ' +
  'and apply migrations with `npm run db:migrate:deploy:v2`.';

export function evaluateDatabaseIdentity(facts: DatabaseFacts): DatabaseIdentityCheck {
  const v1Applied = facts.appliedMigrations.filter((name) => V1_MIGRATIONS.includes(name));
  if (v1Applied.length > 0) {
    return {
      ok: false,
      reason: 'V1_DATABASE',
      message: `Refusing to start: the database carries V1 migration history (${v1Applied.join(', ')}). ${HINT}`,
    };
  }
  if (facts.hasV1StoresTable && !facts.hasV2SellersTable) {
    return {
      ok: false,
      reason: 'V1_DATABASE',
      message: `Refusing to start: the database has the V1 "stores" table and no V2 "sellers" table. ${HINT}`,
    };
  }
  if (!facts.hasMigrationsTable || !facts.appliedMigrations.includes(V2_BASELINE_MIGRATION)) {
    return {
      ok: false,
      reason: 'NOT_MIGRATED',
      message: `Refusing to start: the database has no V2 migration history (${V2_BASELINE_MIGRATION} not applied). ${HINT}`,
    };
  }
  return { ok: true };
}

export async function checkDatabaseIsV2(): Promise<DatabaseIdentityCheck> {
  const [tables] = await prisma.$queryRaw<{ migrations: string | null; v1_stores: string | null; v2_sellers: string | null }[]>`
    SELECT to_regclass('_prisma_migrations')::text AS migrations,
           to_regclass('stores')::text AS v1_stores,
           to_regclass('sellers')::text AS v2_sellers`;

  const applied = tables?.migrations
    ? await prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
    : [];

  return evaluateDatabaseIdentity({
    hasMigrationsTable: Boolean(tables?.migrations),
    hasV1StoresTable: Boolean(tables?.v1_stores),
    hasV2SellersTable: Boolean(tables?.v2_sellers),
    appliedMigrations: applied.map((row) => row.migration_name),
  });
}
