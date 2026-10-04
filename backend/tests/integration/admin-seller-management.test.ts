/**
 * Admin seller management.
 *
 * Step 1 — directory (GET /admin/sellers, GET /admin/sellers/:id) and
 * hardening: masked onboarding queue, document review bound to its seller,
 * http(s)-only document links, create-seller lengths aligned with the
 * `sellers` columns.
 *
 * Step 2 — writes and catalogue reads: the admin trading switch, basic-detail
 * edits, onboarding data entry, bank verification, audited seller-side
 * profile/bank changes, the seller's products/listings, the approval-batch
 * `sellerId` filter, and deleted-seller hardening.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  UserRole,
  type AdminSellerDetailDto,
  type AdminSellerListRowDto,
  type AdminSellerOnboardingSummaryDto,
  type ApprovalStatus,
  type CursorPage,
  type ProductApprovalBatchSummaryDto,
  type SellerListingDto,
  type SellerOnboardingDetailDto,
  type SellerLifecycleStatus,
  type SellerProductDto,
  type SellerType,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedProduct, sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { AppError } from '../../src/common/errors';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import * as onboardingService from '../../src/modules/sellers/seller-onboarding.service';
import { unorderableReason } from '../../src/modules/cart/orderability';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };
const STAFF = { email: 'staff@adione.test', password: 'TestStaff@123' };

/** Raw values seeded into onboarding rows — none may ever appear in a list,
 * the overview, or the review queue. */
const RAW_PAN = 'ABCDE1234F';
const RAW_AADHAAR = '123456789012';
const RAW_ACCOUNT = '000123456789';
const SECRET_DOC_URL = 'https://files.adione.test/secret-pan-card.pdf';

async function loginStaffUser(credentials: { email: string; password: string }, role: UserRole, mobile: string) {
  await prisma.user.create({
    data: {
      mobile,
      email: credentials.email,
      fullName: `${role} user`,
      passwordHash: await hashPassword(credentials.password),
      role,
    },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(credentials).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

const loginAdmin = () => loginStaffUser(ADMIN, UserRole.ADMIN, '0000000001');

interface SeedSellerOptions {
  name: string;
  code?: string;
  city?: string;
  sellerType?: SellerType;
  onboardingStatus?: ApprovalStatus;
  /** Overrides the lifecycle state `sellerLifecycleFields` derives from
   * `onboardingStatus` (it must still agree with it — DB CHECK). */
  lifecycleStatus?: SellerLifecycleStatus;
  isActive?: boolean;
  isAcceptingOrders?: boolean;
  isPlatformOwned?: boolean;
  deletedAt?: Date | null;
  createdAt?: Date;
}

async function seedSeller(options: SeedSellerOptions): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: options.code ?? `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: options.name,
      sellerType: options.sellerType ?? 'GROCERY',
      isPlatformOwned: options.isPlatformOwned ?? false,
      isAcceptingOrders: options.isAcceptingOrders ?? true,
      addressLine: 'Test Address',
      city: options.city ?? 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      ...sellerLifecycleFields(options.onboardingStatus ?? 'PENDING'),
      ...(options.lifecycleStatus ? { lifecycleStatus: options.lifecycleStatus } : {}),
      isActive: options.isActive ?? true,
      deletedAt: options.deletedAt ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
  return seller.id;
}

/** Profile + bank + a PAN document: a complete application (`stage`
 * SUBMITTED while PENDING). Returns the document id. */
async function seedCompleteOnboarding(sellerId: string): Promise<string> {
  await prisma.sellerProfile.create({
    data: {
      sellerId,
      businessName: 'QA Directory Business (DEV)',
      ownerFullName: 'QA Directory Owner (DEV)',
      ownerMobile: '9500000001',
      panNumber: RAW_PAN,
      aadhaarNumber: RAW_AADHAAR,
    },
  });
  await prisma.sellerBankDetail.create({
    data: {
      sellerId,
      accountHolderName: 'QA Directory Owner (DEV)',
      accountNumber: RAW_ACCOUNT,
      ifscCode: 'HDFC0000001',
    },
  });
  const document = await prisma.sellerDocument.create({
    data: { sellerId, type: 'PAN_CARD', fileUrl: SECRET_DOC_URL },
  });
  return document.id;
}

/** What `seedCompleteOnboarding` leaves out of the onboarding checklist
 * (seller-lifecycle-rules.ts): the owner's email, and a PAN document that is
 * an uploaded PDF carrying its number. */
async function completeChecklist(sellerId: string): Promise<void> {
  await prisma.sellerProfile.update({ where: { sellerId }, data: { ownerEmail: 'owner@directory.adione.test' } });
  await prisma.sellerDocument.updateMany({
    where: { sellerId, type: 'PAN_CARD' },
    data: { documentNumber: RAW_PAN, fileKey: `seller-documents/${sellerId}/pan.pdf` },
  });
}

async function seedSellerWithOwner(mobile: string, name: string): Promise<string> {
  const sellerId = await seedSeller({ name });
  const user = await prisma.user.create({ data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId, userId: user.id, role: 'OWNER', isActive: true } });
  return sellerId;
}

async function loginSeller(mobile: string): Promise<string> {
  await otpService.clearOtpState(mobile);
  return (await loginAs(mobile)).accessToken;
}

async function listSellers(token: string, query = ''): Promise<CursorPage<AdminSellerListRowDto>> {
  const res = await api().get(`/api/v1/admin/sellers${query}`).set('Authorization', bearer(token)).expect(200);
  return expectSuccess<CursorPage<AdminSellerListRowDto>>(res.body).data;
}

async function getDetail(token: string, sellerId: string): Promise<AdminSellerDetailDto> {
  const res = await api().get(`/api/v1/admin/sellers/${sellerId}`).set('Authorization', bearer(token)).expect(200);
  return expectSuccess<AdminSellerDetailDto>(res.body).data;
}

function expectNoRawPii(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toContain(RAW_PAN);
  expect(text).not.toContain(RAW_AADHAAR);
  expect(text).not.toContain(RAW_ACCOUNT);
}

const names = (page: CursorPage<AdminSellerListRowDto>) => page.items.map((s) => s.name).sort();

/* --- Step 2 helpers -------------------------------------------------------- */

/** A second raw account number, for "the account changed" cases. */
const NEW_RAW_ACCOUNT = '000987654321';

const adminUserId = async () => (await prisma.user.findFirstOrThrow({ where: { email: ADMIN.email } })).id;

function adminProfileBody(overrides: Record<string, unknown> = {}) {
  return {
    businessName: 'QA Admin Entry Business (DEV)',
    ownerFullName: 'QA Admin Entry Owner (DEV)',
    ownerMobile: '9500000201',
    panNumber: RAW_PAN,
    aadhaarNumber: RAW_AADHAAR,
    ...overrides,
  };
}

function adminBankBody(overrides: Record<string, unknown> = {}) {
  return {
    accountHolderName: 'QA Payout Owner (DEV)',
    accountNumber: NEW_RAW_ACCOUNT,
    ifscCode: 'HDFC0000002',
    ...overrides,
  };
}

/** The bank state an admin reviewed, as the verify endpoint requires it —
 * taken from any read that carries `SellerBankDetailDto`. */
function reviewedBank(detail: { bankDetail: { id: string; updatedAt: string } | null }) {
  return { bankDetailId: detail.bankDetail!.id, expectedUpdatedAt: detail.bankDetail!.updatedAt };
}

/** Every Step 2 / 2.5 admin endpoint for one seller, labelled for failure
 * output. Bodies are well-formed, so an outcome is never a validation 400. */
function step2Calls(sellerId: string) {
  const base = `/api/v1/admin/sellers/${sellerId}`;
  return [
    ['PATCH status', () => api().patch(`${base}/status`).send({ isActive: false, reason: 'Security check' })],
    [
      'PATCH verify',
      () =>
        api()
          .patch(`${base}/onboarding/bank-detail/verify`)
          .send({ bankDetailId: randomUUID(), expectedUpdatedAt: new Date().toISOString() }),
    ],
    ['GET listings', () => api().get(`${base}/listings`)],
    ['GET products', () => api().get(`${base}/products`)],
  ] as const;
}

/** A product submitted by `sellerId`, with that seller's own listing. */
async function seedSellerProduct(sellerId: string, name: string) {
  const seeded = await seedProduct(sellerId, { name, pricePaise: 5000, mrpPaise: 6000, stockQty: 7 });
  await prisma.product.update({ where: { id: seeded.productId }, data: { submittedBySellerId: sellerId } });
  return seeded;
}

async function seedApprovalBatch(
  sellerId: string,
  submittedByUserId: string,
  productId: string,
  item: { status: ApprovalStatus; reviewNote?: string | null } = { status: 'PENDING' },
) {
  return prisma.productApprovalBatch.create({
    data: {
      sellerId,
      submittedByUserId,
      status: 'PENDING',
      items: { create: [{ productId, status: item.status, reviewNote: item.reviewNote ?? null }] },
    },
  });
}

async function auditRows(action: string) {
  return prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });
}

/** The entry whose `after.created` matches — two entries written in the same
 * millisecond have no reliable createdAt order. */
function entryWhere<T extends { after: unknown }>(entries: T[], created: boolean): T {
  const entry = entries.find((e) => (e.after as { created?: boolean } | null)?.created === created);
  if (!entry) throw new Error(`no audit entry with created=${created}`);
  return entry;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

/* -------------------------------------------------------------------------- */
/* GET /admin/sellers                                                         */
/* -------------------------------------------------------------------------- */

describe('admin seller list', () => {
  it('lists sellers with their directory fields', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Directory Grocery', code: 'DIRGROCERY', city: 'Sikar' });

    const page = await listSellers(token);
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({
      id: sellerId,
      code: 'DIRGROCERY',
      name: 'Directory Grocery',
      sellerType: 'GROCERY',
      isPlatformOwned: false,
      city: 'Sikar',
      state: 'Rajasthan',
      onboardingStatus: 'PENDING',
      stage: 'PENDING',
      isActive: true,
      isAcceptingOrders: true,
      // No weekly schedule saved -> no hour restriction (seller.service.ts).
      isOpenNow: true,
      acceptingOrdersNow: true,
      closedReason: null,
    });
    expect(typeof page.items[0]!.createdAt).toBe('string');
  });

  it('paginates newest first with a createdAt cursor', async () => {
    const token = await loginAdmin();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    await seedSeller({ name: 'Page Oldest', createdAt: new Date(base) });
    await seedSeller({ name: 'Page Middle', createdAt: new Date(base + 1_000) });
    await seedSeller({ name: 'Page Newest', createdAt: new Date(base + 2_000) });

    const first = await listSellers(token, '?limit=2');
    expect(first.items.map((s) => s.name)).toEqual(['Page Newest', 'Page Middle']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(new Date(base + 1_000).toISOString());

    const second = await listSellers(token, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((s) => s.name)).toEqual(['Page Oldest']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('searches name, code and city, case-insensitively', async () => {
    const token = await loginAdmin();
    await seedSeller({ name: 'Alpha Kirana Store', city: 'Sikar' });
    await seedSeller({ name: 'Beta Sweets', city: 'Jaipur' });
    await seedSeller({ name: 'Gamma Pharmacy', code: 'QACODE777', city: 'Sikar' });

    expect(names(await listSellers(token, '?search=KIRANA'))).toEqual(['Alpha Kirana Store']);
    expect(names(await listSellers(token, '?search=jaip'))).toEqual(['Beta Sweets']);
    expect(names(await listSellers(token, '?search=qacode777'))).toEqual(['Gamma Pharmacy']);
    expect((await listSellers(token, '?search=nothing-matches')).items).toHaveLength(0);
  });

  it('filters by sellerType', async () => {
    const token = await loginAdmin();
    await seedSeller({ name: 'Type Grocery', sellerType: 'GROCERY' });
    await seedSeller({ name: 'Type Restaurant', sellerType: 'RESTAURANT' });

    expect(names(await listSellers(token, '?sellerType=RESTAURANT'))).toEqual(['Type Restaurant']);
    expect(names(await listSellers(token, '?sellerType=GROCERY'))).toEqual(['Type Grocery']);
  });

  it('filters by onboardingStatus', async () => {
    const token = await loginAdmin();
    await seedSeller({ name: 'Status Pending', onboardingStatus: 'PENDING' });
    await seedSeller({ name: 'Status Approved', onboardingStatus: 'APPROVED' });
    await seedSeller({ name: 'Status Rejected', onboardingStatus: 'REJECTED' });

    expect(names(await listSellers(token, '?onboardingStatus=APPROVED'))).toEqual(['Status Approved']);
    expect(names(await listSellers(token, '?onboardingStatus=REJECTED'))).toEqual(['Status Rejected']);
    expect(names(await listSellers(token, '?onboardingStatus=PENDING'))).toEqual(['Status Pending']);
  });

  it('filters by stage, derived from the lifecycle state (submitted for review vs still onboarding)', async () => {
    const token = await loginAdmin();
    const complete = await seedSeller({ name: 'Stage Complete', lifecycleStatus: 'ONBOARDING_PENDING_REVIEW' });
    await seedCompleteOnboarding(complete);
    await seedSeller({ name: 'Stage Incomplete' });
    await seedSeller({ name: 'Stage Approved', onboardingStatus: 'APPROVED' });

    const submitted = await listSellers(token, '?stage=SUBMITTED');
    expect(names(submitted)).toEqual(['Stage Complete']);
    expect(submitted.items[0]!.stage).toBe('SUBMITTED');

    const pending = await listSellers(token, '?stage=PENDING');
    expect(names(pending)).toEqual(['Stage Incomplete']);
    expect(pending.items[0]!.stage).toBe('PENDING');

    expect(names(await listSellers(token, '?stage=APPROVED'))).toEqual(['Stage Approved']);
  });

  it('filters by isActive', async () => {
    const token = await loginAdmin();
    await seedSeller({ name: 'Active Seller', isActive: true });
    await seedSeller({ name: 'Inactive Seller', isActive: false });

    const inactive = await listSellers(token, '?isActive=false');
    expect(names(inactive)).toEqual(['Inactive Seller']);
    expect(inactive.items[0]).toMatchObject({ isActive: false, isOpenNow: false, closedReason: 'SELLER_INACTIVE' });

    expect(names(await listSellers(token, '?isActive=true'))).toEqual(['Active Seller']);
  });

  it('excludes deleted sellers', async () => {
    const token = await loginAdmin();
    await seedSeller({ name: 'Live Seller' });
    await seedSeller({ name: 'Deleted Seller', deletedAt: new Date() });

    expect(names(await listSellers(token))).toEqual(['Live Seller']);
  });

  it('carries no sensitive PII, even for a complete application', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'PII Seller' });
    await seedCompleteOnboarding(sellerId);

    const res = await api().get('/api/v1/admin/sellers').set('Authorization', bearer(token)).expect(200);
    expectNoRawPii(res.body);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_DOC_URL);

    const row = expectSuccess<CursorPage<Record<string, unknown>>>(res.body).data.items[0]!;
    for (const key of ['profile', 'bankDetail', 'documents', 'staff', 'phone']) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it('keeps the static /sellers/onboarding and /sellers/availability routes reachable', async () => {
    const token = await loginAdmin();
    await seedSeller({ name: 'Route Order Seller' });

    await api().get('/api/v1/admin/sellers/onboarding').set('Authorization', bearer(token)).expect(200);
    await api().get('/api/v1/admin/sellers/availability').set('Authorization', bearer(token)).expect(200);
  });

  it('is admin-only: a seller gets 403, and admin STAFF without the permission gets 403', async () => {
    await seedSellerWithOwner('9500000101', 'Permission Seller');
    const sellerToken = await loginSeller('9500000101');
    const sellerRes = await api().get('/api/v1/admin/sellers').set('Authorization', bearer(sellerToken));
    expect(sellerRes.status).toBe(403);
    expect(expectError(sellerRes.body).code).toBe(ErrorCode.FORBIDDEN);

    const staffToken = await loginStaffUser(STAFF, UserRole.STAFF, '0000000002');
    const staffRes = await api().get('/api/v1/admin/sellers').set('Authorization', bearer(staffToken));
    expect(staffRes.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /admin/sellers/:sellerId                                               */
/* -------------------------------------------------------------------------- */

describe('admin seller detail', () => {
  it('returns the overview with staff, availability and document summary', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9500000110', 'Detail Seller');

    const detail = await getDetail(token, sellerId);
    expect(detail).toMatchObject({
      id: sellerId,
      name: 'Detail Seller',
      sellerType: 'GROCERY',
      isPlatformOwned: false,
      addressLine: 'Test Address',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      onboardingStatus: 'PENDING',
      isActive: true,
      isAcceptingOrders: true,
      profile: null,
      bankDetail: null,
      restaurantProfile: null,
      lastRejectionReason: null,
      lastRejectedAt: null,
      documentSummary: { total: 0, pending: 0, verified: 0, rejected: 0 },
    });
    expect(detail.availability).toMatchObject({
      timezone: 'Asia/Kolkata',
      isOpenNow: true,
      acceptingOrdersNow: true,
      closedReason: null,
      hoursConfigured: false,
    });
    expect(detail.staff).toHaveLength(1);
    expect(detail.staff[0]).toMatchObject({ role: 'OWNER', mobile: '9500000110', isActive: true });
  });

  it('includes the stage (from the lifecycle) and completeness (from the onboarding checklist)', async () => {
    const token = await loginAdmin();
    const incomplete = await seedSeller({ name: 'Detail Incomplete' });
    const complete = await seedSeller({ name: 'Detail Complete', lifecycleStatus: 'ONBOARDING_PENDING_REVIEW' });
    await seedCompleteOnboarding(complete);
    await completeChecklist(complete);

    expect(await getDetail(token, incomplete)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_PENDING',
      stage: 'PENDING',
      isComplete: false,
    });
    expect(await getDetail(token, complete)).toMatchObject({
      lifecycleStatus: 'ONBOARDING_PENDING_REVIEW',
      stage: 'SUBMITTED',
      isComplete: true,
      documentSummary: { total: 1, pending: 1, verified: 0, rejected: 0 },
    });
  });

  it('includes the latest onboarding rejection reason from the audit log', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Rejected Seller', lifecycleStatus: 'ONBOARDING_PENDING_REVIEW' });
    await seedCompleteOnboarding(sellerId);
    const rejectAtGate2 = (reason: string) =>
      api()
        .patch(`/api/v1/admin/sellers/${sellerId}/verification/review`)
        .set('Authorization', bearer(token))
        .send({ decision: 'REJECT', reason })
        .expect(200);

    await rejectAtGate2('PAN scan is blurry');

    const first = await getDetail(token, sellerId);
    expect(first).toMatchObject({
      lifecycleStatus: 'ONBOARDING_REJECTED',
      stage: 'REJECTED',
      lastRejectionReason: 'PAN scan is blurry',
    });
    expect(first.lastRejectedAt).not.toBeNull();

    // A second review round (Gate 2 rejection is terminal, so the round is
    // re-opened directly in the database): only the LATEST rejection is reported.
    await prisma.seller.update({
      where: { id: sellerId },
      data: { onboardingStatus: 'PENDING', lifecycleStatus: 'ONBOARDING_PENDING_REVIEW' },
    });
    await rejectAtGate2('Bank proof missing');
    expect((await getDetail(token, sellerId)).lastRejectionReason).toBe('Bank proof missing');
  });

  it('never fabricates a rejection reason', async () => {
    const token = await loginAdmin();
    const never = await seedSeller({ name: 'Never Rejected Seller' });
    const noReason = await seedSeller({ name: 'Reasonless Audit Seller', onboardingStatus: 'REJECTED' });
    await prisma.auditLog.create({
      data: { action: 'seller_onboarding.reject', entityType: 'Seller', entityId: noReason, after: { status: 'REJECTED' } },
    });

    expect((await getDetail(token, never)).lastRejectionReason).toBeNull();
    expect(await getDetail(token, noReason)).toMatchObject({ lastRejectionReason: null, lastRejectedAt: null });
  });

  it('masks PAN, Aadhaar and the bank account, and carries no document links', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Masked Detail Seller' });
    await seedCompleteOnboarding(sellerId);

    const res = await api().get(`/api/v1/admin/sellers/${sellerId}`).set('Authorization', bearer(token)).expect(200);
    expectNoRawPii(res.body);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_DOC_URL);

    const detail = expectSuccess<AdminSellerDetailDto>(res.body).data;
    expect(detail.profile!.panNumber).toBe('ABC******F');
    expect(detail.profile!.aadhaarNumber).toBe('123********2');
    expect(detail.bankDetail!.accountNumber).toBe('********6789');
  });

  it('is NOT_FOUND for a deleted or unknown seller, and 400 for a malformed id', async () => {
    const token = await loginAdmin();
    const deleted = await seedSeller({ name: 'Deleted Detail Seller', deletedAt: new Date() });

    const deletedRes = await api().get(`/api/v1/admin/sellers/${deleted}`).set('Authorization', bearer(token));
    expect(deletedRes.status).toBe(404);
    expect(expectError(deletedRes.body).code).toBe(ErrorCode.NOT_FOUND);

    const unknown = await api().get(`/api/v1/admin/sellers/${randomUUID()}`).set('Authorization', bearer(token));
    expect(unknown.status).toBe(404);

    const malformed = await api().get('/api/v1/admin/sellers/not-a-uuid').set('Authorization', bearer(token));
    expect(malformed.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Onboarding queue masking                                                   */
/* -------------------------------------------------------------------------- */

describe('onboarding review queue', () => {
  it('returns masked PAN, Aadhaar and bank account numbers', async () => {
    const token = await loginAdmin();
    // The Gate 2 queue holds sellers that submitted their onboarding.
    const sellerId = await seedSeller({ name: 'Queue Masked Seller', lifecycleStatus: 'ONBOARDING_PENDING_REVIEW' });
    await seedCompleteOnboarding(sellerId);

    const res = await api().get('/api/v1/admin/sellers/onboarding').set('Authorization', bearer(token)).expect(200);
    expectNoRawPii(res.body);

    const item = expectSuccess<{
      items: {
        sellerId: string;
        stage: string;
        profile: { panNumber: string; aadhaarNumber: string };
        bankDetail: { accountNumber: string };
      }[];
    }>(res.body).data.items.find((i) => i.sellerId === sellerId)!;
    expect(item.stage).toBe('SUBMITTED');
    expect(item.profile.panNumber).toBe('ABC******F');
    expect(item.profile.aadhaarNumber).toBe('123********2');
    expect(item.bankDetail.accountNumber).toBe('********6789');
  });
});

/* -------------------------------------------------------------------------- */
/* Document review bound to its seller                                        */
/* -------------------------------------------------------------------------- */

describe('document review', () => {
  it("is NOT_FOUND when the document belongs to another seller, and leaves it untouched", async () => {
    const token = await loginAdmin();
    const sellerA = await seedSeller({ name: 'Doc Owner Seller A' });
    const documentId = await seedCompleteOnboarding(sellerA);
    const sellerB = await seedSeller({ name: 'Other Seller B' });

    const cross = await api()
      .patch(`/api/v1/admin/sellers/${sellerB}/onboarding/documents/${documentId}/review`)
      .set('Authorization', bearer(token))
      .send({ status: 'VERIFIED' });
    expect(cross.status).toBe(404);
    const error = expectError(cross.body);
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(JSON.stringify(cross.body)).not.toContain(SECRET_DOC_URL);

    const untouched = await prisma.sellerDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(untouched.status).toBe('PENDING');
    expect(untouched.verifiedByUserId).toBeNull();
    expect(
      await prisma.auditLog.count({ where: { entityType: 'SellerDocument', entityId: documentId, action: 'seller_document.verify' } }),
    ).toBe(0);

    // The owning seller's route still works exactly as before.
    const own = await api()
      .patch(`/api/v1/admin/sellers/${sellerA}/onboarding/documents/${documentId}/review`)
      .set('Authorization', bearer(token))
      .send({ status: 'VERIFIED' })
      .expect(200);
    const reviewed = expectSuccess<{ documents: { id: string; status: string }[] }>(own.body).data.documents.find(
      (d) => d.id === documentId,
    );
    expect(reviewed?.status).toBe('VERIFIED');
  });
});

/* -------------------------------------------------------------------------- */
/* Document link schemes                                                      */
/* -------------------------------------------------------------------------- */

describe('document links', () => {
  async function submitDocument(token: string, fileUrl: string) {
    return api()
      .post('/api/v1/seller/onboarding/documents')
      .set('Authorization', bearer(token))
      .send({ type: 'PAN_CARD', fileUrl });
  }

  async function expectRejected(mobile: string, fileUrls: string[]) {
    const sellerId = await seedSellerWithOwner(mobile, `Link Seller ${mobile}`);
    const token = await loginSeller(mobile);
    for (const fileUrl of fileUrls) {
      const res = await submitDocument(token, fileUrl);
      expect(res.status).toBe(400);
      expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
    expect(await prisma.sellerDocument.count({ where: { sellerId } })).toBe(0);
  }

  async function expectAccepted(mobile: string, fileUrl: string) {
    const sellerId = await seedSellerWithOwner(mobile, `Link Seller ${mobile}`);
    const token = await loginSeller(mobile);
    const res = await submitDocument(token, fileUrl);
    expect(res.status).toBe(201);
    expect(expectSuccess<{ fileUrl: string }>(res.body).data.fileUrl).toBe(fileUrl);
    expect(await prisma.sellerDocument.count({ where: { sellerId } })).toBe(1);
  }

  it('rejects javascript: links', async () => {
    await expectRejected('9500000120', ['javascript:alert(1)', 'JaVaScRiPt:alert(document.cookie)']);
  });

  it('rejects data: links', async () => {
    await expectRejected('9500000121', ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==']);
  });

  it('rejects file: links', async () => {
    await expectRejected('9500000122', ['file:///etc/passwd']);
  });

  it('accepts an http link', async () => {
    await expectAccepted('9500000123', 'http://files.adione.test/pan-card.pdf');
  });

  it('accepts an https link', async () => {
    await expectAccepted('9500000124', 'https://files.adione.test/pan-card.pdf');
  });

  it('is also enforced by the service itself: a non-PDF upload is refused, nothing stored', async () => {
    const sellerId = await seedSeller({ name: 'Service Guard Seller' });
    await expect(
      onboardingService.addDocument(
        sellerId,
        { type: 'PAN_CARD', documentNumber: 'ABCDE1234F' },
        { buffer: Buffer.from('not a pdf at all'), originalname: 'pan.pdf', mimetype: 'application/pdf', size: 16 },
        { userId: randomUUID(), type: 'ADMIN' },
      ),
    ).rejects.toSatisfy((error: unknown) => AppError.is(error) && error.code === ErrorCode.UNSUPPORTED_FILE_TYPE);
    expect(await prisma.sellerDocument.count({ where: { sellerId } })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Create-seller lengths match the `sellers` columns                          */
/* -------------------------------------------------------------------------- */

describe('create seller field lengths', () => {
  function createBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Length Check Seller',
      sellerType: 'GROCERY',
      addressLine: 'Test Address',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      ownerMobile: '9600000001',
      ownerFullName: 'Length Check Owner',
      ...overrides,
    };
  }

  it('returns 400 (not 500) for an oversized name, city or state', async () => {
    const token = await loginAdmin();

    for (const [field, value] of [
      ['name', 'N'.repeat(121)],
      ['city', 'C'.repeat(81)],
      ['state', 'S'.repeat(81)],
    ] as const) {
      const res = await api()
        .post('/api/v1/admin/sellers')
        .set('Authorization', bearer(token))
        .send(createBody({ [field]: value }));
      expect(res.status).toBe(400);
      const error = expectError(res.body);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.details?.some((d) => d.field === field)).toBe(true);
    }
    expect(await prisma.seller.count()).toBe(0);
  });

  it('accepts values exactly at the column limits', async () => {
    const token = await loginAdmin();
    const res = await api()
      .post('/api/v1/admin/sellers')
      .set('Authorization', bearer(token))
      .send(createBody({ name: 'N'.repeat(120), city: 'C'.repeat(80), state: 'S'.repeat(80) }))
      .expect(201);
    const { sellerId } = expectSuccess<{ sellerId: string }>(res.body).data;
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.name).toHaveLength(120);
    expect(seller.city).toHaveLength(80);
    expect(seller.state).toHaveLength(80);
  });
});

/* ========================================================================== */
/* STEP 2                                                                     */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* PATCH /admin/sellers/:sellerId/status                                      */
/* -------------------------------------------------------------------------- */

describe('admin seller status', () => {
  const setStatus = (token: string, sellerId: string, body: unknown) =>
    api().patch(`/api/v1/admin/sellers/${sellerId}/status`).set('Authorization', bearer(token)).send(body as object);

  it('deactivates a non-platform seller, audited with actor, old/new value and reason', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Status Seller', onboardingStatus: 'APPROVED' });

    const res = await setStatus(token, sellerId, { isActive: false, reason: 'Repeated late deliveries' }).expect(200);
    expect(expectSuccess<AdminSellerDetailDto>(res.body).data).toMatchObject({
      id: sellerId,
      isActive: false,
      isAcceptingOrders: true,
      onboardingStatus: 'APPROVED',
      availability: { isOpenNow: false, acceptingOrdersNow: false, closedReason: 'SELLER_INACTIVE' },
    });
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).isActive).toBe(false);

    const [entry] = await auditRows('seller.deactivate');
    expect(entry).toMatchObject({
      actorUserId: await adminUserId(),
      entityType: 'Seller',
      entityId: sellerId,
      before: { isActive: true },
      after: { isActive: false, reason: 'Repeated late deliveries' },
    });
  });

  it('requires a reason, within its length limit', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Reasonless Status Seller' });

    for (const body of [{ isActive: false }, { isActive: false, reason: '' }, { isActive: false, reason: 'R'.repeat(301) }]) {
      const res = await setStatus(token, sellerId, body);
      expect(res.status).toBe(400);
      expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).isActive).toBe(true);
    expect(await auditRows('seller.deactivate')).toHaveLength(0);
  });

  it('makes a deactivated seller unorderable through the existing orderability rule', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Orderability Seller', onboardingStatus: 'APPROVED' });
    const product = { status: 'ACTIVE', deletedAt: null, approvalStatus: 'APPROVED' };
    const variant = { status: 'ACTIVE', deletedAt: null };

    const before = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(unorderableReason({ seller: before, product, variant })).toBeNull();

    await setStatus(token, sellerId, { isActive: false, reason: 'Compliance hold' }).expect(200);

    const after = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(unorderableReason({ seller: after, product, variant })).toBe('SELLER_NOT_TRADING');
    const row = (await listSellers(token)).items.find((s) => s.id === sellerId)!;
    expect(row).toMatchObject({ isActive: false, acceptingOrdersNow: false, closedReason: 'SELLER_INACTIVE' });
  });

  it('reactivates a seller, audited', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Reactivate Seller', isActive: false });

    const res = await setStatus(token, sellerId, { isActive: true, reason: 'Compliance cleared' }).expect(200);
    expect(expectSuccess<AdminSellerDetailDto>(res.body).data).toMatchObject({
      isActive: true,
      availability: { closedReason: null, acceptingOrdersNow: true },
    });
    const [entry] = await auditRows('seller.activate');
    expect(entry).toMatchObject({ before: { isActive: false }, after: { isActive: true, reason: 'Compliance cleared' } });
  });

  it("never touches the seller's own switch or onboarding state, either way", async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({
      name: 'Own Switch Seller',
      isActive: false,
      isAcceptingOrders: false,
      onboardingStatus: 'REJECTED',
    });

    const on = await setStatus(token, sellerId, { isActive: true, reason: 'Reinstated' }).expect(200);
    expect(expectSuccess<AdminSellerDetailDto>(on.body).data).toMatchObject({
      isActive: true,
      isAcceptingOrders: false,
      onboardingStatus: 'REJECTED',
      // Back under the seller's own control: its switch is still OFF.
      availability: { closedReason: 'MANUALLY_CLOSED' },
    });

    await setStatus(token, sellerId, { isActive: false, reason: 'Paused again' }).expect(200);
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller).toMatchObject({ isActive: false, isAcceptingOrders: false, onboardingStatus: 'REJECTED' });
  });

  it('refuses isAcceptingOrders / onboardingStatus in the body (strict)', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Strict Status Seller', isAcceptingOrders: false });

    for (const extra of [{ isAcceptingOrders: true }, { onboardingStatus: 'APPROVED' }]) {
      const res = await setStatus(token, sellerId, { isActive: true, reason: 'Trying extra fields', ...extra });
      expect(res.status).toBe(400);
    }
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller).toMatchObject({ isAcceptingOrders: false, onboardingStatus: 'PENDING' });
  });

  it('setting the current value again writes nothing and audits nothing', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'No-op Status Seller', isActive: true });

    const res = await setStatus(token, sellerId, { isActive: true, reason: 'Already on' }).expect(200);
    expect(expectSuccess<AdminSellerDetailDto>(res.body).data.isActive).toBe(true);
    expect(await auditRows('seller.activate')).toHaveLength(0);
  });

  it('leaves the platform seller to its existing /admin/store/status route', async () => {
    const token = await loginAdmin();
    const platformId = await seedSeller({ name: 'Platform Store', isPlatformOwned: true, onboardingStatus: 'APPROVED' });

    const res = await setStatus(token, platformId, { isActive: false, reason: 'Wrong route' });
    expect(res.status).toBe(400);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: platformId } })).isActive).toBe(true);
  });

  it('is NOT_FOUND for a deleted seller', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Deleted Status Seller', deletedAt: new Date() });

    const res = await setStatus(token, sellerId, { isActive: false, reason: 'Too late' });
    expect(res.status).toBe(404);
    expect(expectError(res.body).code).toBe(ErrorCode.NOT_FOUND);
  });
});

/* -------------------------------------------------------------------------- */
/* Admin onboarding is read-only (two-gate lifecycle)                         */
/* -------------------------------------------------------------------------- */

// The two-gate lifecycle removed admin's seller edit and onboarding data-entry
// routes (PATCH /admin/sellers/:id, PUT .../onboarding/profile,
// PUT .../onboarding/bank-detail, POST .../onboarding/documents): onboarding
// data is the seller's own, and admin asks for corrections with Gate 2
// "request changes". The tests of those routes were replaced by this one.
describe('admin onboarding is read-only', () => {
  it('has no admin route that edits a seller or writes its onboarding data — 404, nothing written', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Read Only Seller' });
    const base = `/api/v1/admin/sellers/${sellerId}`;

    const removed = [
      ['PATCH seller', () => api().patch(base).send({ name: 'Renamed Seller' })],
      ['PUT profile', () => api().put(`${base}/onboarding/profile`).send(adminProfileBody())],
      ['PUT bank-detail', () => api().put(`${base}/onboarding/bank-detail`).send(adminBankBody())],
      ['POST document', () => api().post(`${base}/onboarding/documents`).send({ type: 'PAN_CARD', documentNumber: RAW_PAN })],
    ] as const;
    for (const [label, call] of removed) {
      expect((await call().set('Authorization', bearer(token))).status, label).toBe(404);
    }

    expect(await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).toMatchObject({ name: 'Read Only Seller' });
    expect(await prisma.sellerProfile.count({ where: { sellerId } })).toBe(0);
    expect(await prisma.sellerBankDetail.count({ where: { sellerId } })).toBe(0);
    expect(await prisma.sellerDocument.count({ where: { sellerId } })).toBe(0);
  });
});


/* -------------------------------------------------------------------------- */
/* Bank verification                                                          */
/* -------------------------------------------------------------------------- */

describe('bank verification', () => {
  const verify = (token: string, sellerId: string, body: unknown) =>
    api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/bank-detail/verify`)
      .set('Authorization', bearer(token))
      .send(body as object);
  /** What the admin actually looked at: the masked overview. */
  const review = async (token: string, sellerId: string) => reviewedBank(await getDetail(token, sellerId));

  it('every edit leaves the account unverified — including one that was verified', async () => {
    // Bank details are edited only by the seller (admin onboarding is read-only).
    const sellerId = await seedSellerWithOwner('9500000270', 'Reset Verify Seller');
    await seedCompleteOnboarding(sellerId);
    await prisma.sellerBankDetail.update({ where: { sellerId }, data: { isVerified: true } });

    await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(await loginSeller('9500000270')))
      .send(adminBankBody())
      .expect(200);
    expect((await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } })).isVerified).toBe(false);

    const [entry] = await auditRows('seller_bank_detail.update');
    expect(entry!.after).toMatchObject({ source: 'SELLER', verificationReset: true, isVerified: false });
  });

  it('verifies the reviewed account, audited, and responds masked', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Verify Seller' });
    await seedCompleteOnboarding(sellerId);
    const bank = await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } });

    const reviewed = await review(token, sellerId);
    expect(reviewed).toEqual({ bankDetailId: bank.id, expectedUpdatedAt: bank.updatedAt.toISOString() });

    const res = await verify(token, sellerId, reviewed).expect(200);
    const data = expectSuccess<AdminSellerOnboardingSummaryDto>(res.body).data;
    expect(data.bankDetail).toMatchObject({ isVerified: true, accountNumber: '********6789' });
    expectNoRawPii(res.body);
    expect((await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } })).isVerified).toBe(true);

    const entries = await auditRows('seller_bank_detail.verify');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: await adminUserId(),
      entityType: 'SellerBankDetail',
      entityId: bank.id,
      before: { isVerified: false },
      after: { sellerId, isVerified: true, accountNumberMasked: '********6789' },
    });

    // Verification does not move the data version, so retrying the same
    // request is a no-op — not a 409 and not a second audit entry.
    expect(data.bankDetail!.updatedAt).toBe(reviewed.expectedUpdatedAt);
    await verify(token, sellerId, reviewed).expect(200);
    expect(await auditRows('seller_bank_detail.verify')).toHaveLength(1);
  });

  it('is 409 — and verifies nothing — when the seller changed the account after the admin reviewed it', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9500000240', 'Stale Verify Seller');
    await seedCompleteOnboarding(sellerId);

    // Admin reviews the account ending 6789 …
    const reviewed = await review(token, sellerId);

    // … the seller then switches to one ending 4321 …
    const sellerToken = await loginSeller('9500000240');
    await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(sellerToken))
      .send(adminBankBody())
      .expect(200);

    // … and the admin's verify, based on the old review, is refused.
    const res = await verify(token, sellerId, reviewed);
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    expect((await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } })).isVerified).toBe(false);
    expect(await auditRows('seller_bank_detail.verify')).toHaveLength(0);

    // After re-reviewing the new account, verification works.
    const fresh = await review(token, sellerId);
    const ok = await verify(token, sellerId, fresh).expect(200);
    expect(expectSuccess<AdminSellerOnboardingSummaryDto>(ok.body).data.bankDetail).toMatchObject({
      isVerified: true,
      accountNumber: '********4321',
    });
  });

  it('is 409 even when the new account shares the last 4 digits (why last-4 is not the token)', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9500000271', 'Same Last4 Seller');
    await seedCompleteOnboarding(sellerId); // …6789
    const reviewed = await review(token, sellerId);

    // The seller changes the account after the admin reviewed it.
    await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(await loginSeller('9500000271')))
      .send(adminBankBody({ accountNumber: '999999996789' }))
      .expect(200);

    expect((await verify(token, sellerId, reviewed)).status).toBe(409);
    expect((await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } })).isVerified).toBe(false);
  });

  it("is 409 for another seller's bank detail id, and verifies neither account", async () => {
    const token = await loginAdmin();
    const sellerA = await seedSeller({ name: 'Bank Owner A' });
    const sellerB = await seedSeller({ name: 'Bank Owner B' });
    await seedCompleteOnboarding(sellerA);
    await seedCompleteOnboarding(sellerB);

    const res = await verify(token, sellerB, await review(token, sellerA));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(RAW_ACCOUNT);
    expect(await prisma.sellerBankDetail.count({ where: { isVerified: true } })).toBe(0);
  });

  it('never carries a full account number in the verify request, response or audit entry', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Verify Leak Seller' });
    await seedCompleteOnboarding(sellerId);

    const reviewed = await review(token, sellerId);
    // The request is the row id and a timestamp — no account digits at all.
    expect(Object.keys(reviewed).sort()).toEqual(['bankDetailId', 'expectedUpdatedAt']);
    expect(JSON.stringify(reviewed)).not.toContain(RAW_ACCOUNT);

    const res = await verify(token, sellerId, reviewed).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(RAW_ACCOUNT);
    expect(JSON.stringify(await auditRows('seller_bank_detail.verify'))).not.toContain(RAW_ACCOUNT);
  });

  it('cannot be set by the client: isVerified in any body is refused or ignored', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9500000210', 'Client Verify Seller');

    // The verify endpoint accepts the reviewed id/version only — strict.
    expect((await verify(token, sellerId, { isVerified: true })).status).toBe(400);
    expect(
      (
        await verify(token, sellerId, {
          bankDetailId: randomUUID(),
          expectedUpdatedAt: new Date().toISOString(),
          isVerified: true,
        })
      ).status,
    ).toBe(400);

    // The seller's own route strips it, as it always has.
    const sellerToken = await loginSeller('9500000210');
    await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(sellerToken))
      .send(adminBankBody({ isVerified: true }))
      .expect(200);
    expect((await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } })).isVerified).toBe(false);
  });

  it('is NOT_FOUND without bank details, or for a deleted seller', async () => {
    const token = await loginAdmin();
    const noBank = await seedSeller({ name: 'No Bank Seller' });
    const deleted = await seedSeller({ name: 'Deleted Verify Seller', deletedAt: new Date() });
    await prisma.sellerBankDetail.create({
      data: { sellerId: deleted, accountHolderName: 'Deleted', accountNumber: RAW_ACCOUNT, ifscCode: 'HDFC0000001' },
    });

    const anyVersion = { bankDetailId: randomUUID(), expectedUpdatedAt: new Date().toISOString() };
    expect((await verify(token, noBank, anyVersion)).status).toBe(404);
    expect((await verify(token, deleted, anyVersion)).status).toBe(404);
    expect((await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId: deleted } })).isVerified).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Seller-side profile/bank changes are audited                              */
/* -------------------------------------------------------------------------- */

describe('seller-side onboarding changes', () => {
  it('an APPROVED seller changing its bank account: unverified, audited (masked), flagged for admin', async () => {
    const sellerId = await seedSellerWithOwner('9500000220', 'Approved Payout Seller');
    await prisma.seller.update({ where: { id: sellerId }, data: sellerLifecycleFields('APPROVED') });
    await seedCompleteOnboarding(sellerId);
    await prisma.sellerBankDetail.update({ where: { sellerId }, data: { isVerified: true } });
    const bank = await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } });

    const token = await loginSeller('9500000220');
    const res = await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(token))
      .send(adminBankBody())
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain(NEW_RAW_ACCOUNT);
    expect((await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } })).isVerified).toBe(false);

    const entries = await auditRows('seller_bank_detail.update');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entityType: 'SellerBankDetail',
      entityId: bank.id,
      before: { accountNumberMasked: '********6789', isVerified: true },
      after: {
        sellerId,
        source: 'SELLER',
        created: false,
        verificationReset: true,
        approvedSeller: true,
        isVerified: false,
        accountNumberMasked: '********4321',
      },
    });
    expect((entries[0]!.after as { changedFields: string[] }).changedFields).toEqual(
      expect.arrayContaining(['accountHolderName', 'accountNumber', 'ifscCode']),
    );

    // There is no bank-change notification type in the V2 schema (adding one
    // needs a migration), so nothing is sent — and no notification anywhere
    // carries an account number.
    const notifications = JSON.stringify(await prisma.notification.findMany());
    expect(notifications).not.toContain(RAW_ACCOUNT);
    expect(notifications).not.toContain(NEW_RAW_ACCOUNT);
  });

  it("the seller's own profile changes are audited, PAN/Aadhaar by field name only", async () => {
    const sellerId = await seedSellerWithOwner('9500000221', 'Profile Audit Seller');
    const token = await loginSeller('9500000221');
    // The seller route validates Aadhaar (12 digits, first digit 2-9), which
    // the RAW_AADHAAR fixture predates.
    const validAadhaar = '234567890123';

    await api()
      .put('/api/v1/seller/onboarding/profile')
      .set('Authorization', bearer(token))
      .send(adminProfileBody({ aadhaarNumber: validAadhaar }))
      .expect(200);
    await api()
      .put('/api/v1/seller/onboarding/profile')
      .set('Authorization', bearer(token))
      .send(adminProfileBody({ aadhaarNumber: validAadhaar, panNumber: 'ZZZZZ9999Z' }))
      .expect(200);

    const entries = await auditRows('seller_profile.update');
    expect(entries).toHaveLength(2);
    expect(entryWhere(entries, true).after).toMatchObject({ sellerId, source: 'SELLER', created: true });
    expect(entryWhere(entries, false).after).toMatchObject({
      source: 'SELLER',
      created: false,
      changedFields: ['panNumber'],
    });
    expectNoRawPii(entries);
    expect(JSON.stringify(entries)).not.toContain('ZZZZZ9999Z');
    expect(JSON.stringify(entries)).not.toContain(validAadhaar);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /admin/sellers/:sellerId/products and /listings                        */
/* -------------------------------------------------------------------------- */

describe("admin view of a seller's catalogue", () => {
  it("lists the seller's products with listing, approval state and last rejection", async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Catalogue Seller' });
    const seeded = await seedSellerProduct(sellerId, 'Catalogue Atta');
    await seedApprovalBatch(sellerId, await adminUserId(), seeded.productId, {
      status: 'REJECTED',
      reviewNote: 'Blurry photo',
    });

    const res = await api().get(`/api/v1/admin/sellers/${sellerId}/products`).set('Authorization', bearer(token)).expect(200);
    const products = expectSuccess<SellerProductDto[]>(res.body).data;
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      id: seeded.productId,
      name: 'Catalogue Atta',
      submittedBySellerId: sellerId,
      approvalStatus: 'APPROVED',
      listing: { id: seeded.storeVariantId, mrpPaise: 6000, pricePaise: 5000, stockQty: 7, isAvailable: true },
      lastRejectionReason: 'Blurry photo',
    });
    expect(typeof products[0]!.createdAt).toBe('string');
  });

  it("lists the seller's listings with price, MRP, stock and availability", async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Listing Seller' });
    const seeded = await seedSellerProduct(sellerId, 'Listing Rice');

    const res = await api().get(`/api/v1/admin/sellers/${sellerId}/listings`).set('Authorization', bearer(token)).expect(200);
    const listings = expectSuccess<SellerListingDto[]>(res.body).data;
    expect(listings).toEqual([
      expect.objectContaining({
        id: seeded.storeVariantId,
        sellerId,
        productId: seeded.productId,
        productName: 'Listing Rice',
        approvalStatus: 'APPROVED',
        mrpPaise: 6000,
        pricePaise: 5000,
        stockQty: 7,
        availableQty: 7,
        isAvailable: true,
      }),
    ]);
  });

  it("never mixes in another seller's products or listings", async () => {
    const token = await loginAdmin();
    const sellerA = await seedSeller({ name: 'Catalogue Seller A' });
    const sellerB = await seedSeller({ name: 'Catalogue Seller B' });
    const a = await seedSellerProduct(sellerA, 'Seller A Dal');
    const b = await seedSellerProduct(sellerB, 'Seller B Dal');

    const listings = expectSuccess<SellerListingDto[]>(
      (await api().get(`/api/v1/admin/sellers/${sellerA}/listings`).set('Authorization', bearer(token)).expect(200)).body,
    ).data;
    expect(listings.map((l) => l.id)).toEqual([a.storeVariantId]);
    expect(listings.every((l) => l.sellerId === sellerA)).toBe(true);

    const productsRes = await api().get(`/api/v1/admin/sellers/${sellerA}/products`).set('Authorization', bearer(token)).expect(200);
    const products = expectSuccess<SellerProductDto[]>(productsRes.body).data;
    expect(products.map((p) => p.id)).toEqual([a.productId]);
    expect(JSON.stringify(productsRes.body)).not.toContain(b.productId);
    expect(JSON.stringify(productsRes.body)).not.toContain(b.storeVariantId);
  });

  it('is NOT_FOUND for a deleted seller', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Deleted Catalogue Seller', deletedAt: new Date() });
    await seedSellerProduct(sellerId, 'Deleted Seller Sugar');

    for (const path of ['listings', 'products']) {
      const res = await api().get(`/api/v1/admin/sellers/${sellerId}/${path}`).set('Authorization', bearer(token));
      expect(res.status).toBe(404);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* GET /admin/approval-batches?sellerId=                                      */
/* -------------------------------------------------------------------------- */

describe('approval batch sellerId filter', () => {
  async function seedTwoSellersWithBatches() {
    const token = await loginAdmin();
    const submitter = await adminUserId();
    const sellerA = await seedSeller({ name: 'Batch Seller A' });
    const sellerB = await seedSeller({ name: 'Batch Seller B' });
    const batchA = await seedApprovalBatch(sellerA, submitter, (await seedSellerProduct(sellerA, 'Batch A Oil')).productId);
    const batchB = await seedApprovalBatch(sellerB, submitter, (await seedSellerProduct(sellerB, 'Batch B Oil')).productId);
    return { token, sellerA, batchA, batchB };
  }

  const listBatches = async (token: string, query: string) =>
    expectSuccess<CursorPage<ProductApprovalBatchSummaryDto>>(
      (await api().get(`/api/v1/admin/approval-batches${query}`).set('Authorization', bearer(token)).expect(200)).body,
    ).data;

  it("returns only that seller's batches", async () => {
    const { token, sellerA, batchA } = await seedTwoSellersWithBatches();

    const page = await listBatches(token, `?sellerId=${sellerA}`);
    expect(page.items.map((b) => b.id)).toEqual([batchA.id]);
    expect(page.items.every((b) => b.sellerId === sellerA)).toBe(true);

    // Combines with the existing status filter.
    expect((await listBatches(token, `?sellerId=${sellerA}&status=PENDING`)).items).toHaveLength(1);
    expect((await listBatches(token, `?sellerId=${sellerA}&status=APPROVED`)).items).toHaveLength(0);
    // An unknown seller matches nothing; a malformed id is a 400.
    expect((await listBatches(token, `?sellerId=${randomUUID()}`)).items).toHaveLength(0);
    const bad = await api().get('/api/v1/admin/approval-batches?sellerId=not-a-uuid').set('Authorization', bearer(token));
    expect(bad.status).toBe(400);
  });

  it('without sellerId, behaves exactly as before (every seller)', async () => {
    const { token, batchA, batchB } = await seedTwoSellersWithBatches();

    const page = await listBatches(token, '');
    expect(page.items.map((b) => b.id).sort()).toEqual([batchA.id, batchB.id].sort());
    expect(page.hasMore).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 2 security                                                            */
/* -------------------------------------------------------------------------- */

describe('Step 2 security', () => {
  it('a seller token is 403 on every Step 2 admin endpoint, and nothing changes', async () => {
    const sellerId = await seedSellerWithOwner('9500000230', 'Forbidden Seller');
    const token = await loginSeller('9500000230');

    for (const [label, call] of step2Calls(sellerId)) {
      const res = await call().set('Authorization', bearer(token));
      expect(res.status, label).toBe(403);
      expect(expectError(res.body).code, label).toBe(ErrorCode.FORBIDDEN);
    }
    expect(await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).toMatchObject({
      isActive: true,
      name: 'Forbidden Seller',
    });
    expect(await prisma.sellerProfile.count()).toBe(0);
    expect(await prisma.sellerBankDetail.count()).toBe(0);
  });

  it('admin STAFF (no seller-management permission) is 403 on every Step 2 admin endpoint', async () => {
    const sellerId = await seedSeller({ name: 'Staff Forbidden Seller' });
    const staffToken = await loginStaffUser(STAFF, UserRole.STAFF, '0000000002');

    for (const [label, call] of step2Calls(sellerId)) {
      expect((await call().set('Authorization', bearer(staffToken))).status, label).toBe(403);
    }
  });

  it('a tampered or unknown seller id reveals nothing: the same 404 everywhere', async () => {
    const token = await loginAdmin();
    await seedSeller({ name: 'Real Seller' });

    for (const [label, call] of step2Calls(randomUUID())) {
      const res = await call().set('Authorization', bearer(token));
      expect(res.status, label).toBe(404);
      expect(expectError(res.body).code, label).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it('never returns a full bank account number from any admin read or write', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'No Leak Seller' });
    await seedCompleteOnboarding(sellerId);

    const bankPut = (
      await api()
        .put(`/api/v1/admin/sellers/${sellerId}/onboarding/bank-detail`)
        .set('Authorization', bearer(token))
        .send(adminBankBody())
        .expect(200)
    ).body;
    const reviewed = reviewedBank(expectSuccess<AdminSellerOnboardingSummaryDto>(bankPut).data);

    const bodies = [
      bankPut,
      (await api().patch(`/api/v1/admin/sellers/${sellerId}/onboarding/bank-detail/verify`).set('Authorization', bearer(token)).send(reviewed).expect(200)).body,
      (await api().post(`/api/v1/admin/sellers/${sellerId}/onboarding/documents`).set('Authorization', bearer(token)).send({ type: 'AADHAAR_CARD', fileUrl: 'https://files.adione.test/leak-check.pdf' }).expect(201)).body,
      (await api().put(`/api/v1/admin/sellers/${sellerId}/onboarding/profile`).set('Authorization', bearer(token)).send(adminProfileBody()).expect(200)).body,
      (await api().patch(`/api/v1/admin/sellers/${sellerId}`).set('Authorization', bearer(token)).send({ name: 'No Leak Seller 2' }).expect(200)).body,
      (await api().patch(`/api/v1/admin/sellers/${sellerId}/status`).set('Authorization', bearer(token)).send({ isActive: false, reason: 'Leak check' }).expect(200)).body,
      (await api().get(`/api/v1/admin/sellers/${sellerId}`).set('Authorization', bearer(token)).expect(200)).body,
      (await api().get('/api/v1/admin/sellers').set('Authorization', bearer(token)).expect(200)).body,
      (await api().get('/api/v1/admin/sellers/onboarding').set('Authorization', bearer(token)).expect(200)).body,
    ];
    for (const body of bodies) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(NEW_RAW_ACCOUNT);
      expect(text).not.toContain(RAW_ACCOUNT);
    }
  });

  it('the four onboarding saves respond with the masked summary — no document links, no raw PAN/Aadhaar/account', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Save Response Seller' });
    await seedCompleteOnboarding(sellerId); // raw PAN/Aadhaar/account + a document at SECRET_DOC_URL
    const newDocUrl = 'https://files.adione.test/save-response-check.pdf';
    const base = `/api/v1/admin/sellers/${sellerId}/onboarding`;

    const profile = await api().put(`${base}/profile`).set('Authorization', bearer(token)).send(adminProfileBody()).expect(200);
    const bank = await api().put(`${base}/bank-detail`).set('Authorization', bearer(token)).send(adminBankBody()).expect(200);
    const verified = await api()
      .patch(`${base}/bank-detail/verify`)
      .set('Authorization', bearer(token))
      .send(reviewedBank(expectSuccess<AdminSellerOnboardingSummaryDto>(bank.body).data))
      .expect(200);
    const document = await api()
      .post(`${base}/documents`)
      .set('Authorization', bearer(token))
      .send({ type: 'AADHAAR_CARD', fileUrl: newDocUrl })
      .expect(201);
    const summaryKeys = Object.keys(
      expectSuccess<AdminSellerOnboardingSummaryDto>((await api().get(`${base}/summary`).set('Authorization', bearer(token)).expect(200)).body).data,
    ).sort();

    for (const [label, res] of [['profile', profile], ['bank-detail', bank], ['verify', verified], ['documents', document]] as const) {
      const text = JSON.stringify(res.body);
      expect(text, label).not.toContain(SECRET_DOC_URL);
      expect(text, label).not.toContain(newDocUrl);
      expect(text, label).not.toContain('"fileUrl"');
      expect(text, label).not.toContain(NEW_RAW_ACCOUNT);
      expectNoRawPii(res.body);
      const data = expectSuccess<AdminSellerOnboardingSummaryDto>(res.body).data;
      expect(Object.keys(data).sort(), label).toEqual(summaryKeys);
      expect(data.documents.length, label).toBeGreaterThan(0);
    }
    expect(expectSuccess<AdminSellerOnboardingSummaryDto>(document.body).data.documents.map((d) => d.type)).toContain('AADHAAR_CARD');
    // The links are still stored — and only the reviewer's own read shows them.
    expect(await prisma.sellerDocument.count({ where: { sellerId, fileUrl: newDocUrl } })).toBe(1);
    const review = await api().get(base).set('Authorization', bearer(token)).expect(200);
    expect(JSON.stringify(review.body)).toContain(newDocUrl);
  });

  it('never writes a full bank account number (or PAN/Aadhaar) into the audit log', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9500000231', 'Audit Leak Seller');
    await seedCompleteOnboarding(sellerId);

    await api().put(`/api/v1/admin/sellers/${sellerId}/onboarding/profile`).set('Authorization', bearer(token)).send(adminProfileBody()).expect(200);
    const bankPut = await api()
      .put(`/api/v1/admin/sellers/${sellerId}/onboarding/bank-detail`)
      .set('Authorization', bearer(token))
      .send(adminBankBody())
      .expect(200);
    await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/bank-detail/verify`)
      .set('Authorization', bearer(token))
      .send(reviewedBank(expectSuccess<AdminSellerOnboardingSummaryDto>(bankPut.body).data))
      .expect(200);
    await api()
      .post(`/api/v1/admin/sellers/${sellerId}/onboarding/documents`)
      .set('Authorization', bearer(token))
      .send({ type: 'PAN_CARD', fileUrl: 'https://files.adione.test/audit-leak-check.pdf' })
      .expect(201);
    const sellerToken = await loginSeller('9500000231');
    await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(sellerToken))
      .send(adminBankBody({ accountNumber: RAW_ACCOUNT }))
      .expect(200);

    const allAudit = await prisma.auditLog.findMany();
    expect(allAudit.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(allAudit);
    expect(text).not.toContain(RAW_ACCOUNT);
    expect(text).not.toContain(NEW_RAW_ACCOUNT);
    expect(text).not.toContain(RAW_PAN);
    expect(text).not.toContain(RAW_AADHAAR);
    // Document entries record type/status only — never the link.
    expect(text).not.toContain('audit-leak-check.pdf');
  });
});

/* -------------------------------------------------------------------------- */
/* STEP 4.5 — GET /admin/sellers/:sellerId/onboarding/summary (masked read)   */
/* -------------------------------------------------------------------------- */

describe('masked onboarding summary', () => {
  const summaryPath = (sellerId: string) => `/api/v1/admin/sellers/${sellerId}/onboarding/summary`;
  const getSummary = async (token: string, sellerId: string) => {
    const res = await api().get(summaryPath(sellerId)).set('Authorization', bearer(token)).expect(200);
    return { res, data: expectSuccess<AdminSellerOnboardingSummaryDto>(res.body).data };
  };

  it('returns the masked onboarding record: masked PAN/Aadhaar/account, bank id + updatedAt, document metadata', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Summary Seller', sellerType: 'RESTAURANT' });
    const documentId = await seedCompleteOnboarding(sellerId);
    const bank = await prisma.sellerBankDetail.findUniqueOrThrow({ where: { sellerId } });

    const { data } = await getSummary(token, sellerId);
    expect(data).toMatchObject({
      sellerId,
      sellerName: 'Summary Seller',
      sellerType: 'RESTAURANT',
      onboardingStatus: 'PENDING',
      stage: 'SUBMITTED',
      isComplete: true,
      requirements: { profile: true, bankDetail: true, identityDocument: true },
      lastRejectionReason: null,
      lastRejectedAt: null,
      profile: { businessName: 'QA Directory Business (DEV)', panNumber: 'ABC******F', aadhaarNumber: '123********2' },
      bankDetail: {
        id: bank.id,
        updatedAt: bank.updatedAt.toISOString(),
        accountNumber: '********6789',
        ifscCode: 'HDFC0000001',
        isVerified: false,
      },
    });
    expect(data.documents).toEqual([
      {
        id: documentId,
        type: 'PAN_CARD',
        status: 'PENDING',
        rejectionReason: null,
        expiresAt: null,
        createdAt: expect.any(String),
        reviewedAt: null,
      },
    ]);
  });

  it('never carries full PAN, Aadhaar, account number or any document link', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Summary Leak Seller' });
    await seedCompleteOnboarding(sellerId);

    const { res } = await getSummary(token, sellerId);
    const text = JSON.stringify(res.body);
    expectNoRawPii(res.body);
    expect(text).not.toContain(SECRET_DOC_URL);
    expect(text).not.toContain('fileUrl');
    expect(text).not.toContain('files.adione.test');
  });

  it('reports what is missing, straight from the completeness rule', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Summary Empty Seller' });

    const { data } = await getSummary(token, sellerId);
    expect(data).toMatchObject({
      stage: 'PENDING',
      isComplete: false,
      requirements: { profile: false, bankDetail: false, identityDocument: false },
      profile: null,
      bankDetail: null,
      documents: [],
    });
  });

  it('returns review metadata and rejection reasons (document and onboarding)', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Summary Review Seller', lifecycleStatus: 'ONBOARDING_PENDING_REVIEW' });
    const documentId = await seedCompleteOnboarding(sellerId);

    await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/documents/${documentId}/review`)
      .set('Authorization', bearer(token))
      .send({ status: 'REJECTED', rejectionReason: 'Photo is blurry' })
      .expect(200);
    await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/verification/review`)
      .set('Authorization', bearer(token))
      .send({ decision: 'REJECT', reason: 'Identity document rejected' })
      .expect(200);

    const { data } = await getSummary(token, sellerId);
    expect(data).toMatchObject({
      onboardingStatus: 'REJECTED',
      lifecycleStatus: 'ONBOARDING_REJECTED',
      stage: 'REJECTED',
      lastRejectionReason: 'Identity document rejected',
      // The only identity document is rejected, so that requirement is unmet.
      requirements: { identityDocument: false },
    });
    expect(data.lastRejectedAt).not.toBeNull();
    expect(data.documents[0]).toMatchObject({ id: documentId, status: 'REJECTED', rejectionReason: 'Photo is blurry' });
    expect(data.documents[0]!.reviewedAt).not.toBeNull();
  });

  it('is admin-only: a seller token and admin STAFF both get 403', async () => {
    const sellerId = await seedSellerWithOwner('9500000260', 'Summary Forbidden Seller');
    const sellerRes = await api().get(summaryPath(sellerId)).set('Authorization', bearer(await loginSeller('9500000260')));
    expect(sellerRes.status).toBe(403);
    expect(expectError(sellerRes.body).code).toBe(ErrorCode.FORBIDDEN);

    const staffToken = await loginStaffUser(STAFF, UserRole.STAFF, '0000000002');
    expect((await api().get(summaryPath(sellerId)).set('Authorization', bearer(staffToken))).status).toBe(403);
  });

  it('is 404 for an unknown or deleted seller, and 400 for a malformed id', async () => {
    const token = await loginAdmin();
    const deleted = await seedSeller({ name: 'Summary Deleted Seller', deletedAt: new Date() });
    await seedCompleteOnboarding(deleted);

    const unknown = await api().get(summaryPath(randomUUID())).set('Authorization', bearer(token));
    expect(unknown.status).toBe(404);
    const gone = await api().get(summaryPath(deleted)).set('Authorization', bearer(token));
    expect(gone.status).toBe(404);
    expect(JSON.stringify(gone.body)).not.toContain(RAW_ACCOUNT);
    const malformed = await api().get('/api/v1/admin/sellers/not-a-uuid/onboarding/summary').set('Authorization', bearer(token));
    expect(malformed.status).toBe(400);
  });

  it("never returns another seller's data for a tampered id", async () => {
    const token = await loginAdmin();
    const sellerA = await seedSeller({ name: 'Summary Seller A' });
    await seedCompleteOnboarding(sellerA);
    const sellerB = await seedSeller({ name: 'Summary Seller B' });

    const { data } = await getSummary(token, sellerB);
    expect(data).toMatchObject({ sellerId: sellerB, profile: null, bankDetail: null, documents: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* Deleted-seller hardening on the existing review paths                      */
/* -------------------------------------------------------------------------- */

describe('deleted sellers on the existing onboarding review paths', () => {
  it('are never queued, cannot be reviewed, and their onboarding detail is NOT_FOUND', async () => {
    const token = await loginAdmin();
    const sellerId = await seedSeller({ name: 'Deleted Review Seller', deletedAt: new Date() });
    const documentId = await seedCompleteOnboarding(sellerId);

    const queue = await api().get('/api/v1/admin/sellers/onboarding').set('Authorization', bearer(token)).expect(200);
    expect(expectSuccess<{ items: { sellerId: string }[] }>(queue.body).data.items.map((i) => i.sellerId)).not.toContain(
      sellerId,
    );

    const detail = await api().get(`/api/v1/admin/sellers/${sellerId}/onboarding`).set('Authorization', bearer(token));
    expect(detail.status).toBe(404);

    const review = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(token))
      .send({ status: 'APPROVED' });
    expect(review.status).toBe(404);

    const docReview = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/documents/${documentId}/review`)
      .set('Authorization', bearer(token))
      .send({ status: 'VERIFIED' });
    expect(docReview.status).toBe(404);

    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.onboardingStatus).toBe('PENDING');
    expect((await prisma.sellerDocument.findUniqueOrThrow({ where: { id: documentId } })).status).toBe('PENDING');
  });
});
