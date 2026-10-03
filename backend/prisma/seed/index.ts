/**
 * Seed entry point.
 *
 *   npm run db:seed
 *
 * Two tiers:
 *   REFERENCE — configuration and the bootstrap admin login.
 *               Runs in every environment, including production. Idempotent.
 *   DEMO      — sample coupons and delivery agents. Skipped in production.
 *
 * No seller and no catalogue is seeded: every seller — Aadione included — is
 * created by admin (Sellers → Add seller) and builds its own categories and
 * products in the Seller Panel.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';

// Explicit environment selector (see src/config/env.ts's own copy of this
// comment) — set by `scripts/with-env.mjs` for `db:seed:v2`. When present,
// load ONLY that file, never V1's `.env`. Unset, behavior is unchanged.
const envFileOverride = process.env['ENV_FILE'];

if (envFileOverride) {
  const selectedEnv = path.resolve(__dirname, '../..', envFileOverride);

  if (!fs.existsSync(selectedEnv)) {
    console.error(
      `\nENV_FILE=${envFileOverride} was set but backend/${envFileOverride} was not found.\n`,
    );
    process.exit(1);
  }

  dotenv.config({ path: selectedEnv, override: true });
} else {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
  dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
}

import { seedAdminUser, seedConfiguration } from './reference';
import { seedDemoData } from './demo';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const isProduction = nodeEnv === 'production';

  console.log(`\nAdiOne seed — environment: ${nodeEnv}\n`);

  console.log('Reference data');
  await seedConfiguration(prisma);
  await seedAdminUser(prisma, {
    email: process.env['ADMIN_EMAIL'] ?? 'owner@adione.in',
    password: process.env['ADMIN_PASSWORD'] ?? 'ChangeMe@123',
    name: process.env['ADMIN_NAME'] ?? 'Store Owner',
  });

  if (isProduction) {
    console.log('\nDemo data skipped (NODE_ENV=production).');
  } else {
    console.log('\nDemo data');
    await seedDemoData(prisma);
  }

  console.log('\nSeed complete.\n');
}

main()
  .catch((error) => {
    console.error('\nSeed failed:\n', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
