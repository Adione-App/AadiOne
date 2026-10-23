/**
 * Runs ONCE before the whole suite.
 *
 * Creates the test database if it does not exist and brings it up to the
 * current V2 migration state (prisma/schema.prisma + prisma/migrations).
 *
 * Integration tests run against real PostgreSQL rather than a mocked client on
 * purpose: the properties that matter most in this system — row locks, CHECK
 * constraints, partial unique indexes, transaction rollback — exist only in
 * the database. A mock would pass while the real thing overselas stock.
 *
 * No Prisma CLIENT is created in this process: Prisma's generated client loads
 * `backend/.env` (real credentials) into process.env whenever one is created,
 * and the test workers inherit this process's environment. The database is
 * created and migrated through the Prisma CLI run in isolation instead
 * (tests/test-env.ts runPrismaCli), which reads no env file at all.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  PRISMA_SCHEMA,
  approvedSettings,
  assertSafeTestEnv,
  loadTestEnv,
  removeUnapprovedSettings,
  runPrismaCli,
} from './test-env';

const backendRoot = resolve(__dirname, '..');

export default async function globalSetup(): Promise<void> {
  // `.env.test` only, command line / CI values win, and a hard stop on an
  // unsafe environment — before the database is created, migrated or
  // truncated (tests/test-env.ts: local *_test database, test stand-ins for
  // every external service, no real credentials).
  loadTestEnv();
  assertSafeTestEnv();
  const approved = approvedSettings();

  const databaseUrl = process.env['DATABASE_URL']!;
  const env = { ...process.env, DATABASE_URL: databaseUrl };

  ensureDatabaseExists(databaseUrl, env);

  // V2 only. A test database created from the V1 history (prisma-v1-archive/)
  // is refused rather than migrated over — point .env.test at a separate V2
  // test database instead. execSync's error carries the guard's stderr.
  // (This guard is a separate process that uses Prisma's client, so Prisma
  // loads backend/.env inside THAT short-lived process; it prints only host,
  // database and migration names, and nothing it loads comes back here.)
  execSync('node scripts/assert-v2-database.mjs', { cwd: backendRoot, stdio: 'pipe', env });

  const migrated = runPrismaCli(['migrate', 'deploy', `--schema=${PRISMA_SCHEMA}`], env);
  if (!migrated.ok) throw new Error(`prisma migrate deploy failed:\n${migrated.output}`);

  // Defence in depth: whatever ran above, the workers start from the approved environment only.
  removeUnapprovedSettings(approved);
  assertSafeTestEnv();
}

/**
 * `prisma migrate deploy` does not create a missing database, so create it
 * first through the maintenance database. An existing database is fine.
 */
function ensureDatabaseExists(databaseUrl: string, env: Record<string, string | undefined>): void {
  // Already validated: a local database whose name ends in "_test".
  const targetDatabase = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';

  // CREATE DATABASE cannot be parameterised or run inside a transaction. The
  // name comes from the validated test environment, quoted as an identifier.
  const created = runPrismaCli(
    ['db', 'execute', '--url', adminUrl.toString(), '--stdin'],
    env,
    `CREATE DATABASE "${targetDatabase.replace(/"/g, '""')}";`,
  );
  if (!created.ok && !/already exists/i.test(created.output)) {
    throw new Error(`could not create the test database:\n${created.output}`);
  }
}
