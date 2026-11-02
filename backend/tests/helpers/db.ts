/**
 * Test database helpers.
 */

import { prisma } from '../../src/infra/db/prisma';

/**
 * Empties every table in one statement.
 *
 * TRUNCATE … CASCADE rather than deleting per table: it is far faster, it does
 * not care about foreign-key ordering, and RESTART IDENTITY leaves sequences
 * clean so tests never depend on ids left over from a previous case.
 *
 * `_prisma_migrations` is excluded — wiping it would make Prisma think the
 * database is unmigrated.
 */
/**
 * Last line of defence.
 *
 * Asks the CONNECTION which database it is actually attached to, rather than
 * trusting configuration. Environment loading can go wrong — it did once, and
 * truncated the development database — so this verifies the real target
 * immediately before issuing a destructive statement.
 */
async function assertTestDatabase(): Promise<void> {
  const [row] = await prisma.$queryRaw<{ current_database: string }[]>`
    SELECT current_database()`;
  const name = row?.current_database ?? '';

  if (!name.endsWith('_test')) {
    throw new Error(
      `REFUSING TO TRUNCATE: connected to "${name}", which is not a *_test database. ` +
        'Check backend/.env.test and that NODE_ENV=test.',
    );
  }
}

export async function truncateAll(): Promise<void> {
  await assertTestDatabase();

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

  // The admin's service location — the centre of the delivery area
  // (seller.service checkServiceability) — at the point the tests' stores
  // use (fixtures STORE_COORDS), so customer distances keep their meaning.
  // Tests about the area itself change or clear it.
  await prisma.configuration.create({
    data: { key: 'PLATFORM_LOCATION', value: TEST_SERVICE_LOCATION },
  });
  // The admin-approved delivery villages (village + its PIN) the tests'
  // addresses use. Tests about the list itself change it.
  await prisma.configuration.create({
    data: { key: 'DELIVERY_LOCATIONS', value: TEST_DELIVERY_LOCATIONS },
  });
}

/** The approved village + PIN pairs every test starts with. */
export const TEST_DELIVERY_LOCATIONS = [
  { id: 'sikar', village: 'Sikar', pincode: '332001', active: true },
  { id: 'palsana', village: 'Palsana', pincode: '332402', active: true },
  { id: 'kuraj', village: 'Kuraj', pincode: '313328', active: true },
  { id: 'railmagra', village: 'Railmagra', pincode: '313329', active: true },
  { id: 'jaipur', village: 'Jaipur', pincode: '302017', active: true },
];

/** The service location every test starts with (Sikar — fixtures STORE_COORDS). */
export const TEST_SERVICE_LOCATION = {
  name: 'Test service location',
  addressLine: 'Main Road, Sikar',
  landmark: null,
  latitude: 27.6094,
  longitude: 75.1399,
};

export { prisma };
