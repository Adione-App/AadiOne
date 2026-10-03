/**
 * Reference seed — runs in EVERY environment, including production.
 *
 * Idempotent by construction: every write is an upsert keyed on a natural key,
 * so re-running never duplicates and never clobbers a value an admin has since
 * changed through the panel (except where noted).
 *
 * Contains: business configuration and the bootstrap admin login. No seller
 * and no category tree — sellers (Aadione included) are created by admin and
 * own their categories and products.
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import {
  CONFIG_DEFAULTS,
  CONFIG_DESCRIPTIONS,
  ConfigKey,
  PUBLIC_CONFIG_KEYS,
  UserRole,
} from '../../src/shared';
import { hashPassword } from '../../src/common/crypto';

/**
 * Writes a GLOBAL configuration row (store_id IS NULL).
 *
 * Find-then-write rather than `upsert`, because Prisma cannot target a
 * compound unique that contains a NULL. Uniqueness is still guaranteed by the
 * partial index `configurations_global_key_unique` — see the
 * null_scope_unique migration.
 *
 * Existing rows keep their VALUE: re-running the seed must never revert a
 * radius or a delivery fee the owner has since tuned in the admin panel. Only
 * the description and visibility flag are refreshed.
 */
async function upsertGlobalConfig(
  prisma: PrismaClient,
  key: ConfigKey,
  value: unknown,
  options: { fillIfBlank?: boolean } = {},
): Promise<void> {
  const isPublic = (PUBLIC_CONFIG_KEYS as readonly string[]).includes(key);
  const description = CONFIG_DESCRIPTIONS[key];

  const existing = await prisma.configuration.findFirst({
    where: { key, sellerId: null },
    select: { id: true, value: true },
  });

  if (existing) {
    // `fillIfBlank` covers keys that are seeded twice: CONFIG_DEFAULTS writes a
    // deliberately empty placeholder (SUPPORT_PHONE has no sensible default),
    // and the store seed then supplies the real value. Without this, the empty
    // string would win and Help & Support would show no contact number.
    // A value the owner has actually set is still never overwritten.
    const isBlank = existing.value === null || existing.value === '';
    const shouldFill = options.fillIfBlank === true && isBlank;

    await prisma.configuration.update({
      where: { id: existing.id },
      data: {
        description,
        isPublic,
        ...(shouldFill ? { value: value as Prisma.InputJsonValue } : {}),
      },
    });
    return;
  }

  await prisma.configuration.create({
    data: {
      key,
      sellerId: null,
      value: value as Prisma.InputJsonValue,
      description,
      isPublic,
    },
  });
}

export async function seedConfiguration(prisma: PrismaClient): Promise<void> {
  const entries = Object.entries(CONFIG_DEFAULTS) as [ConfigKey, unknown][];

  for (const [key, value] of entries) {
    await upsertGlobalConfig(prisma, key, value);
  }

  console.log(`  ✓ configuration: ${entries.length} keys`);
}

export async function seedAdminUser(
  prisma: PrismaClient,
  input: { email: string; password: string; name: string },
): Promise<void> {
  const existing = await prisma.user.findFirst({
    where: { email: input.email.toLowerCase() },
  });

  if (existing) {
    console.log(`  ✓ admin user already present: ${input.email}`);
    return;
  }

  // The admin row still needs a mobile (the column is unique and NOT NULL, as
  // mobile is the identity for every customer). A reserved non-dialable value
  // is used so it can never collide with a real Indian number.
  await prisma.user.create({
    data: {
      mobile: '0000000001',
      email: input.email.toLowerCase(),
      fullName: input.name,
      passwordHash: await hashPassword(input.password),
      role: UserRole.ADMIN,
    },
  });

  console.log(`  ✓ admin user: ${input.email}  (CHANGE THIS PASSWORD AFTER FIRST LOGIN)`);
}
