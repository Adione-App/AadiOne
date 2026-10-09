/**
 * Admin-managed storefront content — category / subcategory / menu-section
 * images and banners — end to end through the real app and the local storage
 * provider: presign -> PUT the raw file -> attach, then what customers see.
 *
 * Every image goes through the shared pipeline (uploaded-image.service.ts):
 * stored as WebP in PUBLIC storage, the raw upload deleted. A customer-app
 * (OTP) session of a seller or an admin is a CUSTOMER session and is refused.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, SellerType, UnitType, UserRole, type AdminBannerDto, type BannerDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import { env } from '../../src/config/env';
import { storage, storageKeyFromUrl } from '../../src/infra/storage';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const ADMIN = { mobile: '9400000701', email: 'content-admin@adione.test', password: 'TestAdmin@123' };

interface Seller {
  id: string;
  token: string;
}

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function otpSession(mobile: string): Promise<string> {
  await otpService.clearOtpState(mobile);
  const sent = await api().post('/api/v1/auth/send-otp').send({ mobile }).expect(200);
  const otp = expectSuccess<{ devOtp: string }>(sent.body).data.devOtp;
  const res = await api().post('/api/v1/auth/verify-otp').send({ mobile, otp }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(mobile: string, sellerType: SellerType = SellerType.GROCERY): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `${sellerType} ${mobile}`,
      sellerType,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken };
}

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  put: (p: string, body: object) => api().put(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  delete: (p: string) => api().delete(`/api/v1${p}`).set('Authorization', bearer(token)),
});

/** A real JPEG of the given size. */
function jpeg(width: number, height: number, color = '#2e7d32'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer();
}

/** presign -> PUT the bytes to the returned (local) upload URL; returns the key. */
async function upload(token: string, area: 'admin' | 'seller', body: Buffer, extra: object = {}, contentType = 'image/jpeg'): Promise<string> {
  const presigned = expectSuccess<{ uploadUrl: string; key: string }>(
    (await as(token).post(`/${area}/uploads/presign`, { fileName: 'photo.jpg', contentType, ...extra }).expect(200)).body,
  ).data;
  const target = new URL(presigned.uploadUrl);
  expect(target.pathname).toBe(`/api/v1/${area}/uploads/direct`);
  await api().put(`${target.pathname}${target.search}`).set('Authorization', bearer(token)).set('Content-Type', contentType).send(body).expect(200);
  return presigned.key;
}

const adminUpload = (token: string, purpose: 'category' | 'banner', body: Buffer) => upload(token, 'admin', body, { purpose });

/** The stored file behind a public URL, or null once it is gone. */
async function stored(url: string): Promise<Buffer | null> {
  const key = storageKeyFromUrl(url);
  expect(key, `not one of our storage URLs: ${url}`).toBeTruthy();
  return storage.get(key!, 20 * 1024 * 1024);
}

async function expectWebp(url: string, maxWidth?: number): Promise<sharp.Metadata> {
  expect(url).toMatch(/\.webp$/);
  expect(url.startsWith(env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, ''))).toBe(true); // public storage
  const file = await stored(url);
  expect(file, `missing stored file for ${url}`).not.toBeNull();
  const meta = await sharp(file!).metadata();
  expect(meta.format).toBe('webp');
  if (maxWidth) expect(meta.width).toBeLessThanOrEqual(maxWidth);
  return meta;
}

/** A seller's top category + subcategory, with one approved product so customers see the branch. */
async function groceryBranch(seller: Seller, admin: string | null, top = 'Grocery', sub = 'Rice') {
  const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await as(seller.token).post('/seller/categories', { name: top }).expect(201)).body).data;
  const topId = tree.categories.find((c) => c.name === top)!.id;
  const subId = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/subcategories', { parentId: topId, name: sub }).expect(201)).body).data.id;
  if (admin) {
    const product = expectSuccess<{ id: string }>(
      (
        await as(seller.token)
          .post('/seller/products', { categoryId: subId, name: `${sub} 1 kg ${seller.id.slice(0, 4)}`, sku: `SKU-${randomUUID().slice(0, 8)}`, variantName: '1 kg', unit: UnitType.KG, unitValue: 1, mrpPaise: 6_000, pricePaise: 5_000, stockQty: 40 })
          .expect(201)
      ).body,
    ).data;
    const batch = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/approval-batches', { productIds: [product.id] }).expect(201)).body).data;
    await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);
  }
  return { topId, subId };
}

type CustomerCategory = { id: string; name: string; imageUrl: string | null };
const customerTop = async (name: string) =>
  expectSuccess<CustomerCategory[]>((await api().get('/api/v1/categories').expect(200)).body).data.find((c) => c.name === name);
const customerSub = async (topId: string, name: string) =>
  expectSuccess<CustomerCategory[]>((await api().get(`/api/v1/categories/${topId}/subcategories`).expect(200)).body).data.find((c) => c.name === name);

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

/* -------------------------------------------------------------------------- */

describe('category and subcategory images (admin)', () => {
  it('upload -> WebP in public storage, applied to every seller row, shown to customers; replace; remove', async () => {
    const admin = await loginAdmin();
    const a = await seedSeller('9400000711');
    const b = await seedSeller('9400000712');
    const branchA = await groceryBranch(a, admin);
    await groceryBranch(b, null);

    // 1. Upload: stored as WebP (resized to the category profile), raw upload removed.
    const key = await adminUpload(admin, 'category', await jpeg(2400, 1600));
    expect(key).toMatch(/^admin\/categories\//);
    const set = expectSuccess<{ path: string; imageUrl: string; updatedCategories: number }>(
      (await as(admin).put(`/admin/categories/${branchA.topId}/image`, { key }).expect(200)).body,
    ).data;
    expect(set).toMatchObject({ path: 'grocery', updatedCategories: 2 });
    await expectWebp(set.imageUrl, 1200);
    expect(await storage.get(key, 1024)).toBeNull();
    const rows = await prisma.category.findMany({ where: { path: 'grocery', deletedAt: null } });
    expect(rows.map((r) => r.imageUrl)).toEqual([set.imageUrl, set.imageUrl]);
    expect((await customerTop('Grocery'))?.imageUrl).toBe(set.imageUrl);
    expect(await prisma.auditLog.count({ where: { action: 'category.admin_image.set', entityId: branchA.topId } })).toBe(1);

    // Admin catalogue shows it too.
    const catalogue = expectSuccess<{ categories: { name: string; imageUrl: string | null }[] }>((await as(admin).get('/admin/marketplace/catalogue').expect(200)).body).data;
    expect(catalogue.categories.find((c) => c.name === 'Grocery')?.imageUrl).toBe(set.imageUrl);

    // 2. Replace: a new WebP everywhere; the old file is freed.
    const key2 = await adminUpload(admin, 'category', await jpeg(900, 900, '#c62828'));
    const replaced = expectSuccess<{ imageUrl: string }>((await as(admin).put(`/admin/categories/${branchA.topId}/image`, { key: key2 }).expect(200)).body).data;
    expect(replaced.imageUrl).not.toBe(set.imageUrl);
    await expectWebp(replaced.imageUrl);
    expect(await stored(set.imageUrl)).toBeNull();
    expect((await customerTop('Grocery'))?.imageUrl).toBe(replaced.imageUrl);

    // Remove: no image anywhere, file freed.
    const removed = expectSuccess<{ imageUrl: null; updatedCategories: number }>((await as(admin).delete(`/admin/categories/${branchA.topId}/image`).expect(200)).body).data;
    expect(removed).toMatchObject({ imageUrl: null, updatedCategories: 2 });
    expect(await stored(replaced.imageUrl)).toBeNull();
    expect((await customerTop('Grocery'))?.imageUrl).toBeNull();
  });

  it('subcategory image reaches the customer subcategory list', async () => {
    const admin = await loginAdmin();
    const a = await seedSeller('9400000713');
    const branch = await groceryBranch(a, admin);
    const key = await adminUpload(admin, 'category', await jpeg(800, 800));
    const set = expectSuccess<{ path: string; imageUrl: string }>((await as(admin).put(`/admin/categories/${branch.subId}/image`, { key }).expect(200)).body).data;
    expect(set.path).toBe('grocery/rice');
    await expectWebp(set.imageUrl);
    expect((await customerSub(branch.topId, 'Rice'))?.imageUrl).toBe(set.imageUrl);
    // The parent is untouched.
    expect((await customerTop('Grocery'))?.imageUrl).toBeNull();
  });

  it('food: a restaurant menu-section image reaches the customer menu; the seller menu keeps working', async () => {
    const admin = await loginAdmin();
    const restaurant = await seedSeller('9400000714', SellerType.RESTAURANT);
    const sectionId = expectSuccess<{ id: string }>((await as(restaurant.token).post('/seller/menu-sections', { name: 'Starters' }).expect(201)).body).data.id;

    const key = await adminUpload(admin, 'category', await jpeg(1000, 700, '#ef6c00'));
    const set = expectSuccess<{ imageUrl: string; updatedCategories: number }>((await as(admin).put(`/admin/categories/${sectionId}/image`, { key }).expect(200)).body).data;
    expect(set.updatedCategories).toBe(1);
    await expectWebp(set.imageUrl);

    const menu = expectSuccess<{ sections: { id: string; imageUrl: string | null }[] }>((await api().get(`/api/v1/restaurants/${restaurant.id}`).expect(200)).body).data;
    expect(menu.sections.find((s) => s.id === sectionId)?.imageUrl).toBe(set.imageUrl);

    // The seller's own menu management is unchanged (and sees the image).
    const sections = expectSuccess<{ id: string; imageUrl: string | null }[]>((await as(restaurant.token).get('/seller/menu-sections').expect(200)).body).data;
    expect(sections.find((s) => s.id === sectionId)?.imageUrl).toBe(set.imageUrl);
    await as(restaurant.token).post('/seller/menu-sections', { name: 'Mains' }).expect(201);
  });

  it('refuses a non-image, a seller upload key, and an unknown category', async () => {
    const admin = await loginAdmin();
    const a = await seedSeller('9400000715');
    const branch = await groceryBranch(a, null);

    // Bytes that are not an image, sent as image/jpeg: rejected by decoding, never by extension; raw removed.
    const fake = await adminUpload(admin, 'category', Buffer.from('not really a jpeg, just text'.repeat(20)));
    const bad = await as(admin).put(`/admin/categories/${branch.topId}/image`, { key: fake });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    expect(await storage.get(fake, 1024)).toBeNull();
    expect((await prisma.category.findUniqueOrThrow({ where: { id: branch.topId } })).imageUrl).toBeNull();

    // A seller's upload key cannot be attached by an admin endpoint.
    const sellerKey = await upload(a.token, 'seller', await jpeg(800, 800));
    expect(expectError((await as(admin).put(`/admin/categories/${branch.topId}/image`, { key: sellerKey }).expect(400)).body).code).toBe(ErrorCode.VALIDATION_ERROR);

    const key = await adminUpload(admin, 'category', await jpeg(800, 800));
    await as(admin).put(`/admin/categories/${randomUUID()}/image`, { key }).expect(404);
  });
});

/* -------------------------------------------------------------------------- */

describe('banners (admin + customer)', () => {
  it('create, list by placement, home feed, update, replace image, disable, delete', async () => {
    const admin = await loginAdmin();

    const key = await adminUpload(admin, 'banner', await jpeg(2000, 800));
    expect(key).toMatch(/^admin\/banners\//);
    const banner = expectSuccess<AdminBannerDto>(
      (await as(admin).post('/admin/banners', { placement: 'home_top', title: 'Fresh deals', imageKey: key, displayOrder: 1 }).expect(201)).body,
    ).data;
    expect(banner).toMatchObject({ placement: 'home_top', title: 'Fresh deals', subtitle: null, actionType: 'NONE', actionValue: null, isActive: true, displayOrder: 1 });
    const meta = await expectWebp(banner.imageUrl, 1600);
    expect([banner.imageWidth, banner.imageHeight]).toEqual([meta.width, meta.height]);
    expect(banner.imageWidth).toBe(1600);
    expect(await storage.get(key, 1024)).toBeNull();

    // A second placement never leaks into home_top.
    const foodKey = await adminUpload(admin, 'banner', await jpeg(1200, 600));
    await as(admin).post('/admin/banners', { placement: 'food', imageKey: foodKey }).expect(201);

    const publicList = async (placement: string) => expectSuccess<BannerDto[]>((await api().get(`/api/v1/banners?placement=${placement}`).expect(200)).body).data;
    expect((await publicList('home_top')).map((b) => b.id)).toEqual([banner.id]);
    expect(await publicList('food')).toHaveLength(1);
    const home = expectSuccess<{ banners: BannerDto[] }>((await api().get('/api/v1/home').expect(200)).body).data;
    expect(home.banners.map((b) => [b.id, b.imageUrl, b.imageWidth, b.imageHeight])).toEqual([[banner.id, banner.imageUrl, banner.imageWidth, banner.imageHeight]]);

    // Edit text + replace the image: old file freed.
    const key2 = await adminUpload(admin, 'banner', await jpeg(1600, 640, '#1565c0'));
    const updated = expectSuccess<AdminBannerDto>((await as(admin).patch(`/admin/banners/${banner.id}`, { title: 'Weekend sale', subtitle: 'Up to 30% off', imageKey: key2 }).expect(200)).body).data;
    expect(updated).toMatchObject({ id: banner.id, title: 'Weekend sale', subtitle: 'Up to 30% off' });
    expect(updated.imageUrl).not.toBe(banner.imageUrl);
    await expectWebp(updated.imageUrl);
    expect(await stored(banner.imageUrl)).toBeNull();
    expect((await publicList('home_top'))[0]).toMatchObject({ title: 'Weekend sale', imageUrl: updated.imageUrl });

    // Disable: hidden from customers, still listed for admins.
    await as(admin).patch(`/admin/banners/${banner.id}`, { isActive: false }).expect(200);
    expect(await publicList('home_top')).toEqual([]);
    expect(expectSuccess<{ banners: BannerDto[] }>((await api().get('/api/v1/home').expect(200)).body).data.banners).toEqual([]);
    const adminList = expectSuccess<AdminBannerDto[]>((await as(admin).get('/admin/banners?placement=home_top').expect(200)).body).data;
    expect(adminList.map((b) => [b.id, b.isActive])).toEqual([[banner.id, false]]);

    // Delete: gone, file freed, audited.
    await as(admin).delete(`/admin/banners/${banner.id}`).expect(200);
    expect(await prisma.banner.count({ where: { id: banner.id } })).toBe(0);
    expect(await stored(updated.imageUrl)).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: banner.id, action: { in: ['banner.create', 'banner.update', 'banner.delete'] } } })).toBe(4);
  });

  it('validates image width, placement, action and the image key', async () => {
    const admin = await loginAdmin();

    const narrow = await adminUpload(admin, 'banner', await jpeg(400, 200));
    expect(expectError((await as(admin).post('/admin/banners', { placement: 'home_top', imageKey: narrow }).expect(400)).body).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await storage.get(narrow, 1024)).toBeNull();

    const key = await adminUpload(admin, 'banner', await jpeg(1200, 480));
    await as(admin).post('/admin/banners', { placement: 'Home Top', imageKey: key }).expect(400);
    await as(admin).post('/admin/banners', { placement: 'home_top', imageKey: key, actionType: 'CATEGORY', actionValue: randomUUID() }).expect(400);
    await as(admin).post('/admin/banners', { placement: 'home_top', imageKey: 'sellers/x/images/a.jpg' }).expect(400);
    expect(await prisma.banner.count()).toBe(0);

    // A category placement + an action that exists.
    const a = await seedSeller('9400000716');
    const branch = await groceryBranch(a, null);
    const created = expectSuccess<AdminBannerDto>(
      (await as(admin).post('/admin/banners', { placement: `category:${branch.topId}`, imageKey: key, actionType: 'CATEGORY', actionValue: branch.topId }).expect(201)).body,
    ).data;
    expect(created).toMatchObject({ placement: `category:${branch.topId}`, actionType: 'CATEGORY', actionValue: branch.topId });
  });
});

/* -------------------------------------------------------------------------- */

describe('who may manage content', () => {
  const mutations = (key: string, categoryId: string, bannerId: string): Array<[string, string, object | undefined]> => [
    ['post', '/admin/uploads/presign', { fileName: 'a.jpg', contentType: 'image/jpeg', purpose: 'banner' }],
    ['put', `/admin/categories/${categoryId}/image`, { key }],
    ['delete', `/admin/categories/${categoryId}/image`, undefined],
    ['post', '/admin/banners', { placement: 'home_top', imageKey: key }],
    ['patch', `/admin/banners/${bannerId}`, { isActive: false }],
    ['delete', `/admin/banners/${bannerId}`, undefined],
  ];

  it('customer-app (OTP) sessions of a seller owner and of an admin are refused; the full admin session works', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9400000717');
    const branch = await groceryBranch(seller, null);
    const key = await adminUpload(admin, 'banner', await jpeg(1200, 480));
    const banner = expectSuccess<AdminBannerDto>((await as(admin).post('/admin/banners', { placement: 'home_top', imageKey: key }).expect(201)).body).data;

    const sellerOtp = await otpSession('9400000717');
    const adminOtp = await otpSession(ADMIN.mobile);
    for (const [who, token] of [['seller OTP', sellerOtp], ['admin OTP', adminOtp], ['seller panel', seller.token]] as const) {
      for (const [method, p, body] of mutations('admin/banners/x.jpg', branch.topId, banner.id)) {
        const req = (as(token) as unknown as Record<string, (p: string, b?: object) => ReturnType<ReturnType<typeof as>['get']>>)[method]!(p, body);
        const res = await req;
        expect({ who, p, status: res.status, code: res.body?.error?.code }).toEqual({ who, p, status: 403, code: ErrorCode.FORBIDDEN });
      }
      expect((await as(token).get('/admin/banners')).status).toBe(403);
    }

    // Nothing changed.
    expect((await prisma.banner.findUniqueOrThrow({ where: { id: banner.id } })).isActive).toBe(true);
    // The admin's full session still manages it.
    await as(admin).patch(`/admin/banners/${banner.id}`, { isActive: false }).expect(200);
  });
});

/* -------------------------------------------------------------------------- */

describe('the shared pipeline is unchanged for sellers', () => {
  it('a seller product image is still stored as WebP (with a thumbnail) in public storage', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9400000718');
    const branch = await groceryBranch(seller, admin);
    const product = await prisma.product.findFirstOrThrow({ where: { categoryId: branch.subId } });

    const key = await upload(seller.token, 'seller', await jpeg(2000, 2000));
    const view = expectSuccess<{ images: { url: string; thumbUrl: string | null }[] }>((await as(seller.token).post(`/seller/products/${product.id}/images`, { key }).expect(201)).body).data;
    expect(view.images).toHaveLength(1);
    const image = view.images[0]!;
    await expectWebp(image.url, 1200);
    if (image.thumbUrl && image.thumbUrl !== image.url) await expectWebp(image.thumbUrl, 480);
    expect(await storage.get(key, 1024)).toBeNull();

    // A seller cannot reach the admin upload route either.
    await as(seller.token).post('/admin/uploads/presign', { fileName: 'a.jpg', contentType: 'image/jpeg', purpose: 'category' }).expect(403);
  });

  it('admin content never lands in private (seller document) storage', () => {
    const privateRoot = path.resolve(process.cwd(), 'storage-private');
    if (existsSync(privateRoot)) expect(readdirSync(privateRoot)).not.toContain('admin');
  });
});
