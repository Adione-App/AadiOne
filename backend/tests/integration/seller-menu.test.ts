/**
 * Restaurant / cafe MENU management (V2): Menu → Menu Section → Food Item.
 *
 * Food sellers (RESTAURANT, CAFE) manage their MENU in their own category
 * tree — menus are top categories, menu sections are subcategories — from the
 * Seller Categories page, and add food items through the same
 * product + batch-approval flow as everyone else — but a food item has a
 * selling price and availability only: no MRP, no SKU/unit, no opening stock,
 * and orders never use up its (made-to-order) listing.
 *
 * Marketplace sellers (grocery, electronics…) keep Category → Subcategory →
 * Product with MRP + price + opening stock exactly as before.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { commitReservation, restockCommitted } from '../../src/modules/inventory/inventory.service';
import { runInTransaction } from '../../src/infra/db/prisma';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

interface Seller {
  id: string;
  token: string;
}

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(mobile: string, sellerType: SellerType, name = `${sellerType} Seller`): Promise<Seller> {
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
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  put: (path: string, body: object = {}) => api().put(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  delete: (path: string) => api().delete(`/api/v1${path}`).set('Authorization', bearer(token)),
});

interface Section {
  id: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
  itemCount: number;
  menuId: string | null;
  menuName: string | null;
}

interface Tree {
  usesMenuSections: boolean;
  categories: { id: string; name: string; isActive: boolean; subcategories: { id: string; name: string; productCount: number }[] }[];
}

/** Create a menu (a top category in the food seller's own tree); returns its id. */
async function addMenu(seller: Seller, name: string): Promise<string> {
  const tree = expectSuccess<Tree>((await as(seller.token).post('/seller/categories', { name }).expect(201)).body).data;
  return tree.categories.find((menu) => menu.name === name)!.id;
}

async function tree(seller: Seller): Promise<Tree> {
  return expectSuccess<Tree>((await as(seller.token).get('/seller/categories').expect(200)).body).data;
}

async function addSection(seller: Seller, menuId: string, name: string): Promise<Section> {
  return expectSuccess<Section>((await as(seller.token).post('/seller/menu-sections', { name, menuId }).expect(201)).body).data;
}

async function sections(seller: Seller): Promise<Section[]> {
  return expectSuccess<Section[]>((await as(seller.token).get('/seller/menu-sections').expect(200)).body).data;
}

/** Exactly what the Food Item form sends: no MRP, no SKU/unit, no stock. */
async function addFoodItem(seller: Seller, sectionId: string, overrides: Record<string, unknown> = {}) {
  const res = await as(seller.token)
    .post('/seller/products', { categoryId: sectionId, name: `Dish ${randomUUID().slice(0, 5)}`, description: 'Fresh', pricePaise: 12_000, diet: 'VEG', ...overrides })
    .expect(201);
  return expectSuccess<{ id: string; variantId: string; listingId: string }>(res.body).data;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe.each([
  { type: SellerType.RESTAURANT, label: 'restaurant', mobile: '9600000001', menus: ['Main Menu', 'Breakfast Menu'], sections: ['Roti', 'Sabji', 'Rice'], dish: 'Dal Tadka' },
  { type: SellerType.CAFE, label: 'cafe', mobile: '9600000002', menus: ['Main Menu', 'Breakfast Menu'], sections: ['Hot Coffee', 'Snacks', 'Desserts'], dish: 'Cappuccino' },
])('$label: Menu → Menu Section → Food Item, all from the Seller Categories tree', ({ type, mobile, menus, sections: names, dish }) => {
  it('the Seller Categories tree is the menu', async () => {
    const seller = await seedSeller(mobile, type);
    expect((await tree(seller)).usesMenuSections).toBe(true);
  });

  it('creates, renames, hides and deletes MENUS (several per seller); a menu with food items is protected', async () => {
    const seller = await seedSeller(mobile, type);
    const main = await addMenu(seller, menus[0]!);
    const breakfast = await addMenu(seller, menus[1]!);
    expect((await tree(seller)).categories.map((m) => m.name).sort()).toEqual([...menus].sort());

    await addSection(seller, breakfast, 'Paratha');
    await as(seller.token).patch(`/seller/categories/${breakfast}`, { name: 'Morning Menu' }).expect(200);
    await as(seller.token).patch(`/seller/categories/${breakfast}`, { isActive: false }).expect(200);
    const renamed = (await tree(seller)).categories.find((m) => m.id === breakfast)!;
    expect([renamed.name, renamed.isActive]).toEqual(['Morning Menu', false]);

    // A menu with a food item in one of its sections cannot be deleted; the item is untouched.
    const section = await addSection(seller, main, names[0]!);
    const item = await addFoodItem(seller, section.id);
    const refused = await as(seller.token).delete(`/seller/categories/${main}`);
    expect(refused.status).toBe(409);
    expect(expectError(refused.body).message).toMatch(/1 food item is in this menu/);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).deletedAt).toBeNull();

    // An empty menu (with its empty sections) is deleted.
    const deleted = expectSuccess<{ deletedSubcategoryIds: string[] }>((await as(seller.token).delete(`/seller/categories/${breakfast}`).expect(200)).body).data;
    expect(deleted.deletedSubcategoryIds).toHaveLength(1);
    expect((await tree(seller)).categories.map((m) => m.id)).toEqual([main]);
  });

  it('creates, renames, reorders and deletes MENU SECTIONS inside a menu; a section with food items is protected', async () => {
    const seller = await seedSeller(mobile, type);
    const menu = await addMenu(seller, menus[0]!);
    const [a, b, c] = [await addSection(seller, menu, names[0]!), await addSection(seller, menu, names[1]!), await addSection(seller, menu, names[2]!)];
    expect((await sections(seller)).map((s) => [s.name, s.menuName])).toEqual(names.map((n) => [n, menus[0]]));
    // Also through the ordinary subcategory route (the same tree).
    await as(seller.token).post('/seller/subcategories', { parentId: menu, name: 'Dal' }).expect(201);
    // Duplicate names in one menu are refused.
    expect((await as(seller.token).post('/seller/menu-sections', { name: names[0]!, menuId: menu })).status).toBe(409);

    await as(seller.token).patch(`/seller/subcategories/${a.id}`, { name: `${names[0]} Specials` }).expect(200);
    const dal = (await sections(seller)).find((s) => s.name === 'Dal')!;
    const reordered = expectSuccess<Section[]>(
      (await as(seller.token).put('/seller/menu-sections/order', { menuId: menu, ids: [c.id, a.id, b.id, dal.id] }).expect(200)).body,
    ).data;
    expect(reordered.map((s) => s.name)).toEqual([names[2], `${names[0]} Specials`, names[1], 'Dal']);
    expect((await as(seller.token).put('/seller/menu-sections/order', { menuId: menu, ids: [c.id, a.id] })).status).toBe(400);

    const item = await addFoodItem(seller, b.id);
    const refused = await as(seller.token).delete(`/seller/subcategories/${b.id}`);
    expect(refused.status).toBe(409);
    expect(expectError(refused.body).message).toMatch(/1 food item is in this menu section/);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).deletedAt).toBeNull();
    await as(seller.token).delete(`/seller/subcategories/${dal.id}`).expect(200);
    expect((await sections(seller)).map((s) => s.id)).not.toContain(dal.id);
  });

  it('adds a FOOD ITEM with a selling price only — no MRP, no SKU, no opening stock — inside a section, never on a menu itself', async () => {
    const seller = await seedSeller(mobile, type);
    const menu = await addMenu(seller, menus[0]!);
    const section = await addSection(seller, menu, names[1]!);
    expect((await as(seller.token).post('/seller/products', { categoryId: menu, name: dish, pricePaise: 12_000 })).status).toBe(400);
    const item = await addFoodItem(seller, section.id, { name: dish, pricePaise: 12_000 });

    const listing = await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } });
    expect([listing.pricePaise, listing.mrpPaise, listing.tracksStock, listing.isAvailable]).toEqual([12_000, 12_000, false, true]);
    expect(await prisma.stockLedger.count({ where: { sellerListingId: listing.id } })).toBe(0); // no opening stock
    const product = await prisma.product.findUniqueOrThrow({ where: { id: item.id }, include: { variants: true } });
    expect(product.approvalStatus).toBe('PENDING');
    expect(product.attributes).toEqual({ diet: 'VEG' });
    expect(product.variants[0]!.sku).toMatch(/^FOOD-/);
    expect((await tree(seller)).categories[0]!.subcategories[0]!.productCount).toBe(1);
  });

  it('EDITS a food item (name, description, section, price, veg/non-veg) and toggles availability; stock edits are refused', async () => {
    const seller = await seedSeller(mobile, type);
    const menu = await addMenu(seller, menus[0]!);
    const first = await addSection(seller, menu, names[0]!);
    const second = await addSection(seller, menu, names[1]!);
    const item = await addFoodItem(seller, first.id, { isAvailable: false });
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } })).isAvailable).toBe(false);

    await as(seller.token)
      .patch(`/seller/products/${item.id}`, { name: dish, description: 'Slow cooked', categoryId: second.id, pricePaise: 15_000, diet: 'NON_VEG' })
      .expect(200);
    const edited = await prisma.product.findUniqueOrThrow({ where: { id: item.id } });
    expect([edited.name, edited.description, edited.categoryId, edited.attributes]).toEqual([dish, 'Slow cooked', second.id, { diet: 'NON_VEG' }]);
    const repriced = await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } });
    expect([repriced.pricePaise, repriced.mrpPaise]).toEqual([15_000, 15_000]);

    await as(seller.token).patch(`/seller/listings/${item.listingId}`, { isAvailable: true }).expect(200);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } })).isAvailable).toBe(true);
    await as(seller.token).patch(`/seller/listings/${item.listingId}`, { isAvailable: false }).expect(200);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } })).isAvailable).toBe(false);

    expect((await as(seller.token).patch(`/seller/listings/${item.listingId}`, { stockQty: 5 })).status).toBe(400);
    expect((await as(seller.token).post(`/seller/listings/${item.listingId}/stock-adjust`, { delta: 1 })).status).toBe(400);
  });

  it('DELETES a food item: gone from the menu, listing switched off, section deletable again', async () => {
    const seller = await seedSeller(mobile, type);
    const menu = await addMenu(seller, menus[0]!);
    const section = await addSection(seller, menu, names[0]!);
    const item = await addFoodItem(seller, section.id);

    await as(seller.token).delete(`/seller/products/${item.id}`).expect(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).deletedAt).not.toBeNull();
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } })).isAvailable).toBe(false);
    expect(expectSuccess<unknown[]>((await as(seller.token).get('/seller/products').expect(200)).body).data).toHaveLength(0);
    expect((await as(seller.token).delete(`/seller/products/${item.id}`)).status).toBe(404);
    await as(seller.token).delete(`/seller/subcategories/${section.id}`).expect(200);
  });

  it('orders never use up a made-to-order food item (commit and cancel leave its capacity alone)', async () => {
    const seller = await seedSeller(mobile, type);
    const section = await addSection(seller, await addMenu(seller, menus[0]!), names[0]!);
    const item = await addFoodItem(seller, section.id);
    const before = await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } });
    await prisma.sellerListing.update({ where: { id: item.listingId }, data: { reservedQty: 3 } });

    await runInTransaction((tx) => commitReservation(tx, [{ sellerListingId: item.listingId, qty: 3 }], randomUUID()));
    let after = await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } });
    expect([after.stockQty, after.reservedQty]).toEqual([before.stockQty, 0]);
    await runInTransaction((tx) => restockCommitted(tx, [{ sellerListingId: item.listingId, qty: 3 }], randomUUID()));
    after = await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } });
    expect(after.stockQty).toBe(before.stockQty);
  });

  it('food items go through batch approval and reach the customer menu grouped Menu → Section → Item', async () => {
    const seller = await seedSeller(mobile, type);
    const menu = await addMenu(seller, menus[0]!);
    const section = await addSection(seller, menu, names[0]!);
    const item = await addFoodItem(seller, section.id, { name: dish, pricePaise: 9_900 });
    const batch = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/approval-batches', { productIds: [item.id] }).expect(201)).body).data;
    const admin = await loginAdmin();
    await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);

    const menuView = expectSuccess<{
      restaurant: { sellerType: string };
      menus: { name: string; sections: { name: string; items: { name: string; pricePaise: number; inStock: boolean; diet: string | null }[] }[] }[];
    }>((await api().get(`/api/v1/restaurants/${seller.id}`).expect(200)).body).data;
    expect(menuView.restaurant.sellerType).toBe(type);
    expect(menuView.menus[0]!.name).toBe(menus[0]);
    expect(menuView.menus[0]!.sections[0]!.name).toBe(names[0]);
    expect(menuView.menus[0]!.sections[0]!.items[0]).toMatchObject({ name: dish, pricePaise: 9_900, inStock: true, diet: 'VEG' });

    // A hidden menu hides its sections and items from customers.
    await as(seller.token).patch(`/seller/categories/${menu}`, { isActive: false }).expect(200);
    const hidden = expectSuccess<{ menus: unknown[] }>((await api().get(`/api/v1/restaurants/${seller.id}`).expect(200)).body).data;
    expect(hidden.menus).toEqual([]);
  });

  it('the older one-call "add a menu section" puts it in a Main Menu when the seller has none', async () => {
    const seller = await seedSeller(mobile, type);
    const section = expectSuccess<Section>((await as(seller.token).post('/seller/menu-sections', { name: names[0]! }).expect(201)).body).data;
    expect(section.menuName).toBe('Main Menu');
    expect((await tree(seller)).categories.map((m) => m.name)).toEqual(['Main Menu']);
  });
});

describe('menu isolation', () => {
  it('one food seller can never change another’s menu, menu section or food item', async () => {
    const a = await seedSeller('9600000011', SellerType.RESTAURANT, 'Restaurant A');
    const b = await seedSeller('9600000012', SellerType.CAFE, 'Cafe B');
    const menu = await addMenu(a, 'Main Menu');
    const section = await addSection(a, menu, 'Roti');
    const item = await addFoodItem(a, section.id);
    const B = as(b.token);

    // Menu
    expect((await B.patch(`/seller/categories/${menu}`, { name: 'Hacked' })).status).toBe(404);
    expect((await B.delete(`/seller/categories/${menu}`)).status).toBe(404);
    expect((await B.post('/seller/menu-sections', { name: 'Sneaky', menuId: menu })).status).toBe(404);
    expect((await B.post('/seller/subcategories', { parentId: menu, name: 'Sneaky' })).status).toBe(404);
    expect((await B.put('/seller/menu-sections/order', { menuId: menu, ids: [section.id] })).status).toBe(404);
    // Menu section
    expect((await B.patch(`/seller/subcategories/${section.id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await B.delete(`/seller/subcategories/${section.id}`)).status).toBe(404);
    const foreignItem = await B.post('/seller/products', { categoryId: section.id, name: 'Sneaky Roti', pricePaise: 1_000 });
    expect(foreignItem.status).toBe(404);
    expect(expectError(foreignItem.body).code).toBe(ErrorCode.NOT_FOUND);
    // Food item
    expect((await B.patch(`/seller/products/${item.id}`, { pricePaise: 1 })).status).toBe(404);
    expect((await B.delete(`/seller/products/${item.id}`)).status).toBe(404);
    expect((await B.patch(`/seller/listings/${item.listingId}`, { isAvailable: false })).status).toBe(404);

    expect(await sections(b)).toEqual([]);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: menu } })).name).toBe('Main Menu');
    expect((await prisma.category.findUniqueOrThrow({ where: { id: section.id } })).name).toBe('Roti');
    const untouched = await prisma.sellerListing.findUniqueOrThrow({ where: { id: item.listingId } });
    expect([untouched.pricePaise, untouched.isAvailable]).toEqual([12_000, true]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).deletedAt).toBeNull();
  });

  it('menu sections and food-item delete are food-seller only', async () => {
    const grocer = await seedSeller('9600000013', SellerType.GROCERY);
    expect((await as(grocer.token).get('/seller/menu-sections')).status).toBe(400);
    expect((await as(grocer.token).post('/seller/menu-sections', { name: 'Roti' })).status).toBe(400);
  });
});

describe('marketplace sellers are unchanged: Category → Subcategory → Product with MRP + price + stock', () => {
  it.each([SellerType.GROCERY, SellerType.ELECTRONICS])('%s seller still needs MRP, SKU and opening stock', async (type) => {
    const seller = await seedSeller(type === SellerType.GROCERY ? '9600000021' : '9600000022', type);
    const tree = expectSuccess<{ usesMenuSections: boolean; categories: { id: string }[] }>(
      (await as(seller.token).post('/seller/categories', { name: 'Main' }).expect(201)).body,
    ).data;
    expect(tree.usesMenuSections).toBe(false);
    const top = tree.categories[0]!.id;
    const sub = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/subcategories', { parentId: top, name: 'Sub' }).expect(201)).body).data.id;

    // A food-style body (no MRP / SKU / stock) is refused for a marketplace seller.
    const incomplete = await as(seller.token).post('/seller/products', { categoryId: sub, name: 'Half Product', pricePaise: 10_000 });
    expect(incomplete.status).toBe(400);
    expect(expectError(incomplete.body).message).toMatch(/SKU.*MRP.*opening stock/);
    // Price above MRP still refused.
    const body = { categoryId: sub, name: 'Aashirvaad Atta 5kg', sku: `SKU-${randomUUID().slice(0, 8)}`, variantName: '5 kg', unit: UnitType.KG, unitValue: 5 };
    expect((await as(seller.token).post('/seller/products', { ...body, mrpPaise: 30_000, pricePaise: 31_000, stockQty: 25 })).status).toBe(400);

    const created = expectSuccess<{ id: string; listingId: string }>(
      (await as(seller.token).post('/seller/products', { ...body, mrpPaise: 30_000, pricePaise: 28_000, stockQty: 25 }).expect(201)).body,
    ).data;
    const listing = await prisma.sellerListing.findUniqueOrThrow({ where: { id: created.listingId } });
    expect(listing).toMatchObject({ mrpPaise: 30_000, pricePaise: 28_000, stockQty: 25, tracksStock: true });
    expect(await prisma.stockLedger.count({ where: { sellerListingId: listing.id } })).toBe(1); // opening stock
    // Stock stays editable for marketplace products.
    await as(seller.token).post(`/seller/listings/${created.listingId}/stock-adjust`, { delta: 5 }).expect(200);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: created.listingId } })).stockQty).toBe(30);
    // Marketplace products are not deleted through the food-item route.
    expect((await as(seller.token).delete(`/seller/products/${created.id}`)).status).toBe(400);
  });
});
