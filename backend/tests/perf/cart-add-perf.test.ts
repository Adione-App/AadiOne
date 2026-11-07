/**
 * Add-to-cart timing (QA only, PERF=1): POST /cart/items for a NEW line and
 * for one already in the cart, through the in-process API, with the number
 * of SQL statements each costs. Run with the database behind a latency proxy
 * (DATABASE_URL on :55433) so every statement costs a production-like round
 * trip (Railway Singapore → Supabase Mumbai); writes PERF_OUT, with the
 * statements of the first new-line add (the cleanup DELETE is not counted).
 *   PERF=1 DATABASE_URL=…:55433/adione_test npx vitest run tests/perf/cart-add-perf.test.ts
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStatus } from '../../src/shared';
import { api, bearer, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { STORE_COORDS, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const RUNS = 5;
const OUT = process.env['PERF_OUT'] ?? 'cart-add-perf.json';
const MOBILE = '9876500077';
let queries = 0;
let statementLog: string[] = [];
(prisma as unknown as { $on: (event: 'query', cb: (e: { query: string }) => void) => void }).$on('query', (e) => {
  queries += 1;
  statementLog.push(e.query.replace(/\s+/g, ' ').slice(0, 110));
});
const median = (xs: number[]) => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!);

describe.skipIf(!process.env['PERF'])('add to cart timing', () => {
  let token = '';
  const listings: string[] = [];

  beforeAll(async () => {
    await truncateAll();
    await configService.invalidateAll();
    await cache.clear();
    const seller = await prisma.seller.create({
      data: {
        code: `CAP-${randomUUID().slice(0, 6)}`,
        name: 'Cart Perf Store',
        sellerType: 'GROCERY',
        addressLine: 'Station Road',
        city: 'Sikar',
        state: 'Rajasthan',
        pincode: '332001',
        ...STORE_COORDS,
        timezone: 'Asia/Kolkata',
        isActive: true,
        ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      },
    });
    await prisma.sellerHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '00:00', isClosed: false })),
    });
    // A realistic cart: a few lines already in it, so the cart rebuild in the answer has work to do.
    for (let i = 0; i < 4; i += 1) {
      const p = await seedProduct(seller.id, { name: `Perf item ${i}`, pricePaise: 5000 + i, mrpPaise: 6000, stockQty: 100 });
      listings.push(p!.storeVariantId);
    }
    await otpService.clearOtpState(MOBILE);
    token = (await loginAs(MOBILE)).accessToken;
    for (const listing of listings.slice(1)) {
      await api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId: listing, qty: 1 }).expect(200);
    }
  }, 120_000);

  it('times a new line and an existing one', async () => {
    const add = (sellerListingId: string) =>
      api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId, qty: 1 });
    const result: Record<string, { medianMs: number; samplesMs: number[]; statements: number }> = {};

    // New line: add, then remove it again (not timed) so every run is a first add.
    const fresh: number[] = [];
    let firstAddStatements: string[] = [];
    let freshStatements = 0;
    for (let run = 0; run < RUNS; run += 1) {
      queries = 0;
      statementLog = [];
      const started = performance.now();
      const res = await add(listings[0]!).expect(200);
      if (run === 0) firstAddStatements = [...statementLog];
      fresh.push(performance.now() - started);
      freshStatements = queries;
      const line = (res.body.data.items as { id: string; sellerListingId: string }[]).find((item) => item.sellerListingId === listings[0]);
      await api().delete(`/api/v1/cart/items/${line!.id}`).set('Authorization', bearer(token)).expect(200);
    }
    result['newLine'] = { medianMs: median(fresh), samplesMs: fresh.map(Math.round), statements: freshStatements };

    const again: number[] = [];
    let againStatements = 0;
    for (let run = 0; run < RUNS; run += 1) {
      queries = 0;
      const started = performance.now();
      await add(listings[1]!).expect(200);
      again.push(performance.now() - started);
      againStatements = queries;
    }
    result['existingLine'] = { medianMs: median(again), samplesMs: again.map(Math.round), statements: againStatements };

    const out = { databaseUrlPort: new URL(process.env['DATABASE_URL']!).port, ...result, firstAddStatements };
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    expect(result['newLine']!.statements).toBeGreaterThan(0);
  }, 300_000);
});
