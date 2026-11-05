/**
 * The seller panel's stock path, made fast WITHOUT loosening anything:
 *
 *   - the one-query listing load answers exactly like the per-relation one
 *     (compared field by field against the bulk list, which still uses it);
 *   - ownership is enforced by the row lock itself (another seller: 404,
 *     nothing changed);
 *   - concurrent +/− never lose an update and never take stock below zero
 *     (every change is a row-locked relative update with its ledger row);
 *   - a direct quantity below what is reserved is refused, as before;
 *   - query budgets: what each change costs in database round trips.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

let queries = 0;
let counting = false;
(prisma as unknown as { $on: (event: 'query', cb: () => void) => void }).$on('query', () => {
  if (counting) queries += 1;
});
async function countQueries(run: () => Promise<unknown>): Promise<number> {
  queries = 0;
  counting = true;
  try {
    await run();
  } finally {
    counting = false;
  }
  return queries;
}

interface Seller {
  id: string;
  token: string;
  categoryId: string;
}
async function seedSeller(mobile: string, sellerType: SellerType = SellerType.GROCERY): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Store ${mobile}`,
      sellerType,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  const token = (await loginAs(mobile)).accessToken;
  const categoryId =
    sellerType === SellerType.RESTAURANT
      ? expectSuccess<{ id: string }>((await as(token).post('/seller/menu-sections', { name: 'Mains' }).expect(201)).body).data.id
      : expectSuccess<{ categories: { id: string }[] }>((await as(token).post('/seller/categories', { name: 'Grocery' }).expect(201)).body).data.categories[0]!.id;
  return { id: seller.id, token, categoryId };
}
const as = (token: string) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
});
async function simple(seller: Seller, stockQty = 10): Promise<string> {
  const res = await as(seller.token)
    .post('/seller/products', { categoryId: seller.categoryId, name: `Item ${randomUUID().slice(0, 4)}`, sku: `SKU-${randomUUID().slice(0, 8)}`, variantName: '1 kg', unit: UnitType.KG, unitValue: 1, mrpPaise: 12_000, pricePaise: 10_000, stockQty })
    .expect(201);
  return expectSuccess<{ listingId: string }>(res.body).data.listingId;
}
const listing = async (seller: Seller, id: string) => expectSuccess<{ stockQty: number; reservedQty: number; availableQty: number }>((await as(seller.token).get(`/seller/listings/${id}`).expect(200)).body).data;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('one-query listing answer', () => {
  it('is field-for-field the same as the list (simple, sized, food, with and without a photo)', async () => {
    const grocery = await seedSeller('9600002001');
    const food = await seedSeller('9600002002', SellerType.RESTAURANT);
    await simple(grocery);
    await as(grocery.token)
      .post('/seller/products', {
        categoryId: grocery.categoryId,
        name: 'Sized',
        optionGroups: [{ name: 'Weight', values: ['250g', '500g'] }],
        variants: [
          { optionValues: { Weight: '250g' }, sku: `S-${randomUUID().slice(0, 6)}`, pricePaise: 2_000, mrpPaise: 2_500, stockQty: 3 },
          { optionValues: { Weight: '500g' }, sku: `S-${randomUUID().slice(0, 6)}`, pricePaise: 3_900, mrpPaise: 4_400, stockQty: 0 },
        ],
      })
      .expect(201);
    await as(food.token).post('/seller/products', { categoryId: food.categoryId, name: 'Dal', pricePaise: 15_000 }).expect(201);
    // One product with a photo row (the answer carries its first photo).
    const someProduct = await prisma.product.findFirstOrThrow({ where: { submittedBySellerId: grocery.id } });
    await prisma.productImage.create({ data: { productId: someProduct.id, url: 'https://cdn.example/x.webp', thumbUrl: 'https://cdn.example/x-t.webp', cardUrl: 'https://cdn.example/x-t.webp', displayOrder: 0 } });

    for (const seller of [grocery, food]) {
      const all = expectSuccess<{ id: string }[]>((await as(seller.token).get('/seller/listings').expect(200)).body).data;
      expect(all.length).toBeGreaterThan(0);
      for (const row of all) expect(expectSuccess((await as(seller.token).get(`/seller/listings/${row.id}`).expect(200)).body).data).toEqual(row);
    }
  });
});

describe('stock +/− and direct quantity', () => {
  it("another seller's listing is not found and is never changed", async () => {
    const owner = await seedSeller('9600002011');
    const other = await seedSeller('9600002012');
    const id = await simple(owner, 10);
    expect((await as(other.token).post(`/seller/listings/${id}/stock-adjust`, { delta: 5 })).status).toBe(404);
    expect((await as(other.token).patch(`/seller/listings/${id}`, { stockQty: 99 })).status).toBe(404);
    expect((await listing(owner, id)).stockQty).toBe(10);
    expect(await prisma.stockLedger.count({ where: { sellerListingId: id } })).toBe(1); // opening stock only
  });

  it('20 simultaneous +1 taps all count; simultaneous −1 taps stop exactly at zero', async () => {
    const seller = await seedSeller('9600002021');
    const id = await simple(seller, 3);
    const ups = await Promise.all(Array.from({ length: 20 }, () => as(seller.token).post(`/seller/listings/${id}/stock-adjust`, { delta: 1 })));
    expect(ups.every((r) => r.status === 200)).toBe(true);
    expect((await listing(seller, id)).stockQty).toBe(23);

    const downs = await Promise.all(Array.from({ length: 30 }, () => as(seller.token).post(`/seller/listings/${id}/stock-adjust`, { delta: -1 })));
    expect(downs.filter((r) => r.status === 200)).toHaveLength(23);
    expect(downs.filter((r) => r.status !== 200).every((r) => r.status === 400)).toBe(true);
    expect((await listing(seller, id)).stockQty).toBe(0);
    // Every applied change has its ledger row: opening + 20 + 23.
    expect(await prisma.stockLedger.count({ where: { sellerListingId: id } })).toBe(1 + 20 + 23);
  });

  it('a batched delta (several taps sent as one) is one atomic change; below zero is refused whole', async () => {
    const seller = await seedSeller('9600002031');
    const id = await simple(seller, 5);
    await as(seller.token).post(`/seller/listings/${id}/stock-adjust`, { delta: 7 }).expect(200);
    expect((await listing(seller, id)).stockQty).toBe(12);
    const refused = await as(seller.token).post(`/seller/listings/${id}/stock-adjust`, { delta: -13 });
    expect(refused.status).toBe(400);
    expect(expectError(refused.body).message).toBeTruthy();
    expect((await listing(seller, id)).stockQty).toBe(12);
  });

  it('a direct quantity below what is reserved is refused; a valid one is set', async () => {
    const seller = await seedSeller('9600002041');
    const id = await simple(seller, 10);
    await prisma.sellerListing.update({ where: { id }, data: { reservedQty: 4 } });
    expect((await as(seller.token).patch(`/seller/listings/${id}`, { stockQty: 3 })).status).toBe(400);
    const set = expectSuccess<{ stockQty: number; availableQty: number }>((await as(seller.token).patch(`/seller/listings/${id}`, { stockQty: 6 }).expect(200)).body).data;
    expect([set.stockQty, set.availableQty]).toEqual([6, 2]);
  });

  it('query budget: a +/− tap and a direct quantity each cost at most 10 database round trips (were 20)', async () => {
    const seller = await seedSeller('9600002051');
    const id = await simple(seller, 10);
    const tap = await countQueries(() => as(seller.token).post(`/seller/listings/${id}/stock-adjust`, { delta: 1 }).expect(200));
    const direct = await countQueries(() => as(seller.token).patch(`/seller/listings/${id}`, { stockQty: 20 }).expect(200));
    expect(tap).toBeLessThanOrEqual(10);
    expect(direct).toBeLessThanOrEqual(10);
  });
});
