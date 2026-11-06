/**
 * Smart Search performance benchmark — runs only with PERF=1:
 *
 *   PERF=1 npx vitest run tests/perf/smart-search-perf.test.ts
 *   PERF=1 SEARCH_PERF_PRODUCTS=20000 npx vitest run tests/perf/smart-search-perf.test.ts
 *
 * Seeds a catalogue built from the real Aadione naming style (English name +
 * Hindi in brackets, brands, sizes) across several sellers, indexes it, then
 * measures: indexing throughput, GET /products/search latency (median / p95
 * over repeated runs, after a warm-up), the engine alone, and EXPLAIN ANALYZE
 * of representative queries — asserting the trigram / btree indexes are used.
 * Local PostgreSQL: the numbers exclude the production network round trip.
 * Writes PERF_OUT (default smart-search-perf.json).
 */

import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStatus } from '../../src/shared';
import { api, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { reindexStaleProducts, searchProductIds } from '../../src/infra/search';
import { cache } from '../../src/infra/cache';
import { marketplaceSearchScope } from '../../src/modules/catalog/product-search-scope';
import { analyzeSearchQuery } from '../../src/shared/search-match';

const PRODUCTS = Number(process.env['SEARCH_PERF_PRODUCTS'] ?? 5000);
const RUNS = 9;
const OUT = process.env['PERF_OUT'] ?? 'smart-search-perf.json';

const BASES: [string, string][] = [
  ['Banana', 'केला'], ['Potato', 'आलू'], ['Tomato', 'टमाटर'], ['Onion', 'प्याज'], ['Apple', 'सेब'], ['Milk', 'दूध'],
  ['Curd', 'दही'], ['Rice', 'चावल'], ['Ginger', 'अदरक'], ['Garlic', 'लहसुन'], ['Spinach', 'पालक'], ['Carrot', 'गाजर'],
  ['Cauliflower', 'फूलगोभी'], ['Cabbage', 'पत्तागोभी'], ['Okra', 'भिंडी'], ['Peas', 'मटर'], ['Lemon', 'नींबू'], ['Mango', 'आम'],
  ['Papaya', 'पपीता'], ['Guava', 'अमरूद'], ['Turmeric Powder', 'हल्दी पाउडर'], ['Chilli Powder', 'मिर्च पाउडर'],
  ['Moong Dal', 'मूंग दाल'], ['Toor Dal', 'तूर दाल'], ['Masoor Dal', 'मसूर दाल'], ['Sugar', 'चीनी'], ['Salt', 'नमक'],
  ['Mustard Oil', 'सरसों का तेल'], ['Soyabean Oil', 'सोयाबीन तेल'], ['Atta', 'आटा'], ['Suji', 'सूजी'], ['Besan', 'बेसन'],
  ['Bhujia', 'भुजिया'], ['Namkeen Mix', 'नमकीन मिक्स'], ['Rasgulla', 'रसगुल्ला'], ['Paneer', 'पनीर'], ['Ghee', 'घी'],
  ['Toothpaste', 'टूथपेस्ट'], ['Detergent Powder', 'डिटर्जेंट पाउडर'], ['Agarbatti', 'अगरबत्ती'],
];
const BRANDS = ['', 'Fresh', 'Desi', 'Organic', 'Bikaji', 'Tata', 'Amul', 'SPL', 'Mahakosh', 'Vim', 'Colgate', 'Patanjali'];
const SIZES = ['250 g', '500 g', '1 kg', '2 kg', '5 kg', 'Pack of 6', '1 L', '200 ml'];

const QUERIES = ['banana', 'kela', 'केला', 'banna', 'aloo', 'आलू', 'tamat ar', 'pyaaj', 'doodh', 'ban', 'tom', 'moong dal', 'bikaji bhujia', 'xyzzy', 'sarson tel'];

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)]!;

describe.skipIf(!process.env['PERF'])('smart search performance', () => {
  const report: Record<string, unknown> = { products: PRODUCTS };

  beforeAll(async () => {
    await truncateAll();
    const sellers: string[] = [];
    for (let s = 0; s < 4; s += 1) {
      const seller = await prisma.seller.create({
        data: {
          code: `PERF-${s}`,
          name: `Perf Store ${s}`,
          sellerType: 'GROCERY',
          ...sellerLifecycleFields(ApprovalStatus.APPROVED),
          addressLine: 'Main Road',
          city: 'Railmagra',
          state: 'Rajasthan',
          pincode: '313329',
          latitude: 27.6,
          longitude: 75.1,
          isActive: true,
        },
      });
      sellers.push(seller.id);
    }
    const top = await prisma.category.create({ data: { name: 'Grocery', slug: 'grocery', path: 'grocery', depth: 0 } });
    const subs: string[] = [];
    for (const name of ['Vegetables', 'Fruits', 'Atta Rice & Dal', 'Masala', 'Snacks', 'Home Care']) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      subs.push((await prisma.category.create({ data: { name, slug, path: `grocery/${slug}`, depth: 1, parentId: top.id } })).id);
    }

    const ids: string[] = [];
    const names: string[] = [];
    const namesHi: string[] = [];
    const categories: string[] = [];
    for (let i = 0; i < PRODUCTS; i += 1) {
      const [en, hi] = BASES[i % BASES.length]!;
      const brand = BRANDS[Math.floor(i / BASES.length) % BRANDS.length]!;
      const size = SIZES[Math.floor(i / (BASES.length * BRANDS.length)) % SIZES.length]!;
      ids.push(randomUUID());
      names.push(`${brand ? `${brand} ` : ''}${en} ${size} #${i} (${hi})`);
      namesHi.push(hi);
      categories.push(subs[i % subs.length]!);
    }
    const CHUNK = 2000;
    for (let start = 0; start < PRODUCTS; start += CHUNK) {
      const slice = (a: string[]) => a.slice(start, start + CHUNK);
      await prisma.$executeRaw`
        INSERT INTO products (id, category_id, name, name_hi, slug, search_keywords, status, approval_status, attributes, option_groups, updated_at)
        SELECT id, cat, name, hi, 'perf-' || id, ARRAY[]::text[], 'ACTIVE', 'APPROVED', '{}', '[]', now()
        FROM unnest(${slice(ids)}::uuid[], ${slice(categories)}::uuid[], ${slice(names)}::text[], ${slice(namesHi)}::text[]) AS t(id, cat, name, hi)`;
      await prisma.$executeRaw`
        INSERT INTO product_variants (id, product_id, sku, variant_name, is_default, status, updated_at)
        SELECT gen_random_uuid(), id, 'PERF-' || id, '1 kg', true, 'ACTIVE', now() FROM unnest(${slice(ids)}::uuid[]) AS t(id)`;
    }
    await prisma.$executeRaw`
      INSERT INTO seller_listings (id, seller_id, variant_id, mrp_paise, price_paise, stock_qty, is_available, updated_at)
      SELECT gen_random_uuid(), (${sellers}::uuid[])[1 + (abs(hashtext(v.id::text)) % 4)], v.id, 6000, 5000, 25, true, now()
      FROM product_variants v WHERE v.sku LIKE 'PERF-%'`;
    await prisma.$executeRawUnsafe('ANALYZE');
  }, 600_000);

  it('indexes the catalogue in batches', async () => {
    const started = performance.now();
    const result = await reindexStaleProducts({ maxBatches: 10_000 });
    const ms = performance.now() - started;
    await prisma.$executeRawUnsafe('ANALYZE product_search_terms');
    const terms = await prisma.productSearchTerm.count();
    report['indexing'] = { ms: Math.round(ms), productsPerSecond: Math.round((result.indexed / ms) * 1000), terms, termsPerProduct: +(terms / PRODUCTS).toFixed(1) };
    expect(result.indexed).toBe(PRODUCTS);
  }, 600_000);

  it('answers customer searches quickly', async () => {
    const http: Record<string, { medianMs: number; p95Ms: number; results: number }> = {};
    const engine: Record<string, number> = {};
    for (const q of QUERIES) {
      const url = `/api/v1/products/search?q=${encodeURIComponent(q)}&limit=20`;
      // The API's per-IP limit (120/min, routes/index.ts) is not what is measured here.
      await cache.clear();
      await api().get(url).expect(200); // warm-up
      const times: number[] = [];
      let results = 0;
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        const res = await api().get(url).expect(200);
        times.push(performance.now() - started);
        results = expectSuccess<{ items: unknown[] }>(res.body).data.items.length;
      }
      http[q] = { medianMs: Math.round(median(times)), p95Ms: Math.round(p95(times)), results };

      const engineTimes: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        await searchProductIds({ query: q, where: marketplaceSearchScope(), limit: 21 });
        engineTimes.push(performance.now() - started);
      }
      engine[q] = Math.round(median(engineTimes));
    }
    report['httpSearch'] = http;
    report['engineOnlyMedianMs'] = engine;
    expect(http['xyzzy']?.results).toBe(0);
    expect(http['kela']?.results).toBeGreaterThan(0);
  }, 600_000);

  it('uses the search indexes (EXPLAIN ANALYZE)', async () => {
    const plans: Record<string, { executionMs: number; indexes: string[] }> = {};
    for (const q of ['kela', 'banna', 'moong dal']) {
      const query = analyzeSearchQuery(q);
      const termValues = [...new Set(query.probes.filter((p) => p.kind === 'term').map((p) => p.value))];
      const keyValues = [...new Set(query.probes.filter((p) => p.kind === 'key' || p.kind === 'syn').map((p) => p.value))];
      const fuzzy = query.probes.filter((p) => p.kind === 'fuzzy').map((p) => Prisma.sql`t.key % ${p.value}`);
      const prefix = query.probes.filter((p) => p.kind === 'prefix').map((p) => Prisma.sql`t.term LIKE ${`${p.value}%`}`);
      const rows = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT t.product_id FROM product_search_terms t
        WHERE t.term = ANY(${termValues}::varchar[]) OR t.key = ANY(${keyValues}::varchar[])
          ${fuzzy.length ? Prisma.sql`OR ${Prisma.join(fuzzy, ' OR ')}` : Prisma.empty}
          ${prefix.length ? Prisma.sql`OR ${Prisma.join(prefix, ' OR ')}` : Prisma.empty}`;
      const text = rows.map((r) => r['QUERY PLAN']).join('\n');
      const indexes = [...new Set([...text.matchAll(/Index Scan on (\w+)/g)].map((m) => m[1]!))];
      plans[q] = { executionMs: Number(/Execution Time: ([\d.]+)/.exec(text)?.[1] ?? NaN), indexes };
      expect(text, text).not.toMatch(/Seq Scan on product_search_terms/);
    }
    report['candidatePlans'] = plans;
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }, 600_000);
});
