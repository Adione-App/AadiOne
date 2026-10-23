/**
 * The test suite's ONLY source of configuration, and the gate it must pass.
 *
 * Loading (tests/setup.ts, tests/global-setup.ts):
 *   - reads `backend/.env.test` and nothing else — never `backend/.env`, which
 *     holds real service credentials;
 *   - never overrides a variable that is already set: a value given on the
 *     command line or by CI wins over the file, instead of being silently
 *     replaced by it.
 *
 * Validation (fail closed, before any test or migration runs):
 *   - PostgreSQL and Redis only on this machine (or a host listed in
 *     TEST_SERVICE_HOSTS), the database named `*_test`;
 *   - every external service explicitly on its test stand-in (console OTP and
 *     e-mail and push, mock payments, local storage, Postgres search);
 *   - no real service credential present at all (SMS, push, S3, payment
 *     gateways, the Play-review account), no production URL, no Railway
 *     runtime;
 *   - JWT/OTP/admin secrets visibly test values.
 *
 * Problems are reported by KEY NAME only — a value is never printed.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';

const BACKEND_ROOT = resolve(__dirname, '..');
export const TEST_ENV_FILE = resolve(BACKEND_ROOT, '.env.test');
export const PRISMA_SCHEMA = resolve(BACKEND_ROOT, 'prisma', 'schema.prisma');
const PRISMA_CLI = resolve(BACKEND_ROOT, 'node_modules', 'prisma', 'build', 'index.js');

/**
 * Runs the Prisma CLI without letting it read any env file.
 *
 * Started from `backend/`, the CLI loads `backend/.env` (real credentials) into
 * its process. Started from a fresh empty folder with an absolute schema path,
 * there is no `.env` next to the schema or the working directory, so it uses
 * only the environment passed here. Fails closed if the CLI nevertheless
 * reports loading an env file (e.g. a stray `.env` in a parent folder).
 */
export function runPrismaCli(args: string[], env: Env, input?: string): { ok: boolean; output: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'adione-prisma-'));
  try {
    const run = spawnSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      input,
      encoding: 'utf8',
    });
    // Both streams; any credentials inside a URL are masked before anyone sees the text.
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/(\w+:\/\/)[^@\s/]*@/g, '$1***@');
    if (/Environment variables loaded from/i.test(output)) {
      throw new Error('Refusing to run tests: the Prisma CLI loaded an env file; it must use the test environment only.');
    }
    return { ok: run.status === 0, output };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

type Env = Record<string, string | undefined>;

/** Loads `.env.test` into `target` without overriding anything already set. */
export function loadTestEnv(target: Env = process.env, file: string = TEST_ENV_FILE): void {
  // vitest sets NODE_ENV=test itself; anything else is left for the validator to refuse.
  target['NODE_ENV'] ??= 'test';
  const result = dotenv.config({ path: file, override: false, processEnv: target as dotenv.DotenvPopulateInput, quiet: true });
  if (result.error) throw new Error(`Refusing to run tests: cannot read the test environment file (${file}).`);
}

/** Each external service and the only value a test run may give it. */
export const SAFE_STAND_INS = {
  OTP_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  NOTIFICATION_PROVIDER: 'console',
  PAYMENT_PROVIDER: 'mock',
  STORAGE_PROVIDER: 'local',
  SEARCH_PROVIDER: 'postgres',
} as const;

/** Real-service settings that must not exist in a test run at all. */
export const FORBIDDEN_KEYS = [
  'MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID', 'MSG91_SENDER_ID',
  'CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
  'UPI_VPA', 'UPI_PAYEE_NAME',
  'FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY',
  'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_PRIVATE_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  // The Play-review account signs in with a FIXED OTP (otp.service). Never active in tests.
  'PLAY_REVIEW_MOBILE', 'PLAY_REVIEW_OTP',
  'ALLOW_MEMORY_CACHE_IN_PRODUCTION',
  // A real deployment's image-folder key; tests use the default (JWT_SECRET's test value).
  'SELLER_IMAGE_FOLDER_KEY',
  // Selects another env file inside the app; tests use .env.test only.
  'ENV_FILE',
  // Present only on Railway; the app changes behaviour when it sees them.
  'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID',
] as const;

/** Secrets that must visibly be test values (each production one would not contain "test"). */
const TEST_MARKED_SECRETS = ['JWT_SECRET', 'OTP_PEPPER', 'ADMIN_PASSWORD'] as const;

/** URL-valued settings: only local / reserved test hosts. */
const URL_KEYS = ['API_BASE_URL', 'STORAGE_PUBLIC_BASE_URL', 'SELLER_PANEL_URL'] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** RFC 2606/6761 names that can never be a real service. */
const RESERVED_TEST_TLD = /\.(test|example|invalid|localhost)$/i;
/** Hosted platforms a test run must never reach, even if listed in TEST_SERVICE_HOSTS. */
const PRODUCTION_HOST =
  /(^|\.)(adione\.in|supabase\.co|supabase\.com|pooler\.supabase\.com|railway\.app|rlwy\.net|railway\.internal|cashfree\.com|msg91\.com|googleapis\.com|amazonaws\.com|upstash\.io|redis-cloud\.com|redislabs\.com|neon\.tech|render\.com)$/i;

export interface TestEnvProblem {
  key: string;
  reason: string;
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function extraHosts(env: Env): Set<string> {
  return new Set(
    (env['TEST_SERVICE_HOSTS'] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Service hosts (database, Redis): this machine, or an explicitly allowed CI service name. */
function serviceHostProblem(host: string | null, env: Env): string | null {
  if (!host) return 'is not a valid URL';
  if (PRODUCTION_HOST.test(host)) return 'points at a hosted/production service';
  if (LOCAL_HOSTS.has(host) || extraHosts(env).has(host)) return null;
  return 'must be on this machine (localhost) or listed in TEST_SERVICE_HOSTS';
}

/** Every reason this environment is unsafe for tests; empty when it is safe. Never includes values. */
export function testEnvProblems(env: Env): TestEnvProblem[] {
  const problems: TestEnvProblem[] = [];
  const add = (key: string, reason: string) => problems.push({ key, reason });
  const isSet = (key: string) => (env[key] ?? '').trim() !== '';

  if (env['NODE_ENV'] !== 'test') add('NODE_ENV', 'must be "test"');

  // Database: PostgreSQL on this machine, a *_test database.
  const databaseUrl = env['DATABASE_URL'] ?? '';
  if (!databaseUrl) add('DATABASE_URL', 'is missing');
  else {
    if (!/^postgres(ql)?:\/\//.test(databaseUrl)) add('DATABASE_URL', 'must be a PostgreSQL URL');
    const hostProblem = serviceHostProblem(hostOf(databaseUrl), env);
    if (hostProblem) add('DATABASE_URL', hostProblem);
    let name = '';
    try {
      name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
    } catch {
      /* reported above */
    }
    if (!/_test$/.test(name)) add('DATABASE_URL', 'database name must end in "_test"');
  }

  // Redis: off, or an explicitly selected isolated local instance.
  const redisOn = ['true', '1', 'yes'].includes((env['REDIS'] ?? '').trim().toLowerCase());
  if (redisOn && !isSet('REDIS_URL')) add('REDIS_URL', 'is required when REDIS=true');
  if (isSet('REDIS_URL')) {
    const hostProblem = serviceHostProblem(hostOf(env['REDIS_URL']!), env);
    if (hostProblem) add('REDIS_URL', hostProblem);
  }

  // Every external service on its test stand-in, stated explicitly.
  for (const [key, safe] of Object.entries(SAFE_STAND_INS)) {
    if (env[key] !== safe) add(key, `must be explicitly "${safe}" in tests`);
  }
  if (isSet('CASHFREE_ENV') && env['CASHFREE_ENV'] !== 'sandbox') add('CASHFREE_ENV', 'must not select live payments');

  for (const key of FORBIDDEN_KEYS) {
    if (isSet(key)) add(key, 'must not be set in a test run (real service setting)');
  }

  for (const key of TEST_MARKED_SECRETS) {
    if (!isSet(key)) add(key, 'is missing');
    else if (!/test/i.test(env[key]!)) add(key, 'does not look like a test value');
  }
  if (isSet('ADMIN_EMAIL') && !RESERVED_TEST_TLD.test((env['ADMIN_EMAIL'] ?? '').split('@')[1] ?? '')) {
    add('ADMIN_EMAIL', 'must use a reserved test domain (e.g. @adione.test)');
  }

  for (const key of URL_KEYS) {
    if (!isSet(key)) continue;
    const host = hostOf(env[key]!);
    if (!host || !(LOCAL_HOSTS.has(host) || RESERVED_TEST_TLD.test(host))) add(key, 'must be a localhost or reserved test URL');
  }
  for (const origin of (env['CORS_ORIGINS'] ?? '').split(',').map((o) => o.trim()).filter(Boolean)) {
    const host = hostOf(origin);
    if (!host || !(LOCAL_HOSTS.has(host) || RESERVED_TEST_TLD.test(host))) {
      add('CORS_ORIGINS', 'must list only localhost or reserved test origins');
      break;
    }
  }

  return problems;
}

/**
 * Settings that configure the app or one of its services — what a stray load
 * of `backend/.env` adds. Anything else in the environment (system, vitest,
 * CI) is never touched.
 */
const APP_SETTING =
  /^(NODE_ENV|PORT|API_BASE_URL|LOG_LEVEL|DATABASE_URL|REDIS|REDIS_URL|ALLOW_MEMORY_CACHE_IN_PRODUCTION|JWT_[A-Z0-9_]+|OTP_[A-Z0-9_]+|PLAY_REVIEW_[A-Z0-9_]+|CORS_ORIGINS|MSG91_[A-Z0-9_]+|PAYMENT_PROVIDER|CASHFREE_[A-Z0-9_]+|RAZORPAY_[A-Z0-9_]+|UPI_[A-Z0-9_]+|EMAIL_[A-Z0-9_]+|SELLER_PANEL_URL|PASSWORD_RESET_TTL_MINUTES|NOTIFICATION_PROVIDER|FCM_[A-Z0-9_]+|STORAGE_[A-Z0-9_]+|S3_[A-Z0-9_]+|IMAGE_OPTIMIZE|PRODUCT_IMPORT_[A-Z0-9_]+|SEARCH_PROVIDER|ADMIN_[A-Z0-9_]+|ENV_FILE|RAILWAY_[A-Z0-9_]+)$/;

/** The app settings present now — taken right after the environment passed the gate. */
export function approvedSettings(env: Env = process.env): ReadonlySet<string> {
  return new Set(Object.keys(env).filter((key) => APP_SETTING.test(key)));
}

/**
 * Removes every app setting that was not in the approved environment and
 * returns the KEY NAMES removed.
 *
 * Why: Prisma's generated client loads `backend/.env` into process.env (never
 * overriding a set value) each time a client is created, and has no switch to
 * turn that off. The app's own config is parsed before that happens, but the
 * real credentials would otherwise stay in the test process — readable by
 * later code and inherited by any child process a test starts.
 */
export function removeUnapprovedSettings(approved: ReadonlySet<string>, env: Env = process.env): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (APP_SETTING.test(key) && !approved.has(key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/** Throws (naming keys, never values) unless the environment is safe for tests. */
export function assertSafeTestEnv(env: Env = process.env): void {
  const problems = testEnvProblems(env);
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  - ${p.key}: ${p.reason}`).join('\n');
  throw new Error(
    `Refusing to run tests: the test environment is not safe.\n${lines}\n` +
      'Tests read backend/.env.test only; a variable set on the command line or in CI takes precedence over it.',
  );
}
