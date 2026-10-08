/**
 * V2 production cleanup — removes the pre-launch test/demo operational data
 * approved from `npm run cleanup:dry-run:v2` (2026-10-08), in ONE transaction.
 *
 *   npm run cleanup:v2
 *       REHEARSAL (default): runs every check and every DELETE/UPDATE inside
 *       the transaction, prints the results, then ROLLS BACK. Changes nothing.
 *
 *   npm run cleanup:v2 -- --execute --confirm-project=<project-ref>
 *       Same transaction, COMMITTED only if every check passes.
 *
 * Any failed check, error, or concurrent write conflict (SERIALIZABLE) rolls
 * back everything. No DROP/TRUNCATE, no schema or migration changes.
 *
 * The plan is PINNED to what was approved: the exact protected users and
 * sellers, the exact 6 users, 8 orders and 2 delivery agents to delete, and
 * the single stock restoration. If the database no longer matches (someone
 * signed up, placed an order…), the run rolls back — re-run the dry run and
 * re-approve. Session/log tables (refresh tokens, notifications, audit logs…)
 * are approved as "delete all"; new rows there are deleted too and reported.
 *
 * Every protected table is fingerprinted (md5 over every row) before and
 * after the deletes; any difference — even an indirect one through a foreign
 * key action — rolls back.
 */

import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';

/* -------------------------------------------------------------------------- */
/* The approved plan (from the 2026-10-08 dry run)                            */
/* -------------------------------------------------------------------------- */

const PROTECTED_USERS: Record<string, { role: string; fullName: string }> = {
  '408f2b22-0773-449a-ae2a-42cf523cee78': { role: 'ADMIN', fullName: 'Store Owner' },
  '81b774fe-d1eb-4f82-9559-a813fb6779d8': { role: 'SELLER_OWNER', fullName: 'VINOD JAT' },
  '8658739e-c6ae-4003-989d-bcf7115a2059': { role: 'SELLER_OWNER', fullName: 'Karan Cloths' },
  'ca67384e-784d-413c-9778-343f80e91f39': { role: 'SELLER_OWNER', fullName: 'Avinash Jat' },
  'eb45e3cf-2199-4308-b02c-badba9fac4e6': { role: 'SELLER_OWNER', fullName: 'Madan Khuntia' },
};

const PROTECTED_SELLERS: Record<string, string> = {
  '9817f652-bfc4-4e37-a88b-7f3248675e41': 'Aadione Grocery Store',
  '7bd013e9-5a9e-437f-9493-ca61f82b0bab': 'aadione Cafe',
  'ec22073f-fc38-42c0-a757-9fb06cd00ec8': 'Ha Hokam Food',
  '972624ff-aae0-40ae-97cd-2613de663e33': 'Ram Dev Clothing',
};

const USERS_TO_DELETE = [
  'daf48535-09aa-4821-bb47-9cacf0211527',
  '04f57cb5-9cff-4304-a833-5c1acdff3e85',
  '889d8d87-d2f8-43fd-afaf-6680a8cdd3d1',
  'f876328d-cf68-47b4-ad89-51bf3dc96ae6',
  'de814ba8-4d08-40d9-96fd-54c016cfbd26',
  '181cc907-5e4b-42df-82e2-0d4dfc64702d',
];

const ORDERS_TO_DELETE = [
  'AD261006WAQX59',
  'AD2610068SAUHC',
  'AD261007AS5EEV',
  'AD2610079FMZHV',
  'AD261007J37YFN',
  'AD261007TUUY8H',
  'AD261007KWWJGE',
  'AD261007HMVVN2',
];

const DELIVERY_AGENTS_TO_DELETE = ['dd264713-d9c5-461e-a51b-0535220772eb', '9aad4a2b-019c-4506-b655-2cb2968add61'];

/** The only stock restoration the dry run found (undo one test sale). */
const EXPECTED_STOCK_RESTORE = { seller: 'Ram Dev Clothing', product: "Men's Printed Casual T-Shirt", from: 19, to: 20 };

/** Stock movements written by orders (inventory.service.ts). */
const ORDER_LEDGER_REASONS = ['ORDER_RESERVE', 'ORDER_RELEASE', 'ORDER_COMMIT', 'ORDER_CANCEL_RESTOCK'];

const BACKUP_FILE = path.resolve(__dirname, '..', 'v2-production-before-cleanup-2026-10-08.dump');

/** Exact rows deleted per table, as approved. `atLeast` = "delete all" session/log tables that may have grown. */
const EXPECTED_DELETES: Record<string, { rows: number; atLeast?: true }> = {
  stock_ledger: { rows: 31 },
  notifications: { rows: 79, atLeast: true },
  refunds: { rows: 0 },
  delivery_tasks: { rows: 2 },
  coupon_redemptions: { rows: 0 },
  orders: { rows: 8 },
  payment_events: { rows: 1 },
  seller_settlements: { rows: 0 },
  delivery_agents: { rows: 2 },
  cart_items: { rows: 16, atLeast: true },
  carts: { rows: 14, atLeast: true },
  refresh_tokens: { rows: 249, atLeast: true },
  password_reset_tokens: { rows: 0, atLeast: true },
  idempotency_keys: { rows: 8, atLeast: true },
  audit_logs: { rows: 231, atLeast: true },
  device_tokens: { rows: 0, atLeast: true },
  back_in_stock_subscriptions: { rows: 0, atLeast: true },
  coupons: { rows: 0 },
  referrals: { rows: 0 },
  users: { rows: 6 },
};

/** Removed by ON DELETE CASCADE from orders/users (checked as before -> after). */
const EXPECTED_CASCADES: Record<string, number> = {
  seller_orders: 9,
  order_items: 14,
  order_status_history: 25,
  seller_order_status_history: 13,
  payments: 3,
  addresses: 3,
};

/** Must be byte-for-byte identical after the cleanup (seller_listings: all but the restored row). */
const PROTECTED_TABLES = [
  'sellers', 'seller_profiles', 'seller_bank_details', 'seller_documents', 'restaurant_profiles', 'seller_hours',
  'seller_closures', 'seller_categories', 'seller_staff', 'categories', 'brands', 'products', 'product_variants',
  'product_images', 'product_approval_batches', 'product_approval_batch_items', 'commission_rules', 'configurations',
  '_prisma_migrations',
];

/* -------------------------------------------------------------------------- */

class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const confirmProject = args.find((a) => a.startsWith('--confirm-project='))?.split('=')[1];

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (!ok) failures.push(label);
};
const h = (title: string) => console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 74 - title.length))}`);
const ids = (record: Record<string, unknown>) => Object.keys(record);

async function count(tx: Tx, sql: string, ...params: unknown[]): Promise<number> {
  const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(sql, ...params);
  return Number(row?.n ?? 0);
}

/** md5 over every row of a table (or the rows a WHERE selects), in a stable order. */
async function fingerprint(tx: Tx, table: string, where = 'TRUE', ...params: unknown[]): Promise<string> {
  const [row] = await tx.$queryRawUnsafe<{ md5: string; n: bigint }[]>(
    `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS md5, count(*) AS n FROM "${table}" t WHERE ${where}`,
    ...params,
  );
  return `${row!.md5}/${Number(row!.n)}`;
}

async function snapshotProtected(tx: Tx, restoredListingIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of PROTECTED_TABLES) out[table] = await fingerprint(tx, table);
  out['users (protected rows)'] = await fingerprint(tx, 'users', 't.id = ANY($1::uuid[])', ids(PROTECTED_USERS));
  out['addresses (protected users)'] = await fingerprint(tx, 'addresses', 't.user_id = ANY($1::uuid[])', ids(PROTECTED_USERS));
  out['seller_listings (not restored)'] = await fingerprint(tx, 'seller_listings', 'NOT (t.id = ANY($1::uuid[]))', restoredListingIds);
  out['stock_ledger (kept rows)'] = await fingerprint(tx, 'stock_ledger', 'NOT (t.reason::text = ANY($1::text[]))', ORDER_LEDGER_REASONS);
  return out;
}

async function del(tx: Tx, table: string, sql: string, ...params: unknown[]): Promise<void> {
  const rows = await tx.$executeRawUnsafe(sql, ...params);
  const expected = EXPECTED_DELETES[table]!;
  const ok = expected.atLeast ? rows >= expected.rows : rows === expected.rows;
  check(ok, `DELETE ${table}: ${rows} row(s) (approved: ${expected.atLeast ? `all, was ${expected.rows}` : expected.rows})`);
}

async function cleanup(tx: Tx): Promise<void> {
  /* 1. Pre-checks --------------------------------------------------------- */
  h('1. Pre-checks');
  const [target] = await tx.$queryRawUnsafe<{ iso: string }[]>(`SELECT current_setting('transaction_isolation') AS iso`);
  check(target!.iso === 'serializable', `transaction isolation is SERIALIZABLE (${target!.iso})`);
  const v1 = await count(tx, `SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name NOT LIKE '%\\_v2\\_%' ESCAPE '\\'`);
  const baseline = await count(tx, `SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name = '20260926140446_v2_baseline' AND finished_at IS NOT NULL`);
  check(baseline === 1 && v1 === 0, 'target is a V2 database (V2 baseline applied, no V1 migrations)');

  for (const [id, p] of Object.entries(PROTECTED_USERS)) {
    const ok = await count(tx, `SELECT count(*) AS n FROM users WHERE id = $1::uuid AND role = $2::"UserRole" AND full_name = $3`, id, p.role, p.fullName);
    check(ok === 1, `protected user present: ${p.fullName} (${p.role})`);
  }
  for (const [id, name] of Object.entries(PROTECTED_SELLERS)) {
    const ok = await count(tx, `SELECT count(*) AS n FROM sellers WHERE id = $1::uuid AND name = $2`, id, name);
    check(ok === 1, `protected seller present: ${name}`);
  }
  check((await count(tx, `SELECT count(*) AS n FROM sellers`)) === 4, 'there are exactly 4 sellers');

  const others = (
    await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM users WHERE NOT (id = ANY($1::uuid[])) ORDER BY id`, ids(PROTECTED_USERS))
  ).map((r) => r.id);
  check(JSON.stringify(others) === JSON.stringify([...USERS_TO_DELETE].sort()), `the non-protected users are exactly the approved 6 (found ${others.length})`);
  const orders = (await tx.$queryRawUnsafe<{ order_number: string }[]>(`SELECT order_number FROM orders ORDER BY order_number`)).map((r) => r.order_number);
  check(JSON.stringify(orders) === JSON.stringify([...ORDERS_TO_DELETE].sort()), `the orders are exactly the approved 8 (found ${orders.length})`);
  const agents = (await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM delivery_agents ORDER BY id`)).map((r) => r.id);
  check(JSON.stringify(agents) === JSON.stringify([...DELIVERY_AGENTS_TO_DELETE].sort()), `the delivery agents are exactly the approved 2 (found ${agents.length})`);
  check(
    (await count(tx, `SELECT count(*) AS n FROM product_approval_batches WHERE submitted_by_user_id = ANY($1::uuid[])`, USERS_TO_DELETE)) === 0,
    'no approval batch was submitted by a user being deleted (RESTRICT)',
  );
  check(
    (await count(tx, `SELECT count(*) AS n FROM seller_staff WHERE user_id = ANY($1::uuid[])`, USERS_TO_DELETE)) === 0,
    'no user being deleted is linked to a seller',
  );
  if (failures.length) throw new Rollback('pre-checks failed');

  /* 2. Stock restoration plan (before the order ledger rows go) ---------- */
  h('2. Stock restoration');
  const restore = await tx.$queryRawUnsafe<
    { id: string; seller: string; product: string; stock_qty: number; reserved_qty: number; restored: bigint }[]
  >(
    `SELECT l.id::text, s.name AS seller, p.name AS product, l.stock_qty, l.reserved_qty,
            l.stock_qty + coalesce(sum(-sl.delta) FILTER (WHERE sl.reason = 'ORDER_COMMIT'), 0)
                        - coalesce(sum(sl.delta) FILTER (WHERE sl.reason = 'ORDER_CANCEL_RESTOCK'), 0) AS restored
       FROM seller_listings l
       JOIN sellers s ON s.id = l.seller_id
       JOIN product_variants v ON v.id = l.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN stock_ledger sl ON sl.seller_listing_id = l.id AND sl.reason::text = ANY($1::text[])
      GROUP BY l.id, s.name, p.name`,
    ORDER_LEDGER_REASONS,
  );
  const changes = restore.filter((r) => Number(r.restored) !== r.stock_qty || r.reserved_qty !== 0);
  for (const c of changes) console.log(`  ${c.seller} / ${c.product}: stock ${c.stock_qty} -> ${Number(c.restored)}, reserved ${c.reserved_qty} -> 0`);
  const only = changes[0];
  check(
    changes.length === 1 &&
      only!.seller === EXPECTED_STOCK_RESTORE.seller &&
      only!.product === EXPECTED_STOCK_RESTORE.product &&
      only!.stock_qty === EXPECTED_STOCK_RESTORE.from &&
      Number(only!.restored) === EXPECTED_STOCK_RESTORE.to &&
      only!.reserved_qty === 0,
    `exactly the approved restoration: ${EXPECTED_STOCK_RESTORE.product} ${EXPECTED_STOCK_RESTORE.from} -> ${EXPECTED_STOCK_RESTORE.to}`,
  );
  if (failures.length) throw new Rollback('stock restoration differs from the approved plan');
  const restoredIds = changes.map((c) => c.id);
  const [restoredBefore] = await tx.$queryRawUnsafe<{ rest: unknown }[]>(
    `SELECT to_jsonb(l) - 'stock_qty' AS rest FROM seller_listings l WHERE l.id = $1::uuid`,
    restoredIds[0],
  );

  /* 3. Fingerprint everything that must not change ---------------------- */
  const before = await snapshotProtected(tx, restoredIds);
  const cascadeBefore: Record<string, number> = {};
  for (const t of Object.keys(EXPECTED_CASCADES)) cascadeBefore[t] = await count(tx, `SELECT count(*) AS n FROM "${t}"`);

  /* 4. Deletes, in foreign-key order ------------------------------------- */
  h('3. Deletes (inside the transaction)');
  // Order-driven ledger rows first: deleting orders would only null their link.
  await del(tx, 'stock_ledger', `DELETE FROM stock_ledger WHERE reason::text = ANY($1::text[])`, ORDER_LEDGER_REASONS);
  const restored = await tx.$executeRawUnsafe(
    `UPDATE seller_listings SET stock_qty = $2, reserved_qty = 0 WHERE id = $1::uuid AND stock_qty = $3`,
    restoredIds[0],
    EXPECTED_STOCK_RESTORE.to,
    EXPECTED_STOCK_RESTORE.from,
  );
  check(restored === 1, `UPDATE seller_listings: ${restored} row (stock ${EXPECTED_STOCK_RESTORE.from} -> ${EXPECTED_STOCK_RESTORE.to})`);
  await del(tx, 'notifications', `DELETE FROM notifications`);
  await del(tx, 'refunds', `DELETE FROM refunds`); // RESTRICT on orders and payments
  await del(tx, 'delivery_tasks', `DELETE FROM delivery_tasks`); // RESTRICT on delivery_agents
  await del(tx, 'coupon_redemptions', `DELETE FROM coupon_redemptions`);
  // Cascades: seller_orders, order_items, order_status_history, seller_order_status_history, payments.
  await del(tx, 'orders', `DELETE FROM orders WHERE order_number = ANY($1::text[])`, ORDERS_TO_DELETE);
  await del(tx, 'payment_events', `DELETE FROM payment_events`);
  await del(tx, 'seller_settlements', `DELETE FROM seller_settlements`);
  await del(tx, 'delivery_agents', `DELETE FROM delivery_agents WHERE id = ANY($1::uuid[])`, DELIVERY_AGENTS_TO_DELETE);
  await del(tx, 'cart_items', `DELETE FROM cart_items`);
  await del(tx, 'carts', `DELETE FROM carts`);
  await del(tx, 'refresh_tokens', `DELETE FROM refresh_tokens`);
  await del(tx, 'password_reset_tokens', `DELETE FROM password_reset_tokens`);
  await del(tx, 'idempotency_keys', `DELETE FROM idempotency_keys`);
  await del(tx, 'audit_logs', `DELETE FROM audit_logs`);
  await del(tx, 'device_tokens', `DELETE FROM device_tokens`);
  await del(tx, 'back_in_stock_subscriptions', `DELETE FROM back_in_stock_subscriptions`);
  await del(tx, 'coupons', `DELETE FROM coupons`);
  await del(tx, 'referrals', `DELETE FROM referrals`);
  // Cascades: addresses (and nothing else — checked above and below).
  await del(
    tx,
    'users',
    `DELETE FROM users WHERE id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))`,
    USERS_TO_DELETE,
    ids(PROTECTED_USERS),
  );

  /* 5. Post-checks -------------------------------------------------------- */
  h('4. Post-checks');
  for (const [t, expected] of Object.entries(EXPECTED_CASCADES)) {
    const now = await count(tx, `SELECT count(*) AS n FROM "${t}"`);
    check(cascadeBefore[t]! - now === expected, `cascade ${t}: ${cascadeBefore[t]} -> ${now} (approved: -${expected})`);
  }
  for (const t of [...Object.keys(EXPECTED_DELETES).filter((x) => !['stock_ledger', 'users'].includes(x)), ...Object.keys(EXPECTED_CASCADES)]) {
    if (t === 'addresses') continue;
    check((await count(tx, `SELECT count(*) AS n FROM "${t}"`)) === 0, `${t} is empty`);
  }
  check((await count(tx, `SELECT count(*) AS n FROM users`)) === 5, 'exactly 5 users remain (the protected ones)');
  check(
    (await count(tx, `SELECT count(*) AS n FROM stock_ledger WHERE reason::text = ANY($1::text[])`, ORDER_LEDGER_REASONS)) === 0,
    'no order-driven stock ledger rows remain',
  );
  check(
    (await count(tx, `SELECT count(*) AS n FROM seller_listings WHERE reserved_qty <> 0`)) === 0,
    'no stock is held (reserved_qty = 0 everywhere)',
  );
  const [restoredAfter] = await tx.$queryRawUnsafe<{ rest: unknown; stock_qty: number }[]>(
    `SELECT to_jsonb(l) - 'stock_qty' AS rest, l.stock_qty FROM seller_listings l WHERE l.id = $1::uuid`,
    restoredIds[0],
  );
  check(
    restoredAfter!.stock_qty === EXPECTED_STOCK_RESTORE.to && JSON.stringify(restoredAfter!.rest) === JSON.stringify(restoredBefore!.rest),
    `restored listing: stock_qty = ${restoredAfter!.stock_qty}, every other column unchanged`,
  );
  const after = await snapshotProtected(tx, restoredIds);
  for (const [name, fp] of Object.entries(before)) {
    check(after[name] === fp, `unchanged: ${name} (${fp.split('/')[1]} rows)`);
  }
  check(
    (await count(tx, `SELECT count(*) AS n FROM seller_staff WHERE role = 'OWNER' AND user_id = ANY($1::uuid[]) AND seller_id = ANY($2::uuid[])`, ids(PROTECTED_USERS), ids(PROTECTED_SELLERS))) === 4,
    'all 4 protected sellers keep their protected OWNER',
  );
}

function backupLooksValid(): boolean {
  if (!existsSync(BACKUP_FILE)) return false;
  const fd = openSync(BACKUP_FILE, 'r');
  const magic = Buffer.alloc(5);
  readSync(fd, magic, 0, 5, 0);
  closeSync(fd);
  return magic.toString('latin1') === 'PGDMP';
}

async function main(): Promise<void> {
  const url = new URL(process.env['DATABASE_URL'] ?? 'postgresql://unknown@unknown/unknown');
  const user = decodeURIComponent(url.username); // postgres.<project-ref> on Supabase
  const projectRef = user.split('.')[1] ?? user;
  console.log(`V2 PRODUCTION CLEANUP — ${execute ? 'EXECUTE (commits if every check passes)' : 'REHEARSAL (always rolls back)'}`);
  console.log(`  target: ${user} @ ${url.hostname}:${url.port || '5432'}${url.pathname}`);

  if (execute) {
    if (confirmProject !== projectRef) {
      console.error(`\n  REFUSED: pass --confirm-project=${projectRef} to execute against this database.`);
      process.exitCode = 1;
      return;
    }
    if (!backupLooksValid()) {
      console.error(`\n  REFUSED: backup ${BACKUP_FILE} is missing or not a pg_dump file.`);
      process.exitCode = 1;
      return;
    }
    console.log(`  backup: ${path.basename(BACKUP_FILE)} (pg_dump) present`);
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        await cleanup(tx);
        if (failures.length) throw new Rollback(`${failures.length} check(s) failed`);
        if (!execute) throw new Rollback('rehearsal');
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 30_000 },
    );
    h('Result');
    console.log('  COMMITTED. Every check passed. Run `npm run cleanup:dry-run:v2` to see the clean state.');
  } catch (error) {
    h('Result');
    if (error instanceof Rollback && error.message === 'rehearsal' && failures.length === 0) {
      console.log('  REHEARSAL PASSED — every check passed and everything was ROLLED BACK. Nothing changed.');
      console.log(`  To execute: npm run cleanup:v2 -- --execute --confirm-project=${projectRef}`);
      return;
    }
    for (const f of failures) console.log(`  FAILED: ${f}`);
    console.log(`  ROLLED BACK — nothing changed. Reason: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('CLEANUP COULD NOT RUN (nothing committed):', error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
