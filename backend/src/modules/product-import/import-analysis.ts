/**
 * Bulk import — analysis: files in, preview out. Runs in the background right
 * after the upload (import-worker.ts), never inside the HTTP request:
 *
 *   1. read the sheet (CSV streamed / first .xlsx worksheet), ≤ maxRows rows
 *   2. open the image ZIP safely (archive.ts) and run every image a row names
 *      through the shared image pipeline (validated by decoding, resized,
 *      stored as WebP in the seller's own folder); identical files are
 *      stored once (SHA-256); unreferenced files are listed, not stored
 *   3. validate every row (import-validation.ts) and store rows + images
 *   4. status READY (the preview) — or FAILED with a seller-safe reason
 *
 * The uploaded temp files are always deleted at the end. Nothing here
 * creates or changes a product.
 */

import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Prisma, ProductImportImageStatus, ProductImportKind, ProductImportRowStatus, ProductImportStatus } from '@prisma/client';
import { PRODUCT_IMPORT_LIMITS, type ProductImportMode } from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import { buildImageKey } from '../../infra/storage';
import { sellerImageFolder } from '../catalog/seller-image.service';
import { plannedImageUrls, removeStoredImageIfUnused, storeImageBuffer } from '../catalog/uploaded-image.service';
import { SafeArchive } from './archive';
import { SheetError, readCsvRecords } from './csv';
import { readXlsxRecords, type SheetRecord } from './xlsx';
import { headerProblems, imageNameKey, mapHeader, parseImageNames } from './row-rules';
import { validateImageRows, validateProductRows, type ImageRef, type ValidatedRow } from './import-validation';
import { importLimits } from './import-limits';

const log = moduleLogger('product-import');

export interface UploadedFile {
  path: string;
  originalName: string;
  size: number;
}

export interface ImportFiles {
  sheet?: UploadedFile & { format: 'csv' | 'xlsx' };
  archive?: UploadedFile;
  /** Images-only uploads without a ZIP. */
  looseImages?: UploadedFile[];
}

const IMAGE_FILE = /\.(jpe?g|png|webp|avif)$/i;

/** Seller-safe text for any failure (internal details stay in the log). */
export function safeFailureMessage(error: unknown): string {
  if (error instanceof AppError && error.status < 500) return error.message;
  return 'The file could not be processed. Please try again, or contact support if it keeps failing.';
}

export async function heartbeat(importId: string, data: Prisma.ProductImportUpdateInput = {}): Promise<void> {
  await prisma.productImport.update({ where: { id: importId }, data: { ...data, heartbeatAt: new Date() } });
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

interface ImageSource {
  fileName: string;
  /** Why it must not be read, if so (archive.ts). */
  problem: string | null;
  read: () => Promise<Buffer>;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]!);
    }),
  );
}

/**
 * Stores the wanted images (all of them when `wanted` is 'all') and records
 * every file. Returns the per-name outcome the row validation needs.
 */
async function ingestImages(
  importId: string,
  sellerId: string,
  sources: ImageSource[],
  wanted: Set<string> | 'all',
): Promise<Map<string, ImageRef>> {
  const groups = new Map<string, ImageSource[]>();
  for (const source of sources) {
    const key = imageNameKey(source.fileName);
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }

  const folder = sellerImageFolder(sellerId);
  const bySha = new Map<string, { url: string; thumbUrl: string; width: number | null; height: number | null }>();
  const records: Prisma.ProductImportImageCreateManyInput[] = [];
  const refs = new Map<string, ImageRef>();
  let done = 0;
  let readyCount = 0;

  const record = (key: string, data: Omit<Prisma.ProductImportImageCreateManyInput, 'importId' | 'nameKey'>) => {
    records.push({ importId, nameKey: key, ...data });
    refs.set(key, { fileName: data.fileName, status: data.status, error: data.error ?? null });
  };

  await pool([...groups.entries()], 3, async ([key, group]) => {
    const first = group[0]!;
    try {
      if (group.length > 1) {
        record(key, { fileName: first.fileName, status: ProductImportImageStatus.DUPLICATE_NAME, error: `${group.length} files share this name` });
        return;
      }
      if (!IMAGE_FILE.test(first.fileName)) {
        if (wanted === 'all') record(key, { fileName: first.fileName, status: ProductImportImageStatus.INVALID, error: 'not a JPG, PNG, WebP or AVIF file' });
        return;
      }
      if (wanted !== 'all' && !wanted.has(key)) {
        record(key, { fileName: first.fileName, status: ProductImportImageStatus.UNUSED });
        return;
      }
      if (first.problem) {
        record(key, { fileName: first.fileName, status: ProductImportImageStatus.INVALID, error: first.problem });
        return;
      }
      const bytes = await first.read();
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let stored = bySha.get(sha256);
      if (!stored) {
        // Recorded BEFORE anything is stored: a crash mid-store leaves a
        // PENDING row whose URLs the cleanup removes — never an untracked file.
        const storageKey = buildImageKey(folder, first.fileName);
        const planned = plannedImageUrls(storageKey);
        const pending = await prisma.productImportImage.create({
          data: { importId, nameKey: key, fileName: first.fileName, status: ProductImportImageStatus.PENDING, sha256, bytes: bytes.byteLength, url: planned.url, thumbUrl: planned.thumbUrl },
        });
        try {
          stored = await storeImageBuffer(bytes, storageKey, 'product');
        } catch (error) {
          const message = error instanceof AppError && error.status < 500 ? error.message.replace(/\.$/, '') : 'not a valid image';
          if (!(error instanceof AppError)) log.warn({ err: error, importId, file: first.fileName }, 'import image rejected');
          // Keeps the planned URLs: whatever part was stored is released with the import.
          await prisma.productImportImage.update({ where: { id: pending.id }, data: { status: ProductImportImageStatus.INVALID, error: message.slice(0, 300) } });
          refs.set(key, { fileName: first.fileName, status: ProductImportImageStatus.INVALID, error: message.slice(0, 300) });
          return;
        }
        bySha.set(sha256, stored);
        await prisma.productImportImage.update({
          where: { id: pending.id },
          data: { status: ProductImportImageStatus.READY, url: stored.url, thumbUrl: stored.thumbUrl, width: stored.width, height: stored.height },
        });
        refs.set(key, { fileName: first.fileName, status: ProductImportImageStatus.READY, error: null });
        readyCount += 1;
        return;
      }
      readyCount += 1;
      record(key, {
        fileName: first.fileName,
        status: ProductImportImageStatus.READY,
        sha256,
        bytes: bytes.byteLength,
        url: stored.url,
        thumbUrl: stored.thumbUrl,
        width: stored.width,
        height: stored.height,
      });
    } catch (error) {
      const message = error instanceof AppError && error.status < 500 ? error.message.replace(/\.$/, '') : 'not a valid image';
      if (!(error instanceof AppError)) log.warn({ err: error, importId, file: first.fileName }, 'import image rejected');
      record(key, { fileName: first.fileName, status: ProductImportImageStatus.INVALID, error: message.slice(0, 300) });
    } finally {
      done += 1;
      if (done % 10 === 0) await heartbeat(importId, { analyzedImages: done });
    }
  });

  for (let i = 0; i < records.length; i += 500) {
    await prisma.productImportImage.createMany({ data: records.slice(i, i + 500) });
  }
  await heartbeat(importId, { analyzedImages: done, imageCount: readyCount });
  return refs;
}

async function archiveSources(archivePath: string): Promise<{ archive: SafeArchive; sources: ImageSource[] }> {
  const limits = importLimits();
  const archive = await SafeArchive.open(archivePath, {
    maxEntries: limits.maxArchiveEntries,
    maxEntryBytes: PRODUCT_IMPORT_LIMITS.maxImageBytes,
    maxTotalBytes: limits.maxArchiveUncompressedBytes,
  });
  return {
    archive,
    sources: archive.entries.map((entry) => ({ fileName: entry.fileName, problem: entry.problem, read: () => archive.read(entry) })),
  };
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

const json = (value: unknown) => value as Prisma.InputJsonValue;

export function rowCounts(rows: Pick<ValidatedRow, 'status' | 'warnings'>[]) {
  const count = (status: ProductImportRowStatus) => rows.filter((r) => r.status === status).length;
  return {
    totalRows: rows.length,
    readyRows: count(ProductImportRowStatus.READY),
    invalidRows: count(ProductImportRowStatus.INVALID),
    duplicateRows: count(ProductImportRowStatus.DUPLICATE),
    conflictRows: count(ProductImportRowStatus.CONFLICT),
    warningRows: rows.filter((r) => r.status === ProductImportRowStatus.READY && r.warnings.length > 0).length,
  };
}

async function insertRows(importId: string, rows: ValidatedRow[], raw: Map<number, unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.productImportRow.createMany({
      data: rows.slice(i, i + 500).map((r) => ({
        importId,
        rowNumber: r.rowNumber,
        status: r.status,
        action: r.action,
        sku: r.sku,
        rawValues: json(raw.get(r.rowNumber)),
        parsed: json(r.parsed),
        errors: json(r.errors),
        warnings: json(r.warnings),
        imageNames: json(r.imageNames),
        productId: r.productId,
      })),
    });
  }
}

async function readSheet(sheet: NonNullable<ImportFiles['sheet']>): Promise<SheetRecord[]> {
  const maxRows = importLimits().maxRows;
  if (sheet.format === 'xlsx') return readXlsxRecords(sheet.path, maxRows);
  const records: SheetRecord[] = [];
  for await (const record of readCsvRecords(sheet.path, maxRows)) records.push(record);
  return records;
}

async function analyzeProducts(job: { id: string; sellerId: string; mode: ProductImportMode }, files: ImportFiles): Promise<void> {
  const records = await readSheet(files.sheet!);
  if (records.length === 0) throw new SheetError('The file is empty.');
  const columns = records[0]!.cells.map((c) => c.trim());
  const data = records.slice(1).map((r) => ({ rowNumber: r.rowNumber, cells: columns.map((_c, i) => (r.cells[i] ?? '').trim()) }));
  if (data.length === 0) throw new SheetError('The file has a header row but no products.');

  const header = mapHeader(columns);
  const problems = headerProblems(header, job.mode);
  if (problems.length > 0) throw new SheetError(problems.join(' '));
  await heartbeat(job.id, { columns: json(columns), ignoredColumns: json(header.ignored), totalRows: data.length });

  // Images the rows name — only these are stored.
  let images: Map<string, ImageRef> | null = null;
  if (files.archive) {
    const wanted = new Set<string>();
    for (const row of data) {
      for (const key of ['image_filename', 'additional_image_filenames'] as const) {
        const at = header.index.get(key);
        if (at === undefined || !row.cells[at]) continue;
        const names = parseImageNames(row.cells[at]!);
        if (names.ok) for (const name of names.value) wanted.add(imageNameKey(name));
      }
    }
    const { archive, sources } = await archiveSources(files.archive.path);
    try {
      images = await ingestImages(job.id, job.sellerId, sources, wanted);
    } finally {
      archive.close();
    }
  }

  const { rows, ignoredColumns } = await validateProductRows({
    sellerId: job.sellerId,
    mode: job.mode,
    columns,
    rows: data.map((r) => ({ ...r, decisions: {} })),
    images,
  });
  await insertRows(job.id, rows, new Map(data.map((r) => [r.rowNumber, r.cells])));
  await prisma.productImport.update({
    where: { id: job.id },
    data: { ...rowCounts(rows), ignoredColumns: json(ignoredColumns), status: ProductImportStatus.READY, heartbeatAt: new Date() },
  });
}

async function analyzeImages(job: { id: string; sellerId: string }, files: ImportFiles): Promise<void> {
  let archive: SafeArchive | null = null;
  let sources: ImageSource[];
  if (files.archive) {
    ({ archive, sources } = await archiveSources(files.archive.path));
  } else {
    sources = (files.looseImages ?? []).map((file) => ({
      fileName: path.basename(file.originalName),
      problem: file.size > PRODUCT_IMPORT_LIMITS.maxImageBytes ? 'is larger than 5 MB' : null,
      read: () => readFile(file.path),
    }));
  }
  try {
    if (sources.length === 0) throw new SheetError('No image files were found in the upload.');
    const images = await ingestImages(job.id, job.sellerId, sources, 'all');
    // One row per distinct file name, in natural name order (RB-2 before RB-10).
    const names = [...new Set(sources.map((s) => s.fileName))]
      .filter((n, i, all) => all.findIndex((m) => imageNameKey(m) === imageNameKey(n)) === i)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
    const rows = await validateImageRows({
      sellerId: job.sellerId,
      rows: names.map((fileName, i) => ({ rowNumber: i + 1, fileName, decisions: {} })),
      images,
    });
    await insertRows(job.id, rows, new Map(names.map((n, i) => [i + 1, [n]])));
    await prisma.productImport.update({
      where: { id: job.id },
      data: { ...rowCounts(rows), columns: json(['file_name']), status: ProductImportStatus.READY, heartbeatAt: new Date() },
    });
  } finally {
    archive?.close();
  }
}

/** Removes the import's stored images that no product uses (failed / cancelled / expired jobs). */
export async function releaseImportImages(importId: string, onlyNotUsedByRows = false): Promise<void> {
  const images = await prisma.productImportImage.findMany({
    where: { importId, url: { not: null } },
    select: { nameKey: true, url: true, thumbUrl: true },
  });
  let keep = new Set<string>();
  if (onlyNotUsedByRows) {
    // Images rows can still import (pending or retryable) stay.
    const rows = await prisma.productImportRow.findMany({
      where: { importId, status: { in: [ProductImportRowStatus.READY, ProductImportRowStatus.FAILED] } },
      select: { imageNames: true },
    });
    keep = new Set(rows.flatMap((r) => (r.imageNames as string[]).map(imageNameKey)));
  }
  for (const image of images) {
    if (keep.has(image.nameKey)) continue;
    await removeStoredImageIfUnused(image.url);
    if (image.thumbUrl && image.thumbUrl !== image.url) await removeStoredImageIfUnused(image.thumbUrl);
  }
}

/** Analysis entry point (called from the worker queue). Always cleans up the temp files. */
export async function analyzeImport(importId: string, files: ImportFiles): Promise<void> {
  try {
    const job = await prisma.productImport.findUnique({ where: { id: importId }, select: { id: true, sellerId: true, kind: true, mode: true, status: true } });
    if (!job || job.status !== ProductImportStatus.ANALYZING) return;
    await heartbeat(job.id);
    try {
      if (job.kind === ProductImportKind.PRODUCTS) await analyzeProducts(job, files);
      else await analyzeImages(job, files);
      log.info({ importId, kind: job.kind }, 'product import analysed');
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) log.error({ err: error, importId }, 'product import analysis failed');
      // A partly written preview is worthless: drop it, keep the summary.
      await releaseImportImages(importId);
      await prisma.productImportRow.deleteMany({ where: { importId } });
      await prisma.productImportImage.deleteMany({ where: { importId } });
      await prisma.productImport.update({
        where: { id: importId },
        data: { status: ProductImportStatus.FAILED, errorSummary: safeFailureMessage(error).slice(0, 500), completedAt: new Date(), heartbeatAt: new Date() },
      });
    }
  } finally {
    const paths = [files.sheet?.path, files.archive?.path, ...(files.looseImages ?? []).map((f) => f.path)].filter((p): p is string => Boolean(p));
    await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => undefined)));
  }
}

/** Size of a temp file (multer already enforces the hard cap). */
export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}
