/**
 * Configuration scopes and the cache: a seller reads the GLOBAL map with its
 * own overrides on top. A change to a global value must reach every seller at
 * once — a seller's scope used to cache the already-merged map, so it kept
 * the old global value until its own cache entry expired.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey } from '../../src/shared';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { sellerLifecycleFields } from '../helpers/fixtures';

async function seedSellerRow(): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Config Seller',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      ...sellerLifecycleFields('APPROVED'),
    },
  });
  return seller.id;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('configuration scopes', () => {
  it('a global change reaches an already-cached seller scope immediately', async () => {
    const sellerId = await seedSellerRow();
    await configService.set({ key: ConfigKey.ALLOW_ORDERS_WHEN_CLOSED, value: false });
    // Warm the seller's cache with the old global value.
    expect(await configService.get(ConfigKey.ALLOW_ORDERS_WHEN_CLOSED, sellerId)).toBe(false);

    await configService.set({ key: ConfigKey.ALLOW_ORDERS_WHEN_CLOSED, value: true });
    expect(await configService.get(ConfigKey.ALLOW_ORDERS_WHEN_CLOSED, sellerId)).toBe(true);
    expect(await configService.get(ConfigKey.ALLOW_ORDERS_WHEN_CLOSED)).toBe(true);
  });

  it("a seller's own override wins over the global value, and only for that seller", async () => {
    const sellerId = await seedSellerRow();
    const otherId = await seedSellerRow();
    await configService.set({ key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: 8 });
    await configService.set({ key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: 3, sellerId });

    expect(await configService.get(ConfigKey.MAX_SERVICE_RADIUS_KM, sellerId)).toBe(3);
    expect(await configService.get(ConfigKey.MAX_SERVICE_RADIUS_KM, otherId)).toBe(8);

    // A later global change leaves the override alone but reaches the rest.
    await configService.set({ key: ConfigKey.MAX_SERVICE_RADIUS_KM, value: 10 });
    expect(await configService.get(ConfigKey.MAX_SERVICE_RADIUS_KM, sellerId)).toBe(3);
    expect(await configService.get(ConfigKey.MAX_SERVICE_RADIUS_KM, otherId)).toBe(10);
  });
});
