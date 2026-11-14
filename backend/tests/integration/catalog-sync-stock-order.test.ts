/**
 * Product / category synchronisation and out-of-stock ordering — the
 * regressions behind three customer-visible bugs:
 *
 *   1. Stock priority (GET /products, GET /products/search): products with
 *      stock to sell come first, out-of-stock ones last, in every sort, with
 *      keyset pagination that never skips or repeats a product across the
 *      boundary; reserved units count as sold (stock − reserved), low stock is
 *      still in stock, an off-sale listing is out of stock; a product that
 *      sells out moves down and comes back up when replenished.
 *   2. Category lifecycle seen by customers (GET /categories, GET /home):
 *      a switched-off subcategory disappears and returns when switched back
 *      on; a deleted one never comes back (deletion is refused while products
 *      are attached — products are never touched); every committed change
 *      — and a Home layout publish or a Home main-categories save — tells
 *      connected apps to ask again (realtime `catalog.changed`), and the
 *      published layout is never served from an HTTP cache (no-cache).
 *   3. Seller panel: every own product is returned with its canonical
 *      category path — imported or created by hand alike — and listings carry
 *      their parent category for search; another seller's never appear.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalStatus,
  ConfigKey,
  ProductStatus,
  SellerType,
  UnitType,
  UserRole,
  type CategoryDto,
  type CursorPage,
  type HomeFeedDto,
  type HomeLayoutContent,
  type HomeLayoutDto,
  type ProductSummaryDto,
  type ServiceabilityResult,
} from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { getAdminHomeLayout, publishHomeLayout, saveHomeLayoutDraft } from '../../src/modules/content/home-layout.service';
import { getAdminHomeMainCategories, saveHomeMainCategories } from '../../src/modules/content/home-categories.service';
import { importQueuesIdle } from '../../src/modules/product-import/import-worker';

// Count the realtime "catalogue changed" signals (no socket server runs in tests).
const realtime = vi.hoisted(() => ({ catalogChanged: 0 }));
vi.mock('../../src/realtime/socket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/socket')>();
  return {
    ...actual,
    emitCatalogChanged: () => {
      realtime.catalogChanged += 1;
    },
  };
});

let counter = 0;

async function seller(name: string): Promise<string> {
  counter += 1;
  const row = await prisma.seller.create({
    data: {
      code: `SYNC-${counter}-${randomUUID().slice(0, 4)}`,
      name,
      sellerType: SellerType.GROCERY,
      addressLine: 'Main Road',
      city: 'Railmagra',
      state: 'Rajasthan',
      pincode: '313329',
      latitude: 25.03,
      longitude: 74.11,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  return row.id;
}

/** A seller with an OWNER login (seller-panel routes). */
async function sellerWithLogin(mobile: string, name: string): Promise<{ id: string; token: string }> {
  const id = await seller(name);
  const user = await prisma.user.create({ data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id, token: (await loginAs(mobile)).accessToken };
}

async function category(sellerId: string, path: string, parentId: string | null = null, name = path.split('/').pop()!): Promise<string> {
  const row = await prisma.category.create({
    data: { sellerId, parentId, name, slug: path.split('/').pop()!, path, depth: path.split('/').length - 1 },
  });
  return row.id;
}

interface ProductSpec {
  name: string;
  popularity?: number;
  pricePaise?: number;
  stockQty?: number;
  reservedQty?: number;
  isAvailable?: boolean;
}

async function product(sellerId: string, categoryId: string, spec: ProductSpec): Promise<{ id: string; listingId: string }> {
  counter += 1;
  const row = await prisma.product.create({
    data: {
      name: spec.name,
      slug: `sync-${counter}`,
      categoryId,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      submittedBySellerId: sellerId,
      popularityScore: spec.popularity ?? 0,
      searchKeywords: [],
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: row.id, sku: `SYNC-SKU-${counter}`, variantName: '1 L', unit: UnitType.L, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  const listing = await prisma.sellerListing.create({
    data: {
      sellerId,
      variantId: variant.id,
      mrpPaise: (spec.pricePaise ?? 10000) + 2000,
      pricePaise: spec.pricePaise ?? 10000,
      stockQty: spec.stockQty ?? 20,
      reservedQty: spec.reservedQty ?? 0,
      isAvailable: spec.isAvailable ?? true,
    },
  });
  return { id: row.id, listingId: listing.id };
}

const get = async <T>(path: string): Promise<T> => expectSuccess<T>((await api().get(`/api/v1${path}`).expect(200)).body).data;

/** Every product of a listing, walking the cursor `limit` at a time. */
async function walk(path: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const next: CursorPage<ProductSummaryDto> = await get(`${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...next.items.map((p) => p.id));
    cursor = next.hasMore ? next.nextCursor : null;
  } while (cursor);
  return seen;
}

const isInStock = (p: ProductSummaryDto) => (p.variants ?? []).some((v) => v.inStock);

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  realtime.catalogChanged = 0;
});

/* -------------------------------------------------------------------------- */
/* 1. Stock priority                                                          */
/* -------------------------------------------------------------------------- */

describe('customer listings: in-stock products first, out-of-stock last', () => {
  async function drinksShelf() {
    const s = await seller('Drinks Store');
    const grocery = await category(s, 'grocery');
    const drinks = await category(s, 'grocery/drinks', grocery, 'Drinks');
    const p = {
      fresh: await product(s, drinks, { name: 'Fresh Lime', popularity: 50, pricePaise: 3000 }),
      lassi: await product(s, drinks, { name: 'Sweet Lassi', popularity: 10, pricePaise: 5000 }),
      // One left: LOW stock is still in stock.
      soda: await product(s, drinks, { name: 'Club Soda', popularity: 1, pricePaise: 2000, stockQty: 1 }),
      // Raw stock 0.
      cola: await product(s, drinks, { name: 'Cola Can', popularity: 100, pricePaise: 4000, stockQty: 0 }),
      // Physical stock, but every unit reserved by checkouts: available 0.
      juice: await product(s, drinks, { name: 'Mango Juice', popularity: 90, pricePaise: 6000, stockQty: 3, reservedQty: 3 }),
      // Stock, but the seller switched the listing off sale.
      tea: await product(s, drinks, { name: 'Iced Tea', popularity: 80, pricePaise: 1000, stockQty: 10, isAvailable: false }),
    };
    return { grocery, drinks, p };
  }

  it('orders each group by the chosen sort, paginates across the boundary without repeats, and agrees with the cards', async () => {
    const { grocery, drinks, p } = await drinksShelf();
    const popular = [p.fresh.id, p.lassi.id, p.soda.id, p.cola.id, p.juice.id, p.tea.id];

    // Popular (the default): in stock by popularity, then out of stock by popularity.
    const full = await get<CursorPage<ProductSummaryDto>>(`/products?categoryId=${drinks}&limit=30`);
    expect(full.items.map((x) => x.id)).toEqual(popular);
    // The card's own "Out of Stock" flag matches the grouping exactly.
    expect(full.items.map(isInStock)).toEqual([true, true, true, false, false, false]);

    // Every page size walks the same order — the boundary is never skipped or repeated.
    for (const limit of [1, 2, 4]) expect(await walk(`/products?categoryId=${drinks}`, limit)).toEqual(popular);
    // The main category (parent path) lists the same, in the same order.
    expect(await walk(`/products?categoryId=${grocery}`, 2)).toEqual(popular);

    // An explicit sort still keeps the groups: cheapest in-stock first, then cheapest out-of-stock.
    expect(await walk(`/products?categoryId=${drinks}&sort=PRICE_ASC`, 2)).toEqual([p.soda.id, p.fresh.id, p.lassi.id, p.tea.id, p.cola.id, p.juice.id]);
    expect(await walk(`/products?categoryId=${drinks}&sort=PRICE_DESC`, 2)).toEqual([p.lassi.id, p.fresh.id, p.soda.id, p.juice.id, p.cola.id, p.tea.id]);

    // Deterministic: asking again gives the same order.
    expect((await get<CursorPage<ProductSummaryDto>>(`/products?categoryId=${drinks}&limit=30`)).items.map((x) => x.id)).toEqual(popular);

    // "In stock only" still lists just the first group.
    expect(await walk(`/products?categoryId=${drinks}&inStock=true`, 2)).toEqual([p.fresh.id, p.lassi.id, p.soda.id]);
  });

  it('a product that sells out moves to the bottom, and returns among the in-stock ones when replenished', async () => {
    const { drinks, p } = await drinksShelf();

    // Fresh Lime sells out (stock taken by reservations); Cola Can is restocked.
    await prisma.sellerListing.update({ where: { id: p.fresh.listingId }, data: { reservedQty: 20 } });
    await prisma.sellerListing.update({ where: { id: p.cola.listingId }, data: { stockQty: 12 } });

    expect(await walk(`/products?categoryId=${drinks}`, 2)).toEqual([p.cola.id, p.lassi.id, p.soda.id, p.juice.id, p.tea.id, p.fresh.id]);

    // Reservations released and the off-sale listing switched back on.
    await prisma.sellerListing.update({ where: { id: p.fresh.listingId }, data: { reservedQty: 0 } });
    await prisma.sellerListing.update({ where: { id: p.tea.listingId }, data: { isAvailable: true } });
    expect(await walk(`/products?categoryId=${drinks}`, 3)).toEqual([p.cola.id, p.tea.id, p.fresh.id, p.lassi.id, p.soda.id, p.juice.id]);
  });

  it('a store page groups by that store\'s own stock', async () => {
    const a = await seller('Store A');
    const b = await seller('Store B');
    const drinksA = await category(a, 'drinks');
    const drinksB = await category(b, 'drinks');
    const outA = await product(a, drinksA, { name: 'Soda A', popularity: 99, stockQty: 0 });
    const inA = await product(a, drinksA, { name: 'Water A', popularity: 1 });
    await product(b, drinksB, { name: 'Water B', popularity: 50 });

    expect(await walk(`/products?sellerId=${a}`, 1)).toEqual([inA.id, outA.id]);
  });

  it('search lists matching in-stock products first (best match first in each group), across pages', async () => {
    const s = await seller('Search Store');
    const drinks = await category(s, 'drinks', null, 'Drinks');
    const exactOut = await product(s, drinks, { name: 'Cola', popularity: 100, stockQty: 0 });
    const zero = await product(s, drinks, { name: 'Cola Zero', popularity: 5 });
    const diet = await product(s, drinks, { name: 'Diet Cola', popularity: 1 });
    const reserved = await product(s, drinks, { name: 'Cherry Cola', popularity: 50, stockQty: 2, reservedQty: 2 });

    const all = await walk('/products/search?q=cola', 30);
    expect(all.slice(0, 2).sort()).toEqual([zero.id, diet.id].sort());
    expect(all.slice(2).sort()).toEqual([exactOut.id, reserved.id].sort());
    // The exact name still leads its own group.
    expect(all[2]).toBe(exactOut.id);
    // Page by page: the same order, nothing repeated or skipped.
    expect(await walk('/products/search?q=cola', 1)).toEqual(all);

    // Restocked: the exact match is first overall again.
    await prisma.sellerListing.updateMany({ where: { variant: { productId: exactOut.id } }, data: { stockQty: 5 } });
    expect((await walk('/products/search?q=cola', 2))[0]).toBe(exactOut.id);
  });
});

/* -------------------------------------------------------------------------- */
/* 1b. Several sellers list the same variant                                  */
/* -------------------------------------------------------------------------- */

describe('several sellers list the same product: the stock group follows the offer the card shows', () => {
  /** Seller A owns the product; seller B lists the SAME variant. */
  async function shared(a: { stockQty: number }, b: { stockQty: number }) {
    const sa = await seller('Seller A');
    const sb = await seller('Seller B');
    const drinksA = await category(sa, 'drinks', null, 'Drinks');
    await category(sb, 'drinks', null, 'Drinks');
    const sharedProduct = await product(sa, drinksA, { name: 'Shared Cola', popularity: 100, stockQty: a.stockQty, pricePaise: 4000 });
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: sharedProduct.id } });
    const listingB = await prisma.sellerListing.create({
      data: { sellerId: sb, variantId: variant.id, mrpPaise: 5000, pricePaise: 3900, stockQty: b.stockQty, isAvailable: true },
    });
    // A single-seller product in stock, less popular: the reference point of the in-stock group.
    const plain = await product(sa, drinksA, { name: 'Cola Water', popularity: 1 });
    return { sa, sb, drinksA, sharedProduct, listingA: sharedProduct.listingId, listingB: listingB.id, plain };
  }

  const listing = (categoryId: string) => get<CursorPage<ProductSummaryDto>>(`/products?categoryId=${categoryId}&limit=30`);
  const card = (page: CursorPage<ProductSummaryDto>, id: string) => {
    const v = page.items.find((item) => item.id === id)!.variants![0]!;
    return { inStock: v.inStock, sellerAcceptingOrders: v.sellerAcceptingOrders, sellerName: v.sellerName };
  };
  const closeStore = (sellerId: string, closed: boolean) => prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders: !closed } });

  it('one seller in stock, the other out of stock (both open): in stock, shown from the seller that has it', async () => {
    const t = await shared({ stockQty: 0 }, { stockQty: 6 });
    const page = await listing(t.drinksA);
    expect(page.items.map((x) => x.id)).toEqual([t.sharedProduct.id, t.plain.id]);
    expect(card(page, t.sharedProduct.id)).toMatchObject({ inStock: true, sellerAcceptingOrders: true, sellerName: 'Seller B' });
  });

  it('open seller out of stock, closed seller in stock: the card reads "Out of Stock" — and it sorts with the out-of-stock products', async () => {
    const t = await shared({ stockQty: 0 }, { stockQty: 6 });
    await closeStore(t.sb, true);
    const page = await listing(t.drinksA);
    expect(card(page, t.sharedProduct.id)).toMatchObject({ inStock: false, sellerAcceptingOrders: true, sellerName: 'Seller A' });
    expect(page.items.map((x) => x.id)).toEqual([t.plain.id, t.sharedProduct.id]);
    // Search groups it the same way: both match "cola"; the one in stock comes first.
    expect(await walk('/products/search?q=cola', 1)).toEqual([t.plain.id, t.sharedProduct.id]);
    // B reopens: in stock again (from B), first in search too.
    await closeStore(t.sb, false);
    expect(await walk('/products/search?q=cola', 1)).toEqual([t.sharedProduct.id, t.plain.id]);
  });

  it('open seller in stock, closed seller out of stock: in stock', async () => {
    const t = await shared({ stockQty: 4 }, { stockQty: 0 });
    await closeStore(t.sb, true);
    const page = await listing(t.drinksA);
    expect(card(page, t.sharedProduct.id)).toMatchObject({ inStock: true, sellerAcceptingOrders: true, sellerName: 'Seller A' });
    expect(page.items.map((x) => x.id)).toEqual([t.sharedProduct.id, t.plain.id]);
  });

  it('every seller listing it closed: the closed store\'s stock counts — the card says "Store closed", not "Out of Stock", and it stays in the in-stock group', async () => {
    const t = await shared({ stockQty: 0 }, { stockQty: 6 });
    await closeStore(t.sa, true);
    await closeStore(t.sb, true);
    // Cola Water's store (A) is closed too: both are browsable, neither out of stock.
    const page = await listing(t.drinksA);
    expect(card(page, t.sharedProduct.id)).toMatchObject({ inStock: true, sellerAcceptingOrders: false, sellerName: 'Seller B' });
    expect(page.items.map((x) => x.id)).toEqual([t.sharedProduct.id, t.plain.id]);
  });

  it('both sellers out of stock: out of stock; replenished at either seller: back in the in-stock group', async () => {
    const t = await shared({ stockQty: 0 }, { stockQty: 0 });
    let page = await listing(t.drinksA);
    expect(card(page, t.sharedProduct.id).inStock).toBe(false);
    expect(page.items.map((x) => x.id)).toEqual([t.plain.id, t.sharedProduct.id]);

    await prisma.sellerListing.update({ where: { id: t.listingB }, data: { stockQty: 3 } });
    page = await listing(t.drinksA);
    expect(card(page, t.sharedProduct.id)).toMatchObject({ inStock: true, sellerName: 'Seller B' });
    expect(page.items.map((x) => x.id)).toEqual([t.sharedProduct.id, t.plain.id]);

    // Seller B's units all reserved, seller A restocked: still in stock, now from A.
    await prisma.sellerListing.update({ where: { id: t.listingB }, data: { reservedQty: 3 } });
    await prisma.sellerListing.update({ where: { id: t.listingA }, data: { stockQty: 2 } });
    page = await listing(t.drinksA);
    expect(card(page, t.sharedProduct.id)).toMatchObject({ inStock: true, sellerName: 'Seller A' });
    expect(page.items.map((x) => x.id)).toEqual([t.sharedProduct.id, t.plain.id]);
  });

  it('a store page only counts that store: B\'s page shows its own stock, whatever A has', async () => {
    const t = await shared({ stockQty: 9 }, { stockQty: 0 });
    const pageB = await get<CursorPage<ProductSummaryDto>>(`/products?sellerId=${t.sb}&limit=30`);
    expect(pageB.items.map((x) => x.id)).toEqual([t.sharedProduct.id]);
    expect(card(pageB, t.sharedProduct.id)).toMatchObject({ inStock: false, sellerName: 'Seller B' });
    const pageA = await get<CursorPage<ProductSummaryDto>>(`/products?sellerId=${t.sa}&limit=30`);
    expect(pageA.items.map((x) => x.id)).toEqual([t.sharedProduct.id, t.plain.id]);
    expect(card(pageA, t.sharedProduct.id)).toMatchObject({ inStock: true, sellerName: 'Seller A' });
  });

  it('delivery eligibility differs by customer but never changes the stock group or the shown offer (it is platform-wide)', async () => {
    const t = await shared({ stockQty: 0 }, { stockQty: 6 });
    await closeStore(t.sb, true);
    const centre = { latitude: 25.029, longitude: 74.11 };
    await configService.set({ key: ConfigKey.PLATFORM_LOCATION, value: { name: 'Service centre', addressLine: 'Main Road', landmark: null, ...centre } as never });
    const radius = await configService.get(ConfigKey.MAX_SERVICE_RADIUS_KM);
    const here = await get<ServiceabilityResult>(`/store/serviceability?lat=${centre.latitude}&lng=${centre.longitude}`);
    const far = await get<ServiceabilityResult>(`/store/serviceability?lat=${centre.latitude + (radius + 30) / 111.2}&lng=${centre.longitude}`);
    expect(here.serviceable).toBe(true);
    expect(far.serviceable).toBe(false);
    // The listing takes no location: both customers see the same order and the same card.
    const first = await listing(t.drinksA);
    const second = await listing(t.drinksA);
    expect(second.items.map((x) => x.id)).toEqual(first.items.map((x) => x.id));
    expect(first.items.map((x) => x.id)).toEqual([t.plain.id, t.sharedProduct.id]);
    expect(card(first, t.sharedProduct.id)).toMatchObject({ inStock: false, sellerName: 'Seller A' });
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Category lifecycle as customers see it                                  */
/* -------------------------------------------------------------------------- */

const subcategoryNames = (tree: CategoryDto[]) => tree.flatMap((top) => (top.children ?? []).map((child) => child.name));

describe('categories removed, hidden or re-ordered by the admin or a seller leave the customer app', () => {
  it('a switched-off subcategory leaves /categories and /home, comes back when switched on, and a deleted one stays gone', async () => {
    const owner = await sellerWithLogin('9400000921', 'Aadione Grocery');
    const as = {
      post: (path: string, body: object) => api().post(`/api/v1/seller${path}`).set('Authorization', bearer(owner.token)).send(body),
      patch: (path: string, body: object) => api().patch(`/api/v1/seller${path}`).set('Authorization', bearer(owner.token)).send(body),
      del: (path: string) => api().delete(`/api/v1/seller${path}`).set('Authorization', bearer(owner.token)),
    };
    const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await as.post('/categories', { name: 'Grocery' }).expect(201)).body).data;
    const groceryId = tree.categories.find((c) => c.name === 'Grocery')!.id;
    const teaId = expectSuccess<{ id: string }>((await as.post('/subcategories', { parentId: groceryId, name: 'Tea & Coffee' }).expect(201)).body).data.id;
    const drinksId = expectSuccess<{ id: string }>((await as.post('/subcategories', { parentId: groceryId, name: 'Drinks' }).expect(201)).body).data.id;
    // Every committed category change is announced (top + two subcategories).
    expect(realtime.catalogChanged).toBe(3);

    const tea = await product(owner.id, teaId, { name: 'Assam Tea' });
    await product(owner.id, drinksId, { name: 'Lemon Soda' });

    const customerTree = () => get<CategoryDto[]>('/categories?includeChildren=true&withCounts=true');
    expect(subcategoryNames(await customerTree()).sort()).toEqual(['Drinks', 'Tea & Coffee']);

    // Hide (switch off): gone at once — no cache to wait for — and announced.
    realtime.catalogChanged = 0;
    await as.patch(`/subcategories/${teaId}`, { isActive: false }).expect(200);
    expect(realtime.catalogChanged).toBe(1);
    expect(subcategoryNames(await customerTree())).toEqual(['Drinks']);
    const home = await get<HomeFeedDto>('/home');
    expect(subcategoryNames([...home.categories, ...(home.hiddenCategories ?? [])])).toEqual(['Drinks']);
    // Its products are hidden with it — never deleted.
    expect((await walk(`/products?categoryId=${groceryId}`, 10)).includes(tea.id)).toBe(false);
    expect(await prisma.product.count({ where: { id: tea.id, deletedAt: null } })).toBe(1);

    // Unhide: back, and announced.
    realtime.catalogChanged = 0;
    await as.patch(`/subcategories/${teaId}`, { isActive: true }).expect(200);
    expect(realtime.catalogChanged).toBe(1);
    expect(subcategoryNames(await customerTree()).sort()).toEqual(['Drinks', 'Tea & Coffee']);

    // Re-order: the customer tree follows the new order, and it is announced.
    realtime.catalogChanged = 0;
    await as.patch(`/subcategories/${teaId}`, { displayOrder: 0 }).expect(200);
    await as.patch(`/subcategories/${drinksId}`, { displayOrder: 5 }).expect(200);
    expect(realtime.catalogChanged).toBe(2);
    expect(subcategoryNames(await customerTree())).toEqual(['Tea & Coffee', 'Drinks']);
    await as.patch(`/subcategories/${teaId}`, { displayOrder: 9 }).expect(200);
    expect(subcategoryNames(await customerTree())).toEqual(['Drinks', 'Tea & Coffee']);

    // Delete: refused while a product is attached (products are never touched)…
    await as.del(`/subcategories/${teaId}`).expect(409);
    expect(await prisma.product.count({ where: { id: tea.id, deletedAt: null } })).toBe(1);
    // …once the product is moved out, the empty category is deleted (soft) and never comes back.
    await prisma.product.update({ where: { id: tea.id }, data: { categoryId: drinksId } });
    realtime.catalogChanged = 0;
    await as.del(`/subcategories/${teaId}`).expect(200);
    expect(realtime.catalogChanged).toBe(1);
    expect(subcategoryNames(await customerTree())).toEqual(['Drinks']);
    const after = await get<HomeFeedDto>('/home');
    expect(subcategoryNames([...after.categories, ...(after.hiddenCategories ?? [])])).toEqual(['Drinks']);
    expect((await prisma.category.findUnique({ where: { id: teaId } }))?.deletedAt).not.toBeNull();
    // The moved product is still sold, in its new category.
    expect(await walk(`/products?categoryId=${drinksId}`, 10)).toContain(tea.id);
  });

  it('the admin hiding and re-ordering main categories is applied by /home and announced', async () => {
    const s = await seller('Two Aisles');
    const grocery = await category(s, 'grocery', null, 'Grocery');
    const fashion = await category(s, 'fashion', null, 'Fashion');
    await product(s, grocery, { name: 'Rice' });
    await product(s, fashion, { name: 'Shirt' });
    const admin = await prisma.user.create({ data: { mobile: '9400000922', fullName: 'Admin', role: UserRole.ADMIN } });

    const current = await getAdminHomeMainCategories();
    await saveHomeMainCategories(
      { order: ['fashion', 'grocery'], hidden: [], featured: [], newCategoriesVisible: true, basedOnUpdatedAt: current.updatedAt },
      admin.id,
    );
    expect(realtime.catalogChanged).toBe(1);
    expect((await get<HomeFeedDto>('/home')).categories.map((c) => c.name)).toEqual(['Fashion', 'Grocery']);

    const saved = await getAdminHomeMainCategories();
    await saveHomeMainCategories(
      { order: ['fashion', 'grocery'], hidden: ['fashion'], featured: [], newCategoriesVisible: true, basedOnUpdatedAt: saved.updatedAt },
      admin.id,
    );
    expect(realtime.catalogChanged).toBe(2);
    const home = await get<HomeFeedDto>('/home');
    expect(home.categories.map((c) => c.name)).toEqual(['Grocery']);
    expect((home.hiddenCategories ?? []).map((c) => c.name)).toEqual(['Fashion']);
  });

  it('a published layout (a category hidden, a section hidden) is announced and never served from an HTTP cache', async () => {
    const s = await seller('Layout Store');
    const grocery = await category(s, 'grocery', null, 'Grocery');
    const tea = await category(s, 'grocery/tea-coffee', grocery, 'Tea & Coffee');
    await product(s, tea, { name: 'Filter Coffee' });
    const admin = await prisma.user.create({ data: { mobile: '9400000923', fullName: 'Admin', role: UserRole.ADMIN } });

    const before = await api().get('/api/v1/content/home-layout').expect(200);
    expect(before.headers['cache-control']).toBe('no-cache');
    const published = expectSuccess<HomeLayoutDto>(before.body).data;

    expect(published.layout.sections.find((section) => section.key === 'top_picks')?.visible).toBe(true);
    const layout: HomeLayoutContent = {
      ...published.layout,
      sections: published.layout.sections.map((section) => (section.key === 'top_picks' ? { ...section, visible: false } : section)),
      categoryStyles: [{ path: 'grocery/tea-coffee', displayName: null, displayNameHi: null, tileBackground: null, textColor: null, hidden: true }],
    };
    await saveHomeLayoutDraft(layout, admin.id);
    expect(realtime.catalogChanged).toBe(0); // a draft is not live
    await publishHomeLayout((await getAdminHomeLayout()).published?.revision ?? 0, admin.id);
    expect(realtime.catalogChanged).toBe(1);

    const live = await get<HomeLayoutDto>('/content/home-layout');
    expect(live.layout.categoryStyles.find((style) => style.path === 'grocery/tea-coffee')?.hidden).toBe(true);
    expect(live.layout.sections.find((section) => section.key === 'top_picks')?.visible).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Seller panel                                                            */
/* -------------------------------------------------------------------------- */

describe('seller panel: every own product with its canonical category path', () => {
  it('lists all own products (created or imported) with category + subcategory ids, listings with their parent, never another seller\'s', async () => {
    const owner = await sellerWithLogin('9400000924', 'Drinks Owner');
    const other = await seller('Other Store');
    const grocery = await category(owner.id, 'grocery', null, 'Grocery');
    const drinks = await category(owner.id, 'grocery/drinks', grocery, 'Drinks');
    const mine = [];
    for (let i = 0; i < 12; i += 1) mine.push((await product(owner.id, drinks, { name: `Bottle ${i}` })).id);
    // The bulk importer's rows: the same columns (submittedBySellerId + the seller's own category).
    const imported = await product(owner.id, drinks, { name: 'Imported Sparkling Water' });
    const otherDrinks = await category(other, 'grocery/drinks', await category(other, 'grocery'));
    const foreign = await product(other, otherDrinks, { name: 'Foreign Soda' });

    const products = expectSuccess<{ id: string; categoryId: string; category: { id: string; name: string }; subcategory: { id: string; name: string } | null }[]>(
      (await api().get('/api/v1/seller/products').set('Authorization', bearer(owner.token)).expect(200)).body,
    ).data;
    expect(products.map((p) => p.id).sort()).toEqual([...mine, imported.id].sort());
    expect(products.some((p) => p.id === foreign.id)).toBe(false);
    for (const p of products) {
      expect(p.categoryId).toBe(drinks);
      expect(p.category).toEqual({ id: grocery, name: 'Grocery' });
      expect(p.subcategory).toEqual({ id: drinks, name: 'Drinks' });
    }

    const listings = expectSuccess<{ productId: string; categoryId: string; categoryName: string; parentCategoryId: string | null; parentCategoryName: string | null }[]>(
      (await api().get('/api/v1/seller/listings').set('Authorization', bearer(owner.token)).expect(200)).body,
    ).data;
    expect(listings).toHaveLength(13);
    for (const l of listings) {
      expect(l).toMatchObject({ categoryId: drinks, categoryName: 'Drinks', parentCategoryId: grocery, parentCategoryName: 'Grocery' });
    }
    // A single listing (the one-query path) carries it too.
    const one = listings[0]!;
    const listingId = (await prisma.sellerListing.findFirstOrThrow({ where: { variant: { productId: one.productId } } })).id;
    const detail = expectSuccess<{ parentCategoryId: string | null }>(
      (await api().get(`/api/v1/seller/listings/${listingId}`).set('Authorization', bearer(owner.token)).expect(200)).body,
    ).data;
    expect(detail.parentCategoryId).toBe(grocery);
  });

  it('a CSV-imported product and a hand-created one in the same subcategory come back identically (category + subcategory)', async () => {
    const owner = await sellerWithLogin('9400000925', 'Import Owner');
    const sellerApi = {
      get: (path: string) => api().get(`/api/v1/seller${path}`).set('Authorization', bearer(owner.token)),
      post: (path: string, body: object) => api().post(`/api/v1/seller${path}`).set('Authorization', bearer(owner.token)).send(body),
    };
    const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await sellerApi.post('/categories', { name: 'Grocery' }).expect(201)).body).data;
    const groceryId = tree.categories.find((c) => c.name === 'Grocery')!.id;
    const drinksId = expectSuccess<{ id: string }>((await sellerApi.post('/subcategories', { parentId: groceryId, name: 'Drinks' }).expect(201)).body).data.id;

    // By hand.
    const manual = expectSuccess<{ id: string }>(
      (await sellerApi.post('/products', { categoryId: drinksId, name: 'Lemon Squash', sku: 'MAN-1', variantName: '750 ml', unit: 'ML', unitValue: 750, mrpPaise: 15000, pricePaise: 14000, stockQty: 5 }).expect(201)).body,
    ).data;

    // Bulk import (upload -> analysis -> confirm), names without "drink" in them.
    const csv = [
      'seller_sku,barcode,product_name,category,subcategory,brand,mrp,selling_price,stock_quantity,unit,unit_value,variant_name,image_filename,additional_image_filenames,hindi_name,is_active',
      'IMP-1,,Sparkling Water 500 ml,Grocery,Drinks,,40,35,24,ml,500,,,,,yes',
      'IMP-2,,Coconut Water 200 ml,grocery,drinks,,50,45,0,ml,200,,,,,yes',
    ].join('\n');
    const uploaded = await api()
      .post('/api/v1/seller/imports')
      .set('Authorization', bearer(owner.token))
      .field('mode', 'CREATE')
      .attach('file', Buffer.from(csv, 'utf8'), 'products.csv');
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const jobId = expectSuccess<{ id: string }>(uploaded.body).data.id;
    await importQueuesIdle();
    await sellerApi.post(`/imports/${jobId}/confirm`, { mode: 'CREATE' }).expect(200);
    await importQueuesIdle();
    expect(expectSuccess<{ status: string; createdCount: number }>((await sellerApi.get(`/imports/${jobId}`).expect(200)).body).data).toMatchObject({ status: 'COMPLETED', createdCount: 2 });

    const products = expectSuccess<{ id: string; name: string; categoryId: string; category: { id: string }; subcategory: { id: string } | null }[]>(
      (await sellerApi.get('/products').expect(200)).body,
    ).data;
    expect(products.map((p) => p.name).sort()).toEqual(['Coconut Water 200 ml', 'Lemon Squash', 'Sparkling Water 500 ml']);
    for (const p of products) {
      expect({ categoryId: p.categoryId, top: p.category.id, sub: p.subcategory?.id }).toEqual({ categoryId: drinksId, top: groceryId, sub: drinksId });
    }
    expect(products.some((p) => p.id === manual.id)).toBe(true);
  });
});
