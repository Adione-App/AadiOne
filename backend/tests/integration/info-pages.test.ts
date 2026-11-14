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
 *     missing operator / customer-care / grievance-officer settings;
 *   - every revision is kept (history + restore) and audited;
 *   - Version and "Last updated" are the server's (revision number, publish
 *     date in India): a draft never moves them, a restore publishes a NEW
 *     version, and an earlier "takes effect" date is never shown;
 *   - the three pages are independent;
 *   - the website can read the public endpoints from another origin.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigKey,
  ErrorCode,
  UserRole,
  formatInfoPageDate,
  indiaDateOf,
  infoTextSegments,
  resolveInfoPage,
  validateInfoPage,
  type AdminInfoPageDto,
  type BusinessInfoDto,
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
  await setConfig(ConfigKey.SUPPORT_PHONE, '+91 90000 00001');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_NAME, 'Test Proprietor');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_DESIGNATION, 'Proprietor & Grievance Officer');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'grievance@example.test');
}

/** A complete, publishable page using a few settings. */
const PAGE: InfoPageContent = {
  title: 'Privacy Policy',
  effectiveDate: '',
  sections: [
    { heading: 'Who we are', blocks: [{ type: 'paragraph', text: '{{BUSINESS_TRADE_NAME}} is operated by {{BUSINESS_LEGAL_NAME}}.' }] },
    {
      heading: 'Contact',
      blocks: [{ type: 'bullets', items: ['Email: {{SUPPORT_EMAIL}}', 'WhatsApp: {{SUPPORT_WHATSAPP}}', 'Officer: {{GRIEVANCE_OFFICER_NAME}}'] }],
    },
  ],
};

const today = () => indiaDateOf(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
    expect(privacy).toMatchObject({ slug: 'privacy', source: 'builtin', revision: 0, version: null, effectiveDate: null, publishedAt: null });
    expect(privacy.lastUpdatedLabel).toBe('15 August 2026');
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

  it('the website can read the public endpoints from its own origin (no credentials); other routes keep the allow-list', async () => {
    const res = await api().get('/api/v1/legal/privacy').set('Origin', 'https://website.example').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const business = await api().get('/api/v1/legal/business').set('Origin', 'https://website.example').expect(200);
    expect(business.headers['access-control-allow-origin']).toBe('*');
    // Writing, or any other route, from an unknown origin is still refused.
    const other = await api().get('/api/v1/config/public').set('Origin', 'https://website.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('business details (GET /legal/business)', () => {
  it('every value comes from Configuration; an empty one is null, never substituted', async () => {
    const empty = expectSuccess<BusinessInfoDto>((await api().get('/api/v1/legal/business').expect(200)).body).data;
    expect(empty).toMatchObject({
      tradeName: 'Aadione',
      legalName: null,
      proprietorName: null,
      address: null,
      website: null,
      support: { email: null, phone: null, whatsapp: null, hours: null },
      grievanceOfficer: { name: null, email: null },
      socials: [],
    });

    await fillRequiredSettings();
    await setConfig(ConfigKey.BUSINESS_PROPRIETOR_NAME, 'Test Proprietor');
    await setConfig(ConfigKey.BUSINESS_WEBSITE, 'https://adione.example');
    await setConfig(ConfigKey.SOCIAL_INSTAGRAM_URL, 'https://instagram.com/aadione');
    const filled = expectSuccess<BusinessInfoDto>((await api().get('/api/v1/legal/business').expect(200)).body).data;
    expect(filled).toMatchObject({
      legalName: 'Test Proprietor',
      proprietorName: 'Test Proprietor',
      website: 'https://adione.example',
      support: { phone: '+91 90000 00001', email: null },
      // Its own address is empty, so the business address is shown.
      grievanceOfficer: { name: 'Test Proprietor', address: 'Main Road, Kuraj, Rajasthan 313328' },
      socials: [{ network: 'instagram', label: 'Instagram', url: 'https://instagram.com/aadione' }],
    });
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
    expect(dto).toMatchObject({ slug: 'terms', published: null, draft: null, history: [], nextVersion: 1, live: { source: 'builtin', version: null } });
    expect(dto.template.title).toBe('Terms & Conditions');
    expect(dto.template.effectiveDate).toBe('');
    expect(validateInfoPage(dto.template).ok).toBe(true);
    expect(dto.settings.find((s) => s.token === 'GRIEVANCE_OFFICER_EMAIL')).toMatchObject({ required: true, filled: false });
    expect(dto.missingRequired).toEqual(expect.arrayContaining(['Grievance Officer email', 'Support email or Support phone']));
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

  it('preview fills today\'s settings, leaves out empty ones, reports what is missing and shows the metadata a publish would give', async () => {
    const admin = await adminToken();
    await setConfig(ConfigKey.SUPPORT_EMAIL, 'help@example.test');
    const preview = expectSuccess<InfoPagePreviewDto>(
      (await api().post('/api/v1/admin/content/pages/privacy/preview').set('Authorization', admin).send({ content: PAGE }).expect(200)).body,
    ).data;
    // "Who we are" needs the (empty) legal name, so that whole section is left out.
    expect(preview.page.sections.map((s) => s.heading)).toEqual(['Contact']);
    expect(preview.page.sections[0]!.blocks[0]).toEqual({ type: 'bullets', items: ['Email: help@example.test'] });
    expect(preview.page.missing).toEqual(expect.arrayContaining(['SUPPORT_WHATSAPP', 'GRIEVANCE_OFFICER_NAME']));
    expect(preview.missingRequired).toEqual(expect.arrayContaining(['Legal name (as on PAN / GST)', 'Grievance Officer email']));
    // The support email meets the customer-care requirement.
    expect(preview.missingRequired.join()).not.toMatch(/Support email/);
    expect(preview.onPublish).toEqual({ version: '1', lastUpdatedLabel: formatInfoPageDate(today()), effectiveLabel: null });
    expect(await prisma.contentDocument.count()).toBe(0); // preview stores nothing
  });

  it('publishing refuses «TO CONFIRM» wording and, for a legal page, missing operator / customer-care / grievance settings', async () => {
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

    await setConfig(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'grievance@example.test');
    await setConfig(ConfigKey.SUPPORT_PHONE, '');
    const noSupport = await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 });
    expect(noSupport.status).toBe(400);
    expect(expectError(noSupport.body).message).toMatch(/Support email or Support phone/);
    expect((await publicPage('privacy')).source).toBe('builtin');
  });

  it('publish → customers get it at once with the server\'s version and date; later setting changes show without republishing', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: PAGE }).expect(200);
    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 }).expect(200);

    const page = await publicPage('privacy');
    expect(page).toMatchObject({
      source: 'published',
      revision: 1,
      version: '1',
      updatedAt: today(),
      lastUpdatedLabel: formatInfoPageDate(today()),
      effectiveDate: null,
      effectiveLabel: null,
      title: 'Privacy Policy',
    });
    expect(Date.parse(page.publishedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(page.sections.map((s) => s.id)).toEqual(['who-we-are', 'contact']);
    expect(page.sections[0]!.body).toEqual(['Aadione is operated by Test Proprietor.']);
    // No WhatsApp / email configured: those points are simply absent.
    expect(page.sections[1]!.body).toEqual(['• Officer: Test Proprietor']);

    await setConfig(ConfigKey.SUPPORT_WHATSAPP, '+91 98765 43210');
    expect((await publicPage('privacy')).sections[1]!.blocks[0]).toEqual({ type: 'bullets', items: ['WhatsApp: +91 98765 43210', 'Officer: Test Proprietor'] });

    const html = (await api().get('/api/v1/legal/privacy/page').expect(200)).text;
    expect(html).toContain(`Last updated ${formatInfoPageDate(today())} · Version 1`);
    expect(html).toContain('<a href="tel:+919000000001">+91 90000 00001</a>');

    const audit = await prisma.auditLog.findMany({ where: { entityType: 'ContentDocument' }, select: { action: true, after: true } });
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['content.draft.create', 'content.publish']));
    expect(audit.find((row) => row.action === 'content.publish')!.after).toMatchObject({ revision: 1, version: '1', lastUpdated: today() });
  });

  it('saving a draft never moves the public page or its "Last updated" date', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: PAGE }).expect(200);
    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 }).expect(200);
    const before = await publicPage('privacy');

    await api()
      .put('/api/v1/admin/content/pages/privacy/draft')
      .set('Authorization', admin)
      .send({ content: { ...PAGE, sections: [{ heading: 'Draft only', blocks: [{ type: 'paragraph', text: 'Not public yet.' }] }] } })
      .expect(200);
    await cache.clear();
    const after = await publicPage('privacy');
    expect(after).toEqual(before);
    expect(allText(after)).not.toContain('Not public yet');
  });

  it('a later "takes effect" date is shown; an earlier one is dropped (never backdated); too far ahead is refused', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    const put = (effectiveDate: string) =>
      api().put('/api/v1/admin/content/pages/terms/draft').set('Authorization', admin).send({ content: { ...PAGE, title: 'Terms & Conditions', effectiveDate } }).expect(200);
    const publish = (basedOnRevision: number) => api().post('/api/v1/admin/content/pages/terms/publish').set('Authorization', admin).send({ basedOnRevision });

    const future = addDays(today(), 30);
    await put(future);
    await publish(0).expect(200);
    expect(await publicPage('terms')).toMatchObject({ version: '1', effectiveDate: future, effectiveLabel: formatInfoPageDate(future), lastUpdatedLabel: formatInfoPageDate(today()) });

    await put('2020-01-01');
    await publish(1).expect(200);
    expect(await publicPage('terms')).toMatchObject({ version: '2', effectiveDate: null, effectiveLabel: null, updatedAt: today() });
    const stored = await prisma.contentDocument.findFirst({ where: { key: 'legal_terms', status: 'PUBLISHED' } });
    expect((stored!.content as { effectiveDate: string }).effectiveDate).toBe('');

    await put(addDays(today(), 800));
    expect((await publish(2)).status).toBe(400);
  });

  it('About needs no legal settings; history keeps every publication and a restore publishes a NEW version', async () => {
    const admin = await adminToken();
    const about: InfoPageContent = { ...PAGE, title: 'About Aadione', sections: [{ heading: 'What is Aadione?', blocks: [{ type: 'paragraph', text: 'A local marketplace.' }] }] };
    const put = (content: InfoPageContent) => api().put('/api/v1/admin/content/pages/about/draft').set('Authorization', admin).send({ content }).expect(200);
    const publish = (basedOnRevision: number) => api().post('/api/v1/admin/content/pages/about/publish').set('Authorization', admin).send({ basedOnRevision });

    await put(about);
    await publish(0).expect(200);
    await put({ ...about, sections: [{ heading: 'What is Aadione?', blocks: [{ type: 'paragraph', text: 'Second wording.' }] }] });
    // A stale screen (still showing revision 0) cannot overwrite revision 1.
    expect(expectError((await publish(0)).body).code).toBe(ErrorCode.CONTENT_CHANGED);
    const second = expectSuccess<AdminInfoPageDto>((await publish(1).expect(200)).body).data;
    expect(second.published).toMatchObject({ revision: 2, version: '2', restoredFromVersion: null });
    expect(second.history.map((h) => h.revision)).toEqual([1]);
    const firstPublishedAt = second.history[0]!.publishedAt;
    expect((await publicPage('about')).sections[0]!.body).toEqual(['Second wording.']);

    const restored = expectSuccess<AdminInfoPageDto>(
      (await api().post(`/api/v1/admin/content/pages/about/restore/${second.history[0]!.id}`).set('Authorization', admin).expect(200)).body,
    ).data;
    expect(restored.draft!.content).toMatchObject({ restoredFromVersion: 1, effectiveDate: '' });
    expect(restored.nextVersion).toBe(3);
    expect((await publicPage('about')).sections[0]!.body).toEqual(['Second wording.']); // not live until published
    const third = expectSuccess<AdminInfoPageDto>((await publish(2).expect(200)).body).data;
    expect(third.published).toMatchObject({ revision: 3, version: '3', restoredFromVersion: 1 });
    // The earlier publications keep their own dates.
    expect(third.history.map((h) => h.revision)).toEqual([2, 1]);
    expect(third.history[1]!.publishedAt).toBe(firstPublishedAt);
    expect(await publicPage('about')).toMatchObject({ version: '3', sections: [expect.objectContaining({ body: ['A local marketplace.'] })] });

    await put(about);
    const discarded = expectSuccess<AdminInfoPageDto>((await api().delete('/api/v1/admin/content/pages/about/draft').set('Authorization', admin).expect(200)).body).data;
    expect(discarded.draft).toBeNull();
    expect(discarded.published!.revision).toBe(3);
  });

  it('the three pages are independent: publishing one never publishes or changes the others', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: PAGE }).expect(200);
    await api().put('/api/v1/admin/content/pages/terms/draft').set('Authorization', admin).send({ content: { ...PAGE, title: 'Terms & Conditions' } }).expect(200);
    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 }).expect(200);

    expect((await publicPage('privacy')).source).toBe('published');
    expect((await publicPage('terms')).source).toBe('builtin');
    await getPublic('about', 404);
    const terms = expectSuccess<AdminInfoPageDto>((await api().get('/api/v1/admin/content/pages/terms').set('Authorization', admin)).body).data;
    expect(terms).toMatchObject({ published: null, nextVersion: 1 });
    expect(terms.draft).not.toBeNull();
  });
});

describe('settings validation (Admin Configuration)', () => {
  it('emails, phones, GSTIN and web addresses must be well-formed or empty', async () => {
    const admin = await adminToken();
    const patch = (key: ConfigKey, value: unknown) => api().patch('/api/v1/admin/config').set('Authorization', admin).send({ key, value });
    expect((await patch(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'not-an-email')).status).toBe(400);
    expect((await patch(ConfigKey.SUPPORT_PHONE, 'call me')).status).toBe(400);
    expect((await patch(ConfigKey.STORE_GSTIN, 'GST123')).status).toBe(400);
    expect((await patch(ConfigKey.BUSINESS_ADDRESS, 'x'.repeat(501))).status).toBe(400);
    expect((await patch(ConfigKey.BUSINESS_WEBSITE, 'javascript:alert(1)')).status).toBe(400);
    expect((await patch(ConfigKey.BUSINESS_WEBSITE, 'http://adione.example')).status).toBe(400);
    expect((await patch(ConfigKey.SOCIAL_INSTAGRAM_URL, 'https://evil.example/aadione')).status).toBe(400);
    expect((await patch(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'grievance@example.test')).status).toBe(200);
    expect((await patch(ConfigKey.STORE_GSTIN, '08ABCDE1234F1Z5')).status).toBe(200);
    expect((await patch(ConfigKey.SUPPORT_PHONE, '')).status).toBe(200);
    expect((await patch(ConfigKey.BUSINESS_WEBSITE, 'https://adione.example')).status).toBe(200);
    expect((await patch(ConfigKey.SOCIAL_INSTAGRAM_URL, 'https://www.instagram.com/aadione')).status).toBe(200);
    expect((await patch(ConfigKey.BUSINESS_PROPRIETOR_NAME, 'Test Proprietor')).status).toBe(200);
  });
});

describe('the shared rules', () => {
  it('a line using an empty setting is left out; an empty list or section disappears', () => {
    const page = resolveInfoPage(PAGE, { BUSINESS_TRADE_NAME: 'Aadione', BUSINESS_LEGAL_NAME: '' });
    expect(page.sections).toEqual([]);
    expect(page.missing).toEqual(expect.arrayContaining(['BUSINESS_LEGAL_NAME', 'SUPPORT_EMAIL']));
  });

  it('dates are India calendar days, written the same way everywhere', () => {
    expect(indiaDateOf('2026-11-06T18:29:59Z')).toBe('2026-11-06');
    expect(indiaDateOf('2026-11-06T18:30:00Z')).toBe('2026-11-07');
    expect(formatInfoPageDate('2026-11-07')).toBe('7 November 2026');
    expect(formatInfoPageDate('2027-01-01')).toBe('1 January 2027');
    expect(formatInfoPageDate('2026-02-30')).toBe('');
  });

  it('only email, web and phone links are made, and nothing typed becomes another kind of link', () => {
    expect(infoTextSegments('Write to help@example.test or call +91 97760 29985.')).toEqual([
      { text: 'Write to ' },
      { text: 'help@example.test', href: 'mailto:help@example.test' },
      { text: ' or call ' },
      { text: '+91 97760 29985', href: 'tel:+919776029985' },
      { text: '.' },
    ]);
    expect(infoTextSegments('Visit https://adione.example/help.')).toEqual([
      { text: 'Visit ' },
      { text: 'https://adione.example/help', href: 'https://adione.example/help' },
      { text: '.' },
    ]);
    expect(infoTextSegments('javascript:alert(1) and order 123456789012')).toEqual([{ text: 'javascript:alert(1) and order 123456789012' }]);
  });
});

/* -------------------------------------------------------------------------- */
/* The document editor's formatting                                            */
/* -------------------------------------------------------------------------- */

describe('formatted text from the document editor', () => {
  /** What the editor sends: sub-headings, a numbered list, bold / italic / underline and a link. */
  const FORMATTED: InfoPageContent = {
    title: 'Privacy Policy',
    effectiveDate: '',
    sections: [
      {
        heading: 'Who we are',
        blocks: [
          {
            type: 'paragraph',
            text: '{{BUSINESS_TRADE_NAME}} is run by {{BUSINESS_LEGAL_NAME}}. Read our terms.',
            runs: [
              { text: '{{BUSINESS_TRADE_NAME}}', bold: true },
              { text: ' is run by ' },
              { text: '{{BUSINESS_LEGAL_NAME}}', italic: true },
              { text: '. Read ' },
              { text: 'our terms', underline: true, href: 'https://adione.in/terms-and-conditions' },
              { text: '.' },
            ],
          },
          { type: 'subheading', level: 2, text: 'Complaints <b>&</b> grievances' },
          { type: 'numbered', items: ['Write to the officer', 'We reply in 48 hours'], itemRuns: [[{ text: 'Write', bold: true }, { text: ' to the officer' }], [{ text: 'We reply in 48 hours' }]] },
          { type: 'subheading', level: 3, text: 'Escalation' },
          { type: 'bullets', items: ['Officer: {{GRIEVANCE_OFFICER_NAME}}'] },
        ],
      },
    ],
  };

  it('saves, reloads with every format intact, publishes, and serves rich + plain forms; the HTML page draws it safely', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    const saved = await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: FORMATTED }).expect(200);
    expect(expectSuccess<AdminInfoPageDto>(saved.body).data.draft!.content).toEqual(FORMATTED);
    // A fresh read (as after a reload) returns the same document.
    const reloaded = await api().get('/api/v1/admin/content/pages/privacy').set('Authorization', admin).expect(200);
    expect(expectSuccess<AdminInfoPageDto>(reloaded.body).data.draft!.content).toEqual(FORMATTED);

    // Preview fills the settings inside the formatted pieces.
    const preview = expectSuccess<InfoPagePreviewDto>(
      (await api().post('/api/v1/admin/content/pages/privacy/preview').set('Authorization', admin).send({ content: FORMATTED }).expect(200)).body,
    ).data;
    expect((preview.page.sections[0]!.blocks[0] as { runs: unknown[] }).runs.slice(0, 3)).toEqual([{ text: 'Aadione', bold: true }, { text: ' is run by ' }, { text: 'Test Proprietor', italic: true }]);

    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 }).expect(200);
    const page = await publicPage('privacy');
    const [section] = page.sections;
    expect(section!.id).toBe('who-we-are');
    expect(section!.rich![2]).toEqual(FORMATTED.sections[0]!.blocks[2]);
    // Released app versions read `blocks`: plain paragraphs and bullets only, nothing lost.
    expect(section!.blocks).toEqual([
      { type: 'paragraph', text: 'Aadione is run by Test Proprietor. Read our terms (https://adione.in/terms-and-conditions).' },
      { type: 'paragraph', text: 'Complaints <b>&</b> grievances' },
      { type: 'paragraph', text: '1. Write to the officer' },
      { type: 'paragraph', text: '2. We reply in 48 hours' },
      { type: 'paragraph', text: 'Escalation' },
      { type: 'bullets', items: ['Officer: Test Proprietor'] },
    ]);
    expect(section!.body[2]).toBe('1. Write to the officer');

    const html = (await api().get('/api/v1/legal/privacy/page').expect(200)).text;
    expect(html).toContain('<strong>Aadione</strong> is run by <em>Test Proprietor</em>');
    expect(html).toContain('<a href="https://adione.in/terms-and-conditions" rel="noopener noreferrer"><u>our terms</u></a>');
    expect(html).toContain('<h3>Complaints &lt;b&gt;&amp;&lt;/b&gt; grievances</h3>');
    expect(html).toContain('<ol><li><strong>Write</strong> to the officer</li><li>We reply in 48 hours</li></ol>');
    expect(html).toContain('<h4>Escalation</h4>');
    expect(html).not.toContain('<b>');
  });

  it('refuses a link that is not a web address, email or phone — nothing is stored', async () => {
    const admin = await adminToken();
    const bad = structuredClone(FORMATTED);
    (bad.sections[0]!.blocks[0] as { runs: { href?: string }[] }).runs[4]!.href = 'javascript:alert(document.cookie)';
    const refused = await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: bad });
    expect(refused.status).toBe(400);
    expect(expectError(refused.body).message).toMatch(/link must be a web address/);
    expect(await prisma.contentDocument.count()).toBe(0);
  });

  it('an earlier plain version stays exactly as published after a formatted version replaces it', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: PAGE }).expect(200);
    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 0 }).expect(200);
    const before = expectSuccess<InfoPageDto>((await api().get('/api/v1/legal/privacy/versions/1').expect(200)).body).data;

    await api().put('/api/v1/admin/content/pages/privacy/draft').set('Authorization', admin).send({ content: FORMATTED }).expect(200);
    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 1 }).expect(200);

    const after = expectSuccess<InfoPageDto>((await api().get('/api/v1/legal/privacy/versions/1').expect(200)).body).data;
    expect(after.sections).toEqual(before.sections);
    expect(after.sections[0]!.rich).toEqual(after.sections[0]!.blocks); // plain text: both forms the same
    expect(after.isLatest).toBe(false);
    expect((await publicPage('privacy')).version).toBe('2');
    // Restoring the plain version brings back exactly its text.
    const history = expectSuccess<AdminInfoPageDto>((await api().get('/api/v1/admin/content/pages/privacy').set('Authorization', admin).expect(200)).body).data.history;
    const restored = await api().post(`/api/v1/admin/content/pages/privacy/restore/${history[0]!.id}`).set('Authorization', admin).send({}).expect(200);
    expect(expectSuccess<AdminInfoPageDto>(restored.body).data.draft!.content.sections).toEqual(PAGE.sections);
  });
});
