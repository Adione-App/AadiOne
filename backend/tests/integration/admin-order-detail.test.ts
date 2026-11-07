/**
 * GET /admin/orders/:id — what the admin Orders page's order details are
 * built from: every line's ordered snapshot (image, name, size, option
 * picks, SKU, quantity, unit price, line total) grouped by seller, the bill,
 * payment and delivery details — plus each line's measurable size (`measure`)
 * so "2 × 500 g = 1 kg" comes from the variant's structured unit, never from
 * a name. Permissions are the route's existing ORDER_READ_ALL.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, PaymentMethod, ProductStatus, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { orderItemMeasure, sizeNameAgrees } from '../../src/modules/admin/admin-order.service';
import { STORE_COORDS, seedAddress, seedProduct, seedSellerListing, sellerLifecycleFields } from '../helpers/fixtures';

let panelSeq = 0;
async function panelUser(role: UserRole): Promise<string> {
  panelSeq += 1;
  const email = `detail${panelSeq}@adione.test`;
  await prisma.user.create({
    data: { mobile: `00000005${String(panelSeq).padStart(2, '0')}`, email, fullName: 'Ops', passwordHash: await hashPassword('TestAdmin@123'), role },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email, password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

interface DetailItem {
  productName: string;
  variantName: string;
  sku: string;
  imageUrl: string | null;
  qty: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  measure: { unit: string; unitValue: number } | null;
  variant?: unknown;
}
interface Detail {
  orderNumber: string;
  paymentMethod: string;
  paymentStatus: string;
  itemsSubtotalPaise: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  totalPaise: number;
  deliveryFullName: string;
  sellerOrders: { seller: { name: string }; subtotalPaise: number; items: DetailItem[] }[];
}

beforeEach(async () => {
  await truncateAll();
  invalidateCategoryCache();
  await configService.invalidateAll();
  await cache.clear();
});

/** A live grocery store, open all day. */
async function seedSeller(name: string): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      sellerType: 'GROCERY',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: 'Asia/Kolkata',
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '00:00', isClosed: false })),
  });
  return seller.id;
}

/** Garlic 500 g × 2 and 1 kg × 1 from one store, rice 1 kg × 3 from another — one COD order. */
async function placeMixedOrder() {
  const storeA = await seedSeller('Aadione Grocery Store');
  const storeB = await seedSeller('Rice Mart');
  const garlic = await seedProduct(storeA, { name: 'Garlic', pricePaise: 12000, mrpPaise: 14000 });
  await prisma.productVariant.update({ where: { id: garlic!.variantId }, data: { variantName: '1 kg', unit: UnitType.KG, unitValue: 1 } });
  const halfKilo = await prisma.productVariant.create({
    data: { productId: garlic!.productId, sku: 'GARLIC-500G', variantName: '500 g', unit: UnitType.G, unitValue: 500, status: ProductStatus.ACTIVE },
  });
  const halfKiloListing = await seedSellerListing(storeA, halfKilo.id, { pricePaise: 6500, mrpPaise: 7000, stockQty: 20 });
  const rice = await seedProduct(storeB, { name: 'Basmati Rice', pricePaise: 9000, mrpPaise: 10000 });

  const mobile = '9876500091';
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  const addressId = await seedAddress(session.userId);
  const add = (sellerListingId: string, qty: number) =>
    api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId, qty }).expect(200);
  await add(halfKiloListing, 2);
  await add(garlic!.storeVariantId, 1);
  await add(rice!.storeVariantId, 3);
  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(session.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD })
    .expect(201);
  return { orderId: expectSuccess<{ order: { id: string } }>(res.body).data.order.id, customerToken: session.accessToken, halfKiloId: halfKilo.id };
}

const detailOf = async (token: string, orderId: string) =>
  expectSuccess<Detail>((await api().get(`/api/v1/admin/orders/${orderId}`).set('Authorization', bearer(token)).expect(200)).body).data;

describe('admin order detail', () => {
  it('every line with its ordered size, quantity, prices and SKU, grouped by seller; the measured size from the variant', async () => {
    const { orderId } = await placeMixedOrder();
    const detail = await detailOf(await panelUser(UserRole.ADMIN), orderId);

    expect(detail.paymentMethod).toBe('COD');
    expect(detail.sellerOrders).toHaveLength(2);
    const lines = detail.sellerOrders.flatMap((so) => so.items);
    const line = (name: string, size: string) => lines.find((item) => item.productName === name && item.variantName === size)!;

    expect(line('Garlic', '500 g')).toMatchObject({ qty: 2, unitPricePaise: 6500, lineTotalPaise: 13000, sku: 'GARLIC-500G', measure: { unit: 'G', unitValue: 500 } });
    expect(line('Garlic', '1 kg')).toMatchObject({ qty: 1, unitPricePaise: 12000, lineTotalPaise: 12000, measure: { unit: 'KG', unitValue: 1 } });
    expect(line('Basmati Rice', '1 kg')).toMatchObject({ qty: 3, unitPricePaise: 9000, lineTotalPaise: 27000, measure: { unit: 'KG', unitValue: 1 } });
    // The live variant row itself is not sent.
    for (const item of lines) expect(item.variant).toBeUndefined();

    // Seller subtotals add up to the items subtotal; the customer total is one figure.
    expect(detail.sellerOrders.reduce((sum, so) => sum + so.subtotalPaise, 0)).toBe(detail.itemsSubtotalPaise);
    expect(detail.totalPaise).toBe(detail.itemsSubtotalPaise + detail.deliveryFeePaise + detail.platformFeePaise);
  });

  it('a variant renamed or resized after the order: the ordered size stays, no measure is computed from today\'s variant', async () => {
    const { orderId, halfKiloId } = await placeMixedOrder();
    await prisma.productVariant.update({ where: { id: halfKiloId }, data: { variantName: '750 g', unitValue: 750 } });
    const detail = await detailOf(await panelUser(UserRole.ADMIN), orderId);
    const line = detail.sellerOrders.flatMap((so) => so.items).find((item) => item.sku === 'GARLIC-500G')!;
    expect(line).toMatchObject({ variantName: '500 g', qty: 2, measure: null });
  });

  it('a variant deleted since: still the ordered snapshot, measure null', async () => {
    const { orderId, halfKiloId } = await placeMixedOrder();
    await prisma.orderItem.updateMany({ where: { variantId: halfKiloId }, data: { variantId: null } });
    const detail = await detailOf(await panelUser(UserRole.ADMIN), orderId);
    expect(detail.sellerOrders.flatMap((so) => so.items).find((item) => item.sku === 'GARLIC-500G')).toMatchObject({ variantName: '500 g', measure: null });
  });

  it('permissions unchanged: staff can read it (ORDER_READ_ALL); a customer cannot', async () => {
    const { orderId, customerToken } = await placeMixedOrder();
    await detailOf(await panelUser(UserRole.STAFF), orderId);
    const denied = await api().get(`/api/v1/admin/orders/${orderId}`).set('Authorization', bearer(customerToken));
    expect([401, 403]).toContain(denied.status);
  });
});

describe('orderItemMeasure', () => {
  it('only the same-named, positive-sized variant', () => {
    expect(orderItemMeasure({ variantName: '500 g' }, { variantName: '500 g', unit: 'G', unitValue: 500 })).toEqual({ unit: 'G', unitValue: 500 });
    expect(orderItemMeasure({ variantName: '500 g' }, { variantName: '1 kg', unit: 'KG', unitValue: 1 })).toBeNull();
    expect(orderItemMeasure({ variantName: '500 g' }, null)).toBeNull();
    expect(orderItemMeasure({ variantName: 'Pack' }, { variantName: 'Pack', unit: 'PACK', unitValue: 0 })).toBeNull();
  });

  it('never when the name and the structured size disagree (typed separately by the seller)', () => {
    // Named "1 kg" but saved as 500 G: a total would be wrong — none is given.
    expect(orderItemMeasure({ variantName: '1 kg' }, { variantName: '1 kg', unit: 'G', unitValue: 500 })).toBeNull();
    // Pieces / packs / an unmeasured name: no total.
    expect(orderItemMeasure({ variantName: '1 kg' }, { variantName: '1 kg', unit: 'PIECE', unitValue: 1 })).toBeNull();
    expect(orderItemMeasure({ variantName: 'Family pack' }, { variantName: 'Family pack', unit: 'G', unitValue: 500 })).toBeNull();
  });

  it('agrees on the same size however it is written; never on a different number that merely contains it', () => {
    for (const [name, unit, value] of [
      ['500 g', 'G', 500], ['500g', 'G', 500], ['500 gm', 'G', 500], ['0.5 kg', 'G', 500], ['Garlic 500 Gms', 'G', 500],
      ['1 kg', 'KG', 1], ['1.0 kg', 'KG', 1], ['1000 g', 'KG', 1], ['2.5 kg', 'KG', 2.5],
      ['250 ml', 'ML', 250], ['1 L', 'L', 1], ['1 Ltr', 'L', 1], ['1000 ml', 'L', 1], ['500 ml', 'L', 0.5],
    ] as const) {
      expect(sizeNameAgrees(name, unit, value), `${name} ~ ${value} ${unit}`).toBe(true);
    }
    for (const [name, unit, value] of [
      ['1500 g', 'G', 500], ['500 g', 'G', 50], ['5 kg', 'KG', 1], ['10 L', 'L', 1], ['1 kg', 'G', 500], ['500 ml', 'G', 500], ['500 grams pack of 2', 'G', 50],
    ] as const) {
      expect(sizeNameAgrees(name, unit, value), `${name} !~ ${value} ${unit}`).toBe(false);
    }
  });
});

describe('admin order detail — never sent', () => {
  it('no OTP hash, idempotency key, gateway payload or account rows of the people who changed it', async () => {
    const { orderId } = await placeMixedOrder();
    const sellerOrder = await prisma.sellerOrder.findFirstOrThrow({ where: { orderId } });
    const actor = await prisma.user.create({ data: { mobile: '9000000099', fullName: 'Shop Owner', email: 'owner@shop.test', passwordHash: 'bcrypt-hash-must-not-leak', role: UserRole.SELLER_OWNER } });
    await prisma.sellerOrderStatusHistory.create({ data: { sellerOrderId: sellerOrder.id, toStatus: 'ACCEPTED', actorType: 'SELLER', actorUserId: actor.id } });
    await prisma.orderStatusHistory.create({ data: { orderId, toStatus: 'PROCESSING', actorType: 'ADMIN', actorUserId: actor.id } });
    await prisma.order.update({ where: { id: orderId }, data: { deliveryOtpHash: 'f'.repeat(64) } });
    const payment = await prisma.payment.create({ data: { orderId, provider: 'cashfree', amountPaise: 100, status: 'FAILED', rawPayload: { secret: 'gateway-payload' } } });

    const res = await api().get(`/api/v1/admin/orders/${orderId}`).set('Authorization', bearer(await panelUser(UserRole.STAFF))).expect(200);
    const body = JSON.stringify(res.body);
    for (const secret of ['bcrypt-hash-must-not-leak', 'passwordHash', 'deliveryOtpHash', 'idempotencyKey', 'rawPayload', 'gateway-payload', 'referralCode', 'owner@shop.test']) {
      expect(body.includes(secret), secret).toBe(false);
    }
    // What the panel shows is still there.
    const data = expectSuccess<{ statusHistory: { actor: { fullName: string; role: string } | null }[]; payments: { id: string; status: string }[] }>(res.body).data;
    expect(data.statusHistory.find((h) => h.actor?.fullName === 'Shop Owner')?.actor).toEqual({ fullName: 'Shop Owner', role: 'SELLER_OWNER' });
    // Every actor is just a name and a role.
    for (const h of data.statusHistory) if (h.actor) expect(Object.keys(h.actor).sort()).toEqual(['fullName', 'role']);
    expect(data.payments.map((p) => p.id)).toContain(payment.id);
  });
});
