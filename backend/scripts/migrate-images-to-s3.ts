/**
 * Moves the V2 images (and, with --documents, the seller documents) from local
 * disk to the V2 Supabase Storage buckets, and repoints the image URLs.
 *
 *   npm run images:to-s3:v2
 *       DRY RUN (default): reads the database, the local files and the
 *       buckets; reports what would be uploaded and every URL that would
 *       change. Writes nothing anywhere.
 *
 *   npm run images:to-s3:v2 -- --execute --confirm-project=<project-ref>
 *       1. uploads the missing objects and verifies each one by its public URL
 *          (status, size, MD5) — any failure stops before the database;
 *       2. repoints the URL columns in ONE serializable transaction (each
 *          change only if the row still holds the old URL; every other column
 *          fingerprinted before/after — any difference rolls back);
 *       3. re-checks every new URL publicly.
 *
 *   --documents        also copy the seller documents (KYC PDFs) to the
 *                      PRIVATE bucket (S3_PRIVATE_BUCKET) under their existing
 *                      keys. The database stores keys, so nothing there changes.
 *   --no-cache-control upload images without the one-year Cache-Control header.
 *   --rollback <manifest> --confirm-project=<ref>
 *                      points the rows back at their old local URLs (one
 *                      transaction, only rows still on the new URL). Objects
 *                      stay in the bucket.
 *
 * Public checks use GET, never HEAD: Supabase/Cloudflare answer HEAD with
 * `cache-control: no-cache` regardless of the stored value. Reads are retried
 * (3 attempts, 30 s timeout each) on network errors and 429/5xx, and every
 * failure reports its full cause chain; a PUT is never retried blindly — a
 * lost response is resolved by reading the object back.
 *
 * Never deletes a local file or a bucket object, never overwrites an existing
 * object, and changes nothing but the image URL columns. Only images the database references are moved; the
 * unreferenced files stay local. Re-runnable: identical objects already in a
 * bucket are skipped, and rows already on the new URL are left alone.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';

import { env } from '../src/config/env';
import { IMAGE_CACHE_CONTROL, presignS3 } from '../src/infra/storage';

/* -------------------------------------------------------------------------- */
/* Expectations from the audit (2026-10-08)                                   */
/* -------------------------------------------------------------------------- */

/** URL values pointing at local storage, and the distinct files behind them. */
const EXPECTED_LOCAL_URL_VALUES = 130;
const EXPECTED_LOCAL_KEYS = 57;
const EXPECTED_DOCUMENTS = 8;

/** The image URL columns — the ONLY columns this script ever writes. */
const URL_COLUMNS = [
  { table: 'product_images', column: 'url' },
  { table: 'product_images', column: 'thumb_url' },
  { table: 'product_images', column: 'card_url' },
  { table: 'categories', column: 'image_url' },
  { table: 'order_items', column: 'image_url' },
  { table: 'product_variants', column: 'image_url' },
  { table: 'brands', column: 'logo_url' },
] as const;
type UrlTable = (typeof URL_COLUMNS)[number]['table'];

/** Tables fingerprinted in full (no column of theirs is ever written). */
const UNTOUCHED_TABLES = [
  'users', 'sellers', 'seller_profiles', 'seller_bank_details', 'seller_documents', 'restaurant_profiles', 'seller_staff',
  'seller_listings', 'products', 'product_approval_batches', 'product_approval_batch_items', 'commission_rules',
  'configurations', 'stock_ledger', 'orders', 'seller_orders', '_prisma_migrations',
];

const LOCAL_ROOT = path.resolve(__dirname, '..', 'storage');
const PRIVATE_ROOT = path.resolve(__dirname, '..', 'storage-private');
const MANIFEST_DIR = path.resolve(__dirname, '..', 'image-migrations');

/* -------------------------------------------------------------------------- */

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const option = (name: string) => {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const execute = args.includes('--execute');
const withDocuments = args.includes('--documents');
const cacheControl = args.includes('--no-cache-control') ? undefined : IMAGE_CACHE_CONTROL;
const rollbackFile = option('--rollback');
const confirmProject = option('--confirm-project');

class Abort extends Error {}
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (!ok) failures.push(label);
};
const stopIfFailed = (stage: string) => {
  if (failures.length) throw new Abort(`${stage}: ${failures.length} check(s) failed`);
};
const h = (title: string) => console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 74 - title.length))}`);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');

/* -------------------------------------------------------------------------- */
/* Network: exact errors, bounded retries for reads                           */
/* -------------------------------------------------------------------------- */

/**
 * Node's fetch reports every network failure as `TypeError: fetch failed`;
 * the real reason (ECONNRESET, a TLS reset, a connect timeout, DNS…) is in the
 * `cause` chain. Spell it all out.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const e = current as { name?: string; code?: string; syscall?: string; address?: string; port?: number; message?: string; errors?: unknown[]; cause?: unknown };
    parts.push([e.name, e.code, e.syscall, e.address && `${e.address}${e.port ? `:${e.port}` : ''}`, e.message].filter(Boolean).join(' '));
    if (Array.isArray(e.errors) && e.errors.length) parts.push(`[${e.errors.map((x) => describeError(x)).join(' | ')}]`);
    current = e.cause;
  }
  return parts.join(' <- ');
}

const TRANSIENT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_|TimeoutError|AbortError|other side closed|socket hang up/i;
const READ_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Fetched {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/**
 * GET with a timeout, retried on network errors and on 429/5xx — safe because
 * reads change nothing. `makeUrl` is re-evaluated per attempt (fresh
 * signature). `label` is what errors show: never the URL itself, since a
 * signed URL carries the access key id.
 */
async function read(makeUrl: () => string, label: string): Promise<Fetched> {
  let lastError = '';
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(makeUrl(), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = new Uint8Array(await response.arrayBuffer());
      if (response.status !== 429 && response.status < 500) return { status: response.status, headers: response.headers, body };
      lastError = `HTTP ${response.status} ${Buffer.from(body).toString('utf8').slice(0, 200)}`;
    } catch (error) {
      lastError = describeError(error);
      if (!TRANSIENT.test(lastError)) break;
    }
    if (attempt < READ_ATTEMPTS) {
      console.log(`    retry ${attempt}/${READ_ATTEMPTS - 1} GET ${label}: ${lastError}`);
      await sleep(1000 * 3 ** (attempt - 1));
    }
  }
  throw new Error(`GET ${label} failed after ${READ_ATTEMPTS} attempt(s): ${lastError}`);
}

/** Real format from the bytes — never from the extension or a header. */
function contentTypeOf(bytes: Buffer): string | null {
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(4, 12).toString('latin1') === 'ftypavif') return 'image/avif';
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
const EXTENSION_TYPES: Record<string, string> = {
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.avif': 'image/avif', '.pdf': 'application/pdf',
};

/** `<anything>/static/<key>` — the shape of every local-storage URL. */
function localKeyOf(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/static\/(.+)$/.exec(url);
  const key = m?.[1];
  return key && !key.includes('..') && /^[A-Za-z0-9/_.-]+$/.test(key) ? key : null;
}
const publicBase = () => env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '');
const newUrlOf = (key: string) => `${publicBase()}/${key}`;

/* -------------------------------------------------------------------------- */
/* Bucket access (signed requests; credentials are never printed)              */
/* -------------------------------------------------------------------------- */

type ObjectState = { state: 'missing' } | { state: 'identical' } | { state: 'different'; md5: string; size: number };

async function objectState(bucket: string, key: string, localMd5: string): Promise<ObjectState> {
  const fetched = await read(() => presignS3('GET', bucket, key, undefined, 120), `s3://${bucket}/${key}`);
  if (fetched.status === 404) {
    // A missing bucket is a 404 too — never mistake it for "not uploaded yet".
    if (/NoSuchBucket/i.test(Buffer.from(fetched.body).toString('utf8'))) throw new Error(`bucket "${bucket}" does not exist in this project`);
    return { state: 'missing' };
  }
  if (fetched.status !== 200) {
    throw new Error(`GET s3://${bucket}/${key}: HTTP ${fetched.status} ${Buffer.from(fetched.body).toString('utf8').slice(0, 200)}`);
  }
  const remote = md5(fetched.body);
  return remote === localMd5 ? { state: 'identical' } : { state: 'different', md5: remote, size: fetched.body.byteLength };
}

/**
 * One PUT of an object the caller found MISSING — never an overwrite. A PUT
 * is not retried blindly: if its response is lost, the object is read back,
 * and an identical object means the upload landed.
 */
async function upload(bucket: string, key: string, body: Buffer, contentType: string, localMd5: string, cache?: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (cache) headers['Cache-Control'] = cache;
  let failure: string;
  try {
    const response = await fetch(presignS3('PUT', bucket, key, contentType, 300, cache), {
      method: 'PUT',
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
    });
    const text = await response.text();
    if (response.ok) return;
    failure = `HTTP ${response.status} ${text.slice(0, 300)}`;
  } catch (error) {
    failure = describeError(error);
  }
  const state = await objectState(bucket, key, localMd5);
  if (state.state === 'identical') {
    console.log(`    PUT s3://${bucket}/${key} reported "${failure}", but the object is there and identical — continuing`);
    return;
  }
  throw new Error(`PUT s3://${bucket}/${key} failed: ${failure} (object afterwards: ${state.state})`);
}

/**
 * The public URL serves exactly the local bytes, as the right type, with the
 * expected Cache-Control. Checked on a GET: Supabase/Cloudflare answer a HEAD
 * on a revalidation path that always says `cache-control: no-cache`, whatever
 * the object's stored value.
 */
async function verifyPublic(url: string, localMd5: string, size: number, contentType: string, cache?: string): Promise<string | null> {
  const fetched = await read(() => url, url);
  if (fetched.status !== 200) return `HTTP ${fetched.status}`;
  if (fetched.body.byteLength !== size) return `size ${fetched.body.byteLength} != ${size}`;
  if (md5(fetched.body) !== localMd5) return 'content differs';
  const served = fetched.headers.get('content-type') ?? '';
  if (!served.startsWith(contentType)) return `served as ${served}`;
  const servedCache = fetched.headers.get('cache-control') ?? '(none)';
  if (cache && servedCache !== cache) return `cache-control "${servedCache}" != "${cache}"`;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Preconditions                                                              */
/* -------------------------------------------------------------------------- */

function projectRefs(): { db: string; endpoint: string; publicUrl: string } {
  const db = decodeURIComponent(new URL(process.env['DATABASE_URL'] ?? 'postgresql://x@x/x').username).split('.')[1] ?? '?';
  const endpoint = env.S3_ENDPOINT ? new URL(env.S3_ENDPOINT).hostname.split('.')[0]! : '?';
  const publicUrl = new URL(env.STORAGE_PUBLIC_BASE_URL).hostname.split('.')[0]!;
  return { db, endpoint, publicUrl };
}

async function preconditions(): Promise<string> {
  h('0. Target');
  const refs = projectRefs();
  console.log(`  database project: ${refs.db}   S3 endpoint project: ${refs.endpoint}   public URL project: ${refs.publicUrl}`);
  console.log(`  image bucket: ${env.S3_BUCKET ?? '-'}   documents bucket: ${env.S3_PRIVATE_BUCKET ?? '-'}   cache-control: ${cacheControl ?? '(none)'}`);
  check(env.STORAGE_PROVIDER === 's3', 'STORAGE_PROVIDER=s3');
  check(Boolean(env.S3_BUCKET && env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY), 'S3 endpoint, bucket and credentials are configured');
  check(refs.db === refs.endpoint && refs.db === refs.publicUrl, 'database, S3 endpoint and public URL belong to the SAME project');
  check(new RegExp(`/storage/v1/object/public/${env.S3_BUCKET}$`).test(publicBase()), 'STORAGE_PUBLIC_BASE_URL is the public URL of S3_BUCKET');
  if (execute || rollbackFile) check(confirmProject === refs.db, `--confirm-project matches the target project (${refs.db})`);
  // Supabase's own bucket table is the authority on what is public.
  const buckets = await prisma.$queryRawUnsafe<{ id: string; public: boolean }[]>(`SELECT id, public FROM storage.buckets`);
  const isPublic = (id: string | undefined) => buckets.find((b) => b.id === id)?.public;
  check(isPublic(env.S3_BUCKET) === true, `image bucket "${env.S3_BUCKET}" exists and is public`);
  if (withDocuments) {
    check(Boolean(env.S3_PRIVATE_BUCKET) && env.S3_PRIVATE_BUCKET !== env.S3_BUCKET, 'S3_PRIVATE_BUCKET is set and is not the image bucket');
    check(isPublic(env.S3_PRIVATE_BUCKET) === false, `documents bucket "${env.S3_PRIVATE_BUCKET}" exists and is NOT public`);
  }
  const [db] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name = '20260926140446_v2_baseline' AND finished_at IS NOT NULL`,
  );
  check(Number(db?.n) === 1, 'target database is a migrated V2 database');
  stopIfFailed('preconditions');
  return refs.db;
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

interface UrlChange {
  table: UrlTable;
  column: string;
  id: string;
  oldUrl: string;
  newUrl: string;
}

interface LocalObject {
  key: string;
  file: string;
  bytes: Buffer;
  md5: string;
  contentType: string;
  refs: number;
}

async function collectImageChanges(): Promise<{ changes: UrlChange[]; objects: LocalObject[]; alreadyMigrated: number; foreign: string[] }> {
  const changes: UrlChange[] = [];
  const foreign: string[] = [];
  let alreadyMigrated = 0;
  for (const { table, column } of URL_COLUMNS) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; url: string }[]>(
      `SELECT id::text AS id, "${column}" AS url FROM "${table}" WHERE "${column}" IS NOT NULL ORDER BY id`,
    );
    for (const row of rows) {
      if (row.url.startsWith(`${publicBase()}/`)) {
        alreadyMigrated += 1;
        continue;
      }
      const key = localKeyOf(row.url);
      if (!key) {
        foreign.push(`${table}.${column} ${row.id}: ${row.url}`);
        continue;
      }
      changes.push({ table, column, id: row.id, oldUrl: row.url, newUrl: newUrlOf(key) });
    }
  }
  const objects = new Map<string, LocalObject>();
  for (const change of changes) {
    const key = localKeyOf(change.oldUrl)!;
    const existing = objects.get(key);
    if (existing) {
      existing.refs += 1;
      continue;
    }
    const file = path.join(LOCAL_ROOT, key);
    if (!existsSync(file)) {
      check(false, `local file exists for ${key}`);
      continue;
    }
    const bytes = readFileSync(file);
    const contentType = contentTypeOf(bytes);
    const byExtension = EXTENSION_TYPES[path.extname(key).toLowerCase()];
    if (!contentType || !contentType.startsWith('image/') || contentType !== byExtension) {
      check(false, `${key} is a ${contentType ?? 'unknown'} file matching its extension`);
      continue;
    }
    objects.set(key, { key, file, bytes, md5: md5(bytes), contentType, refs: 1 });
  }
  return { changes, objects: [...objects.values()], alreadyMigrated, foreign };
}

/** md5 over every row with the image URL columns removed — must not change. */
async function fingerprints(tx: Prisma.TransactionClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const urlColumnsByTable = new Map<string, string[]>();
  for (const { table, column } of URL_COLUMNS) urlColumnsByTable.set(table, [...(urlColumnsByTable.get(table) ?? []), column]);
  for (const [table, columns] of urlColumnsByTable) {
    const strip = columns.map((c) => ` - '${c}'`).join('');
    const [row] = await tx.$queryRawUnsafe<{ fp: string }[]>(
      `SELECT md5(coalesce(string_agg((to_jsonb(t)${strip})::text, '|' ORDER BY t.id), '')) || '/' || count(*) AS fp FROM "${table}" t`,
    );
    out[`${table} (all but ${columns.join(', ')})`] = row!.fp;
  }
  for (const table of UNTOUCHED_TABLES) {
    const [row] = await tx.$queryRawUnsafe<{ fp: string }[]>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) || '/' || count(*) AS fp FROM "${table}" t`,
    );
    out[table] = row!.fp;
  }
  return out;
}

async function migrateImages(projectRef: string): Promise<void> {
  h('1. Images: database references -> local files');
  const { changes, objects, alreadyMigrated, foreign } = await collectImageChanges();
  const byColumn: Record<string, number> = {};
  for (const c of changes) byColumn[`${c.table}.${c.column}`] = (byColumn[`${c.table}.${c.column}`] ?? 0) + 1;
  console.log(`  URL values on local storage: ${changes.length}  ${JSON.stringify(byColumn)}`);
  console.log(`  URL values already on ${publicBase()}: ${alreadyMigrated}`);
  console.log(`  URL values that are not ours (left untouched): ${foreign.length}`);
  for (const f of foreign.slice(0, 10)) console.log(`    ${f}`);
  console.log(`  distinct files: ${objects.length}, ${kb(objects.reduce((a, o) => a + o.bytes.byteLength, 0))}`);

  if (changes.length === 0) {
    console.log('  Nothing to migrate: every image URL is already on the bucket.');
    await verifyLiveImages('2. Images');
    return;
  }
  check(changes.length === EXPECTED_LOCAL_URL_VALUES, `exactly the audited ${EXPECTED_LOCAL_URL_VALUES} URL values are on local storage`);
  check(objects.length === EXPECTED_LOCAL_KEYS, `exactly the audited ${EXPECTED_LOCAL_KEYS} files back them`);
  stopIfFailed('image inventory');

  h(`2. Images: bucket "${env.S3_BUCKET}"`);
  const toUpload: LocalObject[] = [];
  for (const object of objects) {
    const state = await objectState(env.S3_BUCKET!, object.key, object.md5);
    if (state.state === 'missing') toUpload.push(object);
    if (state.state === 'different') check(false, `${object.key}: a DIFFERENT object already exists in the bucket (${state.size} bytes)`);
    console.log(`  ${state.state.padEnd(9)} ${object.contentType.padEnd(10)} ${kb(object.bytes.byteLength).padStart(9)}  ${object.key}  [${object.refs} URL value(s)]`);
  }
  console.log(`  to upload: ${toUpload.length}, already identical in the bucket: ${objects.length - toUpload.length}`);
  stopIfFailed('bucket comparison');

  console.log('\n  URL changes (sample):');
  for (const c of changes.slice(0, 4)) console.log(`    ${c.table}.${c.column} ${c.id}\n      ${c.oldUrl}\n   -> ${c.newUrl}`);

  if (!execute) return;

  h('3. Images: upload + public verification');
  for (const object of toUpload) {
    await upload(env.S3_BUCKET!, object.key, object.bytes, object.contentType, object.md5, cacheControl);
    console.log(`  uploaded ${object.key}`);
  }
  for (const object of objects) {
    let problem: string | null;
    try {
      problem = await verifyPublic(newUrlOf(object.key), object.md5, object.bytes.byteLength, object.contentType, cacheControl);
    } catch (error) {
      problem = describeError(error);
    }
    check(problem === null, `public URL serves ${object.key}${problem ? ` — ${problem}` : ''}`);
  }
  stopIfFailed('upload verification (the database was NOT changed)');

  h('4. Images: database (one transaction)');
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const manifestFile = path.join(MANIFEST_DIR, `to-s3-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const manifest = { createdAt: new Date().toISOString(), project: projectRef, publicBase: publicBase(), status: 'pending', changes };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  await prisma.$transaction(
    async (tx) => {
      const before = await fingerprints(tx);
      let updated = 0;
      for (const c of changes) {
        const column = URL_COLUMNS.find((u) => u.table === c.table && u.column === c.column)!.column; // whitelisted
        const rows = await tx.$executeRawUnsafe(
          `UPDATE "${c.table}" SET "${column}" = $1 WHERE id = $2::uuid AND "${column}" = $3`,
          c.newUrl,
          c.id,
          c.oldUrl,
        );
        if (rows !== 1) check(false, `${c.table}.${column} ${c.id} still held its old URL`);
        updated += rows;
      }
      check(updated === changes.length, `UPDATE: ${updated} URL value(s) repointed (expected ${changes.length})`);
      const after = await fingerprints(tx);
      for (const [name, fp] of Object.entries(before)) check(after[name] === fp, `unchanged: ${name} (${fp.split('/')[1]} rows)`);
      let remaining = 0;
      for (const { table, column } of URL_COLUMNS) {
        const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE "${column}" ~ '^https?://[^/]+/static/'`);
        remaining += Number(row?.n ?? 0);
      }
      check(remaining === 0, `no image URL points at local storage any more (${remaining})`);
      stopIfFailed('database update');
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 30_000 },
  );
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, status: 'committed', committedAt: new Date().toISOString() }, null, 2));
  console.log(`  COMMITTED. Manifest: ${manifestFile}`);

  await verifyLiveImages('5. Images', 'the database change above IS committed — nothing was rolled back');
}

/**
 * Every image URL the database holds, checked publicly on a GET: HTTP 200,
 * the exact local bytes (when the local file still exists), the content type
 * and — unless --no-cache-control — the Cache-Control header. Read-only;
 * each URL's failure is collected with its exact cause rather than stopping
 * at the first one.
 */
async function verifyLiveImages(stage: string, context = 'read-only check'): Promise<void> {
  h(`${stage}: every image URL in the database, publicly (GET)`);
  const rows = await Promise.all(
    URL_COLUMNS.map(({ table, column }) =>
      prisma.$queryRawUnsafe<{ url: string }[]>(`SELECT DISTINCT "${column}" AS url FROM "${table}" WHERE "${column}" IS NOT NULL`),
    ),
  );
  const urls = [...new Set(rows.flat().map((r) => r.url))].sort();
  const problems: string[] = [];
  for (const url of urls) {
    if (!url.startsWith(`${publicBase()}/`)) {
      problems.push(`${url} — not on ${publicBase()}`);
      continue;
    }
    const key = url.slice(publicBase().length + 1);
    const file = path.join(LOCAL_ROOT, key);
    try {
      let problem: string | null;
      if (existsSync(file)) {
        const bytes = readFileSync(file);
        problem = await verifyPublic(url, md5(bytes), bytes.byteLength, contentTypeOf(bytes) ?? 'image/', cacheControl);
      } else {
        const fetched = await read(() => url, url);
        const servedCache = fetched.headers.get('cache-control') ?? '(none)';
        problem =
          fetched.status !== 200 ? `HTTP ${fetched.status}`
          : cacheControl && servedCache !== cacheControl ? `cache-control "${servedCache}" != "${cacheControl}"`
          : null;
      }
      if (problem) problems.push(`${key} — ${problem}`);
    } catch (error) {
      problems.push(`${key} — ${describeError(error)}`);
    }
  }
  for (const p of problems.slice(0, 15)) console.log(`    ${p}`);
  check(
    problems.length === 0,
    `${urls.length - problems.length}/${urls.length} image URLs serve the expected bytes and type${cacheControl ? ` with Cache-Control "${cacheControl}"` : ''}`,
  );
  stopIfFailed(`public verification (${context})`);
}

/* -------------------------------------------------------------------------- */
/* Seller documents (--documents)                                             */
/* -------------------------------------------------------------------------- */

async function migrateDocuments(): Promise<void> {
  h(`6. Seller documents -> PRIVATE bucket "${env.S3_PRIVATE_BUCKET}"`);
  const rows = await prisma.$queryRawUnsafe<{ id: string; file_key: string | null }[]>(`SELECT id::text AS id, file_key FROM seller_documents ORDER BY id`);
  const keyed = rows.filter((r) => r.file_key);
  check(rows.length === EXPECTED_DOCUMENTS && keyed.length === EXPECTED_DOCUMENTS, `exactly the audited ${EXPECTED_DOCUMENTS} documents, each with a file key`);
  const docs: LocalObject[] = [];
  for (const row of keyed) {
    const key = row.file_key!;
    const file = path.join(PRIVATE_ROOT, key);
    const valid = /^seller-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/i.test(key) && existsSync(file);
    if (!valid) {
      check(false, `document ${row.id}: well-formed key with a local file (${key})`);
      continue;
    }
    const bytes = readFileSync(file);
    if (contentTypeOf(bytes) !== 'application/pdf') {
      check(false, `document ${key} is a PDF`);
      continue;
    }
    docs.push({ key, file, bytes, md5: md5(bytes), contentType: 'application/pdf', refs: 1 });
  }
  stopIfFailed('document inventory');

  const toUpload: LocalObject[] = [];
  for (const doc of docs) {
    const state = await objectState(env.S3_PRIVATE_BUCKET!, doc.key, doc.md5);
    if (state.state === 'missing') toUpload.push(doc);
    if (state.state === 'different') check(false, `${doc.key}: a DIFFERENT object already exists in the documents bucket`);
    console.log(`  ${state.state.padEnd(9)} ${kb(doc.bytes.byteLength).padStart(9)}  ${doc.key}`);
  }
  console.log(`  to upload: ${toUpload.length}, already identical: ${docs.length - toUpload.length}. The database stores keys — no row changes.`);
  stopIfFailed('documents bucket comparison');
  if (!execute) return;

  for (const doc of toUpload) {
    await upload(env.S3_PRIVATE_BUCKET!, doc.key, doc.bytes, doc.contentType, doc.md5);
    console.log(`  uploaded ${doc.key}`);
  }

  // Every document — uploaded now or already there — reads back identical
  // with a signature, and is never reachable without one.
  const origin = new URL(env.STORAGE_PUBLIC_BASE_URL).origin;
  for (const doc of docs) {
    try {
      const state = await objectState(env.S3_PRIVATE_BUCKET!, doc.key, doc.md5);
      check(state.state === 'identical', `signed read returns the exact local bytes: ${doc.key}`);
      const publicUrl = `${origin}/storage/v1/object/public/${env.S3_PRIVATE_BUCKET}/${doc.key}`;
      const exposed = await read(() => publicUrl, publicUrl);
      check(exposed.status !== 200, `NOT publicly readable (HTTP ${exposed.status}): ${doc.key}`);
    } catch (error) {
      check(false, `verify ${doc.key} — ${describeError(error)}`);
    }
  }
  stopIfFailed('document verification');
  console.log(`  ${toUpload.length} document(s) uploaded; all ${docs.length} verified. Local files kept.`);
}

/* -------------------------------------------------------------------------- */
/* Rollback                                                                   */
/* -------------------------------------------------------------------------- */

async function rollback(file: string, projectRef: string): Promise<void> {
  h('Rollback');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { project: string; publicBase: string; changes: UrlChange[] };
  check(manifest.project === projectRef, `manifest was written for this project (${manifest.project})`);
  stopIfFailed('rollback preconditions');
  await prisma.$transaction(
    async (tx) => {
      let restored = 0;
      for (const c of manifest.changes) {
        const column = URL_COLUMNS.find((u) => u.table === c.table && u.column === c.column)?.column;
        if (!column) throw new Abort(`unexpected column ${c.table}.${c.column} in the manifest`);
        restored += await tx.$executeRawUnsafe(
          `UPDATE "${c.table}" SET "${column}" = $1 WHERE id = $2::uuid AND "${column}" = $3`,
          c.oldUrl,
          c.id,
          c.newUrl,
        );
      }
      console.log(`  ${restored} of ${manifest.changes.length} URL value(s) restored (rows changed since were left alone).`);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300_000, maxWait: 30_000 },
  );
  console.log('  Objects stay in the bucket. Local URLs only load with STORAGE_PROVIDER=local.');
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const mode = rollbackFile ? 'ROLLBACK' : execute ? 'EXECUTE' : 'DRY RUN (writes nothing)';
  console.log(`V2 STORAGE MIGRATION — ${mode}${withDocuments ? ' — images + seller documents' : ' — images'}`);
  try {
    const projectRef = await preconditions();
    if (rollbackFile) {
      await rollback(rollbackFile, projectRef);
      return;
    }
    await migrateImages(projectRef);
    if (withDocuments) await migrateDocuments();
    h('Result');
    console.log(execute ? '  DONE. Local files were not deleted.' : '  DRY RUN complete — nothing was uploaded and the database was not touched.');
    if (!execute) console.log(`  To execute: npm run images:to-s3:v2 -- --execute${withDocuments ? ' --documents' : ''} --confirm-project=${projectRef}`);
  } catch (error) {
    h('Result');
    for (const f of failures) console.log(`  FAILED: ${f}`);
    console.log(`  STOPPED: ${error instanceof Abort ? error.message : describeError(error)}`);
    console.log('  Nothing after the failing step ran. A failed database step was rolled back. Local files were not touched.');
    process.exitCode = 1;
  }
}

main().finally(() => prisma.$disconnect());
