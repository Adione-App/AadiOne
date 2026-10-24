/**
 * Food section (customer Food list + restaurant page), end to end:
 *
 *   - GET /restaurants filters on the server by each restaurant's OWN type:
 *     VEG = pure-veg restaurants, NON_VEG = every other one (whatever veg
 *     dishes it has), type = RESTAURANT / CAFE; each row says which (diet)
 *     and, with a location, the real delivery fee and time; nothing without
 *     a location;
 *   - admin-managed restaurant logo / cover through the admin upload + image
 *     pipeline (WebP, replace removes the old file, remove clears it), refused
 *     to sellers, for non-food sellers and for non-admin uploads;
 *   - the Food hero banners (placements "food" / "food_background") with
 *     their optional button text.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ProductStatus,
  UnitType,
  UserRole,
  type AdminBannerDto,
  type BannerDto,
  type RestaurantMenuDto,
  type RestaurantSummaryDto,
  prepTimeRange,
} from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import { storage, storageKeyFromUrl } from '../../src/infra/storage';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const ADMIN = { mobile: '9400000951', email: 'food-admin@adione.test', password: 'TestAdmin@123' };
/** ~1 km from every seeded kitchen. */
const NEAR = { lat: 25.035, lng: 74.11 };

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  put: (p: string, body: object) => api().put(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  delete: (p: string) => api().delete(`/api/v1${p}`).set('Authorization', bearer(token)),
});

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

let counter = 0;

/** A live food seller open all day near NEAR, with its menu → one section → the given items. */
async function kitchen(
  name: string,
  sellerType: 'RESTAURANT' | 'CAFE' | 'GROCERY',
  options: { vegOnly?: boolean; items?: { name: string; diet: 'VEG' | 'NON_VEG' | null; available?: boolean }[]; ownerMobile?: string } = {},
): Promise<string> {
  counter += 1;
  const seller = await prisma.seller.create({
    data: {
      code: `FOOD-${counter}`,
      name,
      sellerType,
      addressLine: 'Police Thana Road',
      city: 'Railmagra',
      state: 'Rajasthan',
      pincode: '313329',
      latitude: 25.029,
      longitude: 74.11,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  if (sellerType !== 'GROCERY') {
    await prisma.restaurantProfile.create({ data: { sellerId: seller.id, cuisine: ['North Indian'], isVegOnly: options.vegOnly ?? false, avgPrepMins: 25 } });
  }
  const menu = await prisma.category.create({ data: { sellerId: seller.id, name: 'Main Menu', slug: `menu-${counter}`, path: `menu-${counter}`, depth: 0 } });
  const section = await prisma.category.create({
    data: { sellerId: seller.id, parentId: menu.id, name: 'Burger', slug: 'burger', path: `menu-${counter}/burger`, depth: 1 },
  });
  for (const item of options.items ?? []) {
    counter += 1;
    const product = await prisma.product.create({
      data: {
        name: item.name,
        slug: `item-${counter}`,
        categoryId: section.id,
        status: ProductStatus.ACTIVE,
        approvalStatus: 'APPROVED',
        submittedBySellerId: seller.id,
        searchKeywords: [],
        attributes: item.diet ? { diet: item.diet } : {},
      },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, sku: `FOOD-ITEM-${counter}`, variantName: 'Regular', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
    });
    await prisma.sellerListing.create({
      data: { sellerId: seller.id, variantId: variant.id, mrpPaise: 12900, pricePaise: 12900, stockQty: 100_000, tracksStock: false, isAvailable: item.available ?? true },
    });
  }
  if (options.ownerMobile) {
    const user = await prisma.user.create({ data: { mobile: options.ownerMobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
    await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  }
  return seller.id;
}

const list = async (query = ''): Promise<RestaurantSummaryDto[]> =>
  expectSuccess<RestaurantSummaryDto[]>((await api().get(`/api/v1/restaurants${query}`).expect(200)).body).data;

function jpeg(width: number, height: number, color = '#2e7d32'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer();
}

/** presign -> PUT the bytes; returns the upload key. */
async function adminUpload(token: string, body: Buffer, purpose: 'restaurant' | 'banner'): Promise<string> {
  const presigned = expectSuccess<{ uploadUrl: string; key: string }>(
    (await as(token).post('/admin/uploads/presign', { fileName: 'photo.jpg', contentType: 'image/jpeg', purpose }).expect(200)).body,
  ).data;
  const target = new URL(presigned.uploadUrl);
  await api().put(`${target.pathname}${target.search}`).set('Authorization', bearer(token)).set('Content-Type', 'image/jpeg').send(body).expect(200);
  return presigned.key;
}

async function stored(url: string): Promise<Buffer | null> {
  const key = storageKeyFromUrl(url);
  return key ? storage.get(key, 20 * 1024 * 1024) : null;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  for (const mobile of [ADMIN.mobile, '9400000952', '9400000953']) await otpService.clearOtpState(mobile);
});

/* -------------------------------------------------------------------------- */

describe('GET /restaurants — Food filters and card data', () => {
  it('classifies and filters by the restaurant\'s own type, never by its menu items', async () => {
    const veg = await kitchen('Shree Veg Kitchen', 'RESTAURANT', { vegOnly: true, items: [{ name: 'Paneer Burger', diet: 'VEG' }] });
    const nonVeg = await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Veg Burger', diet: 'VEG' }, { name: 'Chicken Burger', diet: 'NON_VEG' }] });
    const cafe = await kitchen('Daily Cafe', 'CAFE', { items: [{ name: 'Cold Coffee', diet: null }] });
    // Not pure veg, though everything it serves right now is veg.
    const offOnly = await kitchen('Quiet Diner', 'RESTAURANT', { items: [{ name: 'Fish Fry', diet: 'NON_VEG', available: false }, { name: 'Dal', diet: 'VEG' }] });

    const all = await list();
    const byId = new Map(all.map((r) => [r.sellerId, r]));
    expect(all).toHaveLength(4);
    // `diet` = the restaurant's own type (isVegOnly) — one mark, always set.
    expect(byId.get(veg)).toMatchObject({ isVegOnly: true, diet: 'VEG' });
    expect(byId.get(nonVeg)).toMatchObject({ isVegOnly: false, diet: 'NON_VEG' });
    expect(byId.get(cafe)).toMatchObject({ isVegOnly: false, diet: 'NON_VEG' });
    expect(byId.get(offOnly)).toMatchObject({ isVegOnly: false, diet: 'NON_VEG' });
    // The old menu-derived fields are gone from the response.
    for (const row of all) {
      expect(row).not.toHaveProperty('dietClass');
      expect(row).not.toHaveProperty('servesVeg');
      expect(row).not.toHaveProperty('servesNonVeg');
    }

    // The filters: Veg = pure-veg restaurants only; Non-Veg = every other one.
    const ids = (rows: RestaurantSummaryDto[]) => rows.map((r) => r.sellerId).sort();
    expect(ids(await list('?diet=VEG'))).toEqual([veg]);
    expect(ids(await list('?diet=NON_VEG'))).toEqual([nonVeg, cafe, offOnly].sort());
    expect((await list('?diet=NON_VEG')).every((r) => r.diet === 'NON_VEG' && !r.isVegOnly)).toBe(true);
    expect((await list('?diet=VEG')).every((r) => r.diet === 'VEG' && r.isVegOnly)).toBe(true);
    expect(ids(await list('?type=CAFE'))).toEqual([cafe]);
    expect(ids(await list('?type=RESTAURANT'))).toEqual([veg, nonVeg, offOnly].sort());
    expect(ids(await list('?type=CAFE&diet=VEG'))).toEqual([]);
    expect(ids(await list('?type=CAFE&diet=NON_VEG'))).toEqual([cafe]);

    await api().get('/api/v1/restaurants?diet=EGG').expect(400);
    await api().get('/api/v1/restaurants?type=GROCERY').expect(400);
  });

  it('gives the real delivery fee and time only for a location it delivers to', async () => {
    await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Burger', diet: 'VEG' }] });

    const anywhere = (await list())[0]!;
    expect(anywhere).toMatchObject({ distanceKm: null, deliveryFeePaise: null, etaMinMinutes: null, etaMaxMinutes: null });

    const near = (await list(`?lat=${NEAR.lat}&lng=${NEAR.lng}`))[0]!;
    expect(near.distanceKm).toBeGreaterThan(0);
    // The configured fee slabs (≤ 3 km road distance = ₹20 by default) and the checkout ETA.
    expect(near.deliveryFeePaise).toBe(2000);
    expect(near.etaMinMinutes).toBeGreaterThan(0);
    expect(near.etaMaxMinutes).toBeGreaterThanOrEqual(near.etaMinMinutes!);

    // Out of range: not listed at all, never a made-up fee.
    expect(await list('?lat=26.9124&lng=75.7873')).toEqual([]);
  });
});

/** One more live-or-hidden food item for `sellerId`, in a new section of a new or existing menu. */
async function extraItem(
  sellerId: string,
  item: { name: string; diet: 'VEG' | 'NON_VEG'; sectionActive?: boolean; menuActive?: boolean },
): Promise<void> {
  counter += 1;
  const menu = await prisma.category.create({
    data: { sellerId, name: `Menu ${counter}`, slug: `menu-x-${counter}`, path: `menu-x-${counter}`, depth: 0, isActive: item.menuActive ?? true },
  });
  const section = await prisma.category.create({
    data: { sellerId, parentId: menu.id, name: `Section ${counter}`, slug: `section-${counter}`, path: `menu-x-${counter}/section-${counter}`, depth: 1, isActive: item.sectionActive ?? true },
  });
  const product = await prisma.product.create({
    data: {
      name: item.name,
      slug: `item-x-${counter}`,
      categoryId: section.id,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      submittedBySellerId: sellerId,
      searchKeywords: [],
      attributes: { diet: item.diet },
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, sku: `FOOD-X-${counter}`, variantName: 'Regular', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  await prisma.sellerListing.create({
    data: { sellerId, variantId: variant.id, mrpPaise: 9900, pricePaise: 9900, stockQty: 100_000, tracksStock: false, isAvailable: true },
  });
}

describe('restaurant classification — the restaurant\'s own type, items keep their own marks', () => {
  const ids = (rows: RestaurantSummaryDto[]) => rows.map((r) => r.sellerId).sort();
  const itemMarks = (menu: RestaurantMenuDto) =>
    new Map(menu.sections.flatMap((section) => section.items).map((item) => [item.name, item.diet]));
  const menuOf = async (id: string) =>
    expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${id}`).expect(200)).body).data;

  it('a non-veg restaurant with veg dishes is only ever Non-Veg; its veg dishes keep their veg mark', async () => {
    const nepali = await kitchen('Nepali Kitchen', 'RESTAURANT', {
      items: [
        { name: 'Chicken Curry', diet: 'NON_VEG' },
        { name: 'Paneer Dish', diet: 'VEG' },
        { name: 'Veg Chow Mein', diet: 'VEG' },
        { name: 'Chicken Momos', diet: 'NON_VEG' },
      ],
    });
    const pureVeg = await kitchen('Pure Veg Restaurant', 'RESTAURANT', {
      vegOnly: true,
      items: [{ name: 'Paneer Dish', diet: 'VEG' }, { name: 'Dal', diet: 'VEG' }, { name: 'Roti', diet: 'VEG' }],
    });

    const byId = new Map((await list()).map((r) => [r.sellerId, r]));
    expect(byId.get(nepali)).toMatchObject({ diet: 'NON_VEG', isVegOnly: false, menuItemCount: 4 });
    expect(byId.get(pureVeg)).toMatchObject({ diet: 'VEG', isVegOnly: true, menuItemCount: 3 });
    expect(ids(await list('?diet=VEG'))).toEqual([pureVeg]);
    expect(ids(await list('?diet=NON_VEG'))).toEqual([nepali]);

    // The menu header reads the restaurant's own type; each item keeps its own mark.
    const nepaliMenu = await menuOf(nepali);
    expect(nepaliMenu.restaurant.isVegOnly).toBe(false);
    expect(itemMarks(nepaliMenu)).toEqual(
      new Map([['Chicken Curry', 'NON_VEG'], ['Paneer Dish', 'VEG'], ['Veg Chow Mein', 'VEG'], ['Chicken Momos', 'NON_VEG']]),
    );
    const vegMenu = await menuOf(pureVeg);
    expect(vegMenu.restaurant.isVegOnly).toBe(true);
    expect(itemMarks(vegMenu)).toEqual(new Map([['Paneer Dish', 'VEG'], ['Dal', 'VEG'], ['Roti', 'VEG']]));
  });

  it('a non-veg restaurant whose live items are all veg is still Non-Veg', async () => {
    const id = await kitchen('Dhaba 52', 'RESTAURANT', { items: [{ name: 'Paneer Tikka', diet: 'VEG' }] });
    await extraItem(id, { name: 'Chicken Tikka', diet: 'NON_VEG', sectionActive: false });
    await extraItem(id, { name: 'Fish Curry', diet: 'NON_VEG', menuActive: false });
    expect((await list())[0]).toMatchObject({ sellerId: id, diet: 'NON_VEG', menuItemCount: 1 });
    expect(ids(await list('?diet=VEG'))).toEqual([]);
    expect(ids(await list('?diet=NON_VEG'))).toEqual([id]);
    // Hidden sections / menus still stay off the public menu.
    expect((await menuOf(id)).sections.flatMap((section) => section.items).map((item) => item.name)).toEqual(['Paneer Tikka']);
  });

  it('a pure-veg restaurant is never Non-Veg — not even with an item wrongly marked non-veg — and the item keeps its own mark', async () => {
    const wronglyMarked = await kitchen('Shree Bhojanalaya', 'RESTAURANT', { vegOnly: true, items: [{ name: 'Dal Bati', diet: 'VEG' }, { name: 'Egg Curry', diet: 'NON_VEG' }] });
    const unmarked = await kitchen('Gopal Sweets', 'CAFE', { vegOnly: true, items: [{ name: 'Kachori', diet: null }] });
    const byId = new Map((await list()).map((r) => [r.sellerId, r]));
    expect(byId.get(wronglyMarked)).toMatchObject({ diet: 'VEG' });
    expect(byId.get(unmarked)).toMatchObject({ diet: 'VEG' });
    expect(ids(await list('?diet=NON_VEG'))).toEqual([]);
    expect(ids(await list('?diet=VEG'))).toEqual([wronglyMarked, unmarked].sort());

    // The seller's data is untouched: no item mark is inferred from the restaurant's type.
    const marks = itemMarks(await menuOf(wronglyMarked));
    expect(marks.get('Dal Bati')).toBe('VEG');
    expect(marks.get('Egg Curry')).toBe('NON_VEG');
    expect(itemMarks(await menuOf(unmarked)).get('Kachori')).toBeNull();
  });

  it('changing the saved type moves the restaurant between the filters; its menu does not', async () => {
    const id = await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Veg Burger', diet: 'VEG' }] });
    expect(ids(await list('?diet=NON_VEG'))).toEqual([id]);
    await prisma.restaurantProfile.update({ where: { sellerId: id }, data: { isVegOnly: true } });
    expect(ids(await list('?diet=VEG'))).toEqual([id]);
    expect(ids(await list('?diet=NON_VEG'))).toEqual([]);
    expect((await list())[0]).toMatchObject({ diet: 'VEG' });
  });

  it('an empty menu keeps its type (the app hides places with nothing to order)', async () => {
    const empty = await kitchen('New Veg Kitchen', 'RESTAURANT', { vegOnly: true });
    const off = await kitchen('Closed Menu', 'RESTAURANT', { items: [{ name: 'Thali', diet: 'VEG', available: false }] });
    const byId = new Map((await list()).map((r) => [r.sellerId, r]));
    expect(byId.get(empty)).toMatchObject({ diet: 'VEG', menuItemCount: 0 });
    expect(byId.get(off)).toMatchObject({ diet: 'NON_VEG', menuItemCount: 0 });
  });
});

describe('restaurant logo and cover (admin-managed)', () => {
  it('uploads, replaces and removes through the image pipeline; the app sees them', async () => {
    const admin = await loginAdmin();
    const sellerId = await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Burger', diet: 'VEG' }] });

    const cover = expectSuccess<{ coverImageUrl: string | null; logoUrl: string | null }>(
      (await as(admin).put(`/admin/restaurants/${sellerId}/images/cover`, { key: await adminUpload(admin, await jpeg(1800, 900), 'restaurant') }).expect(200)).body,
    ).data;
    expect(cover.coverImageUrl).toMatch(/\.webp$/);
    expect((await sharp((await stored(cover.coverImageUrl!))!).metadata()).format).toBe('webp');
    const logo = expectSuccess<{ logoUrl: string | null }>(
      (await as(admin).put(`/admin/restaurants/${sellerId}/images/logo`, { key: await adminUpload(admin, await jpeg(600, 600, '#000000'), 'restaurant') }).expect(200)).body,
    ).data;
    expect(logo.logoUrl).toMatch(/\.webp$/);

    // Customers: the Food card uses its own cover; the menu page has both.
    expect((await list())[0]!.coverImageUrl).toBe(cover.coverImageUrl);
    const menu = expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${sellerId}`).expect(200)).body).data;
    expect(menu.restaurant).toMatchObject({ coverImageUrl: cover.coverImageUrl, logoUrl: logo.logoUrl });

    // Replacing removes the old file; removing clears the field and the file.
    const replaced = expectSuccess<{ coverImageUrl: string }>(
      (await as(admin).put(`/admin/restaurants/${sellerId}/images/cover`, { key: await adminUpload(admin, await jpeg(1600, 800, '#1565c0'), 'restaurant') }).expect(200)).body,
    ).data;
    expect(replaced.coverImageUrl).not.toBe(cover.coverImageUrl);
    expect(await stored(cover.coverImageUrl!)).toBeNull();
    await as(admin).delete(`/admin/restaurants/${sellerId}/images/logo`).expect(200);
    expect(await stored(logo.logoUrl!)).toBeNull();
    expect((await prisma.restaurantProfile.findUniqueOrThrow({ where: { sellerId } })).logoUrl).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: sellerId, action: { startsWith: 'restaurant.' } } })).toBe(4);
  });

  it('is refused to sellers, for non-food sellers, for non-admin uploads and for bad images', async () => {
    const admin = await loginAdmin();
    const sellerId = await kitchen('Ha Hokam Food', 'RESTAURANT', { ownerMobile: '9400000952' });
    const grocery = await kitchen('Corner Kirana', 'GROCERY');
    const seller = (await loginAs('9400000952')).accessToken;

    const key = await adminUpload(admin, await jpeg(1600, 800), 'restaurant');
    await as(seller).put(`/admin/restaurants/${sellerId}/images/cover`, { key }).expect(403);
    await as(seller).delete(`/admin/restaurants/${sellerId}/images/cover`).expect(403);
    await as(admin).put(`/admin/restaurants/${grocery}/images/cover`, { key }).expect(400);
    await as(admin).put(`/admin/restaurants/${sellerId}/images/cover`, { key: 'seller/abc/photo.jpg' }).expect(400);
    await as(admin).put(`/admin/restaurants/${sellerId}/images/banner`, { key }).expect(400);
    await as(admin).put(`/admin/restaurants/${randomUUID()}/images/cover`, { key }).expect(404);
    // Too narrow for a cover (the banner rule): refused, nothing saved.
    const tiny = await adminUpload(admin, await jpeg(300, 150), 'restaurant');
    await as(admin).put(`/admin/restaurants/${sellerId}/images/cover`, { key: tiny }).expect(400);
    expect((await prisma.restaurantProfile.findUniqueOrThrow({ where: { sellerId } })).coverImageUrl).toBeNull();
  });
});

describe('Food hero banners', () => {
  it('serves the "food" and "food_background" placements with their button text', async () => {
    const admin = await loginAdmin();
    const hero = expectSuccess<AdminBannerDto>(
      (
        await as(admin)
          .post('/admin/banners', {
            placement: 'food',
            title: 'Good food brings good mood',
            subtitle: 'Discover local restaurants and cafes near you',
            ctaLabel: 'Order now',
            imageKey: await adminUpload(admin, await jpeg(1200, 900), 'banner'),
          })
          .expect(201)
      ).body,
    ).data;
    expect(hero.ctaLabel).toBe('Order now');
    await as(admin).post('/admin/banners', { placement: 'food_background', imageKey: await adminUpload(admin, await jpeg(1600, 900, '#e8f5e9'), 'banner') }).expect(201);

    const food = expectSuccess<BannerDto[]>((await api().get('/api/v1/banners?placement=food').expect(200)).body).data;
    expect(food.map((b) => [b.title, b.subtitle, b.ctaLabel])).toEqual([['Good food brings good mood', 'Discover local restaurants and cafes near you', 'Order now']]);
    expect(expectSuccess<BannerDto[]>((await api().get('/api/v1/banners?placement=food_background').expect(200)).body).data).toHaveLength(1);

    // The button can be removed again; it is optional.
    await as(admin).patch(`/admin/banners/${hero.id}`, { ctaLabel: null }).expect(200);
    expect(expectSuccess<BannerDto[]>((await api().get('/api/v1/banners?placement=food').expect(200)).body).data[0]!.ctaLabel).toBeNull();
    await as(admin).patch(`/admin/banners/${hero.id}`, { ctaLabel: 'x'.repeat(41) }).expect(400);
  });
});

/** The restaurant's own upload: POST /seller/uploads/presign, then the bytes. */
async function sellerUpload(token: string, body: Buffer): Promise<string> {
  const presigned = expectSuccess<{ uploadUrl: string; key: string }>(
    (await as(token).post('/seller/uploads/presign', { fileName: 'photo.jpg', contentType: 'image/jpeg' }).expect(200)).body,
  ).data;
  const target = new URL(presigned.uploadUrl);
  await api().put(`${target.pathname}${target.search}`).set('Authorization', bearer(token)).set('Content-Type', 'image/jpeg').send(body).expect(200);
  return presigned.key;
}

describe('restaurant cover and menu images, and preparation time', () => {
  it('the restaurant sets its own cover and menu image; the card shows the cover, the menu page the menu image', async () => {
    const sellerId = await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Burger', diet: 'VEG' }], ownerMobile: '9400000952' });
    const seller = (await loginAs('9400000952')).accessToken;

    const cover = expectSuccess<{ coverImageUrl: string }>(
      (await as(seller).put('/seller/restaurant/images/cover', { key: await sellerUpload(seller, await jpeg(1600, 900)) }).expect(200)).body,
    ).data.coverImageUrl;
    const menuImage = expectSuccess<{ menuImageUrl: string }>(
      (await as(seller).put('/seller/restaurant/images/menu', { key: await sellerUpload(seller, await jpeg(1600, 900, '#c62828')) }).expect(200)).body,
    ).data.menuImageUrl;
    expect(cover).toMatch(/\.webp$/);
    expect(menuImage).toMatch(/\.webp$/);
    expect(menuImage).not.toBe(cover);
    expect(expectSuccess<{ coverImageUrl: string; menuImageUrl: string }>((await as(seller).get('/seller/restaurant/branding').expect(200)).body).data).toMatchObject({
      coverImageUrl: cover,
      menuImageUrl: menuImage,
    });

    // Food list card: the cover — never the menu image. Menu page: both, separately.
    expect((await list())[0]!.coverImageUrl).toBe(cover);
    const page = expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${sellerId}`).expect(200)).body).data;
    expect(page.restaurant).toMatchObject({ coverImageUrl: cover, menuImageUrl: menuImage });

    // Replacing one leaves the other alone; removing clears only it.
    await as(seller).put('/seller/restaurant/images/menu', { key: await sellerUpload(seller, await jpeg(1600, 900, '#2e7d32')) }).expect(200);
    expect(await stored(menuImage)).toBeNull();
    await as(seller).delete('/seller/restaurant/images/menu').expect(200);
    const profile = await prisma.restaurantProfile.findUniqueOrThrow({ where: { sellerId } });
    expect(profile.coverImageUrl).toBe(cover);
    expect(profile.menuImageUrl).toBeNull();
  });

  it('keeps the Restaurant Image, the Menu Cover Image and each item photo separate — none stands in for another', async () => {
    const sellerId = await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Burger', diet: 'VEG' }], ownerMobile: '9400000952' });
    const seller = (await loginAs('9400000952')).accessToken;
    const product = await prisma.product.findFirstOrThrow({ where: { submittedBySellerId: sellerId } });
    const itemPhoto = 'https://cdn.example/products/s-x/2026-10-18/burger.webp';
    await prisma.productImage.create({ data: { productId: product.id, url: itemPhoto, thumbUrl: itemPhoto, cardUrl: itemPhoto } });

    // No restaurant images yet: the card and the menu hero get none — never the item's photo.
    expect((await list())[0]!.coverImageUrl).toBeNull();
    const before = expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${sellerId}`).expect(200)).body).data;
    expect(before.restaurant).toMatchObject({ coverImageUrl: null, menuImageUrl: null });
    expect(before.sections[0]!.items[0]!.imageUrl).toBe(itemPhoto);

    const cover = expectSuccess<{ coverImageUrl: string }>(
      (await as(seller).put('/seller/restaurant/images/cover', { key: await sellerUpload(seller, await jpeg(1600, 900)) }).expect(200)).body,
    ).data.coverImageUrl;
    const menuCover = expectSuccess<{ menuImageUrl: string }>(
      (await as(seller).put('/seller/restaurant/images/menu', { key: await sellerUpload(seller, await jpeg(1600, 900, '#c62828')) }).expect(200)).body,
    ).data.menuImageUrl;

    // Each surface gets its own; the item photo and its product are untouched.
    expect((await list())[0]!.coverImageUrl).toBe(cover);
    const after = expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${sellerId}`).expect(200)).body).data;
    expect(after.restaurant).toMatchObject({ coverImageUrl: cover, menuImageUrl: menuCover });
    expect(after.sections[0]!.items[0]!.imageUrl).toBe(itemPhoto);
    expect(await prisma.productImage.findMany({ where: { productId: product.id }, select: { url: true } })).toEqual([{ url: itemPhoto }]);
    // The Seller Panel reads them back from its own profile.
    expect(
      expectSuccess<{ restaurantProfile: { coverImageUrl: string | null; menuImageUrl: string | null } }>((await as(seller).get('/seller/onboarding').expect(200)).body).data
        .restaurantProfile,
    ).toMatchObject({ coverImageUrl: cover, menuImageUrl: menuCover });
  });

  it('a restaurant that has not filled in its profile yet can still set its photos', async () => {
    const sellerId = await kitchen('Ha Hokam Food', 'RESTAURANT', { ownerMobile: '9400000952' });
    await prisma.restaurantProfile.delete({ where: { sellerId } });
    const seller = (await loginAs('9400000952')).accessToken;
    expect(expectSuccess<{ menuImageUrl: string | null }>((await as(seller).get('/seller/restaurant/branding').expect(200)).body).data.menuImageUrl).toBeNull();

    const menuCover = expectSuccess<{ menuImageUrl: string }>(
      (await as(seller).put('/seller/restaurant/images/menu', { key: await sellerUpload(seller, await jpeg(1600, 900)) }).expect(200)).body,
    ).data.menuImageUrl;
    expect(await prisma.restaurantProfile.findUniqueOrThrow({ where: { sellerId } })).toMatchObject({ menuImageUrl: menuCover, coverImageUrl: null, cuisine: [] });
  });

  it("keeps each restaurant to its own images and its own uploads", async () => {
    await kitchen('Ha Hokam Food', 'RESTAURANT', { ownerMobile: '9400000952' });
    const other = await kitchen('Other Cafe', 'CAFE', { ownerMobile: '9400000953' });
    const seller = (await loginAs('9400000952')).accessToken;
    const otherToken = (await loginAs('9400000953')).accessToken;

    // The logo stays an Admin decision; another seller's upload is refused.
    const key = await sellerUpload(seller, await jpeg(1600, 900));
    await as(seller).put('/seller/restaurant/images/logo', { key }).expect(400);
    await as(otherToken).put('/seller/restaurant/images/cover', { key }).expect(403); // "This upload does not belong to your account."
    expect((await prisma.restaurantProfile.findUniqueOrThrow({ where: { sellerId: other } })).coverImageUrl).toBeNull();
    // A seller cannot use the admin routes for anyone, itself included.
    await as(seller).put(`/admin/restaurants/${other}/images/cover`, { key }).expect(403);
    await as(seller).put(`/admin/restaurants/${other}/prep-time`, { avgPrepMins: 30 }).expect(403);
  });

  it('admin sets the menu image and preparation time; customers see it as the ±5 min range', async () => {
    const admin = await loginAdmin();
    const sellerId = await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Burger', diet: 'VEG' }] });

    const menuImage = expectSuccess<{ menuImageUrl: string }>(
      (await as(admin).put(`/admin/restaurants/${sellerId}/images/menu`, { key: await adminUpload(admin, await jpeg(1600, 900), 'restaurant') }).expect(200)).body,
    ).data.menuImageUrl;
    expect(menuImage).toMatch(/\.webp$/);

    for (const bad of [0, 241, 2.5, -5]) {
      await as(admin).put(`/admin/restaurants/${sellerId}/prep-time`, { avgPrepMins: bad }).expect(400);
    }
    await as(admin).put(`/admin/restaurants/${sellerId}/prep-time`, { avgPrepMins: 30 }).expect(200);
    const card = (await list())[0]!;
    const page = expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${sellerId}`).expect(200)).body).data;
    expect(card.avgPrepMins).toBe(30);
    expect(page.restaurant.avgPrepMins).toBe(30);
    // The one display rule both screens use.
    expect(prepTimeRange(card.avgPrepMins)?.label).toBe('25–35 min');
    expect(prepTimeRange(page.restaurant.avgPrepMins)?.label).toBe(prepTimeRange(card.avgPrepMins)?.label);
    expect([10, 20, 30, 35, 45, 3].map((m) => prepTimeRange(m)?.label)).toEqual([
      '5–15 min',
      '15–25 min',
      '25–35 min',
      '30–40 min',
      '40–50 min',
      '1–8 min',
    ]);
    expect(prepTimeRange(null)).toBeNull();
  });
});
