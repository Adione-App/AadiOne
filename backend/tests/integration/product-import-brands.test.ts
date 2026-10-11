/**
 * Bulk import — brands, end to end (real app and database): an existing brand
 * is matched whatever the capitals or spacing, an unknown one is reported on
 * the preview and created ONCE on confirm, never during the preview; a brand
 * that cannot be used is a row error; concurrent imports never duplicate a
 * brand; a failed row leaves no orphan brand; existing brands are never edited.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, UserRole, type ProductImportDto, type ProductImportRowDto, type ProductImportRowPageDto } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import { runInTransaction } from '../../src/infra/db/prisma';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { importQueuesIdle } from '../../src/modules/product-import/import-worker';
import { processImport } from '../../src/modules/product-import/import-processing';
import { ensureBrands } from '../../src/modules/product-import/brand';
import { hashPassword } from '../../src/common/crypto';

interface Seller {
  id: string;
  token: string;
}

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
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
  return { id: seller.id, token };
}

const HEADER = 'seller_sku,product_name,category,brand,mrp,selling_price,stock_quantity,unit,unit_value';
const row = (sku: string, brand: string) => [sku, `Item ${sku}`, 'Snacks', /[,"]/.test(brand) ? `"${brand.replace(/"/g, '""')}"` : brand, '20', '18', '5', 'g', '100'].join(',');

async function preview(token: string, lines: string[], mode: 'CREATE' | 'UPDATE' = 'CREATE'): Promise<ProductImportDto> {
  const res = await api()
    .post('/api/v1/seller/imports')
    .set('Authorization', bearer(token))
    .field('mode', mode)
    .attach('file', Buffer.from([mode === 'CREATE' ? HEADER : 'seller_sku,brand,selling_price', ...lines].join('\n')), 'p.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await importQueuesIdle();
  return expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${expectSuccess<ProductImportDto>(res.body).data.id}`).expect(200)).body).data;
}

const rowsOf = async (token: string, id: string) =>
  new Map(
    (expectSuccess<ProductImportRowPageDto>((await as(token).get(`/seller/imports/${id}/rows?filter=ALL&pageSize=100`).expect(200)).body).data.items as ProductImportRowDto[]).map((r) => [
      r.sku,
      r,
    ]),
  );

async function confirm(token: string, job: ProductImportDto, mode: 'CREATE' | 'UPDATE' = 'CREATE') {
  await as(token).post(`/seller/imports/${job.id}/confirm`, { mode }).expect(200);
  await importQueuesIdle();
  return expectSuccess<ProductImportDto>((await as(token).get(`/seller/imports/${job.id}`).expect(200)).body).data;
}

const brandOf = async (sku: string) => (await prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { product: { include: { brand: true } } } })).product.brand;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('brand matching and creation', () => {
  it('matches existing brands case- and space-insensitively, creates a new brand once on confirm, never during the preview', async () => {
    const seller = await seedSeller('9400001201');
    const bikaji = await prisma.brand.create({ data: { name: 'Bikaji', slug: 'bikaji' } });

    const job = await preview(seller.token, [
      row('BK-1', 'BIKAJI'),
      row('BK-2', '  bikaji  '),
      row('NB-1', 'Desi Swad'),
      row('NB-2', 'desi   SWAD'),
      row('NB-3', 'DESI SWAD'),
      row('NO-1', ''),
    ]);
    expect(job).toMatchObject({ status: 'READY', readyRows: 6, invalidRows: 0, warningRows: 0 });
    const rows = await rowsOf(seller.token, job.id);
    expect(rows.get('BK-1')!.brand).toEqual({ status: 'MATCHED', name: 'Bikaji' });
    expect(rows.get('BK-2')!.brand).toEqual({ status: 'MATCHED', name: 'Bikaji' });
    expect(rows.get('NB-1')!.brand).toEqual({ status: 'NEW', name: 'Desi Swad' });
    expect(rows.get('NB-2')!.brand).toEqual({ status: 'NEW', name: 'desi SWAD' });
    expect(rows.get('NO-1')!.brand).toBeNull();
    for (const r of rows.values()) expect(r.warnings).toEqual([]);
    // The preview only looks.
    expect(await prisma.brand.count()).toBe(1);

    expect(await confirm(seller.token, job)).toMatchObject({ status: 'COMPLETED', createdCount: 6, failedCount: 0 });
    expect((await brandOf('BK-1'))!.id).toBe(bikaji.id);
    expect((await brandOf('BK-2'))!.id).toBe(bikaji.id);
    const desi = await prisma.brand.findMany({ where: { slug: 'desi-swad' } });
    expect(desi).toHaveLength(1);
    expect(desi[0]).toMatchObject({ name: 'Desi Swad', isActive: true });
    for (const sku of ['NB-1', 'NB-2', 'NB-3']) expect((await brandOf(sku))!.id).toBe(desi[0]!.id);
    expect(await brandOf('NO-1')).toBeNull();
    expect(await prisma.brand.count()).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'brand.import_create', entityId: desi[0]!.id } })).toBe(1);
    // The existing brand is linked, never edited.
    expect(await prisma.brand.findUniqueOrThrow({ where: { id: bikaji.id } })).toMatchObject({ name: 'Bikaji', slug: 'bikaji', isActive: true, updatedAt: bikaji.updatedAt });

    // A later import (another seller, other spelling) reuses the created brand.
    const other = await seedSeller('9400001202');
    const second = await preview(other.token, [row('NB-9', ' Desi  swad ')]);
    expect((await rowsOf(other.token, second.id)).get('NB-9')!.brand).toEqual({ status: 'MATCHED', name: 'Desi Swad' });
    await confirm(other.token, second);
    expect((await brandOf('NB-9'))!.id).toBe(desi[0]!.id);
    expect(await prisma.brand.count()).toBe(2);
  });

  it('matches a brand by slug, and reports brands that cannot be used as row errors', async () => {
    const seller = await seedSeller('9400001203');
    const haldiram = await prisma.brand.create({ data: { name: "Haldiram's", slug: 'haldirams' } });
    await prisma.brand.create({ data: { name: 'Old Co', slug: 'old-co', isActive: false } });

    const job = await preview(seller.token, [row('HL-1', 'Haldirams'), row('OC-1', 'OLD co'), row('LG-1', 'X'.repeat(121)), row('SY-1', '!!!')]);
    const rows = await rowsOf(seller.token, job.id);
    expect(rows.get('HL-1')).toMatchObject({ status: 'READY', brand: { status: 'MATCHED', name: "Haldiram's" } });
    expect(rows.get('OC-1')!.status).toBe('INVALID');
    expect(rows.get('OC-1')!.errors[0]).toMatchObject({ field: 'brand', message: expect.stringMatching(/Brand "Old Co" has been disabled by Aadione/) });
    expect(rows.get('LG-1')!.errors[0]!.message).toMatch(/at most 120 characters/);
    expect(rows.get('SY-1')!.errors[0]!.message).toMatch(/must contain letters or numbers/);

    await confirm(seller.token, job);
    expect((await brandOf('HL-1'))!.id).toBe(haldiram.id);
    expect(await prisma.brand.count()).toBe(2);
    expect((await prisma.brand.findUniqueOrThrow({ where: { slug: 'old-co' } })).isActive).toBe(false);
  });

  it('a row that fails while processing leaves no orphan brand; the rest of the batch keeps its new brand', async () => {
    const seller = await seedSeller('9400001204');
    const job = await preview(seller.token, [row('GH-1', 'Ghost Brand'), row('GD-1', 'Good Brand')]);
    expect(job.readyRows).toBe(2);
    // After the preview, another seller takes SKU GH-1: that row's insert fails.
    const thief = await seedSeller('9400001205');
    await confirm(thief.token, await preview(thief.token, [row('GH-1', '')]));

    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'QUEUED', heartbeatAt: null } });
    await processImport(job.id);
    const done = expectSuccess<ProductImportDto>((await as(seller.token).get(`/seller/imports/${job.id}`).expect(200)).body).data;
    expect(done).toMatchObject({ createdCount: 1, failedCount: 1 });
    expect(await prisma.brand.findMany({ where: { slug: 'ghost-brand' } })).toHaveLength(0);
    expect((await brandOf('GD-1'))!.name).toBe('Good Brand');
  });

  it('two transactions creating the same brand at once end with one brand', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    // A creates the brand and keeps its transaction open; B asks for the same brand meanwhile.
    const first = runInTransaction(
      async (tx) => {
        const result = await ensureBrands(tx, ['Kwality Foods']);
        await hold;
        return result;
      },
      { timeoutMs: 15_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = runInTransaction((tx) => ensureBrands(tx, ['  KWALITY   foods ']), { timeoutMs: 15_000 });
    setTimeout(release, 300);
    const [a, b] = await Promise.all([first, second]);

    expect(a.brands.get('kwality foods')!.id).toBe(b.brands.get('kwality foods')!.id);
    expect(a.created.length + b.created.length).toBe(1);
    expect(await prisma.brand.count()).toBe(1);
  });

  it('update mode: repeating the product’s own brand is fine, a different brand is still refused', async () => {
    const seller = await seedSeller('9400001206');
    await prisma.brand.create({ data: { name: 'Bikaji', slug: 'bikaji' } });
    await prisma.brand.create({ data: { name: 'Haldiram', slug: 'haldiram' } });
    await confirm(seller.token, await preview(seller.token, [row('UB-1', 'Bikaji')]));

    const job = await preview(seller.token, ['UB-1,BIKAJI,15'], 'UPDATE');
    expect((await rowsOf(seller.token, job.id)).get('UB-1')).toMatchObject({ status: 'READY', brand: { status: 'MATCHED', name: 'Bikaji' } });
    const changed = await preview(seller.token, ['UB-1,Haldiram,15'], 'UPDATE');
    expect((await rowsOf(seller.token, changed.id)).get('UB-1')!.errors[0]!.message).toMatch(/Brand cannot be changed by an import/);
  });
});

describe('admin approval review shows the brand', () => {
  async function loginAdmin(): Promise<string> {
    const admin = { email: 'brand-admin@adione.test', password: 'TestAdmin@123' };
    await prisma.user.create({ data: { mobile: '9400001290', email: admin.email, fullName: 'Admin', passwordHash: await hashPassword(admin.password), role: UserRole.ADMIN } });
    return expectSuccess<{ tokens: { accessToken: string } }>((await api().post('/api/v1/auth/admin/login').send(admin).expect(200)).body).data.tokens.accessToken;
  }
  type Row = { sku: string | null; brand: { id: string; name: string; isNew: boolean } | null };
  const reviewRows = async (token: string, batchId: string) =>
    new Map(
      expectSuccess<{ items: Row[] }>((await as(token).get(`/admin/approval-batches/${batchId}/products?offset=0&limit=50`).expect(200)).body).data.items.map((r) => [r.sku, r]),
    );
  const submit = async (seller: Seller) => expectSuccess<{ id: string }>((await as(seller.token).post('/seller/approval-batches', {}).expect(201)).body).data.id;

  it('names the brand and flags one an import created that is not live yet; never guesses for other brands', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9400001211');
    const bikaji = await prisma.brand.create({ data: { name: 'Bikaji', slug: 'bikaji' } }); // not from an import
    await confirm(seller.token, await preview(seller.token, [row('RV-NEW', 'Desi Swad'), row('RV-OLD', 'bikaji'), row('RV-NONE', '')]));
    const batch = await submit(seller);

    const rows = await reviewRows(admin, batch);
    const desi = await prisma.brand.findUniqueOrThrow({ where: { slug: 'desi-swad' } });
    expect(rows.get('RV-NEW')!.brand).toEqual({ id: desi.id, name: 'Desi Swad', isNew: true });
    expect(rows.get('RV-OLD')!.brand).toEqual({ id: bikaji.id, name: 'Bikaji', isNew: false });
    expect(rows.get('RV-NONE')!.brand).toBeNull();
    // Sellers cannot read the admin review.
    expect((await as(seller.token).get(`/admin/approval-batches/${batch}/products?offset=0&limit=50`)).status).toBe(403);

    // Once a product with the brand is approved, the brand is live: no longer "new" for the next review.
    await as(admin).post(`/admin/approval-batches/${batch}/approve`).expect(200);
    const other = await seedSeller('9400001212');
    await confirm(other.token, await preview(other.token, [row('RV-NEXT', 'DESI swad')]));
    const next = await reviewRows(admin, await submit(other));
    expect(next.get('RV-NEXT')!.brand).toEqual({ id: desi.id, name: 'Desi Swad', isNew: false });
  });
});
