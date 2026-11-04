/**
 * Multi-variant product management — ONE parent product ("Mogri (मोगरी)") with
 * several variants (250g / 500g / 1kg), each managed on its own through the
 * seller API: price, MRP, stock and on-sale on its own listing (unchanged
 * listing routes, ledgered and row-locked); show / hide, edit, delete and add
 * through the single-variant routes (product-variant.service). Covers the
 * grouped seller / admin views, single parent approval, per-variant review of
 * a variant added later, duplicates, the customer view, cart / checkout on the
 * exact variant, order history, concurrency, single-variant regression,
 * review locks and access.
 *
 * The whole-set editor (PUT /seller/products/:id/variants) stays covered by
 * product-variants.test.ts.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, PaymentMethod, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { seedAddress, seedStore, sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { sellerImageFolder } from '../../src/modules/catalog/seller-image.service';
import { storage } from '../../src/infra/storage';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

interface Seller {
  id: string;
  token: string;
  categoryId: string;
}

interface VariantView {
  id: string;
  variantName: string;
  sku: string;
  optionValues: Record<string, string>;
  isDefault: boolean;
  approvalStatus: string;
  listing: { id: string; pricePaise: number; mrpPaise: number; stockQty: number; isAvailable: boolean; tracksStock: boolean } | null;
}

interface ProductView {
  id: string;
  name: string;
  description: string | null;
  approvalStatus: string;
  optionGroups: { name: string; values: string[] }[];
  images: { id: string }[];
  variants: VariantView[];
}

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

/** An ACTIVE seller with its own category (grocery-style) or menu section (food). */
async function seedSeller(mobile: string, sellerType: SellerType = SellerType.GROCERY): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `${sellerType} ${mobile}`,
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
  let categoryId: string;
  if (sellerType === SellerType.RESTAURANT || sellerType === SellerType.CAFE) {
    categoryId = expectSuccess<{ id: string }>((await as(token).post('/seller/menu-sections', { name: 'Mains' }).expect(201)).body).data.id;
  } else {
    const tree = expectSuccess<{ categories: { id: string }[] }>((await as(token).post('/seller/categories', { name: 'Main' }).expect(201)).body).data;
    categoryId = tree.categories[0]!.id;
  }
  return { id: seller.id, token, categoryId };
}

const as = (token: string) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  put: (path: string, body: object) => api().put(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  delete: (path: string) => api().delete(`/api/v1${path}`).set('Authorization', bearer(token)),
});

/** An upload key inside the seller's own image folder (what the presign flow hands out). */
/**
 * A photo the seller has uploaded: a real JPEG at a key in the seller's own
 * upload space. Attaching reads (and converts) the stored file, so a key with
 * no file behind it is correctly refused ("could not be found").
 */
async function uploadedImageKey(seller: Seller): Promise<string> {
  const key = `${sellerImageFolder(seller.id)}/${randomUUID()}.jpg`;
  const jpeg = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#2e7d32' } }).jpeg().toBuffer();
  await storage.put(key, jpeg, 'image/jpeg');
  return key;
}

const sku = () => `SKU-${randomUUID().slice(0, 8).toUpperCase()}`;

async function product(seller: Seller, id: string): Promise<ProductView> {
  return expectSuccess<ProductView>((await as(seller.token).get(`/seller/products/${id}`).expect(200)).body).data;
}

async function createSimple(seller: Seller, name = 'Tomato 1 kg') {
  const res = await as(seller.token)
    .post('/seller/products', { categoryId: seller.categoryId, name, sku: sku(), variantName: '1 kg', unit: UnitType.KG, unitValue: 1, mrpPaise: 6_000, pricePaise: 5_000, stockQty: 40 })
    .expect(201);
  return expectSuccess<{ id: string; variantId: string; listingId: string }>(res.body).data.id;
}

/** Marketplace product with option groups: one row per variant (SKU, MRP, price, opening stock). */
async function createWithOptions(seller: Seller, name: string, groups: { name: string; values: string[] }[], rows: { values: Record<string, string>; price: number; stock?: number }[]) {
  const res = await as(seller.token)
    .post('/seller/products', {
      categoryId: seller.categoryId,
      name,
      optionGroups: groups,
      variants: rows.map((r) => ({ optionValues: r.values, sku: sku(), pricePaise: r.price, mrpPaise: r.price + 1_000, stockQty: r.stock ?? 10 })),
    })
    .expect(201);
  return expectSuccess<{ id: string }>(res.body).data.id;
}

async function approve(seller: Seller, admin: string, productId: string): Promise<string> {
  const batch = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/approval-batches', { productIds: [productId] }).expect(201)).body).data;
  await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);
  return batch.id;
}

async function customerDetail(productId: string) {
  return expectSuccess<{ optionGroups: { name: string; values: string[] }[]; variants: { id: string; variantName: string; optionValues: Record<string, string>; pricePaise: number; sellerListingId: string; inStock: boolean }[] }>(
    (await api().get(`/api/v1/products/${productId}`).expect(200)).body,
  ).data;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});


/* -------------------------------------------------------------------------- */
/* Multi-variant product management: one parent, variants managed one by one  */
/* -------------------------------------------------------------------------- */

const WEIGHT = [{ name: 'Weight', values: ['250g', '500g', '1kg'] }];

/** Mogri (मोगरी): 250g ₹20 (10), 500g ₹39 (6), 1kg ₹78 (6); MRP = price + ₹10. */
function mogri(seller: Seller) {
  return createWithOptions(seller, 'Mogri (मोगरी)', WEIGHT, [
    { values: { Weight: '250g' }, price: 2_000, stock: 10 },
    { values: { Weight: '500g' }, price: 3_900, stock: 6 },
    { values: { Weight: '1kg' }, price: 7_800, stock: 6 },
  ]);
}

type ManagedVariant = VariantView & {
  status?: string;
  visibility?: { sellable: boolean; reason: string };
  listing: (NonNullable<VariantView['listing']> & { reservedQty: number; availableQty: number }) | null;
};
const managed = async (seller: Seller, id: string) =>
  expectSuccess<ProductView & { variants: ManagedVariant[]; visibility: { sellable: boolean; reason: string } }>(
    (await as(seller.token).get(`/seller/products/${id}`).expect(200)).body,
  ).data;
const named = (variants: ManagedVariant[], name: string) => variants.find((v) => v.variantName === name)!;
const listingsOf = (productId: string) =>
  prisma.sellerListing.findMany({
    where: { variant: { productId } },
    orderBy: { id: 'asc' },
    select: { id: true, variantId: true, pricePaise: true, mrpPaise: true, stockQty: true, reservedQty: true, isAvailable: true },
  });
const customerNames = async (id: string) => (await customerDetail(id)).variants.map((v) => v.variantName).sort();
let customerSeq = 0;
async function customer() {
  customerSeq += 1;
  const mobile = `95500088${String(customerSeq).padStart(2, '0')}`;
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  return { token: session.accessToken, addressId: await seedAddress(session.userId) };
}
const placeCod = (c: { token: string; addressId: string }) =>
  api().post('/api/v1/orders').set('Authorization', bearer(c.token)).set('Idempotency-Key', randomUUID()).send({ addressId: c.addressId, paymentMethod: PaymentMethod.COD });

describe('G. one parent product, three variants', () => {
  it('is created as ONE product with three variants — each its own SKU, listing and opening-stock ledger — and listed once', async () => {
    const seller = await seedSeller('9550001001');
    const admin = await loginAdmin();
    const id = await mogri(seller);

    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id } })).toBe(1);
    const view = await managed(seller, id);
    expect(view.variants.map((v) => v.variantName)).toEqual(['250g', '500g', '1kg']);
    expect(new Set(view.variants.map((v) => v.sku)).size).toBe(3);
    expect(new Set(view.variants.map((v) => v.listing!.id)).size).toBe(3);
    expect(view.variants.map((v) => [v.listing!.pricePaise, v.listing!.stockQty])).toEqual([[2_000, 10], [3_900, 6], [7_800, 6]]);
    for (const v of view.variants) expect(await prisma.stockLedger.count({ where: { sellerListingId: v.listing!.id } })).toBe(1);

    // Every listing is marked as the seller's own product, so the panel shows ONE row for it.
    const listings = expectSuccess<{ id: string; ownProduct: boolean; productId: string }[]>((await as(seller.token).get('/seller/listings').expect(200)).body).data;
    expect(listings.filter((l) => l.productId === id).map((l) => l.ownProduct)).toEqual([true, true, true]);

    // Admin: one grouped row with every variant underneath.
    const rows = expectSuccess<{ items: { productId: string; variantCount: number; variants: { variantName: string; listing: { pricePaise: number; stockQty: number } }[] }[] }>(
      (await as(admin).get(`/admin/marketplace/products?sellerId=${seller.id}`).expect(200)).body,
    ).data.items.filter((row) => row.productId === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.variantCount).toBe(3);
    expect(rows[0]!.variants.map((v) => [v.variantName, v.listing.pricePaise, v.listing.stockQty])).toEqual([
      ['250g', 2_000, 10],
      ['500g', 3_900, 6],
      ['1kg', 7_800, 6],
    ]);
  });

  it('is approved once: one batch item for the parent, then every variant is on sale at its own price', async () => {
    const seller = await seedSeller('9550001002');
    const admin = await loginAdmin();
    const id = await mogri(seller);
    const batch = expectSuccess<{ id: string; items: unknown[] }>((await as(seller.token).post('/seller/approval-batches', {}).expect(201)).body).data;
    expect(batch.items).toHaveLength(1);
    await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);
    const detail = await customerDetail(id);
    expect(detail.variants.map((v) => [v.variantName, v.pricePaise, v.inStock])).toEqual([
      ['250g', 2_000, true],
      ['500g', 3_900, true],
      ['1kg', 7_800, true],
    ]);
    expect(new Set(detail.variants.map((v) => v.sellerListingId)).size).toBe(3);
  });
});

describe('H. each variant is managed on its own', () => {
  it('changing the 500g price, MRP or stock changes the 500g listing alone', async () => {
    const seller = await seedSeller('9550001003');
    const admin = await loginAdmin();
    const id = await mogri(seller);
    await approve(seller, admin, id);
    const before = await listingsOf(id);
    const half = named((await managed(seller, id)).variants, '500g').listing!.id;
    const others = () => before.filter((l) => l.id !== half);

    await as(seller.token).patch(`/seller/listings/${half}`, { pricePaise: 4_500 }).expect(200);
    await as(seller.token).patch(`/seller/listings/${half}`, { mrpPaise: 5_500 }).expect(200);
    await as(seller.token).patch(`/seller/listings/${half}`, { stockQty: 9 }).expect(200);
    await as(seller.token).post(`/seller/listings/${half}/stock-adjust`, { delta: -2 }).expect(200);

    const after = await listingsOf(id);
    expect(after.find((l) => l.id === half)).toMatchObject({ pricePaise: 4_500, mrpPaise: 5_500, stockQty: 7 });
    expect(after.filter((l) => l.id !== half)).toEqual(others());
    for (const l of others()) expect(await prisma.stockLedger.count({ where: { sellerListingId: l.id } })).toBe(1);
    expect(await prisma.stockLedger.count({ where: { sellerListingId: half } })).toBe(3);
    expect((await customerDetail(id)).variants.map((v) => [v.variantName, v.pricePaise])).toEqual([
      ['250g', 2_000],
      ['500g', 4_500],
      ['1kg', 7_800],
    ]);
    // Never below zero.
    expect((await as(seller.token).post(`/seller/listings/${half}/stock-adjust`, { delta: -100 })).status).toBeGreaterThanOrEqual(400);
    expect((await listingsOf(id)).find((l) => l.id === half)!.stockQty).toBe(7);
  });

  it('hiding one variant hides only it; hiding the default hands over; showing brings it back', async () => {
    const seller = await seedSeller('9550001004');
    const admin = await loginAdmin();
    const id = await mogri(seller);
    await approve(seller, admin, id);
    const small = named((await managed(seller, id)).variants, '250g');
    expect(small.isDefault).toBe(true);

    await as(seller.token).patch(`/seller/products/${id}/variants/${small.id}/visibility`, { visible: false }).expect(200);
    let view = await managed(seller, id);
    expect(named(view.variants, '250g')).toMatchObject({ status: 'INACTIVE', isDefault: false, visibility: { sellable: false, reason: 'HIDDEN_BY_SELLER' } });
    expect(named(view.variants, '500g').isDefault).toBe(true);
    expect(view.visibility.sellable).toBe(true);
    expect(await customerNames(id)).toEqual(['1kg', '500g']);
    const c = await customer();
    expect((await as(c.token).post('/cart/items', { sellerListingId: small.listing!.id, qty: 1 })).status).toBeGreaterThanOrEqual(400);

    await as(seller.token).patch(`/seller/products/${id}/variants/${small.id}/visibility`, { visible: true }).expect(200);
    view = await managed(seller, id);
    expect(named(view.variants, '250g').status).toBe('ACTIVE');
    expect(await customerNames(id)).toEqual(['1kg', '250g', '500g']);
    expect(await prisma.auditLog.count({ where: { entityId: small.id, action: { in: ['product.seller_variant_hidden', 'product.seller_variant_shown'] } } })).toBe(2);
  });

  it('taking one variant off sale makes only it unpurchasable', async () => {
    const seller = await seedSeller('9550001005');
    const admin = await loginAdmin();
    await seedStore();
    const id = await mogri(seller);
    await approve(seller, admin, id);
    const view = await managed(seller, id);
    await as(seller.token).patch(`/seller/listings/${named(view.variants, '500g').listing!.id}`, { isAvailable: false }).expect(200);

    const half = (await customerDetail(id)).variants.find((v) => v.variantName === '500g');
    expect(!half || half.inStock === false).toBe(true);
    const c = await customer();
    expect((await as(c.token).post('/cart/items', { sellerListingId: named(view.variants, '500g').listing!.id, qty: 1 })).status).toBeGreaterThanOrEqual(400);
    await as(c.token).post('/cart/items', { sellerListingId: named(view.variants, '250g').listing!.id, qty: 1 }).expect(200);
    expect(named((await managed(seller, id)).variants, '500g').visibility!.reason).toBe('OFF_SALE');
  });
});

describe('I. deleting one variant', () => {
  it('removes only 500g: the parent, 250g and 1kg stay on sale, and its past order is unchanged', async () => {
    const seller = await seedSeller('9550001006');
    const admin = await loginAdmin();
    await seedStore();
    const id = await mogri(seller);
    await approve(seller, admin, id);
    const half = named((await managed(seller, id)).variants, '500g');
    const c = await customer();
    // 3 × ₹39 = ₹117, above the ₹99 minimum order.
    await as(c.token).post('/cart/items', { sellerListingId: half.listing!.id, qty: 3 }).expect(200);
    await placeCod(c).expect(201);
    const ledgerBefore = await prisma.stockLedger.count({ where: { sellerListingId: half.listing!.id } });

    await as(seller.token).delete(`/seller/products/${id}/variants/${half.id}`).expect(200);

    const view = await managed(seller, id);
    expect(view.variants.map((v) => v.variantName)).toEqual(['250g', '1kg']);
    expect(view.optionGroups).toEqual([{ name: 'Weight', values: ['250g', '1kg'] }]);
    expect([view.approvalStatus, (await prisma.product.findUniqueOrThrow({ where: { id } })).status]).toEqual(['APPROVED', 'ACTIVE']);
    expect(await customerNames(id)).toEqual(['1kg', '250g']);
    // History: the variant row, its listing (off sale), its ledger and the order item all remain.
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: half.id } })).deletedAt).not.toBeNull();
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: half.listing!.id } })).isAvailable).toBe(false);
    expect(await prisma.stockLedger.count({ where: { sellerListingId: half.listing!.id } })).toBe(ledgerBefore);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { sellerListingId: half.listing!.id } });
    expect([item.variantName, item.unitPricePaise, item.qty]).toEqual(['500g', 3_900, 3]);
    expect(await prisma.auditLog.count({ where: { entityId: half.id, action: 'product.seller_variant_delete' } })).toBe(1);
  });

  it('the last remaining variant cannot be deleted (the product is hidden or deleted instead)', async () => {
    const seller = await seedSeller('9550001007');
    const id = await mogri(seller);
    const view = await managed(seller, id);
    await as(seller.token).delete(`/seller/products/${id}/variants/${named(view.variants, '250g').id}`).expect(200);
    await as(seller.token).delete(`/seller/products/${id}/variants/${named(view.variants, '500g').id}`).expect(200);
    const last = await as(seller.token).delete(`/seller/products/${id}/variants/${named(view.variants, '1kg').id}`);
    expect(last.status).toBe(409);
    expect((await managed(seller, id)).variants.map((v) => v.variantName)).toEqual(['1kg']);

    const simple = await createSimple(seller);
    const only = (await managed(seller, simple)).variants[0]!;
    expect((await as(seller.token).delete(`/seller/products/${simple}/variants/${only.id}`)).status).toBe(409);
  });
});

describe('J. adding a variant', () => {
  it('a 2kg variant of an approved product waits for its own review; the others stay on sale; approved or rejected on its own', async () => {
    const seller = await seedSeller('9550001008');
    const admin = await loginAdmin();
    const id = await mogri(seller);
    await approve(seller, admin, id);

    await as(seller.token)
      .post(`/seller/products/${id}/variants`, { optionValues: { Weight: '2kg' }, sku: sku(), pricePaise: 15_000, mrpPaise: 16_000, stockQty: 4 })
      .expect(201);
    let view = await managed(seller, id);
    expect(view.variants.map((v) => v.variantName)).toEqual(['250g', '500g', '1kg', '2kg']);
    expect(named(view.variants, '2kg')).toMatchObject({ approvalStatus: 'PENDING', status: 'DRAFT', visibility: { reason: 'PENDING_APPROVAL' } });
    for (const name of ['250g', '500g', '1kg']) expect(named(view.variants, name)).toMatchObject({ approvalStatus: 'APPROVED', status: 'ACTIVE' });
    expect(view.optionGroups[0]!.values).toEqual(['250g', '500g', '1kg', '2kg']);
    expect(view.approvalStatus).toBe('APPROVED');
    expect(await customerNames(id)).toEqual(['1kg', '250g', '500g']);
    // Not toggleable before review.
    expect((await as(seller.token).patch(`/seller/products/${id}/variants/${named(view.variants, '2kg').id}/visibility`, { visible: true })).status).toBe(409);

    // One review item; a second submission is refused.
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>((await as(seller.token).post('/seller/approval-batches', { productIds: [id] }).expect(201)).body).data;
    expect(batch.items).toHaveLength(1);
    expect((await as(seller.token).post('/seller/approval-batches', { productIds: [id] })).status).toBe(409);
    const adminRow = expectSuccess<{ items: { productId: string; variants: { variantName: string; approvalStatus: string }[] }[] }>(
      (await as(admin).get(`/admin/marketplace/products?sellerId=${seller.id}`).expect(200)).body,
    ).data.items.find((row) => row.productId === id)!;
    expect(adminRow.variants.find((v) => v.variantName === '2kg')!.approvalStatus).toBe('PENDING');

    // Rejected: only 2kg; the product and the three others are untouched and on sale.
    await as(admin).patch(`/admin/approval-batches/${batch.id}/items/${batch.items[0]!.id}`, { status: 'REJECTED', reviewNote: 'Wrong weight label' }).expect(200);
    view = await managed(seller, id);
    expect(named(view.variants, '2kg').approvalStatus).toBe('REJECTED');
    expect(view.approvalStatus).toBe('APPROVED');
    expect(await customerNames(id)).toEqual(['1kg', '250g', '500g']);

    // Corrected → back to review → approved: now on sale too.
    await as(seller.token).patch(`/seller/products/${id}/variants/${named(view.variants, '2kg').id}`, { sku: sku() }).expect(200);
    expect(named((await managed(seller, id)).variants, '2kg')).toMatchObject({ approvalStatus: 'PENDING', status: 'DRAFT' });
    await approve(seller, admin, id);
    expect(await customerNames(id)).toEqual(['1kg', '250g', '2kg', '500g']);
  });

  it('a combination the product already has is refused — adding or renaming, any letter case', async () => {
    const seller = await seedSeller('9550001009');
    const id = await mogri(seller);
    for (const weight of ['500G', '1kg ']) {
      const res = await as(seller.token).post(`/seller/products/${id}/variants`, { optionValues: { Weight: weight }, sku: sku(), pricePaise: 1_000, mrpPaise: 1_200, stockQty: 1 });
      expect(res.status).toBe(409);
    }
    const kilo = named((await managed(seller, id)).variants, '1kg');
    expect((await as(seller.token).patch(`/seller/products/${id}/variants/${kilo.id}`, { optionValues: { Weight: '500g' } })).status).toBe(409);
    expect((await managed(seller, id)).variants).toHaveLength(3);

    // A real rename works, and the old value leaves the option group.
    await as(seller.token).patch(`/seller/products/${id}/variants/${kilo.id}`, { optionValues: { Weight: '1.5kg' } }).expect(200);
    const view = await managed(seller, id);
    expect(view.variants.map((v) => v.variantName)).toEqual(['250g', '500g', '1.5kg']);
    expect(view.optionGroups[0]!.values).toEqual(['250g', '500g', '1.5kg']);
  });
});

describe('K. customer, cart, checkout and history use the exact variant', () => {
  it('cart and order carry the selected variant only; its stock alone moves; later edits never change the order', async () => {
    const seller = await seedSeller('9550001010');
    const admin = await loginAdmin();
    await seedStore();
    const id = await mogri(seller);
    await approve(seller, admin, id);
    const half = (await customerDetail(id)).variants.find((v) => v.variantName === '500g')!;
    const before = await listingsOf(id);

    const c = await customer();
    const cart = expectSuccess<{ items: { sellerListingId: string; variantId?: string; unitPricePaise: number; qty: number }[] }>(
      (await as(c.token).post('/cart/items', { sellerListingId: half.sellerListingId, qty: 3 }).expect(200)).body,
    ).data;
    expect(cart.items.map((i) => [i.sellerListingId, i.unitPricePaise, i.qty])).toEqual([[half.sellerListingId, 3_900, 3]]);
    if (cart.items[0]!.variantId) expect(cart.items[0]!.variantId).toBe(half.id);

    await placeCod(c).expect(201);
    const after = await listingsOf(id);
    const moved = after.find((l) => l.id === half.sellerListingId)!;
    const was = before.find((l) => l.id === half.sellerListingId)!;
    expect(was.stockQty - was.reservedQty - (moved.stockQty - moved.reservedQty)).toBe(3);
    expect(after.filter((l) => l.id !== half.sellerListingId)).toEqual(before.filter((l) => l.id !== half.sellerListingId));

    const item = await prisma.orderItem.findFirstOrThrow({ where: { sellerListingId: half.sellerListingId } });
    expect([item.variantName, item.unitPricePaise, item.qty]).toEqual(['500g', 3_900, 3]);
    const sold = named((await managed(seller, id)).variants, '500g');
    await as(seller.token).patch(`/seller/listings/${sold.listing!.id}`, { pricePaise: 4_500, mrpPaise: 5_000 }).expect(200);
    await as(seller.token).patch(`/seller/products/${id}/variants/${sold.id}`, { optionValues: { Weight: '600g' } }).expect(200);
    const unchanged = await prisma.orderItem.findFirstOrThrow({ where: { id: item.id } });
    expect([unchanged.variantName, unchanged.unitPricePaise, unchanged.qty, unchanged.sku]).toEqual(['500g', 3_900, 3, item.sku]);
  });
});

describe('L. concurrency', () => {
  it('simultaneous changes to different variants never cross, and the same variant never goes below zero', async () => {
    const seller = await seedSeller('9550001011');
    const admin = await loginAdmin();
    const id = await mogri(seller);
    await approve(seller, admin, id);
    const view = await managed(seller, id);
    const [small, half, kilo] = ['250g', '500g', '1kg'].map((n) => named(view.variants, n).listing!.id);
    const S = as(seller.token);
    const results = await Promise.all([
      S.post(`/seller/listings/${small}/stock-adjust`, { delta: 5 }),
      S.post(`/seller/listings/${half}/stock-adjust`, { delta: -3 }),
      S.patch(`/seller/listings/${half}`, { pricePaise: 4_100 }),
      S.post(`/seller/listings/${kilo}/stock-adjust`, { delta: 1 }),
      S.post(`/seller/listings/${kilo}/stock-adjust`, { delta: -100 }),
    ]);
    expect(results.slice(0, 4).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(results[4]!.status).toBeGreaterThanOrEqual(400);
    const after = await listingsOf(id);
    expect(after.find((l) => l.id === small)).toMatchObject({ stockQty: 15, pricePaise: 2_000 });
    expect(after.find((l) => l.id === half)).toMatchObject({ stockQty: 3, pricePaise: 4_100 });
    expect(after.find((l) => l.id === kilo)).toMatchObject({ stockQty: 7, pricePaise: 7_800 });
  });

  it('two simultaneous adds of the same new variant create it once', async () => {
    const seller = await seedSeller('9550001012');
    const id = await mogri(seller);
    const add = () => as(seller.token).post(`/seller/products/${id}/variants`, { optionValues: { Weight: '2kg' }, sku: sku(), pricePaise: 15_000, mrpPaise: 16_000, stockQty: 4 });
    const results = await Promise.all([add(), add()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await managed(seller, id)).variants.filter((v) => v.variantName === '2kg')).toHaveLength(1);
  });
});

describe('M. single-variant products, reviews and access', () => {
  it('a single-variant product works as before; adding a variant asks for options first; hiding its only variant hides it', async () => {
    const seller = await seedSeller('9550001013');
    const admin = await loginAdmin();
    const id = await createSimple(seller);
    await approve(seller, admin, id);
    const only = (await managed(seller, id)).variants[0]!;
    await as(seller.token).patch(`/seller/listings/${only.listing!.id}`, { pricePaise: 5_500 }).expect(200);
    expect((await customerDetail(id)).variants.map((v) => v.pricePaise)).toEqual([5_500]);
    const add = await as(seller.token).post(`/seller/products/${id}/variants`, { optionValues: { Size: '2 kg' }, sku: sku(), pricePaise: 9_000, mrpPaise: 10_000, stockQty: 1 });
    expect(add.status).toBe(400);

    await as(seller.token).patch(`/seller/products/${id}/variants/${only.id}/visibility`, { visible: false }).expect(200);
    expect((await api().get(`/api/v1/products/${id}`)).status).toBe(404);
    expect((await managed(seller, id)).visibility.reason).toBe('HIDDEN_BY_SELLER');
    await as(seller.token).patch(`/seller/products/${id}/variants/${only.id}/visibility`, { visible: true }).expect(200);
    expect((await customerDetail(id)).variants).toHaveLength(1);
  });

  it('while the product is under review its variants cannot be added, edited or deleted; prices and stock still can', async () => {
    const seller = await seedSeller('9550001014');
    const id = await mogri(seller);
    await as(seller.token).post('/seller/approval-batches', {}).expect(201);
    const view = await managed(seller, id);
    const half = named(view.variants, '500g');
    const refused = [
      await as(seller.token).post(`/seller/products/${id}/variants`, { optionValues: { Weight: '2kg' }, sku: sku(), pricePaise: 15_000, mrpPaise: 16_000, stockQty: 4 }),
      await as(seller.token).patch(`/seller/products/${id}/variants/${half.id}`, { sku: sku() }),
      await as(seller.token).delete(`/seller/products/${id}/variants/${half.id}`),
    ];
    expect(refused.map((r) => r.status)).toEqual([409, 409, 409]);
    await as(seller.token).patch(`/seller/listings/${half.listing!.id}`, { pricePaise: 4_000 }).expect(200);
    expect((await managed(seller, id)).variants).toHaveLength(3);
  });

  it('another seller, a customer or a wrong product never reaches a variant', async () => {
    const owner = await seedSeller('9550001015');
    const other = await seedSeller('9550001016');
    const id = await mogri(owner);
    const otherProduct = await createSimple(other);
    const half = named((await managed(owner, id)).variants, '500g');
    const tries = (token: string, productId: string) => [
      as(token).post(`/seller/products/${productId}/variants`, { optionValues: { Weight: '2kg' }, sku: sku(), pricePaise: 15_000, mrpPaise: 16_000, stockQty: 4 }),
      as(token).patch(`/seller/products/${productId}/variants/${half.id}`, { sku: sku() }),
      as(token).patch(`/seller/products/${productId}/variants/${half.id}/visibility`, { visible: false }),
      as(token).delete(`/seller/products/${productId}/variants/${half.id}`),
    ];
    for (const res of await Promise.all(tries(other.token, id))) expect(res.status).toBe(404);
    // The variant id under another (own) product: not found either.
    for (const res of (await Promise.all(tries(other.token, otherProduct))).slice(1)) expect(res.status).toBe(404);
    const c = await customer();
    for (const res of await Promise.all(tries(c.token, id))) expect(res.status).toBe(403);
    expect((await managed(owner, id)).variants.map((v) => [v.variantName, v.status])).toEqual([
      ['250g', 'ACTIVE'],
      ['500g', 'ACTIVE'],
      ['1kg', 'ACTIVE'],
    ]);
  });
});
