/**
 * Shared scaffolding for the refund-management suites (refund groups,
 * requests, seller deductions, COD payouts, coupon release).
 *
 * Online orders are paid through the FAKE Cashfree (tests/helpers/
 * fake-cashfree.ts) — a test file using these helpers must route the app's
 * provider to it with the same `vi.mock('../../src/infra/payment', ...)`
 * block payment-security.test.ts uses. No real gateway is ever called.
 *
 * The worked example: Seller A ₹600 and Seller B ₹400 (10% commission).
 */

import { randomUUID } from 'node:crypto';
import { PaymentMethod, SellerOrderStatus, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from './api';
import { prisma } from './db';
import { hashPassword } from '../../src/common/crypto';
import * as otpService from '../../src/modules/auth/otp.service';
import { sharedFakeCashfree as cashfree } from './fake-cashfree';
import { seedAddress, seedProduct, seedSellerListing, sellerLifecycleFields } from './fixtures';

let adminSeq = 0;

/** A panel user of `role`, signed in. ADMIN holds ORDER_REFUND; STAFF does not. */
export async function panelToken(role: UserRole = UserRole.ADMIN): Promise<{ token: string; userId: string }> {
  adminSeq += 1;
  const email = `refunds${adminSeq}@adione.test`;
  const user = await prisma.user.create({
    data: {
      mobile: `00000002${String(adminSeq).padStart(2, '0')}`,
      email,
      fullName: `Refunds ${role}`,
      passwordHash: await hashPassword('TestAdmin@123'),
      role,
    },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return { token: expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken, userId: user.id };
}

export async function seedSeller(name: string, ownerMobile: string, commissionBp = 1000): Promise<string> {
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
      defaultCommissionBp: commissionBp,
      ...sellerLifecycleFields('APPROVED'),
    },
  });
  const owner = await prisma.user.create({ data: { mobile: ownerMobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: owner.id, role: 'OWNER', isActive: true } });
  return seller.id;
}

export async function listing(platformStoreId: string, sellerId: string, pricePaise: number): Promise<string> {
  const product = await seedProduct(platformStoreId, { pricePaise, stockQty: 50 });
  return seedSellerListing(sellerId, product.variantId, { mrpPaise: pricePaise + 100, pricePaise, stockQty: 50 });
}

/** Seller A ₹600 and Seller B ₹400, one listing each. */
export async function twoSellers(platformStoreId: string, mobiles: [string, string] = ['9400000301', '9400000302']) {
  const a = await seedSeller('Seller A', mobiles[0]);
  const b = await seedSeller('Seller B', mobiles[1]);
  return { a, b, aListing: await listing(platformStoreId, a, 60000), bListing: await listing(platformStoreId, b, 40000) };
}

export interface Placed {
  orderId: string;
  token: string;
  userId: string;
  totalPaise: number;
  deliveryOtp: string | null;
  providerOrderId: string | null;
  sellerOrderOf: (sellerId: string) => string;
  /** The order's items for one seller: [{ id, qty, totalPaise }]. */
  itemsOf: (sellerId: string) => Promise<{ id: string; qty: number; lineTotalPaise: number }[]>;
}

/**
 * Places an order for `mobile`; ONLINE orders are paid through the fake
 * Cashfree and confirmed by the app's refresh (a PROCESSING, PAID order).
 */
export async function placeOrder(
  mobile: string,
  lines: { listingId: string; qty?: number }[],
  method: PaymentMethod,
  couponCode?: string,
): Promise<Placed> {
  await otpService.clearOtpState(mobile);
  const customer = await loginAs(mobile);
  const addressId = await seedAddress(customer.userId);
  for (const line of lines) {
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(customer.accessToken))
      .send({ sellerListingId: line.listingId, qty: line.qty ?? 1 })
      .expect(200);
  }
  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(customer.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: method, ...(couponCode ? { couponCode } : {}) });
  if (res.status !== 201) throw new Error(`placing the order failed: ${res.status} ${JSON.stringify(res.body)}`);
  const order = expectSuccess<{
    order: { id: string; deliveryOtp: string | null; bill: { totalPaise: number }; sellerOrders: { id: string; sellerId: string }[] };
  }>(res.body).data.order;

  let providerOrderId: string | null = null;
  if (method === PaymentMethod.ONLINE) {
    const intent = await api()
      .post('/api/v1/payments/create')
      .set('Authorization', bearer(customer.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ orderId: order.id })
      .expect(200);
    providerOrderId = expectSuccess<{ providerOrderId: string }>(intent.body).data.providerOrderId;
    cashfree.attempt(providerOrderId, 'SUCCESS');
    await api().post(`/api/v1/payments/${order.id}/refresh`).set('Authorization', bearer(customer.accessToken)).expect(200);
  }
  return {
    orderId: order.id,
    token: customer.accessToken,
    userId: customer.userId,
    totalPaise: order.bill.totalPaise,
    deliveryOtp: order.deliveryOtp,
    providerOrderId,
    sellerOrderOf: (sellerId) => order.sellerOrders.find((so) => so.sellerId === sellerId)!.id,
    itemsOf: async (sellerId) =>
      prisma.orderItem.findMany({
        where: { sellerOrder: { orderId: order.id, sellerId } },
        select: { id: true, qty: true, lineTotalPaise: true },
      }),
  };
}

export const setSellerOrder = (token: string, sellerOrderId: string, toStatus: SellerOrderStatus) =>
  api()
    .patch(`/api/v1/admin/seller-orders/${sellerOrderId}/status`)
    .set('Authorization', bearer(token))
    .send({ toStatus, reason: 'Out of stock today' });

export const cancelAsCustomer = (placed: Placed) =>
  api().post(`/api/v1/orders/${placed.orderId}/cancel`).set('Authorization', bearer(placed.token)).send({ reason: 'Changed my mind' });

/** Accept -> prepare -> ready for every active portion, assign a rider, deliver. */
export async function deliver(token: string, placed: Placed): Promise<void> {
  const active = await prisma.sellerOrder.findMany({
    where: { orderId: placed.orderId, status: { notIn: [SellerOrderStatus.CANCELLED, SellerOrderStatus.REJECTED] } },
  });
  for (const so of active) {
    for (const s of [SellerOrderStatus.ACCEPTED, SellerOrderStatus.PREPARING, SellerOrderStatus.READY_FOR_PICKUP]) {
      await setSellerOrder(token, so.id, s).expect(204);
    }
  }
  const agent = await api()
    .post('/api/v1/admin/delivery-agents')
    .set('Authorization', bearer(token))
    .send({ name: `Rider ${randomUUID().slice(0, 6)}`, mobile: `98765${Math.floor(10000 + Math.random() * 89999)}` })
    .expect(201);
  await api()
    .post(`/api/v1/admin/orders/${placed.orderId}/assign`)
    .set('Authorization', bearer(token))
    .send({ agentId: expectSuccess<{ id: string }>(agent.body).data.id })
    .expect(200);
  for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
    await api().patch(`/api/v1/admin/orders/${placed.orderId}/status`).set('Authorization', bearer(token)).send({ toStatus }).expect(204);
  }
  await api()
    .patch(`/api/v1/admin/orders/${placed.orderId}/status`)
    .set('Authorization', bearer(token))
    .send({ toStatus: 'DELIVERED', ...(placed.deliveryOtp ? { deliveryOtp: placed.deliveryOtp } : {}) })
    .expect(204);
}

/** Sum of every refund the fake Cashfree holds, in paise. */
export function gatewayRefundedPaise(): number {
  return [...cashfree.refunds.values()].reduce((sum, r) => sum + Math.round(r.refund_amount * 100), 0);
}

/** Lets the reconciliation sweep pick an order's refunds up (it skips the newest). */
export async function ageRefunds(orderId: string, minutes: number): Promise<void> {
  await prisma.refund.updateMany({ where: { orderId }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } });
}

/** Settles every refund the fake Cashfree holds as SUCCESS. */
export function settleAllGatewayRefunds(): void {
  for (const refund of cashfree.refunds.values()) {
    if (refund.refund_status !== 'SUCCESS' && refund.refund_status !== 'CANCELLED') cashfree.settleRefund(refund.refund_id, 'SUCCESS');
  }
}

export const PAID = PaymentMethod.ONLINE;
export const COD = PaymentMethod.COD;
