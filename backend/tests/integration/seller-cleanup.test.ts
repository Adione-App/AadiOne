/**
 * Permanent removal of the 8 dummy sellers (src/modules/maintenance/
 * seller-cleanup.ts) against a real database and real (local) storage:
 *
 *   - exact allowlist; dry run changes nothing; token refusals;
 *   - all 8 targets: PERMANENTLY_DELETED (incl. a name discrepancy),
 *     ARCHIVED_FOR_HISTORY (captured payment + refund, settlement, an order
 *     shared with a kept seller), BLOCKED (another seller's listing),
 *     NOT_FOUND;
 *   - staff accounts: erased (seller-only), turned customer (also a shopper),
 *     membership only (also staff of a kept seller);
 *   - audit retention (catalogue entries deleted; compliance, financial,
 *     unclassified and other sellers' entries kept);
 *   - files: exclusively-owned images + private documents backed up then
 *     removed; an image shared with a kept seller or used by a kept order line
 *     stays;
 *   - shared master category, every kept seller's catalogue, payments,
 *     refunds, settlements unchanged; banners pointing at a removed seller
 *     unpublished; the customer app no longer shows any removed seller;
 *   - a second run is a no-op.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, CodPolicy, PaymentMethod, ProductStatus, SellerType, UnitType, UserRole, UserStatus } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { STORE_COORDS, seedAddress, sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import { buildImageKey, storage } from '../../src/infra/storage';
import { buildDocumentKey, privateDocuments } from '../../src/infra/storage/private-documents';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { invalidateCategoryCache } from '../../src/modules/catalog/catalog.service';
import {
  classifyAuditLog,
  databaseTarget,
  deletePlannedFiles,
  executeSellerCleanup,
  formatPlan,
  planSellerCleanup,
  resolveCodes,
  type FileResult,
  type SellerCleanupPlan,
} from '../../src/modules/maintenance/seller-cleanup';

const CUSTOMER = '9876500003';
const IMAGE_FOLDER = `test-cleanup-${randomUUID().slice(0, 8)}`;
const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'adione-cleanup-files-'));
const createdDocumentKeys: string[] = [];
let counter = 0;

afterAll(async () => {
  rmSync(backupRoot, { recursive: true, force: true });
  rmSync(path.resolve(process.cwd(), 'storage', IMAGE_FOLDER), { recursive: true, force: true });
  for (const key of createdDocumentKeys) await privateDocuments.remove(key).catch(() => undefined);
});

async function storeImage(): Promise<{ key: string; url: string }> {
  const key = buildImageKey(IMAGE_FOLDER, 'photo.webp');
  const stored = await storage.put(key, Buffer.from(`image-${randomUUID()}`), 'image/webp');
  return { key, url: stored.url };
}

/** A live seller with its own category tree and one product with a stored image (food: made to order). */
async function seedSeller(code: string, name: string, sellerType: SellerType, masterCategoryId?: string) {
  const seller = await prisma.seller.create({
    data: {
      code, name, sellerType, ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      addressLine: 'Main Road', city: 'Sikar', state: 'Rajasthan', pincode: '332001', ...STORE_COORDS,
      timezone: 'Asia/Kolkata', isActive: true, allowCod: CodPolicy.ALLOW, phone: '9000000098',
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  await prisma.sellerProfile.create({ data: { sellerId: seller.id, businessName: name, ownerFullName: 'Owner', ownerMobile: '9000000099', ownerEmail: `${code.toLowerCase()}@adione.test` } });
  if (masterCategoryId) await prisma.sellerCategory.create({ data: { sellerId: seller.id, categoryId: masterCategoryId } });
  const food = sellerType === SellerType.RESTAURANT || sellerType === SellerType.CAFE;
  if (food) await prisma.restaurantProfile.create({ data: { sellerId: seller.id, cuisine: ['Indian'], isVegOnly: false } });
  counter += 1;
  const top = await prisma.category.create({ data: { sellerId: seller.id, name: `${name} Top`, slug: `top-${counter}`, path: `top-${counter}`, depth: 0 } });
  const sub = await prisma.category.create({
    data: { sellerId: seller.id, parentId: top.id, name: `${name} Sub`, slug: `sub-${counter}`, path: `top-${counter}/sub-${counter}`, depth: 1 },
  });
  const product = await prisma.product.create({
    data: { name: `${name} Item`, slug: `item-${counter}`, categoryId: sub.id, status: ProductStatus.ACTIVE, approvalStatus: 'APPROVED', submittedBySellerId: seller.id, searchKeywords: [] },
  });
  const image = await storeImage();
  await prisma.productImage.create({ data: { productId: product.id, url: image.url, displayOrder: 0 } });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, sku: `SKU-${code}-${counter}`, variantName: 'Regular', unit: UnitType.PIECE, unitValue: 1, isDefault: true, status: ProductStatus.ACTIVE },
  });
  const listing = await prisma.sellerListing.create({
    data: { sellerId: seller.id, variantId: variant.id, mrpPaise: 10000, pricePaise: 10000, stockQty: food ? 0 : 50, tracksStock: !food, maxQtyPerOrder: 10, isAvailable: true },
  });
  return { id: seller.id, productId: product.id, variantId: variant.id, listingId: listing.id, categoryIds: [top.id, sub.id], image };
}

async function staffUser(mobile: string, sellerId: string) {
  const user = await prisma.user.create({ data: { mobile, fullName: 'Staff Person', email: `${mobile}@adione.test`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId, userId: user.id, role: 'OWNER' } });
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: randomUUID(), familyId: randomUUID(), scope: 'FULL', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return user;
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

async function imageExists(key: string): Promise<boolean> {
  return (await storage.get(key, 10 * 1024 * 1024)) !== null;
}

async function documentExists(key: string): Promise<boolean> {
  try {
    await privateDocuments.get(key);
    return true;
  } catch {
    return false;
  }
}

const entry = (plan: SellerCleanupPlan, code: string) => plan.entries.find((e) => e.code === code)!;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  await otpService.clearOtpState(CUSTOMER);
  invalidateCategoryCache();
});

describe('seller cleanup — rules', () => {
  it('only the exact allowlisted codes can ever be targeted', () => {
    expect(resolveCodes(null)).toHaveLength(8);
    expect(resolveCodes(['GIFTSTORE'])).toEqual(['GIFTSTORE']);
    expect(() => resolveCodes(['KEEPGROCER'])).toThrow(/not on the cleanup allowlist/);
    expect(() => resolveCodes(['giftstore'])).toThrow(/case-sensitive/);
  });

  it('names the target database — host, shared-pooler project, database — never the password', () => {
    const saved = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgresql://postgres.abcdefghijklmnop:s3cret-pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';
    try {
      const target = databaseTarget();
      expect(target).toEqual({ host: 'aws-0-ap-south-1.pooler.supabase.com', port: '5432', database: 'postgres', project: 'abcdefghijklmnop' });
      expect(JSON.stringify(target)).not.toContain('s3cret');
    } finally {
      process.env['DATABASE_URL'] = saved;
    }
  });

  it('audit retention classes: only catalogue / storefront / order-operations entries are disposable', () => {
    expect(classifyAuditLog('product.seller_create', 'Product')).toBe('disposable');
    expect(classifyAuditLog('seller.update_hours', 'Seller')).toBe('disposable');
    expect(classifyAuditLog('order.status_changed', 'Order')).toBe('disposable');
    expect(classifyAuditLog('payment.confirm_manual', 'Order')).toBe('financial');
    expect(classifyAuditLog('settlement.status', 'SellerSettlement')).toBe('financial');
    expect(classifyAuditLog('seller.update', 'SellerBankDetail')).toBe('financial');
    expect(classifyAuditLog('auth.password_changed', 'User')).toBe('security');
    expect(classifyAuditLog('seller_login.credentials_issued', 'User')).toBe('security');
    expect(classifyAuditLog('seller_application.approve', 'Seller')).toBe('compliance');
    expect(classifyAuditLog('seller_document.verify', 'SellerDocument')).toBe('compliance');
    expect(classifyAuditLog('seller.create', 'Seller')).toBe('compliance');
    expect(classifyAuditLog('seller.cleanup_archive', 'Seller')).toBe('cleanup');
    expect(classifyAuditLog('seller.something_new', 'Seller')).toBe('unclassified');
  });
});

describe('seller cleanup — all eight dummy sellers', () => {
  it('dry run → execute: each seller gets its exact outcome; everything else, money and shared data untouched; no stale app content', async () => {
    // Shared master category (kept seller + a target).
    const master = await prisma.category.create({ data: { name: 'Gifts', slug: 'gifts', path: 'gifts', depth: 0 } });

    // Kept sellers.
    const keepGrocer = await seedSeller('KEEPGROCER', 'Keep Grocer', SellerType.GROCERY, master.id);
    const keepKitchen = await seedSeller('KEEPKITCHEN', 'Keep Kitchen', SellerType.RESTAURANT);

    // Seven targets (AADIONECAFE … SABJIVALA); all eight codes are planned.
    const cafe = await seedSeller('AADIONECAFE', 'Aadione Cafe', SellerType.CAFE);
    const hokam = await seedSeller('HAHOKAMFOOD', 'Ha Hokam Food', SellerType.RESTAURANT);
    const ramdev = await seedSeller('RAMDEVCLOTHING', 'Ram Dev Clothing', SellerType.FASHION);
    const fashion = await seedSeller('FASHIONSTORE', 'Fashion Store', SellerType.FASHION);
    const home = await seedSeller('HOMEANDKICHEN', 'home and kichen', SellerType.HOME_KITCHEN);
    const gift = await seedSeller('GIFTSTORE', 'Gift Store', SellerType.HOME, master.id);
    const sabji = await seedSeller('SABJIVALA', 'Sabji Vala', SellerType.GROCERY);
    // SHOESSHOP is BLOCKED: a kept seller lists on its product.
    const shoes = await seedSeller('SHOESSHOP', 'Shoes Shop', SellerType.FASHION);
    await prisma.sellerListing.create({ data: { sellerId: keepGrocer.id, variantId: shoes.variantId, mrpPaise: 9000, pricePaise: 9000, stockQty: 3, isAvailable: true } });

    // Staff accounts.
    const cafeOwner = await staffUser('9000000201', cafe.id); // seller-only -> erased
    const fashionOwner = await staffUser('9000000202', fashion.id); // also shops -> customer
    await seedAddress(fashionOwner.id);
    const giftOwner = await staffUser('9000000203', gift.id); // also staff of a kept seller -> membership only
    await prisma.sellerStaff.create({ data: { sellerId: keepGrocer.id, userId: giftOwner.id, role: 'MANAGER' } });

    // Documents (private PDFs) and bank details.
    const cafeDocKey = buildDocumentKey(cafe.id);
    createdDocumentKeys.push(cafeDocKey);
    await privateDocuments.put(cafeDocKey, Buffer.from('%PDF-1.4 test'), 'application/pdf');
    await prisma.sellerDocument.create({ data: { sellerId: cafe.id, type: 'PAN_CARD', fileKey: cafeDocKey } });
    await prisma.sellerBankDetail.create({ data: { sellerId: cafe.id, accountHolderName: 'Cafe', accountNumber: '000111222333', ifscCode: 'SBIN0000001' } });
    await prisma.sellerBankDetail.create({ data: { sellerId: ramdev.id, accountHolderName: 'Ramdev', accountNumber: '000111222444', ifscCode: 'SBIN0000001' } });

    // An image shared with a kept seller's product -> never removed.
    await prisma.productImage.create({ data: { productId: keepGrocer.productId, url: home.image.url, displayOrder: 1 } });

    // Orders.
    const session = await loginAs(CUSTOMER);
    const cafeOrder = await placeCodOrder(session.accessToken, session.userId, [cafe.listingId]); // disposable
    const hokamCodOrder = await placeCodOrder(session.accessToken, session.userId, [hokam.listingId]); // disposable
    const hokamPaidOrder = await placeCodOrder(session.accessToken, session.userId, [hokam.listingId]); // money moved -> kept
    const payment = await prisma.payment.create({
      data: { orderId: hokamPaidOrder, provider: 'cashfree', providerOrderId: 'cf_order_1', providerPaymentId: 'cf_pay_1', amountPaise: 10000, currency: 'INR', status: 'CAPTURED' },
    });
    await prisma.refund.create({ data: { paymentId: payment.id, orderId: hokamPaidOrder, amountPaise: 2000 } });
    const mixedOrder = await placeCodOrder(session.accessToken, session.userId, [sabji.listingId, keepGrocer.listingId]); // shared -> kept
    await prisma.sellerSettlement.create({
      data: { sellerId: ramdev.id, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), grossSalesPaise: 10000, commissionPaise: 1000, netPayablePaise: 9000 },
    });
    // The settlement's RESTRICT foreign key is what keeps that seller row.
    await expect(prisma.seller.delete({ where: { id: ramdev.id } })).rejects.toThrow();
    // A cart line on a removed product.
    await api().post('/api/v1/cart/items').set('Authorization', bearer(session.accessToken)).send({ sellerListingId: gift.listingId, qty: 1 }).expect(200);
    // The kept paid order's line shows the restaurant's product image -> that file stays.
    expect(await prisma.orderItem.count({ where: { sellerOrder: { orderId: hokamPaidOrder }, imageUrl: hokam.image.url } })).toBe(1);

    // Audit history.
    const audit = (action: string, entityType: string, entityId: string) => prisma.auditLog.create({ data: { action, entityType, entityId } });
    const disposable = await audit('product.seller_create', 'Product', cafe.productId);
    const hours = await audit('seller.update_hours', 'Seller', cafe.id);
    const compliance = await audit('seller_application.approve', 'Seller', cafe.id);
    const unknown = await audit('seller.something_new', 'Seller', cafe.id);
    const financial = await audit('payment.confirm_manual', 'Order', hokamPaidOrder);
    const keptSellers = await audit('product.seller_create', 'Product', keepGrocer.productId);

    // Banners.
    const deadBanner = await prisma.banner.create({ data: { placement: 'home_top', imageUrl: 'https://cdn.example/b1.webp', imageWidth: 1200, imageHeight: 400, actionType: 'RESTAURANT', actionValue: cafe.id } });
    const liveBanner = await prisma.banner.create({ data: { placement: 'home_top', imageUrl: 'https://cdn.example/b2.webp', imageWidth: 1200, imageHeight: 400, actionType: 'RESTAURANT', actionValue: keepKitchen.id } });

    const keptBefore = {
      products: await prisma.product.count({ where: { submittedBySellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      listings: await prisma.sellerListing.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      categories: await prisma.category.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      staff: await prisma.sellerStaff.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
    };

    /* ---------------- dry run ---------------- */
    const plan = await planSellerCleanup();
    expect(plan.target.database).toBe('adione_test');
    expect(plan.target.serverDatabase).toBe('adione_test');
    const outcomes = Object.fromEntries(plan.entries.map((e) => [e.code, e.outcome]));
    expect(outcomes).toEqual({
      AADIONECAFE: 'PERMANENTLY_DELETED',
      HAHOKAMFOOD: 'ARCHIVED_FOR_HISTORY',
      RAMDEVCLOTHING: 'ARCHIVED_FOR_HISTORY',
      FASHIONSTORE: 'PERMANENTLY_DELETED',
      HOMEANDKICHEN: 'PERMANENTLY_DELETED',
      GIFTSTORE: 'PERMANENTLY_DELETED',
      SHOESSHOP: 'BLOCKED',
      SABJIVALA: 'ARCHIVED_FOR_HISTORY',
    });
    expect(entry(plan, 'HOMEANDKICHEN').discrepancies.join()).toMatch(/stored name is "home and kichen", supplied "Home and Kitchen"/);
    expect(entry(plan, 'SHOESSHOP').blockers.join()).toMatch(/listing\(s\) of another seller/);
    expect(entry(plan, 'HAHOKAMFOOD').historyReferences.join()).toMatch(/seller_orders\.seller_id → sellers\.id \(ON DELETE RESTRICT\): 1 seller order\(s\) in 1 kept order/);
    expect(entry(plan, 'HAHOKAMFOOD').retainedOrders[0]!.reasons).toEqual(
      expect.arrayContaining(['1 captured payment(s)', '1 refund(s)', 'payment audit history']),
    );
    expect(entry(plan, 'HAHOKAMFOOD').orders).toMatchObject({ parentOrders: 2, deletableOrders: 1, retainedOrders: 1 });
    expect(entry(plan, 'RAMDEVCLOTHING').historyReferences.join()).toMatch(/seller_settlements\.seller_id .* 1 settlement/);
    expect(entry(plan, 'RAMDEVCLOTHING').counts['sellerBankDetails']).toBe(0); // kept with its settlement
    expect(entry(plan, 'SABJIVALA').retainedOrders[0]!.reasons.join()).toMatch(/shared with seller\(s\) not removed: KEEPGROCER/);
    expect(entry(plan, 'AADIONECAFE').counts).toMatchObject({ orders: 1, sellerDocuments: 1, sellerBankDetails: 1, sellerRow: 1, products: 1, ownCategories: 2 });
    expect(entry(plan, 'AADIONECAFE').staff).toEqual([expect.objectContaining({ decision: 'ACCOUNT_ERASED', mobile: '90000****01' })]);
    expect(entry(plan, 'FASHIONSTORE').staff).toEqual([expect.objectContaining({ decision: 'TURNED_CUSTOMER' })]);
    expect(entry(plan, 'GIFTSTORE').staff).toEqual([expect.objectContaining({ decision: 'MEMBERSHIP_REMOVED' })]);
    expect(entry(plan, 'AADIONECAFE').auditLogs).toEqual({ delete: 2, keep: { compliance: 1, unclassified: 1 } });
    expect(entry(plan, 'AADIONECAFE').files).toEqual({ images: 1, documents: 1, keptShared: 0 });
    expect(entry(plan, 'HOMEANDKICHEN').files).toMatchObject({ images: 0, keptShared: 1 }); // shared with KEEPGROCER
    expect(entry(plan, 'HAHOKAMFOOD').files).toMatchObject({ images: 0, keptShared: 1 }); // used by a kept order line
    expect(entry(plan, 'AADIONECAFE').bannersToUnpublish).toBe(1);
    expect(plan.deletableOrders.map((o) => o.sellerCodes.join())).toEqual(expect.arrayContaining(['AADIONECAFE', 'HAHOKAMFOOD']));
    expect(plan.deletableOrders).toHaveLength(2);
    expect(plan.token).toMatch(/^SC-[0-9A-F]{12}$/);
    expect(formatPlan(plan)).toMatch(/CONFIRMATION TOKEN: SC-/);
    expect(await prisma.seller.count()).toBe(10); // the dry run changed nothing

    /* ---------------- refusals ---------------- */
    const run = (token: string, filesBackupDir: string | null = backupRoot) =>
      executeSellerCleanup(null, { confirmToken: token, actor: 'test operator', backupNote: 'test backup', filesBackupDir });
    await expect(run('SC-000000000000')).rejects.toThrow(/does not match/);
    await expect(run(plan.token, null)).rejects.toThrow(/--files-backup/);
    await expect(executeSellerCleanup(null, { confirmToken: plan.token, actor: '', backupNote: 'x' })).rejects.toThrow(/actor/);
    await prisma.sellerHours.deleteMany({ where: { sellerId: gift.id, dayOfWeek: 0 } });
    await expect(run(plan.token)).rejects.toThrow(/does not match/); // data changed after the dry run
    expect(await prisma.seller.count()).toBe(10);
    expect(await imageExists(cafe.image.key)).toBe(true);

    /* ---------------- execute ---------------- */
    const fresh = await planSellerCleanup();
    const result = await run(fresh.token);
    expect(result.verification).toEqual({ ok: true, problems: [] });
    expect(Object.fromEntries(result.results.map((r) => [r.code, r.outcome]))).toEqual(outcomes);
    expect(result).toMatchObject({ deletedOrders: 2, deletedAuditLogs: 2, unpublishedBanners: 1, staff: { ACCOUNT_ERASED: 1, TURNED_CUSTOMER: 1, MEMBERSHIP_REMOVED: 1 } });

    // PERMANENTLY_DELETED: no row anywhere.
    for (const code of ['AADIONECAFE', 'FASHIONSTORE', 'HOMEANDKICHEN', 'GIFTSTORE']) {
      expect(await prisma.seller.findUnique({ where: { code } })).toBeNull();
    }
    for (const id of [cafe.id, fashion.id, home.id, gift.id]) {
      expect(await prisma.product.count({ where: { submittedBySellerId: id } })).toBe(0);
      expect(await prisma.category.count({ where: { sellerId: id } })).toBe(0);
      expect(await prisma.sellerStaff.count({ where: { sellerId: id } })).toBe(0);
      expect(await prisma.sellerDocument.count({ where: { sellerId: id } })).toBe(0);
      expect(await prisma.sellerBankDetail.count({ where: { sellerId: id } })).toBe(0);
    }
    expect(await prisma.order.count({ where: { id: { in: [cafeOrder, hokamCodOrder] } } })).toBe(0);

    // ARCHIVED_FOR_HISTORY: row kept only for history, everything else gone.
    for (const [code, id] of [['HAHOKAMFOOD', hokam.id], ['RAMDEVCLOTHING', ramdev.id], ['SABJIVALA', sabji.id]] as const) {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { code } });
      expect(seller).toMatchObject({ isActive: false, isAcceptingOrders: false, phone: null });
      expect(seller.deletedAt).not.toBeNull();
      expect(await prisma.product.count({ where: { submittedBySellerId: id } })).toBe(0);
      expect(await prisma.sellerListing.count({ where: { sellerId: id } })).toBe(0);
      expect(await prisma.category.count({ where: { sellerId: id } })).toBe(0);
      expect(await prisma.sellerHours.count({ where: { sellerId: id } })).toBe(0);
      expect(await prisma.sellerProfile.count({ where: { sellerId: id } })).toBe(0);
      expect(await prisma.restaurantProfile.count({ where: { sellerId: id } })).toBe(0);
    }
    expect(await prisma.sellerBankDetail.count({ where: { sellerId: ramdev.id } })).toBe(1); // paid out to it
    expect(await prisma.order.count({ where: { id: { in: [hokamPaidOrder, mixedOrder] } } })).toBe(2);
    expect(await prisma.orderItem.count({ where: { sellerOrder: { orderId: hokamPaidOrder } } })).toBe(1); // name/price snapshot kept

    // BLOCKED: untouched.
    expect(await prisma.product.count({ where: { id: shoes.productId } })).toBe(1);
    expect(await prisma.seller.findUniqueOrThrow({ where: { code: 'SHOESSHOP' } })).toMatchObject({ isActive: true, deletedAt: null });

    // Money and shared data.
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.refund.count()).toBe(1);
    expect(await prisma.sellerSettlement.count()).toBe(1);
    expect(await prisma.category.count({ where: { id: master.id } })).toBe(1);
    expect(await prisma.sellerCategory.count({ where: { categoryId: master.id } })).toBe(1); // the kept grocer's
    expect({
      products: await prisma.product.count({ where: { submittedBySellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      listings: await prisma.sellerListing.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      categories: await prisma.category.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
      staff: await prisma.sellerStaff.count({ where: { sellerId: { in: [keepGrocer.id, keepKitchen.id] } } }),
    }).toEqual(keptBefore);
    expect(await prisma.cartItem.count({ where: { sellerListingId: gift.listingId } })).toBe(0);

    // Staff accounts.
    const erased = await prisma.user.findUniqueOrThrow({ where: { id: cafeOwner.id } });
    expect(erased).toMatchObject({ status: UserStatus.DELETED, role: UserRole.CUSTOMER, fullName: null, email: null });
    expect(erased.mobile).toMatch(/^del_/);
    expect(await prisma.refreshToken.count({ where: { userId: cafeOwner.id, revokedAt: null } })).toBe(0);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: fashionOwner.id } })).toMatchObject({ role: UserRole.CUSTOMER, status: UserStatus.ACTIVE, mobile: '9000000202' });
    expect(await prisma.refreshToken.count({ where: { userId: fashionOwner.id, scope: 'FULL', revokedAt: null } })).toBe(0);
    expect(await prisma.address.count({ where: { userId: fashionOwner.id } })).toBe(1);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: giftOwner.id } })).toMatchObject({ role: UserRole.SELLER_OWNER, status: UserStatus.ACTIVE });
    expect(await prisma.sellerStaff.count({ where: { userId: giftOwner.id, sellerId: keepGrocer.id, isActive: true } })).toBe(1);

    // Audit: disposable gone; compliance, financial, unclassified, other sellers' and cleanup records kept.
    expect(await prisma.auditLog.count({ where: { id: { in: [disposable.id, hours.id] } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { id: { in: [compliance.id, unknown.id, financial.id, keptSellers.id] } } })).toBe(4);
    const cleanupRows = await prisma.auditLog.findMany({ where: { action: { startsWith: 'seller.cleanup_' } } });
    expect(cleanupRows.map((a) => a.action).sort()).toEqual([
      'seller.cleanup_archive', 'seller.cleanup_archive', 'seller.cleanup_archive',
      'seller.cleanup_permanent_delete', 'seller.cleanup_permanent_delete', 'seller.cleanup_permanent_delete', 'seller.cleanup_permanent_delete',
      'seller.cleanup_run',
    ]);
    expect(cleanupRows.every((a) => (a.after as { initiatedBy?: string }).initiatedBy === 'test operator')).toBe(true);

    // Files: owned ones backed up then removed; shared / kept-order ones stay.
    expect(await imageExists(cafe.image.key)).toBe(false);
    expect(await documentExists(cafeDocKey)).toBe(false);
    const backupDir = path.dirname(result.manifestPath!);
    expect(existsSync(path.join(backupDir, 'images', ...cafe.image.key.split('/')))).toBe(true);
    expect(existsSync(path.join(backupDir, 'documents', ...cafeDocKey.split('/')))).toBe(true);
    expect(await imageExists(home.image.key)).toBe(true);
    expect(await imageExists(hokam.image.key)).toBe(true);
    expect(await imageExists(keepGrocer.image.key)).toBe(true);
    expect(await imageExists(shoes.image.key)).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.every((file) => file.status === 'deleted')).toBe(true);

    // Banners.
    expect((await prisma.banner.findUniqueOrThrow({ where: { id: deadBanner.id } })).isActive).toBe(false);
    expect((await prisma.banner.findUniqueOrThrow({ where: { id: liveBanner.id } })).isActive).toBe(true);

    // The customer app: no removed seller anywhere, kept sellers still there.
    invalidateCategoryCache();
    for (const id of [cafe.id, fashion.id, home.id, gift.id, hokam.id, ramdev.id, sabji.id]) {
      expect((await api().get(`/api/v1/stores/${id}`)).status).toBe(404);
    }
    const restaurants = expectSuccess<{ sellerId: string }[]>((await api().get('/api/v1/restaurants').expect(200)).body).data;
    expect(restaurants.map((r) => r.sellerId)).toEqual([keepKitchen.id]);
    const grocerStore = expectSuccess<{ productCount: number }>((await api().get(`/api/v1/stores/${keepGrocer.id}`).expect(200)).body).data;
    expect(grocerStore.productCount).toBeGreaterThanOrEqual(1);
    const removedNames = ['Aadione Cafe', 'Ha Hokam Food', 'Ram Dev Clothing', 'Fashion Store', 'home and kichen', 'Gift Store', 'Sabji Vala'];
    for (const url of ['/api/v1/categories', '/api/v1/stores', '/api/v1/products?pageSize=100', '/api/v1/products/search?q=Item']) {
      const res = await api().get(url);
      expect(res.status, url).toBe(200);
      const body = JSON.stringify(res.body);
      for (const name of removedNames) expect(body, `${url} still mentions ${name}`).not.toContain(name);
    }
    const bannersRes = JSON.stringify((await api().get('/api/v1/banners?placement=home_top').expect(200)).body);
    expect(bannersRes).toContain('b2.webp');
    expect(bannersRes).not.toContain('b1.webp');

    /* ---------------- second run: a no-op ---------------- */
    const again = await planSellerCleanup();
    for (const code of ['AADIONECAFE', 'FASHIONSTORE', 'HOMEANDKICHEN', 'GIFTSTORE']) expect(entry(again, code).outcome).toBe('NOT_FOUND');
    expect(entry(again, 'HAHOKAMFOOD').outcome).toBe('ARCHIVED_FOR_HISTORY');
    expect(again.files).toHaveLength(0);
    const second = await run(again.token);
    expect(second.verification.ok).toBe(true);
    expect(second).toMatchObject({ deletedOrders: 0, deletedAuditLogs: 0, unpublishedBanners: 0 });
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.seller.count()).toBe(6); // 2 kept + 3 archived + SHOESSHOP
  });
});

describe('seller cleanup — all or nothing', () => {
  it('a failure part-way through rolls back EVERY change, and no file is removed', async () => {
    const cafe = await seedSeller('AADIONECAFE', 'Aadione Cafe', SellerType.CAFE);
    const gift = await seedSeller('GIFTSTORE', 'Gift Store', SellerType.HOME);
    const owner = await staffUser('9000000301', cafe.id);
    const session = await loginAs(CUSTOMER);
    const order = await placeCodOrder(session.accessToken, session.userId, [cafe.listingId]);
    const note = await prisma.auditLog.create({ data: { action: 'product.seller_create', entityType: 'Product', entityId: cafe.productId } });
    const docKey = buildDocumentKey(cafe.id);
    createdDocumentKeys.push(docKey);
    await privateDocuments.put(docKey, Buffer.from('%PDF-1.4 rollback'), 'application/pdf');
    await prisma.sellerDocument.create({ data: { sellerId: cafe.id, type: 'PAN_CARD', fileKey: docKey } });
    const runDirsBefore = new Set(readdirSync(backupRoot));

    // Deleting GIFTSTORE's row fails inside the transaction — after the order,
    // the audit entry, the staff account and AADIONECAFE were already handled.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_block_gift_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.code = 'GIFTSTORE' THEN RAISE EXCEPTION 'simulated failure'; END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_block_gift_delete BEFORE DELETE ON sellers FOR EACH ROW EXECUTE FUNCTION test_block_gift_delete()`);
    try {
      const plan = await planSellerCleanup();
      await expect(
        executeSellerCleanup(null, { confirmToken: plan.token, actor: 'test operator', backupNote: 'test backup', filesBackupDir: backupRoot }),
      ).rejects.toThrow(/simulated failure/);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_block_gift_delete ON sellers');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_gift_delete()');
    }

    expect(await prisma.seller.count({ where: { code: { in: ['AADIONECAFE', 'GIFTSTORE'] } } })).toBe(2);
    expect(await prisma.product.count({ where: { id: { in: [cafe.productId, gift.productId] } } })).toBe(2);
    expect(await prisma.order.count({ where: { id: order } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { id: note.id } })).toBe(1);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ status: UserStatus.ACTIVE, mobile: '9000000301' });
    expect(await prisma.sellerStaff.count({ where: { sellerId: cafe.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'seller.cleanup' } } })).toBe(0);
    expect(await imageExists(cafe.image.key)).toBe(true);
    expect(await imageExists(gift.image.key)).toBe(true);
    expect(await documentExists(docKey)).toBe(true);

    // The rolled-back run's manifest says so; removing its files keeps every one whose row survived.
    const abortedDir = readdirSync(backupRoot).find((name) => !runDirsBefore.has(name))!;
    const manifest = JSON.parse(readFileSync(path.join(backupRoot, abortedDir, 'manifest.json'), 'utf8')) as { aborted?: boolean; files: FileResult[] };
    expect(manifest.aborted).toBe(true);
    const retried = await deletePlannedFiles(manifest.files);
    expect(retried.map((file) => file.status)).toEqual(manifest.files.map(() => 'kept_still_referenced'));
    expect(await imageExists(cafe.image.key)).toBe(true);
    expect(await documentExists(docKey)).toBe(true);

    // With the fault gone, the same plan runs cleanly.
    const retry = await planSellerCleanup();
    const result = await executeSellerCleanup(null, { confirmToken: retry.token, actor: 'test operator', backupNote: 'test backup', filesBackupDir: backupRoot });
    expect(result.verification.ok).toBe(true);
    expect(await prisma.seller.count({ where: { code: { in: ['AADIONECAFE', 'GIFTSTORE'] } } })).toBe(0);
  });
});

describe('seller cleanup — purge-financial (owner: delete their paid orders, payments and settlements too)', () => {
  it('deletes paid/refunded orders, their payments, refunds, gateway events, coupon uses and settlements — never a shared order, a still-payable payment, a refund in progress, or another seller’s money', async () => {
    const keepGrocer = await seedSeller('KEEPGROCER', 'Keep Grocer', SellerType.GROCERY);
    const cafe = await seedSeller('AADIONECAFE', 'Aadione Cafe', SellerType.CAFE);
    const ramdev = await seedSeller('RAMDEVCLOTHING', 'Ram Dev Clothing', SellerType.FASHION);
    const hokam = await seedSeller('HAHOKAMFOOD', 'Ha Hokam Food', SellerType.RESTAURANT);
    const fashion = await seedSeller('FASHIONSTORE', 'Fashion Store', SellerType.FASHION);
    const sabji = await seedSeller('SABJIVALA', 'Sabji Vala', SellerType.GROCERY);
    await prisma.sellerBankDetail.create({ data: { sellerId: ramdev.id, accountHolderName: 'Ramdev', accountNumber: '000111222444', ifscCode: 'SBIN0000001' } });

    const session = await loginAs(CUSTOMER);
    const pay = (orderId: string, status: 'CAPTURED' | 'PENDING', ref: string) =>
      prisma.payment.create({ data: { orderId, provider: 'cashfree', providerOrderId: `cf_${ref}`, providerPaymentId: `pay_${ref}`, amountPaise: 10000, currency: 'INR', status } });

    // AADIONECAFE: paid + partly refunded, a gateway event, a coupon use -> all purged.
    const cafePaid = await placeCodOrder(session.accessToken, session.userId, [cafe.listingId]);
    const cafePayment = await pay(cafePaid, 'CAPTURED', 'cafe');
    const cafeRefund = await prisma.refund.create({ data: { paymentId: cafePayment.id, orderId: cafePaid, amountPaise: 1000, status: 'COMPLETED' } });
    const cafeEvent = await prisma.paymentEvent.create({
      data: { provider: 'cashfree', eventId: 'evt_cafe', eventType: 'PAYMENT_SUCCESS_WEBHOOK', signatureValid: true, payload: { data: { order: { order_id: 'cf_cafe' } } } },
    });
    const coupon = await prisma.coupon.create({ data: { code: 'DUMMY10', type: 'FLAT', discountValue: 1000, usedCount: 3 } });
    await prisma.couponRedemption.create({ data: { couponId: coupon.id, userId: session.userId, orderId: cafePaid, discountPaise: 1000 } });
    const financialNote = await prisma.auditLog.create({ data: { action: 'payment.confirm_manual', entityType: 'Order', entityId: cafePaid } });
    const complianceNote = await prisma.auditLog.create({ data: { action: 'seller_application.approve', entityType: 'Seller', entityId: cafe.id } });
    // RAMDEVCLOTHING: a settlement -> purged with the seller.
    await prisma.sellerSettlement.create({
      data: { sellerId: ramdev.id, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), grossSalesPaise: 10000, commissionPaise: 1000, netPayablePaise: 9000 },
    });
    // HAHOKAMFOOD: a payment opened just now — the customer could still complete it -> kept.
    const hokamOpen = await placeCodOrder(session.accessToken, session.userId, [hokam.listingId]);
    await pay(hokamOpen, 'PENDING', 'hokam');
    // FASHIONSTORE: a refund still in progress at the gateway -> kept.
    const fashionOrder = await placeCodOrder(session.accessToken, session.userId, [fashion.listingId]);
    const fashionPayment = await pay(fashionOrder, 'CAPTURED', 'fashion');
    await prisma.refund.create({ data: { paymentId: fashionPayment.id, orderId: fashionOrder, amountPaise: 10000, status: 'PROCESSING' } });
    // SABJIVALA: shares an order with a kept seller -> kept.
    const mixed = await placeCodOrder(session.accessToken, session.userId, [sabji.listingId, keepGrocer.listingId]);
    await pay(mixed, 'CAPTURED', 'mixed');
    // A kept seller's own paid order: never touched.
    const keepOrder = await placeCodOrder(session.accessToken, session.userId, [keepGrocer.listingId]);
    const keepPayment = await pay(keepOrder, 'CAPTURED', 'keep');
    const keepEvent = await prisma.paymentEvent.create({
      data: { provider: 'cashfree', eventId: 'evt_keep', eventType: 'PAYMENT_SUCCESS_WEBHOOK', signatureValid: true, payload: { data: { order: { order_id: 'cf_keep' } } } },
    });

    // The default mode archives the money-holding sellers; purge is a different plan with a different token.
    const preserve = await planSellerCleanup();
    expect(entry(preserve, 'AADIONECAFE').outcome).toBe('ARCHIVED_FOR_HISTORY');
    expect(entry(preserve, 'RAMDEVCLOTHING').outcome).toBe('ARCHIVED_FOR_HISTORY');
    const plan = await planSellerCleanup(null, prisma, { mode: 'purge-financial' });
    expect(plan.token).not.toBe(preserve.token);
    expect(plan.mode).toBe('purge-financial');
    expect(Object.fromEntries(plan.entries.filter((e) => e.found).map((e) => [e.code, e.outcome]))).toEqual({
      AADIONECAFE: 'PERMANENTLY_DELETED',
      HAHOKAMFOOD: 'ARCHIVED_FOR_HISTORY',
      RAMDEVCLOTHING: 'PERMANENTLY_DELETED',
      FASHIONSTORE: 'ARCHIVED_FOR_HISTORY',
      SABJIVALA: 'ARCHIVED_FOR_HISTORY',
    });
    expect(entry(plan, 'HAHOKAMFOOD').retainedOrders[0]!.reasons.join()).toMatch(/could still complete/);
    expect(entry(plan, 'FASHIONSTORE').retainedOrders[0]!.reasons.join()).toMatch(/refund still in progress/);
    expect(entry(plan, 'SABJIVALA').retainedOrders[0]!.reasons.join()).toMatch(/shared with seller\(s\) not removed: KEEPGROCER/);
    expect(plan.financial).toMatchObject({
      payments: [expect.objectContaining({ status: 'CAPTURED', amountPaise: 10000 })],
      refunds: [expect.objectContaining({ status: 'COMPLETED', amountPaise: 1000 })],
      settlements: [expect.objectContaining({ sellerCode: 'RAMDEVCLOTHING', netPayablePaise: 9000 })],
      paymentEvents: 1,
      couponRedemptions: 1,
    });
    expect(formatPlan(plan)).toMatch(/MODE: PURGE-FINANCIAL/);
    expect(formatPlan(plan)).toMatch(/settlements \(1\): RAMDEVCLOTHING 2026-09-01→2026-09-30 PENDING ₹90\.00/);

    // The preserve token cannot run the purge, nor the purge token the preserve plan.
    await expect(
      executeSellerCleanup(null, { confirmToken: preserve.token, actor: 'owner', backupNote: 'b', filesBackupDir: backupRoot, mode: 'purge-financial' }),
    ).rejects.toThrow(/does not match/);
    await expect(executeSellerCleanup(null, { confirmToken: plan.token, actor: 'owner', backupNote: 'b', filesBackupDir: backupRoot })).rejects.toThrow(/does not match/);

    const result = await executeSellerCleanup(null, { confirmToken: plan.token, actor: 'owner', backupNote: 'b', filesBackupDir: backupRoot, mode: 'purge-financial' });
    expect(result.verification).toEqual({ ok: true, problems: [] });
    expect(result).toMatchObject({ mode: 'purge-financial', deletedOrders: 1, deletedSettlements: 1 });

    // Purged.
    expect(await prisma.seller.count({ where: { code: { in: ['AADIONECAFE', 'RAMDEVCLOTHING'] } } })).toBe(0);
    expect(await prisma.order.count({ where: { id: cafePaid } })).toBe(0);
    expect(await prisma.payment.count({ where: { id: cafePayment.id } })).toBe(0);
    expect(await prisma.refund.count({ where: { id: cafeRefund.id } })).toBe(0);
    expect(await prisma.paymentEvent.count({ where: { id: cafeEvent.id } })).toBe(0);
    expect(await prisma.sellerSettlement.count()).toBe(0);
    expect(await prisma.sellerBankDetail.count({ where: { sellerId: ramdev.id } })).toBe(0);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(2);
    expect(await prisma.auditLog.count({ where: { id: { in: [financialNote.id, complianceNote.id] } } })).toBe(0);

    // Kept: the shared, still-payable and refund-in-progress orders with their money; the kept seller's money.
    expect(await prisma.order.count({ where: { id: { in: [hokamOpen, fashionOrder, mixed, keepOrder] } } })).toBe(4);
    expect(await prisma.payment.count()).toBe(4);
    expect(await prisma.refund.count()).toBe(1);
    expect(await prisma.payment.count({ where: { id: keepPayment.id } })).toBe(1);
    expect(await prisma.paymentEvent.count({ where: { id: keepEvent.id } })).toBe(1);
    expect(await prisma.seller.findUniqueOrThrow({ where: { code: 'HAHOKAMFOOD' } })).toMatchObject({ isActive: false });

    // The run's own audit record lists exactly which money rows went.
    const run = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller.cleanup_run' } });
    expect(run.after).toMatchObject({ mode: 'purge-financial', purged: { paymentEvents: 1, couponRedemptions: 1 } });
  });
});
