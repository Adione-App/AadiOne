/**
 * Existing-image migration: re-stores already-uploaded product and category
 * images as optimised WebP (the same pipeline new uploads go through —
 * src/modules/catalog/uploaded-image.service.ts).
 *
 * Nothing is destructive by default, and nothing is ever deleted implicitly:
 *
 *   npm run images:optimize:v2                       DRY RUN (default) — reads only, reports
 *   npm run images:optimize:v2 -- --apply            writes NEW .webp files (+ card thumbnails),
 *                                                    verifies each, then repoints the row.
 *                                                    Original files are kept. Writes a manifest
 *                                                    to backend/image-migrations/.
 *   npm run images:optimize:v2 -- --rollback <manifest>
 *                                                    points every migrated row back at its
 *                                                    original URL (originals were kept).
 *   npm run images:optimize:v2 -- --delete-originals <manifest>
 *                                                    deletes an original ONLY when its row still
 *                                                    uses the new file, the new file reads back
 *                                                    as a valid WebP, and no row anywhere
 *                                                    (order items included) still references it.
 *
 * Add `--limit N` to process only the first N files. `npm run images:optimize`
 * (no :v2) uses backend/.env — check what that points at first.
 *
 * Images whose URL is not one of ours (another environment's bucket, an
 * external link) are skipped and listed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { env } from '../src/config/env';
import { prisma } from '../src/infra/db/prisma';
import { MAX_IMAGE_BYTES, storage, storageKeyFromUrl } from '../src/infra/storage';
import { IMAGE_PROFILES, needsCardThumbnail, optimizeImage, type ImageProfile } from '../src/infra/storage/image-optimizer';
import { isStorageKeyReferenced } from '../src/modules/catalog/uploaded-image.service';

type Kind = 'product' | 'category';

interface ManifestEntry {
  table: 'product_images' | 'categories';
  id: string;
  oldUrl: string;
  oldThumbUrl: string | null;
  oldCardUrl: string | null;
  newUrl: string;
  newThumbUrl: string;
}

interface Manifest {
  createdAt: string;
  storageProvider: string;
  publicBaseUrl: string;
  entries: ManifestEntry[];
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const MANIFEST_DIR = path.resolve(__dirname, '..', 'image-migrations');
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const pct = (before: number, after: number) => (before === 0 ? '0%' : `${(((before - after) / before) * 100).toFixed(1)}%`);

/** Where a migrated copy goes: same folder and UUID, never the original's own key. */
function migratedKeys(key: string): { imageKey: string; thumbKey: string } {
  const base = key.replace(/\.[A-Za-z0-9]+$/, '');
  // An original that is already .webp must not be overwritten in place (no rollback).
  const stem = key.toLowerCase().endsWith('.webp') ? `${base}-opt` : base;
  return { imageKey: `${stem}.webp`, thumbKey: `${stem}-thumb.webp` };
}

async function verifyWebp(key: string, expected: { width: number; height: number }): Promise<void> {
  const body = await storage.get(key, MAX_IMAGE_BYTES);
  if (!body) throw new Error(`verification failed: ${key} not readable after upload`);
  const meta = await sharp(body).metadata();
  if (meta.format !== 'webp' || meta.width !== expected.width || meta.height !== expected.height) {
    throw new Error(`verification failed: ${key} is ${meta.format} ${meta.width}x${meta.height}`);
  }
  if (env.STORAGE_PROVIDER === 's3') {
    const response = await fetch(storage.publicUrl(key), { method: 'HEAD' });
    if (!response.ok) throw new Error(`verification failed: public URL for ${key} answered ${response.status}`);
  }
}

/* -------------------------------------------------------------------------- */

interface Target {
  table: ManifestEntry['table'];
  id: string;
  kind: Kind;
  url: string;
  thumbUrl: string | null;
  cardUrl: string | null;
}

async function loadTargets(): Promise<Target[]> {
  const [images, categories] = await Promise.all([
    prisma.productImage.findMany({ select: { id: true, url: true, thumbUrl: true, cardUrl: true }, orderBy: { createdAt: 'asc' } }),
    prisma.category.findMany({ where: { imageUrl: { not: null } }, select: { id: true, imageUrl: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  return [
    ...images.map((row) => ({ table: 'product_images' as const, id: row.id, kind: 'product' as const, url: row.url, thumbUrl: row.thumbUrl, cardUrl: row.cardUrl })),
    ...categories.map((row) => ({ table: 'categories' as const, id: row.id, kind: 'category' as const, url: row.imageUrl!, thumbUrl: null, cardUrl: null })),
  ];
}

/** Every file in local storage — the only provider whose objects this script can list. */
function listLocalFiles(): Map<string, number> {
  const root = path.resolve(process.cwd(), 'storage');
  const files = new Map<string, number>();
  if (!existsSync(root)) return files;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full).split(path.sep).join('/'), statSync(full).size);
    }
  };
  walk(root);
  return files;
}

async function run(apply: boolean): Promise<void> {
  const limit = Number(option('--limit') ?? Infinity);
  const targets = await loadTargets();
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — storage=${env.STORAGE_PROVIDER} base=${env.STORAGE_PUBLIC_BASE_URL}`);
  console.log(`${targets.length} image references (product_images + categories)\n`);

  const foreign: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const byKey = new Map<string, Target[]>();
  for (const target of targets) {
    const key = storageKeyFromUrl(target.url);
    if (!key) foreign.push(`${target.table}:${target.id} ${target.url}`);
    else byKey.set(key, [...(byKey.get(key) ?? []), target]);
  }

  const manifest: Manifest = {
    createdAt: new Date().toISOString(),
    storageProvider: env.STORAGE_PROVIDER,
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    entries: [],
  };
  const contentHashes = new Map<string, string[]>();
  let processed = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let thumbBytes = 0;
  let largestBefore = 0;
  let largestAfter = 0;
  let unchanged = 0;
  // What a product card downloads: `thumbUrl` (the full image until now).
  let cardBefore = 0;
  let cardAfter = 0;

  for (const [key, rows] of byKey) {
    if (processed >= limit) break;
    const source = await storage.get(key, Number.MAX_SAFE_INTEGER).catch(() => null);
    if (!source) {
      missing.push(key);
      continue;
    }
    processed += 1;
    const hash = createHash('sha256').update(source).digest('hex');
    contentHashes.set(hash, [...(contentHashes.get(hash) ?? []), key]);

    const kind: Kind = rows.some((row) => row.kind === 'product') ? 'product' : 'category';
    const profile: ImageProfile = kind === 'product' ? IMAGE_PROFILES.product : IMAGE_PROFILES.category;
    let meta: sharp.Metadata;
    let image;
    try {
      meta = await sharp(source).metadata();
      image = await optimizeImage(source, profile);
    } catch (error) {
      invalid.push(`${key}: ${(error as Error).message}`);
      continue;
    }

    // The original stays when converting would not help: a WebP that already
    // fits its box (re-encoding it — including this pipeline's own earlier
    // output — only loses quality), or any image the conversion would make
    // bigger (an already heavily compressed upload).
    const upright = (meta.orientation ?? 1) === 1;
    const keepMain =
      upright &&
      (meta.width ?? 0) <= profile.maxWidth &&
      (meta.height ?? 0) <= profile.maxHeight &&
      (meta.format === 'webp' || image.data.byteLength >= source.byteLength);
    const mainWidth = keepMain ? meta.width! : image.width;
    const mainHeight = keepMain ? meta.height! : image.height;
    const mainBytes = keepMain ? source.byteLength : image.data.byteLength;

    const lacksThumb = rows.some((row) => row.kind === 'product' && row.thumbUrl === row.url);
    const needsThumb = kind === 'product' && lacksThumb && needsCardThumbnail(mainWidth, mainHeight);
    const thumb = needsThumb ? await optimizeImage(source, IMAGE_PROFILES.productThumb) : null;

    beforeBytes += source.byteLength;
    afterBytes += mainBytes;
    thumbBytes += thumb?.data.byteLength ?? 0;
    largestBefore = Math.max(largestBefore, source.byteLength);
    largestAfter = Math.max(largestAfter, mainBytes);
    if (kind === 'product') {
      cardBefore += source.byteLength;
      cardAfter += thumb?.data.byteLength ?? mainBytes;
    }

    if (keepMain && !thumb) {
      unchanged += 1;
      continue;
    }
    console.log(
      `${key}\n    ${image.inputFormat} ${meta.width}x${meta.height} ${kb(source.byteLength)} -> ` +
        `${keepMain ? 'kept' : `webp ${mainWidth}x${mainHeight} ${kb(mainBytes)}`}` +
        `${thumb ? ` (+ thumb ${thumb.width}x${thumb.height} ${kb(thumb.data.byteLength)})` : ''}` +
        `  [${rows.length} row${rows.length === 1 ? '' : 's'}]`,
    );

    if (!apply) continue;

    const { imageKey, thumbKey } = migratedKeys(key);
    let newUrl = storage.publicUrl(key);
    if (!keepMain) {
      await storage.put(imageKey, image.data, image.contentType);
      await verifyWebp(imageKey, image);
      newUrl = storage.publicUrl(imageKey);
    }
    let newThumbUrl = newUrl;
    if (thumb) {
      await storage.put(thumbKey, thumb.data, thumb.contentType);
      await verifyWebp(thumbKey, thumb);
      newThumbUrl = storage.publicUrl(thumbKey);
    }

    for (const row of rows) {
      // Only if the row was not changed by someone else meanwhile.
      const updated =
        row.table === 'product_images'
          ? await prisma.productImage.updateMany({
              where: { id: row.id, url: row.url },
              data: { url: newUrl, thumbUrl: newThumbUrl, cardUrl: newThumbUrl },
            })
          : await prisma.category.updateMany({ where: { id: row.id, imageUrl: row.url }, data: { imageUrl: newUrl } });
      if (updated.count === 1) {
        manifest.entries.push({
          table: row.table,
          id: row.id,
          oldUrl: row.url,
          oldThumbUrl: row.thumbUrl,
          oldCardUrl: row.cardUrl,
          newUrl,
          newThumbUrl,
        });
      }
    }
  }

  const duplicates = [...contentHashes.values()].filter((keys) => keys.length > 1);

  console.log('\n=== Summary ===');
  console.log(`files processed:        ${processed}${Number.isFinite(limit) ? ` (limit ${limit})` : ''}`);
  console.log(`already optimal (kept): ${unchanged}`);
  console.log(`before (main images):   ${kb(beforeBytes)}  avg ${kb(processed ? beforeBytes / processed : 0)}  largest ${kb(largestBefore)}`);
  console.log(`after  (main images):   ${kb(afterBytes)}  avg ${kb(processed ? afterBytes / processed : 0)}  largest ${kb(largestAfter)}  (-${pct(beforeBytes, afterBytes)})`);
  console.log(`card thumbnails added:  ${kb(thumbBytes)}`);
  console.log(`after incl. thumbnails: ${kb(afterBytes + thumbBytes)}  (-${pct(beforeBytes, afterBytes + thumbBytes)})`);
  console.log(`product card download:  ${kb(cardBefore)} -> ${kb(cardAfter)}  (-${pct(cardBefore, cardAfter)})`);
  console.log(`not ours (skipped):     ${foreign.length}`);
  foreign.slice(0, 10).forEach((line) => console.log(`    ${line}`));
  console.log(`missing in storage:     ${missing.length}`);
  missing.slice(0, 10).forEach((line) => console.log(`    ${line}`));
  console.log(`not a valid image:      ${invalid.length}`);
  invalid.slice(0, 10).forEach((line) => console.log(`    ${line}`));
  console.log(`identical content:      ${duplicates.length} group(s)`);
  duplicates.slice(0, 10).forEach((keys) => console.log(`    ${keys.join('  ==  ')}`));

  if (env.STORAGE_PROVIDER === 'local') {
    const files = listLocalFiles();
    const orphans: Array<[string, number]> = [];
    for (const [key, size] of files) if (!(await isStorageKeyReferenced(key))) orphans.push([key, size]);
    const total = [...files.values()].reduce((sum, size) => sum + size, 0);
    console.log(`local storage:          ${files.size} files, ${kb(total)}`);
    console.log(`  unreferenced files:   ${orphans.length}, ${kb(orphans.reduce((sum, [, size]) => sum + size, 0))} (reported only — never deleted by this script)`);
    orphans.slice(0, 15).forEach(([key, size]) => console.log(`    ${key} ${kb(size)}`));
  } else {
    console.log('orphan scan:            not available for s3 (listing a bucket is outside the storage port)');
  }

  if (apply) {
    mkdirSync(MANIFEST_DIR, { recursive: true });
    const file = path.join(MANIFEST_DIR, `images-${manifest.createdAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    console.log(`\n${manifest.entries.length} row(s) repointed. Originals kept. Manifest: ${file}`);
    console.log(`Roll back with:        npm run images:optimize:v2 -- --rollback "${file}"`);
    console.log(`After checking the apps, free the originals with:`);
    console.log(`                       npm run images:optimize:v2 -- --delete-originals "${file}"`);
  } else {
    console.log('\nDry run — nothing was written. Re-run with --apply to migrate.');
  }
}

function readManifest(file: string): Manifest {
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (manifest.publicBaseUrl !== env.STORAGE_PUBLIC_BASE_URL || manifest.storageProvider !== env.STORAGE_PROVIDER) {
    throw new Error(`manifest was written for ${manifest.storageProvider} ${manifest.publicBaseUrl}, not this environment`);
  }
  return manifest;
}

async function rollback(file: string): Promise<void> {
  const manifest = readManifest(file);
  let restored = 0;
  for (const entry of manifest.entries) {
    const result =
      entry.table === 'product_images'
        ? await prisma.productImage.updateMany({
            where: { id: entry.id, url: entry.newUrl },
            data: { url: entry.oldUrl, thumbUrl: entry.oldThumbUrl, cardUrl: entry.oldCardUrl },
          })
        : await prisma.category.updateMany({ where: { id: entry.id, imageUrl: entry.newUrl }, data: { imageUrl: entry.oldUrl } });
    restored += result.count;
  }
  console.log(`${restored} of ${manifest.entries.length} row(s) restored to their original image (rows changed since were left alone).`);
  console.log('The new .webp files were left in place; they are unreferenced now.');
}

async function deleteOriginals(file: string): Promise<void> {
  const manifest = readManifest(file);
  const candidates = new Set<string>();
  for (const entry of manifest.entries) {
    for (const url of [entry.oldUrl, entry.oldThumbUrl, entry.oldCardUrl]) {
      if (url && url !== entry.newUrl && url !== entry.newThumbUrl) candidates.add(url);
    }
  }
  let deleted = 0;
  let kept = 0;
  for (const url of candidates) {
    const key = storageKeyFromUrl(url);
    if (!key) continue;
    // Every row migrated from this file must still be on the new image, and the new image must be valid.
    const entries = manifest.entries.filter((entry) => [entry.oldUrl, entry.oldThumbUrl, entry.oldCardUrl].includes(url));
    let safe = true;
    for (const entry of entries) {
      // A row deleted since is fine; a row moved back (rollback) or edited is not.
      const current =
        entry.table === 'product_images'
          ? (await prisma.productImage.findUnique({ where: { id: entry.id }, select: { url: true } }))?.url
          : (await prisma.category.findUnique({ where: { id: entry.id }, select: { imageUrl: true } }))?.imageUrl;
      const newKey = storageKeyFromUrl(entry.newUrl);
      const newBody = newKey ? await storage.get(newKey, MAX_IMAGE_BYTES) : null;
      const valid = newBody ? (await sharp(newBody).metadata()).format === 'webp' : false;
      if ((current !== undefined && current !== entry.newUrl) || !valid) safe = false;
    }
    // Order items, other products, categories — anything still pointing at it keeps it.
    if (!safe || (await isStorageKeyReferenced(key))) {
      kept += 1;
      continue;
    }
    await storage.remove(key);
    deleted += 1;
  }
  console.log(`${deleted} original file(s) deleted, ${kept} kept (still referenced — e.g. by order history — or not verified).`);
}

async function main(): Promise<void> {
  const rollbackFile = option('--rollback');
  const deleteFile = option('--delete-originals');
  if (rollbackFile) await rollback(rollbackFile);
  else if (deleteFile) await deleteOriginals(deleteFile);
  else await run(flag('--apply'));
}

main()
  .catch((error) => {
    console.error('ERROR:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
