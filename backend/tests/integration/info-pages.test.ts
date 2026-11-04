/**
 * Privacy Policy, Terms & Conditions and About Aadione
 * (content/info-page.service.ts, legal/legal.routes.ts, admin content routes):
 *
 *   - public, read-only, for guests and customers alike; nothing is published
 *     automatically (built-in wording until an admin publishes; no About);
 *   - business / contact details come from Admin Configuration on every read,
 *     with NO invented fallback — a line whose setting is empty is left out;
 *   - only admins with Configuration access can read the editor; only those
 *     with write access can save, preview, publish or restore;
 *   - publishing refuses «TO CONFIRM» wording and, for the legal pages,
 *     missing operator / grievance-officer settings;
 *   - every revision is kept (history + restore) and audited.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigKey,
  ErrorCode,
  UserRole,
  resolveInfoPage,
  validateInfoPage,
  type AdminInfoPageDto,
  type InfoPageContent,
  type InfoPageDto,
  type InfoPagePreviewDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const PASSWORD = 'TestAdmin@123';

async function adminToken(role: UserRole = UserRole.ADMIN, n = 1): Promise<string> {
  const email = `pages-${role.toLowerCase()}-${n}@adione.test`;
  await prisma.user.create({
    data: { mobile: `94000008${role === UserRole.ADMIN ? '1' : '2'}${n}`, email, fullName: 'Owner Admin', passwordHash: await hashPassword(PASSWORD), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: PASSWORD }).expect(200);
  return bearer(expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken);
}

const setConfig = (key: ConfigKey, value: unknown) => configService.set({ key, value: value as never });

async function fillRequiredSettings() {
  await setConfig(ConfigKey.BUSINESS_LEGAL_NAME, 'Test Proprietor');
  await setConfig(ConfigKey.BUSINESS_TYPE, 'Sole Proprietorship');
  await setConfig(ConfigKey.BUSINESS_ADDRESS, 'Main Road, Kuraj, Rajasthan 313328');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_NAME, 'Test Proprietor');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_DESIGNATION, 'Proprietor & Grievance Officer');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'grievance@example.test');
}

/** A complete, publishable page using a few settings. */
const PAGE: InfoPageContent = {
  title: 'Privacy Policy',
  version: '2.0',
  effectiveDate: '2026-11-03',
  sections: [
    { heading: 'Who we are', blocks: [{ type: 'paragraph', text: '{{BUSINESS_TRADE_NAME}} is operated by {{BUSINESS_LEGAL_NAME}}.' }] },
    {
      heading: 'Contact',
      blocks: [{ type: 'bullets', items: ['Email: {{SUPPORT_EMAIL}}', 'WhatsApp: {{SUPPORT_WHATSAPP}}', 'Officer: {{GRIEVANCE_OFFICER_NAME}}'] }],
    },
  ],
};

const getPublic = async (slug: string, status = 200) => api().get(`/api/v1/legal/${slug}`).expect(status);
const publicPage = async (slug: string) => expectSuccess<InfoPageDto>((await getPublic(slug)).body).data;
const allText = (page: InfoPageDto) => JSON.stringify(page.sections);

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('public pages (guests and customers)', () => {
  it('before any publish: privacy and terms show the built-in wording; About has none; nothing is published automatically', async () => {
    const privacy = await publicPage('privacy');
    expect(privacy).toMatchObject({ slug: 'privacy', source: 'builtin', revision: 0, version: null });
    expect(privacy.sections.length).toBeGreaterThan(3);
    expect((await publicPage('terms')).source).toBe('builtin');
    expect(expectError((await getPublic('about', 404)).body).code).toBe(ErrorCode.NOT_FOUND);
    expect(expectError((await getPublic('cookies', 404)).body).code).toBe(ErrorCode.NOT_FOUND);
    expect(await prisma.contentDocument.count()).toBe(0);
  });

  it('never shows an invented contact: an empty setting leaves its lines out; a configured one shows at once', async () => {
    const before = allText(await publicPage('privacy'));
    expect(before).not.toContain('support@adione.in');
    expect(before).not.toContain('our support number');
    expect(before).not.toMatch(/\{\{|\}\}/);

    await setConfig(ConfigKey.SUPPORT_EMAIL, 'help@example.test');
    expect(allText(await publicPage('privacy'))).toContain('help@example.test');
  });

  it('works for a signed-in customer too, and the public HTML page escapes every value', async () => {
    await otpService.clearOtpState('9400000831');
    const customer = await loginAs('9400000831');
    await api().get('/api/v1/legal/terms').set('Authorization', bearer(customer.accessToken)).expect(200);

    // The built-in "who we are" line needs both the name and the address (or it is left out).
    await setConfig(ConfigKey.BUSINESS_TRADE_NAME, '<script>alert(1)</script>');
    await setConfig(ConfigKey.BUSINESS_ADDRESS, 'Main Road & "Market" <Kuraj>');
    const html = (await api().get('/api/v1/legal/privacy/page').expect(200)).text;
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Main Road &amp; &quot;Market&quot; &lt;Kuraj&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('admin access', () => {
  it('a customer, and staff without Configuration access, cannot read or change the pages', async () => {
    await otpService.clearOtpState('9400000832');
    const customer = bearer((await loginAs('9400000832')).accessToken);
    const staff = await adminToken(UserRole.STAFF);
    for (const auth of [customer, staff]) {
      expect((await api().get('/api/v1/admin/content/pages/privacy').set('Authorization', auth)).status).toBe(403);
      expect((await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', auth).send({ content: PAGE })).status).toBe(403);
      expect((await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', auth).send({ basedOnRevision: 0 })).status).toBe(403);
    }
    expect((await api().get('/api/v1/admin/content/pages/privacy')).status).toBe(401);
    expect(await prisma.contentDocument.count()).toBe(0);
  });

  it('an unknown page is rejected', async () => {
    const admin = await adminToken();
    expect((await api().get('/api/v1/admin/content/pages/cookies').set('Authorization', admin)).status).toBe(400);
  });
});

describe('editing, preview and publishing', () => {
  it('the editor offers the Aadione template (never published by itself) and lists the settings it uses', async () => {
    const admin = await adminToken();
    const dto = expectSuccess<AdminInfoPageDto>((await api().get('/api/v1/admin/content/pages/terms').set('Authorization', admin).expect(200)).body).data;
    expect(dto).toMatchObject({ slug: 'terms', published: null, draft: null, history: [] });
    expect(dto.template.title).toBe('Terms & Conditions');
    expect(validateInfoPage(dto.template).ok).toBe(true);
    expect(dto.settings.find((s) => s.token === 'GRIEVANCE_OFFICER_EMAIL')).toMatchObject({ required: true, filled: false });
    expect((await publicPage('terms')).source).toBe('builtin');
  });

  it('a draft is validated: an unknown setting is refused; HTML is kept as plain text, never markup', async () => {
    const admin = await adminToken();
    const bad = { ...PAGE, sections: [{ heading: 'X', blocks: [{ type: 'paragraph', text: 'Call {{CEO_PHONE}}' }] }] };
    const refused = await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: bad });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(expectError(refused.body))).toContain('CEO_PHONE');

    const html = { ...PAGE, sections: [{ heading: 'X', blocks: [{ type: 'paragraph', text: '<img src=x onerror=alert(1)>' }] }] };
    const saved = await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: html }).expect(200);
    expect(expectSuccess<AdminInfoPageDto>(saved.body).data.draft!.content.sections[0]!.blocks[0]).toEqual({ type: 'paragraph', text: '<img src=x onerror=alert(1)>' });
    expect((await publicPage('privacy')).source).toBe('builtin'); // a draft is never public
  });

  it('preview fills today\'s settings, leaves out empty ones and reports what is missing', async () => {
    const admin = await adminToken();
    await setConfig(ConfigKey.SUPPORT_EMAIL, 'help@example.test');
    const preview = expectSuccess<InfoPagePreviewDto>(
      (await api().post('/api/v1/admin/content/pages/privacy/preview').set('Authorization', admin).send({ content: PAGE }).expect(200)).body,
    ).data;
    // "Who we are" needs the (empty) legal name, so that whole section is left out.
    expect(preview.page.sections.map((s) => s.heading)).toEqual(['Contact']);
    expect(preview.page.sections[0]!.blocks[0]).toEqual({ type: 'bullets', items: ['Email: help@example.test'] });
    expect(preview.page.missing).toEqual(expect.arrayContaining(['SUPPORT_WHATSAPP', 'GRIEVANCE_OFFICER_NAME']));
    expect(preview.missingRequired).toEqual(expect.arrayContaining(['BUSINESS_LEGAL_NAME', 'GRIEVANCE_OFFICER_EMAIL']));
  });

  it('publishing refuses «TO CONFIRM» wording and, for a legal page, missing operator / grievance settings', async () => {
    const admin = await adminToken();
    const template = expectSuccess<AdminInfoPageDto>((await api().get('/api/v1/admin/content/pages/privacy').set('Authorization', admin)).body).data.template;
    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: template }).expect(200);
    await fillRequiredSettings();
    const unconfirmed = await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 });
    expect(unconfirmed.status).toBe(400);
    expect(expectError(unconfirmed.body).message).toMatch(/TO CONFIRM/);

    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: PAGE }).expect(200);
    await setConfig(ConfigKey.GRIEVANCE_OFFICER_EMAIL, '');
    const missing = await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 });
    expect(missing.status).toBe(400);
    expect(expectError(missing.body).message).toMatch(/Grievance Officer email/);
    expect((await publicPage('privacy')).source).toBe('builtin');
  });

  it('publish → customers get it at once (version, dates, structured + old-app lines); later setting changes show without republishing', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: PAGE }).expect(200);
    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 }).expect(200);

    const page = await publicPage('privacy');
    expect(page).toMatchObject({ source: 'published', revision: 1, version: '2.0', effectiveDate: '2026-11-03', title: 'Privacy Policy' });
    expect(page.sections[0]!.body).toEqual(['Aadione is operated by Test Proprietor.']);
    // No WhatsApp / email configured: those points are simply absent.
    expect(page.sections[1]!.body).toEqual(['• Officer: Test Proprietor']);

    await setConfig(ConfigKey.SUPPORT_WHATSAPP, '+91 98765 43210');
    expect((await publicPage('privacy')).sections[1]!.blocks[0]).toEqual({ type: 'bullets', items: ['WhatsApp: +91 98765 43210', 'Officer: Test Proprietor'] });

    const audit = await prisma.auditLog.findMany({ where: { entityType: 'ContentDocument' }, select: { action: true } });
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['content.draft.create', 'content.publish']));
  });

  it('About needs no legal settings; history keeps every revision and a restore goes through the draft', async () => {
    const admin = await adminToken();
    const about = { ...PAGE, title: 'About Aadione', version: '1.0', sections: [{ heading: 'What is Aadione?', blocks: [{ type: 'paragraph' as const, text: 'A local marketplace.' }] }] };
    const put = (content: InfoPageContent) => api().put('/api/v1/admin/content/pages/about/draft').set('Authorization', admin).send({ content }).expect(200);
    const publish = (basedOnRevision: number) => api().post('/api/v1/admin/content/pages/about/publish').set('Authorization', admin).send({ basedOnRevision });

    await put(about);
    await publish(0).expect(200);
    await put({ ...about, version: '1.1', sections: [{ heading: 'What is Aadione?', blocks: [{ type: 'paragraph', text: 'Second wording.' }] }] });
    // A stale screen (still showing revision 0) cannot overwrite revision 1.
    expect(expectError((await publish(0)).body).code).toBe(ErrorCode.CONTENT_CHANGED);
    const second = expectSuccess<AdminInfoPageDto>((await publish(1).expect(200)).body).data;
    expect(second.published).toMatchObject({ revision: 2, version: '1.1' });
    expect(second.history.map((h) => h.revision)).toEqual([1]);
    expect((await publicPage('about')).sections[0]!.body).toEqual(['Second wording.']);

    const restored = expectSuccess<AdminInfoPageDto>(
      (await api().post(`/api/v1/admin/content/pages/about/restore/${second.history[0]!.id}`).set('Authorization', admin).expect(200)).body,
    ).data;
    expect(restored.draft!.content.version).toBe('1.0');
    expect((await publicPage('about')).sections[0]!.body).toEqual(['Second wording.']); // not live until published
    await publish(2).expect(200);
    expect((await publicPage('about')).sections[0]!.body).toEqual(['A local marketplace.']);

    await put(about);
    const discarded = expectSuccess<AdminInfoPageDto>((await api().delete('/api/v1/admin/content/pages/about/draft').set('Authorization', admin).expect(200)).body).data;
    expect(discarded.draft).toBeNull();
  });
});

describe('settings validation (Admin Configuration)', () => {
  it('emails, phones and GSTIN must be well-formed or empty', async () => {
    const admin = await adminToken();
    const patch = (key: ConfigKey, value: unknown) => api().patch('/api/v1/admin/config').set('Authorization', admin).send({ key, value });
    expect((await patch(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'not-an-email')).status).toBe(400);
    expect((await patch(ConfigKey.SUPPORT_PHONE, 'call me')).status).toBe(400);
    expect((await patch(ConfigKey.STORE_GSTIN, 'GST123')).status).toBe(400);
    expect((await patch(ConfigKey.BUSINESS_ADDRESS, 'x'.repeat(501))).status).toBe(400);
    expect((await patch(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'grievance@example.test')).status).toBe(200);
    expect((await patch(ConfigKey.STORE_GSTIN, '08ABCDE1234F1Z5')).status).toBe(200);
    expect((await patch(ConfigKey.SUPPORT_PHONE, '')).status).toBe(200);
  });
});

describe('the shared rules', () => {
  it('a line using an empty setting is left out; an empty list or section disappears', () => {
    const page = resolveInfoPage(PAGE, { BUSINESS_TRADE_NAME: 'Aadione', BUSINESS_LEGAL_NAME: '' });
    expect(page.sections).toEqual([]);
    expect(page.missing).toEqual(expect.arrayContaining(['BUSINESS_LEGAL_NAME', 'SUPPORT_EMAIL']));
  });
});
