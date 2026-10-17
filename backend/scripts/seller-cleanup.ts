/**
 * Permanent seller cleanup for the owner's fixed allowlist
 * (src/modules/maintenance/seller-cleanup.ts). DRY RUN unless --execute.
 *
 *   # 1. dry run — read-only; writes a .json and a .txt report and prints a token
 *   npm run seller:cleanup:v2
 *   npm run seller:cleanup:v2 -- --codes GIFTSTORE,SHOESSHOP        (an exact subset)
 *
 *   # 2. execute — only with the token of a dry run of the SAME data,
 *   #    the operator's name and a verified backup file
 *   npm run seller:cleanup:v2 -- --execute --confirm SC-XXXXXXXXXXXX \
 *       --actor "Owner name" --backup C:/backups/v2-before-seller-cleanup.dump
 *   #    optional second confirmation: also delete the plan's deletable orders
 *   #    (no payment, no refund, no settlement, only allowlisted sellers)
 *       ... --orders-confirm SO-XXXXXXXXXXXX
 *
 * Prints counts, codes and names only — never a credential, a bank detail or
 * a customer's contact.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prisma } from '../src/infra/db/prisma';
import { executeSellerCleanup, formatPlan, planSellerCleanup } from '../src/modules/maintenance/seller-cleanup';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const BACKUP_MAX_AGE_MS = 24 * 60 * 60_000;

/** A backup taken for this run: exists, non-empty, recent, and (when pg_restore is available) readable. */
function verifyBackup(path: string): string {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0) throw new Error(`backup ${path} is empty or not a file`);
  if (Date.now() - info.mtimeMs > BACKUP_MAX_AGE_MS) throw new Error(`backup ${path} is older than 24 hours — take a fresh one`);
  const pgRestore = process.env['PG_RESTORE'] ?? 'pg_restore';
  const listed = spawnSync(pgRestore, ['--list', path], { encoding: 'utf8' });
  if (listed.error) {
    if (!flag('backup-verified')) {
      throw new Error(`pg_restore is not available to check ${path}; verify it yourself and add --backup-verified (or set PG_RESTORE)`);
    }
    return `${path} (${info.size} bytes, checked by the operator)`;
  }
  if (listed.status !== 0) throw new Error(`pg_restore --list could not read ${path}`);
  const entries = listed.stdout.split('\n').filter((line) => line.trim() && !line.startsWith(';')).length;
  return `${path} (${info.size} bytes, ${entries} archive entries, pg_restore --list OK)`;
}

function writeReports(name: string, json: unknown, text: string): string {
  const dir = arg('out') ?? join(tmpdir(), 'aadione-seller-cleanup');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  writeFileSync(`${base}.txt`, text);
  return base;
}

async function main(): Promise<void> {
  const codes = arg('codes')?.split(',').map((code) => code.trim()).filter(Boolean) ?? null;

  if (flag('global-orders') || flag('global-audit-logs')) {
    console.error(
      'Global order / audit-log deletion is not done by this tool: it would remove other customers\' and sellers\' records\n' +
        'and payment history. The dry run counts them; a global deletion needs its own reviewed, separately approved operation.',
    );
    process.exit(2);
  }

  if (!flag('execute')) {
    const plan = await planSellerCleanup(codes);
    const text = formatPlan(plan);
    const base = writeReports('seller-cleanup-dry-run', plan, text);
    console.log(text);
    console.log(`\nreports: ${base}.json / ${base}.txt`);
    console.log('\nNOTHING WAS CHANGED. To execute exactly this plan, take a backup, then run with');
    console.log(`  --execute --confirm ${plan.token} --actor "<your name>" --backup <dump file>`);
    if (plan.ordersToken) console.log(`  and optionally --orders-confirm ${plan.ordersToken} (deletes ${plan.deletableOrderIds.length} order(s))`);
    return;
  }

  const confirmToken = arg('confirm');
  const actor = arg('actor');
  const backup = arg('backup');
  if (!confirmToken || !actor || !backup) {
    console.error('--execute needs --confirm <token from the dry run>, --actor "<your name>" and --backup <verified dump file>');
    process.exit(2);
  }
  const backupNote = verifyBackup(backup);
  console.log(`backup verified: ${backupNote}`);

  const result = await executeSellerCleanup(codes, {
    confirmToken,
    ordersConfirmToken: arg('orders-confirm') ?? null,
    actor,
    backupNote,
  });
  const text = [
    `SELLER CLEANUP — EXECUTED (run ${result.runId})`,
    ...result.results.map((r) => `  ${r.code}: ${r.done ? r.action : `skipped (${r.action})`} — ${r.detail}`),
    `  orders deleted: ${result.deletedOrders}`,
    `  verification: ${result.verification.ok ? 'OK' : `PROBLEMS: ${result.verification.problems.join('; ')}`}`,
    '',
    'To restore from the backup if needed: pg_restore --clean --if-exists --no-owner -d <database url> <dump file>',
  ].join('\n');
  const base = writeReports('seller-cleanup-executed', result, text);
  console.log(text);
  console.log(`\nreports: ${base}.json / ${base}.txt`);
  if (!result.verification.ok) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('failed:', error instanceof Error ? error.message.split('\n')[0] : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
