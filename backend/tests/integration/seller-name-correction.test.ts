/**
 * Seller display-name correction (2026-10-17): "Nepali Kichen" -> "Nepali
 * Kitchen" for seller code NEPALIKICHEN (the code itself never changes).
 * Exercised on a look-alike test seller — never on real data.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ProductStatus, SellerType, UnitType, type RestaurantMenuDto, type RestaurantSummaryDto } from '../../src/shared';
import { api, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import { correctSellerName } from '../../src/modules/sellers/seller-name-correction';

let counter = 0;

async function restaurant(code: string, name: string, menuName: string) {
  const seller = await prisma.seller.create({
    data: {
      code,
      name,
      sellerType: SellerType.RESTAURANT,
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
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  await prisma.restaurantProfile.create({ data: { sellerId: seller.id, cuisine: ['Indian', 'Chicken', 'egg'], isVegOnly: false, avgPrepMins: 20 } });
  counter += 1;
  const menu = await prisma.category.create({ data: { sellerId: seller.id, name: menuName, slug: `nepali-kichen-${counter}`, path: `nepali-kichen-${counter}`, depth: 0 } });
  for (const [sectionName, item] of [['Chicken', 'Chicken Momo'], ['Roti', 'Butter Roti']] as const) {
    counter += 1;
    const section = await prisma.category.create({
      data: { sellerId: seller.id, parentId: menu.id, name: sectionName, slug: `s-${counter}`, path: `${menu.path}/s-${counter}`, depth: 1 },
    });
    const product = await prisma.product.create({
      data: {
        name: item,
        slug: `p-${counter}`,
        categoryId: section.id,
        status: ProductStatus.ACTIVE,
        approvalStatus: 'APPROVED',
        submittedBySellerId: seller.id,
        searchKeywords: [],
        attributes: { diet: sectionName === 'Chicken' ? 'NON_VEG' : 'VEG' },
      },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, sku: `NK-${counter}`, variantName: 'Regular', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
    });
    await prisma.sellerListing.create({
      data: { sellerId: seller.id, variantId: variant.id, mrpPaise: 12000, pricePaise: 12000, stockQty: 100_000, tracksStock: false, isAvailable: true },
    });
  }
  return { seller, menu };
}

const categories = (sellerId: string) =>
  prisma.category.findMany({ where: { sellerId }, select: { id: true, name: true, slug: true, path: true, parentId: true, depth: true }, orderBy: { id: 'asc' } });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  invalidateCategoryCache();
});

describe('NEPALIKICHEN: "Nepali Kichen" -> "Nepali Kitchen"', () => {
  it('dry run changes nothing; apply renames only the display name and the identically named menu; re-run is a no-op', async () => {
    const { seller, menu } = await restaurant('NEPALIKICHEN', 'Nepali Kichen', 'Nepali Kichen');
    // The KYC application's registered business name is a legal record — left as submitted.
    await prisma.sellerProfile.create({
      data: { sellerId: seller.id, businessName: 'Nepali Kichen', ownerFullName: 'Owner', ownerMobile: '9400000880' },
    });
    // Another seller using the same misspelling is not this correction's business.
    const other = await restaurant('OTHERCAFE', 'Other Cafe', 'Nepali Kichen');
    const beforeCategories = await categories(seller.id);
    const beforeListings = await prisma.sellerListing.findMany({ where: { sellerId: seller.id }, orderBy: { id: 'asc' } });

    const dry = await correctSellerName('NEPALIKICHEN', { apply: false });
    expect(dry).toMatchObject({ status: 'WOULD_CHANGE', sellerName: 'Nepali Kichen' });
    expect(dry.categories).toHaveLength(1);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } })).name).toBe('Nepali Kichen');

    const applied = await correctSellerName('NEPALIKICHEN', { apply: true });
    expect(applied).toMatchObject({ status: 'CHANGED', sellerName: 'Nepali Kitchen' });

    const after = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
    expect(after).toMatchObject({ id: seller.id, code: 'NEPALIKICHEN', name: 'Nepali Kitchen', sellerType: 'RESTAURANT' });
    // Only the menu's label changed: same ids, slugs, paths, parents; sections untouched.
    const afterCategories = await categories(seller.id);
    expect(afterCategories.map((c) => ({ ...c, name: c.id === menu.id ? 'Nepali Kichen' : c.name }))).toEqual(beforeCategories);
    expect(afterCategories.find((c) => c.id === menu.id)!.name).toBe('Nepali Kitchen');
    expect(afterCategories.filter((c) => c.depth === 1).map((c) => c.name).sort()).toEqual(['Chicken', 'Roti']);
    expect(await prisma.sellerListing.findMany({ where: { sellerId: seller.id }, orderBy: { id: 'asc' } })).toEqual(beforeListings);
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { sellerId: seller.id } })).businessName).toBe('Nepali Kichen');
    expect((await prisma.category.findUniqueOrThrow({ where: { id: other.menu.id } })).name).toBe('Nepali Kichen');
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: other.seller.id } })).name).toBe('Other Cafe');
    expect(await prisma.auditLog.count({ where: { action: 'seller.name_correction', entityId: seller.id } })).toBe(1);

    // Customers see the corrected name everywhere the restaurant appears.
    const list = expectSuccess<RestaurantSummaryDto[]>((await api().get('/api/v1/restaurants?type=RESTAURANT').expect(200)).body).data;
    const row = list.find((r) => r.sellerId === seller.id)!;
    expect(row.name).toBe('Nepali Kitchen');
    expect(row.dietClass).toBe('MIXED');
    const page = expectSuccess<RestaurantMenuDto>((await api().get(`/api/v1/restaurants/${seller.id}`).expect(200)).body).data;
    expect(page.restaurant.name).toBe('Nepali Kitchen');
    expect(page.menus.map((m) => m.name)).toEqual(['Nepali Kitchen']);
    expect(page.sections.map((s) => s.name).sort()).toEqual(['Chicken', 'Roti']);
    expect(JSON.stringify(page)).not.toContain('Kichen');

    const again = await correctSellerName('NEPALIKICHEN', { apply: true });
    expect(again.status).toBe('ALREADY_DONE');
    expect(await prisma.auditLog.count({ where: { action: 'seller.name_correction', entityId: seller.id } })).toBe(1);
  });

  it('changes nothing when the current name is not the expected misspelling, the code is unknown, or no correction is listed', async () => {
    const { seller } = await restaurant('NEPALIKICHEN', 'Nepali Momo House', 'Main Menu');
    expect((await correctSellerName('NEPALIKICHEN', { apply: true })).status).toBe('UNEXPECTED_NAME');
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } })).name).toBe('Nepali Momo House');
    await prisma.seller.update({ where: { id: seller.id }, data: { code: 'SOMETHINGELSE' } });
    expect((await correctSellerName('NEPALIKICHEN', { apply: true })).status).toBe('NOT_FOUND');
    expect((await correctSellerName('SOMETHINGELSE', { apply: true })).status).toBe('NO_CORRECTION');
    expect(await prisma.auditLog.count({ where: { action: 'seller.name_correction' } })).toBe(0);
  });
});
