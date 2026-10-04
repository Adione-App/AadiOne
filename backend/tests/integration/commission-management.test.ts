/**
 * Commission management — admin sets seller default / category / product
 * rates (product > category > default, one ACTIVE rule per scope); sellers
 * only read their own. Past orders keep the rate frozen on their OrderItems.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, PaymentMethod, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { seedAddress, seedProduct, seedStore, sellerLifecycleFields } from '../helpers/fixtures';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(mobile: string, defaultCommissionBp: number): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Seller ${mobile}`,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      defaultCommissionBp,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

async function setup() {
  const adminToken = await loginAdmin();
  const platformId = await seedStore();
  const seller = await seedSeller('9800000010', 1000); // 10% default
  const product = await seedProduct(platformId, { pricePaise: 10000, stockQty: 20 });
  const listingId = expectSuccess<{ id: string }>(
    (await api().post(`/api/v1/admin/sellers/${seller.id}/listings`).set('Authorization', bearer(adminToken)).send({ variantId: product.variantId, mrpPaise: 11000, pricePaise: 10000, stockQty: 20 }).expect(201)).body,
  ).data.id;
  return { adminToken, seller, product, listingId };
}

const effective = async (token: string) =>
  expectSuccess<{ listings: { effectiveCommissionBp: number; source: string }[] }>(
    (await api().get('/api/v1/seller/commission').set('Authorization', bearer(token)).expect(200)).body,
  ).data.listings[0]!;

describe('precedence and lifecycle', () => {
  it('default < category < product, with fallback on deactivation and one active rule per scope', async () => {
    const { adminToken, seller, product } = await setup();
    const base = `/api/v1/admin/sellers/${seller.id}/commission`;
    const auth = { Authorization: bearer(adminToken) };

    expect(await effective(seller.token)).toMatchObject({ effectiveCommissionBp: 1000, source: 'SELLER_DEFAULT' });
    await api().put(`${base}/categories/${product.categoryId}`).set(auth).send({ rateBp: 1200 }).expect(200);
    expect(await effective(seller.token)).toMatchObject({ effectiveCommissionBp: 1200, source: 'CATEGORY' });
    await api().put(`${base}/products/${product.productId}`).set(auth).send({ rateBp: 1500 }).expect(200);
    expect(await effective(seller.token)).toMatchObject({ effectiveCommissionBp: 1500, source: 'PRODUCT' });

    // Replace the product rule: old one deactivated, never two active.
    await api().put(`${base}/products/${product.productId}`).set(auth).send({ rateBp: 2000 }).expect(200);
    const rules = await prisma.commissionRule.findMany({ where: { sellerId: seller.id, productId: product.productId } });
    expect(rules.filter((r) => r.isActive).map((r) => r.rateBp)).toEqual([2000]);
    expect(rules).toHaveLength(2);

    await api().delete(`${base}/products/${product.productId}`).set(auth).expect(200);
    expect(await effective(seller.token)).toMatchObject({ effectiveCommissionBp: 1200, source: 'CATEGORY' });
    await api().delete(`${base}/categories/${product.categoryId}`).set(auth).expect(200);
    expect(await effective(seller.token)).toMatchObject({ effectiveCommissionBp: 1000, source: 'SELLER_DEFAULT' });

    await api().put(`${base}/default`).set(auth).send({ rateBp: 800 }).expect(200);
    expect(await effective(seller.token)).toMatchObject({ effectiveCommissionBp: 800, source: 'SELLER_DEFAULT' });
    expect((await api().put(`${base}/default`).set(auth).send({ rateBp: 10001 })).status).toBe(400);
  });
});

describe('historical protection', () => {
  it('an order keeps its frozen rate after the rule changes; new orders use the new rate', async () => {
    const { adminToken, seller, product, listingId } = await setup();
    const base = `/api/v1/admin/sellers/${seller.id}/commission`;
    await api().put(`${base}/products/${product.productId}`).set('Authorization', bearer(adminToken)).send({ rateBp: 1500 }).expect(200);

    await otpService.clearOtpState('9800000099');
    const customer = await loginAs('9800000099');
    const addressId = await seedAddress(customer.userId);
    const order = async () => {
      await api().post('/api/v1/cart/items').set('Authorization', bearer(customer.accessToken)).send({ sellerListingId: listingId, qty: 1 }).expect(200);
      const res = await api().post('/api/v1/orders').set('Authorization', bearer(customer.accessToken)).set('Idempotency-Key', randomUUID()).send({ addressId, paymentMethod: PaymentMethod.COD }).expect(201);
      return expectSuccess<{ order: { id: string } }>(res.body).data.order.id;
    };

    const first = await order();
    await api().put(`${base}/products/${product.productId}`).set('Authorization', bearer(adminToken)).send({ rateBp: 2000 }).expect(200);
    const second = await order();

    const itemOf = (orderId: string) => prisma.orderItem.findFirstOrThrow({ where: { sellerOrder: { orderId } } });
    expect([(await itemOf(first)).commissionBp, (await itemOf(first)).commissionPaise]).toEqual([1500, 1500]);
    expect([(await itemOf(second)).commissionBp, (await itemOf(second)).commissionPaise]).toEqual([2000, 2000]);

    const history = expectSuccess<{ commissionBp: number }[]>(
      (await api().get('/api/v1/seller/commission/orders').set('Authorization', bearer(seller.token)).expect(200)).body,
    ).data;
    expect(history.map((h) => h.commissionBp).sort()).toEqual([1500, 2000]);
  });
});

describe('authorization', () => {
  it('sellers read only their own commission and cannot manage any', async () => {
    const { adminToken, seller, product } = await setup();
    const other = await seedSeller('9800000011', 700);

    for (const req of [
      api().get(`/api/v1/admin/sellers/${seller.id}/commission`),
      api().put(`/api/v1/admin/sellers/${seller.id}/commission/default`).send({ rateBp: 1 }),
      api().put(`/api/v1/admin/sellers/${seller.id}/commission/products/${product.productId}`).send({ rateBp: 1 }),
    ]) {
      expect((await req.set('Authorization', bearer(other.token))).status).toBe(403);
    }
    const own = await api().get('/api/v1/seller/commission').set('Authorization', bearer(other.token)).set('X-Seller-Id', seller.id).expect(200);
    expect(expectSuccess<{ sellerId: string; defaultCommissionBp: number }>(own.body).data).toMatchObject({ sellerId: other.id, defaultCommissionBp: 700 });

    const adminView = await api().get(`/api/v1/admin/sellers/${other.id}/commission`).set('Authorization', bearer(adminToken)).expect(200);
    expect(expectSuccess<{ defaultCommissionBp: number }>(adminView.body).data.defaultCommissionBp).toBe(700);
  });
});
