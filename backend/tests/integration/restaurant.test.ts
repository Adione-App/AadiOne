/**
 * V2 Food / Restaurant module — restaurant sellers reuse Seller +
 * RestaurantProfile, seller-scoped menu Categories, the Product Approval
 * workflow, SellerListings, the mixed cart and the SellerOrder lifecycle.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, PaymentMethod, SellerType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { MockPaymentProvider } from '../../src/infra/payment';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';

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

async function seedSeller(
  mobile: string,
  name: string,
  opts: { sellerType?: SellerType; defaultCommissionBp?: number; approved?: boolean } = {},
): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      sellerType: opts.sellerType ?? SellerType.RESTAURANT,
      isPlatformOwned: false,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      defaultCommissionBp: opts.defaultCommissionBp ?? 0,
      onboardingStatus: opts.approved === false ? ApprovalStatus.PENDING : ApprovalStatus.APPROVED,
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken };
}

async function customer() {
  await otpService.clearOtpState('9500000001');
  const session = await loginAs('9500000001');
  return { token: session.accessToken, addressId: await seedAddress(session.userId) };
}

const section = async (token: string, name: string) =>
  expectSuccess<{ id: string }>(
    (await api().post('/api/v1/seller/menu-sections').set('Authorization', bearer(token)).send({ name }).expect(201)).body,
  ).data.id;

const createProduct = (token: string, categoryId: string, name: string) =>
  api()
    .post('/api/v1/seller/products')
    .set('Authorization', bearer(token))
    .send({ categoryId, name, sku: `SKU-${randomUUID().slice(0, 8)}`, variantName: 'Full plate', unit: 'PIECE', unitValue: 1 });

const listItem = (token: string, variantId: string, pricePaise: number) =>
  api()
    .post('/api/v1/seller/listings')
    .set('Authorization', bearer(token))
    .send({ variantId, mrpPaise: pricePaise + 1000, pricePaise, stockQty: 20 });

/** Seller creates + submits; admin decides each item. Returns product -> variant. */
async function approvedMenuItem(adminToken: string, token: string, categoryId: string, name: string, decision: ApprovalStatus = ApprovalStatus.APPROVED) {
  const product = expectSuccess<{ id: string; variantId: string }>((await createProduct(token, categoryId, name).expect(201)).body).data;
  const batch = expectSuccess<{ id: string; items: { id: string }[] }>(
    (await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(token)).send({ productIds: [product.id] }).expect(201)).body,
  ).data;
  await api()
    .patch(`/api/v1/admin/approval-batches/${batch.id}/items/${batch.items[0]!.id}`)
    .set('Authorization', bearer(adminToken))
    .send({ status: decision, ...(decision === ApprovalStatus.REJECTED ? { reviewNote: 'not suitable' } : {}) })
    .expect(200);
  return product;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('restaurant profile + authorization', () => {
  it('a restaurant manages only its own profile; non-restaurants and customers cannot', async () => {
    const adminToken = await loginAdmin();
    const a = await seedSeller('9500000010', 'Restaurant A');
    const b = await seedSeller('9500000011', 'Restaurant B');
    const general = await seedSeller('9500000012', 'General Seller', { sellerType: SellerType.OTHER });

    await api().put('/api/v1/seller/onboarding/restaurant-profile').set('Authorization', bearer(a.token)).send({ cuisine: ['Mughlai'], avgPrepMins: 20 }).expect(200);
    await api().put('/api/v1/seller/onboarding/restaurant-profile').set('Authorization', bearer(b.token)).send({ cuisine: ['South Indian'], isVegOnly: true }).expect(200);

    const res = await api().put('/api/v1/seller/onboarding/restaurant-profile').set('Authorization', bearer(general.token)).send({ cuisine: ['X'] });
    expect(res.status).toBe(400);
    expect((await api().post('/api/v1/seller/menu-sections').set('Authorization', bearer(general.token)).send({ name: 'Starters' })).status).toBe(400);

    const own = await api().get('/api/v1/seller/onboarding').set('Authorization', bearer(a.token)).set('X-Seller-Id', b.id).expect(200);
    expect(expectSuccess<{ sellerId: string; restaurantProfile: { cuisine: string[] } }>(own.body).data).toMatchObject({
      sellerId: a.id,
      restaurantProfile: { cuisine: ['Mughlai'] },
    });

    const cust = await customer();
    expect((await api().get('/api/v1/seller/onboarding').set('Authorization', bearer(cust.token))).status).toBe(403);
    expect((await api().get('/api/v1/admin/restaurants').set('Authorization', bearer(a.token))).status).toBe(403);

    const admin = await api().get('/api/v1/admin/restaurants').set('Authorization', bearer(adminToken)).expect(200);
    const ids = expectSuccess<{ sellerId: string }[]>(admin.body).data.map((r) => r.sellerId);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(general.id);
  });
});

describe('food catalog, approval and listing gating', () => {
  it('menu items follow the approval workflow and only APPROVED items can be listed', async () => {
    const adminToken = await loginAdmin();
    await seedStore();
    const a = await seedSeller('9500000020', 'Restaurant A');
    const starters = await section(a.token, 'Starters');

    const pending = expectSuccess<{ id: string; variantId: string }>((await createProduct(a.token, starters, 'Paneer Tikka').expect(201)).body).data;
    expect((await prisma.product.findUniqueOrThrow({ where: { id: pending.id } })).approvalStatus).toBe('PENDING');
    expect((await listItem(a.token, pending.variantId, 20000)).status).toBe(400);

    const approved = await approvedMenuItem(adminToken, a.token, starters, 'Hara Bhara Kabab');
    const rejected = await approvedMenuItem(adminToken, a.token, starters, 'Mystery Dish', ApprovalStatus.REJECTED);
    expect((await listItem(a.token, rejected.variantId, 20000)).status).toBe(400);

    const listing = await listItem(a.token, approved.variantId, 18000).expect(201);
    expect(expectSuccess<{ sellerId: string }>(listing.body).data.sellerId).toBe(a.id);
    expect((await listItem(a.token, approved.variantId, 18000)).status).toBe(409);
  });

  it("enforces menu-section scope: own sections only for restaurants, never another seller's", async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    const grocery = await seedProduct(platformId, { pricePaise: 5000, stockQty: 10 });
    const a = await seedSeller('9500000030', 'Restaurant A');
    const b = await seedSeller('9500000031', 'Restaurant B');
    const general = await seedSeller('9500000032', 'General Seller', { sellerType: SellerType.OTHER });
    const aSection = await section(a.token, 'Starters');
    const bSection = await section(b.token, 'Starters'); // same name, other restaurant: allowed
    expect((await api().post('/api/v1/seller/menu-sections').set('Authorization', bearer(a.token)).send({ name: 'Starters' })).status).toBe(409);

    expect((await createProduct(a.token, bSection, 'Stolen')).status).toBe(404);
    expect((await createProduct(general.token, aSection, 'Sneaky')).status).toBe(404);
    const shared = await createProduct(a.token, grocery.categoryId, 'Grocery by restaurant');
    expect(shared.status).toBe(400);

    const aItem = await approvedMenuItem(adminToken, a.token, aSection, 'Paneer Tikka');
    expect((await listItem(b.token, aItem.variantId, 15000)).status).toBe(404);
    const adminCross = await api()
      .post(`/api/v1/admin/sellers/${b.id}/listings`)
      .set('Authorization', bearer(adminToken))
      .send({ variantId: aItem.variantId, mrpPaise: 16000, pricePaise: 15000, stockQty: 5 });
    expect(adminCross.status).toBe(400);
    const adminGrocery = await api()
      .post(`/api/v1/admin/sellers/${a.id}/listings`)
      .set('Authorization', bearer(adminToken))
      .send({ variantId: grocery.variantId, mrpPaise: 6000, pricePaise: 5000, stockQty: 5 });
    expect(adminGrocery.status).toBe(400);
  });

  it("a restaurant can update its own listings but not another restaurant's", async () => {
    const adminToken = await loginAdmin();
    await seedStore();
    const a = await seedSeller('9500000040', 'Restaurant A');
    const b = await seedSeller('9500000041', 'Restaurant B');
    const bItem = await approvedMenuItem(adminToken, b.token, await section(b.token, 'Dosa'), 'Masala Dosa');
    const bListing = expectSuccess<{ id: string }>((await listItem(b.token, bItem.variantId, 12000).expect(201)).body).data.id;

    expect((await api().patch(`/api/v1/seller/listings/${bListing}`).set('Authorization', bearer(a.token)).send({ pricePaise: 100 })).status).toBe(404);
    const own = await api().patch(`/api/v1/seller/listings/${bListing}`).set('Authorization', bearer(b.token)).send({ pricePaise: 11000, stockQty: 25 }).expect(200);
    expect(expectSuccess<{ pricePaise: number; stockQty: number }>(own.body).data).toMatchObject({ pricePaise: 11000, stockQty: 25 });
    const ledger = await prisma.stockLedger.findFirstOrThrow({ where: { sellerListingId: bListing }, orderBy: { createdAt: 'desc' } });
    expect([ledger.reason, ledger.delta]).toEqual(['MANUAL_ADJUST', 5]);
  });
});

describe('customer restaurant catalog', () => {
  it('lists only live restaurants, separately, with menus that identify each listing and restaurant', async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    await seedProduct(platformId, { pricePaise: 4000, stockQty: 10 });
    const a = await seedSeller('9500000050', 'Restaurant A');
    const b = await seedSeller('9500000051', 'Restaurant B');
    const hidden = await seedSeller('9500000052', 'Pending Restaurant', { approved: false });

    const aSection = await section(a.token, 'Starters');
    const aItem = await approvedMenuItem(adminToken, a.token, aSection, 'Paneer Tikka');
    const aListing = expectSuccess<{ id: string }>((await listItem(a.token, aItem.variantId, 20000).expect(201)).body).data.id;
    const bItem = await approvedMenuItem(adminToken, b.token, await section(b.token, 'Dosa'), 'Masala Dosa');
    await listItem(b.token, bItem.variantId, 12000).expect(201);
    await approvedMenuItem(adminToken, a.token, aSection, 'Rejected Dish', ApprovalStatus.REJECTED);

    const list = expectSuccess<{ sellerId: string; menuItemCount: number }[]>((await api().get('/api/v1/restaurants').expect(200)).body).data;
    expect(list.map((r) => r.sellerId).sort()).toEqual([a.id, b.id].sort());
    expect((await api().get(`/api/v1/restaurants/${hidden.id}`)).status).toBe(404);

    const menu = expectSuccess<{ sections: { name: string; items: { sellerListingId: string; sellerId: string; restaurantName: string; name: string }[] }[] }>(
      (await api().get(`/api/v1/restaurants/${a.id}`).expect(200)).body,
    ).data;
    expect(menu.sections.map((s) => [s.name, s.items.map((i) => [i.sellerListingId, i.sellerId, i.restaurantName, i.name])])).toEqual([
      ['Starters', [[aListing, a.id, 'Restaurant A', 'Paneer Tikka']]],
    ]);

    // The grocery category tree never shows restaurant menu sections.
    const categories = expectSuccess<{ id: string }[]>((await api().get('/api/v1/categories').expect(200)).body).data;
    expect(categories.map((c) => c.id)).not.toContain(aSection);
  });
});

describe('mixed restaurant + grocery checkout and the restaurant order lifecycle', () => {
  it('splits into restaurant + grocery SellerOrders with correct commission, then runs the restaurant lifecycle', async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    const grocery = await seedProduct(platformId, { pricePaise: 6000, stockQty: 10 });
    const a = await seedSeller('9500000060', 'Restaurant A', { defaultCommissionBp: 1500 });
    const b = await seedSeller('9500000061', 'Restaurant B');
    const aItem = await approvedMenuItem(adminToken, a.token, await section(a.token, 'Mains'), 'Butter Chicken');
    const aListing = expectSuccess<{ id: string }>((await listItem(a.token, aItem.variantId, 30000).expect(201)).body).data.id;

    const cust = await customer();
    await api().post('/api/v1/cart/items').set('Authorization', bearer(cust.token)).send({ sellerListingId: aListing, qty: 2 }).expect(200);
    await api().post('/api/v1/cart/items').set('Authorization', bearer(cust.token)).send({ sellerListingId: grocery.storeVariantId, qty: 1 }).expect(200);
    const cart = expectSuccess<{ sellerGroups: { sellerId: string; subtotalPaise: number }[] }>(
      (await api().get('/api/v1/cart').set('Authorization', bearer(cust.token)).expect(200)).body,
    ).data;
    expect(cart.sellerGroups.map((g) => [g.sellerId, g.subtotalPaise]).sort()).toEqual([[a.id, 60000], [platformId, 6000]].sort());

    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(cust.token))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId: cust.addressId, paymentMethod: PaymentMethod.ONLINE })
      .expect(201);
    const order = expectSuccess<{ order: { id: string } }>(placed.body).data.order;
    const intent = await api().post('/api/v1/payments/create').set('Authorization', bearer(cust.token)).set('Idempotency-Key', randomUUID()).send({ orderId: order.id }).expect(200);
    const providerOrderId = expectSuccess<{ providerOrderId: string }>(intent.body).data.providerOrderId;
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;
    await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(cust.token))
      .send({ orderId: order.id, providerOrderId, providerPaymentId, signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId) })
      .expect(200);

    const sellerOrders = await prisma.sellerOrder.findMany({ where: { orderId: order.id }, include: { items: true } });
    expect(sellerOrders).toHaveLength(2);
    const soA = sellerOrders.find((s) => s.sellerId === a.id)!;
    const soG = sellerOrders.find((s) => s.sellerId === platformId)!;
    expect([soA.subtotalPaise, soA.commissionPaise, soA.items[0]!.commissionBp, soA.items[0]!.commissionPaise]).toEqual([60000, 9000, 1500, 9000]);
    expect(soG.items.map((i) => i.sellerListingId)).toEqual([grocery.storeVariantId]);

    // Isolation on orders.
    expect((await api().patch(`/api/v1/seller/orders/${soA.id}/status`).set('Authorization', bearer(b.token)).send({ toStatus: 'ACCEPTED' })).status).toBe(404);
    expect((await api().patch(`/api/v1/seller/orders/${soG.id}/status`).set('Authorization', bearer(a.token)).send({ toStatus: 'ACCEPTED' })).status).toBe(404);

    for (const toStatus of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) {
      await api().patch(`/api/v1/seller/orders/${soA.id}/status`).set('Authorization', bearer(a.token)).send({ toStatus }).expect(200);
    }
    const illegal = await api().patch(`/api/v1/seller/orders/${soA.id}/status`).set('Authorization', bearer(a.token)).send({ toStatus: 'ACCEPTED' });
    expect(illegal.status).toBe(409);
    expect(expectError(illegal.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    const history = await prisma.sellerOrderStatusHistory.findMany({ where: { sellerOrderId: soA.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => [h.toStatus, h.actorType])).toEqual([
      ['ACCEPTED', 'SELLER'],
      ['PREPARING', 'SELLER'],
      ['READY_FOR_PICKUP', 'SELLER'],
    ]);
  });

  it("a restaurant rejecting its portion refunds exactly that portion; the grocery sibling is untouched", async () => {
    const adminToken = await loginAdmin();
    const platformId = await seedStore();
    const grocery = await seedProduct(platformId, { pricePaise: 7000, stockQty: 10 });
    const b = await seedSeller('9500000070', 'Restaurant B');
    const bItem = await approvedMenuItem(adminToken, b.token, await section(b.token, 'Dosa'), 'Masala Dosa');
    const bListing = expectSuccess<{ id: string }>((await listItem(b.token, bItem.variantId, 12000).expect(201)).body).data.id;

    const cust = await customer();
    await api().post('/api/v1/cart/items').set('Authorization', bearer(cust.token)).send({ sellerListingId: bListing, qty: 2 }).expect(200);
    await api().post('/api/v1/cart/items').set('Authorization', bearer(cust.token)).send({ sellerListingId: grocery.storeVariantId, qty: 1 }).expect(200);
    const placed = await api()
      .post('/api/v1/orders')
      .set('Authorization', bearer(cust.token))
      .set('Idempotency-Key', randomUUID())
      .send({ addressId: cust.addressId, paymentMethod: PaymentMethod.ONLINE })
      .expect(201);
    const order = expectSuccess<{ order: { id: string } }>(placed.body).data.order;
    const intent = await api().post('/api/v1/payments/create').set('Authorization', bearer(cust.token)).set('Idempotency-Key', randomUUID()).send({ orderId: order.id }).expect(200);
    const providerOrderId = expectSuccess<{ providerOrderId: string }>(intent.body).data.providerOrderId;
    const providerPaymentId = `mock_pay_${randomUUID().slice(0, 8)}`;
    await api()
      .post('/api/v1/payments/verify')
      .set('Authorization', bearer(cust.token))
      .send({ orderId: order.id, providerOrderId, providerPaymentId, signature: MockPaymentProvider.sign(providerOrderId, providerPaymentId) })
      .expect(200);

    const soB = (await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.id, sellerId: b.id } })).id;
    await api().patch(`/api/v1/seller/orders/${soB}/status`).set('Authorization', bearer(b.token)).send({ toStatus: 'REJECTED', reason: 'Out of batter' }).expect(200);
    await api().patch(`/api/v1/seller/orders/${soB}/status`).set('Authorization', bearer(b.token)).send({ toStatus: 'REJECTED', reason: 'again' }).expect(200);

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds.map((r) => [r.sellerOrderId, r.amountPaise, r.status])).toEqual([[soB, 24000, 'COMPLETED']]);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { sellerOrders: true } });
    expect(after.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(after.sellerOrders.find((s) => s.sellerId === platformId)?.status).toBe('NEW');
  });
});
