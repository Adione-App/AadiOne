/**
 * Before/after benchmark (QA only, PERF=1): stock taps and photo attaches,
 * timed end to end through the in-process API, with the database reached
 * through a latency proxy (DATABASE_URL on :55433, RTT set there) so every
 * statement costs a production-like round trip. Copied into a HEAD worktree
 * for "before" and run in the working tree for "after"; writes PERF_OUT.
 *   PERF=1 BROWSER_EDGE=1600|1200 npx vitest run tests/perf/latency-compare.test.ts
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

const RUNS = 5;
const EDGE = Number(process.env['BROWSER_EDGE'] ?? 1200);
const OUT = process.env['PERF_OUT'] ?? 'latency-compare.json';
let queries = 0;
(prisma as unknown as { $on: (event: 'query', cb: () => void) => void }).$on('query', () => {
  queries += 1;
});
const median = (xs: number[]) => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!);

describe.skipIf(!process.env['PERF'])('latency compare', () => {
  let token = '';
  let listingId = '';
  let productId = '';
  const S = {
    get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
    post: (p: string, body: object) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  };

  beforeAll(async () => {
    await truncateAll();
    await configService.invalidateAll();
    await cache.clear();
    const seller = await prisma.seller.create({
      data: {
        code: `LAT-${randomUUID().slice(0, 6)}`,
        name: 'Latency Store',
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
    const user = await prisma.user.create({ data: { mobile: '9600009999', fullName: 'Latency Owner', role: UserRole.SELLER_OWNER } });
    await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
    await otpService.clearOtpState('9600009999');
    token = (await loginAs('9600009999')).accessToken;
    const categoryId = expectSuccess<{ categories: { id: string }[] }>((await S.post('/seller/categories', { name: 'Grocery' }).expect(201)).body).data.categories[0]!.id;
    const created = expectSuccess<{ id: string; listingId: string }>(
      (
        await S.post('/seller/products', {
          categoryId,
          name: 'Latency rice',
          sku: `LAT-${randomUUID().slice(0, 6)}`,
          variantName: '1 kg',
          unit: UnitType.KG,
          unitValue: 1,
          mrpPaise: 12_000,
          pricePaise: 10_000,
          stockQty: 500,
        }).expect(201)
      ).body,
    ).data;
    productId = created.id;
    listingId = created.listingId;
  }, 600_000);

  it('measures', async () => {
    const rows: Record<string, unknown>[] = [];
    const time = async (label: string, run: () => Promise<unknown>, extra: Record<string, unknown> = {}) => {
      const ms: number[] = [];
      const qs: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        await cache.clear();
        await S.get(`/seller/listings/${listingId}`).expect(200); // warm config + auth caches untimed
        queries = 0;
        const start = performance.now();
        await run();
        ms.push(performance.now() - start);
        qs.push(queries);
      }
      const row = { label, medianMs: median(ms), minMs: Math.round(Math.min(...ms)), maxMs: Math.round(Math.max(...ms)), queries: median(qs), ...extra };
      rows.push(row);
      return row;
    };

    // ---- stock
    await time('stock: one tap (POST stock-adjust +1)', () => S.post(`/seller/listings/${listingId}/stock-adjust`, { delta: 1 }).expect(200));
    await time('stock: one tap −1', () => S.post(`/seller/listings/${listingId}/stock-adjust`, { delta: -1 }).expect(200));
    await time('stock: 10 taps, each waiting for the last (product page before)', async () => {
      for (let i = 0; i < 10; i += 1) await S.post(`/seller/listings/${listingId}/stock-adjust`, { delta: 1 }).expect(200);
    });
    await time('stock: 10 taps batched into one +10 (after)', () => S.post(`/seller/listings/${listingId}/stock-adjust`, { delta: 10 }).expect(200));
    // What the product page re-read after every tap before (useRefreshInventory + history), in parallel.
    await time('stock: refresh after a tap (products + listings + activity + history, parallel)', () =>
      Promise.all([S.get('/seller/products'), S.get('/seller/listings'), S.get('/seller/activity?limit=15'), S.get(`/seller/listings/${listingId}/stock-movements`)]),
    );

    // ---- photos: the browser's output for this version (EDGE px WebP), from a 4032x3024 camera-like JPEG
    const camera = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: '#7cb342' } })
      .composite([{ input: await sharp({ create: { width: 2600, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).blur(1.2).png().toBuffer(), top: 500, left: 700 }])
      .jpeg({ quality: 90 })
      .toBuffer();
    const sent = await sharp(camera).resize({ width: EDGE, height: EDGE, fit: 'inside' }).webp({ quality: 86 }).toBuffer();

    async function uploadOne(): Promise<{ key: string; presign: number; put: number }> {
      const t0 = performance.now();
      const target = expectSuccess<{ uploadUrl: string; key: string }>((await S.post('/seller/uploads/presign', { fileName: 'photo.webp', contentType: 'image/webp' }).expect(200)).body).data;
      const t1 = performance.now();
      const url = new URL(target.uploadUrl);
      await api().put(`${url.pathname}${url.search}`).set('Authorization', bearer(token)).set('Content-Type', 'image/webp').send(sent).expect(200);
      return { key: target.key, presign: t1 - t0, put: performance.now() - t1 };
    }
    const clearGallery = () => prisma.productImage.deleteMany({ where: { productId } });
    const hasBatch = (await S.post(`/seller/products/${productId}/images/batch`, { images: [] })).status !== 404;

    // One photo, stage by stage.
    const stages = { presign: [] as number[], put: [] as number[], attach: [] as number[], attachQueries: [] as number[] };
    for (let i = 0; i < RUNS; i += 1) {
      await clearGallery();
      await cache.clear();
      const up = await uploadOne();
      queries = 0;
      const t = performance.now();
      // The attach the version's panel uses: the batch route (after) or the single one (before).
      if (hasBatch) await S.post(`/seller/products/${productId}/images/batch`, { images: [{ key: up.key }] }).expect(201);
      else await S.post(`/seller/products/${productId}/images`, { key: up.key }).expect(201);
      stages.attach.push(performance.now() - t);
      stages.attachQueries.push(queries);
      stages.presign.push(up.presign);
      stages.put.push(up.put);
    }
    rows.push({
      label: `photo: one (${EDGE}px WebP, ${Math.round(sent.byteLength / 1024)} KB sent)`,
      presignMs: median(stages.presign),
      putMs: median(stages.put),
      attachMs: median(stages.attach),
      attachQueries: median(stages.attachQueries),
      totalMs: median(stages.presign) + median(stages.put) + median(stages.attach),
      cameraKB: Math.round(camera.byteLength / 1024),
      sentKB: Math.round(sent.byteLength / 1024),
    });

    // Three photos: uploads in parallel (both versions), then the attach the version uses.
    await time(
      hasBatch ? 'photo: three — one batch attach (after)' : 'photo: three — attached one after another (before)',
      async () => {
        await clearGallery();
        const ups = await Promise.all([uploadOne(), uploadOne(), uploadOne()]);
        if (hasBatch) await S.post(`/seller/products/${productId}/images/batch`, { images: ups.map((u) => ({ key: u.key })) }).expect(201);
        else for (const u of ups) await S.post(`/seller/products/${productId}/images`, { key: u.key }).expect(201);
      },
    );

    console.table(rows);
    writeFileSync(OUT, JSON.stringify({ edge: EDGE, rows }, null, 2));
    expect(rows.length).toBeGreaterThan(0);
  }, 1_800_000);
});
