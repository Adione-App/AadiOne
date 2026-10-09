/**
 * Bulk product import, end to end: real app, real database, local storage.
 * Upload -> background analysis -> preview -> confirm -> background import
 * -> results, for product files (CSV / .xlsx + image ZIP) and photos-only
 * uploads; plus isolation, unsafe files, retries and idempotency.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, UserRole, type ProductImportDto, type ProductImportRowDto, type ProductImportRowPageDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { makeXlsx, makeZip } from '../helpers/zip';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import { storage, storageKeyFromUrl } from '../../src/infra/storage';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { importQueuesIdle, runProductImportWorker } from '../../src/modules/product-import/import-worker';
import { processImport } from '../../src/modules/product-import/import-processing';

const ADMIN = { email: 'import-admin@adione.test', password: 'TestAdmin@123' };

interface Seller {
  id: string;
  token: string;
}

async function loginAdmin(): Promise<string> {
  await prisma.user.create({ data: { mobile: '9400000801', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN } });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

/** An ACTIVE grocery seller with Cold Drinks › Energy Drinks and Snacks. */
async function seedSeller(mobile: string, name = `Kirana ${mobile}`): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
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
  const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await as(token).post('/seller/categories', { name: 'Cold Drinks' }).expect(201)).body).data;
  const cold = tree.categories.find((c) => c.name === 'Cold Drinks')!.id;
  await as(token).post('/seller/subcategories', { parentId: cold, name: 'Energy Drinks' }).expect(201);
  await as(token).post('/seller/categories', { name: 'Snacks' }).expect(201);
  return { id: seller.id, token };
}

const jpeg = (w = 900, h = 900, color = '#c62828') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
const png = (color = '#1565c0') => sharp({ create: { width: 600, height: 600, channels: 3, background: color } }).png().toBuffer();

const HEADER = 'seller_sku,barcode,product_name,category,subcategory,brand,mrp,selling_price,stock_quantity,unit,unit_value,variant_name,image_filename,additional_image_filenames,hindi_name,is_active';
const line = (cells: (string | number)[]) => cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',');

function uploadProducts(token: string, csv: string | Buffer, opts: { zip?: Buffer; mode?: 'CREATE' | 'UPDATE'; name?: string } = {}) {
  let req = api()
    .post('/api/v1/seller/imports')
    .set('Authorization', bearer(token))
    .field('mode', opts.mode ?? 'CREATE')
    .attach('file', Buffer.isBuffer(csv) ? csv : Buffer.from(csv, 'utf8'), opts.name ?? 'products.csv');
  if (opts.zip) req = req.attach('archive', opts.zip, 'photos.zip');
  return req;
}

async function analysed(token: string, res: { status: number; body: unknown }): Promise<ProductImportDto> {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const job = expectSuccess<ProductImportDto>(res.body).data;
  expect(job.status).toBe('ANALYZING');
  await importQueuesIdle();
  return expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${job.id}`).expect(200)).body).data;
}

async function rows(token: string, id: string, filter = 'ALL'): Promise<ProductImportRowDto[]> {
  return expectSuccess<ProductImportRowPageDto>((await as(token).get(`/seller/imports/${id}/rows?filter=${filter}&pageSize=100`).expect(200)).body).data.items;
}

async function confirm(token: string, job: ProductImportDto): Promise<ProductImportDto> {
  await as(token).post(`/seller/imports/${job.id}/confirm`, { mode: job.mode }).expect(200);
  await importQueuesIdle();
  return expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${job.id}`).expect(200)).body).data;
}

async function isWebp(url: string) {
  const key = storageKeyFromUrl(url);
  expect(key).toBeTruthy();
  const bytes = await storage.get(key!, 20 * 1024 * 1024);
  expect(bytes).not.toBeNull();
  return (await sharp(bytes!).metadata()).format === 'webp';
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

/* -------------------------------------------------------------------------- */

describe('product file + image ZIP (CREATE)', () => {
  it('previews, then creates pending products with WebP galleries, listings and opening stock', async () => {
    const seller = await seedSeller('9400000811');
    const brand = await prisma.brand.create({ data: { name: 'Red Bull', slug: 'red-bull' } });
    const csv = [
      HEADER,
      line(['RB-250', '9002490100070', 'Red Bull Energy Drink 250 ml', 'Cold Drinks', 'Energy Drinks', 'red bull', '125', '120', '48', 'ml', '250', '', 'RB-250.jpg', '', 'रेड बुल', 'yes']),
      line(['BIS-100', '', 'Glucose Biscuits 100 g', 'snacks', '', 'Unknown Co', '10', '10', '0', 'g', '100', '100 g pack', 'BIS-100.jpg', '', '', '']),
      line(['OIL-1L', '', 'Mustard Oil 1 L', 'Snacks', '', '', '199.50', '185', '12', 'L', '1', '', 'OIL-1L-front.webp', 'OIL-1L-back.webp', '', 'no']),
    ].join('\r\n');
    const zip = makeZip([
      { name: 'catalogue/RB-250.jpg', data: await jpeg(2000, 2000) },
      { name: 'catalogue/BIS-100.jpg', data: await jpeg(500, 500, '#2e7d32') },
      { name: 'catalogue/OIL-1L-front.webp', data: await sharp(await png()).webp().toBuffer() },
      { name: 'catalogue/OIL-1L-back.webp', data: await sharp(await png('#6a1b9a')).webp().toBuffer() },
      { name: 'catalogue/unused.png', data: await png('#000000') },
    ]);

    const job = await analysed(seller.token, await uploadProducts(seller.token, csv, { zip }));
    expect(job).toMatchObject({ status: 'READY', totalRows: 3, readyRows: 3, invalidRows: 0, warningRows: 1, imageCount: 4 });
    const preview = await rows(seller.token, job.id);
    expect(preview.map((r) => [r.rowNumber, r.status, r.sku])).toEqual([
      [2, 'READY', 'RB-250'],
      [3, 'READY', 'BIS-100'],
      [4, 'READY', 'OIL-1L'],
    ]);
    expect(preview[1]!.warnings[0]!.message).toMatch(/Brand "Unknown Co" is not in Aadione's brand list/);
    expect(preview[2]!.images.map((i) => [i.fileName, i.status])).toEqual([
      ['OIL-1L-front.webp', 'READY'],
      ['OIL-1L-back.webp', 'READY'],
    ]);
    const unused = expectSuccess<{ fileName: string }[]>((await as(seller.token).get(`/seller/imports/${job.id}/images?status=UNUSED`).expect(200)).body).data;
    expect(unused.map((i) => i.fileName)).toEqual(['unused.png']);
    // Nothing is created before confirmation.
    expect(await prisma.product.count()).toBe(0);

    // Change the main photo of the oil before importing.
    await as(seller.token).patch(`/seller/imports/${job.id}/rows/${preview[2]!.id}`, { primaryImage: 'OIL-1L-back.webp' }).expect(200);

    const done = await confirm(seller.token, job);
    expect(done).toMatchObject({ status: 'COMPLETED', createdCount: 3, failedCount: 0, skippedCount: 0 });

    const rb = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'RB-250' }, include: { product: { include: { images: { orderBy: { displayOrder: 'asc' } } } }, sellerListings: true } });
    expect(rb).toMatchObject({ barcode: '9002490100070', unit: 'ML', unitValue: 250, variantName: '250 ml', isDefault: true });
    expect(rb.product).toMatchObject({ name: 'Red Bull Energy Drink 250 ml', nameHi: 'रेड बुल', brandId: brand.id, approvalStatus: 'PENDING', submittedBySellerId: seller.id, status: 'ACTIVE' });
    expect(rb.sellerListings[0]).toMatchObject({ sellerId: seller.id, mrpPaise: 12500, pricePaise: 12000, stockQty: 48, tracksStock: true });
    expect(await prisma.stockLedger.count({ where: { sellerListingId: rb.sellerListings[0]!.id, delta: 48, reason: 'PURCHASE' } })).toBe(1);
    expect(rb.product.images).toHaveLength(1);
    expect(rb.product.images[0]!.url).toMatch(/\.webp$/);
    expect(await isWebp(rb.product.images[0]!.url)).toBe(true);
    expect(await isWebp(rb.product.images[0]!.thumbUrl!)).toBe(true); // 2000px -> card thumbnail too

    const bis = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'BIS-100' }, include: { product: true, sellerListings: true } });
    expect(bis.product.brandId).toBeNull();
    expect(bis.sellerListings[0]!.stockQty).toBe(0);
    expect(await prisma.stockLedger.count({ where: { sellerListingId: bis.sellerListings[0]!.id } })).toBe(0);

    const oil = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'OIL-1L' }, include: { product: { include: { images: { orderBy: { displayOrder: 'asc' } } } }, sellerListings: true } });
    expect(oil.product.status).toBe('INACTIVE'); // is_active = no
    expect(oil.sellerListings[0]!.mrpPaise).toBe(19950);
    const oilImages = await prisma.productImportImage.findMany({ where: { importId: job.id, nameKey: { in: ['oil-1l-back.webp', 'oil-1l-front.webp'] } }, orderBy: { nameKey: 'asc' } });
    expect(oil.product.images.map((i) => i.url)).toEqual([oilImages[0]!.url, oilImages[1]!.url]); // back is main

    // The unused archive file was never stored; rows report the products.
    expect((await rows(seller.token, job.id, 'DONE')).every((r) => r.productId)).toBe(true);

    // The existing product list and detail show them (with images), pending approval.
    const list = expectSuccess<{ id: string; name: string }[]>((await as(seller.token).get('/seller/products').expect(200)).body).data;
    expect(list.map((p) => p.name).sort()).toEqual(['Glucose Biscuits 100 g', 'Mustard Oil 1 L', 'Red Bull Energy Drink 250 ml']);
    const detail = expectSuccess<{ images: { url: string }[] }>((await as(seller.token).get(`/seller/products/${rb.productId}`).expect(200)).body).data;
    expect(detail.images[0]!.url).toBe(rb.product.images[0]!.url);

    // Customers see nothing before approval; after it, the product with its image.
    await api().get(`/api/v1/products/${rb.productId}`).expect(404);
    const admin = await loginAdmin();
    const batch = expectSuccess<{ id: string }>((await as(seller.token).post(`/seller/imports/${job.id}/submit-for-approval`).expect(201)).body).data;
    await as(seller.token).post(`/seller/imports/${job.id}/submit-for-approval`).expect(400); // already submitted
    await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);
    const customer = expectSuccess<{ images: { url: string }[] }>((await api().get(`/api/v1/products/${rb.productId}`).expect(200)).body).data;
    expect(customer.images[0]!.url).toBe(rb.product.images[0]!.url);
  });

  it('reports every problem per row, never imports a bad row, and gives a safe error report', async () => {
    const seller = await seedSeller('9400000812');
    const other = await seedSeller('9400000813');
    await analysed(other.token, await uploadProducts(other.token, [HEADER, line(['THEIRS-1', '', 'Their product', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', '', '', '', ''])].join('\n'))).then((j) => confirm(other.token, j));
    // An own product already there.
    await analysed(seller.token, await uploadProducts(seller.token, [HEADER, line(['MINE-1', '', 'Mine', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', '', '', '', ''])].join('\n'))).then((j) => confirm(seller.token, j));

    const csv = [
      HEADER,
      line(['OK-1', '', 'Valid chips', 'Snacks', '', '', '20', '18', '10', 'g', '50', '', '', '', '', '']),
      line(['PRICE-1', '', 'Too expensive', 'Snacks', '', '', '10', '12', '5', 'g', '50', '', '', '', '', '']),
      line(['CAT-1', '', 'Bad category', 'Fresh Vegetables', '', '', '10', '9', '5', 'kg', '1', '', '', '', '', '']),
      line(['IMG-1', '', 'Missing image', 'Snacks', '', '', '10', '9', '5', 'g', '50', '', 'nope.jpg', '', '', '']),
      line(['COMMA-1', '', 'Comma price', 'Snacks', '', '', '1,200', '1100', '5', 'g', '50', '', '', '', '', '']),
      line(['STOCK-1', '', 'No stock', 'Snacks', '', '', '10', '9', '', 'g', '50', '', '', '', '', '']),
      line(['OK-1', '', 'Duplicate of row 2', 'Snacks', '', '', '20', '18', '10', 'g', '50', '', '', '', '', '']),
      line(['UNIT-1', '8.90106E+12', 'Bad unit', 'Snacks', '', '', '10', '9', '5', 'crate', '1', '', '', '', '', '']),
      line(['MINE-1', '', 'Mine again', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', '', '', '', '']),
      line(['THEIRS-1', '', 'Their SKU', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', '', '', '', '']),
      line(['FORMULA-1', '', '=HYPERLINK("http://evil.test")', 'Nope', '', '', '10', '9', '1', 'g', '50', '', '', '', '', '']),
    ].join('\n');
    const job = await analysed(seller.token, await uploadProducts(seller.token, csv));
    expect(job).toMatchObject({ status: 'READY', totalRows: 11, readyRows: 1, duplicateRows: 1, conflictRows: 1, invalidRows: 8 });
    const byRow = new Map((await rows(seller.token, job.id)).map((r) => [r.rowNumber, r]));
    const msg = (n: number) => byRow.get(n)!.errors.map((e) => e.message).join(' | ');
    expect(byRow.get(2)!.status).toBe('READY');
    expect(msg(3)).toMatch(/Selling price cannot exceed MRP/);
    expect(msg(4)).toMatch(/Category "Fresh Vegetables" does not exist or is not available to this seller/);
    expect(msg(5)).toMatch(/no ZIP of images was uploaded/);
    expect(msg(6)).toMatch(/without commas/);
    expect(msg(7)).toMatch(/Stock quantity is required/);
    expect(byRow.get(8)!.status).toBe('DUPLICATE');
    expect(msg(8)).toMatch(/Same SKU as row 2/);
    expect(msg(9)).toMatch(/scientific format/);
    expect(msg(9)).toMatch(/Unit "crate" is not supported/);
    expect(byRow.get(10)!.status).toBe('CONFLICT');
    expect(msg(10)).toMatch(/already have a product with SKU MINE-1.*Update mode/);
    expect(msg(11)).toMatch(/SKU THEIRS-1 is already used by another product/);

    // The report: original cells + reasons, formula neutralised, ready rows left out.
    const report = await as(seller.token).get(`/seller/imports/${job.id}/error-report.csv`).expect(200);
    expect(report.headers['content-type']).toMatch(/text\/csv/);
    const text = report.text.replace(/^﻿/, '');
    expect(text.split('\r\n')[0]).toBe(`${HEADER},source_row,import_status,import_problems`);
    expect(text).toContain('Row 3: Selling price cannot exceed MRP.');
    expect(text).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
    expect(text).not.toContain('Valid chips');

    const done = await confirm(seller.token, job);
    expect(done).toMatchObject({ status: 'COMPLETED', createdCount: 1, failedCount: 8, skippedCount: 2 });
    expect(await prisma.productVariant.count({ where: { sku: { in: ['PRICE-1', 'CAT-1', 'IMG-1', 'COMMA-1', 'STOCK-1', 'UNIT-1', 'FORMULA-1'] } } })).toBe(0);
    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id } })).toBe(2);
  });

  it('refuses unusable files up front or as a failed check', async () => {
    const seller = await seedSeller('9400000814');
    // Missing required columns.
    const missing = await analysed(seller.token, await uploadProducts(seller.token, 'seller_sku,product_name\nA-1,Thing\n'));
    expect(missing).toMatchObject({ status: 'FAILED' });
    expect(missing.errorSummary).toMatch(/Required columns are missing: category, mrp, selling_price, stock_quantity, unit, unit_value/);
    // Not UTF-8.
    const latin = await analysed(seller.token, await uploadProducts(seller.token, Buffer.concat([Buffer.from(`${HEADER}\nA-1,,Caf`), Buffer.from([0xe9]), Buffer.from(',Snacks\n')])));
    expect(latin.errorSummary).toMatch(/UTF-8/);
    // Header only.
    expect((await analysed(seller.token, await uploadProducts(seller.token, `${HEADER}\n`))).errorSummary).toMatch(/no products/);
    // A fake .xlsx and an executable "csv" with the wrong extension are refused at upload.
    expect(expectError((await uploadProducts(seller.token, 'just text', { name: 'products.xlsx' }).expect(415)).body).code).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE);
    await uploadProducts(seller.token, 'MZ', { name: 'products.exe' }).expect(415);
    // A product file over 10 MB.
    await uploadProducts(seller.token, `${HEADER}\n${'x'.repeat(10 * 1024 * 1024 + 10)}`).expect(413);
    // A "zip" that is not one.
    await api().post('/api/v1/seller/imports').set('Authorization', bearer(seller.token)).attach('file', Buffer.from(`${HEADER}\n`), 'p.csv').attach('archive', Buffer.from('MZ not a zip'), 'photos.zip').expect(415);
    expect(await prisma.product.count()).toBe(0);
  });

  it('reads Excel (.xlsx) files', async () => {
    const seller = await seedSeller('9400000815');
    const header = HEADER.split(',');
    const job = await analysed(
      seller.token,
      await uploadProducts(
        seller.token,
        makeXlsx([header, ['XL-1', 8901058851298, 'Excel Namkeen', 'Snacks', '', '', 49.900000000000006, 45, 30, 'g', 200, '', '', '', 'नमकीन', 'yes']]),
        { name: 'products.xlsx' },
      ),
    );
    expect(job).toMatchObject({ status: 'READY', readyRows: 1 });
    await confirm(seller.token, job);
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'XL-1' }, include: { sellerListings: true, product: true } });
    expect(v.barcode).toBe('8901058851298');
    expect(v.sellerListings[0]).toMatchObject({ mrpPaise: 4990, pricePaise: 4500, stockQty: 30 });
    expect(v.product.nameHi).toBe('नमकीन');
  });

  it('unsafe or unusable archive contents never become product images', async () => {
    const seller = await seedSeller('9400000816');
    const csv = [
      HEADER,
      line(['EXE-1', '', 'Disguised exe', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', 'virus.jpg', '', '', '']),
      line(['BOMB-1', '', 'Bomb', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', 'bomb.jpg', '', '', '']),
      line(['DUP-1', '', 'Same name twice', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', 'same.jpg', '', '', '']),
    ].join('\n');
    const zip = makeZip([
      { name: 'virus.jpg', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 0x90)]), store: true },
      { name: 'bomb.jpg', data: Buffer.alloc(4 * 1024 * 1024, 0) },
      { name: 'a/same.jpg', data: await jpeg() },
      { name: 'b/same.jpg', data: await jpeg() },
    ]);
    const job = await analysed(seller.token, await uploadProducts(seller.token, csv, { zip }));
    const byRow = new Map((await rows(seller.token, job.id)).map((r) => [r.rowNumber, r.errors.map((e) => e.message).join(' ')]));
    expect(byRow.get(2)).toMatch(/Image virus\.jpg cannot be used/);
    expect(byRow.get(3)).toMatch(/Image bomb\.jpg cannot be used: (is larger than 5 MB|looks like a compressed bomb)/);
    expect(byRow.get(4)).toMatch(/more than one file named same\.jpg/);
    expect(job.readyRows).toBe(0);

    // A path-traversal archive is refused as a whole.
    const evil = makeZip([{ name: '../../../tmp/evil.jpg', data: await jpeg() }]);
    const refused = await analysed(seller.token, await uploadProducts(seller.token, csv, { zip: evil }));
    expect(refused).toMatchObject({ status: 'FAILED' });
    expect(refused.errorSummary).toMatch(/unsafe or damaged/);
  });
});

/* -------------------------------------------------------------------------- */

describe('UPDATE mode, mode switch, isolation', () => {
  it('updates only filled-in cells of own products, with ledgered stock', async () => {
    const seller = await seedSeller('9400000821');
    const other = await seedSeller('9400000822');
    await analysed(
      seller.token,
      await uploadProducts(
        seller.token,
        [
          HEADER,
          line(['UP-1', '', 'Cola 600 ml', 'Cold Drinks', '', '', '40', '38', '10', 'ml', '600', '', '', '', '', '']),
          line(['UP-2', '1234567890128', 'Soda 750 ml', 'Cold Drinks', '', '', '30', '28', '6', 'ml', '750', '', '', '', '', '']),
        ].join('\n'),
      ),
    ).then((j) => confirm(seller.token, j));
    await analysed(other.token, await uploadProducts(other.token, [HEADER, line(['OTHER-1', '', 'Other seller item', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', '', '', '', ''])].join('\n'))).then((j) =>
      confirm(other.token, j),
    );

    const csv = [
      'seller_sku,barcode,selling_price,stock_quantity,product_name,is_active',
      'UP-1,,35,25,,no',
      ',1234567890128,,,Soda 750 ml (new pack),',
      'OTHER-1,,5,,,',
      'NOPE-1,,5,,,',
      ',1234567890128,27,,,',
    ].join('\n');
    const job = await analysed(seller.token, await uploadProducts(seller.token, csv, { mode: 'UPDATE' }));
    const byRow = new Map((await rows(seller.token, job.id)).map((r) => [r.rowNumber, r]));
    expect(byRow.get(2)!.status).toBe('READY');
    expect(byRow.get(3)).toMatchObject({ status: 'READY', sku: 'UP-2' }); // matched by barcode alone
    // Another seller's SKU looks exactly like a missing one.
    expect(byRow.get(4)!.errors[0]!.message).toBe('None of your products has SKU OTHER-1.');
    expect(byRow.get(5)!.errors[0]!.message).toBe('None of your products has SKU NOPE-1.');
    // Two rows for the same product: the later one is a duplicate, never applied.
    expect(byRow.get(6)).toMatchObject({ status: 'DUPLICATE', sku: 'UP-2' });

    const done = await confirm(seller.token, job);
    expect(done).toMatchObject({ status: 'COMPLETED', updatedCount: 2, failedCount: 2, skippedCount: 1 });
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'UP-1' }, include: { product: true, sellerListings: true } });
    expect(v.sellerListings[0]).toMatchObject({ mrpPaise: 4000, pricePaise: 3500, stockQty: 25 }); // MRP untouched
    expect(v.product).toMatchObject({ name: 'Cola 600 ml', status: 'INACTIVE' });
    expect(await prisma.stockLedger.count({ where: { sellerListingId: v.sellerListings[0]!.id } })).toBe(2); // opening + adjustment
    const soda = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'UP-2' }, include: { product: true, sellerListings: true } });
    expect(soda.product.name).toBe('Soda 750 ml (new pack)');
    expect(soda.sellerListings[0]).toMatchObject({ pricePaise: 2800, stockQty: 6 }); // duplicate row's 27 not applied
    const theirs = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'OTHER-1' }, include: { sellerListings: true } });
    expect(theirs.sellerListings[0]!.pricePaise).toBe(900);
  });

  it('existing SKUs in CREATE mode need a decision; switching to UPDATE re-checks the preview', async () => {
    const seller = await seedSeller('9400000823');
    const csv = [HEADER, line(['SW-1', '', 'Switch me', 'Snacks', '', '', '30', '25', '5', 'g', '100', '', '', '', '', ''])].join('\n');
    await analysed(seller.token, await uploadProducts(seller.token, csv)).then((j) => confirm(seller.token, j));
    const again = await analysed(seller.token, await uploadProducts(seller.token, csv.replace('25,5', '20,7')));
    expect(again).toMatchObject({ readyRows: 0, conflictRows: 1 });
    await as(seller.token).post(`/seller/imports/${again.id}/confirm`, { mode: 'CREATE' }).expect(400); // nothing ready
    const switched = expectSuccess<ProductImportDto>((await as(seller.token).post(`/seller/imports/${again.id}/mode`, { mode: 'UPDATE' }).expect(200)).body).data;
    expect(switched).toMatchObject({ mode: 'UPDATE', readyRows: 1, conflictRows: 0 });
    // The mode the seller confirms must be the one previewed.
    await as(seller.token).post(`/seller/imports/${again.id}/confirm`, { mode: 'CREATE' }).expect(409);
    const done = await confirm(seller.token, switched);
    expect(done.updatedCount).toBe(1);
    expect(await prisma.productVariant.count({ where: { sku: 'SW-1' } })).toBe(1);
    const listing = await prisma.sellerListing.findFirstOrThrow({ where: { variant: { sku: 'SW-1' } } });
    expect(listing).toMatchObject({ pricePaise: 2000, stockQty: 7 });
  });

  it('only the owning seller (and admins, read-only) can see or act on an import', async () => {
    const a = await seedSeller('9400000824');
    const b = await seedSeller('9400000825');
    const job = await analysed(a.token, await uploadProducts(a.token, [HEADER, line(['ISO-1', '', 'Isolated', 'Snacks', '', '', '10', '9', '1', 'g', '50', '', '', '', '', ''])].join('\n')));

    for (const [method, p] of [
      ['get', `/seller/imports/${job.id}`],
      ['get', `/seller/imports/${job.id}/rows`],
      ['get', `/seller/imports/${job.id}/error-report.csv`],
      ['post', `/seller/imports/${job.id}/confirm`],
      ['post', `/seller/imports/${job.id}/cancel`],
    ] as const) {
      const res = method === 'get' ? await as(b.token).get(p) : await as(b.token).post(p, { mode: 'CREATE' });
      expect({ p, status: res.status }).toEqual({ p, status: 404 });
    }
    const listB = expectSuccess<{ items: unknown[] }>((await as(b.token).get('/seller/imports').expect(200)).body).data;
    expect(listB.items).toHaveLength(0);

    // No session, a customer, and a seller's customer-app (OTP) session: refused.
    await api().get('/api/v1/seller/imports').expect(401);
    await otpService.clearOtpState('9400000824');
    const sent = await api().post('/api/v1/auth/send-otp').send({ mobile: '9400000824' }).expect(200);
    const otp = expectSuccess<{ devOtp: string }>(sent.body).data.devOtp;
    const otpToken = expectSuccess<{ tokens: { accessToken: string } }>((await api().post('/api/v1/auth/verify-otp').send({ mobile: '9400000824', otp }).expect(200)).body).data.tokens.accessToken;
    expect((await as(otpToken).get('/seller/imports')).status).toBe(403);
    expect((await uploadProducts(otpToken, `${HEADER}\n`)).status).toBe(403);

    // Admins read any seller's imports, but cannot run one.
    const admin = await loginAdmin();
    const adminList = expectSuccess<{ items: { id: string }[] }>((await as(admin).get(`/admin/sellers/${a.id}/product-imports`).expect(200)).body).data;
    expect(adminList.items.map((i) => i.id)).toEqual([job.id]);
    await as(admin).get(`/admin/product-imports/${job.id}/rows`).expect(200);
    expect((await as(admin).post(`/seller/imports/${job.id}/confirm`, { mode: 'CREATE' })).status).toBeGreaterThanOrEqual(400);

    // Still waiting: nothing was imported by anyone.
    expect(expectSuccess<ProductImportDto>((await as(a.token).get(`/seller/imports/${job.id}`).expect(200)).body).data.status).toBe('READY');
    expect(await prisma.product.count()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('photos-only upload', () => {
  it('matches by SKU, barcode and photo suffix; unmatched photos are assigned by hand', async () => {
    const seller = await seedSeller('9400000831');
    await analysed(
      seller.token,
      await uploadProducts(
        seller.token,
        [
          HEADER,
          line(['RB-250', '', 'Red Bull', 'Cold Drinks', '', '', '125', '120', '10', 'ml', '250', '', '', '', '', '']),
          line(['OIL-1L', '8901058851298', 'Mustard Oil', 'Snacks', '', '', '200', '185', '10', 'L', '1', '', '', '', '', '']),
          line(['NAMKEEN-200', '', 'Namkeen', 'Snacks', '', '', '50', '45', '10', 'g', '200', '', '', '', '', '']),
        ].join('\n'),
      ),
    ).then((j) => confirm(seller.token, j));

    const zip = makeZip([
      { name: 'RB-250.jpg', data: await jpeg() },
      { name: '8901058851298.png', data: await png() },
      { name: 'OIL-1L-back.webp', data: await sharp(await png('#ff6f00')).webp().toBuffer() },
      { name: 'mystery.jpg', data: await jpeg(700, 700, '#000000') },
      { name: 'notes.txt', data: 'hello' },
    ]);
    const res = await api().post('/api/v1/seller/imports/images').set('Authorization', bearer(seller.token)).attach('archive', zip, 'photos.zip');
    const job = await analysed(seller.token, res);
    expect(job).toMatchObject({ kind: 'IMAGES', status: 'READY', readyRows: 3 });
    const list = await rows(seller.token, job.id);
    const byFile = new Map(list.map((r) => [r.images[0]!.fileName, r]));
    expect(byFile.get('RB-250.jpg')).toMatchObject({ status: 'READY', sku: 'RB-250' });
    expect(byFile.get('8901058851298.png')).toMatchObject({ status: 'READY', sku: 'OIL-1L' });
    expect(byFile.get('OIL-1L-back.webp')).toMatchObject({ status: 'READY', sku: 'OIL-1L' });
    expect(byFile.get('mystery.jpg')).toMatchObject({ status: 'CONFLICT' });
    expect(byFile.get('notes.txt')!.status).toBe('INVALID');

    // Assign the unmatched photo; a wrong SKU is reported, a right one is accepted.
    const mystery = byFile.get('mystery.jpg')!;
    expect(expectSuccess<ProductImportRowDto>((await as(seller.token).patch(`/seller/imports/${job.id}/rows/${mystery.id}`, { sku: 'WRONG-1' }).expect(200)).body).data.status).toBe('INVALID');
    const assigned = expectSuccess<ProductImportRowDto>((await as(seller.token).patch(`/seller/imports/${job.id}/rows/${mystery.id}`, { sku: 'namkeen-200', makePrimary: true }).expect(200)).body).data;
    expect(assigned).toMatchObject({ status: 'READY', sku: 'NAMKEEN-200', makePrimary: true });

    const done = await confirm(seller.token, job);
    expect(done).toMatchObject({ status: 'COMPLETED', updatedCount: 4 });
    const oil = await prisma.product.findFirstOrThrow({ where: { variants: { some: { sku: 'OIL-1L' } } }, include: { images: { orderBy: { displayOrder: 'asc' } } } });
    expect(oil.images).toHaveLength(2);
    for (const image of oil.images) expect(await isWebp(image.url)).toBe(true);

    // A second confirm (double click / other tab) changes nothing.
    await as(seller.token).post(`/seller/imports/${job.id}/confirm`, { mode: 'UPDATE' }).expect(200);
    await importQueuesIdle();
    expect(await prisma.productImage.count()).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */

describe('interruption, retries and scale', () => {
  it('a row that fails to save is retried without repeating the rows that worked', async () => {
    const seller = await seedSeller('9400000841');
    const csv = [HEADER, ...['R-1', 'R-2', 'R-3'].map((sku) => line([sku, '', `Item ${sku}`, 'Snacks', '', '', '10', '9', '2', 'g', '50', '', '', '', '', '']))].join('\n');
    const job = await analysed(seller.token, await uploadProducts(seller.token, csv));
    // Between preview and import, R-2 gets taken by a product added by hand.
    const snacks = (await prisma.category.findFirstOrThrow({ where: { sellerId: seller.id, name: 'Snacks' } })).id;
    const manual = expectSuccess<{ id: string }>(
      (await as(seller.token).post('/seller/products', { categoryId: snacks, name: 'Hand added', sku: 'R-2', variantName: '1 pc', unit: 'PIECE', unitValue: 1, mrpPaise: 1000, pricePaise: 900, stockQty: 1 }).expect(201)).body,
    ).data;

    const first = await confirm(seller.token, job);
    expect(first).toMatchObject({ status: 'COMPLETED', createdCount: 2, failedCount: 1 });
    const failed = await rows(seller.token, job.id, 'FAILED');
    expect(failed.map((r) => [r.sku, r.errors[0]!.message])).toEqual([['R-2', expect.stringMatching(/SKU R-2 was taken by another product/)]]);

    // Free the SKU (the hand-added product is renamed), then retry: only R-2 runs.
    await as(seller.token).patch(`/seller/products/${manual.id}`, { sku: 'HAND-1' }).expect(200);
    await as(seller.token).post(`/seller/imports/${job.id}/retry`).expect(200);
    await importQueuesIdle();
    const second = expectSuccess<ProductImportDto>((await as(seller.token).get(`/seller/imports/${job.id}`).expect(200)).body).data;
    expect(second).toMatchObject({ status: 'COMPLETED', createdCount: 3, failedCount: 0 });
    expect(await prisma.productVariant.count({ where: { sku: { in: ['R-1', 'R-2', 'R-3'] } } })).toBe(3);
    await as(seller.token).post(`/seller/imports/${job.id}/retry`).expect(400); // nothing left to retry
  });

  it('an import whose worker died is resumed, and re-processing never duplicates', async () => {
    const seller = await seedSeller('9400000842');
    const csv = [HEADER, ...Array.from({ length: 120 }, (_, i) => line([`CR-${i}`, '', `Crash item ${i}`, 'Snacks', '', '', '10', '9', '1', 'g', '50', '', '', '', '', '']))].join('\n');
    const job = await analysed(seller.token, await uploadProducts(seller.token, csv));
    // Simulate a crash after the first batch: 50 rows done, the job "PROCESSING" with a dead heartbeat.
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'QUEUED' } });
    const rowsToDo = await prisma.productImportRow.findMany({ where: { importId: job.id }, orderBy: { rowNumber: 'asc' }, take: 50 });
    // Process just those 50 through the real path, then "die".
    await prisma.productImportRow.updateMany({ where: { importId: job.id, id: { notIn: rowsToDo.map((r) => r.id) } }, data: { status: 'EXCLUDED' } });
    await processImport(job.id);
    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id } })).toBe(50);
    await prisma.productImportRow.updateMany({ where: { importId: job.id, status: 'EXCLUDED' }, data: { status: 'READY' } });
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'PROCESSING', heartbeatAt: new Date(Date.now() - 10 * 60_000), completedAt: null } });

    await runProductImportWorker();
    await importQueuesIdle();
    const resumed = expectSuccess<ProductImportDto>((await as(seller.token).get(`/seller/imports/${job.id}`).expect(200)).body).data;
    expect(resumed).toMatchObject({ status: 'COMPLETED', createdCount: 120, failedCount: 0 });
    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id } })).toBe(120);

    // Running it again (another worker, a stray re-queue) adds nothing.
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'QUEUED' } });
    await processImport(job.id);
    await processImport(job.id);
    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id } })).toBe(120);
  });

  it('a 5000-row file: bounded memory and batches, measured', async () => {
    const seller = await seedSeller('9400000843');
    const csv = [HEADER, ...Array.from({ length: 5000 }, (_, i) => line([`BIG-${i}`, '', `Bulk item ${i}`, i % 2 ? 'Snacks' : 'Cold Drinks', '', '', '20', '18', String(i % 50), 'g', '100', '', '', '', '', '']))].join('\n');
    const t0 = Date.now();
    const job = await analysed(seller.token, await uploadProducts(seller.token, csv));
    const analysedMs = Date.now() - t0;
    expect(job).toMatchObject({ status: 'READY', totalRows: 5000, readyRows: 5000 });
    const t1 = Date.now();
    const done = await confirm(seller.token, job);
    const importedMs = Date.now() - t1;
    expect(done).toMatchObject({ status: 'COMPLETED', createdCount: 5000, failedCount: 0 });
    expect(await prisma.productVariant.count({ where: { sku: { startsWith: 'BIG-' } } })).toBe(5000);
    // Row 5002 would be over the limit.
    const tooMany = await analysed(seller.token, await uploadProducts(seller.token, `${csv}\n${line(['BIG-X', '', 'One too many', 'Snacks', '', '', '20', '18', '1', 'g', '100', '', '', '', '', ''])}`));
    expect(tooMany.errorSummary).toMatch(/more than 5000 product rows/);
    console.info(`[perf] 5000-row CSV: analysis ${analysedMs} ms, import ${importedMs} ms`);
  }, 600_000);
});

describe('image throughput', () => {
  it('300 products with one 1200 px photo each: measured', async () => {
    const seller = await seedSeller('9400000844');
    const photo = await jpeg(1200, 1200, '#00897b');
    const entries = await Promise.all(
      Array.from({ length: 300 }, async (_, i) => ({ name: `IMG-${i}.jpg`, data: await sharp(photo).modulate({ hue: i }).jpeg().toBuffer(), store: true })),
    );
    const csv = [HEADER, ...Array.from({ length: 300 }, (_, i) => line([`IMG-${i}`, '', `Photo item ${i}`, 'Snacks', '', '', '20', '18', '5', 'g', '100', '', `IMG-${i}.jpg`, '', '', '']))].join('\n');
    const t0 = Date.now();
    const job = await analysed(seller.token, await uploadProducts(seller.token, csv, { zip: makeZip(entries) }));
    const analysedMs = Date.now() - t0;
    expect(job).toMatchObject({ status: 'READY', readyRows: 300, imageCount: 300 });
    const t1 = Date.now();
    const done = await confirm(seller.token, job);
    const importedMs = Date.now() - t1;
    expect(done.createdCount).toBe(300);
    expect(await prisma.productImage.count({ where: { product: { submittedBySellerId: seller.id } } })).toBe(300);
    console.info(`[perf] 300 rows + 300 photos: analysis (incl. WebP) ${analysedMs} ms, import ${importedMs} ms`);
  }, 600_000);
});

describe('single product creation is unchanged', () => {
  it('Add Product still creates one pending product', async () => {
    const seller = await seedSeller('9400000851');
    const snacks = (await prisma.category.findFirstOrThrow({ where: { sellerId: seller.id, name: 'Snacks' } })).id;
    await as(seller.token).post('/seller/products', { categoryId: snacks, name: 'Single add', sku: 'SINGLE-1', variantName: '1 pc', unit: 'PIECE', unitValue: 1, mrpPaise: 1000, pricePaise: 900, stockQty: 3 }).expect(201);
    expect(await prisma.product.count({ where: { approvalStatus: 'PENDING', submittedBySellerId: seller.id } })).toBe(1);
  });
});
