/**
 * Bulk import hardening, end to end (real app, database, local storage):
 * stale previews, the brand / barcode edit policy, seller and creator checks
 * before processing, leases and concurrent workers, race-safe photo attach,
 * truthful partial updates and their retry, crash cleanup, streaming upload
 * limits on the real route, and the preview re-check rate limit.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProductImportKind, ProductImportMode } from '@prisma/client';
import { ApprovalStatus, UserRole, type ProductImportDto, type ProductImportRowDto, type ProductImportRowPageDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { makeZip } from '../helpers/zip';
import { cache } from '../../src/infra/cache';
import { runInTransaction } from '../../src/infra/db/prisma';
import { buildImageKey, storage } from '../../src/infra/storage';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { IMPORT_TMP_DIR, ensureTmpDir, importQueuesIdle, runProductImportWorker } from '../../src/modules/product-import/import-worker';
import { __testing, processImport } from '../../src/modules/product-import/import-processing';
import { updateSellerProduct } from '../../src/modules/catalog/product-approval.service';

interface Seller {
  id: string;
  token: string;
  userId: string;
}

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

async function seedSeller(mobile: string): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Kirana ${mobile}`,
      sellerType: 'GROCERY',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  const token = (await loginAs(mobile)).accessToken;
  await as(token).post('/seller/categories', { name: 'Snacks' }).expect(201);
  await as(token).post('/seller/categories', { name: 'Cold Drinks' }).expect(201);
  return { id: seller.id, token, userId: user.id };
}

const HEADER = 'seller_sku,barcode,product_name,category,brand,mrp,selling_price,stock_quantity,unit,unit_value,image_filename';
const row = (sku: string, opts: { barcode?: string; category?: string; image?: string; stock?: number } = {}) =>
  [sku, opts.barcode ?? '', `Item ${sku}`, opts.category ?? 'Snacks', '', '20', '18', String(opts.stock ?? 5), 'g', '100', opts.image ?? ''].join(',');

function upload(token: string, csv: string, opts: { zip?: Buffer; mode?: 'CREATE' | 'UPDATE' } = {}) {
  let req = api().post('/api/v1/seller/imports').set('Authorization', bearer(token)).field('mode', opts.mode ?? 'CREATE').attach('file', Buffer.from(csv), 'p.csv');
  if (opts.zip) req = req.attach('archive', opts.zip, 'photos.zip');
  return req;
}

async function preview(token: string, csv: string, opts: { zip?: Buffer; mode?: 'CREATE' | 'UPDATE' } = {}): Promise<ProductImportDto> {
  const res = await upload(token, csv, opts);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await importQueuesIdle();
  return expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${expectSuccess<ProductImportDto>(res.body).data.id}`).expect(200)).body).data;
}

const getJob = async (token: string, id: string) => expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${id}`).expect(200)).body).data;
const getRows = async (token: string, id: string, filter = 'ALL') =>
  expectSuccess<ProductImportRowPageDto>((await as(token).get(`/seller/imports/${id}/rows?filter=${filter}&pageSize=100`).expect(200)).body).data.items as ProductImportRowDto[];

/** Queues a READY preview the way confirm does, without confirm's own re-check (to test processing-time checks). */
const queue = (id: string) => prisma.productImport.update({ where: { id }, data: { status: 'QUEUED', heartbeatAt: null } });

async function createdProduct(seller: Seller, sku: string, extra: { barcode?: string; stock?: number } = {}) {
  const job = await preview(seller.token, [HEADER, row(sku, extra)].join('\n'));
  await as(seller.token).post(`/seller/imports/${job.id}/confirm`, { mode: 'CREATE' }).expect(200);
  await importQueuesIdle();
  return prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { sellerListings: true } });
}

const jpeg = (color = '#c62828') => sharp({ create: { width: 700, height: 700, channels: 3, background: color } }).jpeg().toBuffer();

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

/* -------------------------------------------------------------------------- */

describe('stale previews', () => {
  it('confirm re-checks everything: a category switched off since the preview is caught, nothing is created', async () => {
    const seller = await seedSeller('9400000901');
    const job = await preview(seller.token, [HEADER, row('ST-1'), row('ST-2', { category: 'Cold Drinks' })].join('\n'));
    expect(job.readyRows).toBe(2);
    const snacks = await prisma.category.findFirstOrThrow({ where: { sellerId: seller.id, name: 'Snacks' } });
    await as(seller.token).patch(`/seller/categories/${snacks.id}`, { isActive: false }).expect(200);

    const refused = await as(seller.token).post(`/seller/imports/${job.id}/confirm`, { mode: 'CREATE' }).expect(409);
    expect(expectError(refused.body).message).toMatch(/catalogue changed since this preview was checked \(1 row no longer ready\)/);
    expect(await prisma.product.count()).toBe(0);
    const after = await getJob(seller.token, job.id);
    expect(after).toMatchObject({ status: 'READY', readyRows: 1, invalidRows: 1 });
    expect((await getRows(seller.token, job.id, 'ISSUES'))[0]!.errors[0]!.message).toMatch(/Snacks is switched off/);

    // Confirming the re-checked preview imports exactly what it now shows.
    await as(seller.token).post(`/seller/imports/${job.id}/confirm`, { mode: 'CREATE' }).expect(200);
    await importQueuesIdle();
    expect(await prisma.productVariant.findMany({ select: { sku: true } })).toEqual([{ sku: 'ST-2' }]);
  });

  it('processing re-checks categories and own barcodes once more (a queue can wait)', async () => {
    const seller = await seedSeller('9400000902');
    const existing = await createdProduct(seller, 'OLD-1');
    const job = await preview(seller.token, [HEADER, row('PR-1'), row('PR-2', { category: 'Cold Drinks', barcode: '1234567890128' }), row('PR-3', { category: 'Cold Drinks' })].join('\n'));
    expect(job.readyRows).toBe(3);
    await queue(job.id);
    await prisma.category.updateMany({ where: { sellerId: seller.id, name: 'Snacks' }, data: { isActive: false } });
    await prisma.productVariant.update({ where: { id: existing.id }, data: { barcode: '1234567890128' } });

    await processImport(job.id);
    const done = await getJob(seller.token, job.id);
    expect(done).toMatchObject({ status: 'COMPLETED', createdCount: 1, failedCount: 2 });
    const failed = new Map((await getRows(seller.token, job.id, 'FAILED')).map((r) => [r.sku, r.errors[0]!.message]));
    expect(failed.get('PR-1')).toMatch(/category was switched off or removed after the preview/);
    expect(failed.get('PR-2')).toMatch(/now already have a product with barcode 1234567890128/);
    expect(await prisma.productVariant.count({ where: { sku: { in: ['PR-1', 'PR-2'] } } })).toBe(0);
  });
});

describe('update mode edit policy', () => {
  it('brand and barcode changes are refused per row; products are not touched; Add new never edits', async () => {
    const seller = await seedSeller('9400000903');
    await prisma.brand.create({ data: { name: 'Haldiram', slug: 'haldiram' } });
    await createdProduct(seller, 'UP-A', { barcode: '1234567890128' });
    await createdProduct(seller, 'UP-B');
    await createdProduct(seller, 'UP-C', { barcode: '8901058851298' });
    await createdProduct(seller, 'UP-D', { barcode: '4006381333931' });
    const csv = [
      'seller_sku,brand,barcode,selling_price',
      'UP-A,Haldiram,,15', // brand change
      'UP-B,,96385074,15', // barcode added
      'UP-C,,96385074,15', // barcode changed
      'UP-A,,1234567890128,14', // same product again
      ',,4006381333931,16', // barcode used only to find the product: fine
    ].join('\n');
    const job = await preview(seller.token, csv, { mode: 'UPDATE' });
    const byRow = new Map((await getRows(seller.token, job.id)).map((r) => [r.rowNumber, r]));
    const errorsOf = (n: number) => byRow.get(n)!.errors.map((e) => e.message).join(' ');
    expect(byRow.get(2)!.status).toBe('INVALID');
    expect(errorsOf(2)).toMatch(/Brand cannot be changed by an import/);
    expect(errorsOf(3)).toMatch(/Barcode cannot be added by an import/);
    expect(errorsOf(4)).toMatch(/Barcode cannot be changed by an import \(this product has 8901058851298\)/);
    expect(byRow.get(5)!.status).toBe('DUPLICATE');
    expect(byRow.get(6)).toMatchObject({ status: 'READY', sku: 'UP-D' });
    await as(seller.token).post(`/seller/imports/${job.id}/confirm`, { mode: 'UPDATE' }).expect(200);
    await importQueuesIdle();
    const variant = (sku: string) => prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { product: true, sellerListings: true } });
    const a = await variant('UP-A');
    expect(a.product.brandId).toBeNull();
    expect(a.sellerListings[0]!.pricePaise).toBe(1800);
    expect((await variant('UP-B')).barcode).toBeNull();
    expect((await variant('UP-C')).barcode).toBe('8901058851298');
    expect((await variant('UP-D')).sellerListings[0]!.pricePaise).toBe(1600);

    // Add new: an existing SKU is never modified, and new products stay pending approval.
    const create = await preview(seller.token, [HEADER, row('UP-A'), row('NEW-1')].join('\n'));
    expect(create).toMatchObject({ conflictRows: 1, readyRows: 1 });
    await as(seller.token).post(`/seller/imports/${create.id}/confirm`, { mode: 'CREATE' }).expect(200);
    await importQueuesIdle();
    expect((await prisma.product.findFirstOrThrow({ where: { variants: { some: { sku: 'NEW-1' } } } })).approvalStatus).toBe('PENDING');
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'UP-A' }, include: { sellerListings: true } })).sellerListings[0]!.pricePaise).toBe(1800);
  });
});

describe('seller and creator checks before processing', () => {
  it('a seller no longer ACTIVE: the import stops, nothing is written, and it can be retried once active again', async () => {
    const seller = await seedSeller('9400000904');
    const job = await preview(seller.token, [HEADER, row('SU-1'), row('SU-2')].join('\n'));
    await queue(job.id);
    // Back in onboarding review (lifecycle and onboarding status change together — a DB CHECK ties them).
    await prisma.seller.update({ where: { id: seller.id }, data: sellerLifecycleFields(ApprovalStatus.PENDING) });
    await processImport(job.id);
    const stopped = await prisma.productImport.findUniqueOrThrow({ where: { id: job.id } });
    expect(stopped).toMatchObject({ status: 'FAILED', createdCount: 0, failedCount: 2 });
    expect(stopped.errorSummary).toMatch(/seller account is not active/);
    expect(await prisma.product.count()).toBe(0);

    await prisma.seller.update({ where: { id: seller.id }, data: sellerLifecycleFields(ApprovalStatus.APPROVED) });
    expect((await getRows(seller.token, job.id, 'FAILED'))[0]!.errors[0]!.message).toMatch(/^Not imported: /);
    await as(seller.token).post(`/seller/imports/${job.id}/retry`).expect(200);
    await importQueuesIdle();
    expect(await getJob(seller.token, job.id)).toMatchObject({ status: 'COMPLETED', createdCount: 2, failedCount: 0 });
  });

  it('a removed creator: the import stops with a clear reason', async () => {
    const seller = await seedSeller('9400000905');
    const job = await preview(seller.token, [HEADER, row('CR-1')].join('\n'));
    await queue(job.id);
    await prisma.user.update({ where: { id: seller.userId }, data: { status: 'BLOCKED' } });
    await processImport(job.id);
    const stopped = await prisma.productImport.findUniqueOrThrow({ where: { id: job.id } });
    expect(stopped.status).toBe('FAILED');
    expect(stopped.errorSummary).toMatch(/account that started it is no longer active/);
    expect(await prisma.product.count()).toBe(0);
  });
});

describe('leases and concurrent workers', () => {
  it('two workers on one job: one does the work, nothing is created twice', async () => {
    const seller = await seedSeller('9400000906');
    const csv = [HEADER, ...Array.from({ length: 120 }, (_, i) => row(`CW-${i}`))].join('\n');
    const job = await preview(seller.token, csv);
    await queue(job.id);
    await Promise.all([processImport(job.id), processImport(job.id), processImport(job.id)]);
    expect(await prisma.productVariant.count({ where: { sku: { startsWith: 'CW-' } } })).toBe(120);
    expect(await getJob(seller.token, job.id)).toMatchObject({ status: 'COMPLETED', createdCount: 120 });
  });

  it('a live lease is never taken over; an expired one is', async () => {
    const seller = await seedSeller('9400000907');
    const job = await preview(seller.token, [HEADER, row('LE-1')].join('\n'));
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'PROCESSING', workerId: 'another-instance:1:abc', heartbeatAt: new Date() } });
    await processImport(job.id);
    await runProductImportWorker();
    await importQueuesIdle();
    expect(await prisma.product.count()).toBe(0);
    expect((await prisma.productImport.findUniqueOrThrow({ where: { id: job.id } })).workerId).toBe('another-instance:1:abc');

    await prisma.productImport.update({ where: { id: job.id }, data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    await processImport(job.id);
    expect(await prisma.product.count()).toBe(1);
  });

  it('a worker that lost its lease cannot commit rows', async () => {
    const seller = await seedSeller('9400000908');
    const job = await preview(seller.token, [HEADER, row('FE-1')].join('\n'));
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'PROCESSING', workerId: 'new-owner', heartbeatAt: new Date() } });
    const target = await prisma.productImportRow.findFirstOrThrow({ where: { importId: job.id } });
    const stale = { id: job.id, sellerId: seller.id, kind: ProductImportKind.PRODUCTS, mode: ProductImportMode.CREATE, createdByUserId: seller.userId, lease: 'old-owner', attempts: 1 };
    await expect(runInTransaction((tx) => __testing.markDone(tx, stale, [{ rowId: target.id, productId: randomUUID() }]))).rejects.toThrow(/lease lost/);
    expect((await prisma.productImportRow.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('READY');
  });
});

describe('photo attach is race-safe', () => {
  it('the same photo attached concurrently to one product is stored once', async () => {
    const seller = await seedSeller('9400000909');
    const v = await createdProduct(seller, 'PH-1');
    const job = { id: randomUUID(), sellerId: seller.id, kind: ProductImportKind.IMAGES, mode: ProductImportMode.UPDATE, createdByUserId: seller.userId, lease: 'x', attempts: 1 };
    const image = { url: 'http://localhost:4000/static/products/test/same.webp', thumbUrl: null };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => runInTransaction((tx) => __testing.attachImages(tx, job, v.productId, [image], false, null))),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.productImage.count({ where: { productId: v.productId } })).toBe(1);
  });
});

describe('truthful partial updates', () => {
  it('saved stages are reported; the retry resumes without repeating them', async () => {
    const seller = await seedSeller('9400000910');
    const v = await createdProduct(seller, 'PU-1', { stock: 5 });
    const zip = makeZip([{ name: 'PU-1.jpg', data: await jpeg() }]);
    const job = await preview(seller.token, ['seller_sku,selling_price,stock_quantity,image_filename', 'PU-1,15,9,PU-1.jpg'].join('\n'), { zip, mode: 'UPDATE' });
    expect(job.readyRows).toBe(1);
    // Between the preview and the import, the product fills up with 8 photos.
    await prisma.productImage.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ productId: v.productId, url: `http://localhost:4000/static/x/${i}.webp`, displayOrder: i })) });
    await queue(job.id);
    await processImport(job.id);

    const failed = (await getRows(seller.token, job.id, 'FAILED'))[0]!;
    expect(failed.errors[0]!.message).toBe('Saved: details, price and stock. Not saved: A product can have at most 8 images.');
    const listing = (await prisma.sellerListing.findFirstOrThrow({ where: { variantId: v.id } }));
    expect(listing).toMatchObject({ pricePaise: 1500, stockQty: 9 });
    const ledgerBefore = await prisma.stockLedger.count({ where: { sellerListingId: listing.id } });

    await prisma.productImage.deleteMany({ where: { productId: v.productId } });
    await as(seller.token).post(`/seller/imports/${job.id}/retry`).expect(200);
    await importQueuesIdle();
    expect(await getJob(seller.token, job.id)).toMatchObject({ status: 'COMPLETED', updatedCount: 1, failedCount: 0 });
    expect(await prisma.stockLedger.count({ where: { sellerListingId: listing.id } })).toBe(ledgerBefore); // stock not set twice
    expect(await prisma.productImage.count({ where: { productId: v.productId } })).toBe(1);
  });
});

describe('cleanup after a crash', () => {
  it('images recorded as PENDING by an analysis that died are removed with it', async () => {
    const seller = await seedSeller('9400000911');
    const old = new Date(Date.now() - 60 * 60_000);
    const job = await prisma.productImport.create({ data: { sellerId: seller.id, kind: 'PRODUCTS', status: 'ANALYZING', heartbeatAt: old, createdAt: old } });
    const key = buildImageKey('products/test-orphans', 'orphan.webp');
    const stored = await storage.put(key, await sharp(await jpeg()).webp().toBuffer(), 'image/webp');
    await prisma.productImportImage.create({ data: { importId: job.id, fileName: 'orphan.webp', nameKey: 'orphan.webp', status: 'PENDING', url: stored.url, thumbUrl: stored.url } });
    expect(await storage.get(key, 10 * 1024 * 1024)).not.toBeNull();

    await runProductImportWorker();
    expect((await prisma.productImport.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    expect(await storage.get(key, 10 * 1024 * 1024)).toBeNull();
    expect(await prisma.productImportImage.count({ where: { importId: job.id } })).toBe(0);
  });
});

describe('the real upload route', () => {
  it('a product file over 10 MB is refused while streaming and leaves no temp file', async () => {
    const seller = await seedSeller('9400000912');
    await ensureTmpDir();
    const before = new Set(readdirSync(IMPORT_TMP_DIR));
    const res = await upload(seller.token, `${HEADER}\n${'x'.repeat(10 * 1024 * 1024 + 10)}`);
    expect(res.status).toBe(413);
    expect(expectError(res.body).message).toMatch(/product file must be 10 MB or smaller/);
    await new Promise((r) => setTimeout(r, 200));
    expect(readdirSync(IMPORT_TMP_DIR).filter((f) => !before.has(f))).toEqual([]);
    expect(await prisma.productImport.count()).toBe(0);
  });

  it('preview re-checks are rate limited per user', async () => {
    const seller = await seedSeller('9400000913');
    const job = await preview(seller.token, [HEADER, row('RL-1')].join('\n'));
    const target = (await getRows(seller.token, job.id))[0]!;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await as(seller.token).patch(`/seller/imports/${job.id}/rows/${target.id}`, { excluded: false })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

/* -------------------------------------------------------------------------- */
/* Retry safety of UPDATE rows: a change committed, then a crash              */
/* -------------------------------------------------------------------------- */

describe('UPDATE retry after a crash between the change and its record', () => {
  /** Audit and ledger rows that describe changes to this product and its listing. */
  async function effects(productId: string, listingId: string) {
    const [ledger, zeroLedger, productAudits, listingAudits] = await Promise.all([
      prisma.stockLedger.count({ where: { sellerListingId: listingId } }),
      prisma.stockLedger.count({ where: { sellerListingId: listingId, delta: 0 } }),
      prisma.auditLog.count({ where: { entityId: productId } }),
      prisma.auditLog.count({ where: { entityId: listingId } }),
    ]);
    return { ledger, zeroLedger, productAudits, listingAudits };
  }

  it('the change already in the database is not applied twice: no extra ledger, price or product audit rows', async () => {
    const seller = await seedSeller('9400000920');
    const v = await createdProduct(seller, 'CRASH-1', { stock: 5 });
    const listing = v.sellerListings[0]!;
    const job = await preview(seller.token, ['seller_sku,product_name,selling_price,stock_quantity', 'CRASH-1,Renamed item,15,9'].join('\n'), { mode: 'UPDATE' });
    await queue(job.id);

    // The worker's first attempt: the seller services commit the whole change ...
    await updateSellerProduct(seller.id, v.productId, { name: 'Renamed item', pricePaise: 1500, stockQty: 9 }, seller.userId);
    // ... and the process dies before the import records anything (row still READY, no stages).
    const afterCrash = await effects(v.productId, listing.id);
    expect((await prisma.productImportRow.findFirstOrThrow({ where: { importId: job.id } })).stages).toEqual({});

    await processImport(job.id); // the resumed run
    expect(await getJob(seller.token, job.id)).toMatchObject({ status: 'COMPLETED', updatedCount: 1, failedCount: 0 });
    expect(await effects(v.productId, listing.id)).toEqual(afterCrash);
    expect(await prisma.sellerListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ pricePaise: 1500, stockQty: 9 });
  });

  it('a partly applied change: only the missing part is applied on retry, exactly once', async () => {
    const seller = await seedSeller('9400000921');
    const v = await createdProduct(seller, 'CRASH-2', { stock: 5 });
    const listing = v.sellerListings[0]!;
    const job = await preview(seller.token, ['seller_sku,selling_price,stock_quantity', 'CRASH-2,15,9'].join('\n'), { mode: 'UPDATE' });
    await queue(job.id);
    await updateSellerProduct(seller.id, v.productId, { pricePaise: 1500 }, seller.userId); // price done, crash before stock
    const before = await effects(v.productId, listing.id);

    await processImport(job.id);
    const after = await effects(v.productId, listing.id);
    expect(after.ledger).toBe(before.ledger + 1); // the stock change, once
    expect(after.zeroLedger).toBe(0); // never a zero-change ledger entry
    expect(after.listingAudits).toBe(before.listingAudits); // no second price audit (stock writes no listing audit)
    expect(await prisma.sellerListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ pricePaise: 1500, stockQty: 9 });

    // Running the finished import's row again changes nothing at all.
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'QUEUED' } });
    await prisma.productImportRow.updateMany({ where: { importId: job.id }, data: { status: 'READY' } });
    await processImport(job.id);
    expect(await effects(v.productId, listing.id)).toEqual(after);
  });

  it('a product that gained a second variant after the preview is not edited through the wrong variant', async () => {
    const seller = await seedSeller('9400000922');
    const v = await createdProduct(seller, 'VAR-1');
    const job = await preview(seller.token, ['seller_sku,selling_price', 'VAR-1,15'].join('\n'), { mode: 'UPDATE' });
    await queue(job.id);
    await prisma.productVariant.update({ where: { id: v.id }, data: { isDefault: false } });
    await prisma.productVariant.create({ data: { productId: v.productId, sku: 'VAR-1-B', variantName: 'Big', unit: 'G', unitValue: 500, isDefault: true, status: 'ACTIVE' } });
    await processImport(job.id);
    expect((await getRows(seller.token, job.id, 'FAILED'))[0]!.errors[0]!.message).toMatch(/now has several variants/);
    expect((await prisma.sellerListing.findFirstOrThrow({ where: { variantId: v.id } })).pricePaise).toBe(1800);
  });
});

describe('worker lifecycle', () => {
  it('an import that keeps failing is not resumed forever: past the attempt limit it fails for good', async () => {
    const seller = await seedSeller('9400000923');
    const job = await preview(seller.token, [HEADER, row('AT-1')].join('\n'));
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'QUEUED', attempts: 5 } });
    await processImport(job.id); // attempt 6
    const failed = await prisma.productImport.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.errorSummary).toMatch(/could not be finished after several attempts/);
    expect(await prisma.product.count()).toBe(0);
    // An explicit retry starts afresh.
    await as(seller.token).post(`/seller/imports/${job.id}/retry`).expect(200);
    await importQueuesIdle();
    expect(await getJob(seller.token, job.id)).toMatchObject({ status: 'COMPLETED', createdCount: 1 });
  });

  it('once an import has started, preview decisions and mode switches are refused and its rows are never rewritten', async () => {
    const seller = await seedSeller('9400000924');
    const job = await preview(seller.token, [HEADER, row('PL-1'), row('PL-2')].join('\n'));
    const [first] = await getRows(seller.token, job.id);
    await queue(job.id); // started (processing not run yet)
    await as(seller.token).patch(`/seller/imports/${job.id}/rows/${first!.id}`, { excluded: true }).expect(409);
    await as(seller.token).post(`/seller/imports/${job.id}/mode`, { mode: 'UPDATE' }).expect(409);
    expect((await getRows(seller.token, job.id)).map((r) => r.status)).toEqual(['READY', 'READY']);

    // A re-check never rewrites a row that was already processed.
    const other = await preview(seller.token, [HEADER, row('PL-3'), row('PL-4')].join('\n'));
    const [done] = await getRows(seller.token, other.id);
    await prisma.productImportRow.update({ where: { id: done!.id }, data: { status: 'DONE' } });
    await as(seller.token).post(`/seller/imports/${other.id}/mode`, { mode: 'UPDATE' }).expect(200);
    expect((await prisma.productImportRow.findUniqueOrThrow({ where: { id: done!.id } })).status).toBe('DONE');
  });

  it('concurrent confirm clicks start the import exactly once', async () => {
    const seller = await seedSeller('9400000925');
    const job = await preview(seller.token, [HEADER, ...Array.from({ length: 30 }, (_, i) => row(`CC-${i}`))].join('\n'));
    const results = await Promise.all(Array.from({ length: 4 }, () => as(seller.token).post(`/seller/imports/${job.id}/confirm`, { mode: 'CREATE' })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    await importQueuesIdle();
    expect(await prisma.productVariant.count({ where: { sku: { startsWith: 'CC-' } } })).toBe(30);
    expect(await prisma.auditLog.count({ where: { entityId: job.id, action: 'product_import.confirm' } })).toBe(1);
  });
});
