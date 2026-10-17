/**
 * Made-to-order food has no stock count; physical goods keep exact stock —
 * through the real cart, checkout, inventory, admin views and the backfill.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, CodPolicy, ErrorCode, PaymentMethod, ProductStatus, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { STORE_COORDS, seedAddress, seedProduct, seedStore, sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { listLowStockAllSellers } from '../../src/modules/inventory/inventory.service';
import { applyFoodStockBackfill, planFoodStockBackfill } from '../../src/modules/inventory/food-stock-backfill';

const CUSTOMER = '9876500002';

async function seedRestaurant(code: string, items: { name: string; stockQty?: number; tracksStock?: boolean; maxQtyPerOrder?: number }[]) {
  const seller = await prisma.seller.create({
    data: {
      code,
      name: `${code} Kitchen`,
      sellerType: SellerType.RESTAURANT,
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
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  await prisma.restaurantProfile.create({ data: { sellerId: seller.id, cuisine: ['Indian'], isVegOnly: false } });
  const menu = await prisma.category.create({ data: { sellerId: seller.id, name: 'Main Menu', slug: `menu-${code}`, path: `menu-${code}`, depth: 0 } });
  const section = await prisma.category.create({
    data: { sellerId: seller.id, parentId: menu.id, name: 'Curries', slug: 'curries', path: `menu-${code}/curries`, depth: 1 },
  });
  const listings: { id: string; variantId: string }[] = [];
  for (const item of items) {
    const slug = `${code}-${item.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const product = await prisma.product.create({
      data: { name: item.name, slug, categoryId: section.id, status: ProductStatus.ACTIVE, approvalStatus: 'APPROVED', submittedBySellerId: seller.id, searchKeywords: [] },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, sku: `FOOD-${slug}`.toUpperCase().slice(0, 60), variantName: 'Regular', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
    });
    const listing = await prisma.sellerListing.create({
      data: {
        sellerId: seller.id,
        variantId: variant.id,
        mrpPaise: 20000,
        pricePaise: 20000,
        stockQty: item.stockQty ?? 0,
        tracksStock: item.tracksStock ?? false,
        maxQtyPerOrder: item.maxQtyPerOrder ?? 4,
        isAvailable: true,
      },
    });
    listings.push({ id: listing.id, variantId: variant.id });
  }
  return { sellerId: seller.id, listings };
}

async function adminToken(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '9000000011', email: 'stock-admin@adione.test', fullName: 'Admin', passwordHash: await hashPassword('TestAdmin@123'), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: 'stock-admin@adione.test', password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const listing = (id: string) => prisma.sellerListing.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await otpService.clearOtpState(CUSTOMER);
});

describe('made-to-order food vs physical stock', () => {
  it('a food item with stock 0 is orderable (limited per order only); the order reserves and writes off nothing; grocery stock is exact', async () => {
    const storeId = await seedStore();
    const grocery = await seedProduct(storeId, { stockQty: 5, maxQtyPerOrder: 10, pricePaise: 5000 });
    const kitchen = await seedRestaurant('STOCKKITCHEN', [{ name: 'Dal Makhani', maxQtyPerOrder: 4 }]);
    const food = kitchen.listings[0]!;
    const session = await loginAs(CUSTOMER);
    const as = (path: string) => api().post(`/api/v1${path}`).set('Authorization', bearer(session.accessToken));

    // Food: stock 0, still added — up to its per-order limit, with the per-order message.
    const added = await as('/cart/items').send({ sellerListingId: food.id, qty: 2 });
    expect(added.status).toBe(200);
    const line = expectSuccess<{ items: { sellerListingId: string; availableQty: number; qty: number }[] }>(added.body).data.items.find(
      (item) => item.sellerListingId === food.id,
    )!;
    expect(line).toMatchObject({ qty: 2, availableQty: 4 }); // the per-order limit — never a fake stock
    const tooMany = await as('/cart/items').send({ sellerListingId: food.id, qty: 3 });
    expect(expectError(tooMany.body).code).toBe(ErrorCode.QTY_LIMIT_EXCEEDED);

    // Grocery: real stock enforced.
    const overStock = await as('/cart/items').send({ sellerListingId: grocery.storeVariantId, qty: 6 });
    expect(expectError(overStock.body).code).toBe(ErrorCode.INSUFFICIENT_STOCK);
    expect((await as('/cart/items').send({ sellerListingId: grocery.storeVariantId, qty: 2 })).status).toBe(200);

    const addressId = await seedAddress(session.userId);
    const order = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(session.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId, paymentMethod: PaymentMethod.COD });
    expect(order.status).toBe(201);

    expect(await listing(food.id)).toMatchObject({ stockQty: 0, reservedQty: 0 });
    expect(await prisma.stockLedger.count({ where: { sellerListingId: food.id } })).toBe(0);
    // COD commits at placement: 5 - 2.
    expect(await listing(grocery.storeVariantId)).toMatchObject({ stockQty: 3, reservedQty: 0 });
  });

  it('a switched-off food item is refused; a sold-out grocery item is refused', async () => {
    const storeId = await seedStore();
    const grocery = await seedProduct(storeId, { stockQty: 0 });
    const kitchen = await seedRestaurant('OFFKITCHEN', [{ name: 'Paneer' }]);
    await prisma.sellerListing.update({ where: { id: kitchen.listings[0]!.id }, data: { isAvailable: false } });
    const session = await loginAs(CUSTOMER);
    const add = (id: string) => api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: id, qty: 1 });
    expect(expectError((await add(kitchen.listings[0]!.id)).body).code).toBe(ErrorCode.ITEM_OUT_OF_STOCK);
    expect(expectError((await add(grocery.storeVariantId)).body).code).toBe(ErrorCode.ITEM_OUT_OF_STOCK);
  });

  it('a restaurant that TRACKS limited portions gets real stock rules', async () => {
    const kitchen = await seedRestaurant('PORTIONS', [{ name: 'Biryani', tracksStock: true, stockQty: 2, maxQtyPerOrder: 10 }]);
    const session = await loginAs(CUSTOMER);
    const res = await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: kitchen.listings[0]!.id, qty: 3 });
    expect(expectError(res.body).code).toBe(ErrorCode.INSUFFICIENT_STOCK);
  });

  it('admin inventory: food is "made to order" with 0 units and no stock value; low-stock lists only physical goods', async () => {
    const storeId = await seedStore();
    await seedProduct(storeId, { stockQty: 3, pricePaise: 5000 }); // low (threshold default 5)
    // A legacy row (fabricated stock) and a new row (0): both made to order.
    await seedRestaurant('ADMINKITCHEN', [{ name: 'Old Curry', stockQty: 100_000 }, { name: 'New Curry' }]);
    const admin = await adminToken();
    const res = await api().get('/api/v1/admin/marketplace/inventory?pageSize=100').set('Authorization', bearer(admin)).expect(200);
    const data = expectSuccess<{ items: { stock: string; availableQty: number; stockQty: number }[]; summary: { stockValuePaise: number; lowStock: number; outOfStock: number } }>(res.body).data;
    const food = data.items.filter((row) => row.stock === 'MADE_TO_ORDER');
    expect(food).toHaveLength(2);
    expect(food.every((row) => row.availableQty === 0 && row.stockQty === 0)).toBe(true);
    expect(data.summary.stockValuePaise).toBe(3 * 5000); // the grocery item only
    expect(data.summary.lowStock).toBe(1);

    const low = await listLowStockAllSellers();
    expect(low.map((row) => row.productName)).toHaveLength(1);
  });

  it('backfill: reports, then clears ONLY untracked rows; idempotent; tracked food stock untouched', async () => {
    const kitchen = await seedRestaurant('LEGACYKITCHEN', [
      { name: 'Legacy A', stockQty: 100_000 },
      { name: 'Legacy B', stockQty: 100_000 },
      { name: 'Portions', tracksStock: true, stockQty: 7 },
    ]);
    await prisma.sellerListing.update({ where: { id: kitchen.listings[1]!.id }, data: { reservedQty: 2 } });
    const storeId = await seedStore();
    const grocery = await seedProduct(storeId, { stockQty: 40 });

    const report = await planFoodStockBackfill();
    expect(report.listingsToReset).toBe(2);
    expect(report.untracked[0]).toMatchObject({ sellerCode: 'LEGACYKITCHEN', listings: 2, maxStockQty: 100_000, totalReservedQty: 2 });
    expect(report.trackedFoodListings).toEqual([expect.objectContaining({ sellerCode: 'LEGACYKITCHEN', listings: 1, totalStockQty: 7 })]);

    expect(await applyFoodStockBackfill('test operator')).toEqual({ reset: 2 });
    expect(await listing(kitchen.listings[0]!.id)).toMatchObject({ stockQty: 0, reservedQty: 0 });
    expect(await listing(kitchen.listings[1]!.id)).toMatchObject({ stockQty: 0, reservedQty: 0 });
    expect(await listing(kitchen.listings[2]!.id)).toMatchObject({ stockQty: 7, tracksStock: true });
    expect(await listing(grocery.storeVariantId)).toMatchObject({ stockQty: 40 });
    expect(await applyFoodStockBackfill('test operator')).toEqual({ reset: 0 });
    expect(await prisma.auditLog.count({ where: { action: 'inventory.food_stock_backfill' } })).toBe(2);

    // After the backfill the food is still on the customer menu, in stock.
    const menu = expectSuccess<{ sections: { items: { name: string; inStock: boolean }[] }[] }>(
      (await api().get(`/api/v1/restaurants/${kitchen.sellerId}`).expect(200)).body,
    ).data;
    const items = menu.sections.flatMap((section) => section.items);
    expect(items.find((item) => item.name === 'Legacy A')?.inStock).toBe(true);
  });
});
