/**
 * Bulk import — processing a confirmed import. Runs in the background
 * (import-worker.ts), in bounded batches, resumable, safe with several
 * backend instances:
 *
 *   lease      claiming is one atomic UPDATE (QUEUED, or PROCESSING whose
 *              lease expired) that stamps a per-run lease token. The lease is
 *              renewed on a timer, independent of how long a batch takes, so
 *              a slow batch never looks dead. EVERY write a worker makes for
 *              the job (rows done / failed, update stages, progress, the final
 *              summary) is fenced on that token: a worker that lost its lease
 *              can no longer commit anything, it just stops.
 *   checks     before every batch: the seller is still live and ACTIVE, and
 *              the account that started the import still exists — otherwise
 *              the import stops with a clear reason, nothing more is written.
 *   CREATE     50 rows per transaction: products, variants, the seller's own
 *              listings, opening-stock ledger rows, images and audit rows —
 *              and, in the SAME transaction, the rows marked DONE. Category and
 *              barcode facts are re-checked first (the preview may be days
 *              old). A failing batch is retried row by row.
 *   UPDATE     through the existing seller services (updateSellerProduct:
 *              ownership, editable window, price <= MRP, ledgered stock;
 *              setOwnProductStatus), in recorded stages: a retry resumes after
 *              the last finished stage, and a failure says what was saved.
 *              Brand and barcode are never written (validation refuses them).
 *   IMAGES     one transaction per image: lock the product, attach (never
 *              twice: same URL is skipped under the lock), mark DONE.
 *
 * New products are created exactly like "Add Product": approvalStatus
 * PENDING, invisible to customers until Aadione approves them.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  ApprovalStatus,
  Prisma,
  ProductImportKind,
  ProductImportMode,
  ProductImportRowAction,
  ProductImportRowStatus,
  ProductImportStatus,
  ProductStatus,
  SellerLifecycleStatus,
  StockLedgerReason,
  UserStatus,
  type ProductImportRow,
} from '@prisma/client';
import { ErrorCode, PRODUCT_IMPORT_LIMITS, type ProductImportIssue } from '../../shared';
import { slugify } from '../../shared/text';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { loadEditableOwnProduct, setOwnProductStatus, updateSellerProduct } from '../catalog/product-approval.service';
import { releaseImportImages } from './import-analysis';
import type { ResolvedRow } from './import-validation';
import { LEASE_RENEW_MS, MAX_PROCESS_ATTEMPTS, PROCESS_BATCH_SIZE, STALE_PROCESSING_MS } from './import-limits';
import { imageNameKey } from './row-rules';

const log = moduleLogger('product-import');

/** This process; each processing run adds its own suffix (the lease token). */
const PROCESS_ID = `${os.hostname().slice(0, 30)}:${process.pid}`;

interface Job {
  id: string;
  sellerId: string;
  kind: ProductImportKind;
  mode: ProductImportMode;
  createdByUserId: string | null;
  /** The lease token every write is fenced on. */
  lease: string;
  /** Processing runs claimed so far, this one included. */
  attempts: number;
}

/** The import can no longer run (seller not active, creator gone, lease lost). */
class StopImport extends Error {
  constructor(
    readonly reason: string,
    readonly leaseLost = false,
  ) {
    super(reason);
  }
}

type StoredImage = { url: string; thumbUrl: string | null };

/** UPDATE row stages already applied (row.stages). */
interface Stages {
  fields?: boolean;
  status?: boolean;
}

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
    if (error.code === 'P2002') return row.sku ? `SKU ${row.sku} was taken by another product while importing. Use a different SKU.` : 'This SKU was taken by another product while importing.';
    if (error.code === 'P2003') return 'The category was removed while importing. Choose a current category.';
  }
  if (/price_paise <= mrp_paise|check constraint/i.test(String((error as Error)?.message))) return 'Selling price cannot exceed MRP.';
  return 'This row could not be saved. Use "Retry failed rows" to try again.';
}

/* -------------------------------------------------------------------------- */
/* Fenced writes                                                              */
/* -------------------------------------------------------------------------- */

/** Rows of this import, only while `lease` still holds the job. */
const leased = (job: Job) => ({ import: { workerId: job.lease, status: ProductImportStatus.PROCESSING } });

async function markFailed(job: Job, row: ProductImportRow, error: unknown, prefix = ''): Promise<void> {
  if (!(error instanceof AppError) || error.status >= 500) log.warn({ err: error, rowId: row.id }, 'import row failed');
  const issue: ProductImportIssue = { field: null, message: `${prefix}${rowFailure(error, row)}` };
  await prisma.productImportRow.updateMany({
    where: { id: row.id, status: ProductImportRowStatus.READY, ...leased(job) },
    data: { status: ProductImportRowStatus.FAILED, errors: [issue] as unknown as Prisma.InputJsonValue, processedAt: new Date() },
  });
}

/** Marks rows DONE inside the caller's transaction — all of them while the lease holds, or the transaction fails. */
async function markDone(tx: Tx, job: Job, done: { rowId: string; productId: string }[]): Promise<void> {
  const values = Prisma.join(done.map((d) => Prisma.sql`(${d.rowId}::uuid, ${d.productId}::uuid)`));
  const updated = await tx.$executeRaw`
    UPDATE product_import_rows AS r
       SET status = 'DONE', product_id = v.pid, processed_at = now()
      FROM (VALUES ${values}) AS v(id, pid)
     WHERE r.id = v.id AND r.status = 'READY'
       AND EXISTS (SELECT 1 FROM product_imports p WHERE p.id = r.import_id AND p.worker_id = ${job.lease} AND p.status = 'PROCESSING')`;
  if (updated !== done.length) throw new StopImport(`import rows changed or lease lost (${updated}/${done.length})`, true);
}

async function saveStage(job: Job, row: ProductImportRow, stages: Stages): Promise<void> {
  const saved = await prisma.productImportRow.updateMany({
    where: { id: row.id, status: ProductImportRowStatus.READY, ...leased(job) },
    data: { stages: stages as Prisma.InputJsonValue },
  });
  if (saved.count === 0) throw new StopImport('lease lost', true);
}

/* -------------------------------------------------------------------------- */
/* Checks before every batch                                                  */
/* -------------------------------------------------------------------------- */

async function assertMayRun(job: Job): Promise<void> {
  const [seller, creator] = await Promise.all([
    prisma.seller.findUnique({ where: { id: job.sellerId }, select: { deletedAt: true, isActive: true, lifecycleStatus: true } }),
    job.createdByUserId ? prisma.user.findUnique({ where: { id: job.createdByUserId }, select: { deletedAt: true, status: true } }) : null,
  ]);
  if (!seller || seller.deletedAt || !seller.isActive || seller.lifecycleStatus !== SellerLifecycleStatus.ACTIVE) {
    throw new StopImport('The import stopped because the seller account is not active. Nothing more was imported.');
  }
  if (!creator || creator.deletedAt || creator.status !== UserStatus.ACTIVE) {
    throw new StopImport('The import stopped because the account that started it is no longer active. Start a new import.');
  }
}

/* -------------------------------------------------------------------------- */
/* CREATE                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The preview may be days old: re-checks what can have changed since —
 * category ownership / status and the seller's own barcodes. Returns the
 * rows that may still be written; the others are marked failed.
 */
async function recheckCreateRows(job: Job, rows: ProductImportRow[]): Promise<ProductImportRow[]> {
  const parsed = (row: ProductImportRow) => row.parsed as unknown as ResolvedRow;
  const categoryIds = [...new Set(rows.map((r) => parsed(r).categoryId).filter((id): id is string => Boolean(id)))];
  const categories = await prisma.category.findMany({
    where: { id: { in: categoryIds }, sellerId: job.sellerId, deletedAt: null, isActive: true },
    select: { id: true, parentId: true, parent: { select: { isActive: true, deletedAt: true, sellerId: true } } },
  });
  const usable = new Set(
    categories.filter((c) => c.parentId === null || (c.parent && c.parent.isActive && !c.parent.deletedAt && c.parent.sellerId === job.sellerId)).map((c) => c.id),
  );
  const barcodes = [...new Set(rows.map((r) => parsed(r).barcode).filter((b): b is string => Boolean(b)))];
  const taken = barcodes.length
    ? new Set(
        (
          await prisma.productVariant.findMany({
            where: { barcode: { in: barcodes }, deletedAt: null, product: { submittedBySellerId: job.sellerId, deletedAt: null } },
            select: { barcode: true },
          })
        ).map((v) => v.barcode!),
      )
    : new Set<string>();

  const keep: ProductImportRow[] = [];
  for (const row of rows) {
    const p = parsed(row);
    if (!p.categoryId || !usable.has(p.categoryId)) {
      await markFailed(job, row, new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Its category was switched off or removed after the preview. Choose a current category and upload the row again.' }));
    } else if (p.barcode && taken.has(p.barcode)) {
      await markFailed(job, row, new AppError(ErrorCode.VALIDATION_ERROR, { message: `You now already have a product with barcode ${p.barcode}.` }));
    } else keep.push(row);
  }
  return keep;
}

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
        job,
        plan.map(({ row, productId }) => ({ rowId: row.id, productId })),
      );
    },
    { timeoutMs: 30_000 },
  );
}

async function processCreateBatch(job: Job, batch: ProductImportRow[]): Promise<void> {
  const rows = await recheckCreateRows(job, batch);
  if (rows.length === 0) return;
  const images = await loadImages(job.id, rows);
  try {
    await writeCreateBatch(job, rows, images);
  } catch (error) {
    if (error instanceof StopImport) throw error;
    if (rows.length === 1) return markFailed(job, rows[0]!, error);
    // One bad row must not sink the batch: write them one by one.
    for (const row of rows) {
      try {
        await writeCreateBatch(job, [row], images);
      } catch (rowError) {
        if (rowError instanceof StopImport) throw rowError;
        await markFailed(job, row, rowError);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Images (UPDATE rows and images-only rows)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Adds images to an own product in its editable window. The product row is
 * locked first, so two workers (or two rows) attaching to the same product
 * are serialised: an already-attached file (same URL) is always seen and
 * skipped — never attached twice. `primary`: the first image becomes the main photo.
 */
async function attachImages(tx: Tx, job: Job, productId: string, list: StoredImage[], primary: boolean, altText: string | null): Promise<void> {
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
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
    await markDone(tx, job, [{ rowId: row.id, productId: p.productId! }]);
  });
}

/* -------------------------------------------------------------------------- */
/* UPDATE                                                                     */
/* -------------------------------------------------------------------------- */

const STAGE_LABEL: Record<keyof Stages, string> = { fields: 'details, price and stock', status: 'shown / hidden' };

/** The product as the database has it now — what an UPDATE row compares against. */
async function currentState(job: Job, variantId: string) {
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, deletedAt: null, product: { submittedBySellerId: job.sellerId, deletedAt: null } },
    select: {
      variantName: true,
      unit: true,
      unitValue: true,
      product: {
        select: {
          name: true,
          nameHi: true,
          description: true,
          categoryId: true,
          status: true,
          _count: { select: { variants: { where: { deletedAt: null } } } },
        },
      },
      sellerListings: { where: { sellerId: job.sellerId }, select: { mrpPaise: true, pricePaise: true, stockQty: true } },
    },
  });
  if (!variant) throw new AppError(ErrorCode.NOT_FOUND, { message: 'This product no longer exists.' });
  // updateSellerProduct edits the product's default variant: only safe while
  // the matched variant is the product's ONLY live one (as at the preview).
  if (variant.product._count.variants !== 1) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'This product now has several variants (options). Edit it on its product page instead.' });
  }
  return variant;
}

/**
 * One UPDATE row: fields -> status -> images + DONE.
 *
 * Idempotent by DESIRED STATE, not by flags: before each step the product is
 * read from the database and only the values that still differ are sent to
 * the seller services. So a crash at ANY point — even after a service
 * committed its change but before the import recorded it — is safe: the retry
 * finds those values already in place and sends nothing for them, which means
 * no second stock-ledger row, price audit or product audit. (The shared
 * services each run their own transactions, so the change and the import's
 * marker cannot share one; comparing with the database is what makes the
 * retry exact. Images and DONE do share one transaction.)
 *
 * `stages` only records what was saved, for a truthful failure message.
 */
async function processUpdateRow(job: Job, row: ProductImportRow, images: Map<string, StoredImage>): Promise<void> {
  const p = row.parsed as unknown as ResolvedRow;
  const actor = job.createdByUserId!;
  const productId = p.productId!;
  const stages: Stages = { ...(row.stages as Stages) };
  const savedPrefix = () => {
    const saved = (Object.keys(STAGE_LABEL) as (keyof Stages)[]).filter((k) => stages[k]).map((k) => STAGE_LABEL[k]);
    return saved.length ? `Saved: ${saved.join(', ')}. Not saved: ` : '';
  };
  try {
    const now = await currentState(job, p.variantId!);
    const listing = now.sellerListings[0];
    const differs: Record<string, unknown> = {};
    const want = <K extends keyof ResolvedRow>(key: K, current: unknown) => {
      if (p[key] !== undefined && p[key] !== current) differs[key] = p[key];
    };
    want('name', now.product.name);
    want('nameHi', now.product.nameHi);
    want('description', now.product.description);
    want('categoryId', now.product.categoryId);
    want('variantName', now.variantName);
    want('unit', now.unit);
    want('unitValue', now.unitValue);
    if (listing) {
      want('mrpPaise', listing.mrpPaise);
      want('pricePaise', listing.pricePaise);
      want('stockQty', listing.stockQty);
    } else {
      // No listing yet: the three are created together (validation required all three).
      for (const key of ['mrpPaise', 'pricePaise', 'stockQty'] as const) if (p[key] !== undefined) differs[key] = p[key];
    }
    if (Object.keys(differs).length > 0) {
      // The seller's own edit path: ownership, editable window, price <= MRP, ledgered stock.
      await updateSellerProduct(job.sellerId, productId, differs, actor);
    }
    const hasFieldValues = (['name', 'nameHi', 'description', 'categoryId', 'variantName', 'unit', 'unitValue', 'mrpPaise', 'pricePaise', 'stockQty'] as const).some(
      (key) => p[key] !== undefined,
    );
    if (hasFieldValues && !stages.fields) {
      stages.fields = true;
      await saveStage(job, row, stages);
    }
    const wantStatus = p.isActive === undefined ? null : p.isActive ? ProductStatus.ACTIVE : ProductStatus.INACTIVE;
    if (wantStatus && now.product.status !== wantStatus) {
      // setOwnProductStatus itself writes nothing when the status already matches.
      await setOwnProductStatus(job.sellerId, productId, wantStatus, actor);
    }
    if (wantStatus && !stages.status) {
      stages.status = true;
      await saveStage(job, row, stages);
    }
    await runInTransaction(async (tx) => {
      if ((row.imageNames as string[]).length > 0) {
        await attachImages(tx, job, productId, imagesOf(row, images), Boolean(p.primaryImageGiven), (p.name ?? p.productName ?? null)?.slice(0, 200) ?? null);
      }
      await markDone(tx, job, [{ rowId: row.id, productId }]);
    });
  } catch (error) {
    if (error instanceof StopImport) throw error;
    await markFailed(job, row, error, savedPrefix());
  }
}

/* -------------------------------------------------------------------------- */
/* Job                                                                        */
/* -------------------------------------------------------------------------- */

/** Atomically takes the job and stamps a fresh lease token. */
async function claim(importId: string): Promise<Job | null> {
  const now = new Date();
  const lease = `${PROCESS_ID}:${randomUUID().slice(0, 8)}`;
  const claimed = await prisma.productImport.updateMany({
    where: {
      id: importId,
      OR: [
        { status: ProductImportStatus.QUEUED },
        { status: ProductImportStatus.PROCESSING, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] },
      ],
    },
    data: { status: ProductImportStatus.PROCESSING, heartbeatAt: now, workerId: lease, attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  await prisma.productImport.updateMany({ where: { id: importId, workerId: lease, startedAt: null }, data: { startedAt: now } });
  const job = await prisma.productImport.findUnique({ where: { id: importId }, select: { id: true, sellerId: true, kind: true, mode: true, createdByUserId: true, attempts: true } });
  return job ? { ...job, lease } : null;
}

/** Renews the lease on a timer; `lost` turns true once another worker holds it. */
function keepLease(job: Job) {
  const state = { lost: false };
  const timer = setInterval(() => {
    prisma.productImport
      .updateMany({ where: { id: job.id, workerId: job.lease, status: ProductImportStatus.PROCESSING }, data: { heartbeatAt: new Date() } })
      .then((r) => {
        if (r.count === 0) state.lost = true;
      })
      .catch((error) => log.warn({ err: error, importId: job.id }, 'lease renewal failed'));
  }, LEASE_RENEW_MS);
  timer.unref();
  return { state, stop: () => clearInterval(timer) };
}

/** Final counts from the rows themselves (the source of truth). Fenced on the lease. */
export async function finalizeImport(importId: string, lease: string | null, outcome: { status: ProductImportStatus; errorSummary?: string } = { status: ProductImportStatus.COMPLETED }): Promise<boolean> {
  const groups = await prisma.productImportRow.groupBy({ by: ['status', 'action'], where: { importId }, _count: { _all: true } });
  const sum = (match: (g: (typeof groups)[number]) => boolean) => groups.filter(match).reduce((n, g) => n + g._count._all, 0);
  const done = await prisma.productImport.updateMany({
    where: { id: importId, ...(lease ? { workerId: lease } : {}) },
    data: {
      status: outcome.status,
      ...(outcome.errorSummary ? { errorSummary: outcome.errorSummary.slice(0, 500) } : {}),
      completedAt: new Date(),
      heartbeatAt: new Date(),
      workerId: null,
      createdCount: sum((g) => g.status === 'DONE' && g.action === ProductImportRowAction.CREATE),
      updatedCount: sum((g) => g.status === 'DONE' && g.action !== ProductImportRowAction.CREATE),
      failedCount: sum((g) => g.status === 'FAILED' || g.status === 'INVALID'),
      skippedCount: sum((g) => g.status === 'DUPLICATE' || g.status === 'CONFLICT' || g.status === 'EXCLUDED'),
      processedRows: sum((g) => g.status === 'DONE' || g.status === 'FAILED'),
    },
  });
  if (done.count === 0) return false;
  // Stored images no remaining row can use (invalid / skipped rows) are freed.
  await releaseImportImages(importId, true);
  return true;
}

/** Processes a confirmed import to the end — or stops cleanly (lease lost, seller / creator no longer active). */
export async function processImport(importId: string): Promise<void> {
  const job = await claim(importId);
  if (!job) return;
  const lease = keepLease(job);
  log.info({ importId, kind: job.kind, mode: job.mode }, 'product import processing');
  try {
    if (job.attempts > MAX_PROCESS_ATTEMPTS) {
      throw new StopImport('The import could not be finished after several attempts. Use "Retry failed rows" to try once more, or contact support.');
    }
    for (;;) {
      if (lease.state.lost) throw new StopImport('lease lost', true);
      await assertMayRun(job);
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
          if (lease.state.lost) throw new StopImport('lease lost', true);
          try {
            if (job.kind === ProductImportKind.IMAGES) await processImageRow(job, row, images);
            else await processUpdateRow(job, row, images);
          } catch (error) {
            if (error instanceof StopImport) throw error;
            await markFailed(job, row, error);
          }
        }
      }
      const progressed = await prisma.productImport.updateMany({
        where: { id: importId, workerId: job.lease },
        data: { processedRows: { increment: rows.length }, heartbeatAt: new Date() },
      });
      if (progressed.count === 0) throw new StopImport('lease lost', true);
    }
    if (await finalizeImport(importId, job.lease)) {
      await prisma.auditLog.create({
        data: { actorUserId: job.createdByUserId, action: 'product_import.completed', entityType: 'ProductImport', entityId: importId, after: { sellerId: job.sellerId } },
      });
      log.info({ importId }, 'product import completed');
    }
  } catch (error) {
    if (!(error instanceof StopImport)) {
      // Unexpected (database down, a bug): give the lease back at once so a
      // worker can resume soon; the attempt counter stops endless repeats.
      await prisma.productImport
        .updateMany({ where: { id: importId, workerId: job.lease, status: ProductImportStatus.PROCESSING }, data: { heartbeatAt: null } })
        .catch(() => undefined);
      throw error;
    }
    if (error.leaseLost) {
      log.warn({ importId, reason: error.reason }, 'product import lease lost; another worker continues');
      return;
    }
    // Not allowed to continue: the rows not yet imported say why, the job is FAILED.
    await prisma.productImportRow.updateMany({
      where: { importId, status: ProductImportRowStatus.READY, ...leased(job) },
      data: { status: ProductImportRowStatus.FAILED, errors: [{ field: null, message: `Not imported: ${error.reason}` }] as unknown as Prisma.InputJsonValue },
    });
    await finalizeImport(importId, job.lease, { status: ProductImportStatus.FAILED, errorSummary: error.reason });
    log.warn({ importId, reason: error.reason }, 'product import stopped');
  } finally {
    lease.stop();
  }
}

/** Internals the concurrency tests drive directly (lease fencing, attach under the product lock). */
export const __testing = { markDone, attachImages };
