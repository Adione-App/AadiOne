/**
 * Products with sizes through bulk import / export, end to end (real app,
 * real database):
 *
 *   - rows sharing a parent_sku become ONE product with one variant per row
 *     (own SKU, size, price, stock; price inherited from the product's rows);
 *   - a product's rows are validated together and imported all-or-nothing;
 *   - Update mode adds sizes and changes per-size price / stock;
 *   - the export (one row per variant) re-imports in Update mode without
 *     creating anything twice, and stores a stable parent_sku;
 *   - customers: one product, a size must be in stock, the order keeps the
 *     size / SKU / price, and the last unit of a size sells once.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  PaymentMethod,
  UserRole,
  type ProductDetailDto,
  type ProductImportDto,
  type ProductImportRowDto,
  type ProductImportRowPageDto,
} from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { NEARBY, seedAddress, sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { importQueuesIdle } from '../../src/modules/product-import/import-worker';
import { readCsvRecords } from '../../src/modules/product-import/csv';

/** Reads CSV text with the importer's own reader (header first, BOM dropped). */
async function parseCsv(text: string): Promise<string[][]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'export-'));
  const file = path.join(dir, 'export.csv');
  try {
    await writeFile(file, text, 'utf8');
    const out: string[][] = [];
    for await (const record of readCsvRecords(file, 10_000)) out.push(record.cells);
    if (out[0]?.[0]) out[0][0] = out[0][0].replace(/^\uFEFF/, '');
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Seller {
  id: string;
  token: string;
}

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  put: (p: string, body: object) => api().put(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

/** An ACTIVE fashion seller with Clothing (› T-Shirts) and Footwear, open all day. */
async function seedSeller(mobile: string): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Fashion ${mobile}`,
      sellerType: 'FASHION',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      allowCod: 'ALLOW',
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  const token = (await loginAs(mobile)).accessToken;
  const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await as(token).post('/seller/categories', { name: 'Clothing' }).expect(201)).body).data;
  const clothing = tree.categories.find((c) => c.name === 'Clothing')!.id;
  await as(token).post('/seller/subcategories', { parentId: clothing, name: 'T-Shirts' }).expect(201);
  await as(token).post('/seller/categories', { name: 'Footwear' }).expect(201);
  return { id: seller.id, token };
}

const HEADER = 'parent_sku,seller_sku,product_name,category,subcategory,brand,size,color,mrp,selling_price,stock_quantity,unit,unit_value,variant_name,is_active';
const line = (cells: (string | number)[]) => cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',');
const file = (...lines: string[]) => [HEADER, ...lines].join('\r\n');

function upload(token: string, csv: string, mode: 'CREATE' | 'UPDATE' = 'CREATE') {
  return api().post('/api/v1/seller/imports').set('Authorization', bearer(token)).field('mode', mode).attach('file', Buffer.from(csv, 'utf8'), 'products.csv');
}

async function analysed(token: string, csv: string, mode: 'CREATE' | 'UPDATE' = 'CREATE'): Promise<ProductImportDto> {
  const res = await upload(token, csv, mode);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await importQueuesIdle();
  const id = expectSuccess<ProductImportDto>(res.body).data.id;
  return expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${id}`).expect(200)).body).data;
}

async function rowsOf(token: string, id: string): Promise<ProductImportRowDto[]> {
  return expectSuccess<ProductImportRowPageDto>((await as(token).get(`/seller/imports/${id}/rows?filter=ALL&pageSize=100`).expect(200)).body).data.items;
}

async function confirm(token: string, job: ProductImportDto): Promise<ProductImportDto> {
  await as(token).post(`/seller/imports/${job.id}/confirm`, { mode: job.mode }).expect(200);
  await importQueuesIdle();
  return expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${job.id}`).expect(200)).body).data;
}

const productOf = (sellerId: string, parentSku: string) =>
  prisma.product.findFirstOrThrow({
    where: { submittedBySellerId: sellerId, parentSku, deletedAt: null },
    include: {
      variants: {
        where: { deletedAt: null },
        orderBy: { displayOrder: 'asc' },
        include: { sellerListings: true },
      },
    },
  });

/** A blue T-shirt in S, M and L: details on the first row only, L takes the product's price. */
const TEE = [
  line(['TEE-BLUE', 'TEE-BLUE-S', 'Cotton Tee Blue', 'Clothing', 'T-Shirts', '', 'S', '', '499', '399', '10', 'piece', '1', '', 'yes']),
  line(['TEE-BLUE', 'TEE-BLUE-M', '', '', '', '', 'M', '', '499', '429', '5', '', '', '', '']),
  line(['TEE-BLUE', 'TEE-BLUE-L', '', '', '', '', 'L', '', '', '', '0', '', '', '', '']),
];

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

/* -------------------------------------------------------------------------- */

describe('import: rows sharing a parent_sku', () => {
  it('creates ONE product with a variant per size; a row without parent_sku stays a single item', async () => {
    const seller = await seedSeller('9400000901');
    const job = await analysed(
      seller.token,
      file(...TEE, line(['', 'SANDAL-1', 'Rubber Sandal', 'Footwear', '', '', '', '', '299', '249', '8', 'piece', '1', 'Pair', ''])),
    );
    expect(job).toMatchObject({ status: 'READY', totalRows: 4, readyRows: 4, invalidRows: 0 });
    const preview = await rowsOf(seller.token, job.id);
    expect(preview.map((r) => [r.sku, r.parentSku, r.variantLabel, r.status])).toEqual([
      ['TEE-BLUE-S', 'TEE-BLUE', 'S', 'READY'],
      ['TEE-BLUE-M', 'TEE-BLUE', 'M', 'READY'],
      ['TEE-BLUE-L', 'TEE-BLUE', 'L', 'READY'],
      ['SANDAL-1', null, null, 'READY'],
    ]);

    const done = await confirm(seller.token, job);
    expect(done).toMatchObject({ status: 'COMPLETED', createdCount: 4, failedCount: 0 });
    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id } })).toBe(2);

    const tee = await productOf(seller.id, 'TEE-BLUE');
    expect(tee).toMatchObject({ name: 'Cotton Tee Blue', approvalStatus: 'PENDING', status: 'ACTIVE', optionGroups: [{ name: 'Size', values: ['S', 'M', 'L'] }] });
    expect(
      tee.variants.map((v) => [v.sku, v.variantName, v.optionValues, v.isDefault, v.sellerListings[0]!.mrpPaise, v.sellerListings[0]!.pricePaise, v.sellerListings[0]!.stockQty]),
    ).toEqual([
      ['TEE-BLUE-S', 'S', { Size: 'S' }, true, 49900, 39900, 10],
      ['TEE-BLUE-M', 'M', { Size: 'M' }, false, 49900, 42900, 5],
      // Empty price cells take the product's first row's price.
      ['TEE-BLUE-L', 'L', { Size: 'L' }, false, 49900, 39900, 0],
    ]);
    // Opening stock is ledgered per size (none for a size with 0).
    expect(await prisma.stockLedger.count({ where: { sellerListing: { variant: { productId: tee.id } } } })).toBe(2);

    const sandal = await prisma.product.findFirstOrThrow({ where: { name: 'Rubber Sandal' }, include: { variants: true } });
    expect(sandal).toMatchObject({ parentSku: null, optionGroups: [] });
    expect(sandal.variants.map((v) => [v.sku, v.variantName])).toEqual([['SANDAL-1', 'Pair']]);
  });

  it('checks a product’s rows together and never imports only some of its sizes', async () => {
    const seller = await seedSeller('9400000902');
    const job = await analysed(
      seller.token,
      file(
        // A: one size missing.
        line(['A-TEE', 'A-S', 'Tee A', 'Clothing', '', '', 'S', '', '300', '250', '5', 'piece', '1', '', '']),
        line(['A-TEE', 'A-M', '', '', '', '', '', '', '300', '250', '5', '', '', '', '']),
        // B: the same size twice.
        line(['B-TEE', 'B-S', 'Tee B', 'Clothing', '', '', 'S', '', '300', '250', '5', 'piece', '1', '', '']),
        line(['B-TEE', 'B-S2', '', '', '', '', 's', '', '300', '250', '5', '', '', '', '']),
        // C: two different product names.
        line(['C-TEE', 'C-S', 'Tee C', 'Clothing', '', '', 'S', '', '300', '250', '5', 'piece', '1', '', '']),
        line(['C-TEE', 'C-M', 'Another name', '', '', '', 'M', '', '300', '250', '5', '', '', '', '']),
        // D: an invalid price on one size.
        line(['D-TEE', 'D-S', 'Tee D', 'Clothing', '', '', 'S', '', '300', '250', '5', 'piece', '1', '', '']),
        line(['D-TEE', 'D-M', '', '', '', '', 'M', '', '300', '₹260', '5', '', '', '', '']),
        // E: an unsupported unit on one size.
        line(['E-TEE', 'E-S', 'Tee E', 'Clothing', '', '', 'S', '', '300', '250', '5', 'piece', '1', '', '']),
        line(['E-TEE', 'E-M', '', '', '', '', 'M', '', '300', '250', '5', 'yards', '', '', '']),
        // F: a variant SKU used twice in the file.
        line(['F-TEE', 'F-S', 'Tee F', 'Clothing', '', '', 'S', '', '300', '250', '5', 'piece', '1', '', '']),
        line(['F-TEE', 'F-S', '', '', '', '', 'M', '', '300', '250', '5', '', '', '', '']),
        // G: a size without a parent_sku.
        line(['', 'G-S', 'Tee G', 'Clothing', '', '', 'S', '', '300', '250', '5', 'piece', '1', '', '']),
        // H: two rows, nothing tells them apart.
        line(['H-TEE', 'H-1', 'Tee H', 'Clothing', '', '', '', '', '300', '250', '5', 'piece', '1', '', '']),
        line(['H-TEE', 'H-2', '', '', '', '', '', '', '300', '250', '5', '', '', '', '']),
        // OK: a valid product imports regardless.
        line(['OK-TEE', 'OK-S', 'Tee OK', 'Clothing', '', '', 'S', 'Red', '300', '250', '5', 'piece', '1', '', '']),
        line(['OK-TEE', 'OK-M', '', '', '', '', 'M', 'Red', '300', '250', '5', '', '', '', '']),
      ),
    );
    const preview = await rowsOf(seller.token, job.id);
    const status = Object.fromEntries(preview.map((r) => [r.sku ?? `#${r.rowNumber}`, r.status]));
    for (const sku of ['A-S', 'A-M', 'B-S', 'B-S2', 'C-S', 'C-M', 'D-S', 'D-M', 'E-S', 'E-M', 'G-S', 'H-1', 'H-2']) expect(status[sku], sku).not.toBe('READY');
    expect(status['OK-S']).toBe('READY');
    expect(status['OK-M']).toBe('READY');
    const messages = (sku: string) => preview.filter((r) => r.sku === sku).flatMap((r) => r.errors.map((e) => e.message)).join(' | ');
    expect(messages('A-M')).toMatch(/no size/i);
    expect(messages('A-S')).toMatch(/Not imported: row 3 of the same product/);
    expect(messages('B-S2')).toMatch(/listed twice/);
    expect(messages('C-M')).toMatch(/Different product name/);
    expect(messages('D-S')).toMatch(/Not imported/);
    expect(messages('E-M')).toMatch(/Unit "yards" is not supported/);
    expect(messages('G-S')).toMatch(/needs a parent_sku/);
    expect(messages('H-1')).toMatch(/give each a size, color or option_value/);

    const done = await confirm(seller.token, job);
    expect(done.createdCount).toBe(2);
    expect(await prisma.product.findMany({ where: { submittedBySellerId: seller.id }, select: { name: true } })).toEqual([{ name: 'Tee OK' }]);
    const ok = await productOf(seller.id, 'OK-TEE');
    expect(ok.optionGroups).toEqual([
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Red'] },
    ]);
    expect(ok.variants.map((v) => v.variantName)).toEqual(['S / Red', 'M / Red']);

    // Creating the same parent_sku again is a conflict: Update mode adds sizes.
    const again = await analysed(seller.token, file(line(['OK-TEE', 'OK-L', 'Tee OK', 'Clothing', '', '', 'L', 'Red', '300', '250', '5', 'piece', '1', '', ''])));
    expect((await rowsOf(seller.token, again.id))[0]).toMatchObject({ status: 'CONFLICT' });
  });
});

describe('import: Update mode on a product with sizes', () => {
  it('changes per-size stock and price, adds a size (price from the product), and keeps the rest', async () => {
    const seller = await seedSeller('9400000903');
    await confirm(seller.token, await analysed(seller.token, file(...TEE)));
    const before = await productOf(seller.id, 'TEE-BLUE');

    const update = await analysed(
      seller.token,
      file(
        line(['TEE-BLUE', 'TEE-BLUE-M', 'Cotton Tee — Blue', '', '', '', '', '', '', '449', '25', '', '', '', '']),
        line(['TEE-BLUE', 'TEE-BLUE-XL', '', '', '', '', 'XL', '', '', '', '7', '', '', '', '']),
      ),
      'UPDATE',
    );
    expect(update).toMatchObject({ readyRows: 2, invalidRows: 0 });
    const done = await confirm(seller.token, update);
    expect(done).toMatchObject({ status: 'COMPLETED', updatedCount: 2, failedCount: 0 });

    const after = await productOf(seller.id, 'TEE-BLUE');
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('Cotton Tee — Blue');
    expect(after.optionGroups).toEqual([{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }]);
    expect(after.variants.map((v) => [v.sku, v.variantName, v.sellerListings[0]!.pricePaise, v.sellerListings[0]!.stockQty])).toEqual([
      ['TEE-BLUE-S', 'S', 39900, 10],
      ['TEE-BLUE-M', 'M', 44900, 25],
      ['TEE-BLUE-L', 'L', 39900, 0],
      // New size: MRP and price from the product's default size.
      ['TEE-BLUE-XL', 'XL', 39900, 7],
    ]);
    // Stock changes are ledgered, never overwritten silently.
    const m = after.variants.find((v) => v.sku === 'TEE-BLUE-M')!.sellerListings[0]!;
    expect(await prisma.stockLedger.findMany({ where: { sellerListingId: m.id }, orderBy: { createdAt: 'asc' }, select: { delta: true, balanceAfter: true } })).toEqual([
      { delta: 5, balanceAfter: 5 },
      { delta: 20, balanceAfter: 25 },
    ]);

    // Rows of one parent_sku that point at two different products are refused.
    await confirm(seller.token, await analysed(seller.token, file(line(['CAP-1', 'CAP-1-S', 'Cap', 'Clothing', '', '', 'S', '', '200', '150', '4', 'piece', '1', '', '']))));
    const mixed = await analysed(
      seller.token,
      file(line(['TEE-BLUE', 'TEE-BLUE-S', '', '', '', '', '', '', '', '', '11', '', '', '', '']), line(['TEE-BLUE', 'CAP-1-S', '', '', '', '', '', '', '', '', '3', '', '', '', ''])),
      'UPDATE',
    );
    const mixedRows = await rowsOf(seller.token, mixed.id);
    expect(mixedRows.every((r) => r.status === 'INVALID')).toBe(true);
    expect(mixedRows[0]!.errors.map((e) => e.message).join(' ')).toMatch(/match 2 different products/);
  });
});

describe('export and re-import', () => {
  it('exports one row per variant that re-imports in Update mode without creating anything twice', async () => {
    const seller = await seedSeller('9400000904');
    await confirm(
      seller.token,
      await analysed(seller.token, file(...TEE, line(['', 'SANDAL-1', '=Rubber Sandal', 'Footwear', '', '', '', '', '299', '249', '8', 'piece', '1', 'Pair', '']))),
    );
    // A product with sizes made on the product page has no parent_sku yet.
    const created = expectSuccess<{ id: string }>(
      (
        await as(seller.token)
          .post('/seller/products', {
            name: 'Canvas Shoe',
            categoryId: (await prisma.category.findFirstOrThrow({ where: { sellerId: seller.id, name: 'Footwear' } })).id,
            sku: 'SHOE-7',
            variantName: '7',
            unit: 'PIECE',
            unitValue: 1,
            mrpPaise: 99900,
            pricePaise: 89900,
            stockQty: 3,
          })
          .expect(201)
      ).body,
    ).data;
    await as(seller.token)
      .put(`/seller/products/${created.id}/variants`, {
        optionGroups: [{ name: 'Size', values: ['7', '8'] }],
        variants: [
          { id: (await prisma.productVariant.findFirstOrThrow({ where: { productId: created.id } })).id, optionValues: { Size: '7' }, pricePaise: 89900, mrpPaise: 99900, stockQty: 3 },
          { optionValues: { Size: '8' }, sku: 'SHOE-8', pricePaise: 89900, mrpPaise: 99900, stockQty: 2 },
        ],
      })
      .expect(200);

    const res = await as(seller.token).get('/seller/imports/export.csv').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="aadione-products-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = res.text;
    const records = await parseCsv(text);
    const [header, ...data] = records;
    expect(header).toEqual(expect.arrayContaining(['parent_sku', 'seller_sku', 'size', 'mrp', 'selling_price', 'stock_quantity']));
    expect(header).not.toContain('image_filename');
    const col = (name: string) => header!.indexOf(name);
    const bySku = new Map(data.map((r) => [r[col('seller_sku')], r]));
    expect(data).toHaveLength(6);
    expect(bySku.get('TEE-BLUE-M')![col('parent_sku')]).toBe('TEE-BLUE');
    expect(bySku.get('TEE-BLUE-M')![col('size')]).toBe('M');
    expect(bySku.get('TEE-BLUE-M')![col('selling_price')]).toBe('429');
    expect(bySku.get('TEE-BLUE-M')![col('stock_quantity')]).toBe('5');
    expect(bySku.get('TEE-BLUE-M')![col('subcategory')]).toBe('T-Shirts');
    expect(bySku.get('SANDAL-1')![col('parent_sku')]).toBe('');
    // Formula-looking text is guarded in the file…
    expect(bySku.get('SANDAL-1')![col('product_name')]).toBe("'=Rubber Sandal");
    // …and the shoe without a parent_sku is grouped under its default size's SKU.
    expect(bySku.get('SHOE-8')![col('parent_sku')]).toBe('SHOE-7');

    const counts = async () => ({
      products: await prisma.product.count({ where: { submittedBySellerId: seller.id } }),
      variants: await prisma.productVariant.count({ where: { product: { submittedBySellerId: seller.id }, deletedAt: null } }),
      ledger: await prisma.stockLedger.count(),
    });
    const before = await counts();

    const job = await analysed(seller.token, text, 'UPDATE');
    expect(job).toMatchObject({ totalRows: 6, readyRows: 6, invalidRows: 0 });
    const done = await confirm(seller.token, job);
    expect(done).toMatchObject({ status: 'COMPLETED', updatedCount: 6, createdCount: 0, failedCount: 0 });
    expect(await counts()).toEqual(before);
    expect((await prisma.product.findFirstOrThrow({ where: { name: { contains: 'Rubber Sandal' } } })).name).toBe('=Rubber Sandal');
    // The exported parent code is now stored on the shoe.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: created.id } })).parentSku).toBe('SHOE-7');
  });
});

describe('customers: one product, sizes, stock and orders', () => {
  it('needs an in-stock size, keeps the size in the order, and sells the last unit of a size once', async () => {
    const seller = await seedSeller('9400000905');
    await confirm(seller.token, await analysed(seller.token, file(...TEE)));
    const tee = await productOf(seller.id, 'TEE-BLUE');
    await prisma.product.update({ where: { id: tee.id }, data: { approvalStatus: 'APPROVED' } });
    // One last S.
    await prisma.sellerListing.update({ where: { id: tee.variants[0]!.sellerListings[0]!.id }, data: { stockQty: 1 } });

    const detail = expectSuccess<ProductDetailDto>((await api().get(`/api/v1/products/${tee.id}`).expect(200)).body).data;
    expect(detail.optionGroups).toEqual([{ name: 'Size', values: ['S', 'M', 'L'] }]);
    expect(detail.variants.map((v) => [v.variantName, v.inStock])).toEqual([
      ['S', true],
      ['M', true],
      ['L', false],
    ]);
    const listing = (size: string) => detail.variants.find((v) => v.variantName === size)!.sellerListingId;

    const customers = await Promise.all(
      ['9876500901', '9876500902'].map(async (mobile) => {
        await otpService.clearOtpState(mobile);
        const session = await loginAs(mobile);
        return { token: session.accessToken, addressId: await seedAddress(session.userId, NEARBY) };
      }),
    );
    const [a, b] = customers as [(typeof customers)[number], (typeof customers)[number]];

    // A sold-out size cannot be added; an in-stock one can.
    const soldOut = await as(a.token).post('/cart/items', { sellerListingId: listing('L'), qty: 1 });
    expect(soldOut.status).toBeGreaterThanOrEqual(400);
    await as(a.token).post('/cart/items', { sellerListingId: listing('M'), qty: 1 }).expect(200);

    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(a.token))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId: a.addressId, paymentMethod: PaymentMethod.COD })
      .expect(201);
    const orderId = expectSuccess<{ order: { id: string } }>(placed.body).data.order.id;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { sellerOrder: { orderId } } });
    expect(item).toMatchObject({ sku: 'TEE-BLUE-M', variantName: 'M', optionValues: { Size: 'M' }, unitPricePaise: 42900, qty: 1 });

    // The size is edited later: the placed order is untouched.
    await prisma.sellerListing.update({ where: { id: listing('M') }, data: { pricePaise: 45000 } });
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ unitPricePaise: 42900, variantName: 'M' });

    // Two customers race for the last S: exactly one order gets it.
    for (const c of [a, b]) await as(c.token).post('/cart/items', { sellerListingId: listing('S'), qty: 1 }).expect(200);
    const results = await Promise.all(
      [a, b].map((c) =>
        api().post('/api/v1/orders').set('Authorization', bearer(c.token)).set('Idempotency-Key', randomUUID()).send({ addressId: c.addressId, paymentMethod: PaymentMethod.COD }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const s = await prisma.sellerListing.findUniqueOrThrow({ where: { id: listing('S') } });
    expect(s.stockQty - s.reservedQty).toBe(0);
    expect(s.stockQty).toBeGreaterThanOrEqual(0);
  });
});
