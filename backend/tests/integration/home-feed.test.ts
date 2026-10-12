/**
 * Customer Home feed (GET /home) — the dynamic Home page:
 *
 *   - category shelves spread across subcategories (merged across sellers),
 *     deterministic, in-stock only;
 *   - the admin's Home category order (HOME_CATEGORY_ORDER), with every other
 *     category — including a new one — following automatically;
 *   - admin banner placements (food / above a category shelf / explore /
 *     bottom), never inventing or misplacing one;
 *   - the Top Picks rail;
 *   - GET /products/previously-ordered (own, eligible history only).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  CodPolicy,
  ConfigKey,
  PaymentMethod,
  ProductStatus,
  UnitType,
  UserRole,
  type HomeFeedDto,
  type ProductSummaryDto,
} from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { hashPassword } from '../../src/common/crypto';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { NEARBY, STORE_COORDS, seedAddress, sellerLifecycleFields } from '../helpers/fixtures';

const ADMIN = { mobile: '9400000811', email: 'home-admin@adione.test', password: 'TestAdmin@123' };
const CUSTOMER = '9876500811';
const OTHER_CUSTOMER = '9876500812';

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function home(): Promise<HomeFeedDto> {
  return expectSuccess<HomeFeedDto>((await api().get('/api/v1/home').expect(200)).body).data;
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

let sellerCount = 0;
async function seller(name: string): Promise<string> {
  sellerCount += 1;
  const created = await prisma.seller.create({
    data: {
      code: `HOME-${sellerCount}`,
      name,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      addressLine: 'Main Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: 'Asia/Kolkata',
      isActive: true,
      allowCod: CodPolicy.ALLOW,
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: created.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  return created.id;
}

/** A seller-owned category; `path` decides its place ("grocery" or "grocery/rice"). */
async function category(sellerId: string, name: string, path: string, parentId: string | null = null): Promise<string> {
  const created = await prisma.category.create({
    data: { sellerId, parentId, name, slug: path.split('/').pop()!, path, depth: path.split('/').length - 1 },
  });
  return created.id;
}

let productCount = 0;
async function product(
  sellerId: string,
  categoryId: string,
  options: { stockQty?: number; pricePaise?: number; mrpPaise?: number } = {},
): Promise<{ productId: string; listingId: string }> {
  productCount += 1;
  const slug = `home-product-${productCount}`;
  const created = await prisma.product.create({
    data: {
      name: `Home Product ${productCount}`,
      slug,
      categoryId,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      taxRateBp: 0,
      allowCod: CodPolicy.INHERIT,
      searchKeywords: [],
      // Strictly increasing creation times keep "newest first" unambiguous.
      createdAt: new Date(Date.UTC(2026, 0, 1) + productCount * 60_000),
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: created.id,
      sku: slug.toUpperCase(),
      variantName: '1 kg',
      unit: UnitType.KG,
      unitValue: 1,
      isDefault: true,
      status: ProductStatus.ACTIVE,
    },
  });
  const pricePaise = options.pricePaise ?? 10000;
  const listing = await prisma.sellerListing.create({
    data: {
      sellerId,
      variantId: variant.id,
      pricePaise,
      mrpPaise: options.mrpPaise ?? pricePaise,
      stockQty: options.stockQty ?? 50,
      maxQtyPerOrder: 10,
      isAvailable: true,
    },
  });
  return { productId: created.id, listingId: listing.id };
}

interface Catalogue {
  sellerA: string;
  sellerB: string;
  groceryA: string;
  riceB: string;
  fashion: string;
  toys: string;
  emptyTop: string;
  pathOf: Map<string, string>;
  products: Record<string, { productId: string; listingId: string }[]>;
}

/**
 * Seller A: grocery › rice (5) / oil (2), fashion › shirts (2), toys (1, no
 * subcategory). Seller B: grocery › snacks (3) / rice (1) — B's grocery and
 * rice merge with A's by path. One out-of-stock rice product never shows.
 */
async function seedCatalogue(): Promise<Catalogue> {
  const sellerA = await seller('Home Seller A');
  const groceryA = await category(sellerA, 'Grocery', 'grocery');
  const riceA = await category(sellerA, 'Rice', 'grocery/rice', groceryA);
  const oilA = await category(sellerA, 'Oil', 'grocery/oil', groceryA);
  const fashion = await category(sellerA, 'Fashion', 'fashion');
  const shirts = await category(sellerA, 'Shirts', 'fashion/shirts', fashion);
  const toys = await category(sellerA, 'Toys', 'toys');
  const emptyTop = await category(sellerA, 'Nothing Yet', 'nothing-yet');

  const sellerB = await seller('Home Seller B');
  const groceryB = await category(sellerB, 'Grocery', 'grocery');
  const snacksB = await category(sellerB, 'Snacks', 'grocery/snacks', groceryB);
  const riceB = await category(sellerB, 'Rice', 'grocery/rice', groceryB);

  const many = async (sellerId: string, categoryId: string, count: number) =>
    Promise.all(Array.from({ length: count }, () => product(sellerId, categoryId)));
  const products = {
    rice: [...(await many(sellerA, riceA, 5)), ...(await many(sellerB, riceB, 1))],
    oil: await many(sellerA, oilA, 2),
    snacks: await many(sellerB, snacksB, 3),
    shirts: await many(sellerA, shirts, 2),
    toys: await many(sellerA, toys, 1),
    outOfStock: [await product(sellerA, riceA, { stockQty: 0 })],
  };

  const pathOf = new Map<string, string>();
  for (const [name, list] of Object.entries(products)) for (const p of list) pathOf.set(p.productId, name);
  return { sellerA, sellerB, groceryA, riceB, fashion, toys, emptyTop, pathOf, products };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  invalidateCategoryCache();
  for (const mobile of [ADMIN.mobile, CUSTOMER, OTHER_CUSTOMER]) await otpService.clearOtpState(mobile);
});

/* -------------------------------------------------------------------------- */

describe('category shelves', () => {
  it('spread each shelf across subcategories (merged across sellers), in stock only, the same on every call', async () => {
    const c = await seedCatalogue();
    const feed = await home();

    const grocery = feed.categoryRails.find((rail) => rail.categoryId === c.groceryA);
    expect(grocery?.title).toBe('Grocery');
    const kinds = grocery!.products.map((p) => c.pathOf.get(p.id));
    // One of each subcategory first, then the second round, …
    expect(new Set(kinds.slice(0, 3))).toEqual(new Set(['rice', 'oil', 'snacks']));
    expect(new Set(kinds.slice(3, 6))).toEqual(new Set(['rice', 'oil', 'snacks']));
    // 10 products: rice 5 of 6 (round-robin fills the limit), oil 2, snacks 3.
    expect(kinds).toHaveLength(10);
    expect(kinds.filter((k) => k === 'oil')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'snacks')).toHaveLength(3);
    expect(kinds).not.toContain('outOfStock');
    expect(grocery!.products.every((p) => p.defaultVariant?.inStock)).toBe(true);

    // Deterministic — no random order between requests.
    expect((await home()).categoryRails.map((rail) => rail.products.map((p) => p.id))).toEqual(
      feed.categoryRails.map((rail) => rail.products.map((p) => p.id)),
    );

    // A category without products has neither a tile nor a shelf.
    expect(feed.categories.map((cat) => cat.id)).not.toContain(c.emptyTop);
    expect(feed.categoryRails.map((rail) => rail.categoryId)).not.toContain(c.emptyTop);
    // Subcategories hang under their top category, never as top-level entries.
    expect(feed.categories.map((cat) => cat.slug)).toEqual(['grocery', 'fashion', 'toys']);
    expect(feed.categories[0]!.children!.map((child) => child.slug).sort()).toEqual(['oil', 'rice', 'snacks']);
  });
});

describe('Home category order (HOME_CATEGORY_ORDER)', () => {
  it('shows the admin-listed categories first; every other one — including a new one — follows by itself', async () => {
    const c = await seedCatalogue();
    const admin = await loginAdmin();

    let feed = await home();
    expect(feed.featuredCategoryIds).toEqual([]);
    expect(feed.categories.map((cat) => cat.slug)).toEqual(['grocery', 'fashion', 'toys']);

    await as(admin).patch('/admin/config', { key: ConfigKey.HOME_CATEGORY_ORDER, value: ['toys', 'grocery', 'retired-category'] }).expect(200);
    feed = await home();
    expect(feed.categories.map((cat) => cat.slug)).toEqual(['toys', 'grocery', 'fashion']);
    expect(feed.categoryRails.map((rail) => rail.categoryId)).toEqual([c.toys, c.groceryA, c.fashion]);
    // A stale entry with no live category is skipped, not an empty slot.
    expect(feed.featuredCategoryIds).toEqual([c.toys, c.groceryA]);

    // A seller adds a brand-new category: it appears with no admin action.
    const kitchen = await category(c.sellerB, 'Kitchen', 'kitchen');
    await product(c.sellerB, kitchen);
    invalidateCategoryCache();
    feed = await home();
    expect(feed.categories.map((cat) => cat.slug)).toEqual(['toys', 'grocery', 'fashion', 'kitchen']);
    expect(feed.categoryRails.at(-1)?.categoryId).toBe(kitchen);
    expect(feed.featuredCategoryIds).not.toContain(kitchen);
  });

  it('rejects values that are not a list of distinct top-level category paths', async () => {
    const admin = await loginAdmin();
    for (const value of [['grocery/rice'], 'grocery', ['grocery', 'grocery'], [42], ['Grocery Store']]) {
      await as(admin).patch('/admin/config', { key: ConfigKey.HOME_CATEGORY_ORDER, value }).expect(400);
    }
    expect(await configService.get(ConfigKey.HOME_CATEGORY_ORDER)).toEqual([]);
  });
});

describe('Home banner placements', () => {
  const banner = (placement: string, extra: object = {}) =>
    prisma.banner.create({
      data: { placement, imageUrl: `https://cdn.test/${placement}-${randomUUID()}.webp`, imageWidth: 2000, imageHeight: 800, ...extra },
    });

  it('delivers each placement in order, puts category banners above the right shelf, and drops what cannot be placed', async () => {
    const c = await seedCatalogue();
    const top = await banner('home_top');
    const food2 = await banner('home_food', { displayOrder: 2 });
    const food1 = await banner('home_food', { displayOrder: 1 });
    await banner('home_explore', { isActive: false });
    const bottom = await banner('home_bottom');
    // Opens B's own "rice" row — a subcategory — so it belongs above Grocery (A's id represents it).
    const aboveGrocery = await banner('home_category', { actionType: 'CATEGORY', actionValue: c.riceB });
    const aboveToys = await banner('home_category', { actionType: 'CATEGORY', actionValue: c.toys });
    // No shelf for an empty category, and an image-only one has nowhere to go.
    await banner('home_category', { actionType: 'CATEGORY', actionValue: c.emptyTop });
    await banner('home_category');

    const feed = await home();
    expect(feed.banners.map((b) => b.id)).toEqual([top.id]);
    expect(feed.sectionBanners?.home_food?.map((b) => b.id)).toEqual([food1.id, food2.id]);
    expect(feed.sectionBanners?.home_bottom?.map((b) => b.id)).toEqual([bottom.id]);
    expect(feed.sectionBanners).not.toHaveProperty('home_explore');
    expect(feed.categoryBanners).toEqual(
      expect.arrayContaining([
        { categoryId: c.groceryA, banners: [expect.objectContaining({ id: aboveGrocery.id, actionValue: c.riceB })] },
        { categoryId: c.toys, banners: [expect.objectContaining({ id: aboveToys.id })] },
      ]),
    );
    expect(feed.categoryBanners).toHaveLength(2);
  });

  it('refuses a "home_category" banner that does not open a category', async () => {
    await seedCatalogue();
    const admin = await loginAdmin();
    const res = await as(admin).post('/admin/banners', { placement: 'home_category', actionType: 'NONE', imageKey: 'admin/banners/x.jpg' }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/must open that category/);

    const existing = await banner('home_food');
    await as(admin).patch(`/admin/banners/${existing.id}`, { placement: 'home_category' }).expect(400);
    expect((await prisma.banner.findUniqueOrThrow({ where: { id: existing.id } })).placement).toBe('home_food');
  });
});

describe('Top Picks', () => {
  it('is a real, deterministic rail with a "See All" page', async () => {
    await seedCatalogue();
    const first = (await home()).rails.find((rail) => rail.key === 'TOP_PICKS');
    expect(first?.title).toBe('Top Picks');
    expect(first!.products.length).toBeGreaterThan(0);
    expect(first!.products.every((p) => p.defaultVariant?.inStock)).toBe(true);
    expect((await home()).rails.find((rail) => rail.key === 'TOP_PICKS')!.products.map((p) => p.id)).toEqual(first!.products.map((p) => p.id));

    const page = expectSuccess<{ title: string; products: ProductSummaryDto[] }>(
      (await api().get('/api/v1/products/rail/TOP_PICKS?limit=60').expect(200)).body,
    ).data;
    expect(page.title).toBe('Top Picks');
    expect(page.products.length).toBeGreaterThanOrEqual(first!.products.length);
  });
});

describe('GET /products/previously-ordered', () => {
  it('needs a customer, and returns only their own still-buyable products, most recent first', async () => {
    const c = await seedCatalogue();
    await api().get('/api/v1/products/previously-ordered').expect(401);

    const customer = await loginAs(CUSTOMER);
    const other = await loginAs(OTHER_CUSTOMER);
    const mine = () => as(customer.accessToken).get('/products/previously-ordered').expect(200);
    expect(expectSuccess<ProductSummaryDto[]>((await mine()).body).data).toEqual([]);

    const addressId = await seedAddress(customer.userId, NEARBY);
    const order = async (listingId: string) => {
      await as(customer.accessToken).post('/cart/items', { sellerListingId: listingId, qty: 1 }).expect(200);
      await api()
        .post('/api/v1/orders')
        .set('Authorization', bearer(customer.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ addressId, paymentMethod: PaymentMethod.COD })
        .expect(201);
    };
    const rice = c.products.rice[0]!;
    const shirt = c.products.shirts[0]!;
    await order(rice.listingId);
    await order(shirt.listingId);

    let list = expectSuccess<ProductSummaryDto[]>((await mine()).body).data;
    expect(list.map((p) => p.id)).toEqual([shirt.productId, rice.productId]);
    expect(list[0]!.defaultVariant?.pricePaise).toBe(10000);

    // Out of stock now → not offered again; another customer sees nothing of this history.
    await prisma.sellerListing.update({ where: { id: shirt.listingId }, data: { stockQty: 0, reservedQty: 0 } });
    list = expectSuccess<ProductSummaryDto[]>((await mine()).body).data;
    expect(list.map((p) => p.id)).toEqual([rice.productId]);
    expect(expectSuccess<ProductSummaryDto[]>((await as(other.accessToken).get('/products/previously-ordered').expect(200)).body).data).toEqual([]);
  });
});
