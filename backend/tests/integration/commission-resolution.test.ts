/**
 * `resolveCommissionBpBatch` — the batched replacement for the sequential,
 * per-item `resolveCommissionBp` calls `placeOrder` used to make inside its
 * order-creation transaction (see order.service.ts's own comment on why
 * batching this was safe: CommissionRule/Seller.defaultCommissionBp are
 * read-only inputs, never locked or written by that transaction).
 *
 * The property under test: the batched version must resolve EXACTLY what
 * the individual, per-item version would for the same inputs — precedence
 * (product > category > seller default), independently per seller, in one
 * call covering many lines at once.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCommissionBp,
  resolveCommissionBpBatch,
} from '../../src/modules/commission/commission.service';
import { prisma, truncateAll } from '../helpers/db';
import { seedProduct, seedStore } from '../helpers/fixtures';

async function seedOtherSeller(defaultCommissionBp: number): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `OTHER-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Commission Test Seller',
      isPlatformOwned: false,
      addressLine: 'Test Address',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      defaultCommissionBp,
    },
  });
  return seller.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe('resolveCommissionBpBatch', () => {
  it('matches per-item resolveCommissionBp for a product-level rule, a category-level rule, and a bare default — across different sellers, in one call', async () => {
    const sellerAId = await seedStore();
    await prisma.seller.update({ where: { id: sellerAId }, data: { defaultCommissionBp: 200 } });
    const sellerBId = await seedOtherSeller(700);
    const sellerCId = await seedOtherSeller(150);

    const productA = await seedProduct(sellerAId, {});
    const productB = await seedProduct(sellerBId, {});
    const productC = await seedProduct(sellerCId, {});

    const [{ categoryId: categoryAId, productId: productAId }, { categoryId: categoryBId, productId: productBId }, { categoryId: categoryCId, productId: productCId }] =
      [productA, productB, productC];

    // Product-level rule for seller A — must win over any category rule too.
    await prisma.commissionRule.create({
      data: { sellerId: sellerAId, productId: productAId, rateBp: 900, isActive: true },
    });
    // Category-level rule for seller B — no product-level rule exists for it.
    await prisma.commissionRule.create({
      data: { sellerId: sellerBId, categoryId: categoryBId, rateBp: 450, isActive: true },
    });
    // Seller C has no rules at all — must fall back to its own default.

    const requests = [
      { sellerId: sellerAId, categoryId: categoryAId, productId: productAId },
      { sellerId: sellerBId, categoryId: categoryBId, productId: productBId },
      { sellerId: sellerCId, categoryId: categoryCId, productId: productCId },
    ];
    const sellerDefaults = new Map([
      [sellerAId, 200],
      [sellerBId, 700],
      [sellerCId, 150],
    ]);

    const batched = await resolveCommissionBpBatch(requests, sellerDefaults);
    expect(batched).toEqual([900, 450, 150]);

    // Equivalence: the same three inputs, resolved one at a time the OLD
    // way, must agree exactly with the batched result.
    const individually = await Promise.all(requests.map((r) => resolveCommissionBp(r)));
    expect(individually).toEqual(batched);
  });

  it('returns an empty array for no requests, without querying anything', async () => {
    await expect(resolveCommissionBpBatch([], new Map())).resolves.toEqual([]);
  });

  it('throws rather than silently defaulting to 0 when a seller default is missing from the map', async () => {
    const sellerId = await seedStore();
    const product = await seedProduct(sellerId, {});

    await expect(
      resolveCommissionBpBatch(
        [{ sellerId, categoryId: product.categoryId, productId: product.productId }],
        new Map(), // deliberately missing sellerId
      ),
    ).rejects.toThrow(/no defaultCommissionBp supplied/);
  });

  it('an inactive rule is ignored, falling through to the next level', async () => {
    const sellerId = await seedStore();
    const product = await seedProduct(sellerId, {});

    await prisma.commissionRule.create({
      data: { sellerId, productId: product.productId, rateBp: 999, isActive: false },
    });

    const [rate] = await resolveCommissionBpBatch(
      [{ sellerId, categoryId: product.categoryId, productId: product.productId }],
      new Map([[sellerId, 250]]),
    );
    expect(rate).toBe(250); // the inactive product rule must not apply
  });
});
