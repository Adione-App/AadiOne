/**
 * A shopper's first cart requests can arrive at the same moment (double tap,
 * two screens loading the cart, two devices). The partial unique index allows
 * only one live cart per customer; the requests that lose the race to create
 * it must use that cart, not fail with "already exists".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginCustomerApp } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedProduct, seedStore } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('cart creation under concurrent first requests', () => {
  it('simultaneous first cart reads all succeed and share ONE live cart', async () => {
    const { accessToken, userId } = await loginCustomerApp('9876502001');

    const results = await Promise.all(
      Array.from({ length: 6 }, () => api().get('/api/v1/cart').set('Authorization', bearer(accessToken))),
    );

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await prisma.cart.count({ where: { userId, status: 'ACTIVE' } })).toBe(1);
  });

  it('simultaneous first adds of different items both land in the one cart', async () => {
    const storeId = await seedStore();
    const a = await seedProduct(storeId, { name: 'Rice', stockQty: 20 });
    const b = await seedProduct(storeId, { name: 'Oil', stockQty: 20 });
    const { accessToken, userId } = await loginCustomerApp('9876502002');

    const results = await Promise.all(
      [a, b].map((p) =>
        api().post('/api/v1/cart/items').set('Authorization', bearer(accessToken)).send({ sellerListingId: p.storeVariantId, qty: 1 }),
      ),
    );

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const carts = await prisma.cart.findMany({ where: { userId, status: 'ACTIVE' }, include: { items: true } });
    expect(carts).toHaveLength(1);
    expect(carts[0]!.items.map((i) => i.sellerListingId).sort()).toEqual([a.storeVariantId, b.storeVariantId].sort());
  });
});
