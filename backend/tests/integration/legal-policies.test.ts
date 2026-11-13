/**
 * Legal & Policies — the documents added to the information pages (Refund &
 * Cancellation, Shipping & Delivery, Cookie, Seller Terms, Seller Privacy),
 * public version history, GET /legal/pages, and sellers' acceptance of the
 * Seller Terms / Seller Privacy Policy (legal_acceptances).
 *
 *   - every Aadione template is a valid page that cannot be published until
 *     its «TO CONFIRM» decisions are made;
 *   - a new document is not public until published, and the same publishing
 *     rules (operator, contact, grievance officer) apply to it;
 *   - every published version stays readable — the JSON and the public web
 *     page — after a newer one; an earlier one says so and is not indexed;
 *   - a public page links only to pages its readers can open: customer pages
 *     never link the seller documents, and nothing unpublished;
 *   - only the documents users accept can ask for acceptance;
 *   - sellers accept explicitly, per seller account, append-only; stale
 *     versions are refused; a correction does not ask again, a marked change
 *     does; applicants can accept too; customers' consent is untouched.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ConfigKey,
  ErrorCode,
  INFO_PAGE_SLUGS,
  SellerLifecycleStatus,
  UserRole,
  infoPageUnconfirmed,
  validateInfoPage,
  type InfoPageContent,
  type InfoPageDto,
  type InfoPageIndexEntryDto,
  type InfoPageSlug,
  type InfoPageVersionSummaryDto,
  type SellerLegalConsentStatusDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { INFO_PAGE_TEMPLATES } from '../../src/modules/legal/info-page-templates';

const PASSWORD = 'TestAdmin@123';
let seq = 0;

async function adminToken(): Promise<string> {
  const n = ++seq;
  const email = `legal-admin-${n}@adione.test`;
  await prisma.user.create({ data: { mobile: `9420000${String(n).padStart(3, '0')}`, email, fullName: 'Legal Admin', passwordHash: await hashPassword(PASSWORD), role: UserRole.ADMIN } });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: PASSWORD }).expect(200);
  return bearer(expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken);
}

const setConfig = (key: ConfigKey, value: unknown) => configService.set({ key, value: value as never });

async function fillRequiredSettings() {
  await setConfig(ConfigKey.BUSINESS_LEGAL_NAME, 'Test Proprietor');
  await setConfig(ConfigKey.BUSINESS_ADDRESS, 'Main Road, Kuraj, Rajasthan 313328');
  await setConfig(ConfigKey.SUPPORT_PHONE, '+91 90000 00001');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_NAME, 'Test Proprietor');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_DESIGNATION, 'Proprietor & Grievance Officer');
  await setConfig(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'grievance@example.test');
}

const page = (title: string, text: string): InfoPageContent => ({
  title,
  effectiveDate: '',
  sections: [{ heading: 'Section', blocks: [{ type: 'paragraph', text }] }],
});

async function publishPage(admin: string, slug: InfoPageSlug, content: InfoPageContent, basedOnRevision: number, requireAcceptance?: boolean) {
  await api().put(`/api/v1/admin/content/pages/${slug}/draft`).set('Authorization', admin).send({ content }).expect(200);
  return api()
    .post(`/api/v1/admin/content/pages/${slug}/publish`)
    .set('Authorization', admin)
    .send({ basedOnRevision, ...(requireAcceptance === undefined ? {} : { requireAcceptance }) });
}

async function seller(lifecycle: SellerLifecycleStatus = SellerLifecycleStatus.ACTIVE) {
  const n = ++seq;
  const mobile = `9430000${String(n).padStart(3, '0')}`;
  const fields =
    lifecycle === SellerLifecycleStatus.ACTIVE
      ? sellerLifecycleFields(ApprovalStatus.APPROVED)
      : { onboardingStatus: ApprovalStatus.PENDING, lifecycleStatus: lifecycle };
  const row = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Store ${n}`,
      addressLine: 'Station Road',
      city: 'Kuraj',
      state: 'Rajasthan',
      pincode: '313328',
      latitude: 25.1,
      longitude: 73.9,
      ...fields,
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: row.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: row.id, userId: user.id, auth: bearer((await loginAs(mobile)).accessToken) };
}

const consentOf = async (auth: string) =>
  expectSuccess<SellerLegalConsentStatusDto>((await api().get('/api/v1/seller/legal/consent').set('Authorization', auth).expect(200)).body).data;
const accept = (auth: string, termsVersion: number, privacyVersion: number) =>
  api().post('/api/v1/seller/legal/consent').set('Authorization', auth).send({ termsVersion, privacyVersion });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('templates', () => {
  it('every document has a valid Aadione template that cannot be published while «TO CONFIRM» decisions remain', () => {
    for (const slug of INFO_PAGE_SLUGS) {
      const checked = validateInfoPage(INFO_PAGE_TEMPLATES[slug]);
      expect(checked.ok, slug).toBe(true);
      // The Cookie Policy's only open question (cookies on adione.in) was answered from the live site.
      if (slug !== 'about' && slug !== 'cookie-policy') expect(infoPageUnconfirmed(INFO_PAGE_TEMPLATES[slug]).length, slug).toBeGreaterThan(0);
    }
    // The seller privacy template flags the Aadhaar question for legal review.
    expect(JSON.stringify(INFO_PAGE_TEMPLATES['seller-privacy'])).toMatch(/LEGAL REVIEW: when given, the full 12-digit number is stored/);
    // Facts, not promises: refund requests go through support; bank verification is a practice to confirm.
    expect(JSON.stringify(INFO_PAGE_TEMPLATES['refund-policy'])).toMatch(/Refund requests are made through our customer support team, not in the app/);
    expect(JSON.stringify(INFO_PAGE_TEMPLATES['seller-terms'])).toMatch(/TO CONFIRM: whether Aadione pays only after verifying that bank account/);
    expect(JSON.stringify(INFO_PAGE_TEMPLATES['seller-terms'])).not.toMatch(/Aadione pays only to a bank account it has verified/);
  });
});

describe('history is never rewritten', () => {
  it('a new version, a restore and a re-acceptance never change an earlier published text or the acceptances that point at it', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    for (const slug of ['privacy', 'terms', 'seller-terms', 'seller-privacy'] as const) {
      await publishPage(admin, slug, page(`${slug} title`, `${slug} version one.`), 0).then((r) => expect(r.status).toBe(200));
    }
    // A customer and a seller accept version 1.
    await otpService.clearOtpState('9450000001');
    const customer = bearer((await loginAs('9450000001')).accessToken);
    await api().post('/api/v1/legal/consent').set('Authorization', customer).send({ privacyVersion: 1, termsVersion: 1, source: 'ANDROID' }).expect(200);
    const s = await seller();
    await accept(s.auth, 1, 1).expect(200);

    const snapshot = async () =>
      (await prisma.contentDocument.findMany({ where: { status: { not: 'DRAFT' } }, orderBy: [{ key: 'asc' }, { revision: 'asc' }] })).map((row) => ({
        id: row.id,
        key: row.key,
        revision: row.revision,
        content: JSON.stringify(row.content),
        publishedAt: row.publishedAt?.toISOString(),
      }));
    const before = await snapshot();
    const consentsBefore = await prisma.legalConsent.findMany({ orderBy: { acceptedAt: 'asc' } });
    const acceptancesBefore = await prisma.legalAcceptance.findMany({ orderBy: { documentKey: 'asc' } });

    // Version 2 (marked "ask"), then the text of version 1 restored and published as version 3.
    await publishPage(admin, 'privacy', page('privacy title', 'privacy version two.'), 1, true).then((r) => expect(r.status).toBe(200));
    await publishPage(admin, 'seller-terms', page('seller-terms title', 'seller terms version two.'), 1, true).then((r) => expect(r.status).toBe(200));
    const v1 = before.find((row) => row.key === 'legal_privacy' && row.revision === 1)!;
    await api().post(`/api/v1/admin/content/pages/privacy/restore/${v1.id}`).set('Authorization', admin).expect(200);
    await api().post('/api/v1/admin/content/pages/privacy/publish').set('Authorization', admin).send({ basedOnRevision: 2, requireAcceptance: false }).expect(200);

    // Every earlier published row is byte-for-byte what it was (only PUBLISHED → ARCHIVED).
    const after = await snapshot();
    for (const row of before) {
      const now = after.find((r) => r.id === row.id)!;
      expect({ ...now }, `${row.key} v${row.revision}`).toEqual(row);
    }
    expect(after.filter((row) => row.key === 'legal_privacy').map((row) => row.revision)).toEqual([1, 2, 3]);
    // Acceptance records are untouched and still point at the text that was accepted.
    expect(await prisma.legalConsent.findMany({ orderBy: { acceptedAt: 'asc' } })).toEqual(consentsBefore);
    expect(await prisma.legalAcceptance.findMany({ orderBy: { documentKey: 'asc' } })).toEqual(acceptancesBefore);
    const accepted = await prisma.contentDocument.findUniqueOrThrow({ where: { id: consentsBefore[0]!.privacyDocumentId! } });
    expect(JSON.stringify(accepted.content)).toMatch(/privacy version one\./);
    expect((await api().get('/api/v1/legal/privacy/versions/1').expect(200)).body.data.sections[0].body).toEqual(['privacy version one.']);

    // Re-acceptance is asked of both (version 2 was marked); accepting adds rows, never edits old ones.
    const status = await api().get('/api/v1/legal/consent').set('Authorization', customer).expect(200);
    expect(status.body.data).toMatchObject({ required: true, privacyVersion: 3, accepted: { privacyVersion: 1 } });
    await api().post('/api/v1/legal/consent').set('Authorization', customer).send({ privacyVersion: 3, termsVersion: 1, source: 'ANDROID' }).expect(200);
    expect(await prisma.legalConsent.count()).toBe(2);
    expect((await consentOf(s.auth)).required).toBe(true);
    await accept(s.auth, 2, 1).expect(200);
    expect(await prisma.legalAcceptance.count()).toBe(3);
    expect(await prisma.legalAcceptance.findMany({ where: { id: { in: acceptancesBefore.map((a) => a.id) } }, orderBy: { documentKey: 'asc' } })).toEqual(acceptancesBefore);
  });
});

describe('new documents', () => {
  it('are not public until published, need the same settings, and then appear everywhere at once', async () => {
    const admin = await adminToken();
    expect((await api().get('/api/v1/legal/refund-policy')).status).toBe(404);
    const before = expectSuccess<InfoPageIndexEntryDto[]>((await api().get('/api/v1/legal/pages').expect(200)).body).data;
    expect(before.map((p) => `${p.slug}:${p.source}`)).toEqual(['privacy:builtin', 'terms:builtin']);

    // Operator / contact / grievance settings are required, as for the Privacy Policy.
    const refused = await publishPage(admin, 'refund-policy', page('Refund & Cancellation Policy', 'Refunds go to {{BUSINESS_LEGAL_NAME}}.'), 0);
    expectError(refused.body, ErrorCode.VALIDATION_ERROR);
    await fillRequiredSettings();
    await api().post('/api/v1/admin/content/pages/refund-policy/publish').set('Authorization', admin).send({ basedOnRevision: 0 }).expect(200);

    const pub = expectSuccess<InfoPageDto>((await api().get('/api/v1/legal/refund-policy').expect(200)).body).data;
    expect(pub).toMatchObject({ slug: 'refund-policy', version: '1', source: 'published' });
    expect(pub.sections[0]!.body).toEqual(['Refunds go to Test Proprietor.']);
    const after = expectSuccess<InfoPageIndexEntryDto[]>((await api().get('/api/v1/legal/pages').expect(200)).body).data;
    expect(after.find((p) => p.slug === 'refund-policy')).toMatchObject({ version: '1', audience: 'customer', source: 'published' });
  });

  it('only the documents users accept can ask for acceptance', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await publishPage(admin, 'shipping-policy', page('Shipping & Delivery Policy', 'We deliver.'), 0, true).then((r) => expect(r.status).toBe(200));
    const row = await prisma.contentDocument.findFirstOrThrow({ where: { key: 'legal_shipping_delivery', status: 'PUBLISHED' } });
    expect((row.content as { requiresAcceptance?: boolean }).requiresAcceptance).toBeUndefined();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'content.publish', entityId: row.id } });
    expect(audit.after).toMatchObject({ requiresAcceptance: false });
  });
});

describe('version history', () => {
  it('every published version stays readable; an earlier one says so and is not indexed', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await publishPage(admin, 'cookie-policy', page('Cookie Policy', 'Version one wording.'), 0).then((r) => expect(r.status).toBe(200));
    await publishPage(admin, 'cookie-policy', page('Cookie Policy', 'Version two wording.'), 1).then((r) => expect(r.status).toBe(200));

    const versions = expectSuccess<InfoPageVersionSummaryDto[]>((await api().get('/api/v1/legal/cookie-policy/versions').expect(200)).body).data;
    expect(versions.map((v) => [v.version, v.isLatest])).toEqual([
      ['2', true],
      ['1', false],
    ]);
    const v1 = expectSuccess<InfoPageDto>((await api().get('/api/v1/legal/cookie-policy/versions/1').expect(200)).body).data;
    expect(v1).toMatchObject({ version: '1', isLatest: false });
    expect(v1.sections[0]!.body).toEqual(['Version one wording.']);
    expect(expectSuccess<InfoPageDto>((await api().get('/api/v1/legal/cookie-policy').expect(200)).body).data.sections[0]!.body).toEqual(['Version two wording.']);

    const html = (await api().get('/api/v1/legal/cookie-policy/versions/1/page').expect(200)).text;
    expect(html).toMatch(/This is an earlier version \(version 1\)/);
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
    expect(html).toMatch(/href="\.\.\/\.\.\/\.\.\/cookie-policy\/page">Read the latest version/);

    for (const bad of ['3', '0', 'abc', '-1']) expect((await api().get(`/api/v1/legal/cookie-policy/versions/${bad}`)).status).toBe(404);
    expect((await api().get('/api/v1/legal/nope/versions')).status).toBe(404);
  });

  it('a public page links only to pages its readers can open — never the other audience\'s documents', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await publishPage(admin, 'seller-terms', page('Seller Terms & Conditions', 'Seller wording.'), 0).then((r) => expect(r.status).toBe(200));
    await publishPage(admin, 'refund-policy', page('Refund & Cancellation Policy', 'Refund wording.'), 0).then((r) => expect(r.status).toBe(200));

    const customer = (await api().get('/api/v1/legal/terms/page').expect(200)).text;
    expect(customer).toMatch(/href="\.\.\/refund-policy\/page"/);
    expect(customer).not.toMatch(/seller-terms|seller-privacy/); // seller docs are not for customers
    expect(customer).not.toMatch(/shipping-policy\/page/); // unpublished

    const sellerPage = (await api().get('/api/v1/legal/seller-terms/page').expect(200)).text;
    expect(sellerPage).not.toMatch(/refund-policy\/page|href="\.\.\/terms\/page"/);
  });
});

describe('seller acceptance', () => {
  it('asked only once BOTH seller documents are published; explicit, per seller, append-only', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    const s1 = await seller();
    expect(await consentOf(s1.auth)).toMatchObject({ required: false, termsVersion: null, privacyVersion: null });

    await publishPage(admin, 'seller-terms', page('Seller Terms & Conditions', 'Terms v1.'), 0).then((r) => expect(r.status).toBe(200));
    expect((await consentOf(s1.auth)).required).toBe(false); // privacy not published yet
    expectError((await accept(s1.auth, 1, 1)).body, ErrorCode.VALIDATION_ERROR);
    await publishPage(admin, 'seller-privacy', page('Seller Privacy Policy', 'Privacy v1.'), 0).then((r) => expect(r.status).toBe(200));
    expect(await consentOf(s1.auth)).toMatchObject({ required: true, termsVersion: 1, privacyVersion: 1, accepted: null });

    // A version that is not the published one is refused (reload first).
    expectError((await accept(s1.auth, 2, 1)).body, ErrorCode.CONTENT_CHANGED);
    const ok = expectSuccess<SellerLegalConsentStatusDto>((await accept(s1.auth, 1, 1).expect(200)).body).data;
    expect(ok).toMatchObject({ required: false, accepted: { termsVersion: 1, privacyVersion: 1 } });
    await accept(s1.auth, 1, 1).expect(200); // twice adds nothing
    const rows = await prisma.legalAcceptance.findMany({ where: { userId: s1.userId }, orderBy: { documentKey: 'asc' } });
    expect(rows.map((r) => [r.documentKey, r.revision, r.sellerId, r.source])).toEqual([
      ['legal_seller_privacy', 1, s1.id, 'WEB'],
      ['legal_seller_terms', 1, s1.id, 'WEB'],
    ]);

    // A correction published WITHOUT asking: nobody is asked again.
    await publishPage(admin, 'seller-terms', page('Seller Terms & Conditions', 'Terms v2 (typo fix).'), 1, false).then((r) => expect(r.status).toBe(200));
    expect(await consentOf(s1.auth)).toMatchObject({ required: false, termsVersion: 2 });
    // A significant change marked "ask to accept": asked again; the old acceptance stays.
    await publishPage(admin, 'seller-terms', page('Seller Terms & Conditions', 'Terms v3 (new commission rules).'), 2, true).then((r) => expect(r.status).toBe(200));
    expect(await consentOf(s1.auth)).toMatchObject({ required: true, termsVersion: 3, accepted: { termsVersion: 1 } });
    await accept(s1.auth, 3, 1).expect(200);
    expect(await prisma.legalAcceptance.count({ where: { userId: s1.userId } })).toBe(3);
    // The version accepted earlier is still readable.
    expect((await api().get('/api/v1/legal/seller-terms/versions/1').expect(200)).body.data.sections[0].body).toEqual(['Terms v1.']);

    // Another seller has not accepted anything.
    const s2 = await seller();
    expect((await consentOf(s2.auth)).required).toBe(true);
  });

  it('applicants can accept too; customers and admins cannot use the seller route; customer consent is untouched', async () => {
    const admin = await adminToken();
    await fillRequiredSettings();
    await publishPage(admin, 'seller-terms', page('Seller Terms & Conditions', 'Terms.'), 0).then((r) => expect(r.status).toBe(200));
    await publishPage(admin, 'seller-privacy', page('Seller Privacy Policy', 'Privacy.'), 0).then((r) => expect(r.status).toBe(200));

    const applicant = await seller(SellerLifecycleStatus.APPLICATION_PENDING);
    expect((await consentOf(applicant.auth)).required).toBe(true);
    await accept(applicant.auth, 1, 1).expect(200);
    // Other seller routes stay closed to an applicant.
    expect((await api().get('/api/v1/seller/products').set('Authorization', applicant.auth)).status).toBe(403);

    await otpService.clearOtpState('9440000001');
    const customer = bearer((await loginAs('9440000001')).accessToken);
    expect((await api().get('/api/v1/seller/legal/consent').set('Authorization', customer)).status).toBe(403);
    expect((await api().get('/api/v1/seller/legal/consent').set('Authorization', admin)).status).toBe(403);
    expect((await api().get('/api/v1/seller/legal/consent')).status).toBe(401);
    // Customers' consent depends only on the customer Privacy Policy and Terms (still unpublished).
    expect(expectSuccess<{ required: boolean }>((await api().get('/api/v1/legal/consent').set('Authorization', customer).expect(200)).body).data.required).toBe(false);
  });
});
