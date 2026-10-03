/**
 * Seller availability: admin `isActive` > seller's own Store Open/Closed
 * switch (`isAcceptingOrders`, never auto-reset) > SellerClosure > weekly
 * SellerHours — evaluated in the seller's timezone, enforced at cart add,
 * cart read (checkout blocked, lines kept) and checkout.
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
import * as sellerService from '../../src/modules/sellers/seller.service';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(mobile: string, name: string): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      timezone: 'Asia/Kolkata',
      onboardingStatus: ApprovalStatus.APPROVED,
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken };
}

const loadSeller = (id: string) =>
  prisma.seller.findUniqueOrThrow({ where: { id }, include: { hours: { orderBy: { dayOfWeek: 'asc' } } } });

const everyDay = (opensAt: string, closesAt: string) =>
  Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, opensAt, closesAt, isClosed: false }));

// 2026-08-12 is a Wednesday. 06:30Z = 12:00 IST, 17:30Z = 23:00 IST.
const NOON_IST = new Date('2026-08-12T06:30:00.000Z');
const LATE_IST = new Date('2026-08-12T17:30:00.000Z');
const NEXT_DAY_NOON_IST = new Date('2026-08-13T06:30:00.000Z');

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('availability priority (controlled times)', () => {
  it('hours, own switch (never auto-reset), closure and admin inactive combine in priority order', async () => {
    const s = await seedSeller('9700000010', 'Clock Seller');
    await api().put('/api/v1/seller/hours').set('Authorization', bearer(s.token)).send({ hours: everyDay('09:00', '21:00') }).expect(200);

    let seller = await loadSeller(s.id);
    expect((await sellerService.evaluateSellerAvailability(seller, NOON_IST)).isOpen).toBe(true);
    expect((await sellerService.evaluateSellerAvailability(seller, LATE_IST)).closedReason).toBe('OUTSIDE_HOURS');

    await api().patch('/api/v1/seller/availability').set('Authorization', bearer(s.token)).send({ isAcceptingOrders: false }).expect(200);
    seller = await loadSeller(s.id);
    expect((await sellerService.evaluateSellerAvailability(seller, NOON_IST)).closedReason).toBe('MANUALLY_CLOSED');
    // Still OFF the next day, inside hours — nothing resets it.
    expect((await sellerService.evaluateSellerAvailability(seller, NEXT_DAY_NOON_IST)).closedReason).toBe('MANUALLY_CLOSED');

    await api().patch('/api/v1/seller/availability').set('Authorization', bearer(s.token)).send({ isAcceptingOrders: true }).expect(200);
    seller = await loadSeller(s.id);
    expect((await sellerService.evaluateSellerAvailability(seller, NEXT_DAY_NOON_IST)).isOpen).toBe(true);
    expect((await sellerService.evaluateSellerAvailability(seller, LATE_IST)).isOpen).toBe(false);

    await prisma.sellerClosure.create({ data: { sellerId: s.id, closedOn: new Date('2026-08-12T00:00:00.000Z') } });
    expect((await sellerService.evaluateSellerAvailability(seller, NOON_IST)).closedReason).toBe('CLOSURE');
    expect((await sellerService.evaluateSellerAvailability(seller, NEXT_DAY_NOON_IST)).isOpen).toBe(true);

    await prisma.seller.update({ where: { id: s.id }, data: { isActive: false } });
    seller = await loadSeller(s.id);
    expect((await sellerService.evaluateSellerAvailability(seller, NEXT_DAY_NOON_IST)).closedReason).toBe('SELLER_INACTIVE');
  });

  it('a seller with no weekly schedule has no hour restriction (pre-existing behaviour)', async () => {
    const s = await seedSeller('9700000011', 'No Hours Seller');
    const seller = await loadSeller(s.id);
    expect((await sellerService.evaluateSellerAvailability(seller, LATE_IST)).isOpen).toBe(true);
  });
});

describe('seller availability API authorization', () => {
  it('a seller changes only its own switch and can never touch isActive', async () => {
    const adminToken = await loginAdmin();
    const a = await seedSeller('9700000020', 'Seller A');
    const b = await seedSeller('9700000021', 'Seller B');

    await api().patch('/api/v1/seller/availability').set('Authorization', bearer(a.token)).set('X-Seller-Id', b.id).send({ isAcceptingOrders: false }).expect(200);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: a.id } })).isAcceptingOrders).toBe(false);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: b.id } })).isAcceptingOrders).toBe(true);

    const sneaky = await api().patch('/api/v1/seller/availability').set('Authorization', bearer(a.token)).send({ isAcceptingOrders: true, isActive: false });
    expect(sneaky.status).toBe(400);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: a.id } })).isActive).toBe(true);

    const view = await api().get(`/api/v1/admin/sellers/${a.id}/availability`).set('Authorization', bearer(adminToken)).expect(200);
    expect(expectSuccess<{ isAcceptingOrders: boolean; closedReason: string }>(view.body).data).toMatchObject({
      isAcceptingOrders: false,
      closedReason: 'MANUALLY_CLOSED',
    });
    expect((await api().get(`/api/v1/admin/sellers/${a.id}/availability`).set('Authorization', bearer(a.token))).status).toBe(403);
  });

  it("GET /seller/availability includes the seller's own type", async () => {
    const general = await seedSeller('9700000022', 'General Seller');
    const restaurant = await seedSeller('9700000023', 'Restaurant Seller');
    await prisma.seller.update({ where: { id: restaurant.id }, data: { sellerType: 'RESTAURANT' } });

    const g = await api().get('/api/v1/seller/availability').set('Authorization', bearer(general.token)).expect(200);
    const r = await api().get('/api/v1/seller/availability').set('Authorization', bearer(restaurant.token)).expect(200);
    expect(expectSuccess<{ sellerId: string; sellerType: string }>(g.body).data).toMatchObject({ sellerId: general.id, sellerType: 'GENERAL' });
    expect(expectSuccess<{ sellerId: string; sellerType: string }>(r.body).data).toMatchObject({ sellerId: restaurant.id, sellerType: 'RESTAURANT' });
  });
});

describe('orderability', () => {
  async function setup() {
    const adminToken = await loginAdmin();
    const platformId = await seedStore(); // open 24h
    const grocery = await seedProduct(platformId, { pricePaise: 8000, stockQty: 10 });
    const r = await seedSeller('9700000030', 'Restaurant R');
    const product = await seedProduct(platformId, { pricePaise: 12000, stockQty: 10 });
    const listing = expectSuccess<{ id: string }>(
      (await api().post(`/api/v1/admin/sellers/${r.id}/listings`).set('Authorization', bearer(adminToken)).send({ variantId: product.variantId, mrpPaise: 13000, pricePaise: 12000, stockQty: 10 }).expect(201)).body,
    ).data.id;
    await otpService.clearOtpState('9700000099');
    const customer = await loginAs('9700000099');
    return { r, listing, grocery, platformId, customer: { token: customer.accessToken, addressId: await seedAddress(customer.userId) } };
  }
  const add = (token: string, sellerListingId: string, qty = 1) =>
    api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId, qty });
  const place = (token: string, addressId: string) =>
    api().post('/api/v1/orders').set('Authorization', bearer(token)).set('Idempotency-Key', randomUUID()).send({ addressId, paymentMethod: PaymentMethod.COD });

  it('closed seller: add refused; existing line kept but checkout blocked; reopening restores ordering', async () => {
    const { r, listing, grocery, customer } = await setup();
    await add(customer.token, listing).expect(200);
    await add(customer.token, grocery.storeVariantId).expect(200);

    await api().patch('/api/v1/seller/availability').set('Authorization', bearer(r.token)).send({ isAcceptingOrders: false }).expect(200);

    const refused = await add(customer.token, listing);
    expect(refused.status).toBe(409);
    expect(expectError(refused.body).code).toBe(ErrorCode.SELLER_CLOSED);

    const cart = expectSuccess<{ items: unknown[]; checkoutEnabled: boolean; sellerGroups: { sellerId: string; isOpen: boolean }[] }>(
      (await api().get('/api/v1/cart').set('Authorization', bearer(customer.token)).expect(200)).body,
    ).data;
    expect(cart.items).toHaveLength(2);
    expect(cart.checkoutEnabled).toBe(false);
    expect(cart.sellerGroups.find((g) => g.sellerId === r.id)?.isOpen).toBe(false);

    const blocked = await place(customer.token, customer.addressId);
    expect(blocked.status).toBe(409);
    expect(expectError(blocked.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect(await prisma.order.count()).toBe(0);

    await api().patch('/api/v1/seller/availability').set('Authorization', bearer(r.token)).send({ isAcceptingOrders: true }).expect(200);
    await place(customer.token, customer.addressId).expect(201);
  });

  it('a closed restaurant does not block a grocery-only order', async () => {
    const { r, grocery, customer } = await setup();
    await api().patch('/api/v1/seller/availability').set('Authorization', bearer(r.token)).send({ isAcceptingOrders: false }).expect(200);
    await add(customer.token, grocery.storeVariantId, 2).expect(200);
    await place(customer.token, customer.addressId).expect(201);
  });
});
