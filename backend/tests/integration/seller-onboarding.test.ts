/**
 * Seller onboarding — business profile, bank details, documents, and the
 * admin review decision that moves `Seller.onboardingStatus`.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

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

async function seedSellerWithOwner(mobile: string, name: string): Promise<string> {
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
    },
  });
  const user = await prisma.user.create({
    data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER },
  });
  await prisma.sellerStaff.create({
    data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true },
  });
  return seller.id;
}

async function loginSeller(mobile: string): Promise<string> {
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  return session.accessToken;
}

function profileBody(overrides: Record<string, unknown> = {}) {
  return {
    businessName: 'QA Onboarding Business (DEV)',
    ownerFullName: 'QA Onboarding Owner (DEV)',
    ownerMobile: '9500000001',
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

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('seller profile / bank details', () => {
  it('creates and updates its own profile and bank details', async () => {
    const sellerId = await seedSellerWithOwner('9500000010', 'Onboarding Seller A');
    const token = await loginSeller('9500000010');

    const put1 = await api()
      .put('/api/v1/seller/onboarding/profile')
      .set('Authorization', bearer(token))
      .send(profileBody())
      .expect(200);
    expect(expectSuccess<{ profile: { businessName: string } }>(put1.body).data.profile!.businessName).toBe(
      'QA Onboarding Business (DEV)',
    );

    const put2 = await api()
      .put('/api/v1/seller/onboarding/profile')
      .set('Authorization', bearer(token))
      .send(profileBody({ businessName: 'Renamed Business (DEV)' }))
      .expect(200);
    expect(expectSuccess<{ profile: { businessName: string } }>(put2.body).data.profile!.businessName).toBe(
      'Renamed Business (DEV)',
    );

    // exactly one profile row, not a duplicate
    expect(await prisma.sellerProfile.count({ where: { sellerId } })).toBe(1);

    const bank = await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(token))
      .send(bankBody())
      .expect(200);
    const bankDto = expectSuccess<{ bankDetail: { accountNumber: string; isVerified: boolean } }>(bank.body).data
      .bankDetail!;
    // Masked even for the seller's own view (see the DTO's own doc comment).
    expect(bankDto.accountNumber).not.toBe('000123456789');
    expect(bankDto.accountNumber.endsWith('6789')).toBe(true);
    expect(bankDto.isVerified).toBe(false);
  });

  it('rejects an invalid IFSC code', async () => {
    await seedSellerWithOwner('9500000011', 'Onboarding Seller Bad IFSC');
    const token = await loginSeller('9500000011');

    const res = await api()
      .put('/api/v1/seller/onboarding/bank-detail')
      .set('Authorization', bearer(token))
      .send(bankBody({ ifscCode: 'NOTVALID12' }));

    expect(res.status).toBe(400);
  });

  it("a seller cannot view or edit another seller's onboarding data", async () => {
    await seedSellerWithOwner('9500000012', 'Onboarding Seller A2');
    const tokenA = await loginSeller('9500000012');
    await api().put('/api/v1/seller/onboarding/profile').set('Authorization', bearer(tokenA)).send(profileBody()).expect(200);

    await seedSellerWithOwner('9500000013', 'Onboarding Seller B2');
    const tokenB = await loginSeller('9500000013');

    // Seller B's own GET only ever returns ITS OWN data — there is no id
    // param on the seller-facing route at all, so "isolation" here means B
    // simply never sees A's business name.
    const res = await api().get('/api/v1/seller/onboarding').set('Authorization', bearer(tokenB)).expect(200);
    expect(expectSuccess<{ profile: unknown }>(res.body).data.profile).toBeNull();
  });

  it('a customer cannot access the onboarding endpoint', async () => {
    await otpService.clearOtpState('9500000014');
    const customer = await loginAs('9500000014');

    const res = await api().get('/api/v1/seller/onboarding').set('Authorization', bearer(customer.accessToken));
    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('documents', () => {
  it('submits a document and lists it with PENDING status', async () => {
    await seedSellerWithOwner('9500000020', 'Onboarding Seller Docs');
    const token = await loginSeller('9500000020');

    const res = await api()
      .post('/api/v1/seller/onboarding/documents')
      .set('Authorization', bearer(token))
      .send({ type: 'PAN_CARD', fileUrl: 'https://files.adione.test/qa-test-pan-card.pdf' })
      .expect(201);
    expect(expectSuccess<{ status: string; type: string }>(res.body).data).toMatchObject({
      status: 'PENDING',
      type: 'PAN_CARD',
    });

    const list = await api().get('/api/v1/seller/onboarding/documents').set('Authorization', bearer(token)).expect(200);
    expect(expectSuccess<unknown[]>(list.body).data).toHaveLength(1);
  });
});

describe('onboarding submission', () => {
  it('refuses submission with no profile/bank/documents at all', async () => {
    await seedSellerWithOwner('9500000030', 'Onboarding Seller Empty');
    const token = await loginSeller('9500000030');

    const res = await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(token));
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('refuses submission missing the required identity document', async () => {
    await seedSellerWithOwner('9500000031', 'Onboarding Seller NoDoc');
    const token = await loginSeller('9500000031');
    await api().put('/api/v1/seller/onboarding/profile').set('Authorization', bearer(token)).send(profileBody()).expect(200);
    await api().put('/api/v1/seller/onboarding/bank-detail').set('Authorization', bearer(token)).send(bankBody()).expect(200);

    const res = await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(token));
    expect(res.status).toBe(400);
  });

  it('succeeds once profile, bank, and an identity document all exist', async () => {
    await seedSellerWithOwner('9500000032', 'Onboarding Seller Ready');
    const token = await loginSeller('9500000032');
    await api().put('/api/v1/seller/onboarding/profile').set('Authorization', bearer(token)).send(profileBody()).expect(200);
    await api().put('/api/v1/seller/onboarding/bank-detail').set('Authorization', bearer(token)).send(bankBody()).expect(200);
    await api()
      .post('/api/v1/seller/onboarding/documents')
      .set('Authorization', bearer(token))
      .send({ type: 'AADHAAR_CARD', fileUrl: 'https://files.adione.test/qa-test-aadhaar.pdf' })
      .expect(201);

    const res = await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(token)).expect(200);
    const data = expectSuccess<{ stage: string; onboardingStatus: string }>(res.body).data;
    expect(data.stage).toBe('SUBMITTED');
    expect(data.onboardingStatus).toBe('PENDING'); // no separate persisted SUBMITTED value -- see the service's own doc comment
  });
});

describe('admin review', () => {
  async function readySeller(mobile: string, name: string) {
    const sellerId = await seedSellerWithOwner(mobile, name);
    const token = await loginSeller(mobile);
    await api().put('/api/v1/seller/onboarding/profile').set('Authorization', bearer(token)).send(profileBody()).expect(200);
    await api().put('/api/v1/seller/onboarding/bank-detail').set('Authorization', bearer(token)).send(bankBody()).expect(200);
    await api()
      .post('/api/v1/seller/onboarding/documents')
      .set('Authorization', bearer(token))
      .send({ type: 'PAN_CARD', fileUrl: 'https://files.adione.test/qa-test-pan.pdf' })
      .expect(201);
    await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(token)).expect(200);
    return { sellerId, token };
  }

  it('lists sellers awaiting review, cross-seller', async () => {
    const adminToken = await loginAdmin();
    await readySeller('9500000040', 'Queue Seller X');
    await readySeller('9500000041', 'Queue Seller Y');

    const res = await api().get('/api/v1/admin/sellers/onboarding?limit=50').set('Authorization', bearer(adminToken)).expect(200);
    const names = expectSuccess<{ items: { sellerName: string }[] }>(res.body).data.items.map((s) => s.sellerName);
    expect(names).toContain('Queue Seller X');
    expect(names).toContain('Queue Seller Y');
  });

  it('approves a ready seller', async () => {
    const adminToken = await loginAdmin();
    const { sellerId } = await readySeller('9500000042', 'Approve Seller');

    const res = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);
    expect(expectSuccess<{ onboardingStatus: string; stage: string }>(res.body).data).toMatchObject({
      onboardingStatus: 'APPROVED',
      stage: 'APPROVED',
    });

    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.onboardingStatus).toBe('APPROVED');
  });

  it('rejects with a reason', async () => {
    const adminToken = await loginAdmin();
    const { sellerId } = await readySeller('9500000043', 'Reject Seller');

    const res = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reason: 'PAN document illegible' })
      .expect(200);
    expect(expectSuccess<{ onboardingStatus: string }>(res.body).data.onboardingStatus).toBe('REJECTED');
  });

  it('requires a reason to reject', async () => {
    const adminToken = await loginAdmin();
    const { sellerId } = await readySeller('9500000044', 'Reject NoReason Seller');

    const res = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED' });
    expect(res.status).toBe(400);
  });

  it('refuses to approve an incomplete (unready) seller even directly via admin', async () => {
    const adminToken = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9500000045', 'Incomplete Seller');
    // No profile/bank/documents at all.

    const res = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate approval and duplicate rejection', async () => {
    const adminToken = await loginAdmin();
    const { sellerId } = await readySeller('9500000046', 'Duplicate Review Seller');

    await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    const dup = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' });
    expect(dup.status).toBe(409);
    expect(expectError(dup.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);

    const flip = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reason: 'changed my mind' });
    expect(flip.status).toBe(409);
    expect(expectError(flip.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });

  it('a seller cannot submit for approval once already approved (no APPROVED -> SUBMITTED)', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await readySeller('9500000047', 'Already Approved Seller');
    await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    const res = await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(token));
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });

  it('rejected seller can resubmit, and only THEN can be approved (no REJECTED -> APPROVED shortcut)', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, token } = await readySeller('9500000048', 'Resubmit Seller');
    await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reason: 'fix your PAN scan' })
      .expect(200);

    // Direct re-approval of a REJECTED seller, skipping resubmission, is refused.
    const shortcut = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' });
    expect(shortcut.status).toBe(409);

    const resubmit = await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(token)).expect(200);
    expect(expectSuccess<{ onboardingStatus: string }>(resubmit.body).data.onboardingStatus).toBe('PENDING');

    const approve = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);
    expect(expectSuccess<{ onboardingStatus: string }>(approve.body).data.onboardingStatus).toBe('APPROVED');
  });

  it('reviews an individual document, unmasked bank details visible to admin', async () => {
    const adminToken = await loginAdmin();
    const sellerId = await seedSellerWithOwner('9500000049', 'Doc Review Seller');
    const token = await loginSeller('9500000049');
    await api().put('/api/v1/seller/onboarding/bank-detail').set('Authorization', bearer(token)).send(bankBody()).expect(200);
    const doc = await api()
      .post('/api/v1/seller/onboarding/documents')
      .set('Authorization', bearer(token))
      .send({ type: 'PAN_CARD', fileUrl: 'https://files.adione.test/qa-test-pan.pdf' })
      .expect(201);
    const documentId = expectSuccess<{ id: string }>(doc.body).data.id;

    const detail = await api()
      .get(`/api/v1/admin/sellers/${sellerId}/onboarding`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    const detailData = expectSuccess<{ bankDetail: { accountNumber: string } }>(detail.body).data;
    // Admin's own view is UNMASKED (see the DTO's own doc comment).
    expect(detailData.bankDetail!.accountNumber).toBe('000123456789');

    const review = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/documents/${documentId}/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'VERIFIED' })
      .expect(200);
    const item = expectSuccess<{ documents: { id: string; status: string }[] }>(review.body).data.documents.find(
      (d) => d.id === documentId,
    );
    expect(item?.status).toBe('VERIFIED');

    // Duplicate document review is refused.
    const dup = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/documents/${documentId}/review`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'VERIFIED' });
    expect(dup.status).toBe(409);
  });

  it('a seller cannot call the admin review endpoint', async () => {
    const { sellerId, token } = await readySeller('9500000050', 'NoAdminAccess Seller');

    const res = await api()
      .patch(`/api/v1/admin/sellers/${sellerId}/onboarding/review`)
      .set('Authorization', bearer(token))
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });
});
