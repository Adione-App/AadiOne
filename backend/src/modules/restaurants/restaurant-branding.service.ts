/**
 * A restaurant's / cafe's customer-facing branding (RestaurantProfile):
 *
 *   logo   the round logo on the menu page                       (Admin)
 *   cover  the place itself — storefront / interior — on the
 *          Food list card                                         (Admin + the restaurant)
 *   menu   the food / menu hero at the top of its menu page       (Admin + the restaurant)
 *
 * plus its configured preparation time, which customers see as
 * prepTimeRange() (± 5 min). The restaurant edits its own cover, menu image
 * and time in the Seller Panel; the Admin Panel (Seller → Restaurant) can edit
 * them for any restaurant.
 *
 * Both go through the same image pipeline as banners and product photos: the
 * browser uploads to a key the caller owns (an admin key, or the seller's own
 * folder — never another seller's), the server validates it and stores an
 * optimised WebP in PUBLIC storage, and a replaced or removed image's file is
 * deleted once nothing references it.
 */

import { ErrorCode, isFoodSellerType } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { assertAdminKey } from '../admin/admin-upload.service';
import { processUploadedImage, removeStoredImageIfUnused } from '../catalog/uploaded-image.service';
import { assertOwnSellerKey } from '../catalog/seller-image.service';

export type RestaurantImageKind = 'logo' | 'cover' | 'menu';

/** What a restaurant may change itself (the logo stays an Admin decision). */
export const SELLER_IMAGE_KINDS = ['cover', 'menu'] as const;

const COLUMN: Record<RestaurantImageKind, 'logoUrl' | 'coverImageUrl' | 'menuImageUrl'> = {
  logo: 'logoUrl',
  cover: 'coverImageUrl',
  menu: 'menuImageUrl',
};

/** Same limits as the restaurant's own form (seller-onboarding.validation.ts). */
export const PREP_MINUTES = { min: 1, max: 240 } as const;

export interface RestaurantBrandingDto {
  sellerId: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  menuImageUrl: string | null;
  avgPrepMins: number | null;
}

const BRANDING_SELECT = { logoUrl: true, coverImageUrl: true, menuImageUrl: true, avgPrepMins: true } as const;

async function loadRestaurant(sellerId: string) {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null },
    select: { id: true, sellerType: true, restaurantProfile: { select: BRANDING_SELECT } },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Restaurant not found.' });
  if (!isFoodSellerType(seller.sellerType)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Restaurant images and preparation time are for restaurants and cafes.' });
  }
  return seller;
}

async function audit(actorUserId: string, action: string, sellerId: string, before: unknown, after: unknown): Promise<void> {
  await prisma.auditLog.create({
    data: { actorUserId, action, entityType: 'Seller', entityId: sellerId, before: before as object, after: after as object },
  });
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
    select: BRANDING_SELECT,
  });
  await audit(actorUserId, url ? `restaurant.${kind}.set` : `restaurant.${kind}.remove`, sellerId, { [COLUMN[kind]]: before }, { [COLUMN[kind]]: url });
  if (before && before !== url) await removeStoredImageIfUnused(before);
  return { sellerId, ...profile };
}

/** Cover and menu hero are wide photos (the banner profile and its minimum width); the logo is square-ish. */
const imageProfile = (kind: RestaurantImageKind) => (kind === 'logo' ? 'category' : 'banner');

/** PUT /admin/restaurants/:sellerId/images/:kind — attach an admin upload. */
export async function setRestaurantImage(sellerId: string, kind: RestaurantImageKind, key: string, actorUserId: string): Promise<RestaurantBrandingDto> {
  assertAdminKey(key);
  await loadRestaurant(sellerId);
  const image = await processUploadedImage(key, imageProfile(kind));
  return apply(sellerId, kind, image.url, actorUserId);
}

/** PUT /seller/restaurant/images/:kind — the restaurant's own upload, for its own profile only. */
export async function setOwnRestaurantImage(
  sellerId: string,
  kind: (typeof SELLER_IMAGE_KINDS)[number],
  key: string,
  actorUserId: string,
): Promise<RestaurantBrandingDto> {
  // Only a key from THIS seller's own upload folder — never another seller's file.
  assertOwnSellerKey(sellerId, key);
  await loadRestaurant(sellerId);
  const image = await processUploadedImage(key, imageProfile(kind));
  return apply(sellerId, kind, image.url, actorUserId);
}

/** DELETE …/images/:kind — back to no image of that kind. */
export function removeRestaurantImage(sellerId: string, kind: RestaurantImageKind, actorUserId: string): Promise<RestaurantBrandingDto> {
  return apply(sellerId, kind, null, actorUserId);
}

/** GET …/branding — the current images and time. */
export async function getRestaurantBranding(sellerId: string): Promise<RestaurantBrandingDto> {
  const seller = await loadRestaurant(sellerId);
  return {
    sellerId,
    logoUrl: seller.restaurantProfile?.logoUrl ?? null,
    coverImageUrl: seller.restaurantProfile?.coverImageUrl ?? null,
    menuImageUrl: seller.restaurantProfile?.menuImageUrl ?? null,
    avgPrepMins: seller.restaurantProfile?.avgPrepMins ?? null,
  };
}

/** PUT /admin/restaurants/:sellerId/prep-time — the configured preparation time (minutes), or null to clear it. */
export async function setPrepTime(sellerId: string, avgPrepMins: number | null, actorUserId: string): Promise<RestaurantBrandingDto> {
  if (avgPrepMins !== null && (!Number.isInteger(avgPrepMins) || avgPrepMins < PREP_MINUTES.min || avgPrepMins > PREP_MINUTES.max)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Preparation time must be a whole number of minutes, ${PREP_MINUTES.min}–${PREP_MINUTES.max}.`,
      details: [{ field: 'avgPrepMins', message: 'out of range' }],
    });
  }
  const seller = await loadRestaurant(sellerId);
  const before = seller.restaurantProfile?.avgPrepMins ?? null;
  const profile = await prisma.restaurantProfile.upsert({
    where: { sellerId },
    create: { sellerId, cuisine: [], avgPrepMins },
    update: { avgPrepMins },
    select: BRANDING_SELECT,
  });
  await audit(actorUserId, 'restaurant.prep_time.set', sellerId, { avgPrepMins: before }, { avgPrepMins });
  return { sellerId, ...profile };
}
