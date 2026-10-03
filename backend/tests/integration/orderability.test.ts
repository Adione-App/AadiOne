/**
 * Who a customer may buy from — cart/orderability.ts, enforced at cart add,
 * cart revalidation (read + quote) and, authoritatively, order placement.
 * Admin may still create a listing for a seller whose onboarding is PENDING;
 * that listing is simply not buyable until the seller is approved.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, PaymentMethod, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(onboardingStatus: ApprovalStatus): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Seller ${onboardingStatus}`,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      onboardingStatus,
    },
  });
  return seller.id;
}

async function listingFor(adminToken: string, platformId: string, sellerId: string, pricePaise = 15000): Promise<string> {
  const product = await seedProduct(platformId, { pricePaise, stockQty: 10 });
  const res = await api()
    .post(`/api/v1/admin/sellers/${sellerId}/listings`)
    .set('Authorization', bearer(adminToken))
    .send({ variantId: product.variantId, mrpPaise: pricePaise + 1000, pricePaise, stockQty: 10 })
    .expect(201);
  return expectSuccess<{ id: string }>(res.body).data.id;
}

async function customer() {
  await otpService.clearOtpState('9600000001');
  const session = await loginAs('9600000001');
  return { token: session.accessToken, addressId: await seedAddress(session.userId) };
}

const addToCart = (token: string, sellerListingId: string) =>
  api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId, qty: 1 });

const placeOrder = (token: string, addressId: string) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(token))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('orderability', () => {
  it('an approved, active seller listing can be ordered', async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    const listing = await listingFor(adminToken, platformId, await seedSeller(ApprovalStatus.APPROVED));
    const cust = await customer();
    await addToCart(cust.token, listing).expect(200);
    await placeOrder(cust.token, cust.addressId).expect(201);
  });

  it('admin can stage a listing for a PENDING seller, but customers cannot buy it', async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    const listing = await listingFor(adminToken, platformId, await seedSeller(ApprovalStatus.PENDING));
    const cust = await customer();
    const res = await addToCart(cust.token, listing);
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.PRODUCT_UNAVAILABLE);
  });

  it('a line whose seller stops trading after it was added is removed on read and refused at checkout', async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    const sellerId = await seedSeller(ApprovalStatus.APPROVED);
    const listing = await listingFor(adminToken, platformId, sellerId);
    const cust = await customer();
    await addToCart(cust.token, listing).expect(200);

    await prisma.seller.update({ where: { id: sellerId }, data: { isActive: false } });
    const order = await placeOrder(cust.token, cust.addressId);
    expect(order.status).toBe(409);
    expect(expectError(order.body).code).toBe(ErrorCode.PRODUCT_UNAVAILABLE);
    expect(await prisma.order.count()).toBe(0);

    const cart = expectSuccess<{ items: unknown[]; changes: { type: string }[] }>(
      (await api().get('/api/v1/cart').set('Authorization', bearer(cust.token)).expect(200)).body,
    ).data;
    expect(cart.items).toHaveLength(0);
    expect(cart.changes.map((c) => c.type)).toEqual(['ITEM_REMOVED_UNAVAILABLE']);
  });

  it('a deleted seller, an unavailable listing and an unapproved product cannot be ordered', async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    const cust = await customer();

    const deletedSeller = await seedSeller(ApprovalStatus.APPROVED);
    const deletedListing = await listingFor(adminToken, platformId, deletedSeller);
    await prisma.seller.update({ where: { id: deletedSeller }, data: { deletedAt: new Date() } });
    expect((await addToCart(cust.token, deletedListing)).status).toBe(409);

    const unavailableListing = await listingFor(adminToken, platformId, await seedSeller(ApprovalStatus.APPROVED));
    await prisma.sellerListing.update({ where: { id: unavailableListing }, data: { isAvailable: false } });
    expect((await addToCart(cust.token, unavailableListing)).status).toBe(409);

    const reviewListing = await listingFor(adminToken, platformId, await seedSeller(ApprovalStatus.APPROVED));
    const variant = await prisma.sellerListing.findUniqueOrThrow({ where: { id: reviewListing }, select: { variant: { select: { productId: true } } } });
    await prisma.product.update({ where: { id: variant.variant.productId }, data: { approvalStatus: 'PENDING' } });
    expect((await addToCart(cust.token, reviewListing)).status).toBe(409);
  });
});
