/**
 * Permanent removal of the owner's 8 dummy sellers
 * (src/modules/maintenance/seller-cleanup.ts). DRY RUN unless --execute.
 *
 *   # 1. dry run — read-only; writes a .json and a .txt report and prints a token
 *   npm run seller:cleanup:v2
 *   npm run seller:cleanup:v2 -- --codes GIFTSTORE,SHOESSHOP        (an exact subset)
 *
 *   # 2. execute — only with the token of a dry run of the SAME data, the
 *   #    database host you mean (as the dry run printed it), the operator's
 *   #    name, a verified pg_dump of THIS database taken in the last 24 hours,
 *   #    and a folder the files are copied to before anything is removed
 *   npm run seller:cleanup:v2 -- --execute --confirm SC-XXXXXXXXXXXX \
 *       --expect-host <database host> --expect-project <project ref> --actor "Owner name" \
 *       --backup C:/Users/mahir/aadione-db-backups/<file>.dump \
 *       --files-backup C:/Users/mahir/aadione-db-backups/files
 *
 *   #    add --purge-financial to BOTH the dry run and the execute to also delete
 *   #    the paid/refunded orders, payment rows, refunds, payment events and
 *   #    settlements of these sellers (the owner's explicit choice for dummy data)
 *
 *   # 3. only if some file removals failed after the commit: retry them
 *   npm run seller:cleanup:v2 -- --resume-files <manifest.json from step 2>
 *
 * Prints counts, codes, names and masked numbers only — never a credential,
 * a bank detail or a customer's contact.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prisma } from '../src/infra/db/prisma';
import {
  databaseTarget,
  deletePlannedFiles,
  executeSellerCleanup,
  formatPlan,
  planSellerCleanup,
  type CleanupMode,
  type FileResult,
} from '../src/modules/maintenance/seller-cleanup';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const BACKUP_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * A backup taken for this run: exists, non-empty, recent, readable by
 * pg_restore, dumped from the database this run targets, and containing the
 * seller data. Returns a one-line description for the audit record.
 */
function verifyBackup(path: string, expectedDatabase: string): string {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0) throw new Error(`backup ${path} is empty or not a file`);
  if (Date.now() - info.mtimeMs > BACKUP_MAX_AGE_MS) throw new Error(`backup ${path} is older than 24 hours — take a fresh one`);
  const pgRestore = process.env['PG_RESTORE'] ?? 'pg_restore';
  const listed = spawnSync(pgRestore, ['--list', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.error) {
    if (!flag('backup-verified')) {
      throw new Error(`pg_restore is not available to check ${path}; verify it yourself and add --backup-verified (or set PG_RESTORE)`);
    }
    return `${path} (${info.size} bytes, checked by the operator)`;
  }
  if (listed.status !== 0) throw new Error(`pg_restore --list could not read ${path}`);
  const header = (name: string) => listed.stdout.match(new RegExp(`^;\\s*${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? 'unknown';
  const dumpedDb = header('dbname');
  const created = listed.stdout.match(/^;\s*Archive created at (.+)$/m)?.[1]?.trim() ?? 'unknown';
  if (dumpedDb !== expectedDatabase) throw new Error(`backup ${path} was dumped from database "${dumpedDb}", not "${expectedDatabase}"`);
  for (const table of ['sellers', 'seller_orders', 'payments', 'audit_logs']) {
    if (!new RegExp(`TABLE DATA \\S+ ${table} `).test(listed.stdout)) throw new Error(`backup ${path} has no data for table ${table}`);
  }
  const entries = listed.stdout.split('\n').filter((line) => line.trim() && !line.startsWith(';')).length;
  return `${path} (${info.size} bytes, database "${dumpedDb}", created ${created}, ${entries} archive entries, pg_restore --list OK)`;
}

function writeReports(name: string, json: unknown, text: string): string {
  const dir = arg('out') ?? join(tmpdir(), 'aadione-seller-cleanup');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  writeFileSync(`${base}.txt`, text);
  return base;
}

function summariseFiles(files: FileResult[]): string {
  const by = (status: FileResult['status']) => files.filter((file) => file.status === status).length;
  return `${by('deleted')} deleted, ${by('already_absent')} already absent, ${by('kept_still_referenced')} kept (still referenced), ${by('failed')} failed`;
}

async function main(): Promise<void> {
  const codes = arg('codes')?.split(',').map((code) => code.trim()).filter(Boolean) ?? null;
  // The owner's explicit choice: also delete these sellers' paid/refunded orders, payment rows and settlements.
  const mode: CleanupMode = flag('purge-financial') ? 'purge-financial' : 'preserve';

  if (flag('global-orders') || flag('global-audit-logs')) {
    console.error(
      'Global order / audit-log deletion is not done by this tool: it would remove other customers\' and sellers\' records\n' +
        'and payment history. The dry run counts them; a global deletion needs its own reviewed, separately approved operation.',
    );
    process.exit(2);
  }

  const resume = arg('resume-files');
  if (resume) {
    const manifest = JSON.parse(readFileSync(resume, 'utf8')) as { runId: string; aborted?: boolean; files: FileResult[] };
    if (manifest.aborted) {
      console.error(`REFUSING: run ${manifest.runId} was rolled back — its database rows still exist, so its files are kept.`);
      process.exit(2);
    }
    const files = await deletePlannedFiles(manifest.files);
    writeFileSync(resume, JSON.stringify({ ...manifest, files }, null, 2));
    console.log(`run ${manifest.runId} files: ${summariseFiles(files)}`);
    if (files.some((file) => file.status === 'failed')) process.exitCode = 1;
    return;
  }

  if (!flag('execute')) {
    const plan = await planSellerCleanup(codes, undefined, { mode });
    const text = formatPlan(plan);
    const base = writeReports('seller-cleanup-dry-run', plan, text);
    console.log(text);
    console.log(`\nreports: ${base}.json / ${base}.txt`);
    console.log('\nNOTHING WAS CHANGED. To execute exactly this plan: take a fresh pg_dump of this database, then run with');
    console.log(
      `  --execute --confirm ${plan.token} --expect-host ${plan.target.host}` +
        (plan.target.project !== '-' ? ` --expect-project ${plan.target.project}` : '') +
        ' --actor "<your name>" --backup <dump file>' +
        (mode === 'purge-financial' ? ' --purge-financial' : '') +
        (plan.files.length > 0 ? ' --files-backup <folder>' : ''),
    );
    return;
  }

  const confirmToken = arg('confirm');
  const actor = arg('actor');
  const backup = arg('backup');
  const expectHost = arg('expect-host');
  if (!confirmToken || !actor || !backup || !expectHost) {
    console.error('--execute needs --confirm <token from the dry run>, --expect-host <database host>, --actor "<your name>" and --backup <verified dump file>');
    process.exit(2);
  }
  const target = databaseTarget();
  if (target.host !== expectHost) {
    console.error(`REFUSING: this run targets host ${target.host}, not the --expect-host you gave (${expectHost}).`);
    process.exit(2);
  }
  // A shared pooler host serves many projects: the project must be named too.
  if (target.project !== '-' && arg('expect-project') !== target.project) {
    console.error(`REFUSING: this run targets project ${target.project} on ${target.host}; pass --expect-project ${target.project} only if that is the database you mean.`);
    process.exit(2);
  }
  const backupNote = verifyBackup(backup, target.database);
  console.log(`backup verified: ${backupNote}`);

  const result = await executeSellerCleanup(codes, { confirmToken, actor, backupNote, filesBackupDir: arg('files-backup') ?? null, mode });
  const text = [
    `SELLER CLEANUP — EXECUTED (run ${result.runId}) on host ${result.target.host}, project ${result.target.project}, database ${result.target.database}`,
    ...result.results.map((r) => `  ${r.code}: ${r.outcome} — ${r.detail}`),
    `  mode: ${result.mode}; orders deleted: ${result.deletedOrders}; settlements deleted: ${result.deletedSettlements}; audit entries deleted: ${result.deletedAuditLogs}; banners unpublished: ${result.unpublishedBanners}`,
    `  staff accounts: ${JSON.stringify(result.staff)}`,
    `  files: ${summariseFiles(result.files)}${result.manifestPath ? ` (backup + manifest: ${result.manifestPath})` : ''}`,
    `  verification: ${result.verification.ok ? 'OK' : `PROBLEMS: ${result.verification.problems.join('; ')}`}`,
    '',
    'Database restore if ever needed: pg_restore --clean --if-exists --no-owner -d <database url> <dump file>',
    'Files: copies are in the backup folder above, laid out by storage key (images/, documents/) — the documents are',
    'private seller PDFs: keep that folder access-restricted and delete it once you no longer need a restore.',
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
