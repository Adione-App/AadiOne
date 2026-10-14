/**
 * A restaurant's / cafe's customer-facing branding — its round LOGO and wide
 * COVER photo (RestaurantProfile.logoUrl / coverImageUrl), shown on the Food
 * list card and the menu page. Admin-managed (Admin Panel → Seller →
 * Restaurant), through the same admin upload + image pipeline as banners and
 * category images: the browser uploads to an admin-only key, the server
 * validates it and stores an optimised WebP in PUBLIC storage, and a replaced
 * or removed image's file is deleted once nothing references it.
 *
 * Sellers cannot change these here: a restaurant's profile they manage
 * (cuisine, veg-only, prep time) carries no images.
 */

import { ErrorCode, isFoodSellerType } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { assertAdminKey } from '../admin/admin-upload.service';
import { processUploadedImage, removeStoredImageIfUnused } from '../catalog/uploaded-image.service';

export type RestaurantImageKind = 'logo' | 'cover';

const COLUMN: Record<RestaurantImageKind, 'logoUrl' | 'coverImageUrl'> = { logo: 'logoUrl', cover: 'coverImageUrl' };

export interface RestaurantBrandingDto {
  sellerId: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
}

async function loadRestaurant(sellerId: string) {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null },
    select: { id: true, sellerType: true, restaurantProfile: { select: { logoUrl: true, coverImageUrl: true } } },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Restaurant not found.' });
  if (!isFoodSellerType(seller.sellerType)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Logo and cover photos are for restaurants and cafes.' });
  }
  return seller;
}

async function apply(sellerId: string, kind: RestaurantImageKind, url: string | null, actorUserId: string): Promise<RestaurantBrandingDto> {
  const seller = await loadRestaurant(sellerId);
  const before = seller.restaurantProfile?.[COLUMN[kind]] ?? null;
  const profile = await prisma.restaurantProfile.upsert({
    where: { sellerId },
    // A restaurant that has not filled in its profile yet gets an empty one,
    // so the photo is kept; the seller's own fields stay as they are.
    create: { sellerId, cuisine: [], [COLUMN[kind]]: url },
    update: { [COLUMN[kind]]: url },
    select: { logoUrl: true, coverImageUrl: true },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: url ? `restaurant.${kind}.set` : `restaurant.${kind}.remove`,
      entityType: 'Seller',
      entityId: sellerId,
      before: { [COLUMN[kind]]: before },
      after: { [COLUMN[kind]]: url },
    },
  });
  if (before && before !== url) await removeStoredImageIfUnused(before);
  return { sellerId, ...profile };
}

/** PUT /admin/restaurants/:sellerId/images/:kind — attach an admin upload as the logo / cover. */
export async function setRestaurantImage(sellerId: string, kind: RestaurantImageKind, key: string, actorUserId: string): Promise<RestaurantBrandingDto> {
  assertAdminKey(key);
  await loadRestaurant(sellerId);
  // Cover: the wide banner profile (and its minimum width); logo: the square-ish category profile.
  const image = await processUploadedImage(key, kind === 'cover' ? 'banner' : 'category');
  return apply(sellerId, kind, image.url, actorUserId);
}

/** DELETE /admin/restaurants/:sellerId/images/:kind — back to no logo / cover. */
export function removeRestaurantImage(sellerId: string, kind: RestaurantImageKind, actorUserId: string): Promise<RestaurantBrandingDto> {
  return apply(sellerId, kind, null, actorUserId);
}
