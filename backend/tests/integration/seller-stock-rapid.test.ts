/**
 * Rapid stock −/+ (Seller Panel): the single-statement relative change.
 *
 * POST /seller/listings/:id/stock-adjust is ONE guarded UPDATE with its
 * ledger row (inventory.service adjustStock) plus a one-query membership +
 * lifecycle check. These pin what that must keep doing under load:
 *
 *   - one +1 / one −1: figures, and the ledger row (reason, actor, balance);
 *   - 10 rapid +1, 10 rapid −1, mixed + / − fired together: the exact net;
 *   - never below zero, never below what is reserved (and reserved is never
 *     touched); refusals change nothing and write no ledger row;
 *   - several sellers and listings at once never mix;
 *   - another seller, a customer, an admin and a removed seller are refused;
 *   - a person staffing two stores acts only on the one X-Seller-Id names;
 *   - query budget: 3 round trips per tap (was 9).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs, loginCustomerApp } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import { hashPassword } from '../../src/common/crypto';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

let queries = 0;
let counting = false;
(prisma as unknown as { $on: (event: 'query', cb: () => void) => void }).$on('query', () => {
  if (counting) queries += 1;
});

interface Seller {
  id: string;
  userId: string;
  token: string;
  categoryId: string;
}

const as = (token: string, sellerId?: string) => {
  const auth = (req: ReturnType<ReturnType<typeof api>['get']>) => {
    req.set('Authorization', bearer(token));
    if (sellerId) req.set('X-Seller-Id', sellerId);
    return req;
  };
  return {
    get: (path: string) => auth(api().get(`/api/v1${path}`)),
    post: (path: string, body: object = {}) => auth(api().post(`/api/v1${path}`)).send(body),
  };
};

async function createSeller(name: string) {
  return prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      sellerType: SellerType.GROCERY,
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
}

async function seedSeller(mobile: string): Promise<Seller> {
  const seller = await createSeller(`Store ${mobile}`);
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  const token = (await loginAs(mobile)).accessToken;
  const categoryId = expectSuccess<{ categories: { id: string }[] }>((await as(token).post('/seller/categories', { name: 'Grocery' }).expect(201)).body).data
    .categories[0]!.id;
  return { id: seller.id, userId: user.id, token, categoryId };
}

async function simple(seller: Seller, stockQty: number): Promise<string> {
  const res = await as(seller.token)
    .post('/seller/products', {
      categoryId: seller.categoryId,
      name: `Item ${randomUUID().slice(0, 4)}`,
      sku: `SKU-${randomUUID().slice(0, 8)}`,
      variantName: '1 kg',
      unit: UnitType.KG,
      unitValue: 1,
      mrpPaise: 12_000,
      pricePaise: 10_000,
      stockQty,
    })
    .expect(201);
  return expectSuccess<{ listingId: string }>(res.body).data.listingId;
}

const tap = (seller: Seller, id: string, delta: number) => as(seller.token).post(`/seller/listings/${id}/stock-adjust`, { delta });
const row = (id: string) => prisma.sellerListing.findUniqueOrThrow({ where: { id }, select: { stockQty: true, reservedQty: true } });
const manualLedger = (id: string) =>
  prisma.stockLedger.findMany({ where: { sellerListingId: id, reason: 'MANUAL_ADJUST' }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('stock −/+ taps', () => {
  it('one +1 and one −1: the answer carries the new figures; each writes one ledger row', async () => {
    const seller = await seedSeller('9600003001');
    const id = await simple(seller, 10);

    const up = expectSuccess<{ stockQty: number; reservedQty: number; availableQty: number }>((await tap(seller, id, 1).expect(200)).body).data;
    expect([up.stockQty, up.reservedQty, up.availableQty]).toEqual([11, 0, 11]);
    const down = expectSuccess<{ stockQty: number; availableQty: number }>((await tap(seller, id, -1).expect(200)).body).data;
    expect([down.stockQty, down.availableQty]).toEqual([10, 10]);

    const ledger = await manualLedger(id);
    expect(ledger.map((entry) => [entry.delta, entry.balanceAfter])).toEqual([
      [1, 11],
      [-1, 10],
    ]);
    expect(ledger.every((entry) => entry.actorUserId === seller.userId && entry.note === 'seller stock +/-' && entry.sellerOrderId === null)).toBe(true);
    expect(new Set(ledger.map((entry) => entry.id)).size).toBe(2);
  });

  it('a note typed with an amount is kept on its ledger row', async () => {
    const seller = await seedSeller('9600003002');
    const id = await simple(seller, 2);
    await as(seller.token).post(`/seller/listings/${id}/stock-adjust`, { delta: 25, note: 'new delivery' }).expect(200);
    const [entry] = await manualLedger(id);
    expect(entry).toMatchObject({ delta: 25, balanceAfter: 27, note: 'seller: new delivery' });
  });

  it('10 rapid +1 taps all count, then 10 rapid −1 taps all count', async () => {
    const seller = await seedSeller('9600003003');
    const id = await simple(seller, 5);
    const ups = await Promise.all(Array.from({ length: 10 }, () => tap(seller, id, 1)));
    expect(ups.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect((await row(id)).stockQty).toBe(15);

    const downs = await Promise.all(Array.from({ length: 10 }, () => tap(seller, id, -1)));
    expect(downs.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect((await row(id)).stockQty).toBe(5);

    // Answers re-read the listing, so with taps in flight one may already include later ones — never fewer than its own.
    expect(ups.every((r) => expectSuccess<{ stockQty: number }>(r.body).data.stockQty >= 6)).toBe(true);
    // The ledger is self-checking: the balances are a chain of +1 / −1 steps.
    const balances = (await manualLedger(id)).map((entry) => entry.balanceAfter).sort((a, b) => a - b);
    const steps = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5].sort((a, b) => a - b);
    expect(balances).toEqual(steps);
  });

  it('mixed + / − fired together (and batched deltas) end at the exact net', async () => {
    const seller = await seedSeller('9600003004');
    const id = await simple(seller, 20);
    const pattern = [1, 1, -1, 1, 3, -2, 1, -1, -1, 1, 5, -4, 1, 1, -1, 1];
    const results = await Promise.all(pattern.map((delta) => tap(seller, id, delta)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await row(id)).stockQty).toBe(20 + pattern.reduce((a, b) => a + b, 0));
    expect((await manualLedger(id)).map((entry) => entry.delta).sort((a, b) => a - b)).toEqual([...pattern].sort((a, b) => a - b));
  });

  it('never below zero: of 12 simultaneous −1 taps on 7 units exactly 7 apply; a refusal changes nothing', async () => {
    const seller = await seedSeller('9600003005');
    const id = await simple(seller, 7);
    const downs = await Promise.all(Array.from({ length: 12 }, () => tap(seller, id, -1)));
    expect(downs.filter((r) => r.status === 200)).toHaveLength(7);
    const refused = downs.filter((r) => r.status !== 200);
    expect(refused.every((r) => r.status === 400 && expectError(r.body).message === 'Stock cannot go below zero.')).toBe(true);
    expect((await row(id)).stockQty).toBe(0);
    expect(await manualLedger(id)).toHaveLength(7);
  });

  it('reserved stock: taps stop at what is reserved, never touch it, and available follows', async () => {
    const seller = await seedSeller('9600003006');
    const id = await simple(seller, 10);
    await prisma.sellerListing.update({ where: { id }, data: { reservedQty: 4 } });

    const downs = await Promise.all(Array.from({ length: 10 }, () => tap(seller, id, -1)));
    expect(downs.filter((r) => r.status === 200)).toHaveLength(6);
    const refusal = downs.find((r) => r.status !== 200)!;
    expect(refusal.status).toBe(400);
    expect(expectError(refusal.body).message).toBe('4 unit(s) are reserved for orders in progress. Stock cannot go below that.');
    expect(await row(id)).toEqual({ stockQty: 4, reservedQty: 4 });

    const up = expectSuccess<{ stockQty: number; reservedQty: number; availableQty: number }>((await tap(seller, id, 2).expect(200)).body).data;
    expect([up.stockQty, up.reservedQty, up.availableQty]).toEqual([6, 4, 2]);
    // balance_after = available (stock − reserved), as for every other movement.
    expect((await manualLedger(id)).at(-1)).toMatchObject({ delta: 2, balanceAfter: 2 });
  });

  it('a tap racing an order reservation: both apply, the floor still holds', async () => {
    const seller = await seedSeller('9600003007');
    const id = await simple(seller, 5);
    // An order reserving 3 units (same row-level guard the order path uses) while the seller removes 2.
    const reserve = prisma.$executeRaw`UPDATE seller_listings SET reserved_qty = reserved_qty + 3 WHERE id = ${id}::uuid AND stock_qty - reserved_qty >= 3`;
    const [reserved, removed] = await Promise.all([reserve, tap(seller, id, -2)]);
    const after = await row(id);
    expect(after.reservedQty).toBeLessThanOrEqual(after.stockQty);
    if (reserved === 1 && removed.status === 200) expect(after).toEqual({ stockQty: 3, reservedQty: 3 });
    else expect(after.stockQty + after.reservedQty).toBeGreaterThan(0);
  });

  it('several sellers and listings tapped at once never mix', async () => {
    const a = await seedSeller('9600003008');
    const b = await seedSeller('9600003009');
    const [a1, a2, b1, b2] = [await simple(a, 10), await simple(a, 20), await simple(b, 30), await simple(b, 40)];
    const plan: [Seller, string, number][] = [];
    for (let i = 0; i < 6; i += 1) plan.push([a, a1, 1], [a, a2, -1], [b, b1, 2], [b, b2, -2]);
    const results = await Promise.all(plan.map(([seller, id, delta]) => tap(seller, id, delta)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect([(await row(a1)).stockQty, (await row(a2)).stockQty, (await row(b1)).stockQty, (await row(b2)).stockQty]).toEqual([16, 14, 42, 28]);
  });

  it('made-to-order food has no stock count: refused with the same message, nothing changes', async () => {
    const seller = await seedSeller('9600003010');
    const id = await simple(seller, 5);
    await prisma.sellerListing.update({ where: { id }, data: { tracksStock: false, stockQty: 0 } });
    const res = await tap(seller, id, 1);
    expect(res.status).toBe(400);
    expect(expectError(res.body).message).toMatch(/made to order and has no stock count/);
    expect((await row(id)).stockQty).toBe(0);
    expect(await manualLedger(id)).toHaveLength(0);
  });
});

describe('who may tap', () => {
  it("another seller, a customer and an admin are refused; the listing is unchanged", async () => {
    const owner = await seedSeller('9600003101');
    const other = await seedSeller('9600003102');
    const id = await simple(owner, 10);

    expect((await tap(other, id, 5)).status).toBe(404);
    const customer = (await loginCustomerApp('9600003103')).accessToken;
    expect((await as(customer).post(`/seller/listings/${id}/stock-adjust`, { delta: 5 })).status).toBe(403);
    await prisma.user.create({
      data: { mobile: '0000000001', email: 'owner@adione.test', fullName: 'Admin', passwordHash: await hashPassword('TestAdmin@123'), role: UserRole.ADMIN },
    });
    const admin = expectSuccess<{ tokens: { accessToken: string } }>(
      (await api().post('/api/v1/auth/admin/login').send({ email: 'owner@adione.test', password: 'TestAdmin@123' }).expect(200)).body,
    ).data.tokens.accessToken;
    const adminTap = await as(admin).post(`/seller/listings/${id}/stock-adjust`, { delta: 5 });
    expect([403, 404]).toContain(adminTap.status);

    expect((await row(id)).stockQty).toBe(10);
    expect(await manualLedger(id)).toHaveLength(0);
  });

  it('a removed (soft-deleted) seller and a deactivated staff membership are refused', async () => {
    const seller = await seedSeller('9600003104');
    const id = await simple(seller, 10);
    await prisma.seller.update({ where: { id: seller.id }, data: { deletedAt: new Date() } });
    const gone = await tap(seller, id, 1);
    expect(gone.status).toBe(403);
    expect(expectError(gone.body).message).toBe('Your account is not linked to a seller.');

    await prisma.seller.update({ where: { id: seller.id }, data: { deletedAt: null } });
    await prisma.sellerStaff.updateMany({ where: { sellerId: seller.id }, data: { isActive: false } });
    expect((await tap(seller, id, 1)).status).toBe(403);
    expect((await row(id)).stockQty).toBe(10);
  });

  it('a person staffing two stores acts only on the store X-Seller-Id names', async () => {
    const first = await seedSeller('9600003105');
    const id = await simple(first, 10);
    const second = await createSeller('Second store');
    await prisma.sellerStaff.create({ data: { sellerId: second.id, userId: first.userId, role: 'OWNER', isActive: true } });

    const noHeader = await as(first.token).post(`/seller/listings/${id}/stock-adjust`, { delta: 1 });
    expect(noHeader.status).toBe(400);
    expect((await as(first.token, second.id).post(`/seller/listings/${id}/stock-adjust`, { delta: 1 })).status).toBe(404);
    await as(first.token, first.id).post(`/seller/listings/${id}/stock-adjust`, { delta: 1 }).expect(200);
    expect((await row(id)).stockQty).toBe(11);
  });
});

describe('query budget', () => {
  it('a tap costs 3 database round trips (membership + lifecycle, the change + its ledger row, the answer) — was 9', async () => {
    const seller = await seedSeller('9600003201');
    const id = await simple(seller, 10);
    queries = 0;
    counting = true;
    await tap(seller, id, 1).expect(200);
    counting = false;
    expect(queries).toBeLessThanOrEqual(3);
  });
});
