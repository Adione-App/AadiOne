/**
 * Seller-owned categories and subcategories — create, rename, delete.
 *
 *   - ownership is enforced server-side: another seller's category or
 *     subcategory is NOT_FOUND for every write, whatever id is sent;
 *   - deletion is refused while any product is linked (products are never
 *     deleted or moved by it), is a soft delete, and frees the name;
 *   - the customer marketplace keeps merging sellers' categories by path,
 *     before and after a rename/delete;
 *   - a restaurant's menu sections stay restaurant-only: not deletable through
 *     /seller/categories and never part of the marketplace category tree.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, SellerType, UserRole, type CategoryDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

interface Tree {
  usesMenuSections: boolean;
  categories: {
    id: string;
    name: string;
    productCount: number;
    subcategories: { id: string; name: string; productCount: number }[];
  }[];
}

/** An ACTIVE seller (both onboarding gates passed) with an OWNER login. */
async function seedSeller(
  mobile: string,
  name: string,
  sellerType: SellerType = SellerType.GROCERY,
): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      sellerType,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...sellerLifecycleFields('APPROVED'),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken };
}

const as = (token: string) => ({
  get: (path: string) => api().get(`/api/v1/seller${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object) => api().post(`/api/v1/seller${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1/seller${path}`).set('Authorization', bearer(token)).send(body),
  del: (path: string) => api().delete(`/api/v1/seller${path}`).set('Authorization', bearer(token)),
});

async function tree(token: string): Promise<Tree> {
  return expectSuccess<Tree>((await as(token).get('/categories').expect(200)).body).data;
}

async function createTop(token: string, name: string): Promise<string> {
  const data = expectSuccess<Tree>((await as(token).post('/categories', { name }).expect(201)).body).data;
  return data.categories.find((c) => c.name === name)!.id;
}

async function createSub(token: string, parentId: string, name: string): Promise<string> {
  return expectSuccess<{ id: string }>((await as(token).post('/subcategories', { parentId, name }).expect(201)).body).data.id;
}

async function createProduct(token: string, categoryId: string, name: string): Promise<{ id: string; variantId: string }> {
  const res = await as(token)
    .post('/products', {
      categoryId,
      name,
      sku: `SKU-${randomUUID().slice(0, 8)}`,
      variantName: '1 kg',
      unit: 'KG',
      unitValue: 1,
      mrpPaise: 12000,
      pricePaise: 10000,
      stockQty: 20,
    })
    .expect(201);
  return expectSuccess<{ id: string; variantId: string }>(res.body).data;
}

/**
 * Makes a seller's product customer-visible. The product already carries the
 * seller's price and stock (created complete); this stands in for the admin
 * batch approval, covered by product-approval tests.
 */
async function publish(_sellerId: string, product: { id: string; variantId: string }): Promise<void> {
  await prisma.product.update({ where: { id: product.id }, data: { approvalStatus: 'APPROVED', status: 'ACTIVE' } });
}

async function customerCategories(): Promise<CategoryDto[]> {
  const res = await api().get('/api/v1/categories?includeChildren=true&withCounts=true').expect(200);
  return expectSuccess<CategoryDto[]>(res.body).data;
}

function expectLinkedRefusal(res: { status: number; body: unknown }, count: number) {
  expect(res.status).toBe(409);
  const error = expectError(res.body);
  expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
  expect(error.message).toMatch(new RegExp(`^${count} product`));
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

/* -------------------------------------------------------------------------- */

describe('top categories and subcategories — create and rename', () => {
  it('creates, renames and keeps product references when a category or subcategory is renamed', async () => {
    const seller = await seedSeller('9600000001', 'Category Seller');
    const groceryId = await createTop(seller.token, 'Grocery');
    const riceId = await createSub(seller.token, groceryId, 'Rice');
    const product = await createProduct(seller.token, riceId, 'Sona Masoori Rice');
    const topProduct = await createProduct(seller.token, groceryId, 'Mixed Grocery Kit');

    await as(seller.token).patch(`/categories/${groceryId}`, { name: 'Daily Grocery' }).expect(200);
    await as(seller.token).patch(`/subcategories/${riceId}`, { name: 'Basmati Rice' }).expect(200);

    const [top] = (await tree(seller.token)).categories;
    expect(top).toMatchObject({ id: groceryId, name: 'Daily Grocery', productCount: 1 });
    expect(top!.subcategories).toEqual([expect.objectContaining({ id: riceId, name: 'Basmati Rice', productCount: 1 })]);

    // The rename moved the materialised paths (top and the subcategory under it).
    expect(await prisma.category.findUniqueOrThrow({ where: { id: groceryId } })).toMatchObject({ path: 'daily-grocery' });
    expect(await prisma.category.findUniqueOrThrow({ where: { id: riceId } })).toMatchObject({ path: 'daily-grocery/basmati-rice' });

    // Products keep pointing at the same rows.
    for (const [p, categoryId] of [[product, riceId], [topProduct, groceryId]] as const) {
      const res = await as(seller.token).get(`/products/${p.id}`).expect(200);
      expect(expectSuccess<{ categoryId: string }>(res.body).data.categoryId).toBe(categoryId);
    }
  });

  it('keeps the existing name validation and duplicate rules', async () => {
    const seller = await seedSeller('9600000002', 'Duplicate Seller');
    const groceryId = await createTop(seller.token, 'Grocery');
    await createTop(seller.token, 'Snacks');
    await createSub(seller.token, groceryId, 'Rice');
    const dalId = await createSub(seller.token, groceryId, 'Dal');

    expect((await as(seller.token).post('/categories', { name: 'x' })).status).toBe(400);
    expect((await as(seller.token).post('/categories', { name: 'grocery' })).status).toBe(409);
    expect((await as(seller.token).patch(`/categories/${groceryId}`, { name: 'Snacks' })).status).toBe(409);
    expect((await as(seller.token).post('/subcategories', { parentId: groceryId, name: 'RICE' })).status).toBe(409);
    expect((await as(seller.token).patch(`/subcategories/${dalId}`, { name: 'Rice' })).status).toBe(409);
  });
});

/* -------------------------------------------------------------------------- */

describe('deleting categories and subcategories', () => {
  it('refuses to delete while products are linked — and never touches the products', async () => {
    const seller = await seedSeller('9600000011', 'Linked Seller');
    const groceryId = await createTop(seller.token, 'Grocery');
    const riceId = await createSub(seller.token, groceryId, 'Rice');
    const pending = await createProduct(seller.token, riceId, 'Pending Rice'); // still PENDING approval
    const approved = await createProduct(seller.token, riceId, 'Approved Rice');
    await publish(seller.id, approved);

    expectLinkedRefusal(await as(seller.token).del(`/subcategories/${riceId}`), 2);
    // The top category counts its subcategories' products too.
    expectLinkedRefusal(await as(seller.token).del(`/categories/${groceryId}`), 2);

    for (const id of [groceryId, riceId]) {
      expect((await prisma.category.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
    }
    for (const p of [pending, approved]) {
      expect(await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ categoryId: riceId, deletedAt: null });
    }
    // Both products keep their own listing (price and stock are part of a product).
    expect(await prisma.sellerListing.count({ where: { sellerId: seller.id } })).toBe(2);

    // Moving the editable (not yet approved) product out is the seller's way
    // forward; the approved one keeps the subcategory in use.
    const elsewhere = await createTop(seller.token, 'Snacks');
    await as(seller.token).patch(`/products/${pending.id}`, { categoryId: elsewhere }).expect(200);
    expectLinkedRefusal(await as(seller.token).del(`/subcategories/${riceId}`), 1);
  });

  it('deletes an empty subcategory (soft delete) and frees its name', async () => {
    const seller = await seedSeller('9600000012', 'Empty Sub Seller');
    const groceryId = await createTop(seller.token, 'Grocery');
    const riceId = await createSub(seller.token, groceryId, 'Rice');

    await as(seller.token).del(`/subcategories/${riceId}`).expect(200);

    expect((await tree(seller.token)).categories[0]!.subcategories).toEqual([]);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: riceId } })).deletedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'category.seller_subcategory.delete', entityId: riceId } })).toBe(1);

    // Deleted means gone for every write; the name can be used again.
    expect((await as(seller.token).patch(`/subcategories/${riceId}`, { name: 'Rice Again' })).status).toBe(404);
    expect((await as(seller.token).del(`/subcategories/${riceId}`)).status).toBe(404);
    await createSub(seller.token, groceryId, 'Rice');
  });

  it('deletes an empty top category together with its empty subcategories', async () => {
    const seller = await seedSeller('9600000013', 'Empty Top Seller');
    const groceryId = await createTop(seller.token, 'Grocery');
    const riceId = await createSub(seller.token, groceryId, 'Rice');
    const dalId = await createSub(seller.token, groceryId, 'Dal');

    const res = await as(seller.token).del(`/categories/${groceryId}`).expect(200);
    expect(expectSuccess<{ id: string; deletedSubcategoryIds: string[] }>(res.body).data).toMatchObject({ id: groceryId });
    expect(expectSuccess<{ deletedSubcategoryIds: string[] }>(res.body).data.deletedSubcategoryIds.sort()).toEqual([riceId, dalId].sort());

    expect((await tree(seller.token)).categories).toEqual([]);
    expect(await prisma.category.count({ where: { id: { in: [groceryId, riceId, dalId] }, deletedAt: null } })).toBe(0);
    // Soft delete: the rows still exist.
    expect(await prisma.category.count({ where: { id: { in: [groceryId, riceId, dalId] } } })).toBe(3);
    await createTop(seller.token, 'Grocery');
  });

  it('a deleted product (kept for order history) does not block deletion, and keeps its row and category link', async () => {
    const seller = await seedSeller('9600000014', 'History Seller');
    const groceryId = await createTop(seller.token, 'Grocery');
    const old = await createProduct(seller.token, groceryId, 'Discontinued Item');
    await prisma.product.update({ where: { id: old.id }, data: { deletedAt: new Date() } });

    await as(seller.token).del(`/categories/${groceryId}`).expect(200);

    expect(await prisma.product.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ categoryId: groceryId });
    expect(await prisma.productVariant.count({ where: { productId: old.id } })).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('ownership', () => {
  it("a seller can never rename, switch, delete or extend another seller's category or subcategory", async () => {
    const a = await seedSeller('9600000021', 'Owner A');
    const b = await seedSeller('9600000022', 'Intruder B');
    const aTop = await createTop(a.token, 'Grocery');
    const aSub = await createSub(a.token, aTop, 'Rice');

    const attempts = [
      ['rename top', await as(b.token).patch(`/categories/${aTop}`, { name: 'Hijacked' })],
      ['switch top off', await as(b.token).patch(`/categories/${aTop}`, { isActive: false })],
      ['delete top', await as(b.token).del(`/categories/${aTop}`)],
      ['rename sub', await as(b.token).patch(`/subcategories/${aSub}`, { name: 'Hijacked' })],
      ['delete sub', await as(b.token).del(`/subcategories/${aSub}`)],
      ['create sub under it', await as(b.token).post('/subcategories', { parentId: aTop, name: 'Intruder Sub' })],
      ['product under it', await as(b.token).post('/products', { categoryId: aSub, name: 'Intruder Product', sku: 'SKU-INTRUDER', variantName: '1 kg', unit: 'KG', unitValue: 1, mrpPaise: 1000, pricePaise: 900, stockQty: 1 })],
    ] as const;
    for (const [label, res] of attempts) {
      expect(res.status, label).toBe(404);
      expect(expectError(res.body).code, label).toBe(ErrorCode.NOT_FOUND);
    }

    // Wrong level is NOT_FOUND too: a subcategory id on the top-category route and vice versa.
    expect((await as(a.token).del(`/categories/${aSub}`)).status).toBe(404);
    expect((await as(a.token).del(`/subcategories/${aTop}`)).status).toBe(404);

    expect(await prisma.category.findUniqueOrThrow({ where: { id: aTop } })).toMatchObject({ name: 'Grocery', isActive: true, deletedAt: null });
    expect(await prisma.category.findUniqueOrThrow({ where: { id: aSub } })).toMatchObject({ name: 'Rice', deletedAt: null });
    expect((await tree(b.token)).categories).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('customer marketplace', () => {
  it('merges sellers’ categories by path, before and after a rename and a delete', async () => {
    const a = await seedSeller('9600000031', 'Market A');
    const b = await seedSeller('9600000032', 'Market B');
    const aTop = await createTop(a.token, 'Grocery');
    const bTop = await createTop(b.token, 'Grocery');
    const aRice = await createSub(a.token, aTop, 'Rice');
    const bRice = await createSub(b.token, bTop, 'Rice');
    await publish(a.id, await createProduct(a.token, aRice, 'A Rice'));
    await publish(b.id, await createProduct(b.token, bRice, 'B Rice'));

    let categories = await customerCategories();
    expect(categories.map((c) => c.name)).toEqual(['Grocery']);
    expect(categories[0]!.productCount).toBe(2);
    expect(categories[0]!.children!.map((c) => [c.name, c.productCount])).toEqual([['Rice', 2]]);

    // A renames its subcategory: two groups under the one merged "Grocery".
    await as(a.token).patch(`/subcategories/${aRice}`, { name: 'Basmati Rice' }).expect(200);
    categories = await customerCategories();
    expect(categories.map((c) => c.name)).toEqual(['Grocery']);
    expect(categories[0]!.productCount).toBe(2);
    expect(
      categories[0]!.children!.map((c) => [c.name, c.productCount]).sort(),
    ).toEqual([['Basmati Rice', 1], ['Rice', 1]]);

    // An empty extra subcategory of B, deleted: the marketplace is unchanged.
    const bEmpty = await createSub(b.token, bTop, 'Pulses');
    await as(b.token).del(`/subcategories/${bEmpty}`).expect(200);
    const after = await customerCategories();
    expect(after[0]!.children!.map((c) => c.name).sort()).toEqual(['Basmati Rice', 'Rice']);

    // B's product, its subcategory and both listings are still there.
    expect(await prisma.sellerListing.count()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('restaurants', () => {
  it('menu sections stay restaurant-only: not deletable as categories, never marketplace categories', async () => {
    const grocery = await seedSeller('9600000041', 'Grocery Seller');
    const restaurant = await seedSeller('9600000042', 'Food Place', SellerType.RESTAURANT);
    await prisma.restaurantProfile.create({ data: { sellerId: restaurant.id, cuisine: ['North Indian'] } });

    const sectionId = expectSuccess<{ id: string }>(
      (await as(restaurant.token).post('/menu-sections', { name: 'Starters' }).expect(201)).body,
    ).data.id;
    const item = await createProduct(restaurant.token, sectionId, 'Paneer Tikka');
    await publish(restaurant.id, item);
    const groceryTop = await createTop(grocery.token, 'Grocery');
    await publish(grocery.id, await createProduct(grocery.token, groceryTop, 'Atta'));

    // The categories API is not the restaurant's way to manage sections.
    expect((await tree(restaurant.token)).usesMenuSections).toBe(true);
    expect((await as(restaurant.token).post('/categories', { name: 'Mains' })).status).toBe(400);
    expect((await as(restaurant.token).del(`/categories/${sectionId}`)).status).toBe(400);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: sectionId } })).deletedAt).toBeNull();

    // Marketplace categories: only the grocery seller's.
    expect((await customerCategories()).map((c) => c.name)).toEqual(['Grocery']);

    // The restaurant menu still shows the section with its item.
    const menu = await api().get(`/api/v1/restaurants/${restaurant.id}`).expect(200);
    const sections = expectSuccess<{ sections: { id: string; name: string; items: unknown[] }[] }>(menu.body).data.sections;
    expect(sections).toEqual([expect.objectContaining({ id: sectionId, name: 'Starters' })]);
    expect(sections[0]!.items).toHaveLength(1);
    const sectionList = await as(restaurant.token).get('/menu-sections').expect(200);
    expect(expectSuccess<{ id: string }[]>(sectionList.body).data.map((s) => s.id)).toEqual([sectionId]);
  });
});
