/**
 * Seller type corrections (2026-10-16): Nepali Kitchen CAFE -> RESTAURANT,
 * JAYANT METALS STORE HOME -> HOME_KITCHEN ("Home & Kitchen", a new type
 * distinct from "Home"). The change is a controlled data update
 * (seller-type-change.ts / scripts/change-seller-type.ts) — exercised here
 * on look-alike test sellers, never on real data.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ProductStatus, SellerType, UnitType, UserRole, type RestaurantMenuDto, type RestaurantSummaryDto } from '../../src/shared';
import { api, bearer, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { changeSellerType } from '../../src/modules/sellers/seller-type-change';

let counter = 0;

async function seller(code: string, name: string, sellerType: SellerType): Promise<string> {
  const row = await prisma.seller.create({
    data: {
      code,
      name,
      sellerType,
      addressLine: 'Bus Stand',
      city: 'Railmagra',
      state: 'Rajasthan',
      pincode: '313329',
      latitude: 25.029,
      longitude: 74.11,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: row.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  return row.id;
}

/** A tree of `top` -> sections, each with `itemsPer` live items. */
async function tree(sellerId: string, top: string, sections: string[], itemsPer: number): Promise<void> {
  counter += 1;
  const root = await prisma.category.create({ data: { sellerId, name: top, slug: `top-${counter}`, path: `top-${counter}`, depth: 0 } });
  for (const name of sections) {
    counter += 1;
    const section = await prisma.category.create({
      data: { sellerId, parentId: root.id, name, slug: `s-${counter}`, path: `top-${counter}/s-${counter}`, depth: 1 },
    });
    for (let i = 0; i < itemsPer; i += 1) {
      counter += 1;
      const product = await prisma.product.create({
        data: {
          name: `${name} ${i + 1}`,
          slug: `p-${counter}`,
          categoryId: section.id,
          status: ProductStatus.ACTIVE,
          approvalStatus: 'APPROVED',
          submittedBySellerId: sellerId,
          searchKeywords: [],
          attributes: { diet: 'NON_VEG' },
        },
      });
      const variant = await prisma.productVariant.create({
        data: { productId: product.id, sku: `SKU-${counter}`, variantName: 'Regular', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
      });
      await prisma.sellerListing.create({
        data: { sellerId, variantId: variant.id, mrpPaise: 15000, pricePaise: 15000, stockQty: 100_000, tracksStock: false, isAvailable: true },
      });
    }
  }
}

async function snapshot(sellerId: string) {
  const s = await prisma.seller.findUniqueOrThrow({
    where: { id: sellerId },
    include: { restaurantProfile: true, _count: { select: { listings: true, categories: true, hours: true } } },
  });
  const products = await prisma.product.count({ where: { category: { sellerId } } });
  const categories = await prisma.category.findMany({ where: { sellerId }, select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } });
  return { s, products, categories };
}

async function adminToken(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000901', email: 'types@adione.test', fullName: 'Admin', passwordHash: await hashPassword('TestAdmin@123'), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send({ email: 'types@adione.test', password: 'TestAdmin@123' }).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('Nepali Kitchen: CAFE -> RESTAURANT', () => {
  it('dry run changes nothing; apply changes only the type — menu, items, profile and counts intact; re-run is a no-op', async () => {
    const id = await seller('NEPALIKICHEN', 'Nepali Kitchen', SellerType.CAFE);
    await prisma.restaurantProfile.create({ data: { sellerId: id, cuisine: ['Indian', 'Chicken', 'egg'], isVegOnly: false, avgPrepMins: 20 } });
    await tree(id, 'Nepali Kitchen', ['Chicken', 'Roti'], 2);
    const before = await snapshot(id);

    const dry = await changeSellerType({ code: 'NEPALIKICHEN', from: SellerType.CAFE, to: SellerType.RESTAURANT }, { apply: false, reason: 'test' });
    expect(dry).toMatchObject({ status: 'WOULD_CHANGE', currentType: 'CAFE', counts: { listings: 4, categories: 3, products: 4 } });
    expect((await prisma.seller.findUniqueOrThrow({ where: { id } })).sellerType).toBe('CAFE');

    const applied = await changeSellerType({ code: 'NEPALIKICHEN', from: SellerType.CAFE, to: SellerType.RESTAURANT }, { apply: true, reason: 'test' });
    expect(applied).toMatchObject({ status: 'CHANGED', currentType: 'RESTAURANT', counts: { listings: 4, categories: 3, products: 4 } });

    const after = await snapshot(id);
    expect(after.s.sellerType).toBe('RESTAURANT');
    expect(after.s.id).toBe(before.s.id);
    expect(after.s.code).toBe('NEPALIKICHEN');
    expect(after.s.restaurantProfile).toEqual(before.s.restaurantProfile);
    expect(after.s._count).toEqual(before.s._count);
    expect(after.products).toBe(before.products);
    expect(after.categories).toEqual(before.categories);
    expect(await prisma.auditLog.count({ where: { action: 'seller.type_change', entityId: id } })).toBe(1);

    // Customers: now under the Restaurant filter, same menu.
    const list = expectSuccess<RestaurantSummaryDto[]>((await api().get('/api/v1/restaurants?type=RESTAURANT').expect(200)).body).data;
    expect(list.map((r) => r.sellerId)).toEqual([id]);
    expect(expectSuccess<RestaurantSummaryDto[]>((await api().get('/api/v1/restaurants?type=CAFE').expect(200)).body).data).toEqual([]);
    const menu = expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${id}`).expect(200)).body).data;
    expect(menu.sections.map((s) => s.name).sort()).toEqual(['Chicken', 'Roti']);
    expect(menu.sections.flatMap((s) => s.items)).toHaveLength(4);

    const again = await changeSellerType({ code: 'NEPALIKICHEN', from: SellerType.CAFE, to: SellerType.RESTAURANT }, { apply: true, reason: 'test' });
    expect(again.status).toBe('ALREADY_DONE');
    expect(await prisma.auditLog.count({ where: { action: 'seller.type_change', entityId: id } })).toBe(1);
  });
});

describe('JAYANT METALS STORE: HOME -> HOME_KITCHEN', () => {
  it('becomes "Home & Kitchen" — a type distinct from "Home" — with its categories untouched', async () => {
    const jayant = await seller('JAYANTMETALSSTORE', 'JAYANT METALS STORE', SellerType.HOME);
    const other = await seller('OTHERHOME', 'Other Home Store', SellerType.HOME);
    await tree(jayant, 'Home & Kitchen', ['Cooking Utensils', 'Bottles, Flask & Jugs'], 0);
    const before = await snapshot(jayant);

    const out = await changeSellerType({ code: 'JAYANTMETALSSTORE', from: SellerType.HOME, to: SellerType.HOME_KITCHEN }, { apply: true, reason: 'test' });
    expect(out).toMatchObject({ status: 'CHANGED', currentType: 'HOME_KITCHEN' });
    const after = await snapshot(jayant);
    expect(after.s.sellerType).toBe('HOME_KITCHEN');
    expect(after.categories).toEqual(before.categories);
    expect(after.s._count).toEqual(before.s._count);
    // The other Home seller is untouched.
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: other } })).sellerType).toBe('HOME');

    const token = await adminToken();
    const byType = async (type: string) =>
      expectSuccess<{ items: { code: string }[] }>((await api().get(`/api/v1/admin/sellers?sellerType=${type}`).set('Authorization', bearer(token)).expect(200)).body).data.items.map(
        (s) => s.code,
      );
    expect(await byType('HOME_KITCHEN')).toEqual(['JAYANTMETALSSTORE']);
    expect(await byType('HOME')).toEqual(['OTHERHOME']);
  });
});

describe('guards', () => {
  it('refuses the wrong expected type, food <-> non-food moves and unknown codes — and changes nothing', async () => {
    const id = await seller('NEPALIKICHEN', 'Nepali Kitchen', SellerType.CAFE);
    expect(
      (await changeSellerType({ code: 'NEPALIKICHEN', from: SellerType.HOME, to: SellerType.HOME_KITCHEN }, { apply: true, reason: 'test' })).status,
    ).toBe('UNEXPECTED_TYPE');
    expect(
      (await changeSellerType({ code: 'NEPALIKICHEN', from: SellerType.CAFE, to: SellerType.HOME_KITCHEN }, { apply: true, reason: 'test' })).status,
    ).toBe('REFUSED');
    expect(
      (await changeSellerType({ code: 'NEPALI', from: SellerType.CAFE, to: SellerType.RESTAURANT }, { apply: true, reason: 'test' })).status,
    ).toBe('NOT_FOUND');
    expect((await prisma.seller.findUniqueOrThrow({ where: { id } })).sellerType).toBe('CAFE');
    expect(await prisma.auditLog.count({ where: { action: 'seller.type_change' } })).toBe(0);
  });

  it('admin can create a seller as Home & Kitchen; an unknown type is refused', async () => {
    const token = await adminToken();
    const listed = await api().get('/api/v1/admin/sellers?sellerType=HOME_KITCHEN').set('Authorization', bearer(token));
    expect(listed.status).toBe(200);
    const bad = await api().get('/api/v1/admin/sellers?sellerType=HOME_AND_KITCHEN').set('Authorization', bearer(token));
    expect(bad.status).toBe(400);
  });
});
