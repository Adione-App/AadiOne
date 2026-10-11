/**
 * Seller product removal and bulk actions, end to end (real app, database and
 * local storage): a product nothing references is deleted with its files; one
 * with order or review history is removed but kept; an order in progress
 * blocks removal; ownership and Aadione's lock are enforced by the API; bulk
 * hide / show / delete report every product; repeats are harmless.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, UserRole, type ProductImportDto } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { makeZip } from '../helpers/zip';
import { cache } from '../../src/infra/cache';
import { storage, storageKeyFromUrl } from '../../src/infra/storage';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { cleanupProductImports, importQueuesIdle } from '../../src/modules/product-import/import-worker';
import { processImport } from '../../src/modules/product-import/import-processing';
import { sellerImageFolder } from '../../src/modules/catalog/seller-image.service';

interface Seller {
  id: string;
  token: string;
}

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set('Authorization', bearer(token)),
  post: (p: string, body: object = {}) => api().post(`/api/v1${p}`).set('Authorization', bearer(token)).send(body),
  delete: (p: string) => api().delete(`/api/v1${p}`).set('Authorization', bearer(token)),
});

async function seedSeller(mobile: string): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Kirana ${mobile}`,
      sellerType: 'GROCERY',
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
  await as(token).post('/seller/categories', { name: 'Snacks' }).expect(201);
  return { id: seller.id, token };
}

const jpeg = (color: string) => sharp({ create: { width: 700, height: 700, channels: 3, background: color } }).jpeg().toBuffer();

/** Products through the bulk import (with photos), by SKU. */
async function seedProducts(seller: Seller, items: { sku: string; image?: string }[], images: Record<string, Buffer> = {}) {
  const csv = [
    'seller_sku,product_name,category,mrp,selling_price,stock_quantity,unit,unit_value,image_filename',
    ...items.map((i) => [i.sku, `Item ${i.sku}`, 'Snacks', '20', '18', '5', 'g', '100', i.image ?? ''].join(',')),
  ].join('\n');
  let req = api().post('/api/v1/seller/imports').set('Authorization', bearer(seller.token)).field('mode', 'CREATE').attach('file', Buffer.from(csv), 'p.csv');
  if (Object.keys(images).length > 0) req = req.attach('archive', makeZip(Object.entries(images).map(([name, data]) => ({ name, data }))), 'photos.zip');
  const res = await req;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await importQueuesIdle();
  const job = expectSuccess<ProductImportDto>(res.body).data;
  await as(seller.token).post(`/seller/imports/${job.id}/confirm`, { mode: 'CREATE' }).expect(200);
  await importQueuesIdle();
  const out: Record<string, { productId: string; variantId: string; listingId: string }> = {};
  for (const { sku } of items) {
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { sellerListings: true } });
    out[sku] = { productId: v.productId, variantId: v.id, listingId: v.sellerListings[0]!.id };
  }
  return out;
}

let orderSeq = 0;
/** An order line for this listing, at the given order / seller-order status. */
async function orderWith(sellerId: string, listing: { variantId: string; listingId: string }, status: { order: string; seller: string }) {
  const customer = await prisma.user.create({ data: { mobile: `95000${String(++orderSeq).padStart(5, '0')}`, fullName: 'Customer', role: UserRole.CUSTOMER } });
  const order = await prisma.order.create({
    data: {
      orderNumber: `T-${randomUUID().slice(0, 12)}`,
      userId: customer.id,
      status: status.order as never,
      paymentMethod: 'COD',
      itemsSubtotalPaise: 1800,
      totalPaise: 1800,
      currentPayablePaise: 1800,
      deliveryFullName: 'Customer',
      deliveryMobile: customer.mobile!,
      deliveryAddressLine: 'Main Road',
      deliveryCity: 'Sikar',
      deliveryState: 'Rajasthan',
      deliveryPincode: '332001',
      deliveryLatitude: 27.62,
      deliveryLongitude: 75.14,
      distanceKm: 1,
    },
  });
  const sellerOrder = await prisma.sellerOrder.create({
    data: { orderId: order.id, sellerId, status: status.seller as never, subtotalPaise: 1800, commissionBp: 0, commissionPaise: 0 },
  });
  return prisma.orderItem.create({
    data: {
      sellerOrderId: sellerOrder.id,
      variantId: listing.variantId,
      sellerListingId: listing.listingId,
      productName: 'Item',
      variantName: '100 g',
      sku: 'X',
      unitDisplay: '100 g',
      qty: 1,
      mrpPaise: 2000,
      unitPricePaise: 1800,
      lineTotalPaise: 1800,
    },
  });
}

const stored = async (url: string) => (await storage.get(storageKeyFromUrl(url)!, 20 * 1024 * 1024)) !== null;

/** A READY preview whose rows all use the same photo, x.jpg (stored once by the import). */
async function previewShared(seller: Seller, skus: string[], photo: Buffer): Promise<ProductImportDto> {
  const csv = [
    'seller_sku,product_name,category,mrp,selling_price,stock_quantity,unit,unit_value,image_filename',
    ...skus.map((sku) => [sku, `Item ${sku}`, 'Snacks', '20', '18', '5', 'g', '100', 'x.jpg'].join(',')),
  ].join('\n');
  const res = await api()
    .post('/api/v1/seller/imports')
    .set('Authorization', bearer(seller.token))
    .field('mode', 'CREATE')
    .attach('file', Buffer.from(csv), 'p.csv')
    .attach('archive', makeZip([{ name: 'x.jpg', data: photo }]), 'photos.zip');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await importQueuesIdle();
  const job = await importOf(seller, expectSuccess<ProductImportDto>(res.body).data.id);
  expect(job).toMatchObject({ status: 'READY', readyRows: skus.length });
  return job;
}

const importOf = async (seller: Seller, id: string) => expectSuccess<ProductImportDto>((await as(seller.token).get(`/seller/imports/${id}`).expect(200)).body).data;

/** The worker picks the import up again (as after a restart / an expired lease) and runs it to the end. */
async function runImport(id: string) {
  await prisma.productImport.update({ where: { id }, data: { status: 'QUEUED', heartbeatAt: null, workerId: null } });
  await processImport(id);
}

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('DELETE /seller/products/:id', () => {
  it('deletes a product nothing references, with its rows and the photo files no other product uses', async () => {
    const seller = await seedSeller('9400001301');
    const p = await seedProducts(seller, [{ sku: 'DEL-1', image: 'del.jpg' }, { sku: 'KEEP-1', image: 'shared.jpg' }, { sku: 'DEL-2', image: 'shared.jpg' }], {
      'del.jpg': await jpeg('#c62828'),
      'shared.jpg': await jpeg('#1565c0'),
    });
    const ownImage = (await prisma.productImage.findFirstOrThrow({ where: { productId: p['DEL-1']!.productId } })).url;
    const sharedImage = (await prisma.productImage.findFirstOrThrow({ where: { productId: p['DEL-2']!.productId } })).url;
    expect(await stored(ownImage)).toBe(true);

    const res = expectSuccess<{ outcome: string; message: string }>((await as(seller.token).delete(`/seller/products/${p['DEL-1']!.productId}`).expect(200)).body).data;
    expect(res).toMatchObject({ outcome: 'DELETED', message: 'Item DEL-1 was deleted permanently.' });
    expect(await prisma.product.findUnique({ where: { id: p['DEL-1']!.productId } })).toBeNull();
    expect(await prisma.productVariant.count({ where: { productId: p['DEL-1']!.productId } })).toBe(0);
    expect(await prisma.sellerListing.findUnique({ where: { id: p['DEL-1']!.listingId } })).toBeNull();
    expect(await prisma.stockLedger.count({ where: { sellerListingId: p['DEL-1']!.listingId } })).toBe(0);
    // The import that stored del.jpg still holds it; import retention removes it later (tested below).
    expect(await stored(ownImage)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'product.seller_delete_permanent', entityId: p['DEL-1']!.productId } })).toBe(1);

    // A photo another product still shows stays in storage.
    await as(seller.token).delete(`/seller/products/${p['DEL-2']!.productId}`).expect(200);
    // The import stored shared.jpg once; KEEP-1 still shows it.
    expect((await prisma.productImage.findFirstOrThrow({ where: { productId: p['KEEP-1']!.productId } })).url).toBe(sharedImage);
    expect(await stored(sharedImage)).toBe(true);
    expect(await prisma.product.findUnique({ where: { id: p['KEEP-1']!.productId } })).not.toBeNull();

    // A second delete of the same product is a plain 404.
    expect((await as(seller.token).delete(`/seller/products/${p['DEL-1']!.productId}`)).status).toBe(404);
  });

  it('photos uploaded with the product form: an unused photo is deleted, one another product shows is kept', async () => {
    const seller = await seedSeller('9400001325');
    const snacks = await prisma.category.findFirstOrThrow({ where: { sellerId: seller.id, name: 'Snacks' } });
    const make = async (sku: string) =>
      expectSuccess<{ id: string }>(
        (
          await as(seller.token)
            .post('/seller/products', { categoryId: snacks.id, name: `Item ${sku}`, sku, variantName: '100 g', unit: 'G', unitValue: 100, mrpPaise: 2000, pricePaise: 1800, stockQty: 5 })
            .expect(201)
        ).body,
      ).data.id;
    // A raw upload in the seller's own space, as the browser's direct upload leaves it.
    const upload = async (color: string) => {
      const key = `${sellerImageFolder(seller.id)}/${randomUUID()}.jpg`;
      await storage.put(key, await jpeg(color), 'image/jpeg');
      return key;
    };
    const attach = async (productId: string, key: string) => {
      expect([200, 201]).toContain((await as(seller.token).post(`/seller/products/${productId}/images`, { key })).status);
      return prisma.productImage.findFirstOrThrow({ where: { productId } });
    };
    const own = await make('UP-OWN');
    const shareA = await make('UP-SA');
    const shareB = await make('UP-SB');
    const ownImage = await attach(own, await upload('#4e342e'));
    const sharedKey = await upload('#283593');
    const sharedImage = await attach(shareA, sharedKey);
    expect((await attach(shareB, sharedKey)).url).toBe(sharedImage.url);
    const files = (i: { url: string; thumbUrl: string | null; cardUrl: string | null }) => [...new Set([i.url, i.thumbUrl, i.cardUrl].filter((u): u is string => Boolean(u)))];
    for (const f of [...files(ownImage), ...files(sharedImage)]) expect(await stored(f)).toBe(true);

    await as(seller.token).delete(`/seller/products/${own}`).expect(200);
    for (const f of files(ownImage)) expect(await stored(f)).toBe(false);

    await as(seller.token).delete(`/seller/products/${shareA}`).expect(200);
    for (const f of files(sharedImage)) expect(await stored(f)).toBe(true); // UP-SB still shows it
    await as(seller.token).delete(`/seller/products/${shareB}`).expect(200);
    for (const f of files(sharedImage)) expect(await stored(f)).toBe(false);
  });

  it('keeps a photo a failed import row still needs: deleting product A keeps x.jpg, and retrying row B still works', async () => {
    const seller = await seedSeller('9400001321');
    const thief = await seedSeller('9400001322');
    const job = await previewShared(seller, ['SH-A', 'SH-B'], await jpeg('#6a1b9a'));
    // After the preview another seller takes SKU SH-B: row A is created, row B fails.
    const theirs = await seedProducts(thief, [{ sku: 'SH-B' }]);
    await runImport(job.id);
    expect(await importOf(seller, job.id)).toMatchObject({ createdCount: 1, failedCount: 1 });
    const a = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'SH-A' }, include: { product: { include: { images: true } } } });
    const photo = a.product.images[0]!.url;
    expect(await stored(photo)).toBe(true);

    // A is deleted permanently, but x.jpg stays: the failed row B (retryable) still points at it.
    const removed = expectSuccess<{ outcome: string }>((await as(seller.token).delete(`/seller/products/${a.productId}`).expect(200)).body).data;
    expect(removed.outcome).toBe('DELETED');
    expect(await prisma.product.findUnique({ where: { id: a.productId } })).toBeNull();
    expect(await stored(photo)).toBe(true);

    // The SKU is free again: retrying B creates it with the same, still stored photo.
    await as(thief.token).delete(`/seller/products/${theirs['SH-B']!.productId}`).expect(200);
    await as(seller.token).post(`/seller/imports/${job.id}/retry`).expect(200);
    await importQueuesIdle();
    expect(await importOf(seller, job.id)).toMatchObject({ status: 'COMPLETED', failedCount: 0 });
    const b = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'SH-B' }, include: { product: { include: { images: true } } } });
    expect(b.product.submittedBySellerId).toBe(seller.id);
    expect(b.product.images[0]!.url).toBe(photo);
    expect(await stored(photo)).toBe(true);
  });

  it('keeps a photo an import that is still processing will attach to a later row', async () => {
    const seller = await seedSeller('9400001323');
    const job = await previewShared(seller, ['PR-A', 'PR-B'], await jpeg('#00838f'));
    const rowB = await prisma.productImportRow.findFirstOrThrow({ where: { importId: job.id, sku: 'PR-B' } });
    // The worker has written A's batch; B's batch is still to come (the job is mid-processing).
    await prisma.productImportRow.update({ where: { id: rowB.id }, data: { status: 'EXCLUDED' } });
    await runImport(job.id);
    await prisma.productImportRow.update({ where: { id: rowB.id }, data: { status: 'READY' } });
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'PROCESSING', completedAt: null, heartbeatAt: new Date() } });
    const a = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'PR-A' }, include: { product: { include: { images: true } } } });
    const photo = a.product.images[0]!.url;

    await as(seller.token).delete(`/seller/products/${a.productId}`).expect(200);
    expect(await stored(photo)).toBe(true);

    // The import carries on and attaches the same photo to B.
    await runImport(job.id);
    const b = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'PR-B' }, include: { product: { include: { images: true } } } });
    expect(b.product.images[0]!.url).toBe(photo);
    expect(await stored(photo)).toBe(true);
  });

  it('import retention still removes the photo once the import is cleaned up and nothing uses it', async () => {
    const seller = await seedSeller('9400001324');
    const job = await previewShared(seller, ['RT-A'], await jpeg('#ef6c00'));
    await runImport(job.id);
    const a = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'RT-A' }, include: { product: { include: { images: true } } } });
    const photo = a.product.images[0]!.url;
    await as(seller.token).delete(`/seller/products/${a.productId}`).expect(200);
    expect(await stored(photo)).toBe(true); // the import still holds it

    // Retention: completed long ago -> its images are released, then its rows dropped.
    await prisma.productImport.update({ where: { id: job.id }, data: { completedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000) } });
    await cleanupProductImports();
    expect(await prisma.productImportImage.count({ where: { importId: job.id } })).toBe(0);
    expect(await stored(photo)).toBe(false);
  });

  it('keeps a product with finished orders (removed, history intact) and refuses one with an order in progress', async () => {
    const seller = await seedSeller('9400001302');
    const p = await seedProducts(seller, [{ sku: 'HIS-1', image: 'h.jpg' }, { sku: 'OPEN-1' }], { 'h.jpg': await jpeg('#2e7d32') });
    const item = await orderWith(seller.id, p['HIS-1']!, { order: 'DELIVERED', seller: 'READY_FOR_PICKUP' });
    await orderWith(seller.id, p['OPEN-1']!, { order: 'PROCESSING', seller: 'ACCEPTED' });
    const image = (await prisma.productImage.findFirstOrThrow({ where: { productId: p['HIS-1']!.productId } })).url;

    const res = expectSuccess<{ outcome: string; message: string }>((await as(seller.token).delete(`/seller/products/${p['HIS-1']!.productId}`).expect(200)).body).data;
    expect(res.outcome).toBe('ARCHIVED');
    expect(res.message).toMatch(/order or review history/);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: p['HIS-1']!.productId } })).toMatchObject({ status: 'INACTIVE', deletedAt: expect.any(Date) });
    expect(await prisma.sellerListing.findUniqueOrThrow({ where: { id: p['HIS-1']!.listingId } })).toMatchObject({ isAvailable: false });
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ variantId: p['HIS-1']!.variantId, sellerListingId: p['HIS-1']!.listingId });
    expect(await stored(image)).toBe(true);
    // Gone from the seller's lists (products and listings).
    const products = expectSuccess<{ id: string }[]>((await as(seller.token).get('/seller/products').expect(200)).body).data;
    const listings = expectSuccess<{ id: string }[]>((await as(seller.token).get('/seller/listings').expect(200)).body).data;
    expect(products.map((x) => x.id)).not.toContain(p['HIS-1']!.productId);
    expect(listings.map((x) => x.id)).not.toContain(p['HIS-1']!.listingId);

    const refused = await as(seller.token).delete(`/seller/products/${p['OPEN-1']!.productId}`).expect(409);
    expect(expectError(refused.body).message).toMatch(/1 order with this product is still in progress/);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: p['OPEN-1']!.productId } })).toMatchObject({ deletedAt: null, status: 'ACTIVE' });
  });

  it('keeps a product that went through approval review', async () => {
    const seller = await seedSeller('9400001303');
    const p = await seedProducts(seller, [{ sku: 'REV-1' }]);
    await as(seller.token).post('/seller/approval-batches', { productIds: [p['REV-1']!.productId] }).expect(201);
    const res = expectSuccess<{ outcome: string }>((await as(seller.token).delete(`/seller/products/${p['REV-1']!.productId}`).expect(200)).body).data;
    expect(res.outcome).toBe('ARCHIVED');
    expect(await prisma.productApprovalBatchItem.count({ where: { productId: p['REV-1']!.productId } })).toBe(1);
  });

  it('enforces ownership and Aadione’s lock on the server', async () => {
    const owner = await seedSeller('9400001304');
    const other = await seedSeller('9400001305');
    const p = await seedProducts(owner, [{ sku: 'OWN-1' }, { sku: 'LOCK-1' }]);
    await prisma.product.update({ where: { id: p['LOCK-1']!.productId }, data: { status: 'ARCHIVED' } });

    expect((await as(other.token).delete(`/seller/products/${p['OWN-1']!.productId}`)).status).toBe(404);
    expect((await api().delete(`/api/v1/seller/products/${p['OWN-1']!.productId}`)).status).toBe(401);
    const locked = await as(owner.token).delete(`/seller/products/${p['LOCK-1']!.productId}`).expect(403);
    expect(expectError(locked.body).message).toMatch(/Aadione has disabled this product/);
    expect(await prisma.product.count({ where: { id: { in: [p['OWN-1']!.productId, p['LOCK-1']!.productId] }, deletedAt: null } })).toBe(2);
  });
});

describe('POST /seller/products/bulk', () => {
  it('delete: a mixed selection is reported product by product; nothing of another seller is touched', async () => {
    const seller = await seedSeller('9400001311');
    const other = await seedSeller('9400001312');
    const p = await seedProducts(seller, [{ sku: 'B-NEW' }, { sku: 'B-HIS' }, { sku: 'B-OPEN' }]);
    const theirs = await seedProducts(other, [{ sku: 'B-THEIRS' }]);
    await orderWith(seller.id, p['B-HIS']!, { order: 'CANCELLED', seller: 'CANCELLED' });
    await orderWith(seller.id, p['B-OPEN']!, { order: 'PENDING_PAYMENT', seller: 'NEW' });
    const missing = randomUUID();

    const ids = [p['B-NEW']!.productId, p['B-HIS']!.productId, p['B-OPEN']!.productId, theirs['B-THEIRS']!.productId, missing];
    const report = expectSuccess<{ counts: Record<string, number>; results: { productId: string; outcome: string; message: string }[] }>(
      (await as(seller.token).post('/seller/products/bulk', { action: 'DELETE', productIds: ids }).expect(200)).body,
    ).data;
    expect(report.counts).toMatchObject({ DELETED: 1, ARCHIVED: 1, SKIPPED: 3, FAILED: 0 });
    const by = new Map(report.results.map((r) => [r.productId, r]));
    expect(by.get(p['B-NEW']!.productId)!.outcome).toBe('DELETED');
    expect(by.get(p['B-HIS']!.productId)!.outcome).toBe('ARCHIVED');
    expect(by.get(p['B-OPEN']!.productId)).toMatchObject({ outcome: 'SKIPPED', message: expect.stringMatching(/still in progress/) });
    expect(by.get(theirs['B-THEIRS']!.productId)!.outcome).toBe('SKIPPED');
    expect(by.get(missing)!.outcome).toBe('SKIPPED');
    expect(await prisma.product.findUniqueOrThrow({ where: { id: theirs['B-THEIRS']!.productId } })).toMatchObject({ deletedAt: null, status: 'ACTIVE' });

    // Sent again (double click, retry): nothing more happens.
    const again = expectSuccess<{ counts: Record<string, number> }>((await as(seller.token).post('/seller/products/bulk', { action: 'DELETE', productIds: ids }).expect(200)).body).data;
    expect(again.counts).toMatchObject({ DELETED: 0, ARCHIVED: 0, SKIPPED: 5 });
  });

  it('hide / show: changes only the seller’s own products, reports unchanged ones, and respects Aadione’s lock', async () => {
    const seller = await seedSeller('9400001313');
    const other = await seedSeller('9400001314');
    const p = await seedProducts(seller, [{ sku: 'H-1' }, { sku: 'H-2' }, { sku: 'H-LOCK' }]);
    const theirs = await seedProducts(other, [{ sku: 'H-THEIRS' }]);
    await prisma.product.update({ where: { id: p['H-LOCK']!.productId }, data: { status: 'ARCHIVED' } });
    const ids = [p['H-1']!.productId, p['H-2']!.productId, p['H-LOCK']!.productId, theirs['H-THEIRS']!.productId];

    const hidden = expectSuccess<{ counts: Record<string, number> }>((await as(seller.token).post('/seller/products/bulk', { action: 'HIDE', productIds: ids }).expect(200)).body).data;
    expect(hidden.counts).toMatchObject({ HIDDEN: 2, SKIPPED: 2 });
    expect(await prisma.product.count({ where: { id: { in: [p['H-1']!.productId, p['H-2']!.productId] }, status: 'INACTIVE' } })).toBe(2);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: theirs['H-THEIRS']!.productId } })).status).toBe('ACTIVE');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p['H-LOCK']!.productId } })).status).toBe('ARCHIVED');
    // Hidden products keep everything: listing, stock, approval status.
    expect(await prisma.sellerListing.findUniqueOrThrow({ where: { id: p['H-1']!.listingId } })).toMatchObject({ stockQty: 5 });

    const again = expectSuccess<{ counts: Record<string, number> }>((await as(seller.token).post('/seller/products/bulk', { action: 'HIDE', productIds: ids.slice(0, 2) }).expect(200)).body).data;
    expect(again.counts).toMatchObject({ UNCHANGED: 2 });
    const shown = expectSuccess<{ counts: Record<string, number> }>((await as(seller.token).post('/seller/products/bulk', { action: 'SHOW', productIds: ids.slice(0, 2) }).expect(200)).body).data;
    expect(shown.counts).toMatchObject({ SHOWN: 2 });
  });

  it('validates the request', async () => {
    const seller = await seedSeller('9400001315');
    await as(seller.token).post('/seller/products/bulk', { action: 'DELETE', productIds: [] }).expect(400);
    await as(seller.token).post('/seller/products/bulk', { action: 'ARCHIVE', productIds: [randomUUID()] }).expect(400);
    await as(seller.token).post('/seller/products/bulk', { action: 'HIDE', productIds: Array.from({ length: 101 }, () => randomUUID()) }).expect(400);
    await as(seller.token).post('/seller/products/bulk', { action: 'HIDE', productIds: ['not-a-uuid'] }).expect(400);
    expect((await api().post('/api/v1/seller/products/bulk').send({ action: 'HIDE', productIds: [randomUUID()] })).status).toBe(401);
  });
});

describe('removing or replacing a product photo', () => {
  const imageOf = async (sku: string) =>
    (await prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { product: { include: { images: true } } } })).product;

  it('removing a photo keeps x.jpg while a failed import row needs it; retrying that row still works', async () => {
    const seller = await seedSeller('9400001331');
    const thief = await seedSeller('9400001332');
    const job = await previewShared(seller, ['PH-A', 'PH-B'], await jpeg('#5d4037'));
    const theirs = await seedProducts(thief, [{ sku: 'PH-B' }]);
    await runImport(job.id);
    expect(await importOf(seller, job.id)).toMatchObject({ createdCount: 1, failedCount: 1 });
    const a = await imageOf('PH-A');
    const photo = a.images[0]!.url;

    await as(seller.token).delete(`/seller/products/${a.id}/images/${a.images[0]!.id}`).expect(200);
    expect(await prisma.productImage.count({ where: { productId: a.id } })).toBe(0);
    expect(await stored(photo)).toBe(true);

    await as(thief.token).delete(`/seller/products/${theirs['PH-B']!.productId}`).expect(200);
    await as(seller.token).post(`/seller/imports/${job.id}/retry`).expect(200);
    await importQueuesIdle();
    expect(await importOf(seller, job.id)).toMatchObject({ status: 'COMPLETED', failedCount: 0 });
    expect((await imageOf('PH-B')).images[0]!.url).toBe(photo);
    expect(await stored(photo)).toBe(true);
  });

  it('removing a photo while its import is still processing keeps it for the later row', async () => {
    const seller = await seedSeller('9400001333');
    const job = await previewShared(seller, ['PP-A', 'PP-B'], await jpeg('#1b5e20'));
    const rowB = await prisma.productImportRow.findFirstOrThrow({ where: { importId: job.id, sku: 'PP-B' } });
    await prisma.productImportRow.update({ where: { id: rowB.id }, data: { status: 'EXCLUDED' } });
    await runImport(job.id);
    await prisma.productImportRow.update({ where: { id: rowB.id }, data: { status: 'READY' } });
    await prisma.productImport.update({ where: { id: job.id }, data: { status: 'PROCESSING', completedAt: null, heartbeatAt: new Date() } });
    const a = await imageOf('PP-A');
    const photo = a.images[0]!.url;

    await as(seller.token).delete(`/seller/products/${a.id}/images/${a.images[0]!.id}`).expect(200);
    expect(await stored(photo)).toBe(true);

    await runImport(job.id);
    expect((await imageOf('PP-B')).images[0]!.url).toBe(photo);
    expect(await stored(photo)).toBe(true);
  });

  it('replacing a photo keeps an import-held file; normal uploads are still removed when unused, kept when shared', async () => {
    const seller = await seedSeller('9400001334');
    const thief = await seedSeller('9400001335');
    const job = await previewShared(seller, ['RP-A', 'RP-B'], await jpeg('#4a148c'));
    await seedProducts(thief, [{ sku: 'RP-B' }]);
    await runImport(job.id); // RP-A created, RP-B failed (retryable)
    const a = await imageOf('RP-A');
    const importPhoto = a.images[0]!.url;
    const upload = async (color: string) => {
      const key = `${sellerImageFolder(seller.id)}/${randomUUID()}.jpg`;
      await storage.put(key, await jpeg(color), 'image/jpeg');
      return key;
    };

    // Replace the import's photo with a normal upload: the import still holds the old file.
    await api().patch(`/api/v1/seller/products/${a.id}/images/${a.images[0]!.id}`).set('Authorization', bearer(seller.token)).send({ key: await upload('#f9a825') }).expect(200);
    const replaced = (await imageOf('RP-A')).images[0]!;
    expect(replaced.url).not.toBe(importPhoto);
    expect(await stored(importPhoto)).toBe(true);
    expect(await stored(replaced.url)).toBe(true);

    // Normal flow: replacing that upload again removes it (nothing else uses it) ...
    await api().patch(`/api/v1/seller/products/${a.id}/images/${replaced.id}`).set('Authorization', bearer(seller.token)).send({ key: await upload('#00695c') }).expect(200);
    expect(await stored(replaced.url)).toBe(false);
    const current = (await imageOf('RP-A')).images[0]!;

    // ... and a photo shared by two products survives removal from one of them.
    const snacks = await prisma.category.findFirstOrThrow({ where: { sellerId: seller.id, name: 'Snacks' } });
    const other = expectSuccess<{ id: string }>(
      (await as(seller.token).post('/seller/products', { categoryId: snacks.id, name: 'Item RP-C', sku: 'RP-C', variantName: '100 g', unit: 'G', unitValue: 100, mrpPaise: 2000, pricePaise: 1800, stockQty: 5 }).expect(201)).body,
    ).data.id;
    const sharedKey = await upload('#c2185b');
    await as(seller.token).post(`/seller/products/${other}/images`, { key: sharedKey });
    const sharedOnOther = await prisma.productImage.findFirstOrThrow({ where: { productId: other } });
    await as(seller.token).post(`/seller/products/${a.id}/images`, { key: sharedKey });
    const sharedOnA = await prisma.productImage.findFirstOrThrow({ where: { productId: a.id, url: sharedOnOther.url } });
    await as(seller.token).delete(`/seller/products/${a.id}/images/${sharedOnA.id}`).expect(200);
    expect(await stored(sharedOnOther.url)).toBe(true);
    // Removing the last user's copy deletes the file.
    await as(seller.token).delete(`/seller/products/${other}/images/${sharedOnOther.id}`).expect(200);
    expect(await stored(sharedOnOther.url)).toBe(false);
    expect(await stored(current.url)).toBe(true);
  });
});
