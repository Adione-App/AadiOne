/**
 * Seller product approval — complete products, ONE batch per "Submit for
 * Approval", and a one-click batch approval.
 *
 *   1. The seller creates COMPLETE products: details, its own category, SKU,
 *      AND its own listing (MRP, selling price, opening stock) in one call.
 *      They wait as drafts — invisible to customers — for as long as it likes.
 *   2. "Submit for Approval" (POST /seller/approval-batches, empty body) puts
 *      every complete, never-submitted product into ONE batch.
 *   3. Admin sees the batch as one compact item (counts + a paged product
 *      table) and approves it with ONE action. Approval never touches the
 *      seller's price or stock; it only makes the products live.
 *
 * Replaces the earlier per-product flow (create → submit each → approve →
 * only then set price and stock), which no longer exists.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ErrorCode,
  NotificationType,
  SellerType,
  UnitType,
  UserRole,
  type ApproveProductBatchResultDto,
  type CategoryDto,
  type CursorPage,
  type ProductApprovalBatchProductsPageDto,
  type ProductApprovalBatchSummaryDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { createSellerProduct } from '../../src/modules/catalog/product-approval.service';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: { mobile: '0000000001', email: ADMIN.email, fullName: 'Admin', passwordHash: await hashPassword(ADMIN.password), role: UserRole.ADMIN },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

interface Seller {
  id: string;
  token: string;
  top: string;
  sub: string;
}

/** An ACTIVE grocery seller with an OWNER login and its own "Grocery › Rice". */
async function seedSeller(mobile: string, name: string): Promise<Seller> {
  const seller = await prisma.seller.create({
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
      ...sellerLifecycleFields('APPROVED'),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  const token = (await loginAs(mobile)).accessToken;

  const tree = expectSuccess<{ categories: { id: string; name: string }[] }>(
    (await api().post('/api/v1/seller/categories').set('Authorization', bearer(token)).send({ name: 'Grocery' }).expect(201)).body,
  ).data;
  const top = tree.categories[0]!.id;
  const sub = expectSuccess<{ id: string }>(
    (await api().post('/api/v1/seller/subcategories').set('Authorization', bearer(token)).send({ parentId: top, name: 'Rice' }).expect(201)).body,
  ).data.id;
  return { id: seller.id, token, top, sub };
}

function productBody(categoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    categoryId,
    name: `Product ${randomUUID().slice(0, 6)}`,
    sku: `SKU-${randomUUID().slice(0, 10).toUpperCase()}`,
    variantName: '1 kg',
    unit: UnitType.KG,
    unitValue: 1,
    mrpPaise: 12_000,
    pricePaise: 10_000,
    stockQty: 25,
    ...overrides,
  };
}

const as = (token: string) => ({
  createProduct: (body: object) => api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(body),
  submit: (body: object = {}) => api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(token)).send(body),
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  patch: (path: string, body: object) => api().patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
});

async function createProduct(seller: Seller, overrides: Record<string, unknown> = {}) {
  const res = await as(seller.token).createProduct(productBody(seller.sub, overrides)).expect(201);
  return expectSuccess<{ id: string; variantId: string; listingId: string }>(res.body).data;
}

async function adminBatches(adminToken: string, query = '') {
  return expectSuccess<CursorPage<ProductApprovalBatchSummaryDto>>(
    (await as(adminToken).get(`/admin/approval-batches${query}`).expect(200)).body,
  ).data;
}

async function customerCatalogue(): Promise<CategoryDto[]> {
  return expectSuccess<CategoryDto[]>((await api().get('/api/v1/categories?includeChildren=true&withCounts=true').expect(200)).body).data;
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

/* -------------------------------------------------------------------------- */

describe('complete product creation (price and stock before approval)', () => {
  it('creates the product, variant and the seller’s own listing together — PENDING and invisible to customers', async () => {
    const seller = await seedSeller('9700000001', 'Complete Seller');
    const created = await createProduct(seller, { mrpPaise: 15_000, pricePaise: 13_500, stockQty: 40 });

    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.id } });
    expect(product).toMatchObject({ approvalStatus: 'PENDING', submittedBySellerId: seller.id, status: 'ACTIVE' });
    expect(await prisma.sellerListing.findUniqueOrThrow({ where: { id: created.listingId } })).toMatchObject({
      sellerId: seller.id,
      variantId: created.variantId,
      mrpPaise: 15_000,
      pricePaise: 13_500,
      stockQty: 40,
      isAvailable: true,
    });
    expect(await prisma.stockLedger.findMany({ where: { sellerListingId: created.listingId } })).toEqual([
      expect.objectContaining({ delta: 40, balanceAfter: 40, note: 'Opening stock' }),
    ]);

    // Not sellable until approved.
    const own = expectSuccess<{ id: string; visibility: { sellable: boolean; reason: string } }[]>(
      (await as(seller.token).get('/seller/products').expect(200)).body,
    ).data;
    expect(own[0]!.visibility).toMatchObject({ sellable: false, reason: 'PENDING_APPROVAL' });
    expect(await customerCatalogue()).toEqual([]);
    await otpService.clearOtpState('9700000099');
    const customer = await loginAs('9700000099');
    const cart = await as(customer.accessToken).post('/cart/items', { sellerListingId: created.listingId, qty: 1 });
    expect(cart.status).not.toBe(200);
  });

  it('keeps the existing validation: price/stock required, price ≤ MRP, stock limit, SKU unique, own category only', async () => {
    const seller = await seedSeller('9700000002', 'Validation Seller');
    const other = await seedSeller('9700000003', 'Other Seller');
    const { mrpPaise: _m, pricePaise: _p, stockQty: _s, ...withoutListing } = productBody(seller.sub);

    expect((await as(seller.token).createProduct(withoutListing)).status).toBe(400);
    expect((await as(seller.token).createProduct(productBody(seller.sub, { pricePaise: 20_000, mrpPaise: 10_000 }))).status).toBe(400);
    expect((await as(seller.token).createProduct(productBody(seller.sub, { stockQty: -1 }))).status).toBe(400);
    expect((await as(seller.token).createProduct(productBody(seller.sub, { stockQty: 100_001 }))).status).toBe(400);
    expect((await as(seller.token).createProduct(productBody(other.sub)))).toMatchObject({ status: 404 });

    await createProduct(seller, { sku: 'DUP-SKU-1' });
    expect((await as(seller.token).createProduct(productBody(seller.sub, { sku: 'dup-sku-1' }))).status).toBe(409);
    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id } })).toBe(1);
    expect(await prisma.sellerListing.count({ where: { sellerId: seller.id } })).toBe(1);
  });

  it('a draft’s details, price and stock can be corrected before submission', async () => {
    const seller = await seedSeller('9700000004', 'Editing Seller');
    const created = await createProduct(seller);

    await as(seller.token)
      .patch(`/seller/products/${created.id}`, { name: 'Basmati Rice 1kg', mrpPaise: 20_000, pricePaise: 18_000, stockQty: 60 })
      .expect(200);

    expect((await prisma.product.findUniqueOrThrow({ where: { id: created.id } })).name).toBe('Basmati Rice 1kg');
    expect(await prisma.sellerListing.findUniqueOrThrow({ where: { id: created.listingId } })).toMatchObject({
      mrpPaise: 20_000,
      pricePaise: 18_000,
      stockQty: 60,
    });
    expect((await as(seller.token).patch(`/seller/products/${created.id}`, { pricePaise: 25_000 })).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

describe('Submit for Approval — one batch for everything ready', () => {
  it('submits 100 complete products once: one batch, 100 items, nothing submitted twice', async () => {
    const seller = await seedSeller('9700000011', 'Bulk Seller');
    const started = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      ids.push((await createProduct(seller, { categoryId: i % 2 === 0 ? seller.sub : seller.top })).id);
    }
    const createMs = Date.now() - started;

    const submitStarted = Date.now();
    const res = await as(seller.token).submit().expect(201);
    const submitMs = Date.now() - submitStarted;
    const batch = expectSuccess<{ id: string; status: string; items: { productId: string }[] }>(res.body).data;
    expect(batch.status).toBe('PENDING');
    expect(batch.items.map((i) => i.productId).sort()).toEqual([...ids].sort());
    expect(await prisma.productApprovalBatch.count()).toBe(1);
    expect(await prisma.productApprovalBatchItem.count()).toBe(100);
    // eslint-disable-next-line no-console
    console.info(`[batch] created 100 complete products in ${createMs} ms; one submission in ${submitMs} ms`);

    // Nothing left: a second click submits nothing and creates no batch.
    const again = await as(seller.token).submit();
    expect(again.status).toBe(400);
    expect(expectError(again.body).message).toMatch(/already been submitted/);
    expect(await prisma.productApprovalBatch.count()).toBe(1);

    // New drafts later go into a NEW batch — only them.
    const later = await createProduct(seller);
    const second = expectSuccess<{ items: { productId: string }[] }>((await as(seller.token).submit().expect(201)).body).data;
    expect(second.items.map((i) => i.productId)).toEqual([later.id]);
  });

  it('Submit Selected: 120 ticked products go in one batch; unticked drafts stay drafts; approved ones are refused', async () => {
    const seller = await seedSeller('9700000017', 'Selecting Seller');
    // Created through the same service the create route calls (the route's
    // per-IP rate limit would otherwise trip within one test file).
    const owner = await prisma.user.findFirstOrThrow({ where: { mobile: '9700000017' } });
    const ids: string[] = [];
    for (let i = 0; i < 130; i += 1) {
      ids.push((await createSellerProduct(seller.id, productBody(seller.sub), owner.id)).id);
    }
    const chosen = ids.slice(0, 120);

    const submitStarted = Date.now();
    const res = await as(seller.token).submit({ productIds: chosen }).expect(201);
    const submitMs = Date.now() - submitStarted;
    const batch = expectSuccess<{ id: string; items: { productId: string }[] }>(res.body).data;
    expect(batch.items.map((i) => i.productId).sort()).toEqual([...chosen].sort());
    expect(await prisma.productApprovalBatchItem.count()).toBe(120);
    // eslint-disable-next-line no-console
    console.info(`[batch] one explicit submission of 120 selected products in ${submitMs} ms`);

    // The 10 unticked products are untouched drafts, still ready for a later submission.
    const rest = await prisma.product.findMany({ where: { id: { in: ids.slice(120) } }, include: { approvalBatchItems: true } });
    expect(rest.every((p) => p.approvalStatus === 'PENDING' && p.approvalBatchItems.length === 0)).toBe(true);

    // Pending (in review) products are refused.
    expect((await as(seller.token).submit({ productIds: [chosen[0]!] })).status).toBe(409);

    // Approved products are refused too, and stay approved.
    const admin = await loginAdmin();
    await as(admin).post(`/admin/approval-batches/${batch.id}/approve`).expect(200);
    const approved = await as(seller.token).submit({ productIds: [chosen[0]!, ids[125]!] });
    expect(approved.status).toBe(400);
    expect(await prisma.productApprovalBatch.count()).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: chosen[0]! } })).approvalStatus).toBe('APPROVED');
  });

  it('two simultaneous submissions never put a product into two batches', async () => {
    const seller = await seedSeller('9700000012', 'Race Seller');
    for (let i = 0; i < 20; i += 1) await createProduct(seller);

    const results = await Promise.all([as(seller.token).submit(), as(seller.token).submit()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await prisma.productApprovalBatch.count()).toBe(1);
    const perProduct = await prisma.productApprovalBatchItem.groupBy({ by: ['productId'], _count: { _all: true } });
    expect(perProduct).toHaveLength(20);
    expect(perProduct.every((row) => row._count._all === 1)).toBe(true);
  });

  it('an incomplete product (no price/stock yet) is never submitted until the seller completes it', async () => {
    const seller = await seedSeller('9700000013', 'Incomplete Seller');
    // A product saved before price/stock were part of the form: no listing.
    const legacy = await prisma.product.create({
      data: {
        name: 'Legacy Draft',
        slug: `legacy-${randomUUID().slice(0, 6)}`,
        categoryId: seller.sub,
        status: 'ACTIVE',
        approvalStatus: 'PENDING',
        submittedBySellerId: seller.id,
        searchKeywords: [],
        variants: { create: { sku: `LEG-${randomUUID().slice(0, 6)}`, variantName: '1 kg', unit: 'KG', unitValue: 1, isDefault: true } },
      },
    });

    const none = await as(seller.token).submit();
    expect(none.status).toBe(400);
    expect(expectError(none.body).message).toMatch(/needs a price and stock/);
    expect((await as(seller.token).submit({ productIds: [legacy.id] })).status).toBe(400);

    await as(seller.token).patch(`/seller/products/${legacy.id}`, { mrpPaise: 9_000, pricePaise: 8_000, stockQty: 5 }).expect(200);
    const batch = expectSuccess<{ items: { productId: string }[] }>((await as(seller.token).submit().expect(201)).body).data;
    expect(batch.items.map((i) => i.productId)).toEqual([legacy.id]);
  });

  it('explicit submissions keep the duplicate, approved and ownership guards', async () => {
    const a = await seedSeller('9700000014', 'Seller A');
    const b = await seedSeller('9700000015', 'Seller B');
    const product = await createProduct(a);
    await as(a.token).submit().expect(201);

    const duplicate = await as(a.token).submit({ productIds: [product.id] });
    expect(duplicate.status).toBe(409);
    expect((await as(a.token).submit({ productIds: [product.id, product.id] })).status).toBe(400);

    const foreign = await as(b.token).submit({ productIds: [product.id] });
    expect(foreign.status).toBe(404);
    expect(expectError(foreign.body).code).toBe(ErrorCode.NOT_FOUND);
    // B's own "submit all" never picks up A's products.
    expect((await as(b.token).submit()).status).toBe(400);
    expect(await prisma.productApprovalBatchItem.count({ where: { productId: product.id } })).toBe(1);
  });

  it('a product under review cannot be edited; its price and stock remain the seller’s to manage', async () => {
    const seller = await seedSeller('9700000016', 'Review Edit Seller');
    const product = await createProduct(seller);
    await as(seller.token).submit().expect(201);

    expect((await as(seller.token).patch(`/seller/products/${product.id}`, { name: 'Changed Under Review' })).status).toBe(409);
    await as(seller.token).patch(`/seller/listings/${product.listingId}`, { stockQty: 30 }).expect(200);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: product.listingId } })).stockQty).toBe(30);
  });
});

/* -------------------------------------------------------------------------- */

describe('admin batch review', () => {
  it('shows ONE compact batch with counts, and its products as a paged summary table', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000021', 'ABC Grocery');
    for (let i = 0; i < 60; i += 1) await createProduct(seller, { categoryId: i < 30 ? seller.sub : seller.top });
    const batchId = expectSuccess<{ id: string }>((await as(seller.token).submit().expect(201)).body).data.id;

    const list = await adminBatches(adminToken, '?status=PENDING');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: batchId,
      sellerName: 'ABC Grocery',
      sellerType: 'GROCERY',
      status: 'PENDING',
      itemCount: 60,
      pendingCount: 60,
      approvedCount: 0,
      rejectedCount: 0,
      categoryCount: 2,
    });
    expect(list.items[0]).not.toHaveProperty('items');

    const page = expectSuccess<ProductApprovalBatchProductsPageDto>(
      (await as(adminToken).get(`/admin/approval-batches/${batchId}/products?offset=50&limit=50`).expect(200)).body,
    ).data;
    expect(page.total).toBe(60);
    expect(page.items).toHaveLength(10);
    expect(page.items[0]).toMatchObject({
      itemStatus: 'PENDING',
      category: 'Grocery',
      mrpPaise: 12_000,
      pricePaise: 10_000,
      stockQty: 25,
      variantName: '1 kg',
      removed: false,
    });
    expect(page.items[0]!.sku).toMatch(/^SKU-/);
    // Rows follow the products' creation order: the first 30 sit in Rice.
    const all = expectSuccess<ProductApprovalBatchProductsPageDto>(
      (await as(adminToken).get(`/admin/approval-batches/${batchId}/products?limit=200`).expect(200)).body,
    ).data.items;
    expect(all.slice(0, 30).every((row) => row.category === 'Grocery' && row.subcategory === 'Rice')).toBe(true);
    expect(all.slice(30).every((row) => row.category === 'Grocery' && row.subcategory === null)).toBe(true);
    expect((await as(adminToken).get(`/admin/approval-batches/${batchId}/products?limit=201`)).status).toBe(400);
  });

  it('approves the whole batch in one action: all products live, price and stock untouched', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000022', 'Approve Seller');
    const products = [];
    for (let i = 0; i < 25; i += 1) products.push(await createProduct(seller, { pricePaise: 10_000 + i, stockQty: 10 + i }));
    const batchId = expectSuccess<{ id: string }>((await as(seller.token).submit().expect(201)).body).data.id;
    const listingsBefore = await prisma.sellerListing.findMany({ where: { sellerId: seller.id }, orderBy: { id: 'asc' } });

    const result = expectSuccess<ApproveProductBatchResultDto>(
      (await as(adminToken).post(`/admin/approval-batches/${batchId}/approve`).expect(200)).body,
    ).data;
    expect(result).toMatchObject({ approvedCount: 25, removedCount: 0 });
    expect(result.batch).toMatchObject({ status: 'APPROVED', approvedCount: 25, pendingCount: 0 });

    expect(await prisma.product.count({ where: { submittedBySellerId: seller.id, approvalStatus: 'APPROVED' } })).toBe(25);
    expect(await prisma.productApprovalBatchItem.count({ where: { batchId, status: 'APPROVED' } })).toBe(25);
    // The seller's numbers are exactly as entered.
    expect(await prisma.sellerListing.findMany({ where: { sellerId: seller.id }, orderBy: { id: 'asc' } })).toEqual(listingsBefore);

    // Live: in the marketplace and orderable.
    const catalogue = await customerCatalogue();
    expect(catalogue.map((c) => [c.name, c.productCount])).toEqual([['Grocery', 25]]);
    await otpService.clearOtpState('9700000098');
    const customer = await loginAs('9700000098');
    await as(customer.accessToken).post('/cart/items', { sellerListingId: products[0]!.listingId, qty: 1 }).expect(200);

    // One notice for the batch, not 25.
    expect(await prisma.notification.count({ where: { type: NotificationType.SELLER_PRODUCT_APPROVED } })).toBe(1);

    // Decided once.
    const twice = await as(adminToken).post(`/admin/approval-batches/${batchId}/approve`);
    expect(twice.status).toBe(409);
    expect(expectError(twice.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });

  it('per-item rejection still works alongside batch approval; a fixed product is resubmitted and approved', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000023', 'Mixed Seller');
    const keep = await createProduct(seller);
    const bad = await createProduct(seller);
    const gone = await createProduct(seller);
    const submitted = expectSuccess<{ id: string; items: { id: string; productId: string }[] }>((await as(seller.token).submit().expect(201)).body).data;
    const badItem = submitted.items.find((i) => i.productId === bad.id)!;

    expect((await as(adminToken).patch(`/admin/approval-batches/${submitted.id}/items/${badItem.id}`, { status: 'REJECTED' })).status).toBe(400);
    await as(adminToken)
      .patch(`/admin/approval-batches/${submitted.id}/items/${badItem.id}`, { status: 'REJECTED', reviewNote: 'Blurry photo' })
      .expect(200);
    // The seller removed one product meanwhile.
    await prisma.product.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const result = expectSuccess<ApproveProductBatchResultDto>(
      (await as(adminToken).post(`/admin/approval-batches/${submitted.id}/approve`).expect(200)).body,
    ).data;
    expect(result).toMatchObject({ approvedCount: 1, removedCount: 1 });
    expect(result.batch).toMatchObject({ status: 'REJECTED', approvedCount: 1, rejectedCount: 2, pendingCount: 0 });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: keep.id } })).approvalStatus).toBe('APPROVED');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: bad.id } })).approvalStatus).toBe('REJECTED');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: gone.id } })).approvalStatus).toBe('PENDING');

    // Rejected → corrected → resubmitted (explicitly; "submit all" never
    // resubmits a rejected product on its own) → approved.
    expect((await as(seller.token).submit()).status).toBe(400);
    await as(seller.token).patch(`/seller/products/${bad.id}`, { name: 'Clear Photo Product' }).expect(200);
    const resubmitted = expectSuccess<{ id: string }>((await as(seller.token).submit({ productIds: [bad.id] }).expect(201)).body).data;
    await as(adminToken).post(`/admin/approval-batches/${resubmitted.id}/approve`).expect(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: bad.id } })).approvalStatus).toBe(ApprovalStatus.APPROVED);
  });

  it('approved products can no longer be edited by the seller, but price and stock stay seller-controlled', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000024', 'Post Approval Seller');
    const product = await createProduct(seller);
    const batchId = expectSuccess<{ id: string }>((await as(seller.token).submit().expect(201)).body).data.id;
    await as(adminToken).post(`/admin/approval-batches/${batchId}/approve`).expect(200);

    expect((await as(seller.token).patch(`/seller/products/${product.id}`, { name: 'Renamed' })).status).toBe(409);
    await as(seller.token).patch(`/seller/listings/${product.listingId}`, { pricePaise: 9_500 }).expect(200);
    expect((await prisma.sellerListing.findUniqueOrThrow({ where: { id: product.listingId } })).pricePaise).toBe(9_500);
  });

  it('only admin reviews: sellers and customers cannot list, read, approve or decide batches', async () => {
    const seller = await seedSeller('9700000025', 'No Admin Seller');
    await createProduct(seller);
    const batchId = expectSuccess<{ id: string }>((await as(seller.token).submit().expect(201)).body).data.id;
    await otpService.clearOtpState('9700000097');
    const customer = (await loginAs('9700000097')).accessToken;

    for (const token of [seller.token, customer]) {
      expect((await as(token).get('/admin/approval-batches')).status).toBe(403);
      expect((await as(token).get(`/admin/approval-batches/${batchId}/products`)).status).toBe(403);
      expect((await as(token).post(`/admin/approval-batches/${batchId}/approve`)).status).toBe(403);
    }
    expect(await prisma.productApprovalBatch.findUniqueOrThrow({ where: { id: batchId } })).toMatchObject({ status: 'PENDING' });

    // A seller sees only its own batches, as summaries.
    const b = await seedSeller('9700000026', 'Seller B');
    expect((await as(b.token).get(`/seller/approval-batches/${batchId}`)).status).toBe(404);
    const own = expectSuccess<CursorPage<ProductApprovalBatchSummaryDto>>((await as(seller.token).get('/seller/approval-batches').expect(200)).body).data;
    expect(own.items.map((i) => [i.id, i.itemCount])).toEqual([[batchId, 1]]);
  });
});
