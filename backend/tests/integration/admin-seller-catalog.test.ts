/**
 * Who creates a seller's listings — V2: the SELLER, in its own catalogue.
 *
 * V1 let an admin create a listing for any seller from any (platform)
 * variant (POST /admin/sellers/:sellerId/listings). Since catalogues became
 * seller-owned, that route is gone and the admin view is read-only; a seller
 * lists products under its OWN categories through POST /seller/listings.
 * These tests pin both sides of that contract.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { seedAddress, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

/** An approved, live grocery seller with its owner signed in. */
async function seedSellerWithOwner(mobile: string): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Seller ${mobile}`,
      sellerType: 'GROCERY',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken };
}

/** An approved product under a category the seller OWNS — not yet listed by anyone. */
async function ownProduct(sellerId: string): Promise<{ productId: string; variantId: string }> {
  const product = await seedProduct(sellerId, {});
  await prisma.category.update({ where: { id: product.categoryId }, data: { sellerId } });
  // seedProduct also lists it; start from an unlisted product.
  await prisma.sellerListing.delete({ where: { id: product.storeVariantId } });
  return { productId: product.productId, variantId: product.variantId };
}

const createListing = (token: string, body: object) =>
  api().post('/api/v1/seller/listings').set('Authorization', bearer(token)).send(body);

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('admin is read-only for seller catalogues', () => {
  it('cannot create a listing for a seller — and nothing is created', async () => {
    const token = await loginAdmin();
    const seller = await seedSellerWithOwner('9812340001');
    const product = await ownProduct(seller.id);

    const res = await api()
      .post(`/api/v1/admin/sellers/${seller.id}/listings`)
      .set('Authorization', bearer(token))
      .send({ variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500, stockQty: 10 });
    expect(res.status).toBe(404);
    expect(await prisma.sellerListing.count()).toBe(0);
  });

  it("can read a seller's listings", async () => {
    const token = await loginAdmin();
    const seller = await seedSellerWithOwner('9812340002');
    const product = await ownProduct(seller.id);
    await createListing(seller.token, { variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500, stockQty: 10 }).expect(201);

    const res = await api().get(`/api/v1/admin/sellers/${seller.id}/listings`).set('Authorization', bearer(token)).expect(200);
    expect(JSON.stringify(res.body)).toContain(product.variantId);
  });
});

describe('POST /seller/listings — a seller lists its own products', () => {
  it('creates a listing for its own approved product', async () => {
    const seller = await seedSellerWithOwner('9812340003');
    const product = await ownProduct(seller.id);

    const res = await createListing(seller.token, { variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500, stockQty: 10 }).expect(201);
    const data = expectSuccess<{ id: string; sellerId: string; variantId: string; pricePaise: number; stockQty: number; isAvailable: boolean }>(res.body).data;
    expect(data).toMatchObject({ sellerId: seller.id, variantId: product.variantId, pricePaise: 2500, stockQty: 10, isAvailable: true });

    const stored = await prisma.sellerListing.findUniqueOrThrow({ where: { id: data.id } });
    expect(stored).toMatchObject({ sellerId: seller.id, variantId: product.variantId });
  });

  it('rejects a duplicate (sellerId, variantId) listing rather than updating it', async () => {
    const seller = await seedSellerWithOwner('9812340004');
    const product = await ownProduct(seller.id);
    await createListing(seller.token, { variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500 }).expect(201);

    // Different price — if this silently updated, the original would change.
    const res = await createListing(seller.token, { variantId: product.variantId, mrpPaise: 5000, pricePaise: 4000 });
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);

    const listings = await prisma.sellerListing.findMany({ where: { sellerId: seller.id, variantId: product.variantId } });
    expect(listings).toHaveLength(1);
    expect(listings[0]!.pricePaise).toBe(2500);
  });

  it('rejects a nonexistent product variant', async () => {
    const seller = await seedSellerWithOwner('9812340005');
    const res = await createListing(seller.token, { variantId: randomUUID(), mrpPaise: 3000, pricePaise: 2500 });
    expect(res.status).toBe(404);
    expect(expectError(res.body).code).toBe(ErrorCode.NOT_FOUND);
    expect(await prisma.sellerListing.count()).toBe(0);
  });

  it("cannot list another seller's product — it is reported as not found", async () => {
    const owner = await seedSellerWithOwner('9812340006');
    const other = await seedSellerWithOwner('9812340007');
    const product = await ownProduct(owner.id);

    const res = await createListing(other.token, { variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500 });
    expect(res.status).toBe(404);
    expect(expectError(res.body).code).toBe(ErrorCode.NOT_FOUND);
    expect(await prisma.sellerListing.count({ where: { sellerId: other.id } })).toBe(0);
  });

  it('may list a product still awaiting approval, which customers cannot buy until it is approved', async () => {
    const seller = await seedSellerWithOwner('9812340008');
    const product = await ownProduct(seller.id);
    await prisma.product.update({ where: { id: product.productId }, data: { approvalStatus: 'PENDING' } });

    const listing = expectSuccess<{ id: string }>(
      (await createListing(seller.token, { variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500, stockQty: 5 }).expect(201)).body,
    ).data;

    await otpService.clearOtpState('9812340099');
    const customer = await loginAs('9812340099');
    await seedAddress(customer.userId);
    const add = await api().post('/api/v1/cart/items').set('Authorization', bearer(customer.accessToken)).send({ sellerListingId: listing.id, qty: 1 });
    expect(add.status).toBe(409);
    expect(expectError(add.body).code).toBe(ErrorCode.PRODUCT_UNAVAILABLE);
  });

  it('refuses a caller who is not a seller', async () => {
    const seller = await seedSellerWithOwner('9812340009');
    const product = await ownProduct(seller.id);
    await otpService.clearOtpState('9812340000');
    const customer = await loginAs('9812340000');

    const res = await createListing(customer.accessToken, { variantId: product.variantId, mrpPaise: 3000, pricePaise: 2500 });
    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
    expect(await prisma.sellerListing.count()).toBe(0);
  });
});
