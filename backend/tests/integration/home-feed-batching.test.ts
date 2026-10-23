/**
 * Home feed batching (catalog.service getHomeFeed): the feed is now built in
 * three database rounds — every rail's candidates at once, the category
 * shelves a few at a time, and ONE batched hydration of every product shown —
 * instead of one rail after another, each with its own hydration.
 *
 * The output must be exactly what the previous one-rail-at-a-time algorithm
 * produced. `referenceFeed` below rebuilds it that way from the same
 * repository queries and compares, across: an empty catalogue, a large one
 * (two hydration batches), and a tiny one where later rails must repeat
 * products. Plus the business rules: only live marketplace sellers, only
 * in-stock available listings, no location dependence, live data (no cache).
 *
 * POPULAR is ordered by RANDOM() in SQL; here its candidates are made stable
 * (every eligible product, sorted by id) so both builds see identical input.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStatus, CodPolicy, ProductStatus, UnitType, type HomeFeedDto } from '../../src/shared';
import { api, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as repository from '../../src/modules/catalog/catalog.repository';
import { getHomeFeed, invalidateCategoryCache, mapProducts } from '../../src/modules/catalog/catalog.service';
import { balanceBySubcategory } from '../../src/modules/catalog/home-selection';
import { STORE_COORDS, NEARBY, sellerLifecycleFields } from '../helpers/fixtures';

/* -------------------------------------------------------------------------- */
/* Catalogue builders                                                          */
/* -------------------------------------------------------------------------- */

let sellerNo = 0;
async function seller(
  name: string,
  options: { active?: boolean; type?: 'RESTAURANT' | 'CAFE'; approval?: ApprovalStatus } = {},
): Promise<string> {
  sellerNo += 1;
  const created = await prisma.seller.create({
    data: {
      code: `BATCH-${sellerNo}`,
      name,
      ...sellerLifecycleFields(options.approval ?? ApprovalStatus.APPROVED),
      addressLine: 'Main Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: 'Asia/Kolkata',
      isActive: options.active ?? true,
      allowCod: CodPolicy.ALLOW,
      ...(options.type ? { sellerType: options.type } : {}),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: created.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  return created.id;
}

async function category(sellerId: string, path: string, parentId: string | null = null): Promise<string> {
  const name = path.split('/').pop()!;
  const created = await prisma.category.create({
    data: { sellerId, parentId, name, slug: name, path, depth: path.split('/').length - 1 },
  });
  return created.id;
}

let productNo = 0;
async function product(
  sellerId: string,
  categoryId: string,
  options: { stockQty?: number; available?: boolean; discount?: boolean; essential?: boolean } = {},
): Promise<string> {
  productNo += 1;
  const slug = `batch-product-${productNo}`;
  const created = await prisma.product.create({
    data: {
      name: `Batch Product ${productNo}`,
      slug,
      categoryId,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      taxRateBp: 0,
      allowCod: CodPolicy.INHERIT,
      searchKeywords: [],
      isDailyEssential: options.essential ?? false,
      popularityScore: (productNo * 37) % 101,
      createdAt: new Date(Date.UTC(2026, 0, 1) + productNo * 60_000),
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: created.id, sku: slug.toUpperCase(), variantName: '1 kg', unit: UnitType.KG, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  const price = 5_000 + (productNo % 13) * 100;
  await prisma.sellerListing.create({
    data: {
      sellerId,
      variantId: variant.id,
      pricePaise: price,
      mrpPaise: options.discount ? price + 1_000 : price,
      stockQty: options.stockQty ?? 40,
      maxQtyPerOrder: 10,
      isAvailable: options.available ?? true,
    },
  });
  return created.id;
}

/* -------------------------------------------------------------------------- */
/* The previous algorithm, rebuilt from the same queries (the reference)       */
/* -------------------------------------------------------------------------- */

const RAIL_ORDER = ['DAILY_ESSENTIALS', 'OFFERS', 'BEST_SELLERS', 'RECENTLY_ADDED', 'TOP_PICKS', 'POPULAR'] as const;

async function referenceFeed(feed: HomeFeedDto): Promise<Pick<HomeFeedDto, 'rails' | 'categoryRails'>> {
  // Rails: one at a time, each skipping what an earlier rail used unless fewer
  // than 4 would be left, each hydrated on its own.
  const used = new Set<string>();
  const rails: { key: string; products: unknown[] }[] = [];
  for (const key of RAIL_ORDER) {
    const candidateIds = await repository.listRailProductIds(key, 40);
    const fresh = candidateIds.filter((id) => !used.has(id)).slice(0, 10);
    const ids = fresh.length >= 4 ? fresh : candidateIds.slice(0, 10);
    for (const id of ids) used.add(id);
    const products = await mapProducts(await repository.hydrateProducts(ids));
    if (products.length > 0) rails.push({ key, products });
  }
  // Shelves: one per Home category (in Home order), balanced across subcategories.
  const categoryRails: HomeFeedDto['categoryRails'] = [];
  for (const top of feed.categories) {
    const { path } = await prisma.category.findUniqueOrThrow({ where: { id: top.id } });
    const ids = balanceBySubcategory(await repository.listCategoryShelfCandidates(path, 80), path, 10);
    const products = await mapProducts(await repository.hydrateProducts(ids));
    if (products.length > 0) categoryRails.push({ categoryId: top.id, title: top.name, products });
  }
  return { rails: rails as HomeFeedDto['rails'], categoryRails };
}

const railView = (feed: Pick<HomeFeedDto, 'rails'>) => feed.rails.map((rail) => ({ key: rail.key, products: rail.products }));
const shownIds = (feed: HomeFeedDto) => [
  ...feed.rails.flatMap((rail) => rail.products.map((p) => p.id)),
  ...feed.categoryRails.flatMap((shelf) => shelf.products.map((p) => p.id)),
];

/** Counts the SQL statements of one getHomeFeed call (Prisma query events; tests are not production). */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const listener = (event: { query: string }) => seen.push(event.query);
  (prisma as unknown as { $on: (e: string, cb: typeof listener) => void }).$on('query', listener);
  try {
    await run();
  } finally {
    seen.push('__end__');
  }
  return seen.slice(0, seen.indexOf('__end__'));
}

/* -------------------------------------------------------------------------- */

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  invalidateCategoryCache();
  const realListRail = repository.listRailProductIds;
  vi.spyOn(repository, 'listRailProductIds').mockImplementation(async (rail, limit, client) =>
    rail === 'POPULAR'
      ? (await realListRail(rail, 10_000, client)).sort().slice(0, limit)
      : realListRail(rail, limit, client),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Home feed — batched build gives the same feed as the one-rail-at-a-time build', () => {
  it('an empty catalogue: no rails, no shelves, no categories, no error', async () => {
    const feed = await getHomeFeed();
    expect(feed.rails).toEqual([]);
    expect(feed.categoryRails).toEqual([]);
    expect(feed.categories).toEqual([]);
  });

  it('a large catalogue (two hydration batches): identical rails and shelves; only live, in-stock products', async () => {
    const live = await seller('Live A');
    const liveB = await seller('Live B');
    const off = await seller('Switched off', { active: false });
    const pending = await seller('Not approved', { approval: ApprovalStatus.PENDING });
    const restaurant = await seller('Restaurant', { type: 'RESTAURANT' });

    const hidden = new Set<string>();
    for (let t = 0; t < 12; t += 1) {
      const owner = t % 2 === 0 ? live : liveB;
      const top = await category(owner, `top-${t}`);
      const subs = [await category(owner, `top-${t}/one`, top), await category(owner, `top-${t}/two`, top)];
      for (let k = 0; k < 11; k += 1) {
        await product(owner, subs[k % 2]!, { discount: k % 3 === 0, essential: k % 4 === 0 });
      }
      hidden.add(await product(owner, subs[0]!, { stockQty: 0 })); // out of stock
      hidden.add(await product(owner, subs[1]!, { available: false })); // switched off listing
    }
    for (const excluded of [off, pending, restaurant]) {
      const top = await category(excluded, 'top-0');
      for (let k = 0; k < 3; k += 1) hidden.add(await product(excluded, top, { discount: true, essential: true }));
    }

    await getHomeFeed(); // warm caches, as on a live server
    let feed!: HomeFeedDto;
    const statements = await statementsOf(async () => {
      feed = await getHomeFeed();
    });
    const reference = await referenceFeed(feed);

    expect(railView(feed)).toEqual(railView(reference));
    expect(feed.categoryRails).toEqual(reference.categoryRails);
    expect(feed.categories.length).toBe(12);

    // Business rules held.
    const shown = new Set(shownIds(feed));
    for (const id of hidden) expect(shown.has(id)).toBe(false);
    const inRails = feed.rails.flatMap((rail) => rail.products.map((p) => p.id));
    expect(new Set(inRails).size).toBe(inRails.length); // a big catalogue never needs a repeat
    for (const rail of feed.rails) expect(rail.products.length).toBeLessThanOrEqual(10);

    // The products were hydrated in batches of at most 100, not once per rail.
    const hydrations = statements.filter((sql) => /FROM "public"\."products" WHERE "public"\."products"\."id" IN/.test(sql)).length;
    expect(shown.size).toBeGreaterThan(100);
    expect(hydrations).toBe(Math.ceil(shown.size / 100));
    expect(statements.length).toBeLessThanOrEqual(6 + feed.categories.length + 7 * hydrations + 8);
  });

  it('a tiny catalogue: later rails repeat products exactly as before (a repeat beats a near-empty rail)', async () => {
    const live = await seller('Small shop');
    const top = await category(live, 'grocery');
    const sub = await category(live, 'grocery/rice', top);
    for (let k = 0; k < 5; k += 1) await product(live, sub, { discount: true, essential: true });

    const feed = await getHomeFeed();
    const reference = await referenceFeed(feed);
    expect(railView(feed)).toEqual(railView(reference));
    expect(feed.categoryRails).toEqual(reference.categoryRails);

    const inRails = feed.rails.flatMap((rail) => rail.products.map((p) => p.id));
    expect(new Set(inRails).size).toBeLessThan(inRails.length); // repeats happen
  });

  it('is not filtered by location: GET /home with and without coordinates is identical', async () => {
    const live = await seller('Local shop');
    const top = await category(live, 'grocery');
    for (let k = 0; k < 6; k += 1) await product(live, top, { essential: true });

    const plain = expectSuccess<HomeFeedDto>((await api().get('/api/v1/home').expect(200)).body).data;
    const near = expectSuccess<HomeFeedDto>(
      (await api().get(`/api/v1/home?lat=${NEARBY.latitude}&lng=${NEARBY.longitude}`).expect(200)).body,
    ).data;
    const far = expectSuccess<HomeFeedDto>((await api().get('/api/v1/home?lat=26.9124&lng=75.7873').expect(200)).body).data;
    expect(near).toEqual(plain);
    expect(far).toEqual(plain);
  });

  it('concurrent Home requests each get the complete feed; no request shares or leaks state into another', async () => {
    const live = await seller('Busy shop');
    const liveB = await seller('Busy shop B');
    const off = await seller('Switched off', { active: false });
    const hidden = new Set<string>();
    for (let t = 0; t < 6; t += 1) {
      const owner = t % 2 === 0 ? live : liveB;
      const top = await category(owner, `busy-${t}`);
      const sub = await category(owner, `busy-${t}/one`, top);
      for (let k = 0; k < 8; k += 1) await product(owner, sub, { discount: k % 2 === 0, essential: k % 3 === 0 });
      hidden.add(await product(owner, sub, { stockQty: 0 }));
    }
    const offTop = await category(off, 'busy-0');
    hidden.add(await product(off, offTop, { discount: true, essential: true }));

    // A deep copy: the baseline must not share a single object with any response.
    const single = structuredClone(await getHomeFeed());
    const feeds = await Promise.all(Array.from({ length: 8 }, () => getHomeFeed()));

    for (const feed of feeds) {
      expect(feed).toEqual(single); // same rails, order, de-duplication, shelves, categories
      const inRails = feed.rails.flatMap((rail) => rail.products.map((p) => p.id));
      expect(new Set(inRails).size).toBe(inRails.length);
      for (const id of shownIds(feed)) expect(hidden.has(id)).toBe(false);
    }

    // Each response is its own object graph: changing one never changes another, or the next call.
    feeds[0]!.rails[0]!.products.length = 0;
    feeds[0]!.categories[0]!.name = 'changed by one request';
    expect(feeds[1]).toEqual(single);
    expect(await getHomeFeed()).toEqual(single);
  });

  it('reads stock and seller availability live on every call (nothing cached)', async () => {
    const live = await seller('Live shop');
    const top = await category(live, 'grocery');
    for (let k = 0; k < 5; k += 1) await product(live, top, { essential: true });
    const before = new Set(shownIds(await getHomeFeed()));
    expect(before.size).toBe(5);

    // One product sells out, then the whole seller is switched off.
    const [first] = [...before];
    await prisma.sellerListing.updateMany({ where: { variant: { productId: first } }, data: { stockQty: 0 } });
    expect(shownIds(await getHomeFeed())).not.toContain(first);

    await prisma.seller.update({ where: { id: live }, data: { isActive: false } });
    const after = await getHomeFeed();
    expect(after.rails).toEqual([]);
    expect(after.categoryRails).toEqual([]);
  });
});
