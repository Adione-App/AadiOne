/**
 * Home Page Builder — ADDED sections end to end through the real app:
 * product shelves (random daily, latest, best-selling, hand-picked + top-up)
 * and category sections, in the draft → publish → customers flow.
 *
 *   GET  /content/home-shelves                    customers: the published shelves' products, live
 *   POST /admin/content/home-layout/shelf-preview admin: one shelf right now
 *   GET  /admin/content/product-options           admin: the product picker
 *
 * Shelves store WHAT to show (source, categories, chosen ids, count, layout),
 * never prices or stock; every product shown passes the catalogue's own
 * customer-visibility rules.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  DEFAULT_HOME_LAYOUT,
  ErrorCode,
  ProductStatus,
  SellerType,
  UnitType,
  UserRole,
  addHomeSection,
  createHomeSection,
  duplicateHomeSection,
  moveHomeSection,
  removeHomeSection,
  resolveHomeLayout,
  type AdminHomeLayoutDto,
  type AdminProductOptionsPage,
  type HomeLayoutContent,
  type HomeLayoutDto,
  type HomeShelvesDto,
  type ProductShelfConfig,
  type ProductSummaryDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as otpService from '../../src/modules/auth/otp.service';
import { resolveProductShelves } from '../../src/modules/catalog/catalog.service';

const ADMIN = { mobile: '9400000861', email: 'shelves-admin@adione.test', password: 'TestAdmin@123' };

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  put: (p: string, body: object) => api().put(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  delete: (p: string) => api().delete(`/api/v1${p}`).set('Authorization', bearer(token)),
});

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Shelves Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
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

/** The seller's own top category + subcategory (through the Seller API, so paths are the real ones). */
async function branch(seller: { token: string }, top: string, sub: string): Promise<{ topId: string; subId: string }> {
  const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await as(seller.token).post('/seller/categories', { name: top }).expect(201)).body).data;
  const topId = tree.categories.find((c) => c.name === top)!.id;
  const subId = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/subcategories', { parentId: topId, name: sub }).expect(201)).body).data.id;
  return { topId, subId };
}

let counter = 0;
/** A live, approved product with one in-stock listing (or `stock` units), created `hoursAgo` ago. */
async function product(sellerId: string, categoryId: string, name: string, options: { stock?: number; hoursAgo?: number; nameHi?: string } = {}) {
  counter += 1;
  const created = await prisma.product.create({
    data: {
      name,
      nameHi: options.nameHi ?? null,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter}`,
      categoryId,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      submittedBySellerId: sellerId,
      searchKeywords: [],
      createdAt: new Date(Date.now() - (options.hoursAgo ?? counter) * 3_600_000),
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: created.id, sku: `SHELF-${counter}`, variantName: '1 kg', unit: UnitType.KG, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  const listing = await prisma.sellerListing.create({
    data: { sellerId, variantId: variant.id, mrpPaise: 6_000, pricePaise: 5_000, stockQty: options.stock ?? 40, isAvailable: true },
  });
  return { id: created.id, variantId: variant.id, listingId: listing.id };
}

/** A DELIVERED order of `qty` units of each product — the real best-selling signal. */
async function delivered(sellerId: string, lines: { variantId: string; qty: number }[]) {
  counter += 1;
  const user = await prisma.user.create({ data: { mobile: `95${String(counter).padStart(8, '0')}`, fullName: 'Buyer', role: UserRole.CUSTOMER } });
  const total = lines.reduce((sum, line) => sum + line.qty * 5_000, 0);
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-SHELF-${counter}`,
      userId: user.id,
      status: 'DELIVERED',
      paymentMethod: 'COD',
      itemsSubtotalPaise: total,
      totalPaise: total,
      currentPayablePaise: total,
      deliveryFullName: 'Buyer',
      deliveryMobile: user.mobile,
      deliveryAddressLine: 'Station Road',
      deliveryCity: 'Sikar',
      deliveryState: 'Rajasthan',
      deliveryPincode: '332001',
      deliveryLatitude: 27.62,
      deliveryLongitude: 75.14,
      distanceKm: 1,
    },
  });
  const sellerOrder = await prisma.sellerOrder.create({ data: { orderId: order.id, sellerId, subtotalPaise: total, commissionBp: 0, commissionPaise: 0 } });
  for (const line of lines) {
    await prisma.orderItem.create({
      data: {
        sellerOrderId: sellerOrder.id,
        variantId: line.variantId,
        productName: 'x',
        variantName: '1 kg',
        sku: `SKU-${counter}`,
        unitDisplay: '1 kg',
        qty: line.qty,
        mrpPaise: 6_000,
        unitPricePaise: 5_000,
        lineTotalPaise: line.qty * 5_000,
      },
    });
  }
}

const shelfOf = (overrides: Partial<ProductShelfConfig>): ProductShelfConfig => ({ ...createHomeSection('product_shelf', 'shelf-x').shelf!, viewAll: { type: 'none', path: null }, ...overrides });

/** The default layout plus added sections (each `[id, title, shelf]` or a ready section). */
function layoutWith(...shelves: [string, string, Partial<ProductShelfConfig>][]): HomeLayoutContent {
  let layout = structuredClone(resolveHomeLayout(DEFAULT_HOME_LAYOUT));
  for (const [id, title, shelf] of shelves) {
    layout = addHomeSection(layout, { ...createHomeSection('product_shelf', id, { title }), shelf: shelfOf(shelf) }, 1)!;
  }
  return layout;
}

const saveDraft = (token: string, layout: HomeLayoutContent) => as(token).put('/admin/content/home-layout/draft', { layout });
const adminView = async (token: string) => expectSuccess<AdminHomeLayoutDto>((await as(token).get('/admin/content/home-layout').expect(200)).body).data;
async function publish(token: string, layout: HomeLayoutContent) {
  await saveDraft(token, layout).expect(200);
  const view = await adminView(token);
  return as(token).post('/admin/content/home-layout/publish', { basedOnRevision: view.draft?.basedOnRevision ?? 0 });
}
const customerShelves = async () => expectSuccess<HomeShelvesDto>((await api().get('/api/v1/content/home-shelves').expect(200)).body).data;
const names = (products: ProductSummaryDto[]) => products.map((p) => p.name);
const preview = async (token: string, shelf: Partial<ProductShelfConfig>, sectionId = 'shelf-preview') =>
  expectSuccess<ProductSummaryDto[]>((await as(token).post('/admin/content/home-layout/shelf-preview', { sectionId, shelf: shelfOf(shelf) }).expect(200)).body).data;

let admin: string;
let seller: { id: string; token: string };
let cats: { grocery: { topId: string; subId: string }; veg: { topId: string; subId: string }; fruits: { subId: string } };

beforeEach(async () => {
  await truncateAll();
  await cache.clear();
  admin = await loginAdmin();
  seller = await seedSeller('9400000862');
  const grocery = await branch(seller, 'Grocery', 'Rice');
  const veg = await branch(seller, 'Vegetables Fruits', 'Vegetables');
  const fruits = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/subcategories', { parentId: veg.topId, name: 'Fruits' }).expect(201)).body).data;
  cats = { grocery, veg, fruits: { subId: fruits.id } };
});

describe('category paths used by the shelves', () => {
  it('are the merged catalogue paths', async () => {
    const options = expectSuccess<{ path: string }[]>((await as(admin).get('/admin/content/category-options').expect(200)).body).data.map((o) => o.path);
    expect(options).toEqual(expect.arrayContaining(['grocery', 'grocery/rice', 'vegetables-fruits', 'vegetables-fruits/vegetables', 'vegetables-fruits/fruits']));
  });
});

describe('draft: added sections keep their identity, order and settings', () => {
  it('add, reorder (drag / up-down), hide, duplicate and remove all survive a save; customers see none of it before publishing', async () => {
    let layout = layoutWith(['shelf-grocery', 'Grocery', { source: 'random', categoryPaths: ['grocery'], count: 10 }]);
    layout = addHomeSection(layout, createHomeSection('category_section', 'cats-explore', { title: 'Explore', categories: { paths: ['grocery/rice', 'vegetables-fruits/fruits'] } }))!;
    // Move the shelf above everything, hide the category section, duplicate the shelf.
    layout = moveHomeSection(layout, layout.sections.findIndex((s) => s.id === 'shelf-grocery'), 0);
    layout.sections.find((s) => s.id === 'cats-explore')!.visible = false;
    layout = duplicateHomeSection(layout, 'shelf-grocery', 'shelf-grocery2')!;
    layout.sections.find((s) => s.id === 'shelf-grocery2')!.shelf!.count = 15;
    await saveDraft(admin, layout).expect(200);

    const draft = (await adminView(admin)).draft!.layout;
    expect(draft.sections.slice(0, 2).map((s) => s.id)).toEqual(['shelf-grocery', 'shelf-grocery2']);
    expect(draft.sections.find((s) => s.id === 'shelf-grocery')!.shelf!.count).toBe(10);
    expect(draft.sections.find((s) => s.id === 'shelf-grocery2')!.shelf!.count).toBe(15);
    expect(draft.sections.find((s) => s.id === 'cats-explore')).toMatchObject({ visible: false, categories: { paths: ['grocery/rice', 'vegetables-fruits/fruits'] } });

    // Removing the copy leaves the original.
    await saveDraft(admin, removeHomeSection(draft, 'shelf-grocery2')).expect(200);
    expect((await adminView(admin)).draft!.layout.sections.map((s) => s.id)).not.toContain('shelf-grocery2');

    // Customers: nothing published yet — the defaults and no shelves.
    const live = expectSuccess<HomeLayoutDto>((await api().get('/api/v1/content/home-layout').expect(200)).body).data;
    expect(live.layout.sections.some((s) => s.key === 'product_shelf')).toBe(false);
    expect(await customerShelves()).toEqual({ revision: 0, shelves: {} });
  });

  it('refuses unknown section types, code, stray fields, broken and duplicate ids, built-in ids on added sections', async () => {
    const base = layoutWith(['shelf-grocery', 'Grocery', { categoryPaths: ['grocery'] }]);
    const withSection = (section: object) => ({ ...base, sections: [...base.sections, section] });
    const shelfSection = base.sections.find((s) => s.id === 'shelf-grocery')!;
    for (const bad of [
      withSection({ ...shelfSection, id: 'html-1', key: 'html_block' }),
      withSection({ ...shelfSection, id: 'shelf-js', shelf: { ...shelfSection.shelf, script: 'alert(1)' } }),
      withSection({ ...shelfSection, id: 'shelf-y', shelf: { ...shelfSection.shelf, source: 'sql' } }),
      withSection({ ...shelfSection, id: 'shelf-z', shelf: { ...shelfSection.shelf, count: 31 } }),
      withSection({ ...shelfSection, id: 'Bad Id!' }),
      withSection({ ...shelfSection }), // same id twice
      withSection({ ...shelfSection, id: 'top_categories' }),
      withSection({ ...shelfSection, id: 'shelf-c', shelf: { ...shelfSection.shelf, productIds: ['not-a-uuid'] } }),
    ]) {
      expect(expectError((await saveDraft(admin, bad as HomeLayoutContent).expect(400)).body).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });
});

describe('product sources — every product shown is one customers can buy, from the shelf\'s own categories', () => {
  it('latest: newest first, only the chosen categories, out-of-stock and switched-off left out, at most the count', async () => {
    const rice = await product(seller.id, cats.grocery.subId, 'Basmati Rice', { hoursAgo: 30 });
    const dal = await product(seller.id, cats.grocery.topId, 'Toor Dal', { hoursAgo: 10 });
    await product(seller.id, cats.grocery.subId, 'Sona Rice', { hoursAgo: 1, stock: 0 });
    await product(seller.id, cats.veg.subId, 'Tomato', { hoursAgo: 2 });
    const hidden = await product(seller.id, cats.grocery.subId, 'Old Rice', { hoursAgo: 50 });
    await prisma.sellerListing.update({ where: { id: hidden.listingId }, data: { isAvailable: false } });

    expect(names(await preview(admin, { source: 'latest', categoryPaths: ['grocery'] }))).toEqual(['Toor Dal', 'Basmati Rice']);
    expect(names(await preview(admin, { source: 'latest', categoryPaths: ['grocery'], count: 1 }))).toEqual(['Toor Dal']);
    // A subcategory scope is just that subcategory.
    expect(names(await preview(admin, { source: 'latest', categoryPaths: ['grocery/rice'] }))).toEqual(['Basmati Rice']);
    expect([rice.id, dal.id]).toHaveLength(2);
  });

  it('several categories, overlapping ones included: each product once', async () => {
    await product(seller.id, cats.grocery.subId, 'Basmati Rice');
    await product(seller.id, cats.veg.subId, 'Tomato');
    await product(seller.id, cats.fruits.subId, 'Apple');
    const shown = await preview(admin, { source: 'latest', categoryPaths: ['vegetables-fruits/vegetables', 'vegetables-fruits/fruits', 'vegetables-fruits'] });
    expect(names(shown).sort()).toEqual(['Apple', 'Tomato']);
    const both = await preview(admin, { source: 'random', categoryPaths: ['grocery', 'grocery/rice'] });
    expect(names(both)).toEqual(['Basmati Rice']);
  });

  it('random: the same selection all day (no reshuffling), within its categories; each shelf has its own', async () => {
    for (const name of ['Rice A', 'Rice B', 'Rice C', 'Rice D', 'Rice E', 'Rice F', 'Rice G', 'Rice H']) await product(seller.id, cats.grocery.subId, name);
    await product(seller.id, cats.veg.subId, 'Tomato');
    const config = shelfOf({ source: 'random', categoryPaths: ['grocery'], count: 4 });
    const first = await resolveProductShelves([{ id: 'shelf-a', shelf: config }], { day: '2026-10-24' });
    const again = await resolveProductShelves([{ id: 'shelf-a', shelf: config }], { day: '2026-10-24' });
    expect(names(first['shelf-a']!)).toEqual(names(again['shelf-a']!));
    expect(first['shelf-a']).toHaveLength(4);
    expect(names(first['shelf-a']!).every((name) => name.startsWith('Rice'))).toBe(true);
    // The whole scope, over any seed, is exactly the eligible set.
    const all = await resolveProductShelves([{ id: 'shelf-b', shelf: { ...config, count: 30 } }], { day: '2026-10-25' });
    expect(names(all['shelf-b']!).sort()).toEqual(['Rice A', 'Rice B', 'Rice C', 'Rice D', 'Rice E', 'Rice F', 'Rice G', 'Rice H']);
  });

  it('best-selling: by quantity actually delivered, then a fixed order; undelivered orders do not count', async () => {
    const a = await product(seller.id, cats.grocery.subId, 'Rice A', { hoursAgo: 5 });
    const b = await product(seller.id, cats.grocery.subId, 'Rice B', { hoursAgo: 4 });
    // The oldest — first among products without delivered sales (Top picks' fixed order).
    await product(seller.id, cats.grocery.subId, 'Rice C', { hoursAgo: 8 });
    await delivered(seller.id, [{ variantId: b.variantId, qty: 5 }]);
    await delivered(seller.id, [{ variantId: a.variantId, qty: 2 }]);
    expect(names(await preview(admin, { source: 'bestselling', categoryPaths: ['grocery'] }))).toEqual(['Rice B', 'Rice A', 'Rice C']);
    // An order that is not delivered does not count: Rice A drops back among the unsold.
    const aOrder = await prisma.order.findFirstOrThrow({ where: { sellerOrders: { some: { items: { some: { variantId: a.variantId } } } } } });
    await prisma.order.update({ where: { id: aOrder.id }, data: { status: 'CANCELLED' } });
    expect(names(await preview(admin, { source: 'bestselling', categoryPaths: ['grocery'] }))).toEqual(['Rice B', 'Rice C', 'Rice A']);
  });

  it('hand-picked: the chosen order, unbuyable picks skipped, optionally topped up with the latest from its categories — never padded', async () => {
    const a = await product(seller.id, cats.fruits.subId, 'Apple', { hoursAgo: 9 });
    const b = await product(seller.id, cats.fruits.subId, 'Banana', { hoursAgo: 8, stock: 0 });
    const c = await product(seller.id, cats.grocery.subId, 'Basmati Rice', { hoursAgo: 7 });
    await product(seller.id, cats.fruits.subId, 'Mango', { hoursAgo: 1 });
    await product(seller.id, cats.fruits.subId, 'Guava', { hoursAgo: 2 });

    // Any product may be picked (the categories filter the picker); out-of-stock Banana is skipped.
    expect(names(await preview(admin, { source: 'manual', productIds: [c.id, b.id, a.id], count: 8 }))).toEqual(['Basmati Rice', 'Apple']);
    // Topped up from the shelf's categories: picks first, then the newest others, never a pick twice.
    expect(names(await preview(admin, { source: 'manual', productIds: [a.id], fillFromScope: true, categoryPaths: ['vegetables-fruits/fruits'], count: 3 }))).toEqual(['Apple', 'Mango', 'Guava']);
    expect(names(await preview(admin, { source: 'manual', productIds: [a.id, c.id], count: 1 }))).toEqual(['Apple']);
  });

  it('a shelf with nothing to show is an empty list (the app leaves it out)', async () => {
    expect(await preview(admin, { source: 'latest', categoryPaths: ['grocery'] })).toEqual([]);
  });
});

describe('publishing', () => {
  it('customers get the published shelves resolved live, keyed by section id, immediately after publishing; hidden shelves are not resolved', async () => {
    await product(seller.id, cats.grocery.subId, 'Basmati Rice');
    await product(seller.id, cats.veg.subId, 'Tomato');
    // Customers read the layout first (it is now cached).
    await api().get('/api/v1/content/home-layout').expect(200);
    const layout = layoutWith(
      ['shelf-grocery', 'Grocery', { source: 'random', categoryPaths: ['grocery'], viewAll: { type: 'category', path: 'grocery' } }],
      ['shelf-veg', 'Vegetables', { source: 'latest', categoryPaths: ['vegetables-fruits/vegetables'], layout: 'grid', columns: 3 }],
      ['shelf-hidden', 'Hidden', { source: 'latest' }],
    );
    layout.sections.find((s) => s.id === 'shelf-hidden')!.visible = false;
    expect((await publish(admin, layout)).status).toBe(200);

    const shelves = await customerShelves();
    expect(shelves.revision).toBe(1);
    expect(Object.keys(shelves.shelves).sort()).toEqual(['shelf-grocery', 'shelf-veg']);
    expect(names(shelves.shelves['shelf-grocery']!)).toEqual(['Basmati Rice']);
    expect(names(shelves.shelves['shelf-veg']!)).toEqual(['Tomato']);
    // The layout cache was dropped on publish: the new sections are live at once.
    const live = expectSuccess<HomeLayoutDto>((await api().get('/api/v1/content/home-layout').expect(200)).body).data;
    expect(live.layout.sections.find((s) => s.id === 'shelf-veg')).toMatchObject({ key: 'product_shelf', shelf: { layout: 'grid', columns: 3 } });
    // Live, not a snapshot: a price change shows on the next request.
    await prisma.sellerListing.updateMany({ data: { pricePaise: 4_500 } });
    expect((await customerShelves()).shelves['shelf-grocery']![0]!.defaultVariant!.pricePaise).toBe(4_500);
  });

  it('refuses a View All that does not fit, a hand-picked shelf with no products, a vanished product or category, a shelf without a heading', async () => {
    const rice = await product(seller.id, cats.grocery.subId, 'Basmati Rice');
    const cases: [HomeLayoutContent, RegExp][] = [
      [layoutWith(['shelf-g', 'Grocery', { categoryPaths: ['grocery'], viewAll: { type: 'category', path: 'vegetables-fruits' } }]), /own category/],
      [layoutWith(['shelf-g', 'Grocery', { source: 'random', viewAll: { type: 'latest', path: null } }]), /whole catalogue/],
      [layoutWith(['shelf-g', 'Grocery', { source: 'manual', productIds: [] }]), /at least one product/],
      [layoutWith(['shelf-g', 'Grocery', { source: 'manual', productIds: [randomUUID()] }]), /no longer published/],
      [layoutWith(['shelf-g', 'Grocery', { categoryPaths: ['no-such-category'] }]), /no longer live/],
      [layoutWith(['shelf-g', '', { categoryPaths: ['grocery'] }]), /heading/],
    ];
    for (const [layout, message] of cases) {
      const res = await publish(admin, layout);
      expect(res.status).toBe(400);
      expect(expectError(res.body).message).toMatch(message);
    }
    // Nothing was published by any of them.
    expect((await customerShelves()).revision).toBe(0);
    // A product that is only out of stock does not block publishing.
    await prisma.sellerListing.updateMany({ where: { variant: { productId: rice.id } }, data: { stockQty: 0 } });
    expect((await publish(admin, layoutWith(['shelf-g', 'Picks', { source: 'manual', productIds: [rice.id] }]))).status).toBe(200);
    expect((await customerShelves()).shelves['shelf-g']).toEqual([]);
  });

  it('publishing never touches the sellers\' categories or products', async () => {
    await product(seller.id, cats.grocery.subId, 'Basmati Rice');
    const before = await prisma.category.findMany({ orderBy: { id: 'asc' } });
    const products = await prisma.product.count();
    expect((await publish(admin, layoutWith(['shelf-g', 'Grocery', { categoryPaths: ['grocery'] }]))).status).toBe(200);
    expect(await prisma.category.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.product.count()).toBe(products);
  });
});

describe('product picker (GET /admin/content/product-options)', () => {
  it('searches English and Hindi names, filters by category and seller, looks up chosen ids, pages through results', async () => {
    const rice = await product(seller.id, cats.grocery.subId, 'Basmati Rice', { nameHi: 'बासमती चावल' });
    await product(seller.id, cats.veg.subId, 'Tomato', { nameHi: 'टमाटर' });
    for (const name of ['Apple', 'Banana', 'Guava']) await product(seller.id, cats.fruits.subId, name);
    const other = await seedSeller('9400000863');
    const { subId } = await branch(other, 'Kitchen', 'Utensils');
    await product(other.id, subId, 'Steel Plate');

    const page = async (query: string) => expectSuccess<AdminProductOptionsPage>((await as(admin).get(`/admin/content/product-options?${query}`).expect(200)).body).data;
    expect((await page('q=basmati')).items.map((p) => p.name)).toEqual(['Basmati Rice']);
    expect((await page(`q=${encodeURIComponent('टमाटर')}`)).items.map((p) => p.name)).toEqual(['Tomato']);
    expect((await page('categoryPath=vegetables-fruits')).items.map((p) => p.name)).toEqual(['Apple', 'Banana', 'Guava', 'Tomato']);
    expect((await page(`sellerId=${other.id}`)).items.map((p) => p.name)).toEqual(['Steel Plate']);
    const chosen = (await page(`ids=${rice.id}`)).items[0]!;
    expect(chosen).toMatchObject({ name: 'Basmati Rice', categoryLabel: 'Grocery › Rice', pricePaise: 5_000, mrpPaise: 6_000, available: true, sellerCount: 1, variantCount: 1 });

    const first = await page('limit=2');
    expect(first.items.map((p) => p.name)).toEqual(['Apple', 'Banana']);
    const second = await page(`limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((p) => p.name)).toEqual(['Basmati Rice', 'Guava']);
    await as(admin).get('/admin/content/product-options?cursor=garbage').expect(400);
    await as(admin).get('/admin/content/product-options?ids=not-a-uuid').expect(400);
  });
});

describe('who may use the builder', () => {
  it('no session: 401; a customer or a seller: 403 — on the picker, the preview and the draft', async () => {
    const customer = (await loginAs('9400000864')).accessToken;
    const shelf = { sectionId: 'shelf-x', shelf: shelfOf({}) };
    await api().get('/api/v1/admin/content/product-options').expect(401);
    await api().post('/api/v1/admin/content/home-layout/shelf-preview').send(shelf).expect(401);
    for (const token of [customer, seller.token]) {
      await as(token).get('/admin/content/product-options').expect(403);
      await as(token).post('/admin/content/home-layout/shelf-preview', shelf).expect(403);
      await saveDraft(token, layoutWith(['shelf-g', 'Grocery', {}])).expect(403);
    }
    // The public shelves endpoint needs no account and exposes only product cards.
    const res = await api().get('/api/v1/content/home-shelves').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/pan|aadhaar|bank|commission/i);
  });
});
