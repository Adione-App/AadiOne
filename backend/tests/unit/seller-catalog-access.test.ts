/**
 * Seller catalogue ownership rules — every seller (Aadione included) owns its
 * own top categories and subcategories. The pure decisions behind
 * POST/PATCH /seller/products, /seller/categories, /seller/subcategories and
 * /seller/listings, and the stock +/- floor. DB-free.
 */

import { describe, expect, it } from 'vitest';
import { SellerType } from '../../src/shared';
import { decideCategoryAccess, type AccessCategory } from '../../src/modules/catalog/seller-category.service';
import { nextStockAfterAdjust } from '../../src/modules/inventory/inventory.service';

const SELLER_A = { id: 'seller-a', sellerType: SellerType.GROCERY };
const SELLER_B = { id: 'seller-b', sellerType: SellerType.FASHION };
const RESTAURANT = { id: 'rest-1', sellerType: SellerType.RESTAURANT };

const groceryA: AccessCategory = { id: 'grocery-a', sellerId: 'seller-a', parentId: null, isActive: true };
const riceA: AccessCategory = { id: 'rice-a', sellerId: 'seller-a', parentId: 'grocery-a', isActive: true };
const groceryB: AccessCategory = { id: 'grocery-b', sellerId: 'seller-b', parentId: null, isActive: true };
const riceB: AccessCategory = { id: 'rice-b', sellerId: 'seller-b', parentId: 'grocery-b', isActive: true };
const legacyShared: AccessCategory = { id: 'shared', sellerId: null, parentId: null, isActive: true };
const menuSection: AccessCategory = { id: 'dosa', sellerId: 'rest-1', parentId: null, isActive: true };

function product(
  category: AccessCategory | null,
  root: AccessCategory | null,
  extra: Partial<Parameters<typeof decideCategoryAccess>[0]> = {},
) {
  return decideCategoryAccess({ seller: SELLER_A, category, root, purpose: 'product', ...extra });
}

describe('decideCategoryAccess — products', () => {
  it('allows the seller’s own top category and own subcategory', () => {
    expect(product(groceryA, groceryA)).toEqual({ ok: true });
    expect(product(riceA, groceryA)).toEqual({ ok: true });
  });

  it('reports another seller’s category exactly like a missing one', () => {
    expect(product(groceryB, groceryB)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(product(riceB, groceryB)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(product(null, null)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rejects an owner-less (legacy shared) category — there is no admin taxonomy', () => {
    expect(product(legacyShared, legacyShared)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rejects an own subcategory whose top category is not the seller’s', () => {
    expect(product(riceA, groceryB)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rejects a switched-off category (or top category) for new products, but not for listing an existing one', () => {
    const off = { ...riceA, isActive: false };
    expect(product(off, groceryA)).toEqual({ ok: false, reason: 'INACTIVE' });
    expect(product(riceA, { ...groceryA, isActive: false })).toEqual({ ok: false, reason: 'INACTIVE' });
    expect(product(off, groceryA, { requireActive: false })).toEqual({ ok: true });
  });

  it('applies the same rule to every seller — seller B uses only its own tree', () => {
    expect(decideCategoryAccess({ seller: SELLER_B, category: riceB, root: groceryB, purpose: 'product' })).toEqual({ ok: true });
    expect(decideCategoryAccess({ seller: SELLER_B, category: riceA, root: groceryA, purpose: 'product' })).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });
});

describe('decideCategoryAccess — subcategory parents', () => {
  const parent = (category: AccessCategory) =>
    decideCategoryAccess({ seller: SELLER_A, category, root: category, purpose: 'subcategory-parent' });

  it('allows creating under the seller’s own top category', () => {
    expect(parent(groceryA)).toEqual({ ok: true });
  });

  it('allows one level only — never under a subcategory', () => {
    expect(parent(riceA)).toEqual({ ok: false, reason: 'NOT_A_TOP_CATEGORY' });
  });

  it('hides another seller’s category and the legacy shared taxonomy', () => {
    expect(parent(groceryB)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(parent(legacyShared)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rejects a switched-off top category', () => {
    expect(parent({ ...groceryA, isActive: false })).toEqual({ ok: false, reason: 'INACTIVE' });
  });
});

describe('decideCategoryAccess — restaurants / cafes: Menu → Menu Section → Food Item', () => {
  // A food seller's own tree is its menu: top category = menu, subcategory = menu section.
  const mainMenu: AccessCategory = { ...menuSection, id: 'menu-main' };
  const roti: AccessCategory = { ...menuSection, id: 'section-roti', parentId: mainMenu.id };
  const restaurant = (category: AccessCategory, root: AccessCategory, purpose: 'product' | 'subcategory-parent' = 'product') =>
    decideCategoryAccess({ seller: RESTAURANT, category, root, purpose });

  it('puts food items in its own menu sections', () => {
    expect(restaurant(roti, mainMenu)).toEqual({ ok: true });
  });

  it('never directly on a menu', () => {
    expect(restaurant(mainMenu, mainMenu)).toEqual({ ok: false, reason: 'NOT_A_MENU_SECTION' });
  });

  it('creates menu sections under its own menus only', () => {
    expect(restaurant(mainMenu, mainMenu, 'subcategory-parent')).toEqual({ ok: true });
    expect(restaurant(roti, mainMenu, 'subcategory-parent')).toEqual({ ok: false, reason: 'NOT_A_TOP_CATEGORY' });
  });

  it('rejects other sellers’ categories', () => {
    expect(restaurant(groceryA, groceryA)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('nextStockAfterAdjust', () => {
  it('adds and removes stock', () => {
    expect(nextStockAfterAdjust({ stockQty: 10, reservedQty: 2 }, 5)).toEqual({ ok: true, stockQty: 15 });
    expect(nextStockAfterAdjust({ stockQty: 10, reservedQty: 2 }, -8)).toEqual({ ok: true, stockQty: 2 });
  });

  it('never goes below the reserved quantity', () => {
    const result = nextStockAfterAdjust({ stockQty: 10, reservedQty: 3 }, -8);
    expect(result.ok).toBe(false);
  });

  it('never goes below zero', () => {
    expect(nextStockAfterAdjust({ stockQty: 1, reservedQty: 0 }, -2)).toEqual({ ok: false, message: 'Stock cannot go below zero.' });
  });
});
