/**
 * V2 notifications — audience-scoped feeds (customer / seller / admin),
 * deterministic dedupe keys (unique per user) and read/unread APIs.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStatus, PaymentMethod, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { seedAddress, seedProduct, seedStore, sellerLifecycleFields } from '../helpers/fixtures';
import { SETTLEMENT_CLOSE_LAG_MS } from '../../src/modules/sellers/seller-settlement.service';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSeller(mobile: string, approved = true): Promise<{ id: string; token: string; userId: string }> {
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
      ...sellerLifecycleFields(approved ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  return { id: seller.id, token: (await loginAs(mobile)).accessToken, userId: user.id };
}

type Feed = { items: { id: string; type: string; isRead: boolean; sellerId: string | null }[]; hasMore: boolean };
const feed = async (path: string, token: string) =>
  expectSuccess<Feed>((await api().get(path).set('Authorization', bearer(token)).expect(200)).body).data;
const unread = async (path: string, token: string) =>
  expectSuccess<{ unread: number }>((await api().get(`${path}/unread-count`).set('Authorization', bearer(token)).expect(200)).body).data.unread;
const types = (f: Feed) => f.items.map((i) => i.type).sort();

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function orderSetup() {
  const adminToken = await loginAdmin();
  const platformId = await seedStore();
  const a = await seedSeller('9900000010');
  const product = await seedProduct(platformId, { pricePaise: 15000, stockQty: 10 });
  const listing = expectSuccess<{ id: string }>(
    (await api().post(`/api/v1/admin/sellers/${a.id}/listings`).set('Authorization', bearer(adminToken)).send({ variantId: product.variantId, mrpPaise: 16000, pricePaise: 15000, stockQty: 10 }).expect(201)).body,
  ).data.id;
  await otpService.clearOtpState('9900000099');
  const customer = await loginAs('9900000099');
  const addressId = await seedAddress(customer.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(customer.accessToken)).send({ sellerListingId: listing, qty: 1 }).expect(200);
  const placed = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(customer.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD })
    .expect(201);
  const order = expectSuccess<{ order: { id: string; sellerOrders: { id: string }[] } }>(placed.body).data.order;
  return { adminToken, a, customer: customer.accessToken, order, soId: order.sellerOrders[0]!.id };
}

describe('order lifecycle notifications', () => {
  it('customer and seller feeds get their own events, once each', async () => {
    const { a, customer, soId } = await orderSetup();
    expect(types(await feed('/api/v1/notifications', customer))).toEqual(['ORDER_PLACED']);
    expect(types(await feed('/api/v1/seller/notifications', a.token))).toEqual(['SELLER_NEW_ORDER']);

    for (const toStatus of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) {
      await api().patch(`/api/v1/seller/orders/${soId}/status`).set('Authorization', bearer(a.token)).send({ toStatus }).expect(200);
    }
    // Repeated no-op transition: nothing new.
    await api().patch(`/api/v1/seller/orders/${soId}/status`).set('Authorization', bearer(a.token)).send({ toStatus: 'READY_FOR_PICKUP' }).expect(200);

    expect(types(await feed('/api/v1/notifications', customer))).toEqual(['ORDER_ACCEPTED', 'ORDER_PLACED', 'ORDER_PREPARING', 'ORDER_READY']);
    // The seller did those itself — no seller notices for them.
    expect(types(await feed('/api/v1/seller/notifications', a.token))).toEqual(['SELLER_NEW_ORDER']);
  });

  it('a customer cancellation notifies both sides once, even when repeated', async () => {
    const { a, customer, order } = await orderSetup();
    for (let i = 0; i < 2; i += 1) {
      const res = await api().post(`/api/v1/orders/${order.id}/cancel`).set('Authorization', bearer(customer)).send({ reason: 'Changed my mind' });
      expect([200, 409]).toContain(res.status);
    }
    expect(types(await feed('/api/v1/notifications', customer)).filter((t) => t === 'ORDER_CANCELLED')).toHaveLength(1);
    expect(types(await feed('/api/v1/seller/notifications', a.token)).filter((t) => t === 'SELLER_ORDER_CANCELLED')).toHaveLength(1);
  });
});

describe('read / unread and isolation', () => {
  it('unread count, mark one, mark all — scoped to the caller and feed', async () => {
    const { a, customer } = await orderSetup();
    const b = await seedSeller('9900000011');
    expect(await unread('/api/v1/notifications', customer)).toBe(1);

    const aFeed = await feed('/api/v1/seller/notifications', a.token);
    const aNotificationId = aFeed.items[0]!.id;
    // Seller B, and the customer app, cannot see or mark A's seller notice.
    expect((await feed('/api/v1/seller/notifications', b.token)).items).toHaveLength(0);
    expect((await api().post(`/api/v1/seller/notifications/${aNotificationId}/read`).set('Authorization', bearer(b.token))).status).toBe(404);
    expect((await api().post(`/api/v1/notifications/${aNotificationId}/read`).set('Authorization', bearer(customer))).status).toBe(404);

    await api().post(`/api/v1/seller/notifications/${aNotificationId}/read`).set('Authorization', bearer(a.token)).expect(204);
    await api().post(`/api/v1/seller/notifications/${aNotificationId}/read`).set('Authorization', bearer(a.token)).expect(204); // idempotent
    expect(await unread('/api/v1/seller/notifications', a.token)).toBe(0);

    const all = await api().post('/api/v1/notifications/read-all').set('Authorization', bearer(customer)).expect(200);
    expect(expectSuccess<{ updated: number }>(all.body).data.updated).toBe(1);
    expect(await unread('/api/v1/notifications', customer)).toBe(0);

    expect((await api().get('/api/v1/admin/notifications').set('Authorization', bearer(customer))).status).toBe(403);
    expect((await api().get('/api/v1/admin/notifications').set('Authorization', bearer(a.token))).status).toBe(403);
    expect((await api().get('/api/v1/seller/notifications').set('Authorization', bearer(customer))).status).toBe(403);
  });
});

describe('onboarding, product approval and settlement notifications', () => {
  it('admin is told about submissions; the seller about decisions — per round, once', async () => {
    const adminToken = await loginAdmin();
    const s = await seedSeller('9900000020', false); // ONBOARDING_PENDING (admin-created)
    // A checklist-complete onboarding (seller-lifecycle-rules.ts): contact
    // email, PAN number, and an uploaded PAN PDF carrying its number.
    await prisma.sellerProfile.create({
      data: { sellerId: s.id, businessName: 'QA', ownerFullName: 'QA', ownerMobile: '9900000020', ownerEmail: 'qa@seller.adione.test', panNumber: 'ABCDE1234F' },
    });
    await prisma.sellerBankDetail.create({ data: { sellerId: s.id, accountHolderName: 'QA', accountNumber: '123456789012', ifscCode: 'SBIN0000001' } });
    await prisma.sellerDocument.create({
      data: { sellerId: s.id, type: 'PAN_CARD', documentNumber: 'ABCDE1234F', fileKey: `seller-documents/${s.id}/${randomUUID()}.pdf` },
    });
    const gate2 = (body: object) =>
      api().patch(`/api/v1/admin/sellers/${s.id}/verification/review`).set('Authorization', bearer(adminToken)).send(body).expect(200);

    await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(s.token)).expect(200);
    // Same round: the onboarding is locked under review, so a repeat submit is
    // refused — and no second notice is sent.
    await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(s.token)).expect(403);
    expect(types(await feed('/api/v1/admin/notifications', adminToken))).toEqual(['ADMIN_ONBOARDING_SUBMITTED']);

    await gate2({ decision: 'REQUEST_CHANGES', reason: 'Blurry PAN' });
    await api().post('/api/v1/seller/onboarding/submit').set('Authorization', bearer(s.token)).expect(200); // new round
    await gate2({ decision: 'APPROVE' });

    expect(types(await feed('/api/v1/admin/notifications', adminToken))).toEqual(['ADMIN_ONBOARDING_SUBMITTED', 'ADMIN_ONBOARDING_SUBMITTED']);
    expect(types(await feed('/api/v1/seller/notifications', s.token))).toEqual([
      'SELLER_ONBOARDING_APPROVED',
      'SELLER_ONBOARDING_CHANGES_REQUESTED',
    ]);
  });

  it('settlement created / processing / paid reach the seller once each', async () => {
    const { adminToken, a, customer, order, soId } = await orderSetup();
    for (const toStatus of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) {
      await api().patch(`/api/v1/seller/orders/${soId}/status`).set('Authorization', bearer(a.token)).send({ toStatus }).expect(200);
    }
    const detail = await api().get(`/api/v1/orders/${order.id}`).set('Authorization', bearer(customer)).expect(200);
    const otp = expectSuccess<{ deliveryOtp: string }>(detail.body).data.deliveryOtp;
    const agent = expectSuccess<{ id: string }>((await api().post('/api/v1/admin/delivery-agents').set('Authorization', bearer(adminToken)).send({ name: 'Rider', mobile: '9876500001' }).expect(201)).body).data.id;
    await api().post(`/api/v1/admin/orders/${order.id}/assign`).set('Authorization', bearer(adminToken)).send({ agentId: agent }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api().patch(`/api/v1/admin/orders/${order.id}/status`).set('Authorization', bearer(adminToken)).send({ toStatus }).expect(204);
    }
    await api().patch(`/api/v1/admin/orders/${order.id}/status`).set('Authorization', bearer(adminToken)).send({ toStatus: 'DELIVERED', deliveryOtp: otp }).expect(204);

    expect(types(await feed('/api/v1/seller/notifications', a.token))).toContain('SELLER_ORDER_UPDATE');

    // Move only Date.now() past the settlement close-lag (see seller-settlement tests).
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + SETTLEMENT_CLOSE_LAG_MS + 1_000);
    const created = await api().post(`/api/v1/admin/sellers/${a.id}/settlements`).set('Authorization', bearer(adminToken)).send({}).expect(201);
    const id = expectSuccess<{ id: string }>(created.body).data.id;
    for (const status of ['PROCESSING', 'PAID', 'PAID']) {
      await api().patch(`/api/v1/admin/settlements/${id}/status`).set('Authorization', bearer(adminToken)).send({ status }).expect(200);
    }
    const settlementTypes = types(await feed('/api/v1/seller/notifications', a.token)).filter((t) => t.startsWith('SELLER_SETTLEMENT'));
    expect(settlementTypes).toEqual(['SELLER_SETTLEMENT_CREATED', 'SELLER_SETTLEMENT_PAID', 'SELLER_SETTLEMENT_PROCESSING']);
  });
});
