/**
 * Branding & Identity (content/branding.service.ts, admin /admin/branding,
 * public GET /branding).
 *
 *   - an upload is checked from the FILE ITSELF (real format, size,
 *     dimensions, shape, transparency) and refused with a clear reason; a
 *     refused upload changes nothing and its raw file is deleted;
 *   - accepted files are stored optimised and go into the DRAFT only;
 *   - publish: all changes, or only the chosen ones (the rest stay in the
 *     draft); a new revision each time; earlier files stay usable;
 *   - the public endpoint serves only DYNAMIC assets (never the app icons,
 *     which are the source for the next native build), is readable from any
 *     website without credentials, and changes the moment an admin publishes;
 *   - only Admin / Super Admin (Configuration write) can change anything;
 *     staff, sellers and customers cannot, and nobody unsigned;
 *   - the PDFs use the published main logo, else the built-in one.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, UserRole, brandAssetProblems, brandAssetFor, type AdminBrandingDto, type PublicBrandingDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import { storage } from '../../src/infra/storage';
import * as otpService from '../../src/modules/auth/otp.service';
import { brandedPdfLogo, resetBrandingMemoForTests } from '../../src/modules/content/branding.service';

const PASSWORD = 'TestAdmin@123';
let seq = 0;

async function adminToken(role: UserRole = UserRole.ADMIN): Promise<string> {
  const n = ++seq;
  const email = `brand-${role.toLowerCase()}-${n}@adione.test`;
  await prisma.user.create({ data: { mobile: `9410000${String(n).padStart(3, '0')}`, email, fullName: 'Brand Admin', passwordHash: await hashPassword(PASSWORD), role } });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: PASSWORD }).expect(200);
  return bearer(expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken);
}

/** A PNG of the given size; `alpha` makes the corners transparent. */
async function png(width: number, height: number, alpha = true): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 30, g: 142, b: 62 } } });
  const mark = await sharp({ create: { width: Math.ceil(width / 2), height: Math.ceil(height / 2), channels: 3, background: { r: 30, g: 142, b: 62 } } }).png().toBuffer();
  return base.composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
}

/** Puts bytes where the browser's presigned PUT would, and returns the key. */
async function uploaded(bytes: Buffer, ext = 'png', contentType = 'image/png'): Promise<string> {
  const key = `admin/branding/uploads/2026-11-12/${randomUUID()}.${ext}`;
  await storage.put(key, bytes, contentType);
  return key;
}

const attach = (auth: string, slot: string, key: string, fileName = 'logo.png') =>
  api().post(`/api/v1/admin/branding/assets/${slot}`).set('Authorization', auth).send({ key, fileName });
const getAdmin = async (auth: string) => expectSuccess<AdminBrandingDto>((await api().get('/api/v1/admin/branding').set('Authorization', auth).expect(200)).body).data;
const getPublic = async () => expectSuccess<PublicBrandingDto>((await api().get('/api/v1/branding').expect(200)).body).data;
const publish = (auth: string, basedOnRevision: number, slots?: string[]) =>
  api().post('/api/v1/admin/branding/publish').set('Authorization', auth).send({ basedOnRevision, ...(slots ? { slots } : {}) });

beforeEach(async () => {
  await truncateAll();
  await cache.clear();
  resetBrandingMemoForTests();
});

describe('the rules for each asset', () => {
  it('size, shape and transparency are checked against each slot', () => {
    const facts = (w: number, h: number, extra: Partial<{ format: string; hasAlpha: boolean; opaque: boolean; bytes: number }> = {}) => ({
      format: 'png',
      width: w,
      height: h,
      bytes: 10_000,
      hasAlpha: true,
      opaque: false,
      ...extra,
    });
    expect(brandAssetProblems('logo_main', facts(960, 330))).toEqual([]);
    expect(brandAssetProblems('logo_main', facts(100, 40)).join(' ')).toMatch(/at least 240 × 48/);
    expect(brandAssetProblems('favicon', facts(512, 300)).join(' ')).toMatch(/must be square/);
    expect(brandAssetProblems('favicon', facts(512, 512, { format: 'jpeg' })).join(' ')).toMatch(/Upload a PNG image/);
    expect(brandAssetProblems('logo_dark', facts(960, 330, { opaque: true })).join(' ')).toMatch(/transparent background/);
    expect(brandAssetProblems('ios_app_icon', facts(1024, 1024)).join(' ')).toMatch(/must not have any transparent pixels/);
    expect(brandAssetProblems('ios_app_icon', facts(1024, 1024, { hasAlpha: false, opaque: true }))).toEqual([]);
    expect(brandAssetProblems('android_launcher_foreground', facts(512, 512)).join(' ')).toMatch(/at least 1024 × 1024/);
    expect(brandAssetProblems('logo_main', facts(960, 330, { bytes: 6 * 1024 * 1024 })).join(' ')).toMatch(/5 MB/);
  });

  it('a surface falls back along its chain, and never shows an unsafe address', () => {
    const a = (url: string) => ({ url, pngUrl: url, width: 10, height: 10 });
    const branding = { assets: { logo_main: a('https://cdn.example/main.webp'), seller_app_logo: a('javascript:alert(1)') } };
    expect(brandAssetFor(branding, 'light')?.url).toBe('https://cdn.example/main.webp');
    expect(brandAssetFor(branding, 'seller')?.url).toBe('https://cdn.example/main.webp'); // the unsafe one is skipped
    expect(brandAssetFor(branding, 'dark')).toBeNull(); // dark never falls back to a dark-on-white logo
    expect(brandAssetFor(null, 'light')).toBeNull();
  });
});

describe('uploads', () => {
  it('nothing published: every client gets the built-in defaults', async () => {
    expect(await getPublic()).toEqual({ brandName: 'Aadione', revision: 0, publishedAt: null, assets: {} });
  });

  it('a good file is stored optimised and goes into the draft only; the raw upload is deleted', async () => {
    const admin = await adminToken();
    const key = await uploaded(await png(1200, 400));
    const data = expectSuccess<AdminBrandingDto>((await attach(admin, 'logo_main', key, 'Aadione Logo.png').expect(200)).body).data;
    const slot = data.slots.find((s) => s.slot === 'logo_main')!;
    expect(slot.changed).toBe(true);
    expect(slot.published).toBeNull();
    expect(slot.draft).toMatchObject({ width: 1200, height: 400, hasAlpha: true, fileName: 'Aadione Logo.png' });
    expect(slot.draft!.url).toMatch(/\/admin\/branding\/logo-main\/.+\.webp$/);
    expect(slot.draft!.pngUrl).toMatch(/\/admin\/branding\/logo-main\/.+\.png$/);
    expect(data.draft?.changed).toEqual(['logo_main']);
    expect(await storage.get(key, 10_000_000)).toBeNull();
    expect((await getPublic()).assets).toEqual({}); // drafts are never public
  });

  it('a favicon gets the sizes browsers ask for', async () => {
    const admin = await adminToken();
    await attach(admin, 'favicon', await uploaded(await png(512, 512))).expect(200);
    const slot = (await getAdmin(admin)).slots.find((s) => s.slot === 'favicon')!;
    for (const size of [32, 180, 512]) {
      const url = slot.draft!.variants![`png${size}` as 'png32'];
      const file = await storage.get(url.slice(url.indexOf('admin/')), 10_000_000);
      expect((await sharp(file!).metadata()).width).toBe(size);
    }
  });

  it('a bad file is refused with the reason, changes nothing, and its upload is deleted', async () => {
    const admin = await adminToken();
    const small = await uploaded(await png(100, 40));
    const r1 = await attach(admin, 'logo_main', small);
    expectError(r1.body, ErrorCode.VALIDATION_ERROR);
    expect(r1.body.error.message).toMatch(/Main brand logo: .*at least 240 × 48/);
    expect(await storage.get(small, 10_000_000)).toBeNull();

    // Opaque artwork where transparency is required; transparency where Apple forbids it.
    expect((await attach(admin, 'logo_dark', await uploaded(await png(960, 330, false)))).body.error.message).toMatch(/transparent background/);
    expect((await attach(admin, 'ios_app_icon', await uploaded(await png(1024, 1024, true)))).body.error.message).toMatch(/must not have any transparent pixels/);
    // A file that only CLAIMS to be an image.
    const fake = await uploaded(Buffer.from('<svg onload="alert(1)"></svg>'), 'png');
    expect((await attach(admin, 'logo_main', fake)).body.error.code).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE);
    // A key from anywhere else.
    expect((await attach(admin, 'logo_main', 'admin/banners/2026-11-12/x.png')).status).toBe(400);
    expect((await attach(admin, 'logo_main', 'seller/abc/x.png')).status).toBe(400);
    expect((await api().post('/api/v1/admin/branding/assets/not_a_slot').set('Authorization', admin).send({ key: small })).status).toBe(400);

    expect((await getAdmin(admin)).draft).toBeNull();
  });

  it('an opaque square PNG is a valid iOS icon and Android background', async () => {
    const admin = await adminToken();
    await attach(admin, 'ios_app_icon', await uploaded(await png(1024, 1024, false))).expect(200);
    await attach(admin, 'android_launcher_background', await uploaded(await png(1024, 1024, false))).expect(200);
    await attach(admin, 'android_launcher_foreground', await uploaded(await png(1024, 1024, true))).expect(200);
    expect((await getAdmin(admin)).draft?.changed.sort()).toEqual(['android_launcher_background', 'android_launcher_foreground', 'ios_app_icon']);
  });
});

describe('publishing', () => {
  it('publish all: clients get the dynamic assets at once — never the app icons', async () => {
    const admin = await adminToken();
    await attach(admin, 'logo_light', await uploaded(await png(960, 330))).expect(200);
    await attach(admin, 'ios_app_icon', await uploaded(await png(1024, 1024, false))).expect(200);
    await getPublic(); // cached now — a publish must drop it
    const data = expectSuccess<AdminBrandingDto>((await publish(admin, 0).expect(200)).body).data;
    expect(data.published?.revision).toBe(1);
    expect(data.draft).toBeNull();
    expect(data.history[0]).toMatchObject({ revision: 1, changed: ['logo_light', 'ios_app_icon'] });

    const pub = await getPublic();
    expect(pub.revision).toBe(1);
    expect(Object.keys(pub.assets)).toEqual(['logo_light']);
    expect(JSON.stringify(pub)).not.toMatch(/ios|launcher/i);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Branding', action: 'branding.publish' } });
    expect(audit.after).toMatchObject({ revision: 1, slots: ['logo_light', 'ios_app_icon'], buildRequired: ['ios_app_icon'] });
  });

  it('publish selected: only the chosen change goes live; the rest stays in the draft', async () => {
    const admin = await adminToken();
    await attach(admin, 'logo_light', await uploaded(await png(960, 330))).expect(200);
    await attach(admin, 'favicon', await uploaded(await png(512, 512))).expect(200);
    const data = expectSuccess<AdminBrandingDto>((await publish(admin, 0, ['favicon']).expect(200)).body).data;
    expect(Object.keys((await getPublic()).assets)).toEqual(['favicon']);
    expect(data.draft?.changed).toEqual(['logo_light']);
    expect(data.draft?.basedOnRevision).toBe(1);

    // A stale screen (still based on 0) is refused; nothing changes.
    expectError((await publish(admin, 0)).body, ErrorCode.CONTENT_CHANGED);
    await publish(admin, 1).expect(200);
    expect(Object.keys((await getPublic()).assets).sort()).toEqual(['favicon', 'logo_light']);
  });

  it('back to the built-in default, an earlier file again, and a whole earlier version', async () => {
    const admin = await adminToken();
    await attach(admin, 'logo_main', await uploaded(await png(960, 330))).expect(200);
    await publish(admin, 0).expect(200);
    const first = (await getPublic()).assets.logo_main!.pngUrl;
    await attach(admin, 'logo_main', await uploaded(await png(1000, 300))).expect(200);
    await publish(admin, 1).expect(200);
    expect((await getPublic()).assets.logo_main!.pngUrl).not.toBe(first);

    // Default: the slot disappears for clients (they show the built-in logo).
    await api().post('/api/v1/admin/branding/assets/logo_main/default').set('Authorization', admin).expect(200);
    await publish(admin, 2).expect(200);
    expect((await getPublic()).assets.logo_main).toBeUndefined();

    // The first file again, from the slot's history.
    const slot = (await getAdmin(admin)).slots.find((s) => s.slot === 'logo_main')!;
    expect(slot.history.map((h) => h.revision)).toEqual([2, 1]);
    await api().post('/api/v1/admin/branding/assets/logo_main/reuse').set('Authorization', admin).send({ revision: 1 }).expect(200);
    await publish(admin, 3).expect(200);
    expect((await getPublic()).assets.logo_main!.pngUrl).toBe(first);

    // A whole earlier version back into the draft, then published as a NEW version.
    const v2 = (await getAdmin(admin)).history.find((h) => h.revision === 2)!;
    const restored = expectSuccess<AdminBrandingDto>((await api().post(`/api/v1/admin/branding/restore/${v2.id}`).set('Authorization', admin).expect(200)).body).data;
    expect(restored.draft?.changed).toEqual(['logo_main']);
    const after = expectSuccess<AdminBrandingDto>((await publish(admin, 4).expect(200)).body).data;
    expect(after.history[0]).toMatchObject({ revision: 5, restoredFromRevision: 2 });
    expect((await getPublic()).revision).toBe(5);
  });

  it('discarding the draft leaves what is published untouched', async () => {
    const admin = await adminToken();
    await attach(admin, 'logo_main', await uploaded(await png(960, 330))).expect(200);
    await publish(admin, 0).expect(200);
    await attach(admin, 'logo_main', await uploaded(await png(1000, 300))).expect(200);
    const before = (await getPublic()).assets.logo_main!.pngUrl;
    const data = expectSuccess<AdminBrandingDto>((await api().delete('/api/v1/admin/branding/draft').set('Authorization', admin).expect(200)).body).data;
    expect(data.draft).toBeNull();
    expect((await getPublic()).assets.logo_main!.pngUrl).toBe(before);
  });
});

describe('who may do what', () => {
  it('Admin and Super Admin manage branding; staff, sellers, customers and the public cannot', async () => {
    const superAdmin = await adminToken(UserRole.SUPER_ADMIN);
    await attach(superAdmin, 'logo_main', await uploaded(await png(960, 330))).expect(200);

    const staff = await adminToken(UserRole.STAFF);
    await otpService.clearOtpState('9410001001');
    const customer = bearer((await loginAs('9410001001')).accessToken);
    for (const auth of [staff, customer]) {
      expect((await api().get('/api/v1/admin/branding').set('Authorization', auth)).status).toBe(403);
      expect((await attach(auth, 'logo_main', await uploaded(await png(960, 330)))).status).toBe(403);
      expect((await publish(auth, 0)).status).toBe(403);
      // Not even an upload target for branding.
      const presign = await api().post('/api/v1/admin/uploads/presign').set('Authorization', auth).send({ fileName: 'a.png', contentType: 'image/png', purpose: 'branding' });
      expect(presign.status).toBe(403);
    }
    expect((await api().get('/api/v1/admin/branding')).status).toBe(401);
    expect((await api().post('/api/v1/admin/branding/publish').send({ basedOnRevision: 0 })).status).toBe(401);
    expect((await getPublic()).revision).toBe(0);
  });

  it('any website can READ the public branding (no credentials); it carries nothing private', async () => {
    const res = await api().get('/api/v1/branding').set('Origin', 'https://someone-else.example').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    // …but the admin routes keep the allow-list.
    expect((await api().get('/api/v1/admin/branding').set('Origin', 'https://someone-else.example')).status).toBe(403);
  });
});

describe('documents', () => {
  it('PDFs use the published main logo, else the built-in one', async () => {
    expect(await brandedPdfLogo()).toBeNull();
    const admin = await adminToken();
    await attach(admin, 'logo_main', await uploaded(await png(900, 300))).expect(200);
    await publish(admin, 0).expect(200);
    resetBrandingMemoForTests();
    const logo = await brandedPdfLogo();
    expect(logo).toMatchObject({ width: 900, height: 300 });
    expect((await sharp(logo!.png).metadata()).format).toBe('png');
  });
});
