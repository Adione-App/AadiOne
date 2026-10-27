/**
 * Store availability and checkout eligibility, end to end through the real app:
 *
 *   - two independent layers: app-wide ordering (ORDERING_ENABLED) and each
 *     seller's own availability (admin > seller switch > closure > hours);
 *   - Home and recommendations drop closed stores' products and refill from
 *     open ones, while categories and product pages keep them browsable;
 *   - the cart keeps unavailable lines (marked, outside the bill) and checks
 *     out the available ones only, exactly as confirmed by the customer;
 *   - placeOrder re-checks every store under a lock inside its transaction;
 *   - an online order whose store closed before payment started is cancelled
 *     unpaid and its lines go back to the cart.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalStatus,
  ConfigKey,
  ErrorCode,
  OrderStatus,
  PaymentMethod,
  type CartDto,
  type HomeFeedDto,
  type ProductDetailDto,
  type ProductSummaryDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import * as sellerAvailability from '../../src/modules/sellers/seller-availability.service';
import { storeStatuses } from '../../src/modules/sellers/store-availability';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { STORE_COORDS, configureTestMerchantUpi, seedAddress, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';

const MOBILE = '9876500011';

/** A live grocery store at the fixture point; open all day unless `hours` says otherwise. */
async function seedSeller(name: string, hours: { opensAt: string; closesAt: string } | null = { opensAt: '00:00', closesAt: '23:59' }) {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
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
  if (hours) {
    await prisma.sellerHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, ...hours, isClosed: false })),
    });
  }
  return seller.id;
}

const closeStore = (sellerId: string) => prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders: false } });
const openStore = (sellerId: string) => prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders: true } });

interface World {
  token: string;
  userId: string;
  addressId: string;
  open1: { sellerId: string; listingId: string; productId: string };
  open2: { sellerId: string; listingId: string; productId: string };
  closed: { sellerId: string; listingId: string; productId: string };
}

/** Three sellers with one product each (₹200, stock 10); the third's product in the cart too. */
async function seedWorld(): Promise<World> {
  const sellers = [await seedSeller('Open Store A'), await seedSeller('Open Store B'), await seedSeller('Later Closed Store')];
  const [p1, p2, p3] = [
    await seedProduct(sellers[0]!, { name: 'Apple Juice', pricePaise: 20000, mrpPaise: 25000, stockQty: 10 }),
    await seedProduct(sellers[1]!, { name: 'Basmati Rice', pricePaise: 20000, mrpPaise: 25000, stockQty: 10 }),
    await seedProduct(sellers[2]!, { name: 'Cashew Nuts', pricePaise: 20000, mrpPaise: 25000, stockQty: 10 }),
  ];
  await otpService.clearOtpState(MOBILE);
  const session = await loginAs(MOBILE);
  const addressId = await seedAddress(session.userId);
  return {
    token: session.accessToken,
    userId: session.userId,
    addressId,
    open1: { sellerId: sellers[0]!, listingId: p1!.storeVariantId, productId: p1!.productId },
    open2: { sellerId: sellers[1]!, listingId: p2!.storeVariantId, productId: p2!.productId },
    closed: { sellerId: sellers[2]!, listingId: p3!.storeVariantId, productId: p3!.productId },
  };
}

const as = (token: string) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
});

async function addToCart(world: World, listingId: string, qty = 1): Promise<CartDto> {
  return expectSuccess<CartDto>((await as(world.token).post('/cart/items', { sellerListingId: listingId, qty }).expect(200)).body).data;
}
async function getCart(world: World): Promise<CartDto> {
  return expectSuccess<CartDto>((await as(world.token).get('/cart').expect(200)).body).data;
}
const lineFor = (cart: CartDto, listingId: string) => cart.items.find((item) => item.sellerListingId === listingId)!;

function placeOrder(world: World, body: Record<string, unknown>) {
  return api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(world.token))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId: world.addressId, paymentMethod: PaymentMethod.COD, ...body });
}
const expected = (cart: CartDto, listingIds: string[]) =>
  cart.items.filter((item) => listingIds.includes(item.sellerListingId)).map((item) => ({ sellerListingId: item.sellerListingId, unitPricePaise: item.unitPricePaise }));

beforeEach(async () => {
  await truncateAll();
  // Each case seeds new categories; the catalogue's in-process map must not
  // remember the previous case's.
  invalidateCategoryCache();
  await configService.invalidateAll();
  await cache.clear();
  await configureTestMerchantUpi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('seller availability layer (shared rule, batch evaluation)', () => {
  it('admin deactivation beats the seller switch: switching ON does not reopen an admin-closed store', async () => {
    const sellerId = await seedSeller('Admin Closed');
    await prisma.seller.update({ where: { id: sellerId }, data: { isActive: false } });
    const owner = await prisma.user.create({ data: { mobile: '9876500099', fullName: 'Owner', role: 'SELLER_OWNER' } });
    await sellerAvailability.setAcceptingOrders(sellerId, true, owner.id);

    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId }, include: { hours: true } });
    const status = (await storeStatuses([seller])).get(sellerId)!;
    expect(status.acceptingOrders).toBe(false);
    expect(status.closedReason).toBe('SELLER_INACTIVE');
  });

  it('evaluates hours at the boundary in the seller timezone, and date closures by its LOCAL date', async () => {
    const sellerId = await seedSeller('Hours Store', { opensAt: '09:00', closesAt: '21:00' });
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId }, include: { hours: true } });
    const at = async (iso: string) => (await storeStatuses([seller], new Date(iso))).get(sellerId)!;

    // 08:59 / 09:00 / 20:59 IST (UTC+5:30)
    expect((await at('2026-10-27T03:29:00Z')).acceptingOrders).toBe(false);
    expect((await at('2026-10-27T03:30:00Z')).acceptingOrders).toBe(true);
    expect((await at('2026-10-27T15:29:00Z')).acceptingOrders).toBe(true);
    expect((await at('2026-10-27T03:29:00Z')).closedReason).toBe('OUTSIDE_HOURS');

    // 2026-10-27 01:30 IST is still 2026-10-26 in UTC: a closure on the 27th applies.
    await prisma.sellerHours.updateMany({ where: { sellerId }, data: { opensAt: '00:00', closesAt: '23:59' } });
    const allDay = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId }, include: { hours: true } });
    await prisma.sellerClosure.create({ data: { sellerId, closedOn: new Date('2026-10-27T00:00:00Z') } });
    const night = (await storeStatuses([allDay], new Date('2026-10-26T20:00:00Z'))).get(sellerId)!;
    expect(night.acceptingOrders).toBe(false);
    expect(night.closedReason).toBe('CLOSURE');
  });
});

/* -------------------------------------------------------------------------- */

describe('catalogue and Home', () => {
  it('product pages stay browsable for a closed store and say so; a multi-seller product prefers the open seller', async () => {
    const world = await seedWorld();
    await closeStore(world.closed.sellerId);

    const detail = expectSuccess<ProductDetailDto>((await api().get(`/api/v1/products/${world.closed.productId}`).expect(200)).body).data;
    expect(detail.defaultVariant?.sellerAcceptingOrders).toBe(false);
    expect(detail.defaultVariant?.sellerClosedMessage).toMatch(/Later Closed Store/);

    // The closed store's product listed by an open seller too, at a HIGHER price.
    const variantId = (await prisma.sellerListing.findUniqueOrThrow({ where: { id: world.closed.listingId } })).variantId;
    await prisma.sellerListing.create({
      data: { sellerId: world.open1.sellerId, variantId, mrpPaise: 26000, pricePaise: 22000, stockQty: 5, maxQtyPerOrder: 10, isAvailable: true },
    });
    const both = expectSuccess<ProductDetailDto>((await api().get(`/api/v1/products/${world.closed.productId}`).expect(200)).body).data;
    expect(both.defaultVariant?.sellerId).toBe(world.open1.sellerId);
    expect(both.defaultVariant?.sellerAcceptingOrders).toBe(true);
    expect(both.defaultVariant?.pricePaise).toBe(22000);
  });

  it('Home rails and category shelves drop a closed store\'s products (no duplicates); its category listing still shows them', async () => {
    const world = await seedWorld();
    await closeStore(world.closed.sellerId);

    const home = expectSuccess<HomeFeedDto>((await api().get('/api/v1/home').expect(200)).body).data;
    const shown = [...home.rails, ...home.categoryRails].flatMap((rail) => rail.products.map((product) => product.id));
    expect(shown).not.toContain(world.closed.productId);
    expect(shown).toContain(world.open1.productId);
    for (const rail of home.rails) {
      const ids = rail.products.map((product) => product.id);
      expect(new Set(ids).size).toBe(ids.length);
    }

    const category = (await prisma.product.findUniqueOrThrow({ where: { id: world.closed.productId } })).categoryId;
    const listing = expectSuccess<{ items: ProductSummaryDto[] }>((await api().get(`/api/v1/products?categoryId=${category}`).expect(200)).body);
    expect(listing.data.items.map((product) => product.id)).toContain(world.closed.productId);

    // Reopened: back on Home.
    await openStore(world.closed.sellerId);
    const again = expectSuccess<HomeFeedDto>((await api().get('/api/v1/home').expect(200)).body).data;
    expect([...again.rails, ...again.categoryRails].flatMap((rail) => rail.products.map((product) => product.id))).toContain(world.closed.productId);
  });

  it('store directory keeps a closed store, after the open ones', async () => {
    const world = await seedWorld();
    await closeStore(world.open1.sellerId);
    const stores = expectSuccess<{ id: string; isOpen: boolean }[]>((await api().get('/api/v1/stores').expect(200)).body).data;
    expect(stores.map((store) => store.id)).toContain(world.open1.sellerId);
    const firstClosed = stores.findIndex((store) => !store.isOpen);
    expect(stores.slice(firstClosed).every((store) => !store.isOpen)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('cart with partial eligibility', () => {
  it('all open: everything available, both checkouts enabled', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    const cart = await addToCart(world, world.closed.listingId);
    expect(cart.items.every((item) => item.available)).toBe(true);
    expect(cart.checkoutEnabled).toBe(true);
    expect(cart.availableCheckoutEnabled).toBe(true);
    expect(cart.unavailableItemCount).toBe(0);
  });

  it('one store closes after its item was added: the line stays, marked, outside the bill; the rest can be checked out', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId, 1);
    await addToCart(world, world.open2.listingId, 1);
    await addToCart(world, world.closed.listingId, 2);
    await closeStore(world.closed.sellerId);

    const cart = await getCart(world);
    expect(cart.items).toHaveLength(3);
    const closedLine = lineFor(cart, world.closed.listingId);
    expect(closedLine.available).toBe(false);
    expect(closedLine.unavailableReason).toBe('STORE_CLOSED');
    expect(closedLine.storeClosedReason).toBe('MANUALLY_CLOSED');
    expect(closedLine.unavailableMessage).toMatch(/Later Closed Store/);
    expect(closedLine.qty).toBe(2);

    // Bill: the two available lines only.
    expect(cart.bill.itemsSubtotalPaise).toBe(40000);
    expect(cart.availableItemCount).toBe(2);
    expect(cart.unavailableItemCount).toBe(1);
    expect(cart.availableCheckoutEnabled).toBe(true);
    // Older apps: whole-cart checkout stays blocked, with the reason.
    expect(cart.checkoutEnabled).toBe(false);
    expect(cart.checkoutBlockedReason).toMatch(/Later Closed Store/);
    expect(cart.sellerGroups.find((group) => group.sellerId === world.closed.sellerId)?.isOpen).toBe(false);

    // More of a closed store's item is refused; fewer is fine.
    const increase = await as(world.token).patch(`/cart/items/${closedLine.id}`, { qty: 3 }).expect(409);
    expect(expectError(increase.body).code).toBe(ErrorCode.SELLER_CLOSED);
    await as(world.token).patch(`/cart/items/${closedLine.id}`, { qty: 1 }).expect(200);
    const add = await as(world.token).post('/cart/items', { sellerListingId: world.closed.listingId, qty: 1 }).expect(409);
    expect(expectError(add.body).code).toBe(ErrorCode.SELLER_CLOSED);

    // Reopens: the line counts again, by itself.
    await openStore(world.closed.sellerId);
    const reopened = await getCart(world);
    expect(lineFor(reopened, world.closed.listingId).available).toBe(true);
    expect(reopened.bill.itemsSubtotalPaise).toBe(60000);
    expect(reopened.checkoutEnabled).toBe(true);
  });

  it('a cart kept "overnight" is checked against the current hours', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    // The store's hours now exclude this moment (a 1-minute window far from now in IST).
    const now = new Date();
    const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330 + 720) % 1440;
    const hhmm = `${String(Math.floor(istMinutes / 60)).padStart(2, '0')}:${String(istMinutes % 60).padStart(2, '0')}`;
    const end = `${String(Math.floor(((istMinutes + 1) % 1440) / 60)).padStart(2, '0')}:${String((istMinutes + 1) % 60).padStart(2, '0')}`;
    await prisma.sellerHours.updateMany({ where: { sellerId: world.open1.sellerId }, data: { opensAt: hhmm, closesAt: end } });

    const cart = await getCart(world);
    const line = lineFor(cart, world.open1.listingId);
    expect(line.available).toBe(false);
    expect(line.storeClosedReason).toBe('OUTSIDE_HOURS');
    expect(cart.availableCheckoutEnabled).toBe(false);
    expect(cart.availableCheckoutBlockedReason).toMatch(/None of the items/);
  });

  it('admin-deactivated seller, inactive product and no stock: kept and marked; a deleted product is removed with a notice', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    await addToCart(world, world.open2.listingId);
    await addToCart(world, world.closed.listingId);

    await prisma.seller.update({ where: { id: world.open1.sellerId }, data: { isActive: false } });
    await prisma.product.update({ where: { id: world.open2.productId }, data: { status: 'INACTIVE' } });
    await prisma.sellerListing.update({ where: { id: world.closed.listingId }, data: { stockQty: 0 } });

    const cart = await getCart(world);
    expect(cart.items).toHaveLength(3);
    expect(lineFor(cart, world.open1.listingId).storeClosedReason).toBe('SELLER_INACTIVE');
    expect(lineFor(cart, world.open2.listingId).unavailableReason).toBe('PRODUCT_UNAVAILABLE');
    expect(lineFor(cart, world.closed.listingId).unavailableReason).toBe('OUT_OF_STOCK');
    expect(cart.availableCheckoutEnabled).toBe(false);
    expect(cart.bill.itemsSubtotalPaise).toBe(0);

    // Admin reactivates: that line is orderable again.
    await prisma.seller.update({ where: { id: world.open1.sellerId }, data: { isActive: true } });
    expect(lineFor(await getCart(world), world.open1.listingId).available).toBe(true);

    // Deleted for good: removed, with a notice.
    await prisma.product.update({ where: { id: world.open2.productId }, data: { deletedAt: new Date() } });
    const after = await getCart(world);
    expect(after.items.map((item) => item.sellerListingId)).not.toContain(world.open2.listingId);
    expect(after.changes.some((change) => change.type === 'ITEM_REMOVED_UNAVAILABLE')).toBe(true);
  });

  it('minimum order is measured on the available lines only', async () => {
    const world = await seedWorld();
    await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 30000, actorUserId: null });
    await addToCart(world, world.open1.listingId);
    await addToCart(world, world.closed.listingId);
    expect((await getCart(world)).availableCheckoutEnabled).toBe(true);
    await closeStore(world.closed.sellerId);
    const cart = await getCart(world);
    expect(cart.shortfallPaise).toBe(10000);
    expect(cart.availableCheckoutEnabled).toBe(false);
    expect(cart.availableCheckoutBlockedReason).toMatch(/₹100 more/);
  });
});

/* -------------------------------------------------------------------------- */

describe('checkout', () => {
  it('COD: orders exactly the confirmed available lines; the closed store\'s line stays in the (still active) cart', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    await addToCart(world, world.open2.listingId);
    await addToCart(world, world.closed.listingId);
    await closeStore(world.closed.sellerId);
    const cart = await getCart(world);

    const res = await placeOrder(world, { expectedItems: expected(cart, [world.open1.listingId, world.open2.listingId]) }).expect(201);
    const order = expectSuccess<{ order: { id: string; sellerOrders: { sellerId: string; items: { qty: number }[] }[]; bill: { itemsSubtotalPaise: number } } }>(res.body).data.order;
    expect(order.sellerOrders.map((so) => so.sellerId).sort()).toEqual([world.open1.sellerId, world.open2.sellerId].sort());
    expect(order.bill.itemsSubtotalPaise).toBe(40000);

    const left = await getCart(world);
    expect(left.items.map((item) => item.sellerListingId)).toEqual([world.closed.listingId]);
    expect(left.items[0]!.available).toBe(false);
    expect(await prisma.cart.count({ where: { userId: world.userId, status: 'ACTIVE' } })).toBe(1);

    // Reopened later: it is ordered on its own and the cart is converted.
    await openStore(world.closed.sellerId);
    const reopened = await getCart(world);
    await placeOrder(world, { expectedItems: expected(reopened, [world.closed.listingId]) }).expect(201);
    expect(await prisma.cart.count({ where: { userId: world.userId, status: 'ACTIVE' } })).toBe(0);
  });

  it('an older app (no expectedItems) cannot order a cart with an unavailable line; nothing is written', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    await addToCart(world, world.closed.listingId);
    await closeStore(world.closed.sellerId);
    const res = await placeOrder(world, {}).expect(409);
    expect(expectError(res.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect(await prisma.order.count()).toBe(0);
  });

  it('confirming an unavailable line, or leaving out an orderable one, is refused', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    await addToCart(world, world.closed.listingId);
    await closeStore(world.closed.sellerId);
    const cart = await getCart(world);

    // Confirming the closed store's line (with the open one) is refused with its reason.
    const withClosed = await placeOrder(world, { expectedItems: expected(cart, [world.open1.listingId, world.closed.listingId]) }).expect(409);
    expect(expectError(withClosed.body).code).toBe(ErrorCode.SELLER_CLOSED);

    // The store reopened after the cart was shown: its line is orderable but unconfirmed.
    await openStore(world.closed.sellerId);
    const changed = await placeOrder(world, { expectedItems: expected(cart, [world.open1.listingId]) }).expect(409);
    expect(expectError(changed.body).code).toBe(ErrorCode.CART_CHANGED);
    expect(await prisma.order.count()).toBe(0);
  });

  it('all lines unavailable: checkout is blocked with a reason', async () => {
    const world = await seedWorld();
    await addToCart(world, world.closed.listingId);
    await closeStore(world.closed.sellerId);
    const cart = await getCart(world);
    expect(cart.availableCheckoutEnabled).toBe(false);
    expect(cart.availableCheckoutBlockedReason).toMatch(/None of the items/);
    await placeOrder(world, { expectedItems: [] }).expect(422);
  });

  it('a store that closes AFTER the pre-checks, as the order transaction starts, is caught inside it', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    const cart = await getCart(world);

    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (...args: unknown[]) => {
      await closeStore(world.open1.sellerId);
      return original(...args);
    }) as never);

    const res = await placeOrder(world, { expectedItems: expected(cart, [world.open1.listingId]) }).expect(409);
    expect(expectError(res.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect(await prisma.order.count()).toBe(0);
    expect((await getCart(world)).items).toHaveLength(1);
  });

  it('two checkouts of the same lines at once produce exactly one order', async () => {
    const world = await seedWorld();
    await addToCart(world, world.open1.listingId);
    await addToCart(world, world.closed.listingId);
    await closeStore(world.closed.sellerId);
    const cart = await getCart(world);
    const body = { expectedItems: expected(cart, [world.open1.listingId]) };

    const results = await Promise.all([placeOrder(world, body), placeOrder(world, body)]);
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    expect(await prisma.order.count()).toBe(1);
    expect((await getCart(world)).items.map((item) => item.sellerListingId)).toEqual([world.closed.listingId]);
  });
});

/* -------------------------------------------------------------------------- */

describe('app-wide ordering switch', () => {
  it('paused: browsing and adding to the cart work; no order (COD or online) is accepted', async () => {
    const world = await seedWorld();
    await configService.set({ key: ConfigKey.ORDERING_ENABLED, value: false, actorUserId: null });
    await configService.set({ key: ConfigKey.ORDERING_PAUSED_MESSAGE, value: 'Back at 7 AM.', actorUserId: null });

    await api().get(`/api/v1/products/${world.open1.productId}`).expect(200);
    const cart = await addToCart(world, world.open1.listingId);
    expect(cart.orderingEnabled).toBe(false);
    expect(cart.orderingPausedMessage).toBe('Back at 7 AM.');
    expect(cart.availableCheckoutEnabled).toBe(false);
    expect(cart.availableCheckoutBlockedReason).toBe('Back at 7 AM.');
    expect(lineFor(cart, world.open1.listingId).available).toBe(true);

    for (const paymentMethod of [PaymentMethod.COD, PaymentMethod.ONLINE]) {
      const res = await placeOrder(world, { paymentMethod, expectedItems: expected(cart, [world.open1.listingId]) }).expect(409);
      expect(expectError(res.body).code).toBe(ErrorCode.ORDERING_PAUSED);
    }
    expect(await prisma.order.count()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('online payment start', () => {
  async function onlineOrder(world: World) {
    await addToCart(world, world.open1.listingId, 2);
    const cart = await getCart(world);
    const res = await placeOrder(world, { paymentMethod: PaymentMethod.ONLINE, expectedItems: expected(cart, [world.open1.listingId]) }).expect(201);
    return expectSuccess<{ order: { id: string } }>(res.body).data.order.id;
  }
  const startPayment = (world: World, orderId: string) =>
    api().post('/api/v1/payments/create').set('Authorization', bearer(world.token)).set('Idempotency-Key', randomUUID()).send({ orderId });

  it('store closed before the FIRST attempt: no payment, the unpaid order is cancelled and its lines are back in the cart', async () => {
    const world = await seedWorld();
    const orderId = await onlineOrder(world);
    const reservedBefore = (await prisma.sellerListing.findUniqueOrThrow({ where: { id: world.open1.listingId } })).reservedQty;
    expect(reservedBefore).toBe(2);
    await closeStore(world.open1.sellerId);

    const res = await startPayment(world, orderId).expect(409);
    expect(expectError(res.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect(expectError(res.body).message).toMatch(/back in your cart/);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.CANCELLED);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: world.open1.listingId } })).reservedQty).toBe(0);

    const cart = await getCart(world);
    expect(lineFor(cart, world.open1.listingId).qty).toBe(2);
    expect(lineFor(cart, world.open1.listingId).available).toBe(false);

    // A retry neither cancels again nor puts the lines back twice.
    await startPayment(world, orderId).expect(400);
    expect(lineFor(await getCart(world), world.open1.listingId).qty).toBe(2);
  });

  it('store closes AFTER the payment was started: the attempt is never cancelled from here', async () => {
    const world = await seedWorld();
    const orderId = await onlineOrder(world);
    await startPayment(world, orderId).expect(200);
    await closeStore(world.open1.sellerId);

    await startPayment(world, orderId).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PENDING_PAYMENT);
  });
});
