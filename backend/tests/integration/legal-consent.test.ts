/**
 * Privacy Policy / Terms acceptance (legal/legal-consent.service.ts).
 *
 *   - signing in records nothing; only an explicit POST /legal/consent does;
 *   - nothing to accept while either page is the built-in wording;
 *   - only the versions published at that moment can be accepted;
 *   - append-only history with the server's time; no duplicates;
 *   - a new version asks again only when the admin marked it so (the first
 *     publish always asks); About never asks;
 *   - signed-in customers only; guests and panel users cannot record;
 *   - the endpoint keeps the CORS allow-list (it is not a public read);
 *   - acceptance never gates anything: a customer who has not accepted (or
 *     chose "Not now") still browses, fills a cart and places an order, and
 *     ordering records no consent.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey, type InfoPageContent, type LegalConsentStatusDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { configureTestMerchantUpi, seedStore } from '../helpers/fixtures';
import { COD, listing, panelToken, placeOrder, seedSeller } from '../helpers/refund-fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const page = (title: string, text = 'Text.'): InfoPageContent => ({ title, effectiveDate: '', sections: [{ heading: 'H', blocks: [{ type: 'paragraph', text }] }] });

async function settings() {
  const set = (key: ConfigKey, value: string) => configService.set({ key, value: value as never });
  await set(ConfigKey.BUSINESS_LEGAL_NAME, 'Test Proprietor');
  await set(ConfigKey.BUSINESS_ADDRESS, 'Main Road, Kuraj');
  await set(ConfigKey.SUPPORT_PHONE, '+91 90000 00001');
  await set(ConfigKey.GRIEVANCE_OFFICER_NAME, 'Test Proprietor');
  await set(ConfigKey.GRIEVANCE_OFFICER_DESIGNATION, 'Proprietor');
  await set(ConfigKey.GRIEVANCE_OFFICER_EMAIL, 'grievance@example.test');
}

async function publish(admin: string, slug: 'privacy' | 'terms' | 'about', text: string, requireAcceptance?: boolean) {
  const title = { privacy: 'Privacy Policy', terms: 'Terms & Conditions', about: 'About Aadione' }[slug];
  await api().put(`/api/v1/admin/content/pages/${slug}/draft`).set('Authorization', admin).send({ content: page(title, text) }).expect(200);
  const current = await prisma.contentDocument.findFirst({ where: { key: { privacy: 'legal_privacy', terms: 'legal_terms', about: 'page_about' }[slug], status: 'PUBLISHED' } });
  await api()
    .post(`/api/v1/admin/content/pages/${slug}/publish`)
    .set('Authorization', admin)
    .send({ basedOnRevision: current?.revision ?? 0, ...(requireAcceptance === undefined ? {} : { requireAcceptance }) })
    .expect(200);
}

async function customer(mobile: string) {
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  return { ...session, auth: bearer(session.accessToken) };
}

const status = async (auth: string) => expectSuccess<LegalConsentStatusDto>((await api().get('/api/v1/legal/consent').set('Authorization', auth).expect(200)).body).data;
const accept = (auth: string, privacyVersion: number, termsVersion: number) =>
  api().post('/api/v1/legal/consent').set('Authorization', auth).send({ privacyVersion, termsVersion, source: 'ANDROID', appVersion: '1.1.3' });

let admin = '';
beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await settings();
  admin = bearer((await panelToken()).token);
});

describe('legal consent', () => {
  it('signing in records nothing, and nothing is asked while the pages are the built-in wording', async () => {
    const user = await customer('9400000931');
    expect(await status(user.auth)).toEqual({ required: false, privacyVersion: null, termsVersion: null, accepted: null });
    expect((await accept(user.auth, 1, 1)).status).toBe(400);
    await publish(admin, 'privacy', 'P1');
    expect((await status(user.auth)).required).toBe(false); // Terms still unpublished
    expect(await prisma.legalConsent.count()).toBe(0);
  });

  it('records an explicit acceptance of the published versions only, append-only, with the server time', async () => {
    const user = await customer('9400000932');
    await publish(admin, 'privacy', 'P1');
    await publish(admin, 'terms', 'T1');
    expect(await status(user.auth)).toMatchObject({ required: true, privacyVersion: 1, termsVersion: 1, accepted: null });

    expect(expectError((await accept(user.auth, 1, 2)).body).code).toBe('CONTENT_CHANGED');
    const before = Date.now();
    const accepted = expectSuccess<LegalConsentStatusDto>((await accept(user.auth, 1, 1).expect(200)).body).data;
    expect(accepted).toMatchObject({ required: false, accepted: { privacyVersion: 1, termsVersion: 1 } });
    await accept(user.auth, 1, 1).expect(200); // the same versions again: no second row
    const rows = await prisma.legalConsent.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ privacyVersion: 1, termsVersion: 1, source: 'ANDROID', appVersion: '1.1.3' });
    expect(rows[0]!.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0]!.privacyDocumentId).not.toBeNull();
    // No IP, device id or other personal data is stored.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['acceptedAt', 'appVersion', 'id', 'privacyDocumentId', 'privacyVersion', 'source', 'termsDocumentId', 'termsVersion', 'userId'].sort(),
    );
  });

  it('a correction does not ask again; a version marked "ask" does, and history is kept', async () => {
    const user = await customer('9400000933');
    await publish(admin, 'privacy', 'P1');
    await publish(admin, 'terms', 'T1');
    await accept(user.auth, 1, 1).expect(200);

    await publish(admin, 'terms', 'T2 typo fix'); // later publishes ask only when told to
    expect(await status(user.auth)).toMatchObject({ required: false, termsVersion: 2 });

    await publish(admin, 'privacy', 'P2 material change', true);
    expect(await status(user.auth)).toMatchObject({ required: true, privacyVersion: 2, termsVersion: 2 });
    await accept(user.auth, 2, 2).expect(200);
    expect(await prisma.legalConsent.count({ where: { userId: user.userId } })).toBe(2);
    expect((await status(user.auth)).required).toBe(false);

    // About never asks.
    await publish(admin, 'about', 'A1', true);
    const about = await prisma.contentDocument.findFirstOrThrow({ where: { key: 'page_about', status: 'PUBLISHED' } });
    expect((about.content as { requiresAcceptance?: boolean }).requiresAcceptance).toBeUndefined();
  });

  it('only signed-in customers; never a guest or a panel user; keeps the CORS allow-list', async () => {
    await publish(admin, 'privacy', 'P1');
    await publish(admin, 'terms', 'T1');
    expect((await api().get('/api/v1/legal/consent')).status).toBe(401);
    expect((await api().post('/api/v1/legal/consent').send({ privacyVersion: 1, termsVersion: 1, source: 'WEB' })).status).toBe(401);
    expect((await accept(admin, 1, 1)).status).toBe(403);
    const user = await customer('9400000934');
    expect((await api().get('/api/v1/legal/consent').set('Origin', 'https://not-allowed.example').set('Authorization', user.auth)).status).toBe(403);
    expect((await api().post('/api/v1/legal/consent').set('Authorization', user.auth).send({ privacyVersion: 1, termsVersion: 1, source: 'ANDROID', ip: '1.2.3.4' })).status).toBe(400);
  });

  it('ordering never waits for acceptance and records none: a customer who has not accepted places an order', async () => {
    await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
    await configService.set({ key: ConfigKey.COD_FIRST_ORDER_MAX_PAISE, value: 300_000 as never });
    await configureTestMerchantUpi();
    const storeId = await seedStore();
    const sellerListing = await listing(storeId, await seedSeller('Kirana', '9400000941'), 25_000);
    await publish(admin, 'privacy', 'P1');
    await publish(admin, 'terms', 'T1');

    // Guests read the catalogue and the published pages without any consent.
    expect((await api().get('/api/v1/legal/privacy')).status).toBe(200);
    const mobile = '9400000942';
    const before = await customer(mobile);
    expect(await status(before.auth)).toMatchObject({ required: true, accepted: null });

    const placed = await placeOrder(mobile, [{ listingId: sellerListing }], COD);
    expect(await prisma.order.count({ where: { id: placed.orderId } })).toBe(1);
    expect(await prisma.legalConsent.count()).toBe(0);
    expect(await status(bearer(placed.token))).toMatchObject({ required: true, accepted: null });
  });
});
