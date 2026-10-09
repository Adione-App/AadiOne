/**
 * Bulk import — the background side, in-process like every other job here
 * (jobs/index.ts): no queue service, no Redis requirement.
 *
 *   analysis     runs on the instance that received the upload (the files
 *                are on its temp disk), one at a time
 *   processing   one import at a time per instance; the claim in
 *                import-processing.ts keeps two instances off the same job
 *   sweep        every 30 s (jobs/index.ts): resumes confirmed imports whose
 *                worker died (deploy, crash), fails analyses that died
 *   retention    hourly: unconfirmed previews expire after 7 days, row detail
 *                of finished imports is dropped after 90 days (the summary
 *                stays), stray temp files are removed after a day
 *
 * Moving this to a dedicated worker later is a deployment change: the jobs
 * are idempotent and state lives in PostgreSQL.
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductImportStatus } from '@prisma/client';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import { analyzeImport, releaseImportImages, type ImportFiles } from './import-analysis';
import { processImport } from './import-processing';
import { PREVIEW_TTL_MS, ROW_RETENTION_MS, STALE_ANALYSIS_MS, STALE_PROCESSING_MS } from './import-limits';

const log = moduleLogger('product-import');

/** Where uploads wait for analysis (never served, deleted after analysis). */
export const IMPORT_TMP_DIR = path.join(os.tmpdir(), 'aadione-product-imports');

export async function ensureTmpDir(): Promise<string> {
  await mkdir(IMPORT_TMP_DIR, { recursive: true });
  return IMPORT_TMP_DIR;
}

/** Runs tasks one after another; a failing task never stops the next. */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private size = 0;

  push(task: () => Promise<void>): void {
    this.size += 1;
    this.tail = this.tail
      .then(task)
      .catch((error) => log.error({ err: error }, 'product import task failed'))
      .finally(() => {
        this.size -= 1;
      });
  }

  get pending(): number {
    return this.size;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

const analysis = new SerialQueue();
const processing = new SerialQueue();
const queuedForProcessing = new Set<string>();

export function enqueueAnalysis(importId: string, files: ImportFiles): void {
  analysis.push(() => analyzeImport(importId, files));
}

export function enqueueProcessing(importId: string): void {
  if (queuedForProcessing.has(importId)) return;
  queuedForProcessing.add(importId);
  processing.push(async () => {
    try {
      await processImport(importId);
    } finally {
      queuedForProcessing.delete(importId);
    }
  });
}

/** Tests and graceful shutdown: resolves once nothing is queued or running. */
export async function importQueuesIdle(): Promise<void> {
  while (analysis.pending > 0 || processing.pending > 0) {
    await analysis.idle();
    await processing.idle();
  }
}

/** Every 30 s: resume orphaned imports, fail dead analyses. */
export async function runProductImportWorker(): Promise<void> {
  const now = Date.now();
  const resumable = await prisma.productImport.findMany({
    where: {
      OR: [
        { status: ProductImportStatus.QUEUED },
        { status: ProductImportStatus.PROCESSING, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(now - STALE_PROCESSING_MS) } }] },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  for (const job of resumable) enqueueProcessing(job.id);

  const dead = await prisma.productImport.findMany({
    where: { status: ProductImportStatus.ANALYZING, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(now - STALE_ANALYSIS_MS) } }], createdAt: { lt: new Date(now - STALE_ANALYSIS_MS) } },
    select: { id: true },
    take: 20,
  });
  for (const job of dead) {
    const failed = await prisma.productImport.updateMany({
      where: { id: job.id, status: ProductImportStatus.ANALYZING },
      data: { status: ProductImportStatus.FAILED, errorSummary: 'Checking the file was interrupted. Please upload it again.', completedAt: new Date() },
    });
    if (failed.count === 0) continue;
    await releaseImportImages(job.id);
    await prisma.productImportRow.deleteMany({ where: { importId: job.id } });
    await prisma.productImportImage.deleteMany({ where: { importId: job.id } });
    log.warn({ importId: job.id }, 'product import analysis interrupted');
  }
}

/** Hourly retention. Only import staging data is removed — never a product. */
export async function cleanupProductImports(): Promise<void> {
  const now = Date.now();
  const expired = await prisma.productImport.findMany({
    where: { status: ProductImportStatus.READY, updatedAt: { lt: new Date(now - PREVIEW_TTL_MS) } },
    select: { id: true },
    take: 50,
  });
  for (const job of expired) {
    const changed = await prisma.productImport.updateMany({
      where: { id: job.id, status: ProductImportStatus.READY },
      data: { status: ProductImportStatus.EXPIRED, completedAt: new Date() },
    });
    if (changed.count === 0) continue;
    await releaseImportImages(job.id);
    await prisma.productImportRow.deleteMany({ where: { importId: job.id } });
    await prisma.productImportImage.deleteMany({ where: { importId: job.id } });
  }

  const old = await prisma.productImport.findMany({
    where: {
      status: { in: [ProductImportStatus.COMPLETED, ProductImportStatus.FAILED, ProductImportStatus.CANCELLED, ProductImportStatus.EXPIRED] },
      completedAt: { lt: new Date(now - ROW_RETENTION_MS) },
      OR: [{ rows: { some: {} } }, { images: { some: {} } }],
    },
    select: { id: true },
    take: 50,
  });
  for (const job of old) {
    await releaseImportImages(job.id);
    await prisma.productImportRow.deleteMany({ where: { importId: job.id } });
    await prisma.productImportImage.deleteMany({ where: { importId: job.id } });
  }

  // Temp files of uploads whose analysis never ran (process restarted).
  try {
    for (const name of await readdir(IMPORT_TMP_DIR)) {
      const file = path.join(IMPORT_TMP_DIR, name);
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > 24 * 3600_000) await rm(file, { force: true });
    }
  } catch {
    // No temp dir yet: nothing to clean.
  }
}
