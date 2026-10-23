/**
 * A coupon's limits hold under concurrent checkouts: the use is claimed
 * atomically inside the order transaction (order.service), so simultaneous
 * orders can never use a limited coupon more often than allowed.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, PaymentMethod } from '../../src/shared';
import { api, bearer, expectError, loginCustomerApp } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedAddress, seedProduct, seedStore } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';

const CUSTOMERS = ['9876501001', '9876501002', '9876501003', '9876501004'];

async function shopper(mobile: string, listingId: string) {
  const session = await loginCustomerApp(mobile);
  const addressId = await seedAddress(session.userId);
  await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: listingId, qty: 1 }).expect(200);
  return { ...session, addressId };
}

const placeOrder = (s: { accessToken: string; addressId: string }, couponCode: string) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(s.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId: s.addressId, paymentMethod: PaymentMethod.COD, couponCode });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('coupon limits under concurrent checkouts', () => {
  it('a coupon limited to ONE use is used exactly once when several customers check out at the same moment', async () => {
    const storeId = await seedStore();
    // Each customer buys a DIFFERENT product: no shared stock row serialises the checkouts.
    const products = [];
    for (let i = 0; i < CUSTOMERS.length; i += 1) products.push(await seedProduct(storeId, { name: `Item ${i}`, stockQty: 50, pricePaise: 50_000 }));
    await prisma.coupon.create({ data: { code: 'FIRSTONLY', type: 'FLAT', discountValue: 1000, usageLimitTotal: 1, usageLimitPerUser: 1 } });
    const shoppers = [];
    for (const [i, mobile] of CUSTOMERS.entries()) shoppers.push(await shopper(mobile, products[i]!.storeVariantId));

    const results = await Promise.all(shoppers.map((s) => placeOrder(s, 'FIRSTONLY')));

    const placed = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status !== 201);
    expect(placed).toHaveLength(1);
    for (const r of refused) expect(expectError(r.body).code).toBe(ErrorCode.COUPON_LIMIT_REACHED);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: 'FIRSTONLY' } })).usedCount).toBe(1);
    expect(await prisma.couponRedemption.count()).toBe(1);
    expect(await prisma.order.count({ where: { couponCode: 'FIRSTONLY' } })).toBe(1);
    // Refused checkouts left nothing behind: no extra order, stock reserved only for the one placed.
    expect(await prisma.order.count()).toBe(1);
  });

  it('a coupon limited to 2 uses in total is used exactly twice', async () => {
    const storeId = await seedStore();
    // Each customer buys a DIFFERENT product: no shared stock row serialises the checkouts.
    const products = [];
    for (let i = 0; i < CUSTOMERS.length; i += 1) products.push(await seedProduct(storeId, { name: `Item ${i}`, stockQty: 50, pricePaise: 50_000 }));
    await prisma.coupon.create({ data: { code: 'TWOUSES', type: 'FLAT', discountValue: 1000, usageLimitTotal: 2, usageLimitPerUser: 1 } });
    const shoppers = [];
    for (const [i, mobile] of CUSTOMERS.entries()) shoppers.push(await shopper(mobile, products[i]!.storeVariantId));

    const results = await Promise.all(shoppers.map((s) => placeOrder(s, 'TWOUSES')));

    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: 'TWOUSES' } })).usedCount).toBe(2);
    expect(await prisma.couponRedemption.count()).toBe(2);
  });
});
