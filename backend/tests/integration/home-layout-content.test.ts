/**
 * Home Page Builder / Category Display — the "home_layout" content document
 * end to end through the real app: draft, preview, publish, restore and
 * discard; what customers receive; who may change it; what is refused.
 *
 * Customers only ever get the PUBLISHED layout (the built-in defaults while
 * nothing is published), never a draft.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  DEFAULT_HOME_LAYOUT,
  ErrorCode,
  SellerType,
  UnitType,
  UserRole,
  resolveHomeLayout,
  type AdminBannerDto,
  type AdminCategoryOptionDto,
  type AdminHomeLayoutDto,
  type BannerDto,
  type HomeLayoutContent,
  type HomeLayoutDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as otpService from '../../src/modules/auth/otp.service';

/** The response is an error envelope with this code. */
const fails = (body: unknown, code: string) => expect(expectError(body).code).toBe(code);

const ADMIN = { mobile: '9400000811', email: 'layout-admin@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Layout Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function otpSession(mobile: string): Promise<string> {
  await otpService.clearOtpState(mobile);
  const sent = await api().post('/api/v1/auth/send-otp').send({ mobile }).expect(200);
  const otp = expectSuccess<{ devOtp: string }>(sent.body).data.devOtp;
  const res = await api().post('/api/v1/auth/verify-otp').send({ mobile, otp });
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(mobile: string): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Store ${mobile}`,
      sellerType: SellerType.GROCERY,
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
  delete: (p: string) => api().delete(`/api/v1${p}`).set('Authorization', bearer(token)),
});

/** A seller's top category + subcategory with one approved product (so customers see it). */
async function branch(seller: { id: string; token: string }, admin: string, top: string, sub: string) {
  const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await as(seller.token).post('/seller/categories', { name: top }).expect(201)).body).data;
  const topId = tree.categories.find((c) => c.name === top)!.id;
  const subId = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/subcategories', { parentId: topId, name: sub }).expect(201)).body).data.id;
  const product = expectSuccess<{ id: string }>(
    (
      await as(seller.token)
        .post('/seller/products', { categoryId: subId, name: `${sub} 1 kg ${seller.id.slice(0, 4)}`, sku: `SKU-${randomUUID().slice(0, 8)}`, variantName: '1 kg', unit: UnitType.KG, unitValue: 1, mrpPaise: 6_000, pricePaise: 5_000, stockQty: 40 })
        .expect(201)
    ).body,
  ).data;
  const batch = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/approval-batches', { productIds: [product.id] }).expect(201)).body).data;
  await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);
  return { topId, subId };
}

async function adminUpload(token: string, purpose: 'banner', width = 1200, height = 600): Promise<string> {
  const body = await sharp({ create: { width, height, channels: 3, background: '#f4a261' } }).jpeg({ quality: 90 }).toBuffer();
  const presigned = expectSuccess<{ uploadUrl: string; key: string }>(
    (await as(token).post('/admin/uploads/presign', { fileName: 'card.jpg', contentType: 'image/jpeg', purpose }).expect(200)).body,
  ).data;
  const target = new URL(presigned.uploadUrl);
  await api().put(`${target.pathname}${target.search}`).set('Authorization', bearer(token)).set('Content-Type', 'image/jpeg').send(body).expect(200);
  return presigned.key;
}

const published = async () => expectSuccess<HomeLayoutDto>((await api().get('/api/v1/content/home-layout').expect(200)).body).data;
const adminView = async (token: string) => expectSuccess<AdminHomeLayoutDto>((await as(token).get('/admin/content/home-layout').expect(200)).body).data;

/** A complete, valid layout with a few deliberate changes. */
function editedLayout(changes: (layout: HomeLayoutContent) => void = () => undefined): HomeLayoutContent {
  const layout = structuredClone(resolveHomeLayout(DEFAULT_HOME_LAYOUT));
  layout.hero.background = { ...layout.hero.background, type: 'solid', color: 'peach' };
  layout.hero.cards.maxItems = 2;
  const food = layout.sections.find((section) => section.key === 'food_carousel')!;
  layout.sections = [food, ...layout.sections.filter((section) => section.key !== 'food_carousel')];
  food.title = 'Hungry?';
  food.maxItems = 5;
  layout.sections.find((section) => section.key === 'offers')!.visible = false;
  layout.categoryPlacements.home_top.maxItems = 6;
  layout.categoryPlacements.categories_page.maxItems = 16;
  changes(layout);
  return layout;
}

let admin: string;

beforeEach(async () => {
  await truncateAll();
  await cache.clear();
  admin = await loginAdmin();
});

describe('customers see only the published layout', () => {
  it('before anything is published: the built-in defaults, revision 0', async () => {
    const dto = await published();
    expect(dto).toEqual({ revision: 0, publishedAt: null, layout: resolveHomeLayout(DEFAULT_HOME_LAYOUT) });
    expect(dto.layout.hero.background.type).toBe('gradient');
    expect(dto.layout.sections.map((section) => section.key)[0]).toBe('top_categories');
  });

  it('a saved draft never reaches customers; the preview shows it; publishing makes it revision 1', async () => {
    const draft = editedLayout();
    const saved = expectSuccess<AdminHomeLayoutDto>((await as(admin).put('/admin/content/home-layout/draft', { layout: draft }).expect(200)).body).data;
    expect(saved.draft?.basedOnRevision).toBe(0);
    expect(saved.published).toBeNull();

    // Customers: still the defaults.
    expect((await published()).revision).toBe(0);
    expect((await published()).layout.hero.background.color).toBe(DEFAULT_HOME_LAYOUT.hero.background.color);

    // Admin preview: the draft, resolved.
    const preview = expectSuccess<HomeLayoutDto>((await as(admin).get('/admin/content/home-layout/preview').expect(200)).body).data;
    expect(preview.layout).toEqual(resolveHomeLayout(draft));

    const after = expectSuccess<AdminHomeLayoutDto>((await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(200)).body).data;
    expect(after.draft).toBeNull();
    expect(after.published?.revision).toBe(1);
    expect(after.published?.publishedBy).toBe('Layout Admin');

    const live = await published();
    expect(live.revision).toBe(1);
    expect(live.publishedAt).not.toBeNull();
    expect(live.layout.sections[0]).toMatchObject({ key: 'food_carousel', title: 'Hungry?', maxItems: 5 });
    expect(live.layout.sections.find((section) => section.key === 'offers')?.visible).toBe(false);
    expect(live.layout.hero.background).toMatchObject({ type: 'solid', color: 'peach' });
  });

  it('Home and Categories-page category counts are independent placements', async () => {
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout() }).expect(200);
    await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(200);
    const { layout } = await published();
    expect(layout.categoryPlacements.home_top.maxItems).toBe(6);
    expect(layout.categoryPlacements.categories_page.maxItems).toBe(16);
    expect(layout.categoryPlacements.home_explore.maxItems).toBe(10); // untouched default
  });

  it('publishing again archives the previous revision; an earlier revision can be restored into the draft', async () => {
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout() }).expect(200);
    await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(200);
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout((l) => { l.hero.background.color = 'mint'; }) }).expect(200);
    const second = expectSuccess<AdminHomeLayoutDto>((await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 1 }).expect(200)).body).data;
    expect(second.published?.revision).toBe(2);
    expect(second.history.map((entry) => entry.revision)).toEqual([1]);
    expect((await published()).layout.hero.background.color).toBe('mint');

    const restored = expectSuccess<AdminHomeLayoutDto>((await as(admin).post(`/admin/content/home-layout/restore/${second.history[0]!.id}`).expect(200)).body).data;
    expect(restored.draft?.layout.hero.background.color).toBe('peach');
    expect(restored.draft?.basedOnRevision).toBe(2);
    // Restoring changes only the draft.
    expect((await published()).layout.hero.background.color).toBe('mint');

    await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 2 }).expect(200);
    expect((await published())).toMatchObject({ revision: 3 });
    expect((await published()).layout.hero.background.color).toBe('peach');
  });

  it('discarding the draft leaves the published layout as it was', async () => {
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout() }).expect(200);
    const after = expectSuccess<AdminHomeLayoutDto>((await as(admin).delete('/admin/content/home-layout/draft').expect(200)).body).data;
    expect(after.draft).toBeNull();
    expect((await published()).revision).toBe(0);
    fails((await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(400)).body, ErrorCode.VALIDATION_ERROR);
  });

  it('every change is audited', async () => {
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout() }).expect(200);
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout() }).expect(200);
    await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(200);
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'ContentDocument' }, orderBy: { createdAt: 'asc' } })).map((entry) => entry.action);
    expect(actions).toEqual(['content.draft.create', 'content.draft.update', 'content.publish']);
  });
});

describe('who may change it', () => {
  it('no session: 401 on every admin route; customer and seller sessions: 403', async () => {
    fails((await api().get('/api/v1/admin/content/home-layout').expect(401)).body, ErrorCode.UNAUTHENTICATED);
    fails((await api().put('/api/v1/admin/content/home-layout/draft').send({ layout: editedLayout() }).expect(401)).body, ErrorCode.UNAUTHENTICATED);

    const customer = await otpSession('9400000812');
    const seller = await seedSeller('9400000813');
    for (const token of [customer, seller.token]) {
      fails((await as(token).get('/admin/content/home-layout').expect(403)).body, ErrorCode.FORBIDDEN);
      fails((await as(token).put('/admin/content/home-layout/draft', { layout: editedLayout() }).expect(403)).body, ErrorCode.FORBIDDEN);
      fails((await as(token).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(403)).body, ErrorCode.FORBIDDEN);
      fails((await as(token).get('/admin/content/home-layout/preview').expect(403)).body, ErrorCode.FORBIDDEN);
    }
    expect(await prisma.contentDocument.count()).toBe(0);
  });
});

describe('what is refused', () => {
  it('free-form colours, unknown fields, out-of-range sizes and duplicate sections', async () => {
    const bad: [string, HomeLayoutContent | object][] = [
      ['CSS colour', editedLayout((l) => { l.hero.background.color = 'red; background: url(x)'; })],
      ['unknown field', { ...editedLayout(), script: '<script>alert(1)</script>' }],
      ['card height', editedLayout((l) => { l.hero.cards.height = 999; })],
      ['card count', editedLayout((l) => { l.hero.cards.maxItems = 9; })],
      ['duplicate section', editedLayout((l) => { l.sections.push({ ...l.sections[0]! }); })],
      ['unknown section', editedLayout((l) => { (l.sections[0] as { key: string }).key = 'custom_html'; })],
      ['bad category path', editedLayout((l) => { l.categoryPlacements.home_top.paths = ['../etc']; })],
      ['overlay opacity', editedLayout((l) => { l.hero.background.overlayOpacity = 0.95; })],
    ];
    for (const [label, layout] of bad) {
      const res = await as(admin).put('/admin/content/home-layout/draft', { layout });
      expect(res.status, label).toBe(400);
      fails(res.body, ErrorCode.VALIDATION_ERROR);
    }
    expect(await prisma.contentDocument.count()).toBe(0);
  });

  it('a background image from another website', async () => {
    const layout = editedLayout((l) => {
      l.hero.background = { ...l.hero.background, type: 'image', imageUrl: 'https://evil.example.com/bg.jpg' };
    });
    fails((await as(admin).put('/admin/content/home-layout/draft', { layout }).expect(400)).body, ErrorCode.VALIDATION_ERROR);
  });

  it('publishing a layout that names a category that is not live; then the same layout with a live one', async () => {
    const seller = await seedSeller('9400000814');
    await branch(seller, admin, 'Grocery', 'Rice');
    const layout = editedLayout((l) => {
      l.categoryPlacements.home_top = { ...l.categoryPlacements.home_top, mode: 'manual', paths: ['grocery', 'snacks'] };
    });
    await as(admin).put('/admin/content/home-layout/draft', { layout }).expect(200);
    const refused = await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(400);
    fails(refused.body, ErrorCode.VALIDATION_ERROR);
    expect(expectError(refused.body).message).toContain('snacks');
    expect((await published()).revision).toBe(0);

    layout.categoryPlacements.home_top.paths = ['grocery'];
    layout.categoryStyles = [{ path: 'grocery/rice', displayName: 'Chawal', displayNameHi: 'चावल', tileBackground: 'yellow', textColor: 'dark', hidden: false }];
    await as(admin).put('/admin/content/home-layout/draft', { layout }).expect(200);
    await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(200);
    const live = await published();
    expect(live.layout.categoryPlacements.home_top).toMatchObject({ mode: 'manual', paths: ['grocery'] });
    expect(live.layout.categoryStyles).toEqual([layout.categoryStyles[0]]);
  });

  it('a manual placement with no categories chosen', async () => {
    const layout = editedLayout((l) => { l.categoryPlacements.home_more = { ...l.categoryPlacements.home_more, mode: 'manual', paths: [] }; });
    await as(admin).put('/admin/content/home-layout/draft', { layout }).expect(200);
    fails((await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(400)).body, ErrorCode.VALIDATION_ERROR);
  });

  it('publishing over a newer revision someone else published meanwhile', async () => {
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout() }).expect(200);
    await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(200);
    await as(admin).put('/admin/content/home-layout/draft', { layout: editedLayout((l) => { l.hero.padding = 'compact'; }) }).expect(200);
    // This admin's screen still shows revision 0.
    fails((await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(409)).body, ErrorCode.CONTENT_CHANGED);
    expect((await published()).revision).toBe(1);
    expect((await adminView(admin)).draft).not.toBeNull();
  });
});

describe('category options for the pickers', () => {
  it('live categories merged by path across sellers, with seller and product counts', async () => {
    const one = await seedSeller('9400000815');
    const two = await seedSeller('9400000816');
    await branch(one, admin, 'Grocery', 'Rice');
    await branch(two, admin, 'Grocery', 'Rice');
    await branch(two, admin, 'Snacks', 'Chips');
    const options = expectSuccess<AdminCategoryOptionDto[]>((await as(admin).get('/admin/content/category-options').expect(200)).body).data;
    const byPath = new Map(options.map((option) => [option.path, option]));
    expect([...byPath.keys()].sort()).toEqual(['grocery', 'grocery/rice', 'snacks', 'snacks/chips']);
    expect(byPath.get('grocery')).toMatchObject({ depth: 0, parentPath: null, sellerCount: 2, productCount: 2 });
    expect(byPath.get('grocery/rice')).toMatchObject({ depth: 1, parentPath: 'grocery', sellerCount: 2, productCount: 2 });
    expect(byPath.get('snacks')).toMatchObject({ sellerCount: 1, productCount: 1 });
  });
});

describe('top cards and banner presets', () => {
  it('"home_cards" banners with the warm backgrounds and text tone reach customers in order', async () => {
    const created: AdminBannerDto[] = [];
    for (const [title, background] of [['Home Cleaning', 'peach'], ['Food', 'yellow'], ['Kitchen Specials', 'mint']] as const) {
      const imageKey = await adminUpload(admin, 'banner', 800, 800);
      created.push(
        expectSuccess<AdminBannerDto>(
          (await as(admin).post('/admin/banners', { placement: 'home_cards', title, subtitle: 'Shop now', imageKey, displayOrder: created.length, layout: { background, textTone: 'dark', fit: 'cover' } }).expect(201)).body,
        ).data,
      );
    }
    expect(created.map((banner) => banner.layout?.variant)).toEqual(['tile', 'tile', 'tile']); // the placement's default
    const live = expectSuccess<BannerDto[]>((await api().get('/api/v1/banners?placement=home_cards').expect(200)).body).data;
    expect(live.map((banner) => banner.title)).toEqual(['Home Cleaning', 'Food', 'Kitchen Specials']);
    expect(live.map((banner) => banner.layout?.background)).toEqual(['peach', 'yellow', 'mint']);
    expect(live[0]!.layout?.textTone).toBe('dark');
  });

  it('a background that is not one of the named colours is refused', async () => {
    const imageKey = await adminUpload(admin, 'banner');
    const res = await as(admin).post('/admin/banners', { placement: 'home_cards', imageKey, layout: { background: '#ff0000' } }).expect(400);
    fails(res.body, ErrorCode.VALIDATION_ERROR);
  });

  it('an uploaded background image goes through the image pipeline and can then be published', async () => {
    const key = await adminUpload(admin, 'banner', 1400, 900);
    const image = expectSuccess<{ url: string }>((await as(admin).post('/admin/content/home-layout/background-image', { key }).expect(200)).body).data;
    expect(image.url).toMatch(/\.webp$/);
    const layout = editedLayout((l) => {
      l.hero.background = { ...l.hero.background, type: 'image', imageUrl: image.url, overlayColor: 'white', overlayOpacity: 0.3 };
    });
    await as(admin).put('/admin/content/home-layout/draft', { layout }).expect(200);
    await as(admin).post('/admin/content/home-layout/publish', { basedOnRevision: 0 }).expect(200);
    expect((await published()).layout.hero.background).toMatchObject({ type: 'image', imageUrl: image.url, overlayOpacity: 0.3 });
  });
});

describe('Food Section destination', () => {
  it('a banner can open the Food section: no target is stored, and customers get FOOD', async () => {
    const imageKey = await adminUpload(admin, 'banner');
    const created = expectSuccess<AdminBannerDto>(
      (await as(admin).post('/admin/banners', { placement: 'home_top', title: 'Hungry?', imageKey, actionType: 'FOOD', actionValue: 'ignored-anything' }).expect(201)).body,
    ).data;
    expect(created).toMatchObject({ actionType: 'FOOD', actionValue: null });
    const live = expectSuccess<BannerDto[]>((await api().get('/api/v1/banners?placement=home_top').expect(200)).body).data;
    expect(live.map((banner) => [banner.title, banner.actionType, banner.actionValue])).toEqual([['Hungry?', 'FOOD', null]]);
  });

  it('an unknown destination is still refused', async () => {
    const imageKey = await adminUpload(admin, 'banner');
    fails((await as(admin).post('/admin/banners', { placement: 'home_top', imageKey, actionType: 'SCREEN' }).expect(400)).body, ErrorCode.VALIDATION_ERROR);
  });
});

describe('Latest products (GET /products/rail/RECENTLY_ADDED — the Home "Latest products" section)', () => {
  it('newest eligible products first; out-of-stock products and switched-off sellers are left out', async () => {
    const one = await seedSeller('9400000817');
    const two = await seedSeller('9400000818');
    await branch(one, admin, 'Grocery', 'Rice');
    await branch(one, admin, 'Snacks', 'Chips');
    await branch(one, admin, 'Dairy', 'Milk');
    await branch(two, admin, 'Bakery', 'Bread');

    const product = (sub: string, seller: { id: string }) => prisma.product.findFirstOrThrow({ where: { name: `${sub} 1 kg ${seller.id.slice(0, 4)}` } });
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const [rice, chips, milk, bread] = await Promise.all([product('Rice', one), product('Chips', one), product('Milk', one), product('Bread', two)]);
    await prisma.product.update({ where: { id: rice.id }, data: { createdAt: hoursAgo(72) } });
    await prisma.product.update({ where: { id: chips.id }, data: { createdAt: hoursAgo(24) } });
    await prisma.product.update({ where: { id: milk.id }, data: { createdAt: hoursAgo(1) } });
    await prisma.product.update({ where: { id: bread.id }, data: { createdAt: hoursAgo(2) } });
    // Newest, but nothing left to sell.
    await prisma.sellerListing.updateMany({ where: { variant: { productId: milk.id } }, data: { stockQty: 0 } });
    // Second newest, but its seller is switched off.
    await prisma.seller.update({ where: { id: two.id }, data: { isActive: false } });

    const rail = expectSuccess<{ products: { id: string; name: string }[] }>((await api().get('/api/v1/products/rail/RECENTLY_ADDED?limit=10').expect(200)).body).data;
    expect(rail.products.map((p) => p.id)).toEqual([chips.id, rice.id]);
  });
});
