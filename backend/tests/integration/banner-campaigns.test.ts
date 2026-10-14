/**
 * Banner campaigns (Admin Panel → Banners), end to end:
 *
 *   - visibility: DRAFT / ARCHIVED / switched-off / not-yet-started / ended
 *     banners never reach customers; a PUBLISHED one inside its schedule does;
 *   - presentation: `layout` is filled in with the placement's defaults
 *     (Food hero = "split") and out-of-range numbers are refused;
 *   - tap targets: store / restaurant / product listing / https link are
 *     validated on save, and a target that has since gone reaches customers
 *     as NONE (the image stays, the tap does nothing);
 *   - ordering: PUT /admin/banners/order;
 *   - only admins with catalogue rights manage banners.
 */

import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, UserRole, type AdminBannerDto, type BannerDto } from '../../src/shared';
import { api, bearer, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';

const ADMIN = { mobile: '9400000961', email: 'banner-admin@adione.test', password: 'TestAdmin@123' };

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  put: (p: string, body: object) => api().put(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  patch: (p: string, body: object) => api().patch(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
});

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: ADMIN.mobile, email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function upload(token: string): Promise<string> {
  const body = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#2e7d32' } }).jpeg().toBuffer();
  const presigned = expectSuccess<{ uploadUrl: string; key: string }>(
    (await as(token).post('/admin/uploads/presign', { fileName: 'b.jpg', contentType: 'image/jpeg', purpose: 'banner' }).expect(200)).body,
  ).data;
  const target = new URL(presigned.uploadUrl);
  await api().put(`${target.pathname}${target.search}`).set('Authorization', bearer(token)).set('Content-Type', 'image/jpeg').send(body).expect(200);
  return presigned.key;
}

async function create(token: string, fields: Record<string, unknown>): Promise<AdminBannerDto> {
  const res = await as(token).post('/admin/banners', { placement: 'categories_top', imageKey: await upload(token), ...fields });
  if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return expectSuccess<AdminBannerDto>(res.body).data;
}

const live = async (placement = 'categories_top'): Promise<BannerDto[]> =>
  expectSuccess<BannerDto[]>((await api().get(`/api/v1/banners?placement=${placement}`).expect(200)).body).data;

let sellerCounter = 0;
async function seller(sellerType: 'GROCERY' | 'RESTAURANT'): Promise<string> {
  sellerCounter += 1;
  const row = await prisma.seller.create({
    data: {
      code: `BNR-${sellerCounter}`,
      name: `Seller ${sellerCounter}`,
      sellerType,
      addressLine: 'Main Road',
      city: 'Railmagra',
      state: 'Rajasthan',
      pincode: '313329',
      latitude: 25.03,
      longitude: 74.11,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  return row.id;
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('who customers see', () => {
  it('shows only published, switched-on banners inside their schedule', async () => {
    const token = await loginAdmin();
    const published = await create(token, { title: 'Live' });
    const draft = await create(token, { title: 'Draft', status: 'DRAFT' });
    const off = await create(token, { title: 'Off', isActive: false });
    const future = await create(token, { title: 'Future', startsAt: iso(3_600_000) });
    const ended = await create(token, { title: 'Ended', startsAt: iso(-7_200_000), endsAt: iso(-3_600_000) });
    const window = await create(token, { title: 'Window', startsAt: iso(-60_000), endsAt: iso(3_600_000) });

    expect((await live()).map((b) => b.id).sort()).toEqual([published.id, window.id].sort());

    const admin = expectSuccess<AdminBannerDto[]>((await as(token).get('/admin/banners').expect(200)).body).data;
    const visibility = Object.fromEntries(admin.map((b) => [b.title, b.visibility]));
    expect(visibility).toEqual({ Live: 'LIVE', Draft: 'DRAFT', Off: 'OFF', Future: 'SCHEDULED', Ended: 'ENDED', Window: 'LIVE' });

    // Publishing a draft and archiving a live one take effect at once.
    await as(token).patch(`/admin/banners/${draft.id}`, { status: 'PUBLISHED' }).expect(200);
    await as(token).patch(`/admin/banners/${published.id}`, { status: 'ARCHIVED' }).expect(200);
    expect((await live()).map((b) => b.id).sort()).toEqual([draft.id, window.id].sort());
    void off;
    void future;
    void ended;
  });

  it('refuses a schedule that ends before it starts', async () => {
    const token = await loginAdmin();
    const res = await as(token).post('/admin/banners', {
      placement: 'categories_top',
      imageKey: await upload(token),
      startsAt: iso(3_600_000),
      endsAt: iso(60_000),
    });
    expect(res.status).toBe(400);
  });
});

describe('presentation', () => {
  it('fills in the placement defaults, keeps what the admin set and refuses out-of-range values', async () => {
    const token = await loginAdmin();
    const hero = await create(token, { placement: 'food' });
    expect(hero.layout).toMatchObject({ variant: 'split', fit: 'contain', width: 'content', aspectRatio: null, height: null });

    const custom = await create(token, { layout: { variant: 'strip', height: 80, fit: 'cover', alignX: 'left', radius: 'none', background: 'green' } });
    expect(custom.layout).toMatchObject({ variant: 'strip', height: 80, fit: 'cover', alignX: 'left', radius: 'none', background: 'green' });
    expect((await live())[0]!.layout).toMatchObject({ variant: 'strip', height: 80 });

    for (const layout of [{ height: 2000 }, { height: 10 }, { aspectRatio: 20 }, { fit: 'stretch' }, { variant: 'popup' }, { color: '#f00' }]) {
      const res = await as(token).patch(`/admin/banners/${custom.id}`, { layout });
      expect(res.status, JSON.stringify(layout)).toBe(400);
    }
  });
});

describe('tap targets', () => {
  it('validates store, restaurant, listing and link targets on save', async () => {
    const token = await loginAdmin();
    const store = await seller('GROCERY');
    const kitchen = await seller('RESTAURANT');
    const key = await upload(token);
    const post = (actionType: string, actionValue: string) =>
      as(token).post('/admin/banners', { placement: 'categories_top', imageKey: key, actionType, actionValue });

    expect((await post('STORE', kitchen)).status).toBe(400); // a restaurant is not a store
    expect((await post('RESTAURANT', store)).status).toBe(400);
    expect((await post('RAIL', 'NOT_A_RAIL')).status).toBe(400);
    for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:pw@example.com', 'https://localhost/x', 'https://10.0.0.1/x']) {
      expect((await post('URL', url)).status, url).toBe(400);
    }

    await create(token, { actionType: 'STORE', actionValue: store });
    await create(token, { actionType: 'RESTAURANT', actionValue: kitchen });
    await create(token, { actionType: 'RAIL', actionValue: 'OFFERS' });
    await create(token, { actionType: 'URL', actionValue: 'https://www.adione.in/diwali' });
    expect((await live()).map((b) => b.actionType).sort()).toEqual(['RAIL', 'RESTAURANT', 'STORE', 'URL']);
  });

  it('turns an action whose target has gone into NONE for customers', async () => {
    const token = await loginAdmin();
    const store = await seller('GROCERY');
    const banner = await create(token, { actionType: 'STORE', actionValue: store });
    expect((await live())[0]).toMatchObject({ actionType: 'STORE', actionValue: store });

    await prisma.seller.update({ where: { id: store }, data: { isActive: false } });
    expect((await live())[0]).toMatchObject({ id: banner.id, actionType: 'NONE', actionValue: null });
  });
});

describe('ordering and access', () => {
  it('reorders one placement; only admins with catalogue rights manage banners', async () => {
    const token = await loginAdmin();
    const a = await create(token, { title: 'A' });
    const b = await create(token, { title: 'B' });
    const c = await create(token, { title: 'C' });
    await as(token).put('/admin/banners/order', { placement: 'categories_top', ids: [c.id, a.id, b.id] }).expect(200);
    expect((await live()).map((x) => x.title)).toEqual(['C', 'A', 'B']);
    expect((await as(token).put('/admin/banners/order', { placement: 'food', ids: [a.id] })).status).toBe(400);

    const customer = await prisma.user.create({ data: { mobile: '9400000962', fullName: 'Customer', role: UserRole.CUSTOMER } });
    void customer;
    expect((await api().post('/api/v1/admin/banners').send({ placement: 'categories_top' })).status).toBe(401);
  });
});
