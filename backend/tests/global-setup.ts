/**
 * Runs ONCE before the whole suite.
 *
 * Creates the test database if it does not exist and brings it up to the
 * current V2 migration state (prisma-v2/schema.prisma + prisma-v2/migrations).
 *
 * Integration tests run against real PostgreSQL rather than a mocked client on
 * purpose: the properties that matter most in this system — row locks, CHECK
 * constraints, partial unique indexes, transaction rollback — exist only in
 * the database. A mock would pass while the real thing overselas stock.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

const backendRoot = resolve(__dirname, '..');

export default async function globalSetup(): Promise<void> {
  process.env['NODE_ENV'] = 'test';
  dotenv.config({ path: resolve(backendRoot, '.env'), override: true });
  dotenv.config({ path: resolve(backendRoot, '.env.test'), override: true });

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL missing — is .env.test present?');

  if (!databaseUrl.includes('_test')) {
    // Hard stop. The suite truncates tables; running it against a development
    // or production database would destroy real data.
    throw new Error(
      `Refusing to run tests: DATABASE_URL does not point at a *_test database (${databaseUrl})`,
    );
  }

  await ensureDatabaseExists(databaseUrl);

  const env = { ...process.env, DATABASE_URL: databaseUrl };

  // V2 only. A test database created from the V1 history (prisma/migrations)
  // is refused rather than migrated over — point .env.test at a separate V2
  // test database instead. execSync's error carries the guard's stderr.
  execSync('node scripts/assert-v2-database.mjs', { cwd: backendRoot, stdio: 'pipe', env });

  execSync('npx prisma migrate deploy --schema=prisma-v2/schema.prisma', {
    cwd: backendRoot,
    stdio: 'pipe',
    env,
  });
}

/**
 * `prisma migrate deploy` does not create a missing database, so connect to
 * the maintenance database and create it first.
 */
async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const targetDatabase = url.pathname.replace(/^\//, '');

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';

  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });

  try {
    const existing = await admin.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname = '${targetDatabase}'`,
    );
    if (existing.length === 0) {
      // CREATE DATABASE cannot be parameterised or run inside a transaction.
      // The name comes from our own .env.test, not from user input.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${targetDatabase}"`);
    }
  } finally {
    await admin.$disconnect();
  }
}
