/**
 * Admin-only SellerListing creation for an existing, already-approved
 * ProductVariant — POST /admin/sellers/:sellerId/listings.
 *
 * Deliberately not exercising `createVariant` (admin-catalog.service.ts) —
 * that always targets the platform seller. This suite is only about the
 * separate, seller-parameterised path in admin-seller-catalog.service.ts.
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
import { seedProduct, seedStore } from '../helpers/fixtures';

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

/** A second, non-platform seller — distinct from `seedStore()`'s platform
 * seller, and never onboarding-approved, to prove that isn't a gate here. */
async function seedOtherSeller(overrides: Record<string, unknown> = {}): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `OTHER-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'QA Test Seller (DEV)',
      isPlatformOwned: false,
      onboardingStatus: 'PENDING',
      addressLine: 'Test Address',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...overrides,
    },
  });
  return seller.id;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('POST /admin/sellers/:sellerId/listings', () => {
  it('creates a listing for a valid seller and an approved product variant', async () => {
    const token = await loginAdmin();
    const platformSellerId = await seedStore();
    const product = await seedProduct(platformSellerId, {});
    const otherSellerId = await seedOtherSeller();

    const res = await api()
      .post(`/api/v1/admin/sellers/${otherSellerId}/listings`)
      .set('Authorization', bearer(token))
      .send({ variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500, stockQty: 10 })
      .expect(201);

    const data = expectSuccess<{
      id: string;
      sellerId: string;
      variantId: string;
      pricePaise: number;
      stockQty: number;
      isAvailable: boolean;
    }>(res.body).data;

    expect(data.sellerId).toBe(otherSellerId);
    expect(data.variantId).toBe(product.variantId);
    expect(data.pricePaise).toBe(2500);
    expect(data.stockQty).toBe(10);
    expect(data.isAvailable).toBe(true);

    const stored = await prisma.sellerListing.findUniqueOrThrow({ where: { id: data.id } });
    expect(stored.sellerId).toBe(otherSellerId);
    expect(stored.variantId).toBe(product.variantId);

    // Never touches the platform seller's own listing for the same variant.
    const platformListing = await prisma.sellerListing.findUnique({
      where: { sellerId_variantId: { sellerId: platformSellerId, variantId: product.variantId } },
    });
    expect(platformListing?.sellerId).toBe(platformSellerId);
  });

  it('rejects a duplicate (sellerId, variantId) listing rather than updating it', async () => {
    const token = await loginAdmin();
    const platformSellerId = await seedStore();
    const product = await seedProduct(platformSellerId, {});
    const otherSellerId = await seedOtherSeller();

    await api()
      .post(`/api/v1/admin/sellers/${otherSellerId}/listings`)
      .set('Authorization', bearer(token))
      .send({ variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500 })
      .expect(201);

    const res = await api()
      .post(`/api/v1/admin/sellers/${otherSellerId}/listings`)
      .set('Authorization', bearer(token))
      // Different price — if this silently updated, the original would change.
      .send({ variantId: product.variantId, mrpPaise: 5000, pricePaise: 4000 });

    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);

    const listings = await prisma.sellerListing.findMany({
      where: { sellerId: otherSellerId, variantId: product.variantId },
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]!.pricePaise).toBe(2500); // untouched by the rejected second call
  });

  it('rejects a nonexistent seller', async () => {
    const token = await loginAdmin();
    const platformSellerId = await seedStore();
    const product = await seedProduct(platformSellerId, {});

    const res = await api()
      .post(`/api/v1/admin/sellers/${randomUUID()}/listings`)
      .set('Authorization', bearer(token))
      .send({ variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500 });

    expect(res.status).toBe(404);
    expect(expectError(res.body).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('rejects a nonexistent product variant', async () => {
    const token = await loginAdmin();
    const otherSellerId = await seedOtherSeller();

    const res = await api()
      .post(`/api/v1/admin/sellers/${otherSellerId}/listings`)
      .set('Authorization', bearer(token))
      .send({ variantId: randomUUID(), mrpPaise: 3000, pricePaise: 2500 });

    expect(res.status).toBe(404);
    expect(expectError(res.body).code).toBe(ErrorCode.NOT_FOUND);
    expect(await prisma.sellerListing.count()).toBe(0);
  });

  it('rejects a variant whose product has not been approved', async () => {
    const token = await loginAdmin();
    const platformSellerId = await seedStore();
    const product = await seedProduct(platformSellerId, {});
    await prisma.product.update({
      where: { id: product.productId },
      data: { approvalStatus: 'PENDING' },
    });
    const otherSellerId = await seedOtherSeller();

    const res = await api()
      .post(`/api/v1/admin/sellers/${otherSellerId}/listings`)
      .set('Authorization', bearer(token))
      .send({ variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500 });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await prisma.sellerListing.count({ where: { sellerId: otherSellerId } })).toBe(0);
  });

  it('refuses a non-admin caller', async () => {
    const platformSellerId = await seedStore();
    const product = await seedProduct(platformSellerId, {});
    const otherSellerId = await seedOtherSeller();

    await otpService.clearOtpState('9812340000');
    const customer = await loginAs('9812340000');

    const res = await api()
      .post(`/api/v1/admin/sellers/${otherSellerId}/listings`)
      .set('Authorization', bearer(customer.accessToken))
      .send({ variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500 });

    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
    expect(await prisma.sellerListing.count({ where: { sellerId: otherSellerId } })).toBe(0);
  });
});
