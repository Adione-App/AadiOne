/**
 * The test-environment gate (tests/test-env.ts): tests read `.env.test` only,
 * command-line/CI values win over it, and an environment that could reach a
 * real service — production URLs, real credentials, live payments, a
 * non-local database or Redis, the Play-review account — is refused before
 * anything runs. Errors name keys only, never values.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import { env as appEnv } from '../../src/config/env';
// Creating the app's Prisma client makes Prisma load backend/.env into this
// worker's process.env — the leak the setup must clean up before tests run.
import { prisma } from '../../src/infra/db/prisma';
import {
  FORBIDDEN_KEYS,
  PRISMA_SCHEMA,
  SAFE_STAND_INS,
  approvedSettings,
  assertSafeTestEnv,
  loadTestEnv,
  removeUnapprovedSettings,
  runPrismaCli,
  testEnvProblems,
} from '../test-env';

/** A valid test environment, built from fake values only. */
function safeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres@localhost:55432/adione_test',
    REDIS: 'false',
    JWT_SECRET: 'test-jwt-secret-0123456789-0123456789',
    OTP_PEPPER: 'test-otp-pepper-0123456789-0123456789',
    ADMIN_PASSWORD: 'TestAdmin@123',
    ADMIN_EMAIL: 'owner@adione.test',
    CORS_ORIGINS: 'http://localhost:5173',
    ...SAFE_STAND_INS,
    ...overrides,
  };
}

const keysOf = (env: Record<string, string | undefined>) => testEnvProblems(env).map((p) => p.key);

describe('test environment gate — accepts', () => {
  it('a valid local test environment', () => {
    expect(testEnvProblems(safeEnv())).toEqual([]);
  });

  it('the environment this very run is using (loaded from .env.test only)', () => {
    expect(testEnvProblems(process.env)).toEqual([]);
  });

  it('an explicitly selected isolated local Redis', () => {
    expect(testEnvProblems(safeEnv({ REDIS: 'true', REDIS_URL: 'redis://:pw@127.0.0.1:56379' }))).toEqual([]);
    expect(testEnvProblems(safeEnv({ REDIS: 'true', REDIS_URL: 'redis://localhost:6390' }))).toEqual([]);
  });

  it('a CI service host only when explicitly listed in TEST_SERVICE_HOSTS', () => {
    const ci = { DATABASE_URL: 'postgresql://postgres@postgres:5432/adione_test' };
    expect(keysOf(safeEnv(ci))).toContain('DATABASE_URL');
    expect(testEnvProblems(safeEnv({ ...ci, TEST_SERVICE_HOSTS: 'postgres' }))).toEqual([]);
  });
});

describe('test environment gate — refuses', () => {
  it.each([
    ['a hosted (Supabase pooler) database', { DATABASE_URL: 'postgresql://postgres.ref:pw@aws-0-ap-south-1.pooler.supabase.com:5432/adione_test' }],
    ['a production database name', { DATABASE_URL: 'postgresql://postgres@localhost:5432/postgres' }],
    ['a non-local database host', { DATABASE_URL: 'postgresql://postgres@10.0.0.5:5432/adione_test' }],
    ['a missing database URL', { DATABASE_URL: undefined }],
  ])('%s', (_label, overrides) => {
    expect(keysOf(safeEnv(overrides))).toContain('DATABASE_URL');
  });

  it('a production domain even when listed in TEST_SERVICE_HOSTS', () => {
    expect(keysOf(safeEnv({
      DATABASE_URL: 'postgresql://p@db.abcdefgh.supabase.co:5432/adione_test',
      TEST_SERVICE_HOSTS: 'db.abcdefgh.supabase.co',
    }))).toContain('DATABASE_URL');
  });

  it('Redis on a remote / hosted host, or REDIS=true without a URL', () => {
    expect(keysOf(safeEnv({ REDIS: 'true', REDIS_URL: 'redis://default:pw@redis.railway.internal:6379' }))).toContain('REDIS_URL');
    expect(keysOf(safeEnv({ REDIS: 'true', REDIS_URL: 'rediss://x.upstash.io:6379' }))).toContain('REDIS_URL');
    expect(keysOf(safeEnv({ REDIS: 'true' }))).toContain('REDIS_URL');
    // A leftover remote REDIS_URL is refused even while Redis is off.
    expect(keysOf(safeEnv({ REDIS_URL: 'redis://10.1.2.3:6379' }))).toContain('REDIS_URL');
  });

  it.each(Object.keys(SAFE_STAND_INS))('%s set to a real service, or left implicit', (key) => {
    expect(keysOf(safeEnv({ [key]: 'msg91' }))).toContain(key);
    expect(keysOf(safeEnv({ [key]: undefined }))).toContain(key);
  });

  it('live payment configuration', () => {
    expect(keysOf(safeEnv({ PAYMENT_PROVIDER: 'cashfree' }))).toContain('PAYMENT_PROVIDER');
    expect(keysOf(safeEnv({ CASHFREE_ENV: 'production' }))).toContain('CASHFREE_ENV');
  });

  it.each(FORBIDDEN_KEYS)('any value for %s (real service setting)', (key) => {
    expect(keysOf(safeEnv({ [key]: 'x' }))).toContain(key);
  });

  it('the Play-review account (its fixed OTP path is never active in tests)', () => {
    const problems = keysOf(safeEnv({ PLAY_REVIEW_MOBILE: '9000000001', PLAY_REVIEW_OTP: '424242' }));
    expect(problems).toEqual(expect.arrayContaining(['PLAY_REVIEW_MOBILE', 'PLAY_REVIEW_OTP']));
  });

  it('secrets that are not visibly test values', () => {
    expect(keysOf(safeEnv({ JWT_SECRET: 'a-real-looking-signing-key-0123456789abcdef' }))).toContain('JWT_SECRET');
    expect(keysOf(safeEnv({ OTP_PEPPER: undefined }))).toContain('OTP_PEPPER');
    expect(keysOf(safeEnv({ ADMIN_EMAIL: 'owner@adione.in' }))).toContain('ADMIN_EMAIL');
  });

  it('production URLs', () => {
    expect(keysOf(safeEnv({ API_BASE_URL: 'https://api.adione.in' }))).toContain('API_BASE_URL');
    expect(keysOf(safeEnv({ STORAGE_PUBLIC_BASE_URL: 'https://ref.supabase.co/storage/v1/object/public/b' }))).toContain('STORAGE_PUBLIC_BASE_URL');
    expect(keysOf(safeEnv({ CORS_ORIGINS: 'http://localhost:5173,https://admin.adione.in' }))).toContain('CORS_ORIGINS');
  });

  it('running inside Railway, or with another env file selected', () => {
    expect(keysOf(safeEnv({ RAILWAY_ENVIRONMENT_ID: 'x' }))).toContain('RAILWAY_ENVIRONMENT_ID');
    expect(keysOf(safeEnv({ ENV_FILE: '.env.v2' }))).toContain('ENV_FILE');
  });

  it('NODE_ENV other than test', () => {
    expect(keysOf(safeEnv({ NODE_ENV: 'production' }))).toContain('NODE_ENV');
  });

  it('fails closed with an error that names keys but NEVER prints a value', () => {
    const secret = 'sk_live_DO_NOT_PRINT_8f3a91';
    const dbPassword = 'pw-DO-NOT-PRINT-77';
    const unsafe = safeEnv({
      S3_SECRET_ACCESS_KEY: secret,
      FCM_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----${secret}`,
      DATABASE_URL: `postgresql://postgres.ref:${dbPassword}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
      JWT_SECRET: secret,
    });
    let message = '';
    try {
      assertSafeTestEnv(unsafe);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Refusing to run tests/);
    expect(message).toMatch(/S3_SECRET_ACCESS_KEY/);
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(dbPassword);
    expect(message).not.toContain('supabase.com');
  });
});

describe('loading: .env.test only, and command-line/CI values win', () => {
  const tempEnvFile = (body: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'adione-test-env-')), '.env.test');
    writeFileSync(file, body);
    return file;
  };

  it('a value already set (command line / CI) is NOT overridden by the file', () => {
    const target: Record<string, string | undefined> = { REDIS: 'true', REDIS_URL: 'redis://127.0.0.1:56379' };
    loadTestEnv(target, tempEnvFile('REDIS=false\nOTP_PROVIDER=console\n'));
    expect(target['REDIS']).toBe('true');
    expect(target['REDIS_URL']).toBe('redis://127.0.0.1:56379');
    expect(target['OTP_PROVIDER']).toBe('console'); // unset values come from the file
    expect(target['NODE_ENV']).toBe('test');
  });

  it('settings a stray .env load adds (as Prisma does) are removed; approved and unrelated variables are kept', () => {
    const target: Record<string, string | undefined> = { ...safeEnv(), PATH: '/usr/bin', VITEST_WORKER_ID: '1' };
    const approved = approvedSettings(target);
    const strayEnvFile = tempEnvFile(
      'FCM_PRIVATE_KEY=fake-key\nS3_SECRET_ACCESS_KEY=fake\nAPI_BASE_URL=https://api.adione.in\nOTP_PROVIDER=msg91\nUNRELATED_TOOL_SETTING=1\n',
    );
    // Prisma's behaviour: load the file without overriding values already set.
    dotenv.config({ path: strayEnvFile, processEnv: target as dotenv.DotenvPopulateInput, quiet: true });
    expect(target['FCM_PRIVATE_KEY']).toBe('fake-key');

    expect(removeUnapprovedSettings(approved, target).sort()).toEqual(['API_BASE_URL', 'FCM_PRIVATE_KEY', 'S3_SECRET_ACCESS_KEY']);
    expect(target['FCM_PRIVATE_KEY']).toBeUndefined();
    expect(target['OTP_PROVIDER']).toBe('console'); // approved value, never overridden
    expect(target['PATH']).toBe('/usr/bin');
    expect(target['UNRELATED_TOOL_SETTING']).toBe('1'); // not an app setting: left alone
    expect(testEnvProblems(target)).toEqual([]);
  });

  it('a missing test env file stops the run', () => {
    expect(() => loadTestEnv({}, join(tmpdir(), 'no-such-dir-xyz', '.env.test'))).toThrow(/cannot read the test environment file/);
  });

  it('no real service setting is present in this run — even after the app created its Prisma client', () => {
    expect(prisma).toBeDefined(); // constructed at import, which made Prisma load backend/.env
    for (const key of FORBIDDEN_KEYS) expect(process.env[key] ?? '').toBe('');
    expect(testEnvProblems(process.env)).toEqual([]);
  });

  it('a child process a test starts inherits no real service setting', () => {
    const probe = `const keys=${JSON.stringify(FORBIDDEN_KEYS)};process.stdout.write(JSON.stringify(keys.filter(k=>(process.env[k]??"")!=="")))`;
    const child = spawnSync(process.execPath, ['-e', probe], { env: process.env, encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([]); // key NAMES only — never values
  });

  it('the isolated Prisma CLI (migrations, database creation) reads no env file', () => {
    // runPrismaCli itself throws if Prisma reports loading any env file.
    const status = runPrismaCli(['migrate', 'status', `--schema=${PRISMA_SCHEMA}`], process.env);
    expect(status.ok).toBe(true);
    expect(status.output).toMatch(/up to date/i);
    expect(status.output).not.toMatch(/Environment variables loaded/i);
  });

  it('the app itself sees no Play-review account, so its fixed-OTP path is off', () => {
    expect(appEnv.PLAY_REVIEW_MOBILE).toBeUndefined();
    expect(appEnv.PLAY_REVIEW_OTP).toBeUndefined();
  });
});
