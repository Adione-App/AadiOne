/**
 * Per-test-file setup. Must run before anything imports `src/config/env`.
 *
 * Configuration comes from `.env.test` only (never `backend/.env`), values
 * already set on the command line or by CI win, and an unsafe environment
 * stops the run before any test touches a service (tests/test-env.ts).
 */

import { beforeAll } from 'vitest';
import { approvedSettings, assertSafeTestEnv, loadTestEnv, removeUnapprovedSettings } from './test-env';

loadTestEnv();
assertSafeTestEnv();
const approved = approvedSettings();

// Importing the app creates its Prisma client, and Prisma then loads
// `backend/.env` into process.env by itself (tests/test-env.ts). Before any
// test runs, drop whatever it added and check the environment again.
beforeAll(() => {
  removeUnapprovedSettings(approved);
  assertSafeTestEnv();
});
