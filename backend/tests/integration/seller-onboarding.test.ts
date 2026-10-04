/**
 * Seller onboarding — the two-gate lifecycle (Seller.lifecycleStatus):
 *
 *   APPLICATION_PENDING --Gate 1 approve--> ONBOARDING_PENDING
 *                       --Gate 1 reject---> APPLICATION_REJECTED (terminal)
 *   ONBOARDING_PENDING / ONBOARDING_CHANGES_REQUIRED --submit--> ONBOARDING_PENDING_REVIEW
 *   ONBOARDING_PENDING_REVIEW --Gate 2 approve---------> ACTIVE
 *                             --Gate 2 request changes-> ONBOARDING_CHANGES_REQUIRED
 *                             --Gate 2 reject----------> ONBOARDING_REJECTED (terminal)
 *
 * End to end through the HTTP API: self-signup, both admin gates, the
 * seller's own onboarding data (profile, bank, location, PDF documents), the
 * submit/lock/resubmit loop, and the server-side gate that keeps every
 * operational Seller Panel route closed until the seller is ACTIVE.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  NotificationType,
  SellerLifecycleStatus,
  UserRole,
  type SellerLifecycleDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import { privateDocuments } from '../../src/infra/storage/private-documents';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { onboardingStatusFor } from '../../src/modules/sellers/seller-lifecycle-rules';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };
const SELLER_PASSWORD = 'Seller@Test123';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');

/** Operational Seller Panel reads — open to ACTIVE sellers only. */
const OPERATIONAL_READS = ['/orders', '/products', '/categories', '/earnings', '/settlements', '/activity'] as const;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: {
      mobile: '0000000001',
      email: ADMIN.email,
      fullName: 'Admin',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

/** Self-signup (POST /auth/seller/signup): an APPLICATION_PENDING seller. */
async function signupSeller(mobile: string, businessName: string): Promise<{ sellerId: string; token: string }> {
  const res = await api()
    .post('/api/v1/auth/seller/signup')
    .send({
      fullName: `${businessName} Owner`,
      mobile,
      email: `${mobile}@sellers.adione.test`,
      password: SELLER_PASSWORD,
      businessName,
      sellerType: 'GROCERY',
    })
    .expect(201);
  const data = expectSuccess<{ sellerId: string; lifecycleStatus: string; tokens: { accessToken: string } }>(res.body).data;
  expect(data.lifecycleStatus).toBe(SellerLifecycleStatus.APPLICATION_PENDING);
  return { sellerId: data.sellerId, token: data.tokens.accessToken };
}

/** A seller row in `status`, with an OWNER login — for the access matrix and
 * admin-created sellers (which start at ONBOARDING_PENDING: Gate 1 passed). */
async function seedSellerWithOwner(
  mobile: string,
  name: string,
  status: SellerLifecycleStatus = SellerLifecycleStatus.ONBOARDING_PENDING,
): Promise<{ sellerId: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      isPlatformOwned: false,
      addressLine: 'Test Address',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...sellerLifecycleFields(onboardingStatusFor(status)),
      lifecycleStatus: status,
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { sellerId: seller.id, token: (await loginAs(mobile)).accessToken };
}

function profileBody(overrides: Record<string, unknown> = {}) {
  return {
    businessName: 'QA Onboarding Business (DEV)',
    ownerFullName: 'QA Onboarding Owner (DEV)',
    ownerMobile: '9500000001',
    ownerEmail: 'owner@onboarding.adione.test',
    panNumber: 'ABCDE1234F',
    ...overrides,
  };
}

function bankBody(overrides: Record<string, unknown> = {}) {
  return {
    accountHolderName: 'QA Onboarding Owner (DEV)',
    accountNumber: '000123456789',
    ifscCode: 'HDFC0000001',
    ...overrides,
  };
}

const seller = (token: string) => ({
  get: (path: string) => api().get(`/api/v1/seller${path}`).set('Authorization', bearer(token)),
  put: (path: string, body: object) => api().put(`/api/v1/seller${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1/seller${path}`).set('Authorization', bearer(token)).send(body),
  submit: () => api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(token)),
  uploadPan: () =>
    api()
      .post('/api/v1/seller/onboarding/documents')
      .set('Authorization', bearer(token))
      .field('type', 'PAN_CARD')
      .field('documentNumber', 'ABCDE1234F')
      .attach('file', PDF, { filename: 'pan.pdf', contentType: 'application/pdf' }),
});

async function lifecycleOf(token: string): Promise<SellerLifecycleDto> {
  return expectSuccess<SellerLifecycleDto>((await seller(token).get('/lifecycle').expect(200)).body).data;
}

/** Everything the onboarding checklist needs for a GROCERY seller. */
async function completeOnboarding(token: string): Promise<void> {
  const s = seller(token);
  await s.put('/onboarding/profile', profileBody()).expect(200);
  await s.put('/onboarding/bank-detail', bankBody()).expect(200);
  await s
    .patch('/location', {
      latitude: 27.62,
      longitude: 75.14,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
    })
    .expect(200);
  await s.uploadPan().expect(201);
}

const gate1 = (adminToken: string, sellerId: string, body: object) =>
  api().patch(`/api/v1/admin/sellers/${sellerId}/application/review`).set('Authorization', bearer(adminToken)).send(body);

const gate2 = (adminToken: string, sellerId: string, body: object) =>
  api().patch(`/api/v1/admin/sellers/${sellerId}/verification/review`).set('Authorization', bearer(adminToken)).send(body);

async function lifecycleRow(sellerId: string) {
  return prisma.seller.findUniqueOrThrow({
    where: { id: sellerId },
    select: {
      lifecycleStatus: true,
      onboardingStatus: true,
      lifecycleReason: true,
      applicationSubmittedAt: true,
      onboardingSubmittedAt: true,
      activatedAt: true,
    },
  });
}

/** A ready seller that has submitted for Gate 2. */
async function submittedSeller(mobile: string, name: string) {
  const created = await seedSellerWithOwner(mobile, name);
  await completeOnboarding(created.token);
  await seller(created.token).submit().expect(200);
  return created;
}

function expectNotActive(res: { status: number; body: unknown }, label?: string) {
  expect(res.status, label).toBe(403);
  expect(expectError(res.body).code, label).toBe(ErrorCode.SELLER_ACCOUNT_NOT_ACTIVE);
}

/* -------------------------------------------------------------------------- */
/* Setup — documents go to an in-memory private store, never to disk          */
/* -------------------------------------------------------------------------- */

const storedDocuments = new Map<string, Buffer>();

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  storedDocuments.clear();
  vi.spyOn(privateDocuments, 'put').mockImplementation(async (key, body) => {
    storedDocuments.set(key, body);
  });
  vi.spyOn(privateDocuments, 'get').mockImplementation(async (key) => {
    const body = storedDocuments.get(key);
    if (!body) throw new Error(`no stored document ${key}`);
    return body;
  });
  vi.spyOn(privateDocuments, 'remove').mockImplementation(async (key) => {
    storedDocuments.delete(key);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Application Pending                                                        */
/* -------------------------------------------------------------------------- */

describe('Application Pending (self-signup)', () => {
  it('creates an APPLICATION_PENDING seller that can only see its own status', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await signupSeller('9500000101', 'Applicant Store');

    expect(await lifecycleRow(sellerId)).toMatchObject({
      lifecycleStatus: 'APPLICATION_PENDING',
      onboardingStatus: 'PENDING',
    });
    expect((await lifecycleRow(sellerId)).applicationSubmittedAt).not.toBeNull();

    const status = await lifecycleOf(token);
    expect(status).toMatchObject({
      sellerId,
      lifecycleStatus: 'APPLICATION_PENDING',
      panelUnlocked: false,
      canEditOnboarding: false,
      canSubmit: false,
    });

    // No onboarding before Gate 1 — not even a read.
    expectNotActive(await seller(token).get('/onboarding'));
    expectNotActive(await seller(token).put('/onboarding/profile', profileBody()));

    // Admin's Gate 1 queue has it; admins were told about it.
    const queue = await api()
      .get('/api/v1/admin/sellers/applications?status=APPLICATION_PENDING')
      .set('Authorization', bearer(adminToken))
      .expect(200);
    const ids = expectSuccess<{ items: { sellerId: string }[] }>(queue.body).data.items.map((i) => i.sellerId);
    expect(ids).toEqual([sellerId]);
  });

  it('is strict: an applicant cannot set its own status (400, nothing created)', async () => {
    const res = await api().post('/api/v1/auth/seller/signup').send({
      fullName: 'Sneaky Owner',
      mobile: '9500000102',
      email: 'sneaky@sellers.adione.test',
      password: SELLER_PASSWORD,
      businessName: 'Sneaky Store',
      sellerType: 'GROCERY',
      lifecycleStatus: 'ACTIVE',
    });
    expect(res.status).toBe(400);
    expect(await prisma.seller.count()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 1                                                                     */
/* -------------------------------------------------------------------------- */

describe('Gate 1 — application review', () => {
  it('approve: the applicant moves to ONBOARDING_PENDING and may fill in its onboarding', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await signupSeller('9500000111', 'Approved Applicant');

    await gate1(adminToken, sellerId, { decision: 'APPROVE' }).expect(200);

    expect(await lifecycleRow(sellerId)).toMatchObject({ lifecycleStatus: 'ONBOARDING_PENDING', onboardingStatus: 'PENDING' });
    expect(await lifecycleOf(token)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_PENDING',
      panelUnlocked: false,
      canEditOnboarding: true,
    });
    await seller(token).get('/onboarding').expect(200);
    await seller(token).put('/onboarding/profile', profileBody()).expect(200);
    expect(await prisma.notification.count({ where: { type: NotificationType.SELLER_APPLICATION_APPROVED } })).toBe(1);

    // A decided application cannot be decided again.
    const again = await gate1(adminToken, sellerId, { decision: 'REJECT', reason: 'changed my mind' });
    expect(again.status).toBe(409);
    expect(expectError(again.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });

  it('reject: needs a reason, is terminal, and the applicant sees why', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await signupSeller('9500000112', 'Rejected Applicant');

    expect((await gate1(adminToken, sellerId, { decision: 'REJECT' })).status).toBe(400);
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('APPLICATION_PENDING');

    await gate1(adminToken, sellerId, { decision: 'REJECT', reason: 'Outside our service area' }).expect(200);

    expect(await lifecycleRow(sellerId)).toMatchObject({
      lifecycleStatus: 'APPLICATION_REJECTED',
      onboardingStatus: 'PENDING',
      lifecycleReason: 'Outside our service area',
    });
    expect(await lifecycleOf(token)).toMatchObject({
      lifecycleStatus: 'APPLICATION_REJECTED',
      reason: 'Outside our service area',
      canEditOnboarding: false,
    });
    expectNotActive(await seller(token).get('/onboarding'));
    expect(await prisma.notification.count({ where: { type: NotificationType.SELLER_APPLICATION_REJECTED } })).toBe(1);

    expect((await gate1(adminToken, sellerId, { decision: 'APPROVE' })).status).toBe(409);
  });

  it('applies only to an application: an admin-created seller (already past Gate 1) is 409', async () => {
    const adminToken = await loginAdmin();
    const { sellerId } = await seedSellerWithOwner('9500000113', 'Admin Created Seller');

    const res = await gate1(adminToken, sellerId, { decision: 'APPROVE' });
    expect(res.status).toBe(409);
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('ONBOARDING_PENDING');
  });
});

/* -------------------------------------------------------------------------- */
/* Onboarding Pending                                                         */
/* -------------------------------------------------------------------------- */

describe('Onboarding Pending — the seller fills in its own onboarding', () => {
  it('creates and updates its own profile and bank details (bank masked for the seller)', async () => {
    const { sellerId, token } = await seedSellerWithOwner('9500000121', 'Onboarding Seller A');

    const put1 = await seller(token).put('/onboarding/profile', profileBody()).expect(200);
    expect(expectSuccess<{ profile: { businessName: string } }>(put1.body).data.profile.businessName).toBe(
      'QA Onboarding Business (DEV)',
    );
    const put2 = await seller(token).put('/onboarding/profile', profileBody({ businessName: 'Renamed Business (DEV)' })).expect(200);
    expect(expectSuccess<{ profile: { businessName: string } }>(put2.body).data.profile.businessName).toBe(
      'Renamed Business (DEV)',
    );
    expect(await prisma.sellerProfile.count({ where: { sellerId } })).toBe(1);

    const bank = await seller(token).put('/onboarding/bank-detail', bankBody()).expect(200);
    const bankDto = expectSuccess<{ bankDetail: { accountNumber: string; isVerified: boolean } }>(bank.body).data.bankDetail;
    expect(bankDto.accountNumber).not.toBe('000123456789');
    expect(bankDto.accountNumber.endsWith('6789')).toBe(true);
    expect(bankDto.isVerified).toBe(false);
  });

  it('rejects an invalid IFSC code', async () => {
    const { token } = await seedSellerWithOwner('9500000122', 'Onboarding Seller Bad IFSC');
    expect((await seller(token).put('/onboarding/bank-detail', bankBody({ ifscCode: 'NOTVALID12' }))).status).toBe(400);
  });

  it("only ever sees its own onboarding data", async () => {
    const a = await seedSellerWithOwner('9500000123', 'Onboarding Seller A2');
    await seller(a.token).put('/onboarding/profile', profileBody()).expect(200);
    const b = await seedSellerWithOwner('9500000124', 'Onboarding Seller B2');

    // There is no seller id on the seller-facing route: B simply never sees A's data.
    const res = await seller(b.token).get('/onboarding').expect(200);
    expect(expectSuccess<{ profile: unknown }>(res.body).data.profile).toBeNull();
  });

  it('a customer cannot reach any seller route', async () => {
    await otpService.clearOtpState('9500000125');
    const customer = await loginAs('9500000125');

    const res = await api().get('/api/v1/seller/lifecycle').set('Authorization', bearer(customer.accessToken));
    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });

  it('uploads a PDF document, listed as PENDING', async () => {
    const { token } = await seedSellerWithOwner('9500000126', 'Onboarding Seller Docs');

    const res = await seller(token).uploadPan().expect(201);
    expect(expectSuccess<{ status: string; type: string }>(res.body).data).toMatchObject({ status: 'PENDING', type: 'PAN_CARD' });
    const list = await seller(token).get('/onboarding/documents').expect(200);
    expect(expectSuccess<unknown[]>(list.body).data).toHaveLength(1);
    expect(storedDocuments.size).toBe(1);
  });

  it('refuses to submit while the checklist is incomplete, naming what is missing', async () => {
    const { sellerId, token } = await seedSellerWithOwner('9500000127', 'Onboarding Seller Empty');

    const empty = await seller(token).submit();
    expect(empty.status).toBe(400);
    expect(expectError(empty.body).code).toBe(ErrorCode.VALIDATION_ERROR);

    // Everything but the PAN document.
    await seller(token).put('/onboarding/profile', profileBody()).expect(200);
    await seller(token).put('/onboarding/bank-detail', bankBody()).expect(200);
    const noDocument = await seller(token).submit();
    expect(noDocument.status).toBe(400);
    expect(JSON.stringify(noDocument.body)).toContain('panDocument');

    const status = await lifecycleOf(token);
    expect(status).toMatchObject({ lifecycleStatus: 'ONBOARDING_PENDING', canSubmit: false });
    expect(status.checklist.find((item) => item.key === 'panDocument')?.met).toBe(false);
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('ONBOARDING_PENDING');
  });
});

/* -------------------------------------------------------------------------- */
/* Submit for Review                                                          */
/* -------------------------------------------------------------------------- */

describe('Submit for Review', () => {
  it('moves a complete onboarding to ONBOARDING_PENDING_REVIEW, queues it for admin and locks it', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await seedSellerWithOwner('9500000131', 'Submitting Seller');
    await completeOnboarding(token);
    expect((await lifecycleOf(token)).canSubmit).toBe(true);

    const res = await seller(token).submit().expect(200);
    expect(expectSuccess<SellerLifecycleDto>(res.body).data).toMatchObject({
      lifecycleStatus: 'ONBOARDING_PENDING_REVIEW',
      canEditOnboarding: false,
      panelUnlocked: false,
    });
    const row = await lifecycleRow(sellerId);
    expect(row).toMatchObject({ lifecycleStatus: 'ONBOARDING_PENDING_REVIEW', onboardingStatus: 'PENDING' });
    expect(row.onboardingSubmittedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { type: NotificationType.ADMIN_ONBOARDING_SUBMITTED } })).toBe(1);

    const queue = await api().get('/api/v1/admin/sellers/onboarding?limit=50').set('Authorization', bearer(adminToken)).expect(200);
    expect(expectSuccess<{ items: { sellerId: string; stage: string }[] }>(queue.body).data.items).toEqual([
      expect.objectContaining({ sellerId, stage: 'SUBMITTED' }),
    ]);

    // Locked while under review: reads work, every onboarding write is refused.
    await seller(token).get('/onboarding').expect(200);
    for (const [label, res] of [
      ['profile', await seller(token).put('/onboarding/profile', profileBody({ businessName: 'Changed Under Review' }))],
      ['bank', await seller(token).put('/onboarding/bank-detail', bankBody())],
      ['location', await seller(token).patch('/location', { latitude: 27.6, longitude: 75.1 })],
      ['document', await seller(token).uploadPan()],
      ['resubmit', await seller(token).submit()],
    ] as const) {
      expectNotActive(res, label);
    }
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { sellerId } })).businessName).toBe(
      'QA Onboarding Business (DEV)',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 2 — Request Changes / Resubmit                                        */
/* -------------------------------------------------------------------------- */

describe('Gate 2 — request changes, then resubmit', () => {
  it('reopens the onboarding with a reason; only a resubmission can then be approved', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await submittedSeller('9500000141', 'Changes Seller');

    expect((await gate2(adminToken, sellerId, { decision: 'REQUEST_CHANGES' })).status).toBe(400);

    await gate2(adminToken, sellerId, { decision: 'REQUEST_CHANGES', reason: 'Upload a clearer PAN scan' }).expect(200);
    expect(await lifecycleRow(sellerId)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_CHANGES_REQUIRED',
      onboardingStatus: 'PENDING',
      lifecycleReason: 'Upload a clearer PAN scan',
    });
    expect(await lifecycleOf(token)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_CHANGES_REQUIRED',
      reason: 'Upload a clearer PAN scan',
      canEditOnboarding: true,
      canSubmit: true,
    });
    expect(await prisma.notification.count({ where: { type: NotificationType.SELLER_ONBOARDING_CHANGES_REQUESTED } })).toBe(1);

    // No shortcut: it is not under review any more.
    expect((await gate2(adminToken, sellerId, { decision: 'APPROVE' })).status).toBe(409);
    expectNotActive(await seller(token).get('/orders'));

    // The seller corrects and resubmits.
    await seller(token).uploadPan().expect(201);
    const resubmit = await seller(token).submit().expect(200);
    expect(expectSuccess<SellerLifecycleDto>(resubmit.body).data.lifecycleStatus).toBe('ONBOARDING_PENDING_REVIEW');
    expect((await lifecycleRow(sellerId)).lifecycleReason).toBeNull();

    await gate2(adminToken, sellerId, { decision: 'APPROVE' }).expect(200);
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('ACTIVE');
    // One "submitted" notice per review round.
    expect(await prisma.notification.count({ where: { type: NotificationType.ADMIN_ONBOARDING_SUBMITTED } })).toBe(2);
  });

  it('legacy PATCH .../onboarding/review: REJECTED means "request changes" (never terminal), APPROVED approves', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await submittedSeller('9500000142', 'Legacy Review Seller');
    const legacy = (body: object) =>
      api().patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`).set('Authorization', bearer(adminToken)).send(body);

    expect((await legacy({ status: 'REJECTED' })).status).toBe(400);
    await legacy({ status: 'REJECTED', reason: 'fix your PAN scan' }).expect(200);
    expect(await lifecycleRow(sellerId)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_CHANGES_REQUIRED',
      onboardingStatus: 'PENDING',
    });

    // Re-approval without a resubmission is refused.
    expect((await legacy({ status: 'APPROVED' })).status).toBe(409);

    await seller(token).submit().expect(200);
    const approve = await legacy({ status: 'APPROVED' }).expect(200);
    expect(expectSuccess<{ onboardingStatus: string; stage: string }>(approve.body).data).toMatchObject({
      onboardingStatus: 'APPROVED',
      stage: 'APPROVED',
    });
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('ACTIVE');
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 2 — Approve                                                           */
/* -------------------------------------------------------------------------- */

describe('Gate 2 — approve', () => {
  it('activates the seller: ACTIVE + onboardingStatus APPROVED, and the operational panel opens', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await submittedSeller('9500000151', 'Approved Seller');
    for (const path of OPERATIONAL_READS) expectNotActive(await seller(token).get(path), path);

    const res = await gate2(adminToken, sellerId, { decision: 'APPROVE' }).expect(200);
    expect(expectSuccess<{ lifecycleStatus: string }>(res.body).data.lifecycleStatus).toBe('ACTIVE');

    const row = await lifecycleRow(sellerId);
    expect(row).toMatchObject({ lifecycleStatus: 'ACTIVE', onboardingStatus: 'APPROVED', lifecycleReason: null });
    expect(row.activatedAt).not.toBeNull();
    expect(await lifecycleOf(token)).toMatchObject({ lifecycleStatus: 'ACTIVE', panelUnlocked: true });
    expect(await prisma.notification.count({ where: { type: NotificationType.SELLER_ONBOARDING_APPROVED } })).toBe(1);

    for (const path of OPERATIONAL_READS) {
      expect((await seller(token).get(path)).status, path).toBe(200);
    }

    // Decided: no second decision, no resubmission.
    const dup = await gate2(adminToken, sellerId, { decision: 'APPROVE' });
    expect(dup.status).toBe(409);
    expect(expectError(dup.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    const resubmit = await seller(token).submit();
    expect(resubmit.status).toBe(409);
    expect(expectError(resubmit.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });

  it('refuses to approve an incomplete onboarding even when it is under review', async () => {
    const adminToken = await loginAdmin();
    const { sellerId } = await seedSellerWithOwner(
      '9500000152',
      'Incomplete Under Review',
      SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW,
    );

    const res = await gate2(adminToken, sellerId, { decision: 'APPROVE' });
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await lifecycleRow(sellerId)).toMatchObject({ lifecycleStatus: 'ONBOARDING_PENDING_REVIEW', onboardingStatus: 'PENDING' });
  });

  it('refuses a seller that has not submitted (ONBOARDING_PENDING) — 409', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await seedSellerWithOwner('9500000153', 'Not Submitted Seller');
    await completeOnboarding(token);

    expect((await gate2(adminToken, sellerId, { decision: 'APPROVE' })).status).toBe(409);
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('ONBOARDING_PENDING');
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 2 — Reject                                                            */
/* -------------------------------------------------------------------------- */

describe('Gate 2 — reject', () => {
  it('needs a reason, is terminal, and keeps the seller out of the operational panel', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await submittedSeller('9500000161', 'Rejected Seller');

    expect((await gate2(adminToken, sellerId, { decision: 'REJECT' })).status).toBe(400);
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('ONBOARDING_PENDING_REVIEW');

    await gate2(adminToken, sellerId, { decision: 'REJECT', reason: 'Documents do not match the business' }).expect(200);
    expect(await lifecycleRow(sellerId)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_REJECTED',
      onboardingStatus: 'REJECTED',
      lifecycleReason: 'Documents do not match the business',
    });
    expect(await lifecycleOf(token)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_REJECTED',
      reason: 'Documents do not match the business',
      canEditOnboarding: false,
      panelUnlocked: false,
    });
    expect(await prisma.notification.count({ where: { type: NotificationType.SELLER_ONBOARDING_REJECTED } })).toBe(1);

    // Terminal: it can read its record, but cannot change or resubmit it, and
    // admin cannot approve it.
    await seller(token).get('/onboarding').expect(200);
    expectNotActive(await seller(token).put('/onboarding/profile', profileBody()));
    expectNotActive(await seller(token).submit());
    expectNotActive(await seller(token).get('/orders'));
    expect((await gate2(adminToken, sellerId, { decision: 'APPROVE' })).status).toBe(409);
  });
});

/* -------------------------------------------------------------------------- */
/* Access: ACTIVE vs every pre-active state                                   */
/* -------------------------------------------------------------------------- */

describe('Seller Panel access by lifecycle state', () => {
  const PRE_ACTIVE: SellerLifecycleStatus[] = [
    SellerLifecycleStatus.APPLICATION_PENDING,
    SellerLifecycleStatus.APPLICATION_REJECTED,
    SellerLifecycleStatus.ONBOARDING_PENDING,
    SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW,
    SellerLifecycleStatus.ONBOARDING_CHANGES_REQUIRED,
    SellerLifecycleStatus.ONBOARDING_REJECTED,
  ];

  it('blocks every operational route before ACTIVE — reads and writes — while /lifecycle always answers', async () => {
    let n = 0;
    for (const status of PRE_ACTIVE) {
      const { token } = await seedSellerWithOwner(`95000002${String(n++).padStart(2, '0')}`, `Pre-active ${status}`, status);

      expect((await lifecycleOf(token)).lifecycleStatus).toBe(status);
      for (const path of OPERATIONAL_READS) expectNotActive(await seller(token).get(path), `${status} GET ${path}`);
      expectNotActive(
        await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send({ name: 'Sneaky Product' }),
        `${status} POST /products`,
      );
      expectNotActive(await seller(token).patch('/availability', { isAcceptingOrders: false }), `${status} PATCH /availability`);
    }
  });

  it('opens every operational route to an ACTIVE seller', async () => {
    const { token } = await seedSellerWithOwner('9500000251', 'Active Seller', SellerLifecycleStatus.ACTIVE);

    expect(await lifecycleOf(token)).toMatchObject({ lifecycleStatus: 'ACTIVE', panelUnlocked: true });
    for (const path of OPERATIONAL_READS) {
      expect((await seller(token).get(path)).status, path).toBe(200);
    }
    // ACTIVE sellers keep their own onboarding area (bank details, documents, location).
    await seller(token).get('/onboarding').expect(200);
    await seller(token).put('/onboarding/bank-detail', bankBody()).expect(200);
  });
});

/* -------------------------------------------------------------------------- */
/* Admin-only review endpoints                                                */
/* -------------------------------------------------------------------------- */

describe('admin review endpoints', () => {
  it('reviews an individual document; the admin review view shows the bank account unmasked', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await seedSellerWithOwner('9500000171', 'Doc Review Seller');
    await seller(token).put('/onboarding/bank-detail', bankBody()).expect(200);
    const documentId = expectSuccess<{ id: string }>((await seller(token).uploadPan().expect(201)).body).data.id;

    const detail = await api().get(`/api/v1/admin/sellers/${sellerId}/onboarding`).set('Authorization', bearer(adminToken)).expect(200);
    expect(expectSuccess<{ bankDetail: { accountNumber: string } }>(detail.body).data.bankDetail.accountNumber).toBe('000123456789');

    const review = (body: object) =>
      api()
        .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/documents/${documentId}/review`)
        .set('Authorization', bearer(adminToken))
        .send(body);
    const reviewed = await review({ status: 'VERIFIED' }).expect(200);
    expect(
      expectSuccess<{ documents: { id: string; status: string }[] }>(reviewed.body).data.documents.find((d) => d.id === documentId)
        ?.status,
    ).toBe('VERIFIED');
    expect((await review({ status: 'VERIFIED' })).status).toBe(409);
  });

  it('a seller cannot call either gate (or the legacy review), whatever its own state', async () => {
    const { sellerId, token } = await submittedSeller('9500000172', 'No Admin Access Seller');

    for (const [label, res] of [
      ['gate 1', await gate1(token, sellerId, { decision: 'APPROVE' })],
      ['gate 2', await gate2(token, sellerId, { decision: 'APPROVE' })],
      [
        'legacy',
        await api().patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`).set('Authorization', bearer(token)).send({ status: 'APPROVED' }),
      ],
    ] as const) {
      expect(res.status, label).toBe(403);
      expect(expectError(res.body).code, label).toBe(ErrorCode.FORBIDDEN);
    }
    expect((await lifecycleRow(sellerId)).lifecycleStatus).toBe('ONBOARDING_PENDING_REVIEW');
  });
});

/* -------------------------------------------------------------------------- */
/* Admin: view + review only — never writes the seller's onboarding data      */
/* -------------------------------------------------------------------------- */

describe('admin onboarding is read-only', () => {
  async function loginPlatformUser(role: UserRole, mobile: string, email: string): Promise<string> {
    const password = 'TestPlatform@123';
    await prisma.user.create({ data: { mobile, email, fullName: role, passwordHash: await hashPassword(password), role } });
    const res = await api().post('/api/v1/auth/admin/login').send({ email, password }).expect(200);
    return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
  }

  it('admin and super admin cannot write any seller onboarding data — not through seller routes, not with X-Seller-Id', async () => {
    const admin = await loginAdmin();
    const superAdmin = await loginPlatformUser(UserRole.SUPER_ADMIN, '0000000009', 'super@adione.test');
    const { sellerId } = await seedSellerWithOwner('9500000181', 'Seller Owned Data');

    for (const [who, token] of [['ADMIN', admin], ['SUPER_ADMIN', superAdmin]] as const) {
      for (const sellerHeader of [null, sellerId]) {
        const send = (method: 'put' | 'post' | 'patch', path: string) => {
          const req = api()[method](`/api/v1/seller${path}`).set('Authorization', bearer(token));
          return sellerHeader ? req.set('X-Seller-Id', sellerHeader) : req;
        };
        for (const [label, res] of [
          ['profile', await send('put', '/onboarding/profile').send(profileBody())],
          ['bank', await send('put', '/onboarding/bank-detail').send(bankBody())],
          ['restaurant', await send('put', '/onboarding/restaurant-profile').send({ cuisine: ['Mughlai'] })],
          [
            'document',
            await send('post', '/onboarding/documents')
              .field('type', 'PAN_CARD')
              .field('documentNumber', 'ABCDE1234F')
              .attach('file', PDF, { filename: 'pan.pdf', contentType: 'application/pdf' }),
          ],
          ['submit', await send('post', '/onboarding/submit')],
          ['location', await send('patch', '/location').send({ latitude: 27.7, longitude: 75.2, addressLine: 'Admin Road' })],
        ] as const) {
          const tag = `${who}${sellerHeader ? ' + X-Seller-Id' : ''} ${label}`;
          expect(res.status, tag).toBe(403);
          expect(expectError(res.body).code, tag).toBe(ErrorCode.FORBIDDEN);
          // Refused by the explicit rule, not merely for lack of a seller context.
          expect(expectError(res.body).message, tag).toMatch(/can only be changed by the seller/);
        }
      }
    }

    // The removed admin write routes stay gone.
    for (const [label, res] of [
      ['PATCH seller', await api().patch(`/api/v1/admin/sellers/${sellerId}`).set('Authorization', bearer(superAdmin)).send({ name: 'Renamed' })],
      ['PUT profile', await api().put(`/api/v1/admin/sellers/${sellerId}/onboarding/profile`).set('Authorization', bearer(superAdmin)).send(profileBody())],
      ['PUT bank', await api().put(`/api/v1/admin/sellers/${sellerId}/onboarding/bank-detail`).set('Authorization', bearer(superAdmin)).send(bankBody())],
      ['POST document', await api().post(`/api/v1/admin/sellers/${sellerId}/onboarding/documents`).set('Authorization', bearer(superAdmin)).send({ type: 'PAN_CARD' })],
    ] as const) {
      expect(res.status, label).toBe(404);
    }

    // Nothing was written.
    expect(await prisma.sellerProfile.count({ where: { sellerId } })).toBe(0);
    expect(await prisma.sellerBankDetail.count({ where: { sellerId } })).toBe(0);
    expect(await prisma.sellerDocument.count({ where: { sellerId } })).toBe(0);
    expect(await prisma.restaurantProfile.count({ where: { sellerId } })).toBe(0);
    expect(storedDocuments.size).toBe(0);
    expect(await lifecycleRow(sellerId)).toMatchObject({ lifecycleStatus: 'ONBOARDING_PENDING' });
    expect(await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).toMatchObject({
      name: 'Seller Owned Data',
      addressLine: 'Test Address',
      latitude: 27.62,
    });
  });

  it('admin views everything the seller submitted, opens the PDF and reveals a number; the seller keeps editing', async () => {
    const admin = await loginAdmin();
    const { sellerId, token } = await seedSellerWithOwner('9500000182', 'Viewable Seller');
    await completeOnboarding(token);
    const documentId = (await prisma.sellerDocument.findFirstOrThrow({ where: { sellerId } })).id;

    const summary = await api().get(`/api/v1/admin/sellers/${sellerId}/onboarding/summary`).set('Authorization', bearer(admin)).expect(200);
    const data = expectSuccess<{
      profile: { businessName: string; ownerEmail: string; panNumber: string };
      bankDetail: { accountNumber: string; ifscCode: string };
      documents: { id: string; type: string }[];
    }>(summary.body).data;
    expect(data.profile).toMatchObject({ businessName: 'QA Onboarding Business (DEV)', ownerEmail: 'owner@onboarding.adione.test' });
    expect(data.profile.panNumber).not.toBe('ABCDE1234F'); // masked
    expect(data.bankDetail.accountNumber).not.toBe('000123456789'); // masked
    expect(data.documents.map((d) => d.type)).toEqual(['PAN_CARD']);

    const file = await api()
      .get(`/api/v1/admin/sellers/${sellerId}/onboarding/documents/${documentId}/file`)
      .set('Authorization', bearer(admin))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);

    const revealed = await api()
      .get(`/api/v1/admin/sellers/${sellerId}/onboarding/documents/${documentId}/number`)
      .set('Authorization', bearer(admin))
      .expect(200);
    expect(JSON.stringify(revealed.body)).toContain('ABCDE1234F');

    // The seller can still change its own data while onboarding is editable.
    await seller(token).put('/onboarding/profile', profileBody({ businessName: 'Seller Renamed Business' })).expect(200);
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { sellerId } })).businessName).toBe('Seller Renamed Business');
  });
});
