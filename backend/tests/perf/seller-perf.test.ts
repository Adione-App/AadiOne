/**
 * Seller-panel performance benchmark — runs only with PERF=1:
 *
 *   PERF=1 npx vitest run tests/perf/seller-perf.test.ts
 *
 * Measures, for every request ONE seller action makes, the wall time (local
 * Postgres, in-process API) and the number of database queries. Locally a
 * query costs well under a millisecond; in production every query is a
 * network round trip from the API server to the database, so the query count
 * is what decides the time the seller waits. The report prints both, plus a
 * production estimate at PROD_RTT_MS per query (an estimate, labelled as one).
 *
 * Writes perf-report.json next to this file's run directory (PERF_OUT).
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStatus, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const RUNS = 7;
const PROD_RTT_MS = Number(process.env['PROD_RTT_MS'] ?? 60);
const OUT = process.env['PERF_OUT'] ?? 'perf-report.json';

let queries = 0;
let counting = false;
let tracing = false;
const trace: string[] = [];

/** Before each timed run: reset the API's rate-limit counters (they live in the cache) and re-warm the config cache untimed. */
let warm: () => Promise<unknown> = async () => undefined;
async function fresh(): Promise<void> {
  await cache.clear();
  await warm();
}

async function measure(label: string, run: () => Promise<unknown>) {
  const times: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    await fresh();
    queries = 0;
    counting = true;
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
    counting = false;
    counts.push(queries);
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  return { label, ms: Math.round(median(times)), queries: median(counts) };
}

describe.skipIf(!process.env['PERF'])('seller panel performance', () => {
  let token = '';
  let listingId = '';
  let productId = '';

  beforeAll(async () => {
    await truncateAll();
    await configService.invalidateAll();
    await cache.clear();
    (prisma as unknown as { $on: (event: 'query', cb: (e: { query: string }) => void) => void }).$on('query', (e) => {
      if (counting) {
        queries += 1;
        if (tracing) trace.push(e.query.replace(/\s+/g, ' ').slice(0, 140));
      }
    });

    const seller = await prisma.seller.create({
      data: {
        code: `PERF-${randomUUID().slice(0, 6)}`,
        name: 'Perf Store',
        sellerType: SellerType.GROCERY,
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
    const user = await prisma.user.create({ data: { mobile: '9600001234', fullName: 'Perf Owner', role: UserRole.SELLER_OWNER } });
    await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
    await otpService.clearOtpState('9600001234');
    token = (await loginAs('9600001234')).accessToken;
    const S = (method: 'post' | 'get', path: string, body?: object) =>
      method === 'post' ? api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body ?? {}) : api().get(`/api/v1${path}`).set('Authorization', bearer(token));

    const tree = expectSuccess<{ categories: { id: string }[] }>((await S('post', '/seller/categories', { name: 'Grocery' }).expect(201)).body).data;
    const categoryId = tree.categories[0]!.id;
    // A realistic small store: 30 simple products + 10 sold in three sizes.
    for (let i = 0; i < 30; i += 1) {
      const res = await S('post', '/seller/products', {
        categoryId,
        name: `Product ${i}`,
        sku: `PERF-S-${i}-${randomUUID().slice(0, 4)}`,
        variantName: '1 kg',
        unit: UnitType.KG,
        unitValue: 1,
        mrpPaise: 12_000,
        pricePaise: 10_000,
        stockQty: 50,
      }).expect(201);
      if (i === 0) {
        const created = expectSuccess<{ id: string; listingId: string }>(res.body).data;
        productId = created.id;
        listingId = created.listingId;
      }
    }
    for (let i = 0; i < 10; i += 1) {
      await S('post', '/seller/products', {
        categoryId,
        name: `Sized ${i}`,
        optionGroups: [{ name: 'Weight', values: ['250g', '500g', '1kg'] }],
        variants: ['250g', '500g', '1kg'].map((w, j) => ({ optionValues: { Weight: w }, sku: `PERF-V-${i}-${j}-${randomUUID().slice(0, 4)}`, pricePaise: 2_000 * (j + 1), mrpPaise: 2_500 * (j + 1), stockQty: 20 })),
      }).expect(201);
    }
  }, 300_000);

  it('measures stock updates and image uploads', async () => {
    const S = {
      get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
      post: (path: string, body: object) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
      patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
    };
    let stock = 50;
    const rows = [];
    warm = () => S.get(`/seller/listings/${listingId}`).expect(200);

    if (process.env['PERF_TRACE']) {
      for (const [label, call] of [
        ['stock-adjust', () => S.post(`/seller/listings/${listingId}/stock-adjust`, { delta: 1 }).expect(200)],
      ] as const) {
        await fresh();
        trace.length = 0;
        counting = true;
        tracing = true;
        await call();
        counting = false;
        tracing = false;
        console.log([`TRACE ${label}:`, ...trace.map((q, i) => `  ${i + 1}. ${q}`)].join(String.fromCharCode(10)));
      }
      // The attach step of an image upload (presign + PUT untraced).
      await fresh();
      const small = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#2e7d32' } }).jpeg().toBuffer();
      const presigned = expectSuccess<{ uploadUrl: string; key: string }>(
        (await S.post('/seller/uploads/presign', { fileName: 'p.jpg', contentType: 'image/jpeg' }).expect(200)).body,
      ).data;
      const target = new URL(presigned.uploadUrl);
      await api().put(`${target.pathname}${target.search}`).set('Authorization', bearer(token)).set('Content-Type', 'image/jpeg').send(small).expect(200);
      trace.length = 0;
      counting = true;
      tracing = true;
      await S.post(`/seller/products/${productId}/images`, { key: presigned.key }).expect(201);
      counting = false;
      tracing = false;
      console.log([`TRACE attach:`, ...trace.map((q, i) => `  ${i + 1}. ${q}`)].join(String.fromCharCode(10)));
      await prisma.productImage.deleteMany({ where: { productId } });
    }
    rows.push(await measure('POST stock-adjust +1', async () => {
      await S.post(`/seller/listings/${listingId}/stock-adjust`, { delta: 1 }).expect(200);
    }));
    rows.push(await measure('POST stock-adjust -1', async () => {
      await S.post(`/seller/listings/${listingId}/stock-adjust`, { delta: -1 }).expect(200);
    }));
    rows.push(await measure('PATCH listing stockQty (direct)', async () => {
      stock += 1;
      await S.patch(`/seller/listings/${listingId}`, { stockQty: stock }).expect(200);
    }));
    // What the panel re-reads after each change today (useRefreshInventory + the product page).
    rows.push(await measure('GET /seller/products (refresh)', async () => void (await S.get('/seller/products').expect(200))));
    rows.push(await measure('GET /seller/listings (refresh)', async () => void (await S.get('/seller/listings').expect(200))));
    rows.push(await measure('GET /seller/activity (refresh)', async () => void (await S.get('/seller/activity?limit=15').expect(200))));
    rows.push(await measure(`GET /seller/products/:id (product page)`, async () => void (await S.get(`/seller/products/${productId}`).expect(200))));
    rows.push(await measure(`GET stock-movements (product page)`, async () => void (await S.get(`/seller/listings/${listingId}/stock-movements`).expect(200))));

    // Image: a phone-camera sized JPEG (4032x3024) and the same photo downscaled in the browser.
    const camera = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: '#7cb342' } })
      .composite([{ input: await sharp({ create: { width: 2000, height: 1500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer(), top: 700, left: 1000 }])
      .jpeg({ quality: 92 })
      .toBuffer();
    const browserSized = await sharp(camera).resize({ width: 1600, height: 1600, fit: 'inside' }).webp({ quality: 85 }).toBuffer();

    async function uploadOnce(bytes: Buffer, contentType: string) {
      const t0 = performance.now();
      const presigned = expectSuccess<{ uploadUrl: string; key: string }>(
        (await S.post('/seller/uploads/presign', { fileName: 'photo.jpg', contentType }).expect(200)).body,
      ).data;
      const t1 = performance.now();
      const target = new URL(presigned.uploadUrl);
      await api().put(`${target.pathname}${target.search}`).set('Authorization', bearer(token)).set('Content-Type', contentType).send(bytes).expect(200);
      const t2 = performance.now();
      await S.post(`/seller/products/${productId}/images`, { key: presigned.key }).expect(201);
      const t3 = performance.now();
      // keep the gallery small
      const images = await prisma.productImage.findMany({ where: { productId }, select: { id: true } });
      if (images.length >= 6) await prisma.productImage.deleteMany({ where: { productId } });
      return { presign: t1 - t0, put: t2 - t1, attach: t3 - t2 };
    }
    for (const [label, bytes, type] of [
      ['image: camera JPEG', camera, 'image/jpeg'],
      ['image: browser-downscaled WebP', browserSized, 'image/webp'],
    ] as const) {
      const parts: { presign: number; put: number; attach: number }[] = [];
      const counts: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        await fresh();
        queries = 0;
        counting = true;
        parts.push(await uploadOnce(bytes, type));
        counting = false;
        counts.push(queries);
      }
      const med = (pick: (p: (typeof parts)[number]) => number) => Math.round([...parts.map(pick)].sort((a, b) => a - b)[2]!);
      rows.push({
        label: `${label} (${Math.round(bytes.byteLength / 1024)} KB)`,
        ms: med((p) => p.presign + p.put + p.attach),
        queries: [...counts].sort((a, b) => a - b)[2]!,
        detail: { presignMs: med((p) => p.presign), putMs: med((p) => p.put), attachMs: med((p) => p.attach), bytes: bytes.byteLength },
      });
    }

    const report = rows.map((r) => ({ ...r, prodEstimateMs: r.ms + r.queries * PROD_RTT_MS }));
    console.table(report.map(({ detail: _d, ...r }) => r));
    for (const r of report) if ('detail' in r && r.detail) console.log(r.label, JSON.stringify(r.detail));
    writeFileSync(OUT, JSON.stringify({ prodRttMs: PROD_RTT_MS, runs: RUNS, report }, null, 2));
    expect(report.length).toBeGreaterThan(0);
  }, 600_000);
});
