/**
 * A rejected product, corrected and resubmitted, then decided again — end to
 * end through the seller and admin APIs, as both panels use them:
 *
 *   new -> PENDING -> REJECTED (reason kept on the batch item) -> edited
 *   (still REJECTED, not in any queue) -> resubmitted (PENDING, a NEW batch
 *   item; the old one stays as history) -> APPROVED or REJECTED again.
 *
 * The product's own `approvalStatus` is what every view reads: the database,
 * the admin Products list, the seller's Products tab, the batch table (with
 * "now <status>" on an older batch's row) and the customer catalogue — which
 * still applies every other rule (stock, seller hidden, seller inactive).
 * Decisions are serialised per batch, and a seller edit — details, options
 * or photos — never lands inside a submission. The original flow stays in product-approval.test.ts.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ErrorCode,
  NotificationType,
  SellerType,
  UnitType,
  UserRole,
  type ApproveProductBatchResultDto,
  type SellerProductDto,
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
import { storage, storageKeyFromUrl } from '../../src/infra/storage';
import { sellerImageFolder } from '../../src/modules/catalog/seller-image.service';
import { optimizedKeysFor } from '../../src/modules/catalog/uploaded-image.service';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

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
  put: (path: string, body: object) => api().put(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
  delete: (path: string) => api().delete(`/api/v1${path}`).set('Authorization', bearer(token)),
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

type Batch = { id: string; status: string; items: { id: string; productId: string; status: string }[] };

const submit = async (seller: Seller, productIds?: string[]) =>
  expectSuccess<Batch>((await as(seller.token).submit(productIds ? { productIds } : {}).expect(201)).body).data;
const decide = (adminToken: string, batch: Batch, productId: string, status: 'APPROVED' | 'REJECTED', reviewNote?: string) =>
  as(adminToken).patch(`/admin/approval-batches/${batch.id}/items/${batch.items.find((i) => i.productId === productId)!.id}`, {
    status,
    ...(reviewNote ? { reviewNote } : {}),
  });
const dbStatus = async (productId: string) => (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).approvalStatus;
const sellerView = async (seller: Seller, productId: string) =>
  expectSuccess<SellerProductDto>((await as(seller.token).get(`/seller/products/${productId}`).expect(200)).body).data;
/** The admin Products list row (GET /admin/marketplace/products). */
async function adminRow(adminToken: string, seller: Seller, productId: string) {
  const page = expectSuccess<{ items: { productId: string; approvalStatus: string; visibility: { sellable: boolean; reason: string } }[] }>(
    (await as(adminToken).get(`/admin/marketplace/products?sellerId=${seller.id}`).expect(200)).body,
  ).data;
  return page.items.find((row) => row.productId === productId)!;
}
/** The seller's Products tab in the admin Seller page. */
async function adminSellerProduct(adminToken: string, seller: Seller, productId: string) {
  const rows = expectSuccess<SellerProductDto[]>((await as(adminToken).get(`/admin/sellers/${seller.id}/products`).expect(200)).body).data;
  return rows.find((row) => row.id === productId)!;
}
async function batchRow(adminToken: string, batchId: string, productId: string) {
  const page = expectSuccess<ProductApprovalBatchProductsPageDto>(
    (await as(adminToken).get(`/admin/approval-batches/${batchId}/products?offset=0&limit=50`).expect(200)).body,
  ).data;
  return page.items.find((row) => row.productId === productId)!;
}
const customerSees = async (productId: string) => (await api().get(`/api/v1/products/${productId}`)).status === 200;

/** A product submitted once and rejected with `reason`. */
async function rejectedProduct(adminToken: string, seller: Seller, reason = 'Wrong product name') {
  const product = await createProduct(seller, { name: `Basmti Rice ${randomUUID().slice(0, 4)}` });
  const first = await submit(seller);
  await decide(adminToken, first, product.id, 'REJECTED', reason).expect(200);
  return { product, first };
}

describe('reject -> correct -> resubmit -> decide again', () => {
  it('walks every status (PENDING, REJECTED, still REJECTED after an edit, PENDING on resubmit, APPROVED) and every view agrees', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000041', 'Resubmit Seller');

    // 1. New product: PENDING, never submitted, not on sale.
    const product = await createProduct(seller, { name: 'Basmti Rice' });
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.PENDING);
    expect((await sellerView(seller, product.id)).latestApproval).toBeNull();
    const first = await submit(seller);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.PENDING);

    // 2. Rejected: the reason is stored, the product is not on sale.
    await decide(adminToken, first, product.id, 'REJECTED', 'Wrong product name').expect(200);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.REJECTED);
    expect(await sellerView(seller, product.id)).toMatchObject({ approvalStatus: 'REJECTED', lastRejectionReason: 'Wrong product name' });
    expect((await adminRow(adminToken, seller, product.id)).approvalStatus).toBe('REJECTED');
    expect(await customerSees(product.id)).toBe(false);

    // 3. Corrected: saved, but still REJECTED and in no queue until resubmitted.
    await as(seller.token).patch(`/seller/products/${product.id}`, { name: 'Basmati Rice' }).expect(200);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.REJECTED);
    expect(await prisma.productApprovalBatchItem.count({ where: { productId: product.id, status: 'PENDING' } })).toBe(0);

    // 4. Resubmitted: PENDING, a new batch item; the old decision is kept as history.
    const second = await submit(seller, [product.id]);
    expect(second.id).not.toBe(first.id);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.PENDING);
    expect(
      await prisma.productApprovalBatchItem.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: 'asc' },
        select: { status: true, reviewNote: true },
      }),
    ).toEqual([
      { status: 'REJECTED', reviewNote: 'Wrong product name' },
      { status: 'PENDING', reviewNote: null },
    ]);
    expect((await adminRow(adminToken, seller, product.id)).approvalStatus).toBe('PENDING');
    // Under review: no more edits until it is decided.
    expect((await as(seller.token).patch(`/seller/products/${product.id}`, { name: 'Changed Again' })).status).toBe(409);

    // 5. Approved: persisted, and the answer is what the database holds.
    const approved = expectSuccess<{ status: string; items: { status: string }[] }>(
      (await decide(adminToken, second, product.id, 'APPROVED').expect(200)).body,
    ).data;
    expect(approved.status).toBe('APPROVED');
    expect(approved.items[0]!.status).toBe('APPROVED');
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.APPROVED);

    // Admin: approved in the Products list and the seller's Products tab.
    expect(await adminRow(adminToken, seller, product.id)).toMatchObject({ approvalStatus: 'APPROVED', visibility: { sellable: true, reason: 'VISIBLE' } });
    expect((await adminSellerProduct(adminToken, seller, product.id)).approvalStatus).toBe('APPROVED');
    // The OLD batch keeps its Rejected decision as history, and says what it is now.
    expect(await batchRow(adminToken, first.id, product.id)).toMatchObject({
      itemStatus: 'REJECTED',
      currentApprovalStatus: 'APPROVED',
      newerSubmission: { batchId: second.id, status: 'APPROVED' },
    });
    expect((await batchRow(adminToken, second.id, product.id)).newerSubmission).toBeNull();

    // 7. The old reason is no longer the active one: the latest decision is the approval.
    const seen = await sellerView(seller, product.id);
    expect(seen.approvalStatus).toBe('APPROVED');
    expect(seen.latestApproval).toMatchObject({ status: 'APPROVED', reviewNote: null, batchId: second.id });

    // 8. On sale for customers: product page, its category and search.
    expect(await customerSees(product.id)).toBe(true);
    expect((await customerCatalogue()).map((c) => [c.name, c.productCount])).toEqual([['Grocery', 1]]);
    const search = expectSuccess<{ items: { id: string }[] }>((await api().get('/api/v1/products/search?q=Basmati').expect(200)).body).data;
    expect(search.items.map((p) => p.id)).toContain(product.id);
  });

  it('a resubmitted product rejected again is REJECTED with the NEW reason; the history keeps both', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000042', 'Twice Seller');
    const { product } = await rejectedProduct(adminToken, seller, 'Wrong product name');
    await as(seller.token).patch(`/seller/products/${product.id}`, { name: 'Still Wrong' }).expect(200);
    const second = await submit(seller, [product.id]);

    // 6. Rejected again.
    await decide(adminToken, second, product.id, 'REJECTED', 'Image does not match the product').expect(200);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.REJECTED);
    expect(await sellerView(seller, product.id)).toMatchObject({
      approvalStatus: 'REJECTED',
      lastRejectionReason: 'Image does not match the product',
      latestApproval: { status: 'REJECTED', reviewNote: 'Image does not match the product' },
    });
    const notes = await prisma.productApprovalBatchItem.findMany({ where: { productId: product.id }, orderBy: { createdAt: 'asc' } });
    expect(notes.map((i) => i.reviewNote)).toEqual(['Wrong product name', 'Image does not match the product']);
    expect(await customerSees(product.id)).toBe(false);
  });

  it('Approve Batch approves a resubmitted product too; it can be resubmitted together with new drafts', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000043', 'Batch Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    const draft = await createProduct(seller);
    await as(seller.token).patch(`/seller/products/${product.id}`, { name: 'Corrected Product' }).expect(200);

    // The Products page's Submit Selected: a draft and the corrected rejected product together.
    const batch = await submit(seller, [draft.id, product.id]);
    expect(batch.items).toHaveLength(2);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.PENDING);

    const result = expectSuccess<ApproveProductBatchResultDto>(
      (await as(adminToken).post(`/admin/approval-batches/${batch.id}/approve`).expect(200)).body,
    ).data;
    expect(result.approvedCount).toBe(2);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.APPROVED);
    expect(await dbStatus(draft.id)).toBe(ApprovalStatus.APPROVED);
    expect(await customerSees(product.id)).toBe(true);
  });

  it('Submit for Approval (everything) never resubmits a rejected product on its own; only an explicit resubmission does', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000044', 'Explicit Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    await createProduct(seller);
    const all = await submit(seller);
    expect(all.items.map((i) => i.productId)).not.toContain(product.id);
    await as(adminToken).post(`/admin/approval-batches/${all.id}/approve`).expect(200);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.REJECTED);
  });
});

describe('approval never overrides the other catalogue rules', () => {
  async function approvedProduct(adminToken: string, seller: Seller) {
    const { product } = await rejectedProduct(adminToken, seller);
    const second = await submit(seller, [product.id]);
    await decide(adminToken, second, product.id, 'APPROVED').expect(200);
    expect(await customerSees(product.id)).toBe(true);
    return product;
  }

  it('9. approved but out of stock: not orderable, shown as out of stock to admin', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000045', 'Stock Seller');
    const product = await approvedProduct(adminToken, seller);
    await prisma.sellerListing.update({ where: { id: product.listingId }, data: { stockQty: 0 } });

    expect((await adminRow(adminToken, seller, product.id)).visibility).toMatchObject({ sellable: false, reason: 'OUT_OF_STOCK' });
    await otpService.clearOtpState('9700000096');
    const customer = await loginAs('9700000096');
    const add = await as(customer.accessToken).post('/cart/items', { sellerListingId: product.listingId, qty: 1 });
    expect(add.status).toBeGreaterThanOrEqual(400);
    expect([ErrorCode.ITEM_OUT_OF_STOCK, ErrorCode.INSUFFICIENT_STOCK]).toContain(expectError(add.body).code);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.APPROVED);
  });

  it('10. approved but hidden by the seller, or the seller deactivated: not shown to customers', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000046', 'Hidden Seller');
    const product = await approvedProduct(adminToken, seller);

    await as(seller.token).patch(`/seller/products/${product.id}/status`, { status: 'INACTIVE' }).expect(200);
    expect(await customerSees(product.id)).toBe(false);
    expect((await adminRow(adminToken, seller, product.id)).visibility.reason).toBe('HIDDEN_BY_SELLER');
    await as(seller.token).patch(`/seller/products/${product.id}/status`, { status: 'ACTIVE' }).expect(200);
    expect(await customerSees(product.id)).toBe(true);

    await prisma.seller.update({ where: { id: seller.id }, data: { isActive: false } });
    expect(await customerSees(product.id)).toBe(false);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.APPROVED);
  });
});

describe('repeated and concurrent decisions', () => {
  it('11. approving twice is refused the second time; the product stays APPROVED', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000047', 'Twice Approve Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    const second = await submit(seller, [product.id]);
    await decide(adminToken, second, product.id, 'APPROVED').expect(200);
    const again = await decide(adminToken, second, product.id, 'APPROVED');
    expect(again.status).toBe(409);
    expect(expectError(again.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    expect((await as(adminToken).post(`/admin/approval-batches/${second.id}/approve`)).status).toBe(409);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.APPROVED);
  });

  it('a per-item reject racing Approve Batch is decided once, and the product matches its item', async () => {
    const adminToken = await loginAdmin();
    for (let round = 0; round < 3; round += 1) {
      const seller = await seedSeller(`970000005${round}`, `Race Seller ${round}`);
      const product = await createProduct(seller);
      const batch = await submit(seller);
      const [reject, approve] = await Promise.all([
        decide(adminToken, batch, product.id, 'REJECTED', 'Blurry photo'),
        as(adminToken).post(`/admin/approval-batches/${batch.id}/approve`),
      ]);
      const item = await prisma.productApprovalBatchItem.findFirstOrThrow({ where: { batchId: batch.id } });
      // Exactly one decision landed, and the product carries that one.
      expect([reject.status, approve.status].sort()).toEqual([200, 409]);
      expect(await dbStatus(product.id)).toBe(item.status);
      expect(item.status).toBe(reject.status === 200 ? 'REJECTED' : 'APPROVED');
    }
  });
});

describe('12. a seller edit never lands inside a submission', () => {
  it('an edit made while a submission holds the lock waits for it, then is refused as under review', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000061', 'Lock Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    const staff = await prisma.sellerStaff.findFirstOrThrow({ where: { sellerId: seller.id } });

    // A submission in progress: the seller row locked, the item created, not yet committed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const submission = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${seller.id}::uuid FOR UPDATE`;
        const batch = await tx.productApprovalBatch.create({ data: { sellerId: seller.id, submittedByUserId: staff.userId } });
        await tx.productApprovalBatchItem.create({ data: { batchId: batch.id, productId: product.id } });
        await tx.product.update({ where: { id: product.id }, data: { approvalStatus: 'PENDING' } });
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    let settled = false;
    const edit = as(seller.token)
      .patch(`/seller/products/${product.id}`, { name: 'Sneaky Change' })
      .then((res) => {
        settled = true;
        return res;
      });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(settled).toBe(false);

    release();
    await submission;
    const res = await edit;
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).name).not.toBe('Sneaky Change');
  });

  it('the options of a product under review cannot change either', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000062', 'Options Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    await submit(seller, [product.id]);
    const own = await sellerView(seller, product.id);
    const put = await as(seller.token).put(`/seller/products/${product.id}/variants`, {
      optionGroups: [],
      variants: [{ id: own.variants[0]!.id, variantName: '2 kg', pricePaise: 10_000, mrpPaise: 12_000, stockQty: 25 }],
    });
    expect(put.status).toBe(409);
  });
});

/* -------------------------------------------------------------------------- */
/* Product images follow the same review rule as the product's details        */
/* -------------------------------------------------------------------------- */

const photo = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).jpeg().toBuffer();
/** A file in the seller's own upload folder, as POST /seller/uploads/presign + PUT leave it. */
async function uploaded(seller: Seller, color: string): Promise<string> {
  const key = `${sellerImageFolder(seller.id)}/${randomUUID()}.jpg`;
  await storage.put(key, await photo(color), 'image/jpeg');
  return key;
}
const imagesOf = (productId: string) =>
  prisma.productImage.findMany({ where: { productId }, orderBy: { displayOrder: 'asc' }, select: { id: true, url: true, displayOrder: true } });
const storedKey = async (key: string) => (await storage.get(key, 20 * 1024 * 1024)) !== null;
const storedUrl = async (url: string) => storedKey(storageKeyFromUrl(url)!);

/**
 * A "Submit for Approval" caught mid-way for `productId`: the seller row is
 * locked and the product is put under review, uncommitted until `release()`.
 */
async function submissionInProgress(seller: Seller, productId: string) {
  const staff = await prisma.sellerStaff.findFirstOrThrow({ where: { sellerId: seller.id } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${seller.id}::uuid FOR UPDATE`;
      const batch = await tx.productApprovalBatch.create({ data: { sellerId: seller.id, submittedByUserId: staff.userId } });
      await tx.productApprovalBatchItem.create({ data: { batchId: batch.id, productId } });
      await tx.product.update({ where: { id: productId }, data: { approvalStatus: 'PENDING' } });
      locked();
      await gate;
    },
    { timeout: 30_000 },
  );
  await lockTaken;
  return {
    finish: async () => {
      release();
      await done;
    },
  };
}

/** Starts a request and reports whether it has answered yet. */
function tracked<T>(request: PromiseLike<T>) {
  const state = { settled: false };
  const result = Promise.resolve(request).then((value) => {
    state.settled = true;
    return value;
  });
  return { state, result };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('product images and review', () => {
  it('a rejected product takes new photos (still REJECTED); once resubmitted, no image can be added, replaced, reordered or removed', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000071', 'Photo Seller');
    const { product } = await rejectedProduct(adminToken, seller, 'Image does not match the product');

    // Correcting the rejected product: photos can change, the status does not.
    await as(seller.token).post(`/seller/products/${product.id}/images`, { key: await uploaded(seller, '#1b5e20') }).expect(201);
    await as(seller.token).post(`/seller/products/${product.id}/images`, { key: await uploaded(seller, '#0d47a1') }).expect(201);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.REJECTED);
    const before = await imagesOf(product.id);
    expect(before).toHaveLength(2);

    // Resubmitted: under review — every image change is refused, nothing moves.
    const second = await submit(seller, [product.id]);
    const newKey = await uploaded(seller, '#b71c1c');
    const refusals = [
      await as(seller.token).post(`/seller/products/${product.id}/images`, { key: newKey }),
      await as(seller.token).patch(`/seller/products/${product.id}/images/${before[0]!.id}`, { key: newKey }),
      await as(seller.token).put(`/seller/products/${product.id}/images/order`, { imageIds: [before[1]!.id, before[0]!.id] }),
      await as(seller.token).delete(`/seller/products/${product.id}/images/${before[1]!.id}`),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(409);
      expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    }
    expect(await imagesOf(product.id)).toEqual(before);
    for (const image of before) expect(await storedUrl(image.url)).toBe(true);

    // Approved with exactly those photos; an approved product's photos are the seller's again.
    await decide(adminToken, second, product.id, 'APPROVED').expect(200);
    expect(await imagesOf(product.id)).toEqual(before);
    await as(seller.token).delete(`/seller/products/${product.id}/images/${before[1]!.id}`).expect(200);
    expect(await dbStatus(product.id)).toBe(ApprovalStatus.APPROVED);
    expect(await storedUrl(before[1]!.url)).toBe(false);
  });

  it('a photo upload racing "Submit for Approval" waits for it, is refused, and leaves no row and no stray file', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000072', 'Race Photo Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    await as(seller.token).post(`/seller/products/${product.id}/images`, { key: await uploaded(seller, '#1b5e20') }).expect(201);
    const before = await imagesOf(product.id);

    const submission = await submissionInProgress(seller, product.id);
    const key = await uploaded(seller, '#e65100');
    const attach = tracked(as(seller.token).post(`/seller/products/${product.id}/images`, { key }));
    await pause(1_200);
    expect(attach.state.settled).toBe(false); // waiting behind the submission

    await submission.finish();
    const res = await attach.result;
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    expect(await imagesOf(product.id)).toEqual(before);
    // The refused upload's processed files are gone; the product's own photo is kept.
    const { imageKey, thumbKey } = optimizedKeysFor(key);
    expect(await storedKey(imageKey)).toBe(false);
    expect(await storedKey(thumbKey)).toBe(false);
    expect(await storedUrl(before[0]!.url)).toBe(true);
  });

  it('a photo replace or remove racing "Submit for Approval" is refused; the submitted photo and its file stay', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000073', 'Race Replace Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    await as(seller.token).post(`/seller/products/${product.id}/images`, { key: await uploaded(seller, '#1b5e20') }).expect(201);
    await as(seller.token).post(`/seller/products/${product.id}/images`, { key: await uploaded(seller, '#0d47a1') }).expect(201);
    const before = await imagesOf(product.id);

    const submission = await submissionInProgress(seller, product.id);
    const replacement = await uploaded(seller, '#4a148c');
    const replace = tracked(as(seller.token).patch(`/seller/products/${product.id}/images/${before[0]!.id}`, { key: replacement }));
    const remove = tracked(as(seller.token).delete(`/seller/products/${product.id}/images/${before[1]!.id}`));
    const reorder = tracked(as(seller.token).put(`/seller/products/${product.id}/images/order`, { imageIds: [before[1]!.id, before[0]!.id] }));
    await pause(1_200);
    expect([replace.state.settled, remove.state.settled, reorder.state.settled]).toEqual([false, false, false]);

    await submission.finish();
    for (const res of [await replace.result, await remove.result, await reorder.result]) expect(res.status).toBe(409);
    expect(await imagesOf(product.id)).toEqual(before);
    for (const image of before) expect(await storedUrl(image.url)).toBe(true);
    const { imageKey } = optimizedKeysFor(replacement);
    expect(await storedKey(imageKey)).toBe(false);
  });

  it('a photo change that lands before the submission is part of what is reviewed', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000074', 'Order Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    await as(seller.token).post(`/seller/products/${product.id}/images`, { key: await uploaded(seller, '#1b5e20') }).expect(201);
    const second = await submit(seller, [product.id]);
    const review = expectSuccess<{ items: { product: { images: { url: string }[] } | null }[] }>(
      (await as(adminToken).get(`/admin/approval-batches/${second.id}`).expect(200)).body,
    ).data;
    expect(review.items[0]!.product!.images.map((i) => i.url)).toEqual((await imagesOf(product.id)).map((i) => i.url));
  });
});

describe('never-submitted drafts are left alone', () => {
  it('resubmitting, approving and rejecting other products never submits, approves or changes a draft', async () => {
    const adminToken = await loginAdmin();
    const seller = await seedSeller('9700000075', 'Draft Seller');
    const { product } = await rejectedProduct(adminToken, seller);
    // Created after the first submission and never submitted (like a seller's new, unsent products).
    const drafts = [await createProduct(seller), await createProduct(seller), await createProduct(seller)];
    const before = await prisma.product.findMany({ where: { id: { in: drafts.map((d) => d.id) } }, orderBy: { id: 'asc' } });

    await as(seller.token).patch(`/seller/products/${product.id}`, { name: 'Corrected Name' }).expect(200);
    const second = await submit(seller, [product.id]);
    expect(second.items.map((i) => i.productId)).toEqual([product.id]);
    await decide(adminToken, second, product.id, 'APPROVED').expect(200);

    expect(await prisma.product.findMany({ where: { id: { in: drafts.map((d) => d.id) } }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.productApprovalBatchItem.count({ where: { productId: { in: drafts.map((d) => d.id) } } })).toBe(0);
    for (const draft of drafts) expect(await customerSees(draft.id)).toBe(false);
  });
});
