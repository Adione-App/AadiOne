/**
 * Options / variants and post-approval editing (V2).
 *
 * Variants extend the EXISTING model: one ProductVariant per sellable
 * combination (optionValues + variantName), each with the seller's own
 * SellerListing (price, MRP, stock, availability). No option groups = a
 * simple item with one variant. A variant added to an already-approved product
 * waits for review per variant while the product stays live. After approval
 * the seller edits its own content (name, description, images, price, stock,
 * availability) without a new review.
 */

import { randomUUID } from 'node:crypto';
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
const imageKey = (seller: Seller) => `${sellerImageFolder(seller.id)}/${randomUUID()}.jpg`;

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

describe('A. an APPROVED marketplace product stays editable by its seller', () => {
  it('edits name, description, images (add / reorder / remove), price, stock and availability — live, still APPROVED', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9550000001');
    const id = await createSimple(seller);
    await approve(seller, admin, id);
    const S = as(seller.token);

    await S.patch(`/seller/products/${id}`, { name: 'Desi Tomato 1 kg', description: 'Farm fresh' }).expect(200);
    const keys = [1, 2].map(() => imageKey(seller));
    // Images go through the seller's own upload space; attach two, reorder, remove one.
    for (const key of keys) expect([200, 201]).toContain((await S.post(`/seller/products/${id}/images`, { key })).status);
    let view = await product(seller, id);
    expect(view.images).toHaveLength(2);
    await S.put(`/seller/products/${id}/images/order`, { imageIds: [view.images[1]!.id, view.images[0]!.id] }).expect(200);
    const reordered = (await product(seller, id)).images.map((i) => i.id);
    expect(reordered).toEqual([view.images[1]!.id, view.images[0]!.id]);
    await S.delete(`/seller/products/${id}/images/${reordered[0]}`).expect(200);

    const listingId = view.variants[0]!.listing!.id;
    await S.patch(`/seller/listings/${listingId}`, { pricePaise: 5_500, stockQty: 60 }).expect(200);
    await S.patch(`/seller/listings/${listingId}`, { isAvailable: false }).expect(200);

    view = await product(seller, id);
    expect([view.name, view.description, view.approvalStatus, view.images.length]).toEqual(['Desi Tomato 1 kg', 'Farm fresh', 'APPROVED', 1]);
    expect(view.variants[0]!.listing).toMatchObject({ pricePaise: 5_500, stockQty: 60, isAvailable: false });
    // Stock still goes through the ledger.
    expect(await prisma.stockLedger.count({ where: { sellerListingId: listingId } })).toBe(2);
    // Audit trail of the content edit.
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'product.seller_update' } })).toBe(1);
    // Still live for customers (once switched back on).
    await S.patch(`/seller/listings/${listingId}`, { isAvailable: true }).expect(200);
    expect((await customerDetail(id)).variants).toHaveLength(1);
  });
});

describe('B. an APPROVED restaurant food item stays editable', () => {
  it('edits name, description, photos, price and availability; no MRP / stock involved', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9550000002', SellerType.RESTAURANT);
    const S = as(seller.token);
    const id = expectSuccess<{ id: string }>((await S.post('/seller/products', { categoryId: seller.categoryId, name: 'Dal Tadka', pricePaise: 12_000 }).expect(201)).body).data.id;
    await approve(seller, admin, id);

    await S.patch(`/seller/products/${id}`, { name: 'Dal Tadka (Ghee)', description: 'Slow cooked', pricePaise: 13_000 }).expect(200);
    for (let i = 0; i < 2; i += 1) expect([200, 201]).toContain((await S.post(`/seller/products/${id}/images`, { key: imageKey(seller) })).status);
    let view = await product(seller, id);
    await S.put(`/seller/products/${id}/images/order`, { imageIds: view.images.map((i) => i.id).reverse() }).expect(200);
    await S.delete(`/seller/products/${id}/images/${view.images[0]!.id}`).expect(200);
    await S.patch(`/seller/listings/${view.variants[0]!.listing!.id}`, { isAvailable: false }).expect(200);

    view = await product(seller, id);
    expect([view.name, view.description, view.approvalStatus, view.images.length]).toEqual(['Dal Tadka (Ghee)', 'Slow cooked', 'APPROVED', 1]);
    expect(view.variants[0]!.listing).toMatchObject({ pricePaise: 13_000, mrpPaise: 13_000, isAvailable: false, tracksStock: false });
  });
});

describe('C. options / variants (generic, optional)', () => {
  it('a simple product has no option groups and exactly one variant', async () => {
    const seller = await seedSeller('9550000003');
    const view = await product(seller, await createSimple(seller));
    expect(view.optionGroups).toEqual([]);
    expect(view.variants.map((v) => [v.variantName, v.optionValues, v.isDefault])).toEqual([['1 kg', {}, true]]);
  });

  it('pizza Half / Full (food): one price per variant, no SKU / MRP / stock', async () => {
    const seller = await seedSeller('9550000004', SellerType.RESTAURANT);
    const res = await as(seller.token)
      .post('/seller/products', {
        categoryId: seller.categoryId,
        name: 'Margherita Pizza',
        optionGroups: [{ name: 'Size', values: ['Half', 'Full'] }],
        variants: [
          { optionValues: { Size: 'Half' }, pricePaise: 12_000 },
          { optionValues: { Size: 'Full' }, pricePaise: 22_000 },
        ],
      })
      .expect(201);
    const view = await product(seller, expectSuccess<{ id: string }>(res.body).data.id);
    expect(view.variants.map((v) => [v.variantName, v.listing!.pricePaise, v.listing!.tracksStock])).toEqual([
      ['Half', 12_000, false],
      ['Full', 22_000, false],
    ]);
    expect(view.variants.every((v) => v.sku.startsWith('FOOD-'))).toBe(true);
  });

  it('pizza Small / Medium / Large, grocery 500 g / 1 kg, clothing Size — correct price and stock per variant', async () => {
    const seller = await seedSeller('9550000005');
    const pizza = await product(
      seller,
      await createWithOptions(seller, 'Frozen Pizza', [{ name: 'Size', values: ['Small', 'Medium', 'Large'] }], [
        { values: { Size: 'Small' }, price: 14_900, stock: 5 },
        { values: { Size: 'Medium' }, price: 24_900, stock: 6 },
        { values: { Size: 'Large' }, price: 34_900, stock: 7 },
      ]),
    );
    expect(pizza.variants.map((v) => [v.variantName, v.listing!.pricePaise, v.listing!.stockQty])).toEqual([
      ['Small', 14_900, 5],
      ['Medium', 24_900, 6],
      ['Large', 34_900, 7],
    ]);
    const rice = await product(
      seller,
      await createWithOptions(seller, 'Basmati Rice', [{ name: 'Pack Size', values: ['500 g', '1 kg'] }], [
        { values: { 'Pack Size': '500 g' }, price: 6_000 },
        { values: { 'Pack Size': '1 kg' }, price: 11_000 },
      ]),
    );
    expect(rice.variants.map((v) => v.variantName)).toEqual(['500 g', '1 kg']);
    const tshirt = await product(
      seller,
      await createWithOptions(seller, 'Cotton T-Shirt', [{ name: 'Size', values: ['S', 'M', 'L', 'XL', 'XXL'] }], ['S', 'M', 'L', 'XL', 'XXL'].map((size, i) => ({ values: { Size: size }, price: 49_900 + i * 100 }))),
    );
    expect(tshirt.variants).toHaveLength(5);
    // Each opening stock is ledgered on its own listing.
    expect(await prisma.stockLedger.count({ where: { sellerListingId: pizza.variants[2]!.listing!.id } })).toBe(1);
  });

  it('multiple option groups (Size × Color); invalid combinations and duplicates are refused', async () => {
    const seller = await seedSeller('9550000006');
    const groups = [
      { name: 'Size', values: ['M', 'L'] },
      { name: 'Color', values: ['Black', 'White'] },
    ];
    const view = await product(
      seller,
      await createWithOptions(seller, 'Polo', groups, [
        { values: { Size: 'M', Color: 'Black' }, price: 59_900 },
        { values: { Size: 'L', Color: 'White' }, price: 64_900 },
      ]),
    );
    expect(view.variants.map((v) => v.variantName)).toEqual(['M / Black', 'L / White']);
    expect(view.optionGroups).toEqual(groups);

    const base = { categoryId: seller.categoryId, name: 'Bad', optionGroups: groups };
    const row = (values: Record<string, string>) => ({ optionValues: values, sku: sku(), pricePaise: 100, mrpPaise: 200, stockQty: 1 });
    expect((await as(seller.token).post('/seller/products', { ...base, variants: [row({ Size: 'M' })] })).status).toBe(400); // missing Color
    expect((await as(seller.token).post('/seller/products', { ...base, variants: [row({ Size: 'XL', Color: 'Black' })] })).status).toBe(400); // unknown value
    expect((await as(seller.token).post('/seller/products', { ...base, variants: [row({ Size: 'M', Color: 'Black' }), row({ Size: 'M', Color: 'Black' })] })).status).toBe(400);
    // Marketplace variants still need SKU, MRP and opening stock.
    expect((await as(seller.token).post('/seller/products', { ...base, variants: [{ optionValues: { Size: 'M', Color: 'Black' }, pricePaise: 100 }] })).status).toBe(400);
  });

  it('variants are added, edited, reordered and removed later; prices and stock per variant', async () => {
    const seller = await seedSeller('9550000007');
    const id = await createSimple(seller, 'Atta');
    let view = await product(seller, id);
    const original = view.variants[0]!;

    // Turn the simple item into a "Pack Size" item: the existing variant becomes "1 kg", two new ones added.
    view = expectSuccess<ProductView>(
      (
        await as(seller.token)
          .put(`/seller/products/${id}/variants`, {
            optionGroups: [{ name: 'Pack Size', values: ['500 g', '1 kg', '5 kg'] }],
            variants: [
              { id: original.id, optionValues: { 'Pack Size': '1 kg' }, pricePaise: 5_200, mrpPaise: 6_000, stockQty: 45 },
              { optionValues: { 'Pack Size': '500 g' }, sku: sku(), pricePaise: 2_800, mrpPaise: 3_000, stockQty: 20 },
              { optionValues: { 'Pack Size': '5 kg' }, sku: sku(), pricePaise: 24_000, mrpPaise: 26_000, stockQty: 8 },
            ],
          })
          .expect(200)
      ).body,
    ).data;
    expect(view.variants.map((v) => [v.variantName, v.listing!.pricePaise, v.listing!.stockQty, v.isDefault])).toEqual([
      ['1 kg', 5_200, 45, true],
      ['500 g', 2_800, 20, false],
      ['5 kg', 24_000, 8, false],
    ]);
    // The kept variant's stock change went through the ledger (40 -> 45).
    const kept = await prisma.stockLedger.findMany({ where: { sellerListingId: original.listing!.id }, orderBy: { createdAt: 'asc' } });
    expect(kept.map((l) => l.delta)).toEqual([40, 5]);

    // Reorder + edit + remove "5 kg".
    const [oneKg, half] = view.variants;
    view = expectSuccess<ProductView>(
      (
        await as(seller.token)
          .put(`/seller/products/${id}/variants`, {
            optionGroups: [{ name: 'Pack Size', values: ['500 g', '1 kg'] }],
            variants: [
              { id: half!.id, optionValues: { 'Pack Size': '500 g' }, pricePaise: 2_900, mrpPaise: 3_000, stockQty: 20 },
              { id: oneKg!.id, optionValues: { 'Pack Size': '1 kg' }, pricePaise: 5_200, mrpPaise: 6_000, stockQty: 45 },
            ],
          })
          .expect(200)
      ).body,
    ).data;
    expect(view.variants.map((v) => [v.variantName, v.listing!.pricePaise, v.isDefault])).toEqual([
      ['500 g', 2_900, true],
      ['1 kg', 5_200, false],
    ]);
    const removed = await prisma.productVariant.findFirstOrThrow({ where: { productId: id, variantName: '5 kg' } });
    expect(removed.deletedAt).not.toBeNull();
    // Its name can be used again.
    await as(seller.token)
      .put(`/seller/products/${id}/variants`, {
        optionGroups: [{ name: 'Pack Size', values: ['500 g', '1 kg', '5 kg'] }],
        variants: [
          { id: half!.id, optionValues: { 'Pack Size': '500 g' }, pricePaise: 2_900, mrpPaise: 3_000 },
          { id: oneKg!.id, optionValues: { 'Pack Size': '1 kg' }, pricePaise: 5_200, mrpPaise: 6_000 },
          { optionValues: { 'Pack Size': '5 kg' }, sku: sku(), pricePaise: 23_000, mrpPaise: 26_000, stockQty: 3 },
        ],
      })
      .expect(200);
  });

  it('two variants of one product are two separate cart lines with their own prices', async () => {
    const admin = await loginAdmin();
    await seedStore();
    const seller = await seedSeller('9550000008');
    const id = await createWithOptions(seller, 'Pizza Base', [{ name: 'Size', values: ['Half', 'Full'] }], [
      { values: { Size: 'Half' }, price: 12_000 },
      { values: { Size: 'Full' }, price: 22_000 },
    ]);
    await approve(seller, admin, id);
    const detail = await customerDetail(id);
    expect(detail.optionGroups).toEqual([{ name: 'Size', values: ['Half', 'Full'] }]);
    const half = detail.variants.find((v) => v.optionValues['Size'] === 'Half')!;
    const full = detail.variants.find((v) => v.optionValues['Size'] === 'Full')!;
    expect([half.pricePaise, full.pricePaise]).toEqual([12_000, 22_000]);

    await otpService.clearOtpState('9550009999');
    const customer = await loginAs('9550009999');
    const C = as(customer.accessToken);
    await C.post('/cart/items', { sellerListingId: half.sellerListingId, qty: 1 }).expect(200);
    await C.post('/cart/items', { sellerListingId: full.sellerListingId, qty: 2 }).expect(200);
    const cart = expectSuccess<{ items: { sellerListingId: string; qty: number; unitPricePaise?: number; pricePaise?: number }[] }>((await C.get('/cart').expect(200)).body).data;
    expect(cart.items.map((i) => [i.sellerListingId, i.qty]).sort()).toEqual(
      [
        [half.sellerListingId, 1],
        [full.sellerListingId, 2],
      ].sort(),
    );
  });
});

describe('D. isolation', () => {
  it("seller A can never edit seller B's product, variants or listings", async () => {
    const a = await seedSeller('9550000011');
    const b = await seedSeller('9550000012');
    const id = await createWithOptions(b, 'Shirt', [{ name: 'Size', values: ['M', 'L'] }], [
      { values: { Size: 'M' }, price: 50_000 },
      { values: { Size: 'L' }, price: 55_000 },
    ]);
    const view = await product(b, id);
    const A = as(a.token);
    expect((await A.patch(`/seller/products/${id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await A.put(`/seller/products/${id}/variants`, { optionGroups: [], variants: [{ variantName: 'x', sku: sku(), pricePaise: 1, mrpPaise: 1, stockQty: 1 }] })).status).toBe(404);
    expect((await A.patch(`/seller/listings/${view.variants[0]!.listing!.id}`, { pricePaise: 1 })).status).toBe(404);
    expect((await A.post(`/seller/listings/${view.variants[1]!.listing!.id}/stock-adjust`, { delta: -1 })).status).toBe(404);
    // Seller B cannot slip another product's variant id into its own set either.
    const other = await product(a, await createSimple(a));
    expect(
      (
        await as(b.token).put(`/seller/products/${id}/variants`, {
          optionGroups: [{ name: 'Size', values: ['M'] }],
          variants: [{ id: other.variants[0]!.id, optionValues: { Size: 'M' }, pricePaise: 1, mrpPaise: 2 }],
        })
      ).status,
    ).toBe(404);
    const untouched = await product(b, id);
    expect([untouched.name, untouched.variants.map((v) => v.listing!.pricePaise)]).toEqual(['Shirt', [50_000, 55_000]]);
  });
});

describe('E. approval', () => {
  it('a content edit keeps an approved product live; a NEW variant waits for review without hiding the approved ones', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9550000021');
    const id = await createWithOptions(seller, 'Pizza', [{ name: 'Size', values: ['Half', 'Full'] }], [
      { values: { Size: 'Half' }, price: 12_000 },
      { values: { Size: 'Full' }, price: 22_000 },
    ]);
    await approve(seller, admin, id);
    await as(seller.token).patch(`/seller/products/${id}`, { name: 'Pizza Margherita' }).expect(200);
    expect((await customerDetail(id)).variants).toHaveLength(2);

    // Add "Family" to the approved product.
    const view = await product(seller, id);
    const set = {
      optionGroups: [{ name: 'Size', values: ['Half', 'Full', 'Family'] }],
      variants: [
        ...view.variants.map((v) => ({ id: v.id, optionValues: v.optionValues, pricePaise: v.listing!.pricePaise, mrpPaise: v.listing!.mrpPaise })),
        { optionValues: { Size: 'Family' }, sku: sku(), pricePaise: 32_000, mrpPaise: 33_000, stockQty: 4 },
      ],
    };
    const after = expectSuccess<ProductView>((await as(seller.token).put(`/seller/products/${id}/variants`, set).expect(200)).body).data;
    expect(after.approvalStatus).toBe('APPROVED');
    expect(after.variants.map((v) => [v.variantName, v.approvalStatus])).toEqual([
      ['Half', 'APPROVED'],
      ['Full', 'APPROVED'],
      ['Family', 'PENDING'],
    ]);
    // Customers keep buying Half / Full; Family is hidden until reviewed.
    expect((await customerDetail(id)).variants.map((v) => v.variantName).sort()).toEqual(['Full', 'Half']);

    // Submitted through the SAME batch flow; the product stays APPROVED meanwhile.
    const batch = expectSuccess<{ id: string }>((await as(seller.token).post('/seller/approval-batches', { productIds: [id] }).expect(201)).body).data;
    expect((await prisma.product.findUniqueOrThrow({ where: { id } })).approvalStatus).toBe('APPROVED');
    expect((await customerDetail(id)).variants).toHaveLength(2);
    // Options are locked while that review is open.
    expect((await as(seller.token).put(`/seller/products/${id}/variants`, set)).status).toBe(409);
    // Admin sees the variants with prices and review state.
    const rows = expectSuccess<{ items: { variants: { variantName: string; approvalStatus: string; pricePaise: number }[] }[] }>(
      (await as(admin).get(`/admin/approval-batches/${batch.id}/products`).expect(200)).body,
    ).data.items;
    expect(rows[0]!.variants.map((v) => [v.variantName, v.approvalStatus, v.pricePaise])).toEqual([
      ['Half', 'APPROVED', 12_000],
      ['Full', 'APPROVED', 22_000],
      ['Family', 'PENDING', 32_000],
    ]);
    await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);
    expect((await customerDetail(id)).variants.map((v) => v.variantName).sort()).toEqual(['Family', 'Full', 'Half']);
  });

  it('rejecting a new variant leaves the product and its approved variants live', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9550000022');
    const id = await createSimple(seller, 'Paneer');
    await approve(seller, admin, id);
    const view = await product(seller, id);
    await as(seller.token)
      .put(`/seller/products/${id}/variants`, {
        optionGroups: [{ name: 'Pack Size', values: ['200 g', '1 kg'] }],
        variants: [
          { id: view.variants[0]!.id, optionValues: { 'Pack Size': '200 g' }, pricePaise: 5_000, mrpPaise: 6_000 },
          { optionValues: { 'Pack Size': '1 kg' }, sku: sku(), pricePaise: 22_000, mrpPaise: 25_000, stockQty: 5 },
        ],
      })
      .expect(200);
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>((await as(seller.token).post('/seller/approval-batches', {}).expect(201)).body).data;
    await as(admin).patch(`/admin/approval-batches/${batch.id}/items/${batch.items[0]!.id}`, { status: 'REJECTED', reviewNote: 'Wrong photo for 1 kg' }).expect(200);

    const after = await product(seller, id);
    expect(after.approvalStatus).toBe('APPROVED');
    expect(after.variants.map((v) => [v.variantName, v.approvalStatus])).toEqual([
      ['200 g', 'APPROVED'],
      ['1 kg', 'REJECTED'],
    ]);
    expect((await customerDetail(id)).variants.map((v) => v.variantName)).toEqual(['200 g']);
  });

  it('variants of a product not yet approved are reviewed together with it', async () => {
    const admin = await loginAdmin();
    const seller = await seedSeller('9550000023');
    const id = await createWithOptions(seller, 'Jeans', [{ name: 'Size', values: ['30', '32'] }], [
      { values: { Size: '30' }, price: 99_900 },
      { values: { Size: '32' }, price: 99_900 },
    ]);
    expect((await product(seller, id)).variants.every((v) => v.approvalStatus === 'APPROVED')).toBe(true);
    expect((await api().get(`/api/v1/products/${id}`)).status).toBe(404);
    await approve(seller, admin, id);
    expect((await customerDetail(id)).variants).toHaveLength(2);
  });
});

describe('F. order history', () => {
  it('editing or removing a variant later never changes a placed order', async () => {
    const admin = await loginAdmin();
    await seedStore();
    const seller = await seedSeller('9550000031');
    const id = await createWithOptions(seller, 'Cold Coffee', [{ name: 'Size', values: ['Regular', 'Large'] }], [
      { values: { Size: 'Regular' }, price: 9_000 },
      { values: { Size: 'Large' }, price: 13_000 },
    ]);
    await approve(seller, admin, id);
    const large = (await customerDetail(id)).variants.find((v) => v.variantName === 'Large')!;

    await otpService.clearOtpState('9550009998');
    const customer = await loginAs('9550009998');
    const addressId = await seedAddress(customer.userId);
    await as(customer.accessToken).post('/cart/items', { sellerListingId: large.sellerListingId, qty: 1 }).expect(200);
    await api().post('/api/v1/orders').set('Authorization', bearer(customer.accessToken)).set('Idempotency-Key', randomUUID()).send({ addressId, paymentMethod: PaymentMethod.COD }).expect(201);

    // Seller renames the product, reprices and then removes "Large".
    await as(seller.token).patch(`/seller/products/${id}`, { name: 'Iced Coffee' }).expect(200);
    const view = await product(seller, id);
    const regular = view.variants.find((v) => v.variantName === 'Regular')!;
    await as(seller.token)
      .put(`/seller/products/${id}/variants`, {
        optionGroups: [{ name: 'Size', values: ['Regular'] }],
        variants: [{ id: regular.id, optionValues: { Size: 'Regular' }, pricePaise: 9_500, mrpPaise: 10_000 }],
      })
      .expect(200);

    const item = await prisma.orderItem.findFirstOrThrow({ where: { sellerListingId: large.sellerListingId } });
    expect([item.productName, item.variantName, item.unitPricePaise]).toEqual(['Cold Coffee', 'Large', 13_000]);
    // The removed variant row still exists (soft delete) for history.
    expect(await prisma.productVariant.count({ where: { id: large.id } })).toBe(1);
    expect(expectError((await as(seller.token).get('/seller/products/00000000-0000-0000-0000-000000000000')).body).code).toBe('NOT_FOUND');
  });
});
