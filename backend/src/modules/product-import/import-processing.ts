/**
 * Bulk import — processing a confirmed import. Runs in the background
 * (import-worker.ts), in bounded batches, resumable:
 *
 *   claim      an atomic status change (QUEUED, or PROCESSING whose worker
 *              went silent) — two workers can never hold one job
 *   CREATE     50 rows per transaction: products, variants, the seller's own
 *              listings, opening-stock ledger rows, images and audit rows —
 *              and, in the SAME transaction, the rows marked DONE. A crash
 *              mid-batch rolls everything back; a re-run finds the rows still
 *              READY. A batch that fails is retried row by row, so one bad
 *              row never sinks its neighbours.
 *   UPDATE     row by row through the existing seller services
 *              (updateSellerProduct: ledgered stock, price <= MRP, own product
 *              in its editable window; setOwnProductStatus). Values are
 *              absolute and images are de-duplicated by URL, so a re-run of an
 *              interrupted row changes nothing twice.
 *   IMAGES     one transaction per image: attach + mark DONE.
 *
 * New products are created exactly like "Add Product": approvalStatus
 * PENDING, invisible to customers until Aadione approves them.
 */

import { randomUUID } from 'node:crypto';
import {
  ApprovalStatus,
  Prisma,
  ProductImportKind,
  ProductImportMode,
  ProductImportRowAction,
  ProductImportRowStatus,
  ProductImportStatus,
  ProductStatus,
  StockLedgerReason,
  type ProductImportRow,
} from '@prisma/client';
import { ErrorCode, PRODUCT_IMPORT_LIMITS, type ProductImportIssue } from '../../shared';
import { slugify } from '../../shared/text';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { loadEditableOwnProduct, setOwnProductStatus, updateSellerProduct } from '../catalog/product-approval.service';
import { heartbeat, releaseImportImages } from './import-analysis';
import type { ResolvedRow } from './import-validation';
import { PROCESS_BATCH_SIZE, STALE_PROCESSING_MS } from './import-limits';
import { imageNameKey } from './row-rules';

const log = moduleLogger('product-import');

interface Job {
  id: string;
  sellerId: string;
  kind: ProductImportKind;
  mode: ProductImportMode;
  createdByUserId: string | null;
}

type StoredImage = { url: string; thumbUrl: string | null };

async function loadImages(importId: string, rows: Pick<ProductImportRow, 'imageNames'>[]): Promise<Map<string, StoredImage>> {
  const keys = [...new Set(rows.flatMap((r) => (r.imageNames as string[]).map(imageNameKey)))];
  if (keys.length === 0) return new Map();
  const images = await prisma.productImportImage.findMany({
    where: { importId, nameKey: { in: keys }, status: 'READY', url: { not: null } },
    select: { nameKey: true, url: true, thumbUrl: true },
  });
  return new Map(images.map((i) => [i.nameKey, { url: i.url!, thumbUrl: i.thumbUrl }]));
}

function imagesOf(row: Pick<ProductImportRow, 'imageNames'>, images: Map<string, StoredImage>): StoredImage[] {
  return (row.imageNames as string[]).map((name) => {
    const image = images.get(imageNameKey(name));
    if (!image) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `Image ${name} is no longer available. Upload the file again.` });
    return image;
  });
}

/** Seller-safe reason a row could not be written. */
function rowFailure(error: unknown, row: Pick<ProductImportRow, 'sku'>): string {
  if (error instanceof AppError && error.status < 500) return error.message;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return `SKU ${row.sku ?? ''} was taken by another product while importing. Use a different SKU.`.replace('SKU  ', 'This SKU ');
    if (error.code === 'P2003') return 'The category was removed while importing. Choose a current category.';
  }
  if (/price_paise <= mrp_paise|check constraint/i.test(String((error as Error)?.message))) return 'Selling price cannot exceed MRP.';
  return 'This row could not be saved. Use "Retry failed rows" to try again.';
}

async function markFailed(row: ProductImportRow, error: unknown): Promise<void> {
  if (!(error instanceof AppError) || error.status >= 500) log.warn({ err: error, rowId: row.id }, 'import row failed');
  const issue: ProductImportIssue = { field: null, message: rowFailure(error, row) };
  await prisma.productImportRow.updateMany({
    where: { id: row.id, status: ProductImportRowStatus.READY },
    data: { status: ProductImportRowStatus.FAILED, errors: [issue] as unknown as Prisma.InputJsonValue, processedAt: new Date() },
  });
}

/** Marks rows DONE inside the caller's transaction — all of them, or the transaction fails. */
async function markDone(tx: Tx, done: { rowId: string; productId: string }[]): Promise<void> {
  const values = Prisma.join(done.map((d) => Prisma.sql`(${d.rowId}::uuid, ${d.productId}::uuid)`));
  const updated = await tx.$executeRaw`
    UPDATE product_import_rows AS r
       SET status = 'DONE', product_id = v.pid, processed_at = now()
      FROM (VALUES ${values}) AS v(id, pid)
     WHERE r.id = v.id AND r.status = 'READY'`;
  if (updated !== done.length) throw new Error(`import rows changed concurrently (${updated}/${done.length})`);
}

/* -------------------------------------------------------------------------- */
/* CREATE                                                                     */
/* -------------------------------------------------------------------------- */

async function writeCreateBatch(job: Job, rows: ProductImportRow[], images: Map<string, StoredImage>): Promise<void> {
  const plan = rows.map((row) => {
    const p = row.parsed as unknown as ResolvedRow;
    return { row, p, productId: randomUUID(), variantId: randomUUID(), listingId: randomUUID(), images: imagesOf(row, images) };
  });
  await runInTransaction(
    async (tx) => {
      await tx.product.createMany({
        data: plan.map(({ p, productId }) => ({
          id: productId,
          name: p.name!,
          nameHi: p.nameHi ?? null,
          slug: `${slugify(p.name!)}-${Math.random().toString(36).slice(2, 8)}`,
          categoryId: p.categoryId!,
          brandId: p.brandId ?? null,
          description: p.description ?? null,
          searchKeywords: [],
          status: p.isActive === false ? ProductStatus.INACTIVE : ProductStatus.ACTIVE,
          // Exactly like "Add Product": nothing sells before Aadione approves it.
          approvalStatus: ApprovalStatus.PENDING,
          submittedBySellerId: job.sellerId,
        })),
      });
      await tx.productVariant.createMany({
        data: plan.map(({ p, productId, variantId }) => ({
          id: variantId,
          productId,
          sku: p.sku!,
          variantName: p.variantName!,
          unit: p.unit!,
          unitValue: p.unitValue!,
          barcode: p.barcode ?? null,
          isDefault: true,
          status: ProductStatus.ACTIVE,
        })),
      });
      await tx.sellerListing.createMany({
        data: plan.map(({ p, variantId, listingId }) => ({
          id: listingId,
          sellerId: job.sellerId,
          variantId,
          mrpPaise: p.mrpPaise!,
          pricePaise: p.pricePaise!,
          stockQty: p.stockQty!,
          tracksStock: true,
          isAvailable: true,
        })),
      });
      const opening = plan.filter(({ p }) => p.stockQty! > 0);
      if (opening.length > 0) {
        await tx.stockLedger.createMany({
          data: opening.map(({ p, listingId }) => ({
            sellerListingId: listingId,
            delta: p.stockQty!,
            reason: StockLedgerReason.PURCHASE,
            balanceAfter: p.stockQty!,
            actorUserId: job.createdByUserId,
            note: 'Opening stock (bulk import)',
          })),
        });
      }
      const imageRows = plan.flatMap(({ p, productId, images: list }) =>
        list.map((image, i) => ({ productId, url: image.url, thumbUrl: image.thumbUrl, cardUrl: image.thumbUrl, altText: p.name!.slice(0, 200), displayOrder: i })),
      );
      if (imageRows.length > 0) await tx.productImage.createMany({ data: imageRows });
      await tx.auditLog.createMany({
        data: plan.map(({ row, p, productId, listingId }) => ({
          actorUserId: job.createdByUserId,
          action: 'product.seller_create',
          entityType: 'Product',
          entityId: productId,
          after: {
            sellerId: job.sellerId,
            name: p.name!,
            categoryId: p.categoryId!,
            listingId,
            mrpPaise: p.mrpPaise!,
            pricePaise: p.pricePaise!,
            stockQty: p.stockQty!,
            importId: job.id,
            rowNumber: row.rowNumber,
          },
        })),
      });
      await markDone(
        tx,
        plan.map(({ row, productId }) => ({ rowId: row.id, productId })),
      );
    },
    { timeoutMs: 30_000 },
  );
}

async function processCreateBatch(job: Job, rows: ProductImportRow[]): Promise<void> {
  const images = await loadImages(job.id, rows);
  try {
    await writeCreateBatch(job, rows, images);
  } catch (error) {
    if (rows.length === 1) return markFailed(rows[0]!, error);
    // One bad row must not sink the batch: write them one by one.
    for (const row of rows) {
      try {
        await writeCreateBatch(job, [row], images);
      } catch (rowError) {
        await markFailed(row, rowError);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Images (UPDATE rows and images-only rows)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Adds images to an own product in its editable window. Already-attached
 * files (same URL) are skipped, so a re-run attaches nothing twice.
 * `primary`: the first image becomes the main photo.
 */
async function attachImages(tx: Tx, job: Job, productId: string, list: StoredImage[], primary: boolean, altText: string | null): Promise<void> {
  await loadEditableOwnProduct(job.sellerId, productId, tx);
  const existing = await tx.productImage.findMany({ where: { productId }, select: { url: true, displayOrder: true } });
  const fresh = list.filter((image, i) => !existing.some((e) => e.url === image.url) && list.findIndex((o) => o.url === image.url) === i);
  if (fresh.length === 0) return;
  if (existing.length + fresh.length > PRODUCT_IMPORT_LIMITS.maxImagesPerProduct) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `A product can have at most ${PRODUCT_IMPORT_LIMITS.maxImagesPerProduct} images.` });
  }
  const min = Math.min(0, ...existing.map((e) => e.displayOrder));
  let max = Math.max(-1, ...existing.map((e) => e.displayOrder));
  const data = fresh.map((image, i) => ({
    productId,
    url: image.url,
    thumbUrl: image.thumbUrl,
    cardUrl: image.thumbUrl,
    altText,
    displayOrder: primary && i === 0 && existing.length > 0 ? min - 1 : (max += 1),
  }));
  await tx.productImage.createMany({ data });
  await tx.auditLog.createMany({
    data: data.map((d) => ({
      actorUserId: job.createdByUserId,
      action: 'product.image.attach',
      entityType: 'ProductImage',
      entityId: productId,
      after: { productId, url: d.url, importId: job.id },
    })),
  });
}

async function processImageRow(job: Job, row: ProductImportRow, images: Map<string, StoredImage>): Promise<void> {
  const p = row.parsed as unknown as ResolvedRow;
  await runInTransaction(async (tx) => {
    await attachImages(tx, job, p.productId!, imagesOf(row, images), Boolean(p.makePrimary), p.productName?.slice(0, 200) ?? null);
    await markDone(tx, [{ rowId: row.id, productId: p.productId! }]);
  });
}

/* -------------------------------------------------------------------------- */
/* UPDATE                                                                     */
/* -------------------------------------------------------------------------- */

async function processUpdateRow(job: Job, row: ProductImportRow, images: Map<string, StoredImage>): Promise<void> {
  const p = row.parsed as unknown as ResolvedRow;
  const actor = job.createdByUserId ?? '';
  const productId = p.productId!;

  const fields = Object.fromEntries(
    (['name', 'nameHi', 'description', 'categoryId', 'variantName', 'unit', 'unitValue', 'mrpPaise', 'pricePaise', 'stockQty'] as const)
      .filter((key) => p[key] !== undefined)
      .map((key) => [key, p[key]]),
  );
  // The seller's own edit path: ownership, editable window, price <= MRP, ledgered stock.
  if (Object.keys(fields).length > 0) await updateSellerProduct(job.sellerId, productId, fields, actor);

  if (p.barcode !== undefined || p.brandId !== undefined) {
    await runInTransaction(async (tx) => {
      if (p.barcode !== undefined) {
        await tx.productVariant.updateMany({ where: { id: p.variantId!, product: { submittedBySellerId: job.sellerId } }, data: { barcode: p.barcode } });
      }
      if (p.brandId !== undefined) {
        await tx.product.updateMany({ where: { id: productId, submittedBySellerId: job.sellerId }, data: { brandId: p.brandId } });
      }
      await tx.auditLog.create({
        data: {
          actorUserId: job.createdByUserId,
          action: 'product.import_update',
          entityType: 'Product',
          entityId: productId,
          after: { barcode: p.barcode ?? null, brandId: p.brandId ?? null, importId: job.id },
        },
      });
    });
  }
  if (p.isActive !== undefined) {
    await setOwnProductStatus(job.sellerId, productId, p.isActive ? ProductStatus.ACTIVE : ProductStatus.INACTIVE, actor);
  }
  await runInTransaction(async (tx) => {
    if (row.imageNames && (row.imageNames as string[]).length > 0) {
      await attachImages(tx, job, productId, imagesOf(row, images), Boolean(p.primaryImageGiven), (p.name ?? p.productName ?? null)?.slice(0, 200) ?? null);
    }
    await markDone(tx, [{ rowId: row.id, productId }]);
  });
}

/* -------------------------------------------------------------------------- */
/* Job                                                                        */
/* -------------------------------------------------------------------------- */

/** Atomically takes the job: only one worker ever processes it at a time. */
async function claim(importId: string): Promise<Job | null> {
  const now = new Date();
  const claimed = await prisma.productImport.updateMany({
    where: {
      id: importId,
      OR: [
        { status: ProductImportStatus.QUEUED },
        { status: ProductImportStatus.PROCESSING, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] },
      ],
    },
    data: { status: ProductImportStatus.PROCESSING, heartbeatAt: now },
  });
  if (claimed.count === 0) return null;
  await prisma.productImport.updateMany({ where: { id: importId, startedAt: null }, data: { startedAt: now } });
  return prisma.productImport.findUnique({
    where: { id: importId },
    select: { id: true, sellerId: true, kind: true, mode: true, createdByUserId: true },
  });
}

/** Final counts from the rows themselves (the source of truth). */
export async function finalizeImport(importId: string): Promise<void> {
  const groups = await prisma.productImportRow.groupBy({ by: ['status', 'action'], where: { importId }, _count: { _all: true } });
  const sum = (match: (g: (typeof groups)[number]) => boolean) => groups.filter(match).reduce((n, g) => n + g._count._all, 0);
  await prisma.productImport.update({
    where: { id: importId },
    data: {
      status: ProductImportStatus.COMPLETED,
      completedAt: new Date(),
      heartbeatAt: new Date(),
      createdCount: sum((g) => g.status === 'DONE' && g.action === ProductImportRowAction.CREATE),
      updatedCount: sum((g) => g.status === 'DONE' && g.action !== ProductImportRowAction.CREATE),
      failedCount: sum((g) => g.status === 'FAILED' || g.status === 'INVALID'),
      skippedCount: sum((g) => g.status === 'DUPLICATE' || g.status === 'CONFLICT' || g.status === 'EXCLUDED'),
      processedRows: sum((g) => g.status === 'DONE' || g.status === 'FAILED'),
    },
  });
  // Stored images no remaining row can use (invalid / skipped rows) are freed.
  await releaseImportImages(importId, true);
}

/** Processes a confirmed import to the end (or until this worker dies — then another resumes it). */
export async function processImport(importId: string): Promise<void> {
  const job = await claim(importId);
  if (!job) return;
  log.info({ importId, kind: job.kind, mode: job.mode }, 'product import processing');
  for (;;) {
    const rows = await prisma.productImportRow.findMany({
      where: { importId, status: ProductImportRowStatus.READY },
      orderBy: { rowNumber: 'asc' },
      take: PROCESS_BATCH_SIZE,
    });
    if (rows.length === 0) break;
    if (job.kind === ProductImportKind.PRODUCTS && job.mode === ProductImportMode.CREATE) {
      await processCreateBatch(job, rows);
    } else {
      const images = await loadImages(job.id, rows);
      for (const row of rows) {
        try {
          if (job.kind === ProductImportKind.IMAGES) await processImageRow(job, row, images);
          else await processUpdateRow(job, row, images);
        } catch (error) {
          await markFailed(row, error);
        }
      }
    }
    await heartbeat(importId, { processedRows: { increment: rows.length } });
  }
  await finalizeImport(importId);
  await prisma.auditLog.create({
    data: { actorUserId: job.createdByUserId, action: 'product_import.completed', entityType: 'ProductImport', entityId: importId, after: { sellerId: job.sellerId } },
  });
  log.info({ importId }, 'product import completed');
}
