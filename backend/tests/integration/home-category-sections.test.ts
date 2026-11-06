/**
 * Home Page Builder → "Category products" sections end to end: product
 * shelves that draw from exactly ONE main category or subcategory
 * (createCategoryProductSection), the admin's own order, through
 * draft → publish → GET /content/home-layout + GET /content/home-shelves.
 *
 *   - the example page: Grocery (main, 12), Vegetables (sub, 12), Fruits
 *     (sub, 10), Rice (sub), Vegetables & Fruits (main), Fruits again with
 *     its own heading — in exactly the admin's order, each with its own
 *     products and a View All to exactly its category;
 *   - a subcategory section shows only that subcategory; a main one includes
 *     its subcategories; never more than its count;
 *   - hidden sections are not resolved; an empty one is an empty list;
 *   - only buyable products: a hidden, pending, sold-out or switched-off size
 *     never counts, a store not taking orders is left out, and a product whose
 *     default size is sold out still shows through its other size;
 *   - guests read the published page; a vanished category or an out-of-range
 *     count is refused; customers and sellers cannot write it;
 *   - query budget and timing of GET /content/home-shelves with six sections.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  DEFAULT_HOME_LAYOUT,
  ProductStatus,
  SellerType,
  UnitType,
  UserRole,
  addHomeSection,
  categoryShelfKind,
  createCategoryProductSection,
  resolveHomeLayout,
  type AdminHomeLayoutDto,
  type HomeLayoutContent,
  type HomeLayoutDto,
  type HomeShelvesDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs, loginCustomerApp } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as otpService from '../../src/modules/auth/otp.service';

let queries = 0;
let counting = false;
(prisma as unknown as { $on: (event: 'query', cb: () => void) => void }).$on('query', () => {
  if (counting) queries += 1;
});

const ADMIN = { mobile: '9400000871', email: 'category-sections@adione.test', password: 'TestAdmin@123' };

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  put: (p: string, body: object) => api().put(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Sections Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(mobile: string): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Store ${mobile}`,
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
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken };
}

async function topCategory(seller: { token: string }, name: string): Promise<string> {
  const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await as(seller.token).post('/seller/categories', { name }).expect(201)).body).data;
  return tree.categories.find((c) => c.name === name)!.id;
}
const subcategory = async (seller: { token: string }, parentId: string, name: string) =>
  expectSuccess<{ id: string }>((await as(seller.token).post('/seller/subcategories', { parentId, name }).expect(201)).body).data.id;

let counter = 0;
interface Size {
  stock?: number;
  status?: 'ACTIVE' | 'INACTIVE' | 'DRAFT';
  approval?: 'APPROVED' | 'PENDING';
  isAvailable?: boolean;
}
/** A live, approved product; by default one in-stock size (pass `sizes` for more). */
async function product(sellerId: string, categoryId: string, name: string, sizes: Size[] = [{}]) {
  counter += 1;
  const created = await prisma.product.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter}`,
      categoryId,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      submittedBySellerId: sellerId,
      searchKeywords: [],
      createdAt: new Date(Date.now() - counter * 60_000),
    },
  });
  for (const [index, size] of sizes.entries()) {
    const variant = await prisma.productVariant.create({
      data: {
        productId: created.id,
        sku: `CAT-${counter}-${index}`,
        variantName: `${index + 1} kg`,
        unit: UnitType.KG,
        unitValue: index + 1,
        isDefault: index === 0,
        displayOrder: index,
        status: size.status ?? ProductStatus.ACTIVE,
        approvalStatus: size.approval ?? 'APPROVED',
      },
    });
    await prisma.sellerListing.create({
      data: { sellerId, variantId: variant.id, mrpPaise: 6_000, pricePaise: 5_000 + index * 100, stockQty: size.stock ?? 40, isAvailable: size.isAvailable ?? true },
    });
  }
  return created.id;
}

const freshLayout = (): HomeLayoutContent => structuredClone(resolveHomeLayout(DEFAULT_HOME_LAYOUT));
/** Category products sections appended in the given order. */
function withSections(layout: HomeLayoutContent, ...sections: { id: string; path: string; title: string; count: number; source?: 'latest' | 'bestselling' | 'random' }[]) {
  let next = layout;
  for (const { id, ...input } of sections) next = addHomeSection(next, createCategoryProductSection(id, input)!)!;
  return next;
}
async function publish(token: string, layout: HomeLayoutContent) {
  await as(token).put('/admin/content/home-layout/draft', { layout }).expect(200);
  const view = expectSuccess<AdminHomeLayoutDto>((await as(token).get('/admin/content/home-layout').expect(200)).body).data;
  return as(token).post('/admin/content/home-layout/publish', { basedOnRevision: view.draft?.basedOnRevision ?? 0 });
}
async function published(layout: HomeLayoutContent) {
  const res = await publish(admin, layout);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const guestLayout = async () => expectSuccess<HomeLayoutDto>((await api().get('/api/v1/content/home-layout').expect(200)).body).data;
const guestShelves = async () => expectSuccess<HomeShelvesDto>((await api().get('/api/v1/content/home-shelves').expect(200)).body).data;
const names = (list: { name: string }[] | undefined) => (list ?? []).map((p) => p.name).sort();

let admin: string;
let seller: { id: string; token: string };
let ids: { grocery: string; rice: string; vegFruits: string; vegetables: string; fruits: string; dairy: string };

beforeEach(async () => {
  await truncateAll();
  await cache.clear();
  admin = await loginAdmin();
  seller = await seedSeller('9400000872');
  const grocery = await topCategory(seller, 'Grocery');
  const vegFruits = await topCategory(seller, 'Vegetables Fruits');
  ids = {
    grocery,
    rice: await subcategory(seller, grocery, 'Rice'),
    vegFruits,
    vegetables: await subcategory(seller, vegFruits, 'Vegetables'),
    fruits: await subcategory(seller, vegFruits, 'Fruits'),
    dairy: await subcategory(seller, grocery, 'Dairy'),
  };
});

describe('category products sections', () => {
  it('the example page: main and subcategory sections in the admin order, each with its own products, count and View All', async () => {
    for (let i = 0; i < 14; i += 1) await product(seller.id, ids.rice, `Rice ${i}`);
    for (let i = 0; i < 13; i += 1) await product(seller.id, ids.vegetables, `Veg ${i}`);
    for (let i = 0; i < 4; i += 1) await product(seller.id, ids.fruits, `Fruit ${i}`);
    await product(seller.id, ids.grocery, 'Loose grocery'); // directly in the main category

    const layout = withSections(
      freshLayout(),
      { id: 'shelf-grocery', path: 'grocery', title: 'Grocery', count: 12 },
      { id: 'shelf-veg', path: 'vegetables-fruits/vegetables', title: 'Fresh Vegetables', count: 12 },
      { id: 'shelf-fruits', path: 'vegetables-fruits/fruits', title: 'Fruits', count: 10 },
      { id: 'shelf-rice', path: 'grocery/rice', title: 'Rice', count: 5 },
      { id: 'shelf-vegfruits', path: 'vegetables-fruits', title: 'Vegetables & Fruits', count: 12 },
      { id: 'shelf-fruits-2', path: 'vegetables-fruits/fruits', title: 'Fruits — best sellers', count: 10, source: 'bestselling' },
    );
    await published(layout);

    // The published page lists them in exactly this order, as main / subcategory sections.
    const live = (await guestLayout()).layout.sections.filter((s) => s.id.startsWith('shelf-'));
    expect(live.map((s) => s.id)).toEqual(['shelf-grocery', 'shelf-veg', 'shelf-fruits', 'shelf-rice', 'shelf-vegfruits', 'shelf-fruits-2']);
    expect(live.map((s) => categoryShelfKind(s.shelf))).toEqual(['main', 'sub', 'sub', 'sub', 'main', 'sub']);
    expect(live.map((s) => s.shelf!.viewAll)).toEqual(live.map((s) => ({ type: 'category', path: s.shelf!.categoryPaths[0] })));
    expect(live.every((s) => s.shelf!.layout === 'carousel')).toBe(true);

    const { shelves } = await guestShelves();
    // A main category includes its subcategories (and its own products); never more than the count.
    expect(shelves['shelf-grocery']).toHaveLength(12);
    expect(shelves['shelf-grocery']!.every((p) => p.name.startsWith('Rice') || p.name === 'Loose grocery')).toBe(true);
    // A subcategory shows only its own products.
    expect(shelves['shelf-veg']).toHaveLength(12);
    expect(shelves['shelf-veg']!.every((p) => p.name.startsWith('Veg '))).toBe(true);
    expect(names(shelves['shelf-fruits'])).toEqual(['Fruit 0', 'Fruit 1', 'Fruit 2', 'Fruit 3']);
    expect(shelves['shelf-rice']).toHaveLength(5);
    expect(shelves['shelf-rice']!.every((p) => p.name.startsWith('Rice'))).toBe(true);
    expect(shelves['shelf-vegfruits']!.every((p) => p.name.startsWith('Veg ') || p.name.startsWith('Fruit'))).toBe(true);
    // The same subcategory twice, each its own section.
    expect(names(shelves['shelf-fruits-2'])).toEqual(names(shelves['shelf-fruits']));
    // Latest first.
    expect(shelves['shelf-veg']!.map((p) => p.name).slice(0, 3)).toEqual(['Veg 0', 'Veg 1', 'Veg 2']);
  });

  it('a hidden section is not resolved; an empty one is an empty list (the app leaves it out); re-enabling brings it back', async () => {
    await product(seller.id, ids.fruits, 'Mango');
    let layout = withSections(
      freshLayout(),
      { id: 'shelf-fruits', path: 'vegetables-fruits/fruits', title: 'Fruits', count: 10 },
      { id: 'shelf-dairy', path: 'grocery/dairy', title: 'Dairy Products', count: 12 },
    );
    layout.sections.find((s) => s.id === 'shelf-fruits')!.visible = false;
    await published(layout);
    let { shelves } = await guestShelves();
    expect(Object.keys(shelves).sort()).toEqual(['shelf-dairy']);
    expect(shelves['shelf-dairy']).toEqual([]);

    layout = structuredClone(layout);
    layout.sections.find((s) => s.id === 'shelf-fruits')!.visible = true;
    await published(layout);
    ({ shelves } = await guestShelves());
    expect(names(shelves['shelf-fruits'])).toEqual(['Mango']);
  });

  it('only buyable products: hidden / pending / sold-out / switched-off sizes never count; a sold-out default shows through its other size', async () => {
    await product(seller.id, ids.fruits, 'Orange', [{ stock: 0 }, { stock: 5 }]); // default sold out, 2nd buyable
    await product(seller.id, ids.fruits, 'Apple', [{ status: 'INACTIVE' }]);
    await product(seller.id, ids.fruits, 'Kiwi', [{ status: 'DRAFT', approval: 'PENDING' }]);
    await product(seller.id, ids.fruits, 'Grapes', [{ stock: 0 }]);
    await product(seller.id, ids.fruits, 'Papaya', [{ isAvailable: false }]);
    await product(seller.id, ids.fruits, 'Guava');
    const hiddenProduct = await product(seller.id, ids.fruits, 'Lychee');
    await prisma.product.update({ where: { id: hiddenProduct }, data: { status: ProductStatus.INACTIVE } });

    await published(withSections(freshLayout(), { id: 'shelf-fruits', path: 'vegetables-fruits/fruits', title: 'Fruits', count: 10 }));
    const fruits = (await guestShelves()).shelves['shelf-fruits']!;
    expect(names(fruits)).toEqual(['Guava', 'Orange']);
    // The card shows the size that can be bought.
    const orange = fruits.find((p) => p.name === 'Orange')!;
    expect(orange.defaultVariant?.inStock).toBe(true);
    expect(orange.defaultVariant?.variantName).toBe('2 kg');
  });

  it('a store not taking orders is left out of the section; the other stores stay', async () => {
    const other = await seedSeller('9400000873');
    // Same category path in the other store (categories are seller-owned, merged by path).
    const otherVeg = await topCategory(other, 'Vegetables Fruits');
    const otherFruits = await subcategory(other, otherVeg, 'Fruits');
    await product(seller.id, ids.fruits, 'Mango');
    await product(other.id, otherFruits, 'Banana');
    await published(withSections(freshLayout(), { id: 'shelf-fruits', path: 'vegetables-fruits/fruits', title: 'Fruits', count: 10 }));
    expect(names((await guestShelves()).shelves['shelf-fruits'])).toEqual(['Banana', 'Mango']);

    await prisma.seller.update({ where: { id: other.id }, data: { isAcceptingOrders: false } });
    await cache.clear();
    expect(names((await guestShelves()).shelves['shelf-fruits'])).toEqual(['Mango']);
  });

  it('guests read the page with no session; a category that is not live and an out-of-range count are refused; customers and sellers cannot write', async () => {
    const res = await publish(admin, withSections(freshLayout(), { id: 'shelf-gone', path: 'grocery/snacks', title: 'Snacks', count: 10 }));
    expect(res.status).toBe(400);
    expect(expectError(res.body).message).toMatch(/no longer live: grocery\/snacks/);

    const tooMany = freshLayout();
    const section = createCategoryProductSection('shelf-big', { path: 'grocery', title: 'Grocery', count: 12 })!;
    section.shelf!.count = 31;
    expect((await as(admin).put('/admin/content/home-layout/draft', { layout: addHomeSection(tooMany, section) })).status).toBe(400);

    // The helper itself only accepts a category path and keeps the count in range.
    expect(createCategoryProductSection('shelf-a', { path: 'Not A Path', title: 'X', count: 10 })).toBeNull();
    expect(createCategoryProductSection('shelf-b', { path: 'grocery', title: 'X', count: 99 })!.shelf!.count).toBe(30);

    const customer = (await loginCustomerApp('9400000874')).accessToken;
    const layout = withSections(freshLayout(), { id: 'shelf-grocery', path: 'grocery', title: 'Grocery', count: 12 });
    expect((await as(customer).put('/admin/content/home-layout/draft', { layout })).status).toBe(403);
    expect((await as(seller.token).put('/admin/content/home-layout/draft', { layout })).status).toBe(403);
    expect((await api().put('/api/v1/admin/content/home-layout/draft').send({ layout })).status).toBe(401);

    await api().get('/api/v1/content/home-layout').expect(200);
    await api().get('/api/v1/content/home-shelves').expect(200);
  });
});

describe('GET /content/home-shelves cost', () => {
  it('six sections: one product query per section plus a fixed few — not one per product; timing printed', async () => {
    for (let i = 0; i < 14; i += 1) await product(seller.id, ids.rice, `Rice ${i}`, [{}, {}]);
    for (let i = 0; i < 13; i += 1) await product(seller.id, ids.vegetables, `Veg ${i}`);
    for (let i = 0; i < 6; i += 1) await product(seller.id, ids.fruits, `Fruit ${i}`);
    const six = withSections(
      freshLayout(),
      { id: 'shelf-grocery', path: 'grocery', title: 'Grocery', count: 12 },
      { id: 'shelf-veg', path: 'vegetables-fruits/vegetables', title: 'Fresh Vegetables', count: 12 },
      { id: 'shelf-fruits', path: 'vegetables-fruits/fruits', title: 'Fruits', count: 10 },
      { id: 'shelf-dairy', path: 'grocery/dairy', title: 'Dairy Products', count: 12 },
      { id: 'shelf-vegfruits', path: 'vegetables-fruits', title: 'Vegetables & Fruits', count: 12 },
      { id: 'shelf-rice', path: 'grocery/rice', title: 'Rice', count: 10 },
    );

    const measure = async () => {
      await cache.clear();
      await api().get('/api/v1/content/home-shelves').expect(200); // warm the layout cache
      const times: number[] = [];
      let count = 0;
      for (let run = 0; run < 5; run += 1) {
        queries = 0;
        counting = true;
        const start = performance.now();
        await api().get('/api/v1/content/home-shelves').expect(200);
        times.push(performance.now() - start);
        counting = false;
        count = queries;
      }
      return { queries: count, ms: Math.round([...times].sort((a, b) => a - b)[2]!) };
    };

    await published(withSections(freshLayout(), { id: 'shelf-grocery', path: 'grocery', title: 'Grocery', count: 12 }));
    const one = await measure();
    await published(six);
    const all = await measure();
    console.log(`home-shelves: 1 section ${one.queries} queries / ${one.ms} ms median; 6 sections ${all.queries} queries / ${all.ms} ms median (local Postgres)`);
    // 56 products across six sections: the extra five sections cost one id query each, the products are hydrated in one batch.
    expect(all.queries - one.queries).toBeLessThanOrEqual(5);
    expect(all.queries).toBeLessThanOrEqual(20);
  });
});
