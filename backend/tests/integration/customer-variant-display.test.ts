/**
 * What a customer's product cards get for a product with several sizes, and
 * what cart add accepts — the server half of the customer app's smart
 * variant display / direct add (mobile lib/cardVariant.ts).
 *
 *   - Every card list (category, search, rail, store, product page) carries
 *     the product's customer-visible variants, in one deterministic order,
 *     with each one's own price, stock and store state.
 *   - Hidden, deleted, pending and rejected variants never appear; a listing
 *     switched off sale or out of stock appears as not in stock.
 *   - The card's `defaultVariant` is the default when it can be bought, else
 *     the next one that can — never a size that can't — and the seller's
 *     real default is never changed.
 *   - Cart add takes the exact listing; the optional variant / price checks
 *     refuse a mismatch, stock and visibility are re-checked, and a refused
 *     add puts nothing in the cart.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, ProductStatus, UnitType, type CartDto, type ProductDetailDto, type ProductSummaryDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedStore } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';

interface SizeSpec {
  name: string;
  pricePaise: number;
  stockQty?: number;
  isDefault?: boolean;
  displayOrder?: number;
  status?: ProductStatus;
  approvalStatus?: ApprovalStatus;
  deleted?: boolean;
  onSale?: boolean;
}

interface Seeded {
  productId: string;
  categoryId: string;
  variants: Record<string, { id: string; listingId: string }>;
}

let storeId: string;
let categoryId: string;

/** One product with the given sizes, each listed by the store. */
async function seedSized(name: string, sizes: SizeSpec[]): Promise<Seeded> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}`;
  const product = await prisma.product.create({
    data: { name, slug, categoryId, status: ProductStatus.ACTIVE, approvalStatus: ApprovalStatus.APPROVED, searchKeywords: [] },
  });
  const variants: Seeded['variants'] = {};
  for (const [index, size] of sizes.entries()) {
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `SKU-${randomUUID().slice(0, 10).toUpperCase()}`,
        variantName: size.name,
        unit: UnitType.G,
        unitValue: 1,
        isDefault: size.isDefault ?? index === 0,
        displayOrder: size.displayOrder ?? index,
        status: size.status ?? ProductStatus.ACTIVE,
        approvalStatus: size.approvalStatus ?? ApprovalStatus.APPROVED,
        deletedAt: size.deleted ? new Date() : null,
      },
    });
    const listing = await prisma.sellerListing.create({
      data: {
        sellerId: storeId,
        variantId: variant.id,
        pricePaise: size.pricePaise,
        mrpPaise: size.pricePaise + 500,
        stockQty: size.stockQty ?? 20,
        isAvailable: size.onSale ?? true,
      },
    });
    variants[size.name] = { id: variant.id, listingId: listing.id };
  }
  return { productId: product.id, categoryId, variants };
}

async function categoryCards(): Promise<ProductSummaryDto[]> {
  const res = await api().get(`/api/v1/products?categoryId=${categoryId}&limit=50`).expect(200);
  return expectSuccess<{ items: ProductSummaryDto[] }>(res.body).data.items;
}

async function cardOf(productId: string): Promise<ProductSummaryDto> {
  const card = (await categoryCards()).find((item) => item.id === productId);
  if (!card) throw new Error(`product ${productId} is not in the category listing`);
  return card;
}

async function detailOf(productId: string): Promise<ProductDetailDto> {
  return expectSuccess<ProductDetailDto>((await api().get(`/api/v1/products/${productId}`).expect(200)).body).data;
}

async function customer(): Promise<string> {
  const mobile = '9600000777';
  await otpService.clearOtpState(mobile);
  return (await loginAs(mobile)).accessToken;
}

const addToCart = (token: string, body: Record<string, unknown>) =>
  api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ qty: 1, ...body });

async function cartOf(token: string): Promise<CartDto> {
  return expectSuccess<CartDto>((await api().get('/api/v1/cart').set('Authorization', bearer(token)).expect(200)).body).data;
}

const names = (card: ProductSummaryDto) => (card.variants ?? []).map((variant) => variant.variantName);

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  // The category tree is kept in memory for a minute: each test has its own.
  invalidateCategoryCache();
  storeId = await seedStore();
  const category = await prisma.category.create({
    data: { sellerId: storeId, name: 'Fruits', slug: `fruits-${randomUUID().slice(0, 6)}`, path: 'fruits', depth: 0 },
  });
  categoryId = category.id;
});

describe('card variants — display', () => {
  it('Orange: the default 500g is out of stock, so the card shows 1kg at ₹65 with its own price', async () => {
    const orange = await seedSized('Orange', [
      { name: '500g', pricePaise: 3400, stockQty: 0, isDefault: true },
      { name: '1kg', pricePaise: 6500, stockQty: 12 },
    ]);
    const card = await cardOf(orange.productId);

    expect(card.name).toBe('Orange');
    expect(card.defaultVariant?.variantName).toBe('1kg');
    expect(card.defaultVariant?.pricePaise).toBe(6500);
    expect(card.defaultVariant?.inStock).toBe(true);
    // The whole visible set, default first, each with its own state.
    expect(names(card)).toEqual(['500g', '1kg']);
    expect(card.variants!.map((variant) => [variant.variantName, variant.pricePaise, variant.inStock])).toEqual([
      ['500g', 3400, false],
      ['1kg', 6500, true],
    ]);
    // Internal identifiers stay in the data (the app only stops SHOWING the
    // SKU and the seller): the cart and checkout still key on them.
    for (const variant of card.variants!) {
      expect(variant.sku).toMatch(/^SKU-/);
      expect(variant.sellerId).toBe(storeId);
      expect(variant.sellerName).toBe('Test Store');
      expect(variant.sellerListingId).toBeTruthy();
    }
    // The seller's real default is untouched.
    const stored = await prisma.productVariant.findUniqueOrThrow({ where: { id: orange.variants['500g']!.id } });
    expect(stored.isDefault).toBe(true);
  });

  it('a hidden default is not shown at all; the next visible size is', async () => {
    const product = await seedSized('Apple', [
      { name: '500g', pricePaise: 5000, isDefault: true, status: ProductStatus.INACTIVE },
      { name: '1kg', pricePaise: 9000 },
    ]);
    const card = await cardOf(product.productId);
    expect(names(card)).toEqual(['1kg']);
    expect(card.variantCount).toBe(1);
    expect(card.defaultVariant?.variantName).toBe('1kg');
  });

  it('deleted, pending and rejected sizes never reach a customer — even one wrongly left ACTIVE', async () => {
    const product = await seedSized('Grapes', [
      { name: '250g', pricePaise: 3000 },
      { name: '500g', pricePaise: 5500, deleted: true, status: ProductStatus.INACTIVE },
      { name: '1kg', pricePaise: 9900, status: ProductStatus.DRAFT, approvalStatus: ApprovalStatus.PENDING },
      { name: '2kg', pricePaise: 18000, status: ProductStatus.DRAFT, approvalStatus: ApprovalStatus.REJECTED },
      // A half-reviewed row: ACTIVE but not approved.
      { name: '5kg', pricePaise: 42000, approvalStatus: ApprovalStatus.PENDING },
    ]);
    const card = await cardOf(product.productId);
    expect(names(card)).toEqual(['250g']);
    expect(names(await detailOf(product.productId))).toEqual(['250g']);
  });

  it('a size switched off sale counts as not in stock', async () => {
    const product = await seedSized('Banana', [
      { name: '6 pcs', pricePaise: 4000, isDefault: true, onSale: false },
      { name: '12 pcs', pricePaise: 7600 },
    ]);
    const card = await cardOf(product.productId);
    expect(card.variants!.map((variant) => [variant.variantName, variant.inStock])).toEqual([
      ['6 pcs', false],
      ['12 pcs', true],
    ]);
    expect(card.defaultVariant?.variantName).toBe('12 pcs');
  });

  it('every size unavailable: the card keeps the default, marked not in stock', async () => {
    const product = await seedSized('Mango', [
      { name: '1kg', pricePaise: 12000, isDefault: true, stockQty: 0 },
      { name: '2kg', pricePaise: 23000, onSale: false },
    ]);
    const card = await cardOf(product.productId);
    expect(card.defaultVariant?.variantName).toBe('1kg');
    expect(card.defaultVariant?.inStock).toBe(false);
    expect(card.variants!.every((variant) => !variant.inStock)).toBe(true);
  });

  it('the order is deterministic: default, then display order, then creation time', async () => {
    const product = await seedSized('Rice', [
      { name: '5kg', pricePaise: 40000, displayOrder: 0, isDefault: false },
      { name: '1kg', pricePaise: 9000, displayOrder: 0, isDefault: false },
      { name: '10kg', pricePaise: 76000, displayOrder: 0, isDefault: true },
    ]);
    // Same display order: creation order decides, on every request.
    for (let i = 0; i < 3; i += 1) {
      expect(names(await cardOf(product.productId))).toEqual(['10kg', '5kg', '1kg']);
    }
  });

  it('category, search, rail, store and product page all agree on the variants and the card size', async () => {
    const orange = await seedSized('Orange Nagpuri', [
      { name: '500g', pricePaise: 3400, stockQty: 0, isDefault: true },
      { name: '1kg', pricePaise: 6500, stockQty: 12 },
    ]);
    const fromCategory = await cardOf(orange.productId);
    const search = expectSuccess<{ items: ProductSummaryDto[] }>(
      (await api().get('/api/v1/products/search?q=Orange').expect(200)).body,
    ).data.items.find((item) => item.id === orange.productId);
    const rail = expectSuccess<{ products: ProductSummaryDto[] }>((await api().get('/api/v1/products/rail/RECENTLY_ADDED').expect(200)).body).data.products.find(
      (item) => item.id === orange.productId,
    );
    const store = expectSuccess<{ items: ProductSummaryDto[] }>(
      (await api().get(`/api/v1/products?sellerId=${storeId}&limit=50`).expect(200)).body,
    ).data.items.find((item) => item.id === orange.productId);
    const detail = await detailOf(orange.productId);

    for (const card of [search, rail, store, detail]) {
      expect(card, 'every list carries the product').toBeDefined();
      expect(card!.defaultVariant?.id).toBe(fromCategory.defaultVariant?.id);
      expect(card!.variants).toEqual(fromCategory.variants);
      expect(card!.optionGroups).toEqual(fromCategory.optionGroups);
    }
    expect(fromCategory.defaultVariant?.variantName).toBe('1kg');
  });

  it('availability changes are reflected on the next read (the card size is recalculated)', async () => {
    const orange = await seedSized('Kinnow', [
      { name: '500g', pricePaise: 3400, stockQty: 0, isDefault: true },
      { name: '1kg', pricePaise: 6500, stockQty: 12 },
    ]);
    expect((await cardOf(orange.productId)).defaultVariant?.variantName).toBe('1kg');
    await prisma.sellerListing.update({ where: { id: orange.variants['500g']!.listingId }, data: { stockQty: 5 } });
    expect((await cardOf(orange.productId)).defaultVariant?.variantName).toBe('500g');
  });
});

describe('cart add — exact variant, server-checked', () => {
  it('the exact listing, variant and price reach the cart', async () => {
    const token = await customer();
    const orange = await seedSized('Orange', [
      { name: '500g', pricePaise: 3400, stockQty: 0, isDefault: true },
      { name: '1kg', pricePaise: 6500, stockQty: 12 },
    ]);
    const shown = (await cardOf(orange.productId)).defaultVariant!;
    const res = await addToCart(token, { sellerListingId: shown.sellerListingId, variantId: shown.id, expectedPricePaise: shown.pricePaise });
    expect(res.status).toBe(200);
    const cart = expectSuccess<CartDto>(res.body).data;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({ variantId: orange.variants['1kg']!.id, sellerListingId: orange.variants['1kg']!.listingId, unitPricePaise: 6500, qty: 1 });
  });

  it('a listing that is not of the variant the customer chose is refused, nothing added', async () => {
    const token = await customer();
    const orange = await seedSized('Orange', [
      { name: '500g', pricePaise: 3400 },
      { name: '1kg', pricePaise: 6500 },
    ]);
    const res = await addToCart(token, { sellerListingId: orange.variants['500g']!.listingId, variantId: orange.variants['1kg']!.id });
    expect(expectError(res.body).code).toBe(ErrorCode.PRODUCT_UNAVAILABLE);
    expect((await cartOf(token)).items).toHaveLength(0);
  });

  it('a price changed since the screen loaded is refused with the new price, nothing added', async () => {
    const token = await customer();
    const orange = await seedSized('Orange', [{ name: '1kg', pricePaise: 6500 }]);
    const shown = (await cardOf(orange.productId)).defaultVariant!;
    await prisma.sellerListing.update({ where: { id: shown.sellerListingId }, data: { pricePaise: 7000, mrpPaise: 7500 } });

    const res = await addToCart(token, { sellerListingId: shown.sellerListingId, variantId: shown.id, expectedPricePaise: shown.pricePaise });
    const error = expectError(res.body);
    expect(error.code).toBe(ErrorCode.PRICE_CHANGED);
    expect(error.message).toContain('₹70');
    expect((await cartOf(token)).items).toHaveLength(0);
  });

  it('stock gone between display and add is refused (cached card data does not bypass the check)', async () => {
    const token = await customer();
    const orange = await seedSized('Orange', [
      { name: '500g', pricePaise: 3400, stockQty: 0, isDefault: true },
      { name: '1kg', pricePaise: 6500, stockQty: 1 },
    ]);
    const shown = (await cardOf(orange.productId)).defaultVariant!;
    expect(shown.variantName).toBe('1kg');
    await prisma.sellerListing.update({ where: { id: shown.sellerListingId }, data: { stockQty: 0 } });

    const res = await addToCart(token, { sellerListingId: shown.sellerListingId, variantId: shown.id, expectedPricePaise: shown.pricePaise });
    expect(expectError(res.body).code).toBe(ErrorCode.ITEM_OUT_OF_STOCK);
    expect((await cartOf(token)).items).toHaveLength(0);
  });

  it('a size hidden, deleted or still under review after the card loaded is refused', async () => {
    const token = await customer();
    const product = await seedSized('Pear', [
      { name: '500g', pricePaise: 5000 },
      { name: '1kg', pricePaise: 9000 },
      { name: '2kg', pricePaise: 17000 },
    ]);
    await prisma.productVariant.update({ where: { id: product.variants['500g']!.id }, data: { status: ProductStatus.INACTIVE } });
    await prisma.productVariant.update({ where: { id: product.variants['1kg']!.id }, data: { deletedAt: new Date(), status: ProductStatus.INACTIVE } });
    await prisma.productVariant.update({ where: { id: product.variants['2kg']!.id }, data: { approvalStatus: ApprovalStatus.PENDING } });

    for (const size of ['500g', '1kg', '2kg']) {
      const res = await addToCart(token, { sellerListingId: product.variants[size]!.listingId, variantId: product.variants[size]!.id });
      expect(expectError(res.body).code, size).toBe(ErrorCode.PRODUCT_UNAVAILABLE);
    }
    expect((await cartOf(token)).items).toHaveLength(0);
  });

  it('an older app (no variant / price fields) still adds by listing, as before', async () => {
    const token = await customer();
    const product = await seedSized('Lemon', [{ name: '250g', pricePaise: 2000 }]);
    const res = await addToCart(token, { sellerListingId: product.variants['250g']!.listingId });
    expect(res.status).toBe(200);
    expect(expectSuccess<CartDto>(res.body).data.items[0]?.variantId).toBe(product.variants['250g']!.id);
  });
});
