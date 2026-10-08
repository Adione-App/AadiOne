/**
 * V2 production cleanup — DRY RUN ONLY. Reads; never writes.
 *
 * Reports exactly what the pre-production cleanup of test/demo operational
 * data would remove from the V2 database, and verifies that the protected
 * users and their sellers' data are excluded. Every query runs inside one
 * READ ONLY, REPEATABLE READ transaction — PostgreSQL itself rejects any write
 * — and this file contains no DELETE/UPDATE/TRUNCATE/DROP statement.
 *
 *   npm run cleanup:dry-run:v2
 *
 * Exit code 0 = every safety check passed; 1 = at least one check failed
 * (the plan must not be executed as reported); 2 = could not run.
 */

import { Prisma, PrismaClient } from '@prisma/client';

/* -------------------------------------------------------------------------- */
/* What must never be deleted                                                 */
/* -------------------------------------------------------------------------- */

/** Matched EXACTLY on role + full_name; each must match exactly one user. */
const PROTECTED_USERS = [
  { role: 'ADMIN', fullName: 'Store Owner' },
  { role: 'SELLER_OWNER', fullName: 'VINOD JAT' },
  { role: 'SELLER_OWNER', fullName: 'Karan Cloths' },
  { role: 'SELLER_OWNER', fullName: 'Avinash Jat' },
  { role: 'SELLER_OWNER', fullName: 'Madan Khuntia' },
] as const;
const EXPECTED_PROTECTED_SELLERS = 4;

/** Stock movements written by orders (inventory.service.ts). */
const ORDER_LEDGER_REASONS = ['ORDER_RESERVE', 'ORDER_RELEASE', 'ORDER_COMMIT', 'ORDER_CANCEL_RESTOCK'];

/* -------------------------------------------------------------------------- */

const prisma = new PrismaClient();
type Tx = Prisma.TransactionClient;

const failures: string[] = [];
const warnings: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (!ok) failures.push(label);
};
const warn = (label: string) => {
  console.log(`  [WARN] ${label}`);
  warnings.push(label);
};
const h = (title: string) => console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 74 - title.length))}`);
const mask = (mobile: string | null) => (mobile ? `******${mobile.slice(-4)}` : '-');
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '-');
const n = (v: unknown) => Number(v);

async function count(tx: Tx, sql: string, ...params: unknown[]): Promise<number> {
  const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(sql, ...params);
  return n(row?.n ?? 0);
}

async function run(tx: Tx): Promise<void> {
  /* 0. Target ------------------------------------------------------------ */
  h('0. Target database');
  const [target] = await tx.$queryRawUnsafe<{ db: string; usr: string; ro: string }[]>(
    `SELECT current_database() AS db, current_user AS usr, current_setting('transaction_read_only') AS ro`,
  );
  // Host and user only — never the password.
  const url = new URL(process.env['DATABASE_URL'] ?? 'postgresql://unknown@unknown/unknown');
  console.log(`  target: ${decodeURIComponent(url.username)} @ ${url.hostname}:${url.port || '5432'}/${target!.db}   transaction_read_only: ${target!.ro}`);
  check(target!.ro === 'on', 'all queries run in a READ ONLY transaction');
  const v1 = await count(tx, `SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name NOT LIKE '%\\_v2\\_%' ESCAPE '\\'`);
  const baseline = await count(tx, `SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name = '20260926140446_v2_baseline' AND finished_at IS NOT NULL`);
  check(baseline === 1 && v1 === 0, 'target is a V2 database (V2 baseline applied, no V1 migrations)');

  /* 1. Protected users ---------------------------------------------------- */
  h('1. Protected users (never deleted)');
  const protectedIds: string[] = [];
  for (const p of PROTECTED_USERS) {
    const rows = await tx.$queryRawUnsafe<{ id: string; mobile: string; email: string | null; status: string; deleted_at: Date | null }[]>(
      `SELECT id::text, mobile, email, status::text, deleted_at FROM users WHERE role = $1::"UserRole" AND full_name = $2`,
      p.role,
      p.fullName,
    );
    if (rows.length === 1) {
      const u = rows[0]!;
      protectedIds.push(u.id);
      console.log(`  ${p.role.padEnd(13)} ${p.fullName.padEnd(15)} id=${u.id} mobile=${mask(u.mobile)} status=${u.status}${u.deleted_at ? ' SOFT-DELETED' : ''}`);
    } else {
      const near = await tx.$queryRawUnsafe<{ id: string; role: string; full_name: string }[]>(
        `SELECT id::text, role::text, full_name FROM users WHERE lower(trim(full_name)) = lower(trim($1))`,
        p.fullName,
      );
      console.log(`  ${p.role.padEnd(13)} ${p.fullName.padEnd(15)} -> ${rows.length} exact matches; similar: ${JSON.stringify(near)}`);
    }
    check(rows.length === 1, `"${p.fullName}" (${p.role}) matches exactly one user`);
  }
  check(new Set(protectedIds).size === PROTECTED_USERS.length, `${PROTECTED_USERS.length} distinct protected users`);

  /* 2. Protected sellers -------------------------------------------------- */
  h('2. Protected sellers (owned by protected SELLER_OWNER users)');
  const sellers = await tx.$queryRawUnsafe<
    { id: string; name: string; seller_type: string; lifecycle: string; owners: string | null; protected: boolean; deleted_at: Date | null }[]
  >(
    `SELECT s.id::text, s.name, s.seller_type::text, s.lifecycle_status::text AS lifecycle, s.deleted_at,
            string_agg(u.full_name || ' (' || ss.role::text || ')', ', ') AS owners,
            bool_or(ss.user_id = ANY($1::uuid[])) AS protected
       FROM sellers s
       LEFT JOIN seller_staff ss ON ss.seller_id = s.id
       LEFT JOIN users u ON u.id = ss.user_id
      GROUP BY s.id ORDER BY s.created_at`,
    protectedIds,
  );
  for (const s of sellers) {
    console.log(`  ${s.protected ? 'PROTECTED  ' : 'UNPROTECTED'} ${s.name.padEnd(26)} ${s.seller_type.padEnd(12)} ${s.lifecycle.padEnd(20)} id=${s.id} staff: ${s.owners ?? '-'}${s.deleted_at ? ' SOFT-DELETED' : ''}`);
  }
  const protectedSellerIds = sellers.filter((s) => s.protected).map((s) => s.id);
  check(protectedSellerIds.length === EXPECTED_PROTECTED_SELLERS, `exactly ${EXPECTED_PROTECTED_SELLERS} protected sellers`);
  check(sellers.every((s) => s.protected), 'every seller in the database is protected (this plan never deletes a seller)');
  const ownerLinks = await count(
    tx,
    `SELECT count(*) AS n FROM seller_staff WHERE user_id = ANY($1::uuid[]) AND role = 'OWNER' AND seller_id = ANY($2::uuid[])`,
    protectedIds,
    protectedSellerIds,
  );
  check(ownerLinks >= EXPECTED_PROTECTED_SELLERS, `each protected seller keeps a protected OWNER link (${ownerLinks} owner links)`);

  /* 3. Preserved seller / catalogue data ---------------------------------- */
  h('3. Preserved seller and catalogue data (per protected seller)');
  const perSeller: Array<[string, string]> = [
    ['categories', `SELECT count(*) AS n FROM categories WHERE seller_id = $1::uuid AND parent_id IS NULL`],
    ['subcategories', `SELECT count(*) AS n FROM categories WHERE seller_id = $1::uuid AND parent_id IS NOT NULL`],
    ['products', `SELECT count(*) AS n FROM products WHERE submitted_by_seller_id = $1::uuid`],
    ['variants', `SELECT count(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.submitted_by_seller_id = $1::uuid`],
    ['images', `SELECT count(*) AS n FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.submitted_by_seller_id = $1::uuid`],
    ['listings', `SELECT count(*) AS n FROM seller_listings WHERE seller_id = $1::uuid`],
    ['approval batches', `SELECT count(*) AS n FROM product_approval_batches WHERE seller_id = $1::uuid`],
    ['documents', `SELECT count(*) AS n FROM seller_documents WHERE seller_id = $1::uuid`],
    ['bank', `SELECT count(*) AS n FROM seller_bank_details WHERE seller_id = $1::uuid`],
    ['profile', `SELECT count(*) AS n FROM seller_profiles WHERE seller_id = $1::uuid`],
    ['restaurant', `SELECT count(*) AS n FROM restaurant_profiles WHERE seller_id = $1::uuid`],
    ['commission', `SELECT count(*) AS n FROM commission_rules WHERE seller_id = $1::uuid`],
    ['config', `SELECT count(*) AS n FROM configurations WHERE seller_id = $1::uuid`],
    ['hours', `SELECT count(*) AS n FROM seller_hours WHERE seller_id = $1::uuid`],
    ['closures', `SELECT count(*) AS n FROM seller_closures WHERE seller_id = $1::uuid`],
    ['assigned cats', `SELECT count(*) AS n FROM seller_categories WHERE seller_id = $1::uuid`],
    ['staff', `SELECT count(*) AS n FROM seller_staff WHERE seller_id = $1::uuid`],
  ];
  for (const s of sellers.filter((x) => x.protected)) {
    const parts: string[] = [];
    for (const [label, sql] of perSeller) parts.push(`${label}=${await count(tx, sql, s.id)}`);
    console.log(`  ${s.name}:\n    ${parts.join('  ')}`);
  }
  const shared = {
    'shared categories': await count(tx, `SELECT count(*) AS n FROM categories WHERE seller_id IS NULL`),
    'products without seller': await count(tx, `SELECT count(*) AS n FROM products WHERE submitted_by_seller_id IS NULL`),
    'global configurations': await count(tx, `SELECT count(*) AS n FROM configurations WHERE seller_id IS NULL`),
    'global commission rules': await count(tx, `SELECT count(*) AS n FROM commission_rules WHERE seller_id IS NULL`),
    brands: await count(tx, `SELECT count(*) AS n FROM brands`),
  };
  console.log(`  not seller-owned (also preserved): ${Object.entries(shared).map(([k, v]) => `${k}=${v}`).join('  ')}`);

  /* 4. Users to delete ---------------------------------------------------- */
  h('4. Users to DELETE (everyone except the 5 protected users)');
  const doomed = await tx.$queryRawUnsafe<
    { id: string; role: string; full_name: string | null; mobile: string; created_at: Date; orders: bigint; addresses: bigint; carts: bigint; staff: bigint; agent: bigint }[]
  >(
    `SELECT u.id::text, u.role::text, u.full_name, u.mobile, u.created_at,
            (SELECT count(*) FROM orders o WHERE o.user_id = u.id) AS orders,
            (SELECT count(*) FROM addresses a WHERE a.user_id = u.id) AS addresses,
            (SELECT count(*) FROM carts c WHERE c.user_id = u.id) AS carts,
            (SELECT count(*) FROM seller_staff ss WHERE ss.user_id = u.id) AS staff,
            (SELECT count(*) FROM delivery_agents d WHERE d.user_id = u.id) AS agent
       FROM users u WHERE NOT (u.id = ANY($1::uuid[])) ORDER BY u.role, u.created_at`,
    protectedIds,
  );
  for (const u of doomed) {
    console.log(
      `  ${u.role.padEnd(15)} ${(u.full_name ?? '(no name)').padEnd(22)} ${mask(u.mobile)} created ${day(u.created_at)} id=${u.id}` +
        `  orders=${n(u.orders)} addresses=${n(u.addresses)} carts=${n(u.carts)} sellerStaff=${n(u.staff)} agent=${n(u.agent)}`,
    );
  }
  const doomedIds = doomed.map((u) => u.id);
  console.log(`  total: ${doomed.length} users`);
  check(doomedIds.every((id) => !protectedIds.includes(id)), 'no protected user is in the delete set');
  const doomedStaff = await tx.$queryRawUnsafe<{ seller: string; name: string | null; role: string }[]>(
    `SELECT s.name AS seller, u.full_name AS name, ss.role::text AS role FROM seller_staff ss JOIN sellers s ON s.id = ss.seller_id JOIN users u ON u.id = ss.user_id
      WHERE ss.user_id = ANY($1::uuid[])`,
    doomedIds,
  );
  if (doomedStaff.length) for (const r of doomedStaff) warn(`deleting user "${r.name}" removes their ${r.role} link to seller "${r.seller}"`);
  check(!doomedStaff.some((r) => r.role === 'OWNER'), 'no deleted user is an OWNER of any seller');

  /* 5. Blockers and side effects on preserved rows ------------------------ */
  h('5. Foreign-key blockers and side effects on preserved rows');
  const blockers = await tx.$queryRawUnsafe<{ id: string; seller: string; who: string | null }[]>(
    `SELECT b.id::text, s.name AS seller, u.full_name AS who FROM product_approval_batches b
       JOIN sellers s ON s.id = b.seller_id JOIN users u ON u.id = b.submitted_by_user_id
      WHERE b.submitted_by_user_id = ANY($1::uuid[])`,
    doomedIds,
  );
  for (const b of blockers) console.log(`  BLOCKER approval batch ${b.id} (${b.seller}) submitted by deletable user "${b.who}" (ON DELETE RESTRICT)`);
  check(blockers.length === 0, 'no preserved approval batch was submitted by a user to be deleted (RESTRICT)');
  const setNull: Array<[string, string, unknown[]]> = [
    ['product_approval_batches.reviewed_by_user_id', `SELECT count(*) AS n FROM product_approval_batches WHERE reviewed_by_user_id = ANY($1::uuid[])`, [doomedIds]],
    ['seller_documents.verified_by_user_id', `SELECT count(*) AS n FROM seller_documents WHERE verified_by_user_id = ANY($1::uuid[])`, [doomedIds]],
    ['configurations.updated_by_user_id', `SELECT count(*) AS n FROM configurations WHERE updated_by_user_id = ANY($1::uuid[])`, [doomedIds]],
    [
      'users.referred_by_user_id (protected users)',
      `SELECT count(*) AS n FROM users WHERE id = ANY($2::uuid[]) AND referred_by_user_id = ANY($1::uuid[])`,
      [doomedIds, protectedIds],
    ],
    [
      'stock_ledger.actor_user_id (kept, non-order rows)',
      `SELECT count(*) AS n FROM stock_ledger WHERE actor_user_id = ANY($1::uuid[]) AND NOT (reason::text = ANY($2::text[]))`,
      [doomedIds, ORDER_LEDGER_REASONS],
    ],
  ];
  for (const [label, sql, params] of setNull) {
    const c = await count(tx, sql, ...params);
    console.log(`  ${label.padEnd(50)} would be SET NULL on ${c} preserved row(s)`);
    if (c > 0) warn(`${c} preserved row(s) lose their "${label}" reference`);
  }

  /* 6. Orders and everything hanging off them ----------------------------- */
  h('6. Orders to DELETE (all orders — pre-launch test orders) and their dependents');
  const orders = await tx.$queryRawUnsafe<
    { id: string; order_number: string; status: string; payment_status: string; total_paise: number; created_at: Date; customer: string | null; mobile: string; is_protected: boolean }[]
  >(
    `SELECT o.id::text, o.order_number, o.status::text, o.payment_status::text, o.total_paise, o.created_at, u.full_name AS customer, u.mobile,
            (o.user_id = ANY($1::uuid[])) AS is_protected
       FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at`,
    protectedIds,
  );
  for (const o of orders) {
    console.log(`  ${o.order_number.padEnd(20)} ${o.status.padEnd(22)} ${o.payment_status.padEnd(18)} ${rupees(o.total_paise).padStart(10)}  ${day(o.created_at)}  by ${o.customer ?? '(no name)'} ${mask(o.mobile)}${o.is_protected ? '  <- PROTECTED USER' : ''}`);
  }
  const byProtected = orders.filter((o) => o.is_protected).length;
  if (byProtected) warn(`${byProtected} order(s) were placed by a protected user's account — included as test orders`);
  const orderDependents: Array<[string, string]> = [
    ['seller_orders', `SELECT count(*) AS n FROM seller_orders`],
    ['order_items', `SELECT count(*) AS n FROM order_items`],
    ['order_status_history', `SELECT count(*) AS n FROM order_status_history`],
    ['seller_order_status_history', `SELECT count(*) AS n FROM seller_order_status_history`],
    ['payments', `SELECT count(*) AS n FROM payments`],
    ['refunds', `SELECT count(*) AS n FROM refunds`],
    ['coupon_redemptions', `SELECT count(*) AS n FROM coupon_redemptions`],
    ['delivery_tasks', `SELECT count(*) AS n FROM delivery_tasks`],
    ['payment_events (webhook log, not FK-linked)', `SELECT count(*) AS n FROM payment_events`],
    ['seller_settlements (computed from orders)', `SELECT count(*) AS n FROM seller_settlements`],
  ];
  for (const [label, sql] of orderDependents) console.log(`  ${label.padEnd(45)} ${await count(tx, sql)}`);
  const orphanSellerOrders = await count(tx, `SELECT count(*) AS n FROM seller_orders so WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = so.order_id)`);
  check(orphanSellerOrders === 0, 'every seller order belongs to an order being deleted');

  /* 7. Stock ledger + stock restoration ----------------------------------- */
  h('7. Stock ledger: order-driven rows DELETED, seller stock entries KEPT');
  const ledger = await tx.$queryRawUnsafe<{ reason: string; rows: bigint; linked: bigint }[]>(
    `SELECT reason::text, count(*) AS rows, count(seller_order_id) AS linked FROM stock_ledger GROUP BY reason ORDER BY reason`,
  );
  for (const l of ledger) {
    const isOrder = ORDER_LEDGER_REASONS.includes(l.reason);
    console.log(`  ${l.reason.padEnd(22)} ${String(n(l.rows)).padStart(4)} rows (${n(l.linked)} linked to a seller order)  -> ${isOrder ? 'DELETE' : 'KEEP'}`);
  }
  const unlinkedOrderRows = await count(tx, `SELECT count(*) AS n FROM stock_ledger WHERE reason::text = ANY($1::text[]) AND seller_order_id IS NULL`, ORDER_LEDGER_REASONS);
  const linkedOtherRows = await count(tx, `SELECT count(*) AS n FROM stock_ledger WHERE NOT (reason::text = ANY($1::text[])) AND seller_order_id IS NOT NULL`, ORDER_LEDGER_REASONS);
  check(unlinkedOrderRows === 0, 'every order-driven ledger row is linked to a seller order');
  if (linkedOtherRows) warn(`${linkedOtherRows} non-order ledger row(s) reference a seller order (kept; the link becomes NULL)`);

  console.log('\n  Listings whose stock test orders moved (restore = undo test sales, release all holds):');
  const stock = await tx.$queryRawUnsafe<
    { seller: string; product: string; variant: string; tracks: boolean; stock_qty: number; reserved_qty: number; committed: bigint; restocked: bigint }[]
  >(
    `SELECT s.name AS seller, p.name AS product, v.variant_name AS variant, l.tracks_stock AS tracks, l.stock_qty, l.reserved_qty,
            coalesce(sum(-sl.delta) FILTER (WHERE sl.reason = 'ORDER_COMMIT'), 0) AS committed,
            coalesce(sum(sl.delta) FILTER (WHERE sl.reason = 'ORDER_CANCEL_RESTOCK'), 0) AS restocked
       FROM seller_listings l
       JOIN sellers s ON s.id = l.seller_id
       JOIN product_variants v ON v.id = l.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN stock_ledger sl ON sl.seller_listing_id = l.id AND sl.reason::text = ANY($1::text[])
      GROUP BY s.name, p.name, v.variant_name, l.id
     HAVING l.reserved_qty <> 0 OR count(sl.id) > 0
      ORDER BY s.name, p.name`,
    ORDER_LEDGER_REASONS,
  );
  let negative = 0;
  for (const r of stock) {
    const restored = r.stock_qty + n(r.committed) - n(r.restocked);
    if (restored < 0) negative += 1;
    console.log(
      `    ${r.seller.padEnd(24)} ${`${r.product} / ${r.variant}`.slice(0, 44).padEnd(44)} ${r.tracks ? 'tracked ' : 'no-track'}` +
        `  stock ${String(r.stock_qty).padStart(4)} -> ${String(restored).padStart(4)}   reserved ${String(r.reserved_qty).padStart(3)} -> 0`,
    );
  }
  console.log(`  ${stock.length} listing(s) would be UPDATED (stock_qty / reserved_qty only; no listing is deleted).`);
  check(negative === 0, 'no restored stock quantity would be negative');

  /* 8. Other operational data -------------------------------------------- */
  h('8. Other operational data to DELETE');
  const agents = await tx.$queryRawUnsafe<{ id: string; name: string; mobile: string; user_name: string | null }[]>(
    `SELECT d.id::text, d.name, d.mobile, u.full_name AS user_name FROM delivery_agents d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.created_at`,
  );
  for (const a of agents) console.log(`  delivery agent  ${a.name.padEnd(22)} ${mask(a.mobile)} linked user: ${a.user_name ?? '-'}  id=${a.id}`);
  const coupons = await tx.$queryRawUnsafe<{ code: string; origin: string; is_active: boolean }[]>(`SELECT code, origin::text, is_active FROM coupons ORDER BY created_at`);
  for (const c of coupons) console.log(`  coupon          ${c.code} (${c.origin}${c.is_active ? ', active' : ''})`);
  const notif = await tx.$queryRawUnsafe<{ audience: string; rows: bigint }[]>(`SELECT audience::text, count(*) AS rows FROM notifications GROUP BY audience`);
  console.log(`  notifications by audience: ${notif.map((r) => `${r.audience}=${n(r.rows)}`).join(' ') || 'none'}`);
  const audit = await tx.$queryRawUnsafe<{ entity_type: string; rows: bigint }[]>(
    `SELECT entity_type, count(*) AS rows FROM audit_logs GROUP BY entity_type ORDER BY count(*) DESC`,
  );
  console.log(`  audit_logs by entity: ${audit.map((r) => `${r.entity_type}=${n(r.rows)}`).join(' ')}`);
  if (audit.length) warn('ALL audit logs are deleted, including the catalogue/approval/onboarding trail of the protected sellers (as requested)');
  const tokensProtected = await count(tx, `SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ANY($1::uuid[])`, protectedIds);
  if (tokensProtected) warn(`${tokensProtected} refresh token(s) of protected users are deleted — they must sign in again`);
  const protAddresses = await count(tx, `SELECT count(*) AS n FROM addresses WHERE user_id = ANY($1::uuid[])`, protectedIds);
  console.log(`  addresses of protected users: ${protAddresses} (KEPT); addresses of deleted users go with them`);

  /* 9. Before / after ---------------------------------------------------- */
  h('9. Row counts: now -> after cleanup');
  const tables = (await tx.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`)).map((r) => r.t);
  // Rows removed per table under the plan above (cascades included).
  const removed: Record<string, [string, unknown[]]> = {
    users: [`SELECT count(*) AS n FROM users WHERE NOT (id = ANY($1::uuid[]))`, [protectedIds]],
    addresses: [`SELECT count(*) AS n FROM addresses WHERE NOT (user_id = ANY($1::uuid[]))`, [protectedIds]],
    seller_staff: [`SELECT count(*) AS n FROM seller_staff WHERE NOT (user_id = ANY($1::uuid[]))`, [protectedIds]],
    stock_ledger: [`SELECT count(*) AS n FROM stock_ledger WHERE reason::text = ANY($1::text[])`, [ORDER_LEDGER_REASONS]],
  };
  const deleteAll = new Set([
    'orders', 'seller_orders', 'order_items', 'order_status_history', 'seller_order_status_history', 'payments', 'payment_events',
    'refunds', 'coupon_redemptions', 'coupons', 'referrals', 'delivery_tasks', 'delivery_agents', 'carts', 'cart_items',
    'notifications', 'refresh_tokens', 'password_reset_tokens', 'idempotency_keys', 'audit_logs', 'back_in_stock_subscriptions',
    'seller_settlements', 'device_tokens',
  ]);
  const preservedTables = [
    'sellers', 'seller_profiles', 'seller_bank_details', 'seller_documents', 'restaurant_profiles', 'seller_hours', 'seller_closures',
    'seller_categories', 'categories', 'brands', 'products', 'product_variants', 'product_images', 'seller_listings',
    'product_approval_batches', 'product_approval_batch_items', 'commission_rules', 'configurations',
  ];
  let totalRemoved = 0;
  for (const t of tables) {
    const now = await count(tx, `SELECT count(*) AS n FROM "${t}"`);
    const partial = removed[t];
    const gone = deleteAll.has(t) ? now : partial ? await count(tx, partial[0], ...partial[1]) : 0;
    totalRemoved += gone;
    const tag = preservedTables.includes(t) ? 'preserved' : gone === 0 ? '' : gone === now ? 'all' : 'partial';
    console.log(`  ${t.padEnd(30)} ${String(now).padStart(5)} -> ${String(now - gone).padStart(5)}   ${gone ? `-${gone}` : ''} ${tag}`);
    if (preservedTables.includes(t)) check(gone === 0, `${t}: no rows removed`);
  }
  console.log(`  total rows to delete: ${totalRemoved}`);
}

async function main(): Promise<void> {
  console.log('V2 CLEANUP — DRY RUN (read-only; nothing is changed)');
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await run(tx);
    },
    { isolationLevel: 'RepeatableRead', timeout: 300_000, maxWait: 30_000 },
  );

  h('Result');
  for (const w of warnings) console.log(`  WARN: ${w}`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    console.log(`\n  ${failures.length} safety check(s) FAILED — the cleanup must NOT run as reported.`);
    process.exitCode = 1;
  } else {
    console.log('\n  All safety checks PASSED. Nothing was changed. Review the lists above before approving.');
  }
}

main()
  .catch((error) => {
    console.error('DRY RUN COULD NOT COMPLETE:', error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
