/**
 * Bulk import — what the routes call. Every function takes the seller id the
 * server derived from the session (attachSellerContext) and scopes every read
 * and write to it: another seller's import is NOT_FOUND, exactly like a
 * missing one. Admin reads pass `null` (any seller; read-only).
 */

import type { Response } from 'express';
import {
  Prisma,
  ProductImportKind,
  ProductImportMode,
  ProductImportRowAction,
  ProductImportRowStatus,
  ProductImportStatus,
  type ProductImport,
  type ProductImportRow,
} from '@prisma/client';
import {
  ErrorCode,
  isFoodSellerType,
  PRODUCT_IMPORT_COLUMNS,
  type ProductImportDto,
  type ProductImportImageDto,
  type ProductImportIssue,
  type ProductImportPageDto,
  type ProductImportRowDto,
  type ProductImportRowPageDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { submitApprovalBatch } from '../catalog/product-approval.service';
import { CSV_BOM, csvLine } from './csv';
import { releaseImportImages, rowCounts, type ImportFiles } from './import-analysis';
import { validateImageRows, validateProductRows, type ImageRef, type ResolvedRow, type RowDecisions, type ValidatedRow } from './import-validation';
import { enqueueAnalysis, enqueueProcessing } from './import-worker';
import { imageNameKey } from './row-rules';

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toImportDto(job: ProductImport): ProductImportDto {
  return {
    id: job.id,
    kind: job.kind,
    mode: job.mode,
    status: job.status,
    fileName: job.fileName,
    archiveName: job.archiveName,
    columns: job.columns as string[],
    ignoredColumns: job.ignoredColumns as string[],
    totalRows: job.totalRows,
    readyRows: job.readyRows,
    invalidRows: job.invalidRows,
    duplicateRows: job.duplicateRows,
    conflictRows: job.conflictRows,
    warningRows: job.warningRows,
    processedRows: job.processedRows,
    createdCount: job.createdCount,
    updatedCount: job.updatedCount,
    failedCount: job.failedCount,
    skippedCount: job.skippedCount,
    imageCount: job.imageCount,
    analyzedImages: job.analyzedImages,
    errorSummary: job.errorSummary,
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.startedAt),
    completedAt: iso(job.completedAt),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function toRowDto(job: ProductImport, row: ProductImportRow, images: Map<string, { status: string; thumbUrl: string | null; error: string | null }>): ProductImportRowDto {
  const cells = row.rawValues as string[];
  const columns = job.columns as string[];
  const values: Record<string, string> = {};
  columns.forEach((header, i) => {
    if (header) values[header] = cells[i] ?? '';
  });
  const parsed = row.parsed as unknown as ResolvedRow;
  const decisions = row.decisions as RowDecisions;
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    status: row.status,
    action: row.action,
    sku: row.sku,
    name: parsed.name ?? parsed.productName ?? null,
    values,
    errors: row.errors as unknown as ProductImportIssue[],
    warnings: row.warnings as unknown as ProductImportIssue[],
    images: (row.imageNames as string[]).map((fileName) => {
      const image = images.get(imageNameKey(fileName));
      return image
        ? { fileName, status: image.status as ProductImportRowDto['images'][number]['status'], thumbUrl: image.thumbUrl, error: image.error }
        : { fileName, status: 'MISSING' as const, thumbUrl: null, error: null };
    }),
    productId: row.productId,
    makePrimary: Boolean(decisions.makePrimary),
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** `sellerId` null = admin (any seller). */
async function loadImport(importId: string, sellerId: string | null): Promise<ProductImport> {
  const job = await prisma.productImport.findFirst({ where: { id: importId, ...(sellerId ? { sellerId } : {}) } });
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Import not found.' });
  return job;
}

export async function getImport(importId: string, sellerId: string | null): Promise<ProductImportDto> {
  return toImportDto(await loadImport(importId, sellerId));
}

export async function listImports(sellerId: string, page: number, pageSize: number): Promise<ProductImportPageDto> {
  const [items, total] = await Promise.all([
    prisma.productImport.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.productImport.count({ where: { sellerId } }),
  ]);
  return { items: items.map(toImportDto), total, page, pageSize };
}

export type RowFilter = 'ALL' | 'READY' | 'ISSUES' | 'WARNINGS' | ProductImportRowStatus;

const ISSUE_STATUSES = [ProductImportRowStatus.INVALID, ProductImportRowStatus.DUPLICATE, ProductImportRowStatus.CONFLICT, ProductImportRowStatus.FAILED];

function rowWhere(importId: string, filter: RowFilter): Prisma.ProductImportRowWhereInput {
  if (filter === 'ALL') return { importId };
  if (filter === 'ISSUES') return { importId, status: { in: ISSUE_STATUSES } };
  if (filter === 'WARNINGS') return { importId, status: ProductImportRowStatus.READY, NOT: { warnings: { equals: [] } } };
  return { importId, status: filter };
}

async function imageIndex(importId: string, rows: Pick<ProductImportRow, 'imageNames'>[]) {
  const keys = [...new Set(rows.flatMap((r) => (r.imageNames as string[]).map(imageNameKey)))];
  const images = keys.length
    ? await prisma.productImportImage.findMany({ where: { importId, nameKey: { in: keys } }, select: { nameKey: true, status: true, thumbUrl: true, error: true } })
    : [];
  return new Map(images.map((i) => [i.nameKey, i]));
}

export async function listRows(importId: string, sellerId: string | null, filter: RowFilter, page: number, pageSize: number): Promise<ProductImportRowPageDto> {
  const job = await loadImport(importId, sellerId);
  const where = rowWhere(importId, filter);
  const [rows, total] = await Promise.all([
    prisma.productImportRow.findMany({ where, orderBy: { rowNumber: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.productImportRow.count({ where }),
  ]);
  const images = await imageIndex(importId, rows);
  return { items: rows.map((r) => toRowDto(job, r, images)), total, page, pageSize };
}

/** Archive files no row uses, or that could not be used. */
export async function listImages(importId: string, sellerId: string | null, status: 'UNUSED' | 'INVALID' | 'DUPLICATE_NAME' | 'READY'): Promise<ProductImportImageDto[]> {
  await loadImport(importId, sellerId);
  const images = await prisma.productImportImage.findMany({ where: { importId, status }, orderBy: { fileName: 'asc' }, take: 500 });
  return images.map((i) => ({ id: i.id, fileName: i.fileName, status: i.status, error: i.error, thumbUrl: i.thumbUrl }));
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

export async function assertSellerMayImport(sellerId: string): Promise<void> {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, deletedAt: null }, select: { sellerType: true } });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  if (isFoodSellerType(seller.sellerType)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Bulk import is for packaged products. Restaurant and cafe menus are managed on the Products page.' });
  }
}

/** Creates the job and hands the files to background analysis. */
export async function startImport(input: {
  sellerId: string;
  userId: string;
  kind: ProductImportKind;
  mode: ProductImportMode;
  files: ImportFiles;
}): Promise<ProductImportDto> {
  const job = await prisma.productImport.create({
    data: {
      sellerId: input.sellerId,
      createdByUserId: input.userId,
      kind: input.kind,
      mode: input.mode,
      status: ProductImportStatus.ANALYZING,
      fileName: input.files.sheet?.originalName.slice(0, 255) ?? null,
      archiveName: input.files.archive?.originalName.slice(0, 255) ?? (input.files.looseImages?.length ? `${input.files.looseImages.length} image files` : null),
      heartbeatAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId: input.userId,
      action: 'product_import.upload',
      entityType: 'ProductImport',
      entityId: job.id,
      after: { sellerId: input.sellerId, kind: input.kind, mode: input.mode, fileName: job.fileName, archiveName: job.archiveName },
    },
  });
  enqueueAnalysis(job.id, input.files);
  return toImportDto(job);
}

/* -------------------------------------------------------------------------- */
/* Preview decisions (re-validation)                                          */
/* -------------------------------------------------------------------------- */

const jsonb = (value: unknown) => JSON.stringify(value ?? null);

/** Writes re-validated rows back in bulk (500 per statement). */
async function writeValidated(importId: string, rows: ValidatedRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const values = Prisma.join(
      rows.slice(i, i + 500).map(
        (r) =>
          Prisma.sql`(${r.rowNumber}::int, ${r.status}::text, ${r.action}::text, ${r.sku}::text, ${jsonb(r.parsed)}::jsonb, ${jsonb(r.errors)}::jsonb, ${jsonb(r.warnings)}::jsonb, ${jsonb(r.imageNames)}::jsonb, ${r.productId}::uuid)`,
      ),
    );
    await prisma.$executeRaw`
      UPDATE product_import_rows AS r
         SET status = v.status::"ProductImportRowStatus", action = v.action::"ProductImportRowAction", sku = v.sku,
             parsed = v.parsed, errors = v.errors, warnings = v.warnings, image_names = v.image_names, product_id = v.product_id
        FROM (VALUES ${values}) AS v(row_number, status, action, sku, parsed, errors, warnings, image_names, product_id)
       WHERE r.import_id = ${importId}::uuid AND r.row_number = v.row_number`;
  }
}

/** Re-runs validation over the stored rows (mode switch, a seller decision). */
async function revalidate(job: ProductImport, mode: ProductImportMode): Promise<void> {
  const rows = await prisma.productImportRow.findMany({ where: { importId: job.id }, select: { rowNumber: true, rawValues: true, decisions: true }, orderBy: { rowNumber: 'asc' } });
  const imageRows = await prisma.productImportImage.findMany({ where: { importId: job.id }, select: { nameKey: true, fileName: true, status: true, error: true } });
  const images = new Map<string, ImageRef>(imageRows.map((i) => [i.nameKey, { fileName: i.fileName, status: i.status, error: i.error }]));
  let validated: ValidatedRow[];
  if (job.kind === ProductImportKind.PRODUCTS) {
    ({ rows: validated } = await validateProductRows({
      sellerId: job.sellerId,
      mode,
      columns: job.columns as string[],
      rows: rows.map((r) => ({ rowNumber: r.rowNumber, cells: r.rawValues as string[], decisions: r.decisions as RowDecisions })),
      images: job.archiveName ? images : null,
    }));
  } else {
    validated = await validateImageRows({
      sellerId: job.sellerId,
      rows: rows.map((r) => ({ rowNumber: r.rowNumber, fileName: (r.rawValues as string[])[0] ?? '', decisions: r.decisions as RowDecisions })),
      images,
    });
  }
  await writeValidated(job.id, validated);
  await prisma.productImport.update({ where: { id: job.id }, data: { ...rowCounts(validated), mode } });
}

function assertReady(job: ProductImport): void {
  if (job.status !== ProductImportStatus.READY) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'This import is no longer waiting for review.' });
  }
}

/** POST /imports/:id/mode — switch CREATE / UPDATE before confirming. */
export async function changeMode(importId: string, sellerId: string, mode: ProductImportMode): Promise<ProductImportDto> {
  const job = await loadImport(importId, sellerId);
  assertReady(job);
  if (job.kind !== ProductImportKind.PRODUCTS) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Images-only imports have no mode.' });
  if (job.mode !== mode) await revalidate(job, mode);
  return getImport(importId, sellerId);
}

/** PATCH /imports/:id/rows/:rowId — exclude a row, pick the main image, assign an image to a SKU. */
export async function decideRow(importId: string, sellerId: string, rowId: string, input: RowDecisions): Promise<ProductImportRowDto> {
  const job = await loadImport(importId, sellerId);
  assertReady(job);
  const row = await prisma.productImportRow.findFirst({ where: { id: rowId, importId } });
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Row not found.' });
  if (job.kind === ProductImportKind.PRODUCTS && (input.sku !== undefined || input.makePrimary !== undefined)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'SKU assignment is for images-only imports.' });
  }
  if (input.primaryImage && !(row.imageNames as string[]).some((n) => imageNameKey(n) === imageNameKey(input.primaryImage!))) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose one of this row’s own images.' });
  }
  const decisions: RowDecisions = { ...(row.decisions as RowDecisions) };
  for (const [key, value] of Object.entries(input) as [keyof RowDecisions, unknown][]) {
    if (value === null || value === undefined || value === '') delete decisions[key];
    else (decisions as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim() : value;
  }
  await prisma.productImportRow.update({ where: { id: rowId }, data: { decisions: decisions as Prisma.InputJsonValue } });
  await revalidate(job, job.mode);
  const fresh = await prisma.productImportRow.findUniqueOrThrow({ where: { id: rowId } });
  return toRowDto(job, fresh, await imageIndex(importId, [fresh]));
}

/* -------------------------------------------------------------------------- */
/* Confirm / cancel / retry                                                   */
/* -------------------------------------------------------------------------- */

/**
 * POST /imports/:id/confirm — starts processing. The mode the seller saw is
 * sent back and must still be the import's mode. A second click (or tab) on
 * an import already started just returns it: nothing runs twice.
 */
export async function confirmImport(importId: string, sellerId: string, mode: ProductImportMode, actorUserId: string): Promise<ProductImportDto> {
  const job = await loadImport(importId, sellerId);
  if (job.status === ProductImportStatus.QUEUED || job.status === ProductImportStatus.PROCESSING || job.status === ProductImportStatus.COMPLETED) {
    return toImportDto(job);
  }
  assertReady(job);
  if (job.mode !== mode) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'The import mode changed. Review the preview again before importing.' });
  }
  if (job.readyRows === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'No row is ready to import. Fix the errors and upload the file again.' });
  const started = await prisma.productImport.updateMany({
    where: { id: importId, sellerId, status: ProductImportStatus.READY, mode },
    data: { status: ProductImportStatus.QUEUED, heartbeatAt: null },
  });
  if (started.count === 1) {
    await prisma.auditLog.create({
      data: { actorUserId, action: 'product_import.confirm', entityType: 'ProductImport', entityId: importId, after: { sellerId, mode, readyRows: job.readyRows } },
    });
    enqueueProcessing(importId);
  }
  return getImport(importId, sellerId);
}

export async function cancelImport(importId: string, sellerId: string, actorUserId: string): Promise<ProductImportDto> {
  const job = await loadImport(importId, sellerId);
  if (job.status === ProductImportStatus.CANCELLED) return toImportDto(job);
  assertReady(job);
  const changed = await prisma.productImport.updateMany({
    where: { id: importId, status: ProductImportStatus.READY },
    data: { status: ProductImportStatus.CANCELLED, completedAt: new Date() },
  });
  if (changed.count === 1) {
    await releaseImportImages(importId);
    await prisma.productImportRow.deleteMany({ where: { importId } });
    await prisma.productImportImage.deleteMany({ where: { importId } });
    await prisma.auditLog.create({ data: { actorUserId, action: 'product_import.cancel', entityType: 'ProductImport', entityId: importId } });
  }
  return getImport(importId, sellerId);
}

/** POST /imports/:id/retry — rows that were valid but failed to save go again. Imported rows are never touched. */
export async function retryFailedRows(importId: string, sellerId: string, actorUserId: string): Promise<ProductImportDto> {
  const job = await loadImport(importId, sellerId);
  if (job.status !== ProductImportStatus.COMPLETED) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'Only a finished import can be retried.' });
  }
  const retried = await prisma.productImportRow.updateMany({
    where: { importId, status: ProductImportRowStatus.FAILED },
    data: { status: ProductImportRowStatus.READY, errors: [], processedAt: null },
  });
  if (retried.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'There are no failed rows to retry. Rows with errors must be fixed in the file and uploaded again.' });
  await prisma.productImport.update({ where: { id: importId }, data: { status: ProductImportStatus.QUEUED, completedAt: null, heartbeatAt: null } });
  await prisma.auditLog.create({ data: { actorUserId, action: 'product_import.retry', entityType: 'ProductImport', entityId: importId, after: { rows: retried.count } } });
  enqueueProcessing(importId);
  return getImport(importId, sellerId);
}

/** POST /imports/:id/submit-for-approval — the products this import created, as one approval batch. */
export async function submitImportedForApproval(importId: string, sellerId: string, actorUserId: string) {
  const job = await loadImport(importId, sellerId);
  if (job.status !== ProductImportStatus.COMPLETED || job.kind !== ProductImportKind.PRODUCTS) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'Submit for approval once the import has finished.' });
  }
  const rows = await prisma.productImportRow.findMany({
    where: { importId, status: ProductImportRowStatus.DONE, action: ProductImportRowAction.CREATE, productId: { not: null } },
    select: { productId: true },
  });
  const ready = await prisma.product.findMany({
    where: {
      id: { in: rows.map((r) => r.productId!) },
      submittedBySellerId: sellerId,
      deletedAt: null,
      approvalStatus: 'PENDING',
      approvalBatchItems: { none: {} },
    },
    select: { id: true },
  });
  if (ready.length === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'These products have already been submitted for approval.' });
  return submitApprovalBatch(
    sellerId,
    ready.map((p) => p.id),
    actorUserId,
  );
}

/* -------------------------------------------------------------------------- */
/* Error report and template                                                  */
/* -------------------------------------------------------------------------- */

const REPORT_STATUSES = [...ISSUE_STATUSES];
const STATUS_LABEL: Record<string, string> = {
  INVALID: 'Error',
  DUPLICATE: 'Duplicate',
  CONFLICT: 'Needs decision',
  FAILED: 'Failed to save',
};

/**
 * GET /imports/:id/error-report.csv — every rejected row with its original
 * cells (so it can be fixed and uploaded again) plus what was wrong. Streamed
 * 500 rows at a time; every cell is neutralised against formula injection.
 */
export async function streamErrorReport(importId: string, sellerId: string | null, res: Response): Promise<void> {
  const job = await loadImport(importId, sellerId);
  const columns = job.columns as string[];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-errors-${job.createdAt.toISOString().slice(0, 10)}-${job.id.slice(0, 8)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.write(CSV_BOM + csvLine([...columns, 'source_row', 'import_status', 'import_problems']));
  let after = 0;
  for (;;) {
    const rows = await prisma.productImportRow.findMany({
      where: { importId, status: { in: REPORT_STATUSES }, rowNumber: { gt: after } },
      orderBy: { rowNumber: 'asc' },
      take: 500,
      select: { rowNumber: true, status: true, rawValues: true, errors: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const cells = row.rawValues as string[];
      const problems = (row.errors as unknown as ProductImportIssue[]).map((e) => `Row ${row.rowNumber}: ${e.message}`).join(' | ');
      res.write(csvLine([...columns.map((_c, i) => cells[i] ?? ''), row.rowNumber, STATUS_LABEL[row.status] ?? row.status, problems]));
    }
    after = rows[rows.length - 1]!.rowNumber;
  }
  res.end();
}

/** GET /imports/template.csv — the header row only: no sample prices or stock that could be imported by mistake. */
export function templateCsv(): string {
  return CSV_BOM + csvLine(PRODUCT_IMPORT_COLUMNS.map((c) => c.key));
}
