/**
 * isStorageKeyReferenced — "is any stored row still pointing at this file?" —
 * now one SQL statement instead of seven queries. Same answer: every table and
 * column that can hold an image URL counts; the match is "ends with /<key>";
 * LIKE wildcards in a key (_ %) are literal, never wildcards.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, truncateAll } from '../helpers/db';
import { isStorageKeyReferenced } from '../../src/modules/catalog/uploaded-image.service';
import { seedProduct, seedStore } from '../helpers/fixtures';

const url = (key: string) => `https://cdn.example.test/storage/${key}`;

beforeEach(async () => {
  await truncateAll();
});

describe('isStorageKeyReferenced', () => {
  it('finds a key in every image column, and only an exact "/<key>" ending', async () => {
    const storeId = await seedStore();
    const product = (await seedProduct(storeId, { name: 'Ref Check' }))!;
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.productId } });
    const category = await prisma.category.findFirstOrThrow();
    const keys = Array.from({ length: 10 }, () => `products/s-test/${randomUUID()}.webp`);
    for (const key of keys) expect(await isStorageKeyReferenced(key)).toBe(false);

    await prisma.productImage.create({ data: { productId: product.productId, url: url(keys[0]!), displayOrder: 0 } });
    await prisma.productImage.create({ data: { productId: product.productId, url: url('other.webp'), thumbUrl: url(keys[1]!), displayOrder: 1 } });
    await prisma.productImage.create({ data: { productId: product.productId, url: url('other2.webp'), cardUrl: url(keys[2]!), displayOrder: 2 } });
    await prisma.category.update({ where: { id: category.id }, data: { imageUrl: url(keys[3]!) } });
    await prisma.productVariant.update({ where: { id: variant.id }, data: { imageUrl: url(keys[4]!) } });
    await prisma.brand.create({ data: { name: `Brand ${randomUUID().slice(0, 6)}`, slug: `brand-${randomUUID().slice(0, 6)}`, logoUrl: url(keys[5]!) } });
    await prisma.banner.create({ data: { placement: 'home_top', imageUrl: url(keys[6]!), imageWidth: 1200, imageHeight: 400 } });
    const seller = await prisma.seller.findFirstOrThrow();
    await prisma.restaurantProfile.create({ data: { sellerId: seller.id, cuisine: [], logoUrl: url(keys[7]!), coverImageUrl: url(keys[8]!), menuImageUrl: url(keys[9]!) } });

    for (const key of keys) expect(await isStorageKeyReferenced(key)).toBe(true);
    // A longer key that merely contains / ends differently never matches.
    expect(await isStorageKeyReferenced(`x${keys[0]!}`)).toBe(false);
    expect(await isStorageKeyReferenced(keys[0]!.replace('.webp', '.web'))).toBe(false);
  });

  it('LIKE wildcards in a key are literal (an "_" or "%" never matches another character)', async () => {
    const storeId = await seedStore();
    const product = (await seedProduct(storeId, { name: 'Wildcards' }))!;
    await prisma.productImage.create({ data: { productId: product.productId, url: url('products/a-b.webp'), displayOrder: 0 } });
    await prisma.productImage.create({ data: { productId: product.productId, url: url('products/c100d.webp'), displayOrder: 1 } });
    expect(await isStorageKeyReferenced('products/a_b.webp')).toBe(false);
    expect(await isStorageKeyReferenced('products/c%d.webp')).toBe(false);
    expect(await isStorageKeyReferenced('products/a-b.webp')).toBe(true);
  });
});
