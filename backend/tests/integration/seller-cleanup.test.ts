/**
 * Seller cleanup (src/modules/maintenance/seller-cleanup.ts) against a real
 * database: exact allowlist, dry-run counts and token, DELETE / RETIRE /
 * BLOCKED / NOT_FOUND, shared categories and every non-target seller kept,
 * payment history never deleted, the separately-gated order step, staff
 * accounts turned customers, idempotency — and the remaining sellers' catalogue
 * still visible to customers afterwards.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, CodPolicy, PaymentMethod, ProductStatus, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { STORE_COORDS, seedAddress, sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import {
  executeSellerCleanup,
  formatPlan,
  planSellerCleanup,
  resolveCodes,
  type SellerCleanupPlan,
} from '../../src/modules/maintenance/seller-cleanup';

const CUSTOMER = '9876500003';
let counter = 0;

/** A live seller with its own category and one product (food: made to order). */
async function seedSeller(code: string, name: string, sellerType: SellerType, masterCategoryId?: string) {
  const seller = await prisma.seller.create({
    data: {
      code,
      name,
      sellerType,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      addressLine: 'Main Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: 'Asia/Kolkata',
      isActive: true,
      allowCod: CodPolicy.ALLOW,
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  await prisma.sellerProfile.create({ data: { sellerId: seller.id, businessName: name, ownerFullName: 'Owner', ownerMobile: '9000000099', ownerEmail: `${code.toLowerCase()}@adione.test` } });
  if (masterCategoryId) await prisma.sellerCategory.create({ data: { sellerId: seller.id, categoryId: masterCategoryId } });
  const food = sellerType === SellerType.RESTAURANT || sellerType === SellerType.CAFE;
  counter += 1;
  const top = await prisma.category.create({ data: { sellerId: seller.id, name: `${name} Top`, slug: `top-${counter}`, path: `top-${counter}`, depth: 0 } });
  const sub = await prisma.category.create({
    data: { sellerId: seller.id, parentId: top.id, name: `${name} Sub`, slug: `sub-${counter}`, path: `top-${counter}/sub-${counter}`, depth: 1 },
  });
  const product = await prisma.product.create({
    data: { name: `${name} Item`, slug: `item-${counter}`, categoryId: sub.id, status: ProductStatus.ACTIVE, approvalStatus: 'APPROVED', submittedBySellerId: seller.id, searchKeywords: [] },
  });
  await prisma.productImage.create({ data: { productId: product.id, url: `https://img.example/${counter}.webp`, displayOrder: 0 } });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, sku: `SKU-${code}-${counter}`, variantName: 'Regular', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  const listing = await prisma.sellerListing.create({
    data: { sellerId: seller.id, variantId: variant.id, mrpPaise: 10000, pricePaise: 10000, stockQty: food ? 0 : 50, tracksStock: !food, maxQtyPerOrder: 10, isAvailable: true },
  });
  return { id: seller.id, productId: product.id, variantId: variant.id, listingId: listing.id, categoryIds: [top.id, sub.id] };
}

async function placeCodOrder(token: string, userId: string, listingIds: string[]): Promise<string> {
  for (const id of listingIds) {
    await api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId: id, qty: 1 }).expect(200);
  }
  const addressId = (await prisma.address.findFirst({ where: { userId } }))?.id ?? (await seedAddress(userId));
  const res = await api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(token))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD });
  expect(res.status).toBe(201);
  return expectSuccess<{ order: { id: string } }>(res.body).data.order.id;
}

const entry = (plan: SellerCleanupPlan, code: string) => plan.entries.find((e) => e.code === code)!;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await otpService.clearOtpState(CUSTOMER);
  invalidateCategoryCache();
});

describe('seller cleanup', () => {
  it('only the exact allowlisted codes can ever be targeted', () => {
    expect(resolveCodes(null)).toHaveLength(8);
    expect(resolveCodes(['GIFTSTORE'])).toEqual(['GIFTSTORE']);
    expect(() => resolveCodes(['KEEPGROCER'])).toThrow(/not on the cleanup allowlist/);
    expect(() => resolveCodes(['giftstore'])).toThrow(/case-sensitive/);
  });

  it('dry run → execute: deletes, retires and blocks exactly as planned; every other seller, shared data and money untouched', async () => {
    // Shared master category used by a kept seller AND a target.
    const master = await prisma.category.create({ data: { name: 'Gifts', slug: 'gifts', path: 'gifts', depth: 0 } });

    // Kept sellers (not on the list).
    const keepGrocer = await seedSeller('KEEPGROCER', 'Keep Grocer', SellerType.GROCERY, master.id);
    const keepKitchen = await seedSeller('KEEPKITCHEN', 'Keep Kitchen', SellerType.RESTAURANT);
    await prisma.restaurantProfile.create({ data: { sellerId: keepKitchen.id, cuisine: ['Indian'], isVegOnly: true } });

    // Targets.
    const gift = await seedSeller('GIFTSTORE', 'Gift Shop', SellerType.HOME, master.id); // name differs from the list
    const owner = await prisma.user.create({ data: { mobile: '9000000123', fullName: 'Gift Owner', role: UserRole.SELLER_OWNER } });
    await prisma.sellerStaff.create({ data: { sellerId: gift.id, userId: owner.id, role: 'OWNER' } });
    await prisma.refreshToken.create({
      data: { userId: owner.id, tokenHash: randomUUID(), familyId: randomUUID(), scope: 'FULL', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const food = await seedSeller('HAHOKAMFOOD', 'Ha Hokam Food', SellerType.RESTAURANT);
    await prisma.restaurantProfile.create({ data: { sellerId: food.id, cuisine: ['Indian'], isVegOnly: false } });
    const sabji = await seedSeller('SABJIVALA', 'Sabji Vala', SellerType.GROCERY);
    const shoes = await seedSeller('SHOESSHOP', 'Shoes Shop', SellerType.FASHION);
    // Another seller's listing on a target's product -> BLOCKED.
    await prisma.sellerListing.create({ data: { sellerId: keepGrocer.id, variantId: shoes.variantId, mrpPaise: 9000, pricePaise: 9000, stockQty: 3, isAvailable: true } });

    // Orders: a COD food order (deletable), a food order with a captured payment (kept),
    // and a mixed order with a kept seller (kept).
    const session = await loginAs(CUSTOMER);
    const deletableOrder = await placeCodOrder(session.accessToken, session.userId, [food.listingId]);
    const paidOrder = await placeCodOrder(session.accessToken, session.userId, [food.listingId]);
    await prisma.payment.create({ data: { orderId: paidOrder, provider: 'cashfree', providerOrderId: 'cf_order_1', providerPaymentId: 'cf_pay_1', amountPaise: 10000, currency: 'INR', status: 'CAPTURED' } });
    const mixedOrder = await placeCodOrder(session.accessToken, session.userId, [sabji.listingId, keepGrocer.listingId]);
    // A customer's cart line on the gift store's product.
    await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: gift.listingId, qty: 1 }).expect(200);

    const keptBefore = {
      products: await prisma.product.count({ where: { submittedBySellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      listings: await prisma.sellerListing.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      categories: await prisma.category.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
    };

    /* ---- dry run ---- */
    const plan = await planSellerCleanup();
    expect(entry(plan, 'GIFTSTORE')).toMatchObject({ action: 'DELETE', found: true });
    expect(entry(plan, 'GIFTSTORE').discrepancies.join()).toMatch(/name is "Gift Shop"/);
    expect(entry(plan, 'GIFTSTORE').counts).toMatchObject({
      products: 1, productVariants: 1, productImages: 1, sellerListings: 1, cartItems: 1, ownCategories: 2,
      masterCategoryAssignments: 1, sellerHours: 7, sellerProfiles: 1, sellerStaff: 1,
    });
    expect(entry(plan, 'GIFTSTORE').staffAccounts).toMatchObject({ total: 1, toCustomer: 1 });
    expect(entry(plan, 'HAHOKAMFOOD')).toMatchObject({ action: 'RETIRE' });
    expect(entry(plan, 'HAHOKAMFOOD').orders).toMatchObject({ sellerOrders: 2, parentOrders: 2, parentOrdersMixed: 0, ordersWithPaymentRows: 1, capturedPayments: 1, deletableOrders: 1 });
    expect(entry(plan, 'SABJIVALA')).toMatchObject({ action: 'RETIRE' });
    expect(entry(plan, 'SABJIVALA').orders).toMatchObject({ parentOrdersMixed: 1, deletableOrders: 0 });
    expect(entry(plan, 'SHOESSHOP')).toMatchObject({ action: 'BLOCKED' });
    expect(entry(plan, 'SHOESSHOP').blockers.join()).toMatch(/listing\(s\) of another seller/);
    for (const code of ['AADIONECAFE', 'RAMDEVCLOTHING', 'FASHIONSTORE', 'HOMEANDKICHEN']) expect(entry(plan, code).action).toBe('NOT_FOUND');
    expect(plan.global).toMatchObject({ orders: 3, ordersOfNonTargetSellers: 1, nonTargetSellers: 2 });
    expect(plan.deletableOrderIds).toEqual([deletableOrder]);
    expect(plan.token).toMatch(/^SC-[0-9A-F]{12}$/);
    expect(plan.ordersToken).toMatch(/^SO-/);
    expect(formatPlan(plan)).toMatch(/CONFIRMATION TOKEN: SC-/);
    // The dry run changed nothing.
    expect(await prisma.seller.count()).toBe(6);

    /* ---- refusals ---- */
    const run = (token: string, ordersToken: string | null = null) =>
      executeSellerCleanup(null, { confirmToken: token, ordersConfirmToken: ordersToken, actor: 'test operator', backupNote: 'test backup' });
    await expect(run('SC-000000000000')).rejects.toThrow(/does not match/);
    await expect(executeSellerCleanup(null, { confirmToken: plan.token, actor: '', backupNote: 'x' })).rejects.toThrow(/actor/);
    expect(await prisma.seller.count()).toBe(6);
    // Data changed after the dry run -> its token no longer matches.
    await prisma.sellerHours.deleteMany({ where: { sellerId: gift.id, dayOfWeek: 0 } });
    await expect(run(plan.token)).rejects.toThrow(/does not match/);

    /* ---- execute (catalogue + sellers; orders NOT included) ---- */
    const fresh = await planSellerCleanup();
    const result = await run(fresh.token);
    expect(result.verification).toEqual({ ok: true, problems: [] });
    expect(result.results.find((r) => r.code === 'GIFTSTORE')).toMatchObject({ action: 'DELETE', done: true });
    expect(result.results.find((r) => r.code === 'HAHOKAMFOOD')).toMatchObject({ action: 'RETIRE', done: true });
    expect(result.results.find((r) => r.code === 'SHOESSHOP')).toMatchObject({ action: 'BLOCKED', done: false });

    // GIFTSTORE gone with its own data; the SHARED master category stays.
    expect(await prisma.seller.findUnique({ where: { code: 'GIFTSTORE' } })).toBeNull();
    expect(await prisma.product.count({ where: { id: gift.productId } })).toBe(0);
    expect(await prisma.category.count({ where: { id: { in: gift.categoryIds } } })).toBe(0);
    expect(await prisma.category.count({ where: { id: master.id } })).toBe(1);
    expect(await prisma.sellerCategory.count({ where: { categoryId: master.id } })).toBe(1); // the kept grocer's assignment
    expect(await prisma.cartItem.count({ where: { sellerListingId: gift.listingId } })).toBe(0);
    // Its owner account is kept, as a plain customer, with seller-panel sessions revoked.
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ role: UserRole.CUSTOMER });
    expect(await prisma.refreshToken.count({ where: { userId: owner.id, revokedAt: null } })).toBe(0);

    // Retired: invisible, catalogue gone, every order and payment kept.
    const retired = await prisma.seller.findUniqueOrThrow({ where: { code: 'HAHOKAMFOOD' } });
    expect(retired).toMatchObject({ isActive: false });
    expect(retired.deletedAt).not.toBeNull();
    expect(await prisma.product.count({ where: { id: food.productId } })).toBe(0);
    expect(await prisma.sellerOrder.count({ where: { sellerId: food.id } })).toBe(2);
    expect(await prisma.payment.count({ where: { orderId: paidOrder } })).toBe(1);
    expect(await prisma.order.count({ where: { id: { in: [deletableOrder, paidOrder, mixedOrder] } } })).toBe(3);
    // Order lines keep their snapshot (name, price) even though the product is gone.
    expect(await prisma.orderItem.count({ where: { sellerOrder: { orderId: paidOrder } } })).toBe(1);

    // Blocked: untouched.
    expect(await prisma.product.count({ where: { id: shoes.productId } })).toBe(1);

    // Every kept seller exactly as before, and still visible to customers.
    expect({
      products: await prisma.product.count({ where: { submittedBySellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      listings: await prisma.sellerListing.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      categories: await prisma.category.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
    }).toEqual(keptBefore);
    invalidateCategoryCache();
    const store = expectSuccess<{ id: string; productCount: number }>((await api().get(`/api/v1/stores/${keepGrocer.id}`).expect(200)).body).data;
    expect(store.productCount).toBeGreaterThanOrEqual(1);
    const restaurants = expectSuccess<{ sellerId: string; menuItemCount: number }[]>((await api().get('/api/v1/restaurants').expect(200)).body).data;
    expect(restaurants.map((r) => r.sellerId)).toEqual([keepKitchen.id]);
    expect(restaurants[0]!.menuItemCount).toBe(1);
    expect((await api().get(`/api/v1/stores/${gift.id}`)).status).toBe(404);

    // Audited: who, when, what.
    const audit = await prisma.auditLog.findMany({ where: { action: { startsWith: 'seller.cleanup_' } } });
    expect(audit.map((a) => a.action).sort()).toEqual(['seller.cleanup_delete', 'seller.cleanup_retire', 'seller.cleanup_retire']);
    expect(audit.every((a) => (a.after as { initiatedBy?: string }).initiatedBy === 'test operator')).toBe(true);

    /* ---- the separately-gated order step ---- */
    const second = await planSellerCleanup();
    expect(second.deletableOrderIds).toEqual([deletableOrder]);
    await expect(run(second.token, 'SO-000000000000')).rejects.toThrow(/orders confirmation token/);
    const withOrders = await run(second.token, second.ordersToken);
    expect(withOrders.deletedOrders).toBe(1);
    expect(withOrders.verification.ok).toBe(true);
    expect(await prisma.order.count({ where: { id: deletableOrder } })).toBe(0);
    // The paid order and the mixed order are kept; no payment was ever deleted.
    expect(await prisma.order.count({ where: { id: { in: [paidOrder, mixedOrder] } } })).toBe(2);
    expect(await prisma.payment.count()).toBe(1);

    /* ---- idempotent ---- */
    const third = await planSellerCleanup();
    expect(entry(third, 'GIFTSTORE').action).toBe('NOT_FOUND');
    const again = await run(third.token);
    expect(again.verification.ok).toBe(true);
    expect(await prisma.seller.count()).toBe(5);
  });
});
