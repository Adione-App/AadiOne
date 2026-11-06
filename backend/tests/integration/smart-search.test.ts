/**
 * Smart Search, end to end against PostgreSQL:
 *
 *   - customer GET /products/search finds a product by English (and its
 *     typos), Hindi, Hinglish and partial words, exact matches first, and
 *     nothing for unrelated words;
 *   - only what the customer could browse (published, approved, live seller,
 *     live category, not a restaurant dish), with the in-stock filter and
 *     keyset pagination intact, every product once;
 *   - the index follows the catalogue: a new product is searchable at once,
 *     a renamed one stops matching its old name before it is even re-indexed,
 *     a deleted one disappears, a category / brand rename requeues products,
 *     the backfill is repeatable and concurrent rebuilds never corrupt rows;
 *   - the admin product list (permission-checked) and the seller / admin order
 *     lists use the same engine, a seller only ever finding its own orders;
 *   - customer Food search finds restaurants by name, cuisine and dish.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ProductStatus, UnitType, UserRole, type ProductSummaryDto } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedStore, sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { reindexProducts, reindexStaleProducts, searchProductIds } from '../../src/infra/search';
import { runSearchBackfill } from '../../src/infra/search/backfill';
import { marketplaceSearchScope, sellerOwnSearchScope } from '../../src/modules/catalog/product-search-scope';
import { listSellerOrders } from '../../src/modules/orders/seller-order.service';
import { listOrders } from '../../src/modules/admin/admin-order.service';

const ADMIN = { mobile: '9400000971', email: 'search-admin@adione.test', password: 'TestAdmin@123' };

let seq = 0;
let storeId: string;
let fruits: string;
let vegetables: string;

async function category(name: string, options: { parentId?: string | null; sellerId?: string | null; isActive?: boolean } = {}): Promise<string> {
  seq += 1;
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${seq}`;
  const parent = options.parentId ? await prisma.category.findUniqueOrThrow({ where: { id: options.parentId } }) : null;
  const row = await prisma.category.create({
    data: {
      name,
      slug,
      path: parent ? `${parent.path}/${slug}` : slug,
      depth: parent ? 1 : 0,
      parentId: options.parentId ?? null,
      sellerId: options.sellerId ?? null,
      isActive: options.isActive ?? true,
    },
  });
  return row.id;
}

async function product(
  name: string,
  options: {
    nameHi?: string;
    keywords?: string[];
    categoryId?: string;
    sellerId?: string;
    stockQty?: number;
    approval?: ApprovalStatus;
    status?: ProductStatus;
    submittedBySellerId?: string | null;
  } = {},
): Promise<{ productId: string; variantId: string; listingId: string }> {
  seq += 1;
  const row = await prisma.product.create({
    data: {
      name,
      nameHi: options.nameHi ?? null,
      slug: `p-${seq}`,
      categoryId: options.categoryId ?? fruits,
      status: options.status ?? ProductStatus.ACTIVE,
      approvalStatus: options.approval ?? ApprovalStatus.APPROVED,
      searchKeywords: options.keywords ?? [],
      submittedBySellerId: options.submittedBySellerId ?? null,
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: row.id, sku: `SKU-${seq}-${randomUUID().slice(0, 6)}`, variantName: '1 kg', unit: UnitType.KG, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  const listing = await prisma.sellerListing.create({
    data: { sellerId: options.sellerId ?? storeId, variantId: variant.id, mrpPaise: 6000, pricePaise: 5000, stockQty: options.stockQty ?? 20, isAvailable: true },
  });
  return { productId: row.id, variantId: variant.id, listingId: listing.id };
}

async function seller(name: string, sellerType: 'GROCERY' | 'RESTAURANT' = 'GROCERY', options: { isActive?: boolean; cuisine?: string[] } = {}): Promise<string> {
  seq += 1;
  const row = await prisma.seller.create({
    data: {
      code: `S-${seq}`,
      name,
      sellerType,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      addressLine: 'Main Road',
      city: 'Railmagra',
      state: 'Rajasthan',
      pincode: '313329',
      latitude: 27.6094,
      longitude: 75.1399,
      isActive: options.isActive ?? true,
    },
  });
  if (sellerType === 'RESTAURANT') {
    await prisma.restaurantProfile.create({ data: { sellerId: row.id, cuisine: options.cuisine ?? [] } });
  }
  return row.id;
}

type Page = { items: ProductSummaryDto[]; nextCursor: string | null; hasMore: boolean };
async function search(q: string, extra = ''): Promise<Page> {
  return expectSuccess<Page>((await api().get(`/api/v1/products/search?q=${encodeURIComponent(q)}${extra}`).expect(200)).body).data;
}
const names = async (q: string, extra = '') => (await search(q, extra)).items.map((item) => item.name);

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

let orderSeq = 0;
async function orderOf(sellerId: string, line: { variantId: string; listingId: string; productName: string }, customerName = 'Customer') {
  orderSeq += 1;
  const customer = await prisma.user.create({ data: { mobile: `95100${String(orderSeq).padStart(5, '0')}`, fullName: customerName, role: UserRole.CUSTOMER } });
  const order = await prisma.order.create({
    data: {
      orderNumber: `AD2611${String(orderSeq).padStart(6, '0')}`,
      userId: customer.id,
      status: 'PROCESSING',
      paymentMethod: 'COD',
      itemsSubtotalPaise: 5000,
      totalPaise: 5000,
      currentPayablePaise: 5000,
      deliveryFullName: customerName,
      deliveryMobile: customer.mobile!,
      deliveryAddressLine: 'Main Road',
      deliveryCity: 'Railmagra',
      deliveryState: 'Rajasthan',
      deliveryPincode: '313329',
      deliveryLatitude: 27.62,
      deliveryLongitude: 75.14,
      distanceKm: 1,
      placedAt: new Date(),
    },
  });
  const sellerOrder = await prisma.sellerOrder.create({
    data: { orderId: order.id, sellerId, status: 'ACCEPTED', subtotalPaise: 5000, commissionBp: 0, commissionPaise: 0 },
  });
  await prisma.orderItem.create({
    data: {
      sellerOrderId: sellerOrder.id,
      variantId: line.variantId,
      sellerListingId: line.listingId,
      productName: line.productName,
      variantName: '1 kg',
      sku: 'X',
      unitDisplay: '1 kg',
      qty: 1,
      mrpPaise: 6000,
      unitPricePaise: 5000,
      lineTotalPaise: 5000,
    },
  });
  return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: sellerOrder.id };
}

beforeEach(async () => {
  await truncateAll();
  storeId = await seedStore();
  const top = await category('Vegetables & Fruits', { sellerId: storeId });
  fruits = await category('Fruits', { parentId: top, sellerId: storeId });
  vegetables = await category('Vegetables', { parentId: top, sellerId: storeId });
});

/** The real catalogue's naming style: English with the Hindi in brackets. */
async function seedCatalogue() {
  const ids = {
    banana: await product('Banana (केला)', { nameHi: 'केला' }),
    rawBanana: await product('Raw Banana (कच्चा केला)', { nameHi: 'कच्चा केला', categoryId: vegetables }),
    potato: await product('Potato (आलू)', { nameHi: 'आलू', categoryId: vegetables }),
    tomato: await product('Tomato (टमाटर)', { nameHi: 'टमाटर', categoryId: vegetables }),
    onion: await product('Onion (प्याज)', { nameHi: 'प्याज', categoryId: vegetables }),
    apple: await product('Imported Apple (इम्पोर्टेड सेब)', { nameHi: 'इम्पोर्टेड सेब' }),
    milk: await product('Amul Taaza Milk', { categoryId: vegetables }),
    curd: await product('Curd'),
    rice: await product('Rice'),
    bhujia: await product('Bikaji Bikaneri Bhujia'),
    shirt: await product('Urban Cotton Shirt'),
  };
  await reindexStaleProducts();
  return ids;
}

describe('customer product search — languages, typos, ranking', () => {
  it('finds Banana by English, its typos, Hindi and Hinglish — the exact product first', async () => {
    await seedCatalogue();
    for (const q of ['Banana', 'banana', 'banna', 'baanana', 'bananna', 'bananaa', 'केला', 'kela', 'keela', 'kelaa', 'kayla']) {
      const found = await names(q);
      expect(found[0], `query "${q}" -> ${JSON.stringify(found)}`).toBe('Banana (केला)');
      expect(found).not.toContain('Urban Cotton Shirt');
    }
  });

  it('maps the Hindi, Hinglish and English names of everyday items to each other', async () => {
    await seedCatalogue();
    const cases: [string, string][] = [
      ['आलू', 'Potato (आलू)'],
      ['aloo', 'Potato (आलू)'],
      ['alu', 'Potato (आलू)'],
      ['टमाटर', 'Tomato (टमाटर)'],
      ['tamatar', 'Tomato (टमाटर)'],
      ['tamat ar', 'Tomato (टमाटर)'],
      ['pyaj', 'Onion (प्याज)'],
      ['pyaaj', 'Onion (प्याज)'],
      ['प्याज', 'Onion (प्याज)'],
      ['doodh', 'Amul Taaza Milk'],
      ['dud', 'Amul Taaza Milk'],
      ['दूध', 'Amul Taaza Milk'],
      ['seb', 'Imported Apple (इम्पोर्टेड सेब)'],
      ['saib', 'Imported Apple (इम्पोर्टेड सेब)'],
      ['सेब', 'Imported Apple (इम्पोर्टेड सेब)'],
      ['dahi', 'Curd'],
      ['दही', 'Curd'],
      ['chawal', 'Rice'],
      ['chaal', 'Rice'],
      ['चावल', 'Rice'],
    ];
    for (const [q, expected] of cases) {
      const found = await names(q);
      expect(found[0], `query "${q}" -> ${JSON.stringify(found)}`).toBe(expected);
    }
  });

  it('completes partial words', async () => {
    await seedCatalogue();
    expect((await names('ban'))[0]).toBe('Banana (केला)');
    expect(await names('ban')).not.toContain('Urban Cotton Shirt');
    expect((await names('tom'))[0]).toBe('Tomato (टमाटर)');
    expect((await names('pot'))[0]).toBe('Potato (आलू)');
  });

  it('ranks an exact match above any fuzzy one and returns nothing for unrelated words', async () => {
    const exact = await product('Banana');
    const fuzzy = await product('Bandana Scarf');
    await reindexStaleProducts();

    const hits = await searchProductIds({ query: 'banana', where: marketplaceSearchScope(), limit: 10 });
    expect(hits[0]?.productId).toBe(exact.productId);
    const exactTier = hits.find((h) => h.productId === exact.productId)!.tier;
    const fuzzyHit = hits.find((h) => h.productId === fuzzy.productId);
    if (fuzzyHit) expect(fuzzyHit.tier).toBeLessThan(exactTier);
    expect(exactTier).toBe(8);

    for (const q of ['xyzzy', 'qwerty', 'laptop', 'zz']) expect(await names(q), q).toEqual([]);
  });

  it('never returns a product twice, however many of its aliases match', async () => {
    const { productId } = await product('Banana', { nameHi: 'केला', keywords: ['kela', 'Kela', 'KELA', 'केला', 'kela'] });
    await reindexStaleProducts();
    const terms = await prisma.productSearchTerm.findMany({ where: { productId, term: 'kela' } });
    expect(terms).toHaveLength(1);
    const found = await search('kela');
    expect(found.items.filter((item) => item.id === productId)).toHaveLength(1);
  });
});

describe('customer product search — visibility, filters, pagination', () => {
  it('only finds what a customer can browse', async () => {
    const visible = await product('Mango Alphonso');
    await product('Mango Pending', { approval: ApprovalStatus.PENDING });
    await product('Mango Hidden', { status: ProductStatus.INACTIVE });
    const offline = await seller('Closed Grocer', 'GROCERY', { isActive: false });
    await product('Mango Of Inactive Seller', { sellerId: offline });
    const hiddenCategory = await category('Hidden Shelf', { sellerId: storeId, isActive: false });
    await product('Mango In Hidden Category', { categoryId: hiddenCategory });
    const kitchen = await seller('Mango Kitchen', 'RESTAURANT');
    const menu = await category('Menu', { sellerId: kitchen });
    await product('Mango Lassi', { sellerId: kitchen, categoryId: menu });
    await reindexStaleProducts();

    const found = await search('mango');
    expect(found.items.map((item) => item.id)).toEqual([visible.productId]);
    // "aam" (Hindi for mango) obeys the same rules.
    expect((await search('aam')).items.map((item) => item.id)).toEqual([visible.productId]);
  });

  it('keeps the in-stock filter', async () => {
    const inStock = await product('Tomato Hybrid', { categoryId: vegetables });
    await product('Tomato Desi', { categoryId: vegetables, stockQty: 0 });
    await reindexStaleProducts();
    expect((await search('tamatar')).items).toHaveLength(2);
    expect((await search('tamatar', '&inStock=true')).items.map((item) => item.id)).toEqual([inStock.productId]);
  });

  it('pages through every match exactly once', async () => {
    const created = new Set<string>();
    for (let i = 0; i < 7; i += 1) created.add((await product(`Tomato Variety ${i}`, { categoryId: vegetables })).productId);
    await reindexStaleProducts();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const page: Page = await search('tomato', `&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.items.map((item) => item.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(created);
    // A tampered cursor falls back to the first page, never a 500.
    await api().get('/api/v1/products/search?q=tomato&cursor=bm90LWEtdXVpZA').expect(200);
  });
});

describe('search index lifecycle', () => {
  it('finds a brand-new product immediately, before it is indexed', async () => {
    await product('Guava Allahabadi');
    expect(await names('guava')).toEqual(['Guava Allahabadi']);
    await reindexStaleProducts();
    // …and, once indexed, by its Hindi / Hinglish names too.
    expect(await names('amrood')).toEqual(['Guava Allahabadi']);
  });

  it('drops a renamed product from its old name at once and indexes the new one', async () => {
    const { productId } = await product('Banana Robusta');
    await reindexStaleProducts();
    expect(await names('kela')).toEqual(['Banana Robusta']);

    await prisma.product.update({ where: { id: productId }, data: { name: 'Mango Kesar' } });
    const [row] = await prisma.$queryRaw<{ stale: boolean }[]>`SELECT search_index_stale AS stale FROM products WHERE id = ${productId}::uuid`;
    expect(row?.stale).toBe(true);
    // Stale: old terms ignored, the live name matched.
    expect(await names('kela')).toEqual([]);
    expect(await names('mango')).toEqual(['Mango Kesar']);

    await reindexStaleProducts();
    expect(await names('kela')).toEqual([]);
    expect(await names('aam')).toEqual(['Mango Kesar']);
  });

  it('removes a deleted product and all of its terms', async () => {
    const { productId } = await product('Papaya Red Lady');
    await reindexStaleProducts();
    expect(await names('papita')).toEqual(['Papaya Red Lady']);

    await prisma.product.update({ where: { id: productId }, data: { deletedAt: new Date() } });
    expect(await names('papaya')).toEqual([]);
    await reindexStaleProducts();
    expect(await prisma.productSearchTerm.count({ where: { productId } })).toBe(0);
    expect(await names('papita')).toEqual([]);

    // A hard delete cascades too.
    const second = await product('Papaya Green');
    await reindexStaleProducts();
    await prisma.productSearchTerm.count({ where: { productId: second.productId } }).then((n) => expect(n).toBeGreaterThan(0));
    await prisma.sellerListing.deleteMany({ where: { variant: { productId: second.productId } } });
    await prisma.productVariant.deleteMany({ where: { productId: second.productId } });
    await prisma.product.delete({ where: { id: second.productId } });
    expect(await prisma.productSearchTerm.count({ where: { productId: second.productId } })).toBe(0);
  });

  it('requeues products when their category or brand is renamed', async () => {
    const brand = await prisma.brand.create({ data: { name: 'Bikaji', slug: 'bikaji' } });
    const { productId } = await product('Bhujia Classic', { categoryId: fruits });
    await prisma.product.update({ where: { id: productId }, data: { brandId: brand.id } });
    await reindexStaleProducts();
    expect(await names('bikaji')).toEqual(['Bhujia Classic']);

    await prisma.brand.update({ where: { id: brand.id }, data: { name: 'Haldiram' } });
    let [row] = await prisma.$queryRaw<{ stale: boolean }[]>`SELECT search_index_stale AS stale FROM products WHERE id = ${productId}::uuid`;
    expect(row?.stale).toBe(true);
    await reindexStaleProducts();
    expect(await names('haldiram')).toEqual(['Bhujia Classic']);
    expect(await names('bikaji')).toEqual([]);

    await prisma.category.update({ where: { id: fruits }, data: { name: 'Namkeen Corner' } });
    [row] = await prisma.$queryRaw<{ stale: boolean }[]>`SELECT search_index_stale AS stale FROM products WHERE id = ${productId}::uuid`;
    expect(row?.stale).toBe(true);
    await reindexStaleProducts();
    const terms = await prisma.productSearchTerm.findMany({ where: { productId, source: 'CATEGORY' }, select: { term: true } });
    expect(terms.map((t) => t.term)).toContain('namkeen corner');
  });

  it('backfills every product and is repeatable', async () => {
    await seedCatalogue();
    await prisma.$executeRaw`UPDATE products SET search_index_stale = true`;
    await prisma.productSearchTerm.deleteMany({});

    const dry = await runSearchBackfill({ dryRun: true, batchSize: 4 });
    expect(dry.indexed).toBe(11);
    expect(await prisma.productSearchTerm.count()).toBe(0);

    const first = await runSearchBackfill({ batchSize: 4 });
    const rowsAfterFirst = await prisma.productSearchTerm.count();
    expect(first).toMatchObject({ processed: 11, indexed: 11, failedBatches: 0, staleAfter: 0 });
    expect(rowsAfterFirst).toBe(first.terms);

    const second = await runSearchBackfill({ batchSize: 3 });
    expect(second.terms).toBe(first.terms);
    expect(await prisma.productSearchTerm.count()).toBe(rowsAfterFirst);
    expect((await names('kela'))[0]).toBe('Banana (केला)');
  });

  it('survives concurrent rebuilds and edits without duplicate or stale rows', async () => {
    const { productId } = await product('Orange Nagpur');
    await Promise.all([
      reindexProducts([productId]),
      reindexProducts([productId]),
      prisma.product.update({ where: { id: productId }, data: { name: 'Pomegranate Kandhari' } }),
      reindexStaleProducts(),
      reindexProducts([productId]),
    ]);
    await reindexStaleProducts();

    const rows = await prisma.productSearchTerm.findMany({ where: { productId } });
    expect(new Set(rows.map((r) => r.term)).size).toBe(rows.length);
    expect(rows.map((r) => r.term)).toContain('pomegranate kandhari');
    expect(rows.map((r) => r.term)).not.toContain('orange nagpur');
    const [row] = await prisma.$queryRaw<{ stale: boolean }[]>`SELECT search_index_stale AS stale FROM products WHERE id = ${productId}::uuid`;
    expect(row?.stale).toBe(false);
    expect(await names('anar')).toEqual(['Pomegranate Kandhari']);
  });

  it('handles Hindi-only names and decomposed Unicode', async () => {
    await product('आलू देसी', { categoryId: vegetables });
    await reindexStaleProducts();
    expect(await names('aloo')).toEqual(['आलू देसी']);
    expect(await names('potato')).toEqual(['आलू देसी']);
    expect(await names('आलू')).toEqual(['आलू देसी']);
    // प्याज़ typed with a separate nukta (U+091C U+093C) still finds Onion.
    await product('Onion (प्याज)', { categoryId: vegetables });
    await reindexStaleProducts();
    expect(await names('प्याज़')).toContain('Onion (प्याज)');
  });
});

describe('panels share the engine — permissions and isolation', () => {
  it('admin product list matches by alias, and only for admins', async () => {
    await seedCatalogue();
    const admin = await loginAdmin();
    const res = await api().get('/api/v1/admin/marketplace/products?q=kela').set('Authorization', bearer(admin)).expect(200);
    const rows = expectSuccess<{ items: { productName: string }[] }>(res.body).data.items;
    expect(rows[0]?.productName).toBe('Banana (केला)');
    expect(rows.map((r) => r.productName)).not.toContain('Urban Cotton Shirt');

    const customer = await loginAs('9811100001');
    await api().get('/api/v1/admin/marketplace/products?q=kela').set('Authorization', bearer(customer.accessToken)).expect(403);
    await api().get('/api/v1/admin/marketplace/products?q=kela').expect(401);
  });

  it('a seller finds only its own products and orders, in any language', async () => {
    const a = await seller('Seller A');
    const b = await seller('Seller B');
    const aBanana = await product('Banana Elaichi', { sellerId: a, submittedBySellerId: a });
    const bBanana = await product('Banana Yelakki', { sellerId: b, submittedBySellerId: b });
    await reindexStaleProducts();

    const own = await searchProductIds({ query: 'kela', where: sellerOwnSearchScope(a), limit: 10 });
    expect(own.map((h) => h.productId)).toEqual([aBanana.productId]);

    const orderA = await orderOf(a, { ...aBanana, productName: 'Banana Elaichi' }, 'Ramesh Kumar');
    await orderOf(b, { ...bBanana, productName: 'Banana Yelakki' }, 'Ramesh Kumar');

    for (const q of ['kela', 'केला', 'banana', 'rmesh', orderA.orderNumber.slice(2).replace(/(\d{3})/, '$1 ')]) {
      const page = await listSellerOrders(a, { q, limit: 20 } as never);
      expect(page.items.map((row) => (row as { id: string }).id), `seller search "${q}"`).toEqual([orderA.sellerOrderId]);
    }

    const adminPage = await listOrders({ search: 'kela', limit: 20 });
    expect(adminPage.items).toHaveLength(2);
    const adminByPhone = await listOrders({ search: '+91 95100-00001', limit: 20 });
    expect(adminByPhone.items.map((o) => o.id)).toEqual([orderA.orderId]);
  });
});

describe('customer Food search', () => {
  it('finds restaurants by name, cuisine and dish', async () => {
    const nepali = await seller('Nepali Kitchen', 'RESTAURANT', { cuisine: ['Chinese', 'Nepali'] });
    const cafe = await seller('AS Cafe', 'RESTAURANT', { cuisine: ['Fast food'] });
    const menuA = await category('Main Menu', { sellerId: nepali });
    const sectionA = await category('Starters', { sellerId: nepali, parentId: menuA });
    await product('Chicken Momos (Steam)', { sellerId: nepali, categoryId: sectionA });
    const menuB = await category('Main Menu', { sellerId: cafe });
    const sectionB = await category('Pizza', { sellerId: cafe, parentId: menuB });
    await product('Paneer Cheese Pizza', { sellerId: cafe, categoryId: sectionB });
    await reindexStaleProducts();

    type Hit = { sellerId: string; matchedItems: string[] };
    const find = async (q: string) =>
      expectSuccess<Hit[]>((await api().get(`/api/v1/restaurants/search?q=${encodeURIComponent(q)}`).expect(200)).body).data;

    expect((await find('nepali')).map((h) => h.sellerId)).toEqual([nepali]);
    expect((await find('chinese')).map((h) => h.sellerId)).toEqual([nepali]);
    const momo = await find('momo');
    expect(momo.map((h) => h.sellerId)).toEqual([nepali]);
    expect(momo[0]?.matchedItems).toEqual(['Chicken Momos (Steam)']);
    expect((await find('पनीर')).map((h) => h.sellerId)).toEqual([cafe]);
    expect((await find('panir')).map((h) => h.sellerId)).toEqual([cafe]);
    expect(await find('xyzzy')).toEqual([]);

    // A dish the seller switched off is not on the public menu: not found either.
    const hidden = await product('Mutton Rogan Josh', { sellerId: nepali, categoryId: sectionA });
    await prisma.sellerListing.update({ where: { id: hidden.listingId }, data: { isAvailable: false } });
    await reindexStaleProducts();
    expect(await find('rogan josh')).toEqual([]);
    expect((await find('momo'))[0]?.matchedItems).toEqual(['Chicken Momos (Steam)']);
  });
});
