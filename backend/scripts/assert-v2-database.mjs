#!/usr/bin/env node
/**
 * Refuses to let a V2 Prisma command touch a V1 database.
 *
 * This codebase runs ONLY the V2 schema and migrations (prisma/). The V1
 * history, archived in prisma-v1-archive/migrations, must never be
 * applied here — and, just as important, the V2 migrations must never be
 * applied to a database that V1 created. `prisma migrate dev` against a V1
 * database offers to RESET it; `migrate deploy` half-applies the V2 baseline
 * and records a failed migration in it.
 *
 * Every script that changes a database's schema (migrate dev / deploy /
 * reset, db push), the test global setup and the production container run
 * this first. It exits non-zero when the target database:
 *
 *   - has any V1 migration (a folder name in prisma-v1-archive/migrations that
 *     is not in prisma/migrations) recorded in `_prisma_migrations`, or
 *   - has the V1-only `stores` table and no V2 `sellers` table.
 *
 * A database that does not exist yet, or is empty, passes — migrate dev /
 * deploy then builds it from the V2 history.
 *
 * Usage (DATABASE_URL from the environment, else backend/.env — the same
 * place the Prisma CLI reads it from):
 *   node scripts/assert-v2-database.mjs
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env["DATABASE_URL"]) {
  // Not overriding: a value from with-env.mjs, the shell or the container wins.
  config({ path: path.join(backendRoot, ".env") });
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl || !databaseUrl.trim()) {
  console.error("\n[assert-v2-database] DATABASE_URL is not set.\n");
  process.exit(1);
}

function migrationNames(dir) {
  const full = path.join(backendRoot, dir);
  if (!existsSync(full)) return new Set();
  return new Set(
    readdirSync(full, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

/**
 * The V1 history as of the V2 fork (origin/main 2a83477). Built in because the
 * production image deliberately does not contain prisma-v1-archive/; the
 * directory, when present, adds anything V1 gained since.
 */
const KNOWN_V1_MIGRATIONS = [
  "20260814125023_init_core",
  "20260814125142_drop_indexes_replaced_by_partial",
  "20260814125200_hardening",
  "20260814130000_null_scope_unique",
  "20260814140000_add_mobile_verified_at",
  "20260814150000_category_slug_partial_unique",
  "20260923120000_add_referrals_and_reward_coupons",
];

const v2Migrations = migrationNames("prisma/migrations");
const v1Only = [...new Set([...KNOWN_V1_MIGRATIONS, ...migrationNames("prisma-v1-archive/migrations")])].filter(
  (name) => !v2Migrations.has(name),
);

function describeTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function refuse(reason) {
  console.error(
    `\n[assert-v2-database] REFUSING: ${describeTarget(databaseUrl)} is a V1 database (${reason}).\n` +
      "V2 commands only run the prisma/ schema and migrations, and must not be pointed at a\n" +
      "database created from the V1 history (prisma-v1-archive/). Point DATABASE_URL (backend/.env,\n" +
      "backend/.env.v2 or backend/.env.test) at a separate V2 database.\n",
  );
  process.exit(1);
}

const { PrismaClient } = await import("@prisma/client");
const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

try {
  const [tables] = await client.$queryRawUnsafe(
    `SELECT to_regclass('_prisma_migrations')::text AS migrations,
            to_regclass('stores')::text AS v1_stores,
            to_regclass('sellers')::text AS v2_sellers`,
  );

  if (tables.migrations) {
    const applied = await client.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations`);
    const v1Applied = applied.map((row) => row.migration_name).filter((name) => v1Only.includes(name));
    if (v1Applied.length > 0) {
      refuse(`V1 migration${v1Applied.length > 1 ? "s" : ""} applied: ${v1Applied.join(", ")}`);
    }
  }

  if (tables.v1_stores && !tables.v2_sellers) {
    refuse('it has the V1 "stores" table and no V2 "sellers" table');
  }
} catch (error) {
  // P1003 / 3D000: the database does not exist yet — nothing V1 in it.
  const code = error?.errorCode ?? error?.code;
  const message = String(error?.message ?? error);
  if (code === "P1003" || (/does not exist/i.test(message) && /database/i.test(message))) {
    process.exit(0);
  }
  console.error(`\n[assert-v2-database] Could not inspect ${describeTarget(databaseUrl)}: ${message}\n`);
  process.exit(1);
} finally {
  await client.$disconnect();
}
