/**
 * A main (top-level) category's product listing — what the app's Categories
 * screen opens when a main category is tapped, and Home's category "See All":
 * GET /products?categoryId=<main category>.
 *
 *   - includes products assigned directly to the main category AND every
 *     product in its subcategories, merged across sellers (categories are
 *     matched by path, so each seller's own "Grocery" counts);
 *   - never a product of another main category;
 *   - an empty subcategory lists nothing; pagination (limit / cursor) walks
 *     the whole listing without repeats.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ProductStatus, UnitType, type CursorPage, type ProductSummaryDto } from '../../src/shared';
import { api, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';

let counter = 0;

async function seller(name: string): Promise<string> {
  counter += 1;
  const row = await prisma.seller.create({
    data: {
      code: `CAT-${counter}`,
      name,
      sellerType: 'GROCERY',
      addressLine: 'Main Road',
      city: 'Railmagra',
      state: 'Rajasthan',
      pincode: '313329',
      latitude: 25.03,
      longitude: 74.11,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  return row.id;
}

async function category(sellerId: string, path: string, parentId: string | null = null): Promise<string> {
  const name = path.split('/').pop()!;
  const row = await prisma.category.create({
    data: { sellerId, parentId, name, slug: name, path, depth: path.split('/').length - 1 },
  });
  return row.id;
}

async function product(sellerId: string, categoryId: string, name: string): Promise<string> {
  counter += 1;
  const row = await prisma.product.create({
    data: {
      name,
      slug: `p-${counter}`,
      categoryId,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      submittedBySellerId: sellerId,
      searchKeywords: [],
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: row.id, sku: `CAT-SKU-${counter}`, variantName: '1 kg', unit: UnitType.KG, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  await prisma.sellerListing.create({ data: { sellerId, variantId: variant.id, mrpPaise: 12000, pricePaise: 10000, stockQty: 50, isAvailable: true } });
  return row.id;
}

const page = async (query: string): Promise<CursorPage<ProductSummaryDto>> =>
  expectSuccess<CursorPage<ProductSummaryDto>>((await api().get(`/api/v1/products?${query}`).expect(200)).body).data;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('main category product listing', () => {
  it('lists the main category itself and all its subcategories, across sellers, and nothing else', async () => {
    const a = await seller('Store A');
    const b = await seller('Store B');
    const groceryA = await category(a, 'grocery');
    const snacksA = await category(a, 'grocery/snacks', groceryA);
    const emptyA = await category(a, 'grocery/empty-shelf', groceryA);
    const groceryB = await category(b, 'grocery');
    const oilB = await category(b, 'grocery/oil', groceryB);
    const fashionA = await category(a, 'fashion');

    const direct = await product(a, groceryA, 'Gift Pack (direct on Grocery)');
    const chips = await product(a, snacksA, 'Chips');
    const oil = await product(b, oilB, 'Mustard Oil');
    const shirt = await product(a, fashionA, 'Shirt');

    const listing = await page(`categoryId=${groceryA}&limit=30`);
    expect(listing.items.map((p) => p.id).sort()).toEqual([direct, chips, oil].sort());
    expect(listing.items.some((p) => p.id === shirt)).toBe(false);

    // A subcategory still lists only its own products; an empty one lists nothing.
    expect((await page(`categoryId=${snacksA}`)).items.map((p) => p.id)).toEqual([chips]);
    expect((await page(`categoryId=${emptyA}`)).items).toEqual([]);

    // Paginated: one at a time, every product exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const next: CursorPage<ProductSummaryDto> = await page(`categoryId=${groceryA}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...next.items.map((p) => p.id));
      cursor = next.hasMore ? next.nextCursor : null;
    } while (cursor);
    expect(seen.sort()).toEqual([direct, chips, oil].sort());
  });
});
