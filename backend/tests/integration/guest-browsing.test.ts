/**
 * Guest browsing — App Store guideline 5.1.1(v): browsing must not require an
 * account, while everything belonging to an account still does.
 *
 *   - the whole public catalogue (Home, categories, products, search, rails,
 *     stores, restaurants and their menus, banners, offers, serviceability,
 *     public config) answers with NO Authorization header — and also with a
 *     stale/invalid one, which a signed-out app may still send;
 *   - a guest sees exactly what a signed-in customer sees there, and nothing
 *     unpublished;
 *   - every customer-owned route (cart, checkout, orders, payments, addresses,
 *     profile, notifications, devices, referrals, rewards, previous orders,
 *     back-in-stock alerts) and every seller/admin route refuses a guest;
 *   - a signed-in customer still only reaches their OWN records.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  CodPolicy,
  ErrorCode,
  ProductStatus,
  SellerType,
  UnitType,
  type CategoryDto,
  type CursorPage,
  type HomeFeedDto,
  type ProductDetailDto,
  type ProductSummaryDto,
  type RestaurantMenuDto,
  type RestaurantSummaryDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { NEARBY, STORE_COORDS, seedAddress, sellerLifecycleFields } from '../helpers/fixtures';

const CUSTOMER = '9876500921';
const OTHER_CUSTOMER = '9876500922';

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

let sellerCount = 0;
async function seller(name: string, sellerType: SellerType = SellerType.OTHER): Promise<string> {
  sellerCount += 1;
  const created = await prisma.seller.create({
    data: {
      code: `GUEST-${sellerCount}`,
      name,
      sellerType,
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
  name: string,
  approvalStatus: ApprovalStatus = ApprovalStatus.APPROVED,
): Promise<{ productId: string; variantId: string; listingId: string }> {
  productCount += 1;
  const slug = `guest-product-${productCount}`;
  const created = await prisma.product.create({
    data: {
      name,
      slug,
      categoryId,
      status: ProductStatus.ACTIVE,
      approvalStatus,
      taxRateBp: 0,
      allowCod: CodPolicy.INHERIT,
      searchKeywords: [],
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
  const listing = await prisma.sellerListing.create({
    data: { sellerId, variantId: variant.id, pricePaise: 10000, mrpPaise: 12000, stockQty: 50, maxQtyPerOrder: 10, isAvailable: true },
  });
  return { productId: created.id, variantId: variant.id, listingId: listing.id };
}

interface Catalogue {
  storeId: string;
  groceryId: string;
  riceId: string;
  rice: { productId: string; variantId: string; listingId: string };
  unapproved: { productId: string };
  restaurantId: string;
  dish: { productId: string; listingId: string };
}

async function seedCatalogue(): Promise<Catalogue> {
  const storeId = await seller('Guest Grocery');
  const groceryId = await category(storeId, 'Grocery', 'grocery');
  const riceId = await category(storeId, 'Rice', 'grocery/rice', groceryId);
  const rice = await product(storeId, riceId, 'Guest Basmati Rice');
  await product(storeId, riceId, 'Guest Brown Rice');
  // Submitted by the seller, never approved: must stay invisible to everyone.
  const unapproved = await product(storeId, riceId, 'Guest Unapproved Rice', ApprovalStatus.PENDING);

  const restaurantId = await seller('Guest Dhaba', SellerType.RESTAURANT);
  const menu = await category(restaurantId, 'Main Menu', 'main-menu');
  const starters = await category(restaurantId, 'Starters', 'main-menu/starters', menu);
  const dish = await product(restaurantId, starters, 'Guest Paneer Tikka');

  return { storeId, groceryId, riceId, rice, unapproved, restaurantId, dish };
}

const guestGet = (path: string) => api().get(`/api/v1${path}`);

/** Sends each labelled guest request; every one must be refused with 401. */
async function expectAllRefused(requests: Record<string, PromiseLike<{ status: number; body: unknown }>>): Promise<void> {
  for (const [label, pending] of Object.entries(requests)) {
    const res = await pending;
    expect(res.status, label).toBe(401);
    expect(expectError(res.body).code, label).toBe(ErrorCode.UNAUTHENTICATED);
  }
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  invalidateCategoryCache();
  for (const mobile of [CUSTOMER, OTHER_CUSTOMER]) await otpService.clearOtpState(mobile);
});

/* -------------------------------------------------------------------------- */

describe('a guest (no login) browses the whole public catalogue', () => {
  it('loads public config and the Home feed', async () => {
    await seedCatalogue();
    await guestGet('/config/public').expect(200);
    const feed = expectSuccess<HomeFeedDto>((await guestGet('/home').expect(200)).body).data;
    const shown = JSON.stringify(feed);
    expect(shown).toContain('Guest Basmati Rice');
    expect(shown).not.toContain('Guest Unapproved Rice');
  });

  it('browses categories and subcategories', async () => {
    const c = await seedCatalogue();
    const categories = expectSuccess<CategoryDto[]>((await guestGet('/categories').expect(200)).body).data;
    expect(categories.map((cat) => cat.name)).toContain('Grocery');
    await guestGet(`/categories/${c.groceryId}/subcategories`).expect(200);
  });

  it('lists products of a category, opens a product, its related items and a rail', async () => {
    const c = await seedCatalogue();
    const page = expectSuccess<CursorPage<ProductSummaryDto>>(
      (await guestGet(`/products?categoryId=${c.groceryId}`).expect(200)).body,
    ).data;
    const names = page.items.map((p) => p.name);
    expect(names).toContain('Guest Basmati Rice');
    expect(names).not.toContain('Guest Unapproved Rice');

    const detail = expectSuccess<ProductDetailDto>((await guestGet(`/products/${c.rice.productId}`).expect(200)).body).data;
    expect(detail.name).toBe('Guest Basmati Rice');
    expect(detail.variants.length).toBeGreaterThan(0);

    await guestGet(`/products/${c.rice.productId}/related`).expect(200);
    await guestGet('/products/rail/RECENTLY_ADDED').expect(200);
  });

  it('searches products', async () => {
    await seedCatalogue();
    const results = expectSuccess<CursorPage<ProductSummaryDto>>(
      (await guestGet('/products/search?q=basmati').expect(200)).body,
    ).data;
    expect(results.items.map((p) => p.name)).toContain('Guest Basmati Rice');
  });

  it('views stores, restaurants and a restaurant menu', async () => {
    const c = await seedCatalogue();
    await guestGet('/stores').expect(200);
    await guestGet(`/stores/${c.storeId}`).expect(200);

    const restaurants = expectSuccess<RestaurantSummaryDto[]>((await guestGet('/restaurants').expect(200)).body).data;
    expect(restaurants.map((r) => r.sellerId)).toContain(c.restaurantId);
    const menu = expectSuccess<RestaurantMenuDto>((await guestGet(`/restaurants/${c.restaurantId}`).expect(200)).body).data;
    expect(JSON.stringify(menu)).toContain('Guest Paneer Tikka');
  });

  it('sees banners, offers and whether a location is served — without an account', async () => {
    await seedCatalogue();
    await guestGet('/banners?placement=home_top').expect(200);
    await guestGet('/offers').expect(200);
    await guestGet(`/store/serviceability?lat=${NEARBY.latitude}&lng=${NEARBY.longitude}`).expect(200);
  });

  it('never sees an unpublished product, even by its id', async () => {
    const c = await seedCatalogue();
    await guestGet(`/products/${c.unapproved.productId}`).expect(404);
  });

  it('is not blocked by a stale or invalid token a signed-out app may still send', async () => {
    const c = await seedCatalogue();
    for (const path of ['/home', '/categories', `/products/${c.rice.productId}`, '/products/search?q=rice', `/restaurants/${c.restaurantId}`]) {
      await api().get(`/api/v1${path}`).set('Authorization', 'Bearer not-a-real-token').expect(200);
    }
  });

  it('sees the same catalogue a signed-in customer sees', async () => {
    const c = await seedCatalogue();
    const { accessToken } = await loginAs(CUSTOMER);
    const signedIn = (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(accessToken)).expect(200);

    for (const path of ['/categories', `/products?categoryId=${c.groceryId}`, `/products/${c.rice.productId}`, `/restaurants/${c.restaurantId}`]) {
      const asGuest = (await guestGet(path).expect(200)).body.data;
      const asCustomer = (await signedIn(path)).body.data;
      expect(asGuest, path).toEqual(asCustomer);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('a guest is refused everything that belongs to an account', () => {
  it('cannot read or change a cart, check out, order or pay', async () => {
    const c = await seedCatalogue();
    const id = randomUUID();
    await expectAllRefused({
      'GET /cart': guestGet('/cart'),
      'POST /cart/items': api().post('/api/v1/cart/items').send({ sellerListingId: c.rice.listingId, qty: 1 }),
      'PATCH /cart/items/:id': api().patch(`/api/v1/cart/items/${id}`).send({ qty: 2 }),
      'DELETE /cart/items/:id': api().delete(`/api/v1/cart/items/${id}`),
      'DELETE /cart': api().delete('/api/v1/cart'),
      'POST /cart/coupon': api().post('/api/v1/cart/coupon').send({ code: 'WELCOME' }),
      'POST /checkout/quote': api().post('/api/v1/checkout/quote').send({}),
      'POST /orders': api().post('/api/v1/orders').set('Idempotency-Key', randomUUID()).send({}),
      'GET /orders': guestGet('/orders'),
      'GET /orders/:id': guestGet(`/orders/${id}`),
      'POST /orders/:id/cancel': api().post(`/api/v1/orders/${id}/cancel`).send({ reason: 'test' }),
      'POST /payments/create': api().post('/api/v1/payments/create').send({ orderId: id }),
      'POST /payments/:id/refresh': api().post(`/api/v1/payments/${id}/refresh`),
      'GET /payments/:id/status': guestGet(`/payments/${id}/status`),
    });
    // Nothing was created for anyone.
    expect(await prisma.cart.count()).toBe(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it('cannot read or change a profile, addresses, notifications, rewards or order history', async () => {
    const c = await seedCatalogue();
    const id = randomUUID();
    await expectAllRefused({
      'GET /auth/me': guestGet('/auth/me'),
      'PATCH /auth/me': api().patch('/api/v1/auth/me').send({ fullName: 'Guest' }),
      'DELETE /auth/me': api().delete('/api/v1/auth/me'),
      'GET /addresses': guestGet('/addresses'),
      'POST /addresses': api().post('/api/v1/addresses').send({}),
      'PATCH /addresses/:id': api().patch(`/api/v1/addresses/${id}`).send({}),
      'DELETE /addresses/:id': api().delete(`/api/v1/addresses/${id}`),
      'GET /notifications': guestGet('/notifications'),
      'GET /notifications/unread-count': guestGet('/notifications/unread-count'),
      'POST /devices': api().post('/api/v1/devices').send({}),
      'GET /referrals/me': guestGet('/referrals/me'),
      'POST /referrals/apply': api().post('/api/v1/referrals/apply').send({ code: 'ABC123' }),
      'GET /rewards/coupons': guestGet('/rewards/coupons'),
      'GET /products/previously-ordered': guestGet('/products/previously-ordered'),
      'POST /products/:variantId/notify-me': api().post(`/api/v1/products/${c.rice.variantId}/notify-me`),
    });
  });

  it('cannot reach seller or admin routes', async () => {
    await expectAllRefused({
      'GET /seller/orders': guestGet('/seller/orders'),
      'GET /seller/listings': guestGet('/seller/listings'),
      'GET /admin/orders': guestGet('/admin/orders'),
      'GET /admin/sellers': guestGet('/admin/sellers'),
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('signed in, a customer still reaches only their own records', () => {
  it("cannot see or change another customer's address", async () => {
    const owner = await loginAs(CUSTOMER);
    const other = await loginAs(OTHER_CUSTOMER);
    const addressId = await seedAddress(owner.userId);

    const othersList = expectSuccess<{ id: string }[]>(
      (await api().get('/api/v1/addresses').set('Authorization', bearer(other.accessToken)).expect(200)).body,
    ).data;
    expect(othersList.map((a) => a.id)).not.toContain(addressId);

    await api()
      .patch(`/api/v1/addresses/${addressId}`)
      .set('Authorization', bearer(other.accessToken))
      .send({ label: 'Mine now' })
      .expect(404);
    await api().delete(`/api/v1/addresses/${addressId}`).set('Authorization', bearer(other.accessToken)).expect(404);
    expect((await prisma.address.findUniqueOrThrow({ where: { id: addressId } })).deletedAt).toBeNull();
  });

  it('has an own cart: adding works for the signed-in customer only', async () => {
    const c = await seedCatalogue();
    const owner = await loginAs(CUSTOMER);
    const other = await loginAs(OTHER_CUSTOMER);

    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(owner.accessToken))
      .send({ sellerListingId: c.rice.listingId, qty: 1 })
      .expect(200);

    const othersCart = expectSuccess<{ items: unknown[] }>(
      (await api().get('/api/v1/cart').set('Authorization', bearer(other.accessToken)).expect(200)).body,
    ).data;
    expect(othersCart.items).toHaveLength(0);
  });
});
