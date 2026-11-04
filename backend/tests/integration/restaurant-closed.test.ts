/**
 * A restaurant / cafe that is not taking orders, end to end:
 *
 *   - its card (GET /restaurants) and menu (GET /restaurants/:id) stay
 *     visible and browsable, marked closed (isOpen = false);
 *   - adding or increasing one of its items is refused (SELLER_CLOSED) — by
 *     its switch or by its hours;
 *   - a line added while it was open stays in the cart, with its quantity,
 *     marked STORE_CLOSED and outside the bill — never deleted — and cannot
 *     be checked out; nothing is written;
 *   - when it opens again its items can be added and ordered at once;
 *   - a grocery store in the same cart is unaffected.
 *
 * The app side: mobile tests/restaurantClosed.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ErrorCode,
  PaymentMethod,
  ProductStatus,
  UnitType,
  type CartDto,
  type RestaurantMenuDto,
  type RestaurantSummaryDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { STORE_COORDS, configureTestMerchantUpi, seedAddress, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';

const MOBILE = '9876500071';

let counter = 0;

/** A live food seller at the fixture point, open all day (or closed every day), with one menu item. */
async function kitchen(name: string, sellerType: 'RESTAURANT' | 'CAFE', options: { closedEveryDay?: boolean } = {}) {
  counter += 1;
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      sellerType,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: 'Asia/Kolkata',
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      sellerId: seller.id,
      dayOfWeek,
      opensAt: '00:00',
      closesAt: '00:00',
      isClosed: options.closedEveryDay ?? false,
    })),
  });
  await prisma.restaurantProfile.create({ data: { sellerId: seller.id, cuisine: ['North Indian'], isVegOnly: false, avgPrepMins: 25 } });
  const menu = await prisma.category.create({ data: { sellerId: seller.id, name: 'Main Menu', slug: `menu-${counter}`, path: `menu-${counter}`, depth: 0 } });
  const section = await prisma.category.create({
    data: { sellerId: seller.id, parentId: menu.id, name: 'Thali', slug: `thali-${counter}`, path: `menu-${counter}/thali-${counter}`, depth: 1 },
  });
  const product = await prisma.product.create({
    data: {
      name: `${name} Special Thali`,
      slug: `thali-item-${counter}`,
      categoryId: section.id,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      submittedBySellerId: seller.id,
      searchKeywords: [],
      attributes: { diet: 'VEG' },
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, sku: `THALI-${counter}`, variantName: 'Full', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  const listing = await prisma.sellerListing.create({
    data: { sellerId: seller.id, variantId: variant.id, mrpPaise: 15000, pricePaise: 15000, stockQty: 100_000, tracksStock: false, isAvailable: true },
  });
  return { sellerId: seller.id, listingId: listing.id };
}

const closeStore = (sellerId: string) => prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders: false } });
const openStore = (sellerId: string) => prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders: true } });

async function customer() {
  await otpService.clearOtpState(MOBILE);
  const session = await loginAs(MOBILE);
  return { token: session.accessToken, addressId: await seedAddress(session.userId) };
}

type Customer = Awaited<ReturnType<typeof customer>>;

const add = (who: Customer, sellerListingId: string, qty = 1) =>
  api().post('/api/v1/cart/items').set('Authorization', bearer(who.token)).send({ sellerListingId, qty });
const getCart = async (who: Customer) =>
  expectSuccess<CartDto>((await api().get('/api/v1/cart').set('Authorization', bearer(who.token)).expect(200)).body).data;
const menuOf = async (sellerId: string) =>
  expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${sellerId}`).expect(200)).body).data;
const lineFor = (cart: CartDto, listingId: string) => cart.items.find((item) => item.sellerListingId === listingId);
const expected = (cart: CartDto, listingIds: string[]) =>
  cart.items.filter((item) => listingIds.includes(item.sellerListingId)).map((item) => ({ sellerListingId: item.sellerListingId, unitPricePaise: item.unitPricePaise }));
const placeOrder = (who: Customer, body: Record<string, unknown>) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(who.token))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId: who.addressId, paymentMethod: PaymentMethod.COD, ...body });

beforeEach(async () => {
  await truncateAll();
  invalidateCategoryCache();
  await configService.invalidateAll();
  await cache.clear();
  await configureTestMerchantUpi();
});

describe('a closed restaurant or cafe', () => {
  it('stays on the list and its menu stays browsable, marked closed', async () => {
    const kitchenA = await kitchen('Nepali Kitchen', 'RESTAURANT');
    await closeStore(kitchenA.sellerId);

    const list = expectSuccess<RestaurantSummaryDto[]>((await api().get('/api/v1/restaurants').expect(200)).body).data;
    const card = list.find((row) => row.sellerId === kitchenA.sellerId);
    expect(card?.isOpen).toBe(false);
    expect(card?.menuItemCount).toBe(1);

    const menu = await menuOf(kitchenA.sellerId);
    expect(menu.restaurant.isOpen).toBe(false);
    const items = menu.menus.flatMap((entry) => entry.sections.flatMap((section) => section.items));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'Nepali Kitchen Special Thali', pricePaise: 15000, sellerListingId: kitchenA.listingId });
  });

  it('refuses an add — by its switch, and a cafe by its hours — and writes nothing to the cart', async () => {
    const restaurant = await kitchen('AS Kitchen', 'RESTAURANT');
    const cafe = await kitchen('Night Cafe', 'CAFE', { closedEveryDay: true });
    await closeStore(restaurant.sellerId);
    const who = await customer();

    const refused = await add(who, restaurant.listingId).expect(409);
    expect(expectError(refused.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect(expectError(refused.body).message).toMatch(/AS Kitchen/);

    const cafeRefused = await add(who, cafe.listingId).expect(409);
    expect(expectError(cafeRefused.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect((await menuOf(cafe.sellerId)).restaurant.isOpen).toBe(false);

    expect((await getCart(who)).items).toHaveLength(0);
  });

  it('keeps a line added while open — quantity and all, never deleted — but it cannot be increased or ordered', async () => {
    const restaurant = await kitchen('Nepali Kitchen', 'RESTAURANT');
    const who = await customer();
    await add(who, restaurant.listingId, 2).expect(200);
    await closeStore(restaurant.sellerId);

    const cart = await getCart(who);
    const line = lineFor(cart, restaurant.listingId)!;
    expect(line).toBeDefined();
    expect(line.qty).toBe(2);
    expect(line.available).toBe(false);
    expect(line.unavailableReason).toBe('STORE_CLOSED');
    expect(cart.bill.itemsSubtotalPaise).toBe(0);

    const increase = await api()
      .patch(`/api/v1/cart/items/${line.id}`)
      .set('Authorization', bearer(who.token))
      .send({ qty: 3 })
      .expect(409);
    expect(expectError(increase.body).code).toBe(ErrorCode.SELLER_CLOSED);

    const order = await placeOrder(who, { expectedItems: expected(cart, [restaurant.listingId]) }).expect(409);
    expect(expectError(order.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect(await prisma.order.count()).toBe(0);

    // Still there, unchanged, after both refusals.
    expect(lineFor(await getCart(who), restaurant.listingId)?.qty).toBe(2);
  });

  it('opens again: the same line counts, more can be added, and it can be ordered', async () => {
    const restaurant = await kitchen('Nepali Kitchen', 'RESTAURANT');
    const who = await customer();
    await add(who, restaurant.listingId, 1).expect(200);
    await closeStore(restaurant.sellerId);
    await openStore(restaurant.sellerId);

    expect((await menuOf(restaurant.sellerId)).restaurant.isOpen).toBe(true);
    await add(who, restaurant.listingId, 2).expect(200);
    const cart = await getCart(who);
    // POST /cart/items adds to the line: 1 kept from before + 2 now.
    expect(lineFor(cart, restaurant.listingId)).toMatchObject({ qty: 3, available: true });
    await placeOrder(who, { expectedItems: expected(cart, [restaurant.listingId]) }).expect(201);
  });

  it('does not touch a grocery store in the same cart: it is added and ordered as usual', async () => {
    const restaurant = await kitchen('Nepali Kitchen', 'RESTAURANT');
    const grocerySeller = await prisma.seller.create({
      data: {
        code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Aadione Grocery',
        sellerType: 'GROCERY',
        addressLine: 'Station Road',
        city: 'Sikar',
        state: 'Rajasthan',
        pincode: '332001',
        ...STORE_COORDS,
        timezone: 'Asia/Kolkata',
        isActive: true,
        ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      },
    });
    await prisma.sellerHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: grocerySeller.id, dayOfWeek, opensAt: '00:00', closesAt: '00:00', isClosed: false })),
    });
    const rice = (await seedProduct(grocerySeller.id, { name: 'Basmati Rice', pricePaise: 20000, stockQty: 10 }))!;
    const who = await customer();
    await add(who, restaurant.listingId, 1).expect(200);
    await closeStore(restaurant.sellerId);

    await add(who, rice.storeVariantId, 1).expect(200);
    const cart = await getCart(who);
    expect(lineFor(cart, rice.storeVariantId)?.available).toBe(true);
    expect(lineFor(cart, restaurant.listingId)?.unavailableReason).toBe('STORE_CLOSED');
    expect(cart.bill.itemsSubtotalPaise).toBe(20000);

    await placeOrder(who, { expectedItems: expected(cart, [rice.storeVariantId]) }).expect(201);
    // The closed restaurant's line is still waiting in the cart.
    expect(lineFor(await getCart(who), restaurant.listingId)?.qty).toBe(1);
  });
});
