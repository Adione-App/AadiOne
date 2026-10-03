/**
 * Product Approval Batch — seller submits, admin reviews, and only an
 * APPROVED product may back a SellerListing.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ErrorCode,
  ProductStatus,
  UnitType,
  UserRole,
  type ProductApprovalBatchReviewDto,
  type SellerProductDto,
} from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: {
      mobile: '0000000001',
      email: ADMIN.email,
      fullName: 'Admin',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

async function seedSellerWithOwner(mobile: string, name: string): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name,
      isPlatformOwned: false,
      addressLine: 'Test Address',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
    },
  });
  const user = await prisma.user.create({
    data: { mobile, fullName: `${name} Owner`, role: UserRole.SELLER_OWNER },
  });
  await prisma.sellerStaff.create({
    data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true },
  });
  return seller.id;
}

async function seedCategory(): Promise<string> {
  const slug = `cat-${randomUUID().slice(0, 8)}`;
  const category = await prisma.category.create({
    data: { name: slug, slug, path: slug, depth: 0, isActive: true },
  });
  return category.id;
}

async function loginSeller(mobile: string): Promise<string> {
  await otpService.clearOtpState(mobile);
  const session = await loginAs(mobile);
  return session.accessToken;
}

function productBody(categoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    categoryId,
    name: `Test Product ${randomUUID().slice(0, 6)}`,
    sku: `SKU-${randomUUID().slice(0, 8).toUpperCase()}`,
    variantName: '1 kg',
    unit: UnitType.KG,
    unitValue: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('seller product submission', () => {
  it('creates a product as PENDING, owned by the submitting seller', async () => {
    const sellerId = await seedSellerWithOwner('9600000001', 'Seller A');
    const categoryId = await seedCategory();
    const token = await loginSeller('9600000001');

    const res = await api()
      .post('/api/v1/seller/products')
      .set('Authorization', bearer(token))
      .send(productBody(categoryId))
      .expect(201);

    const { id } = expectSuccess<{ id: string; variantId: string }>(res.body).data;
    const product = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect(product.approvalStatus).toBe(ApprovalStatus.PENDING);
    expect(product.submittedBySellerId).toBe(sellerId);
  });

  it('submits a batch of its own products and creates one PENDING item per product', async () => {
    const categoryId = await seedCategory();
    const token = await loginSeller('9600000002');

    const p1 = await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(productBody(categoryId)).expect(201);
    const p2 = await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(productBody(categoryId)).expect(201);
    const id1 = expectSuccess<{ id: string }>(p1.body).data.id;
    const id2 = expectSuccess<{ id: string }>(p2.body).data.id;

    const res = await api()
      .post('/api/v1/seller/approval-batches')
      .set('Authorization', bearer(token))
      .send({ productIds: [id1, id2] })
      .expect(201);

    const batch = expectSuccess<{ id: string; status: string; items: { productId: string; status: string }[] }>(res.body).data;
    expect(batch.status).toBe(ApprovalStatus.PENDING);
    expect(batch.items).toHaveLength(2);
    expect(batch.items.every((i) => i.status === ApprovalStatus.PENDING)).toBe(true);
  });

  it('rejects a duplicate submission while an item is still pending review', async () => {
    const categoryId = await seedCategory();
    const token = await loginSeller('9600000003');
    const p = await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(productBody(categoryId)).expect(201);
    const id = expectSuccess<{ id: string }>(p.body).data.id;

    await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(token)).send({ productIds: [id] }).expect(201);

    const res = await api()
      .post('/api/v1/seller/approval-batches')
      .set('Authorization', bearer(token))
      .send({ productIds: [id] });

    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await prisma.productApprovalBatchItem.count({ where: { productId: id } })).toBe(1);
  });

  it("refuses to submit another seller's product (isolation)", async () => {
    const categoryId = await seedCategory();
    const tokenA = await loginSeller('9600000004');
    const p = await api().post('/api/v1/seller/products').set('Authorization', bearer(tokenA)).send(productBody(categoryId)).expect(201);
    const id = expectSuccess<{ id: string }>(p.body).data.id;

    await seedSellerWithOwner('9600000005', 'Seller B');
    const tokenB = await loginSeller('9600000005');

    const res = await api()
      .post('/api/v1/seller/approval-batches')
      .set('Authorization', bearer(tokenB))
      .send({ productIds: [id] });

    expect(res.status).toBe(404);
    expect(expectError(res.body).code).toBe(ErrorCode.NOT_FOUND);
  });

  it("cannot view another seller's approval batch", async () => {
    const categoryId = await seedCategory();
    const tokenA = await loginSeller('9600000006');
    const p = await api().post('/api/v1/seller/products').set('Authorization', bearer(tokenA)).send(productBody(categoryId)).expect(201);
    const id = expectSuccess<{ id: string }>(p.body).data.id;
    const submitted = await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(tokenA)).send({ productIds: [id] }).expect(201);
    const batchId = expectSuccess<{ id: string }>(submitted.body).data.id;

    await seedSellerWithOwner('9600000007', 'Seller B');
    const tokenB = await loginSeller('9600000007');

    const res = await api()
      .get(`/api/v1/seller/approval-batches/${batchId}`)
      .set('Authorization', bearer(tokenB));

    expect(res.status).toBe(404);
  });

  it('a customer cannot access seller approval endpoints', async () => {
    const categoryId = await seedCategory();
    await otpService.clearOtpState('9600000008');
    const customer = await loginAs('9600000008');

    const res = await api()
      .post('/api/v1/seller/products')
      .set('Authorization', bearer(customer.accessToken))
      .send(productBody(categoryId));

    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('admin review', () => {
  async function submitOneProduct(mobile: string, sellerName: string) {
    const sellerId = await seedSellerWithOwner(mobile, sellerName);
    const categoryId = await seedCategory();
    const token = await loginSeller(mobile);
    const p = await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(productBody(categoryId)).expect(201);
    const productId = expectSuccess<{ id: string }>(p.body).data.id;
    const submitted = await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(token)).send({ productIds: [productId] }).expect(201);
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>(submitted.body).data;
    return { sellerId, productId, batchId: batch.id, itemId: batch.items[0]!.id, sellerToken: token };
  }

  it('admin approves an item, which approves the product and the batch', async () => {
    const adminToken = await loginAdmin();
    const { productId, batchId, itemId } = await submitOneProduct('9600000010', 'Seller Approve');

    const res = await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    const batch = expectSuccess<{ status: string; items: { status: string }[] }>(res.body).data;
    expect(batch.status).toBe(ApprovalStatus.APPROVED);
    expect(batch.items[0]!.status).toBe(ApprovalStatus.APPROVED);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.approvalStatus).toBe(ApprovalStatus.APPROVED);
  });

  it('admin rejects an item with a reason, which rejects the product and the batch', async () => {
    const adminToken = await loginAdmin();
    const { productId, batchId, itemId } = await submitOneProduct('9600000011', 'Seller Reject');

    const res = await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reviewNote: 'Image quality too low.' })
      .expect(200);

    const batch = expectSuccess<{ status: string }>(res.body).data;
    expect(batch.status).toBe(ApprovalStatus.REJECTED);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.approvalStatus).toBe(ApprovalStatus.REJECTED);
  });

  it('requires a reason to reject', async () => {
    const adminToken = await loginAdmin();
    const { batchId, itemId } = await submitOneProduct('9600000012', 'Seller NoReason');

    const res = await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED' });

    expect(res.status).toBe(400);
  });

  it('rejects a duplicate decision on an already-decided item (both directions)', async () => {
    const adminToken = await loginAdmin();
    const { batchId, itemId } = await submitOneProduct('9600000013', 'Seller Dup');

    await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    // duplicate approval
    const dup = await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' });
    expect(dup.status).toBe(409);
    expect(expectError(dup.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);

    // APPROVED -> REJECTED is equally illegal once decided
    const flip = await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reviewNote: 'changed my mind' });
    expect(flip.status).toBe(409);
    expect(expectError(flip.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });

  it('a resubmitted (previously rejected) product can be re-reviewed and approved', async () => {
    const adminToken = await loginAdmin();
    const { productId, batchId, itemId, sellerToken } = await submitOneProduct('9600000014', 'Seller Resubmit');

    await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reviewNote: 'fix the photo' })
      .expect(200);

    // A brand new batch, not a revival of the old item.
    const resubmitted = await api()
      .post('/api/v1/seller/approval-batches')
      .set('Authorization', bearer(sellerToken))
      .send({ productIds: [productId] })
      .expect(201);
    const newBatch = expectSuccess<{ id: string; items: { id: string; status: string }[] }>(resubmitted.body).data;
    expect(newBatch.items[0]!.status).toBe(ApprovalStatus.PENDING);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.approvalStatus).toBe(ApprovalStatus.PENDING); // back under review, not silently APPROVED

    await api()
      .patch(`/api/v1/admin/approval-batches/${newBatch.id}/items/${newBatch.items[0]!.id}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    const finalProduct = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(finalProduct.approvalStatus).toBe(ApprovalStatus.APPROVED);
  });

  it('admin can add an eligible, unbatched product to an existing open batch', async () => {
    const adminToken = await loginAdmin();
    const { sellerId, batchId } = await submitOneProduct('9600000015', 'Seller AddItem');

    // A second product from the SAME seller, created but not yet submitted.
    const categoryId = await seedCategory();
    const sellerToken = await loginSeller('9600000015');
    const p2 = await api().post('/api/v1/seller/products').set('Authorization', bearer(sellerToken)).send(productBody(categoryId)).expect(201);
    const productId2 = expectSuccess<{ id: string }>(p2.body).data.id;

    const res = await api()
      .post(`/api/v1/admin/approval-batches/${batchId}/items`)
      .set('Authorization', bearer(adminToken))
      .send({ productId: productId2 })
      .expect(200);

    const batch = expectSuccess<{ items: { productId: string }[] }>(res.body).data;
    expect(batch.items.map((i) => i.productId)).toContain(productId2);
    expect(await prisma.productApprovalBatchItem.count({ where: { batchId } })).toBe(2);
    void sellerId;
  });

  it('a seller cannot call the admin review endpoint', async () => {
    const { batchId, itemId, sellerToken } = await submitOneProduct('9600000016', 'Seller NoReview');

    const res = await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(sellerToken))
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });

  it('admin can list and view batches across every seller', async () => {
    const adminToken = await loginAdmin();
    await submitOneProduct('9600000017', 'Seller X');
    await submitOneProduct('9600000018', 'Seller Y');

    const res = await api()
      .get('/api/v1/admin/approval-batches?limit=50')
      .set('Authorization', bearer(adminToken))
      .expect(200);

    const list = expectSuccess<{ items: { sellerName: string }[] }>(res.body).data;
    const sellerNames = list.items.map((b) => b.sellerName);
    expect(sellerNames).toContain('Seller X');
    expect(sellerNames).toContain('Seller Y');
  });
});

describe('SellerListing integration — approvalStatus gates listing creation', () => {
  async function loginAdminToken(): Promise<string> {
    return loginAdmin();
  }

  it('an APPROVED product can back a new SellerListing', async () => {
    const adminToken = await loginAdminToken();
    const sellerId = await seedSellerWithOwner('9600000020', 'Seller Listable');
    const categoryId = await seedCategory();
    const sellerToken = await loginSeller('9600000020');

    const p = await api().post('/api/v1/seller/products').set('Authorization', bearer(sellerToken)).send(productBody(categoryId)).expect(201);
    const { id: productId, variantId } = expectSuccess<{ id: string; variantId: string }>(p.body).data;

    const submitted = await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(sellerToken)).send({ productIds: [productId] }).expect(201);
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>(submitted.body).data;

    await api()
      .patch(`/api/v1/admin/approval-batches/${batch.id}/items/${batch.items[0]!.id}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    const res = await api()
      .post(`/api/v1/admin/sellers/${sellerId}/listings`)
      .set('Authorization', bearer(adminToken))
      .send({ variantId, mrpPaise: 2000, pricePaise: 1800, stockQty: 5 })
      .expect(201);

    expect(expectSuccess<{ sellerId: string; variantId: string }>(res.body).data.variantId).toBe(variantId);
  });

  it('a PENDING product cannot back a SellerListing', async () => {
    const adminToken = await loginAdminToken();
    const sellerId = await seedSellerWithOwner('9600000021', 'Seller Pending');
    const categoryId = await seedCategory();
    const sellerToken = await loginSeller('9600000021');

    const p = await api().post('/api/v1/seller/products').set('Authorization', bearer(sellerToken)).send(productBody(categoryId)).expect(201);
    const { variantId } = expectSuccess<{ id: string; variantId: string }>(p.body).data;
    // Deliberately never submitted -- stays PENDING.

    const res = await api()
      .post(`/api/v1/admin/sellers/${sellerId}/listings`)
      .set('Authorization', bearer(adminToken))
      .send({ variantId, mrpPaise: 2000, pricePaise: 1800 });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await prisma.sellerListing.count({ where: { sellerId } })).toBe(0);
  });

  it('a REJECTED product cannot back a SellerListing', async () => {
    const adminToken = await loginAdminToken();
    const sellerId = await seedSellerWithOwner('9600000022', 'Seller Rejected');
    const categoryId = await seedCategory();
    const sellerToken = await loginSeller('9600000022');

    const p = await api().post('/api/v1/seller/products').set('Authorization', bearer(sellerToken)).send(productBody(categoryId)).expect(201);
    const { id: productId, variantId } = expectSuccess<{ id: string; variantId: string }>(p.body).data;
    const submitted = await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(sellerToken)).send({ productIds: [productId] }).expect(201);
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>(submitted.body).data;

    await api()
      .patch(`/api/v1/admin/approval-batches/${batch.id}/items/${batch.items[0]!.id}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reviewNote: 'not eligible' })
      .expect(200);

    const res = await api()
      .post(`/api/v1/admin/sellers/${sellerId}/listings`)
      .set('Authorization', bearer(adminToken))
      .send({ variantId, mrpPaise: 2000, pricePaise: 1800 });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await prisma.sellerListing.count({ where: { sellerId } })).toBe(0);
  });
});

describe('seller product list — GET /seller/products', () => {
  async function seedSubcategory(): Promise<{ parentId: string; parentName: string; childId: string; childName: string }> {
    const parentSlug = `parent-${randomUUID().slice(0, 8)}`;
    const parent = await prisma.category.create({
      data: { name: parentSlug, slug: parentSlug, path: parentSlug, depth: 0, isActive: true },
    });
    const childSlug = `child-${randomUUID().slice(0, 8)}`;
    const child = await prisma.category.create({
      data: { name: childSlug, slug: childSlug, path: `${parentSlug}/${childSlug}`, depth: 1, parentId: parent.id, isActive: true },
    });
    return { parentId: parent.id, parentName: parent.name, childId: child.id, childName: child.name };
  }

  async function createProduct(token: string, categoryId: string, overrides: Record<string, unknown> = {}) {
    const res = await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(productBody(categoryId, overrides)).expect(201);
    return expectSuccess<{ id: string; variantId: string }>(res.body).data;
  }

  async function submit(token: string, productId: string) {
    const res = await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(token)).send({ productIds: [productId] }).expect(201);
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>(res.body).data;
    return { batchId: batch.id, itemId: batch.items[0]!.id };
  }

  async function ownProducts(token: string, query = ''): Promise<SellerProductDto[]> {
    const res = await api().get(`/api/v1/seller/products${query}`).set('Authorization', bearer(token)).expect(200);
    return expectSuccess<SellerProductDto[]>(res.body).data;
  }

  it('lists an own product never submitted, with category, subcategory and default variant', async () => {
    const sellerId = await seedSellerWithOwner('9600000030', 'Seller List');
    const cats = await seedSubcategory();
    const token = await loginSeller('9600000030');
    const { id, variantId } = await createProduct(token, cats.childId, {
      name: 'Basmati Rice',
      nameHi: 'Basmati Chawal',
      description: 'Long grain.',
      sku: 'bas-rice-1kg',
      variantName: '1 kg',
      unit: UnitType.KG,
      unitValue: 1,
    });

    const list = await ownProducts(token);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      name: 'Basmati Rice',
      nameHi: 'Basmati Chawal',
      description: 'Long grain.',
      status: ProductStatus.ACTIVE,
      approvalStatus: ApprovalStatus.PENDING,
      submittedBySellerId: sellerId,
      categoryId: cats.childId,
      category: { id: cats.parentId, name: cats.parentName },
      subcategory: { id: cats.childId, name: cats.childName },
      defaultVariant: { id: variantId, variantName: '1 kg', sku: 'BAS-RICE-1KG', unit: UnitType.KG, unitValue: 1 },
      listing: null,
      latestApproval: null,
      lastRejectionReason: null,
    });
    expect(typeof list[0]!.createdAt).toBe('string');
  });

  it("never shows another seller's products, and ignores a sellerId query parameter", async () => {
    const sellerA = await seedSellerWithOwner('9600000031', 'Seller A');
    await seedSellerWithOwner('9600000032', 'Seller B');
    const categoryId = await seedCategory();
    const tokenA = await loginSeller('9600000031');
    const tokenB = await loginSeller('9600000032');
    const a = await createProduct(tokenA, categoryId);
    const b = await createProduct(tokenB, categoryId);

    expect((await ownProducts(tokenA)).map((p) => p.id)).toEqual([a.id]);
    expect((await ownProducts(tokenB)).map((p) => p.id)).toEqual([b.id]);
    expect((await ownProducts(tokenB, `?sellerId=${sellerA}`)).map((p) => p.id)).toEqual([b.id]);
  });

  it('shows the pending review of a submitted product', async () => {
    await seedSellerWithOwner('9600000033', 'Seller Pending');
    const categoryId = await seedCategory();
    const token = await loginSeller('9600000033');
    const { id } = await createProduct(token, categoryId);
    const { batchId, itemId } = await submit(token, id);

    const [product] = await ownProducts(token);
    expect(product!.approvalStatus).toBe(ApprovalStatus.PENDING);
    expect(product!.latestApproval).toMatchObject({
      batchId,
      itemId,
      batchStatus: ApprovalStatus.PENDING,
      status: ApprovalStatus.PENDING,
      reviewNote: null,
    });
  });

  it('carries the rejection reason, and keeps it as lastRejectionReason after resubmission', async () => {
    const adminToken = await loginAdmin();
    await seedSellerWithOwner('9600000034', 'Seller Rejected');
    const categoryId = await seedCategory();
    const token = await loginSeller('9600000034');
    const { id } = await createProduct(token, categoryId);
    const { batchId, itemId } = await submit(token, id);
    await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reviewNote: 'Photo is blurry.' })
      .expect(200);

    let [product] = await ownProducts(token);
    expect(product!.approvalStatus).toBe(ApprovalStatus.REJECTED);
    expect(product!.latestApproval).toMatchObject({ status: ApprovalStatus.REJECTED, batchStatus: ApprovalStatus.REJECTED, reviewNote: 'Photo is blurry.' });
    expect(product!.lastRejectionReason).toBe('Photo is blurry.');

    const again = await submit(token, id);
    [product] = await ownProducts(token);
    expect(product!.approvalStatus).toBe(ApprovalStatus.PENDING);
    expect(product!.latestApproval).toMatchObject({ batchId: again.batchId, status: ApprovalStatus.PENDING, reviewNote: null });
    expect(product!.lastRejectionReason).toBe('Photo is blurry.');
  });

  it("shows the seller's own listing of an approved product, never another seller's", async () => {
    const adminToken = await loginAdmin();
    await seedSellerWithOwner('9600000035', 'Seller Owner');
    const otherSellerId = await seedSellerWithOwner('9600000036', 'Seller Other');
    const categoryId = await seedCategory();
    const token = await loginSeller('9600000035');
    const { id, variantId } = await createProduct(token, categoryId);
    const { batchId, itemId } = await submit(token, id);
    await api()
      .patch(`/api/v1/admin/approval-batches/${batchId}/items/${itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    // Another seller lists the same approved variant first: not the owner's listing.
    await api()
      .post(`/api/v1/admin/sellers/${otherSellerId}/listings`)
      .set('Authorization', bearer(adminToken))
      .send({ variantId, mrpPaise: 2000, pricePaise: 1500, stockQty: 3 })
      .expect(201);
    let [product] = await ownProducts(token);
    expect(product!.approvalStatus).toBe(ApprovalStatus.APPROVED);
    expect(product!.listing).toBeNull();

    const created = await api()
      .post('/api/v1/seller/listings')
      .set('Authorization', bearer(token))
      .send({ variantId, mrpPaise: 2000, pricePaise: 1800, stockQty: 7 })
      .expect(201);
    const listingId = expectSuccess<{ id: string }>(created.body).data.id;

    [product] = await ownProducts(token);
    expect(product!.listing).toEqual({
      id: listingId,
      mrpPaise: 2000,
      pricePaise: 1800,
      stockQty: 7,
      reservedQty: 0,
      availableQty: 7,
      isAvailable: true,
    });
  });

  it('a customer cannot list seller products', async () => {
    await otpService.clearOtpState('9600000037');
    const customer = await loginAs('9600000037');

    const res = await api().get('/api/v1/seller/products').set('Authorization', bearer(customer.accessToken));

    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('admin approval detail — GET /admin/approval-batches/:id', () => {
  async function submitDetailedProduct(mobile: string) {
    await seedSellerWithOwner(mobile, `Seller ${mobile}`);
    const parentSlug = `parent-${randomUUID().slice(0, 8)}`;
    const parent = await prisma.category.create({ data: { name: parentSlug, slug: parentSlug, path: parentSlug, depth: 0, isActive: true } });
    const childSlug = `child-${randomUUID().slice(0, 8)}`;
    const child = await prisma.category.create({
      data: { name: childSlug, slug: childSlug, path: `${parentSlug}/${childSlug}`, depth: 1, parentId: parent.id, isActive: true },
    });
    const token = await loginSeller(mobile);
    const created = await api()
      .post('/api/v1/seller/products')
      .set('Authorization', bearer(token))
      .send(productBody(child.id, { name: 'Toor Dal', nameHi: 'Toor Daal', description: 'Unpolished.', sku: 'toor-500', variantName: '500 g', unit: UnitType.G, unitValue: 500 }))
      .expect(201);
    const { id: productId, variantId } = expectSuccess<{ id: string; variantId: string }>(created.body).data;
    const submitted = await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(token)).send({ productIds: [productId] }).expect(201);
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>(submitted.body).data;
    return { token, productId, variantId, batchId: batch.id, itemId: batch.items[0]!.id, parent, child };
  }

  it('an admin sees the submitted product details, category, variant and images', async () => {
    const adminToken = await loginAdmin();
    const s = await submitDetailedProduct('9600000040');
    // Image rows as the admin catalogue attaches them (displayOrder 0 = primary).
    await prisma.productImage.create({ data: { productId: s.productId, url: 'https://img.test/b.jpg', displayOrder: 1 } });
    await prisma.productImage.create({ data: { productId: s.productId, url: 'https://img.test/a.jpg', thumbUrl: 'https://img.test/a-t.jpg', altText: 'front', displayOrder: 0 } });

    const res = await api().get(`/api/v1/admin/approval-batches/${s.batchId}`).set('Authorization', bearer(adminToken)).expect(200);
    const detail = expectSuccess<ProductApprovalBatchReviewDto>(res.body).data;

    expect(detail.items).toHaveLength(1);
    const item = detail.items[0]!;
    // The existing item fields are unchanged ...
    expect(item).toMatchObject({ id: s.itemId, productId: s.productId, productName: 'Toor Dal', status: ApprovalStatus.PENDING, reviewNote: null });
    // ... plus what the admin reviews.
    expect(item.product).toMatchObject({
      id: s.productId,
      name: 'Toor Dal',
      nameHi: 'Toor Daal',
      description: 'Unpolished.',
      status: ProductStatus.ACTIVE,
      approvalStatus: ApprovalStatus.PENDING,
      categoryId: s.child.id,
      category: { id: s.parent.id, name: s.parent.name },
      subcategory: { id: s.child.id, name: s.child.name },
      defaultVariant: { id: s.variantId, variantName: '500 g', sku: 'TOOR-500', unit: UnitType.G, unitValue: 500 },
    });
    expect(item.product!.images.map((i) => i.url)).toEqual(['https://img.test/a.jpg', 'https://img.test/b.jpg']);
    expect(item.product!.images[0]).toMatchObject({ thumbUrl: 'https://img.test/a-t.jpg', altText: 'front', displayOrder: 0 });
  });

  it('a seller cannot read the admin batch detail, not even for their own batch', async () => {
    const s = await submitDetailedProduct('9600000041');

    const res = await api().get(`/api/v1/admin/approval-batches/${s.batchId}`).set('Authorization', bearer(s.token));

    expect(res.status).toBe(403);
    expect(expectError(res.body).code).toBe(ErrorCode.FORBIDDEN);
  });

  it('approve/reject still work, and the detail reflects the decision', async () => {
    const adminToken = await loginAdmin();
    const s = await submitDetailedProduct('9600000042');

    await api()
      .patch(`/api/v1/admin/approval-batches/${s.batchId}/items/${s.itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'REJECTED', reviewNote: 'Wrong category.' })
      .expect(200);

    const res = await api().get(`/api/v1/admin/approval-batches/${s.batchId}`).set('Authorization', bearer(adminToken)).expect(200);
    const detail = expectSuccess<ProductApprovalBatchReviewDto>(res.body).data;
    expect(detail.status).toBe(ApprovalStatus.REJECTED);
    expect(detail.items[0]).toMatchObject({ status: ApprovalStatus.REJECTED, reviewNote: 'Wrong category.' });
    expect(detail.items[0]!.product!.approvalStatus).toBe(ApprovalStatus.REJECTED);

    // A decided item still cannot be reviewed again.
    const again = await api()
      .patch(`/api/v1/admin/approval-batches/${s.batchId}/items/${s.itemId}`)
      .set('Authorization', bearer(adminToken))
      .send({ status: 'APPROVED' });
    expect(again.status).toBe(409);
    expect(expectError(again.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
  });
});

describe('seller product edit — PATCH /seller/products/:id', () => {
  async function setup(mobile: string) {
    const sellerId = await seedSellerWithOwner(mobile, `Seller ${mobile}`);
    const categoryId = await seedCategory();
    const token = await loginSeller(mobile);
    const res = await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(productBody(categoryId)).expect(201);
    const { id, variantId } = expectSuccess<{ id: string; variantId: string }>(res.body).data;
    return { sellerId, categoryId, token, id, variantId };
  }
  async function submit(token: string, productId: string) {
    const res = await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(token)).send({ productIds: [productId] });
    return res;
  }
  async function decide(adminToken: string, token: string, productId: string, status: 'APPROVED' | 'REJECTED') {
    const submitted = await submit(token, productId);
    const batch = expectSuccess<{ id: string; items: { id: string }[] }>(submitted.body).data;
    await api()
      .patch(`/api/v1/admin/approval-batches/${batch.id}/items/${batch.items[0]!.id}`)
      .set('Authorization', bearer(adminToken))
      .send(status === 'REJECTED' ? { status, reviewNote: 'Fix the name.' } : { status })
      .expect(200);
  }

  it('the owner corrects a rejected product; it stays REJECTED until resubmitted, then PENDING', async () => {
    const adminToken = await loginAdmin();
    const s = await setup('9600000050');
    await decide(adminToken, s.token, s.id, 'REJECTED');

    const res = await api()
      .patch(`/api/v1/seller/products/${s.id}`)
      .set('Authorization', bearer(s.token))
      .send({ name: 'Corrected Name', description: 'Now with details.', sku: 'fixed-sku-50', unitValue: 2 })
      .expect(200);
    const updated = expectSuccess<SellerProductDto>(res.body).data;
    expect(updated).toMatchObject({ id: s.id, name: 'Corrected Name', description: 'Now with details.', approvalStatus: ApprovalStatus.REJECTED, submittedBySellerId: s.sellerId });
    expect(updated.defaultVariant).toMatchObject({ id: s.variantId, sku: 'FIXED-SKU-50', unitValue: 2 });

    await submit(s.token, s.id).then((r) => expect(r.status).toBe(201));
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s.id } })).approvalStatus).toBe(ApprovalStatus.PENDING);
    expect(await prisma.product.count({ where: { submittedBySellerId: s.sellerId } })).toBe(1);
  });

  it('a never-submitted product can be edited', async () => {
    const s = await setup('9600000051');
    await api().patch(`/api/v1/seller/products/${s.id}`).set('Authorization', bearer(s.token)).send({ variantName: '2 kg' }).expect(200);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: s.variantId } })).variantName).toBe('2 kg');
  });

  it("another seller gets 404 and nothing changes", async () => {
    const s = await setup('9600000052');
    await seedSellerWithOwner('9600000053', 'Other Seller');
    const other = await loginSeller('9600000053');

    const res = await api().patch(`/api/v1/seller/products/${s.id}`).set('Authorization', bearer(other)).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(expectError(res.body).code).toBe(ErrorCode.NOT_FOUND);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s.id } })).name).not.toBe('Hijacked');
  });

  it('a product under review or approved cannot be edited (409), and its listing is untouched', async () => {
    const adminToken = await loginAdmin();
    const s = await setup('9600000054');
    await submit(s.token, s.id);
    const inReview = await api().patch(`/api/v1/seller/products/${s.id}`).set('Authorization', bearer(s.token)).send({ name: 'During review' });
    expect(inReview.status).toBe(409);
    expect(expectError(inReview.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);

    const batch = await prisma.productApprovalBatchItem.findFirstOrThrow({ where: { productId: s.id } });
    await api().patch(`/api/v1/admin/approval-batches/${batch.batchId}/items/${batch.id}`).set('Authorization', bearer(adminToken)).send({ status: 'APPROVED' }).expect(200);
    await api().post('/api/v1/seller/listings').set('Authorization', bearer(s.token)).send({ variantId: s.variantId, mrpPaise: 2000, pricePaise: 1800, stockQty: 4 }).expect(201);

    const approved = await api().patch(`/api/v1/seller/products/${s.id}`).set('Authorization', bearer(s.token)).send({ name: 'After approval' });
    expect(approved.status).toBe(409);
    const listing = await prisma.sellerListing.findFirstOrThrow({ where: { variantId: s.variantId } });
    expect(listing).toMatchObject({ mrpPaise: 2000, pricePaise: 1800, stockQty: 4 });
  });

  it('refuses fields outside the creation schema with 400', async () => {
    const s = await setup('9600000055');
    for (const body of [{ approvalStatus: 'APPROVED' }, { submittedBySellerId: s.sellerId }, { status: 'ACTIVE' }, { pricePaise: 100 }, { stockQty: 5 }, {}]) {
      const res = await api().patch(`/api/v1/seller/products/${s.id}`).set('Authorization', bearer(s.token)).send(body);
      expect(res.status).toBe(400);
    }
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s.id } })).approvalStatus).toBe(ApprovalStatus.PENDING);
  });

  it('a SKU already in use is a clean 409', async () => {
    const a = await setup('9600000056');
    const other = await api().post('/api/v1/seller/products').set('Authorization', bearer(a.token)).send(productBody(a.categoryId, { sku: 'TAKEN-SKU' })).expect(201);
    void other;

    const res = await api().patch(`/api/v1/seller/products/${a.id}`).set('Authorization', bearer(a.token)).send({ sku: 'taken-sku' });

    expect(res.status).toBe(409);
    expect(expectError(res.body).message).toBe('This SKU is already used by another product.');
  });

  it('after resubmission a duplicate submission is 409, and the admin can decide again', async () => {
    const adminToken = await loginAdmin();
    const s = await setup('9600000057');
    await decide(adminToken, s.token, s.id, 'REJECTED');
    await api().patch(`/api/v1/seller/products/${s.id}`).set('Authorization', bearer(s.token)).send({ name: 'Second try' }).expect(200);
    const again = await submit(s.token, s.id);
    expect(again.status).toBe(201);
    expect((await submit(s.token, s.id)).status).toBe(409);

    const batch = expectSuccess<{ id: string; items: { id: string }[] }>(again.body).data;
    await api().patch(`/api/v1/admin/approval-batches/${batch.id}/items/${batch.items[0]!.id}`).set('Authorization', bearer(adminToken)).send({ status: 'APPROVED' }).expect(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s.id } })).approvalStatus).toBe(ApprovalStatus.APPROVED);
  });
});

describe('seller product images', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a50000000049454e44ae426082', 'hex');

  async function setup(mobile: string) {
    const sellerId = await seedSellerWithOwner(mobile, `Seller ${mobile}`);
    const categoryId = await seedCategory();
    const token = await loginSeller(mobile);
    const res = await api().post('/api/v1/seller/products').set('Authorization', bearer(token)).send(productBody(categoryId)).expect(201);
    return { sellerId, token, productId: expectSuccess<{ id: string }>(res.body).data.id };
  }
  async function upload(token: string) {
    const presign = await api().post('/api/v1/seller/uploads/presign').set('Authorization', bearer(token)).send({ fileName: 'photo.png', contentType: 'image/png' }).expect(200);
    const target = expectSuccess<{ uploadUrl: string; key: string }>(presign.body).data;
    await api().put(`/api/v1/seller/uploads/direct?key=${encodeURIComponent(target.key)}`).set('Authorization', bearer(token)).set('Content-Type', 'image/png').send(PNG).expect(200);
    return target;
  }

  it('upload + attach on an own editable product; the image is listed; removal deletes row and file', async () => {
    const s = await setup('9600000060');
    const target = await upload(s.token);
    expect(target.key).toMatch(/^products\/s-[0-9a-f]{24}\//);
    expect(target.uploadUrl).toContain('/api/v1/seller/uploads/direct?key=');
    expect(target.key).not.toContain(s.sellerId);

    const attached = await api().post(`/api/v1/seller/products/${s.productId}/images`).set('Authorization', bearer(s.token)).send({ key: target.key }).expect(201);
    const product = expectSuccess<SellerProductDto>(attached.body).data;
    expect(product.images).toHaveLength(1);
    expect(product.images[0]!.url).toContain(target.key);

    const stored = resolve(__dirname, '../../storage', target.key);
    expect(existsSync(stored)).toBe(true);
    const removed = await api().delete(`/api/v1/seller/products/${s.productId}/images/${product.images[0]!.id}`).set('Authorization', bearer(s.token)).expect(200);
    expect(expectSuccess<SellerProductDto>(removed.body).data.images).toHaveLength(0);
    expect(await prisma.productImage.count({ where: { productId: s.productId } })).toBe(0);
    expect(existsSync(stored)).toBe(false);
  });

  it("a seller can't write to, attach from, or attach to another seller's space", async () => {
    const a = await setup('9600000061');
    const b = await setup('9600000062');
    const bTarget = await upload(b.token);

    // A PUTs bytes to B's key -> refused; A attaches B's key -> refused.
    const put = await api().put(`/api/v1/seller/uploads/direct?key=${encodeURIComponent(bTarget.key)}`).set('Authorization', bearer(a.token)).set('Content-Type', 'image/png').send(PNG);
    expect(put.status).toBe(403);
    const borrow = await api().post(`/api/v1/seller/products/${a.productId}/images`).set('Authorization', bearer(a.token)).send({ key: bTarget.key });
    expect(borrow.status).toBe(403);
    // A attaches its own key to B's product -> not found.
    const aTarget = await upload(a.token);
    const foreign = await api().post(`/api/v1/seller/products/${b.productId}/images`).set('Authorization', bearer(a.token)).send({ key: aTarget.key });
    expect(foreign.status).toBe(404);

    // B's image can't be removed by A.
    const bAttached = await api().post(`/api/v1/seller/products/${b.productId}/images`).set('Authorization', bearer(b.token)).send({ key: bTarget.key }).expect(201);
    const bImage = expectSuccess<SellerProductDto>(bAttached.body).data.images[0]!;
    expect((await api().delete(`/api/v1/seller/products/${b.productId}/images/${bImage.id}`).set('Authorization', bearer(a.token))).status).toBe(404);
    expect((await api().delete(`/api/v1/seller/products/${a.productId}/images/${bImage.id}`).set('Authorization', bearer(a.token))).status).toBe(404);
    expect(await prisma.productImage.count({ where: { id: bImage.id } })).toBe(1);
  });

  it('invalid type and oversized files are refused', async () => {
    const s = await setup('9600000063');
    const presign = await api().post('/api/v1/seller/uploads/presign').set('Authorization', bearer(s.token)).send({ fileName: 'doc.pdf', contentType: 'application/pdf' });
    expect(presign.status).toBe(415);
    const target = await upload(s.token);
    const text = await api().put(`/api/v1/seller/uploads/direct?key=${encodeURIComponent(target.key)}`).set('Authorization', bearer(s.token)).set('Content-Type', 'text/plain').send('not an image');
    expect(text.status).toBe(415);
    const big = await api().put(`/api/v1/seller/uploads/direct?key=${encodeURIComponent(target.key)}`).set('Authorization', bearer(s.token)).set('Content-Type', 'image/png').send(Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(expectError(big.body).code).toBe(ErrorCode.FILE_TOO_LARGE);
  });

  it('images of a product under review or approved cannot change (409)', async () => {
    const s = await setup('9600000064');
    const target = await upload(s.token);
    await api().post('/api/v1/seller/approval-batches').set('Authorization', bearer(s.token)).send({ productIds: [s.productId] }).expect(201);
    const res = await api().post(`/api/v1/seller/products/${s.productId}/images`).set('Authorization', bearer(s.token)).send({ key: target.key });
    expect(res.status).toBe(409);
  });
});
