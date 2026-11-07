/**
 * Seller product photos attached together (POST /seller/products/:id/images/batch)
 * and the single attach that now shares its path (seller-image.service
 * attachSellerImages):
 *
 *   - several uploads become rows in the order given, after the current last
 *     image, each stored as WebP (+ card thumbnail for large photos);
 *   - one unusable upload never stops the others — it is reported, and
 *     nothing of it is left in storage;
 *   - refused whole (and every file just processed removed) when the product
 *     is under review or the gallery would pass 8 photos;
 *   - another seller's upload or product, and the same upload twice, are refused;
 *   - query budget: the database round trips one photo, and three, cost.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, SellerType, UnitType, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import { storage, storageKeyFromUrl } from '../../src/infra/storage';
import { sellerImageFolder } from '../../src/modules/catalog/seller-image.service';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';

let queries = 0;
let counting = false;
// Prisma checks a pooled connection that has sat idle with a bare `SELECT 1`
// before handing it out. That probe is the pool's, not the attach path's: it
// appears only when an earlier test left a connection idle (seen as 16 vs 15),
// so it is not counted.
const isPoolProbe = (query: string) => query.trim() === 'SELECT 1';
(prisma as unknown as { $on: (event: 'query', cb: (e: { query: string }) => void) => void }).$on('query', (e) => {
  if (counting && !isPoolProbe(e.query)) queries += 1;
});

interface Seller {
  id: string;
  token: string;
  categoryId: string;
}

const as = (token: string) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', bearer(token)),
  post: (path: string, body: object = {}) => api().post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body),
});

async function seedSeller(mobile: string): Promise<Seller> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Store ${mobile}`,
      sellerType: SellerType.GROCERY,
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
  const categoryId = expectSuccess<{ categories: { id: string }[] }>((await as(token).post('/seller/categories', { name: 'Grocery' }).expect(201)).body).data
    .categories[0]!.id;
  return { id: seller.id, token, categoryId };
}

async function product(seller: Seller): Promise<string> {
  const res = await as(seller.token)
    .post('/seller/products', {
      categoryId: seller.categoryId,
      name: `Item ${randomUUID().slice(0, 4)}`,
      sku: `SKU-${randomUUID().slice(0, 8)}`,
      variantName: '1 kg',
      unit: UnitType.KG,
      unitValue: 1,
      mrpPaise: 12_000,
      pricePaise: 10_000,
      stockQty: 5,
    })
    .expect(201);
  return expectSuccess<{ id: string }>(res.body).data.id;
}

const photo = (color: string, size = 64) => sharp({ create: { width: size, height: size, channels: 3, background: color } }).jpeg().toBuffer();
/** A file in the seller's own upload folder, as POST /seller/uploads/presign + PUT leave it. */
async function uploaded(seller: Seller, bytes: Buffer | Promise<Buffer>, ext = 'jpg', type = 'image/jpeg'): Promise<string> {
  const key = `${sellerImageFolder(seller.id)}/${randomUUID()}.${ext}`;
  await storage.put(key, await bytes, type);
  return key;
}
const stored = async (key: string) => (await storage.get(key, 20 * 1024 * 1024)) !== null;
const imagesOf = (productId: string) =>
  prisma.productImage.findMany({ where: { productId }, orderBy: { displayOrder: 'asc' }, select: { id: true, url: true, thumbUrl: true, displayOrder: true } });
const base = (url: string) => storageKeyFromUrl(url)!.replace(/(-thumb)?\.webp$/, '');
const batch = (seller: Seller, productId: string, keys: string[]) =>
  as(seller.token).post(`/seller/products/${productId}/images/batch`, { images: keys.map((key) => ({ key })) });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('several photos at once', () => {
  it('three uploads become three rows in the order given, after the existing photo, stored as WebP', async () => {
    const seller = await seedSeller('9600004001');
    const id = await product(seller);
    await as(seller.token).post(`/seller/products/${id}/images`, { key: await uploaded(seller, photo('#111111')) }).expect(201);
    const keys = [await uploaded(seller, photo('#aa0000', 1600)), await uploaded(seller, photo('#00aa00')), await uploaded(seller, photo('#0000aa'))];

    const res = await batch(seller, id, keys).expect(201);
    const body = expectSuccess<{ images: { id: string; url: string; displayOrder: number }[]; failed: unknown[] }>(res.body).data;
    expect(body.failed).toEqual([]);

    const rows = await imagesOf(id);
    expect(rows.map((row) => row.displayOrder)).toEqual([0, 1, 2, 3]);
    expect(rows.slice(1).map((row) => base(row.url))).toEqual(keys.map((key) => key.replace(/\.jpg$/, '')));
    expect(rows.every((row) => row.url.endsWith('.webp'))).toBe(true);
    // The large photo got its own card thumbnail; the small ones serve the card themselves.
    expect(rows[1]!.thumbUrl).toMatch(/-thumb\.webp$/);
    expect(rows[2]!.thumbUrl).toBe(rows[2]!.url);
    // The answer is the product's gallery, in the same order as the product page lists it.
    expect(body.images.map((image) => image.id)).toEqual(rows.map((row) => row.id));
    const page = expectSuccess<{ images: unknown[] }>((await as(seller.token).get(`/seller/products/${id}`).expect(200)).body).data;
    expect(body.images).toEqual(page.images);
    // Raw uploads are gone; only the stored WebP files remain.
    for (const key of keys) expect(await stored(key)).toBe(false);
    for (const row of rows.slice(1)) expect(await stored(storageKeyFromUrl(row.url)!)).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { action: 'product.image.attach' }, orderBy: { createdAt: 'asc' } });
    expect(audits).toHaveLength(4);
    // Same rows as before: one per photo, entity = the image, after = { productId, key }.
    for (const [index, key] of keys.entries()) {
      const row = audits.find((audit) => audit.entityId === rows[index + 1]!.id)!;
      expect(row).toMatchObject({ entityType: 'ProductImage', before: null, after: { productId: id, key } });
    }
  });

  it('an unusable upload is reported by key; the others are attached; nothing of it is left behind', async () => {
    const seller = await seedSeller('9600004002');
    const id = await product(seller);
    const good1 = await uploaded(seller, photo('#aa0000'));
    const broken = await uploaded(seller, Buffer.from('definitely not an image'), 'png', 'image/png');
    const good2 = await uploaded(seller, photo('#0000aa'));

    const res = await batch(seller, id, [good1, broken, good2]).expect(201);
    const body = expectSuccess<{ failed: { key: string; message: string }[] }>(res.body).data;
    expect(body.failed).toEqual([{ key: broken, message: 'This file is not a valid JPEG, PNG, WebP or AVIF image. Please choose another picture.' }]);
    expect((await imagesOf(id)).map((row) => base(row.url))).toEqual([good1, good2].map((key) => key.replace(/\.jpg$/, '')));
    expect(await stored(broken)).toBe(false);
  });

  it('when no upload can be used, the attach fails with the reason (as a single attach always did)', async () => {
    const seller = await seedSeller('9600004003');
    const id = await product(seller);
    const broken = await uploaded(seller, Buffer.from('nope'), 'png', 'image/png');
    const single = await as(seller.token).post(`/seller/products/${id}/images`, { key: broken });
    expect(single.status).toBe(415);
    const missing = await batch(seller, id, [`${sellerImageFolder(seller.id)}/${randomUUID()}.jpg`]);
    expect(missing.status).toBe(400);
    expect(expectError(missing.body).message).toBe('The uploaded image could not be found. Please upload it again.');
    expect(await imagesOf(id)).toHaveLength(0);
  });

  it('under review: refused whole, no rows, and the uploads are not processed', async () => {
    const seller = await seedSeller('9600004004');
    const id = await product(seller);
    const staff = await prisma.sellerStaff.findFirstOrThrow({ where: { sellerId: seller.id } });
    const review = await prisma.productApprovalBatch.create({ data: { sellerId: seller.id, submittedByUserId: staff.userId } });
    await prisma.productApprovalBatchItem.create({ data: { batchId: review.id, productId: id } });
    await prisma.product.update({ where: { id }, data: { approvalStatus: 'PENDING' } });

    const keys = [await uploaded(seller, photo('#aa0000')), await uploaded(seller, photo('#00aa00'))];
    const res = await batch(seller, id, keys);
    expect(res.status).toBe(409);
    expect(expectError(res.body).message).toBe('This product is under review. It can be edited again if it is rejected.');
    expect(await imagesOf(id)).toHaveLength(0);
    // Refused before any processing: the raw uploads are untouched (a retry after a rejection can use them).
    for (const key of keys) expect(await stored(key)).toBe(true);
  });

  it('the gallery never passes 8 photos: a batch that would is refused whole', async () => {
    const seller = await seedSeller('9600004005');
    const id = await product(seller);
    const first = await Promise.all(Array.from({ length: 6 }, (_, i) => uploaded(seller, photo(`#00${i}0${i}0`))));
    await batch(seller, id, first).expect(201);
    const more = await Promise.all(Array.from({ length: 3 }, (_, i) => uploaded(seller, photo(`#a0${i}0${i}0`))));
    const res = await batch(seller, id, more);
    expect(res.status).toBe(400);
    expect(expectError(res.body).message).toBe('A product can have at most 8 images. Remove one first.');
    expect(await imagesOf(id)).toHaveLength(6);
    await batch(seller, id, more.slice(0, 2)).expect(201);
    expect((await imagesOf(id)).map((row) => row.displayOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("another seller's upload or product, and the same upload twice, are refused", async () => {
    const owner = await seedSeller('9600004006');
    const other = await seedSeller('9600004007');
    const id = await product(owner);
    const theirs = await uploaded(other, photo('#aa0000'));
    const mine = await uploaded(owner, photo('#00aa00'));

    expect((await batch(owner, id, [mine, theirs])).status).toBe(403);
    expect((await batch(other, id, [theirs])).status).toBe(404);
    const twice = await batch(owner, id, [mine, mine]);
    expect(twice.status).toBe(400);
    expect(expectError(twice.body).message).toBe('The same upload was sent twice.');
    expect(await imagesOf(id)).toHaveLength(0);
    expect(await stored(theirs)).toBe(true);
  });

  it('a retried attach (its answer lost) never adds a second row: the photo counts as attached', async () => {
    const seller = await seedSeller('9600004009');
    const id = await product(seller);
    const keys = [await uploaded(seller, photo('#aa0000')), await uploaded(seller, photo('#00aa00'))];
    await batch(seller, id, keys).expect(201);
    const retry = expectSuccess<{ failed: unknown[]; images: unknown[] }>((await batch(seller, id, keys).expect(201)).body).data;
    expect(retry.failed).toEqual([]);
    expect(retry.images).toHaveLength(2);
    // The single route too, and a retry mixed with a new photo adds only the new one.
    await as(seller.token).post(`/seller/products/${id}/images`, { key: keys[0] }).expect(201);
    const fresh = await uploaded(seller, photo('#0000aa'));
    await batch(seller, id, [keys[1]!, fresh]).expect(201);
    expect((await imagesOf(id)).map((row) => base(row.url))).toEqual([...keys, fresh].map((key) => key.replace(/\.jpg$/, '')));
    expect(await prisma.auditLog.count({ where: { action: 'product.image.attach' } })).toBe(3);
  });

  it('query budget: one photo and three photos', async () => {
    const seller = await seedSeller('9600004008');
    const id = await product(seller);
    const one = await uploaded(seller, photo('#aa0000'));
    queries = 0;
    counting = true;
    await as(seller.token).post(`/seller/products/${id}/images`, { key: one }).expect(201);
    counting = false;
    const single = queries;

    const three = [await uploaded(seller, photo('#00aa00')), await uploaded(seller, photo('#0000aa')), await uploaded(seller, photo('#aaaa00'))];
    queries = 0;
    counting = true;
    await batch(seller, id, three).expect(201);
    counting = false;
    const batchThree = queries;
    const solo = await uploaded(seller, photo('#00aaaa'));
    queries = 0;
    counting = true;
    await batch(seller, id, [solo]).expect(201);
    counting = false;
    const batchOne = queries;
    // Was 29 per photo (87 for three, one after another). The old single route still answers with the whole product.
    console.log(`attach query budget: single route ${single}, batch of one ${batchOne}, batch of three ${batchThree}`);
    expect(single).toBeLessThanOrEqual(20);
    expect(batchOne).toBeLessThanOrEqual(13);
    expect(batchThree).toBeLessThanOrEqual(batchOne + 4);
  });
});
