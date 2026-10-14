/**
 * Food section (customer Food list + restaurant page), end to end:
 *
 *   - GET /restaurants filters on the server: VEG = pure-veg kitchens,
 *     NON_VEG = places with a live non-veg item, type = RESTAURANT / CAFE;
 *     each row says which (diet) and, with a location, the real delivery fee
 *     and time; nothing without a location;
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
  it('marks and filters veg / non-veg from the real item marks; a place with both shows both', async () => {
    const veg = await kitchen('Shree Veg Kitchen', 'RESTAURANT', { vegOnly: true, items: [{ name: 'Paneer Burger', diet: 'VEG' }] });
    const nonVeg = await kitchen('Ha Hokam Food', 'RESTAURANT', { items: [{ name: 'Veg Burger', diet: 'VEG' }, { name: 'Chicken Burger', diet: 'NON_VEG' }] });
    const cafe = await kitchen('Daily Cafe', 'CAFE', { items: [{ name: 'Cold Coffee', diet: null }] });
    // A switched-off non-veg item does not make a kitchen "non-veg".
    const offOnly = await kitchen('Quiet Diner', 'RESTAURANT', { items: [{ name: 'Fish Fry', diet: 'NON_VEG', available: false }, { name: 'Dal', diet: 'VEG' }] });

    const all = await list();
    const byId = new Map(all.map((r) => [r.sellerId, r]));
    expect(all).toHaveLength(4);
    expect(byId.get(veg)!.diet).toBe('VEG');
    expect(byId.get(nonVeg)!.diet).toBe('NON_VEG');
    expect(byId.get(cafe)!.diet).toBeNull();
    expect(byId.get(offOnly)!.diet).toBeNull();

    // Green / red marks from the real item marks: a place with both kinds shows both;
    // an unmarked item (the cafe's coffee) and a switched-off item count as neither.
    const marks = (id: string) => [byId.get(id)!.servesVeg, byId.get(id)!.servesNonVeg];
    expect(marks(veg)).toEqual([true, false]);
    expect(marks(nonVeg)).toEqual([true, true]);
    expect(marks(cafe)).toEqual([false, false]);
    expect(marks(offOnly)).toEqual([true, false]);

    // The filters mean exactly the marks: Veg = serves veg, Non-Veg = serves non-veg.
    const ids = (rows: RestaurantSummaryDto[]) => rows.map((r) => r.sellerId).sort();
    expect(ids(await list('?diet=VEG'))).toEqual([veg, nonVeg, offOnly].sort());
    expect(ids(await list('?diet=NON_VEG'))).toEqual([nonVeg]);
    expect((await list('?diet=NON_VEG')).every((r) => r.servesNonVeg)).toBe(true);
    expect((await list('?diet=VEG')).every((r) => r.servesVeg)).toBe(true);
    expect(ids(await list('?type=CAFE'))).toEqual([cafe]);
    expect(ids(await list('?type=RESTAURANT'))).toEqual([veg, nonVeg, offOnly].sort());
    expect(ids(await list('?type=CAFE&diet=VEG'))).toEqual([]);

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
