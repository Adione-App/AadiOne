/**
 * Seller image folders (seller-image.service): named by an HMAC of the seller
 * id. SELLER_IMAGE_FOLDER_KEY decouples that HMAC from JWT_SECRET, so the
 * token-signing key can be rotated without moving every seller's folder.
 * Unset (as in tests), the folder is exactly what it always was.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { sellerImageFolder, sellerImageFolderFor } from '../../src/modules/catalog/seller-image.service';

const SELLER = '6f1c2a9e-3b7d-4e58-9a10-2c4b6d8e0f12';

/** The original formula, written out independently. */
const original = (sellerId: string, key: string) =>
  `products/s-${createHmac('sha256', key).update(`seller-image-folder:${sellerId}`).digest('hex').slice(0, 24)}`;

describe('seller image folder key', () => {
  it('without SELLER_IMAGE_FOLDER_KEY, folders are unchanged: the HMAC still uses JWT_SECRET', () => {
    expect(env.SELLER_IMAGE_FOLDER_KEY).toBeUndefined();
    expect(sellerImageFolder(SELLER)).toBe(original(SELLER, env.JWT_SECRET));
  });

  it('a given key always names the same folder, and the folder depends only on that key', () => {
    const key = 'folder-key-test-0123456789-abcdefghijklmnop';
    expect(sellerImageFolderFor(SELLER, key)).toBe(original(SELLER, key));
    expect(sellerImageFolderFor(SELLER, key)).toBe(sellerImageFolderFor(SELLER, key));
    expect(sellerImageFolderFor(SELLER, key)).not.toBe(sellerImageFolderFor(SELLER, `${key}-rotated`));
  });

  it('with SELLER_IMAGE_FOLDER_KEY set, folders use it — not JWT_SECRET', () => {
    const key = 'dedicated-folder-key-test-0123456789-abcdef';
    const mutable = env as { SELLER_IMAGE_FOLDER_KEY?: string };
    mutable.SELLER_IMAGE_FOLDER_KEY = key;
    try {
      expect(sellerImageFolder(SELLER)).toBe(original(SELLER, key));
      expect(sellerImageFolder(SELLER)).not.toBe(original(SELLER, env.JWT_SECRET));
    } finally {
      delete mutable.SELLER_IMAGE_FOLDER_KEY;
    }
  });

  it('keeping the folder key while rotating JWT_SECRET keeps every folder where it is', () => {
    const currentJwtSecret = env.JWT_SECRET;
    // Rotation recipe: SELLER_IMAGE_FOLDER_KEY := current JWT_SECRET, then change JWT_SECRET.
    expect(sellerImageFolderFor(SELLER, currentJwtSecret)).toBe(sellerImageFolder(SELLER));
  });

  it('different sellers get different, well-formed folders', () => {
    const other = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';
    expect(sellerImageFolder(SELLER)).not.toBe(sellerImageFolder(other));
    expect(sellerImageFolder(SELLER)).toMatch(/^products\/s-[0-9a-f]{24}$/);
  });
});
