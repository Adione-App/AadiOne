/**
 * Banners — admin-managed promotional images, shown wherever a client asks
 * for a placement ("home_top", "home_middle", "food", "category:<id>", …).
 *
 * `placement` is a free-form slug rather than a fixed list, so deciding where
 * banners show next needs no schema change: the Admin Panel saves a banner
 * under a new placement and a client starts asking for it. Customers only
 * ever receive ACTIVE banners of the placement they ask for, in order.
 *
 * Images go through the shared image pipeline (uploaded-image.service.ts):
 * validated, resized to the banner profile, stored as WebP in public storage;
 * the raw upload is deleted. A replaced or deleted banner's image is removed
 * once nothing references it.
 */

import { BannerActionType, Prisma, type Banner } from '@prisma/client';
import sharp from 'sharp';
import { ErrorCode, type AdminBannerDto, type BannerDto } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { MAX_IMAGE_BYTES, storage, storageKeyFromUrl } from '../../infra/storage';
import { assertAdminKey } from '../admin/admin-upload.service';
import { processUploadedImage, removeStoredImageIfUnused } from '../catalog/uploaded-image.service';

/** The placement the Home screen's top carousel asks for (HomeFeedDto.banners). */
export const HOME_TOP_PLACEMENT = 'home_top';

/** "home_top", "food", "category:3f2…" — mirrors the banners_placement_format CHECK. */
export const PLACEMENT_PATTERN = /^[a-z][a-z0-9_]*(:[A-Za-z0-9_-]+)?$/;

function toDto(banner: Banner): BannerDto {
  return {
    id: banner.id,
    imageUrl: banner.imageUrl,
    imageWidth: banner.imageWidth,
    imageHeight: banner.imageHeight,
    title: banner.title,
    subtitle: banner.subtitle,
    actionType: banner.actionType,
    actionValue: banner.actionValue,
  };
}

function toAdminDto(banner: Banner): AdminBannerDto {
  return {
    ...toDto(banner),
    placement: banner.placement,
    displayOrder: banner.displayOrder,
    isActive: banner.isActive,
    createdAt: banner.createdAt.toISOString(),
    updatedAt: banner.updatedAt.toISOString(),
  };
}

const ORDER: Prisma.BannerOrderByWithRelationInput[] = [{ displayOrder: 'asc' }, { createdAt: 'asc' }];

/** GET /banners?placement=… and the Home feed: active banners of one placement. */
export async function listActiveBanners(placement: string): Promise<BannerDto[]> {
  const banners = await prisma.banner.findMany({ where: { placement, isActive: true }, orderBy: ORDER });
  return banners.map(toDto);
}

/** GET /admin/banners — every banner (active or not), optionally one placement. */
export async function listBanners(placement?: string): Promise<AdminBannerDto[]> {
  const banners = await prisma.banner.findMany({
    where: placement ? { placement } : {},
    orderBy: [{ placement: 'asc' }, ...ORDER],
  });
  return banners.map(toAdminDto);
}

/* -------------------------------------------------------------------------- */

export interface BannerInput {
  placement: string;
  title: string | null;
  subtitle: string | null;
  actionType: BannerActionType;
  actionValue: string | null;
  displayOrder: number;
  isActive: boolean;
}

/** A tap action must point at something that exists — never a dead link. */
async function assertAction(type: BannerActionType, value: string | null): Promise<string | null> {
  if (type === BannerActionType.NONE) return null;
  const target = value?.trim();
  if (!target) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose what the banner opens.', details: [{ field: 'actionValue', message: 'required' }] });
  }
  const missing = (what: string) =>
    new AppError(ErrorCode.VALIDATION_ERROR, { message: `That ${what} does not exist.`, details: [{ field: 'actionValue', message: 'not found' }] });
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  if (type === BannerActionType.CATEGORY) {
    if (!isUuid || !(await prisma.category.count({ where: { id: target, deletedAt: null } }))) throw missing('category');
  } else if (type === BannerActionType.PRODUCT) {
    if (!isUuid || !(await prisma.product.count({ where: { id: target, deletedAt: null } }))) throw missing('product');
  } else if (type === BannerActionType.COUPON) {
    if (!(await prisma.coupon.count({ where: { code: target.toUpperCase() } }))) throw missing('coupon');
    return target.toUpperCase();
  }
  return target;
}

function assertPlacement(placement: string): void {
  if (!PLACEMENT_PATTERN.test(placement) || placement.length > 60) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Placement must look like "home_top", "food" or "category:<id>".',
      details: [{ field: 'placement', message: 'invalid' }],
    });
  }
}

/** Runs an admin upload through the image pipeline; returns the WebP and its size. */
async function processBannerImage(key: string): Promise<{ url: string; width: number; height: number }> {
  assertAdminKey(key);
  const image = await processUploadedImage(key, 'banner');
  if (image.width && image.height) return { url: image.url, width: image.width, height: image.height };
  // Reused upload or IMAGE_OPTIMIZE=false: read the stored file's size.
  const storedKey = storageKeyFromUrl(image.url);
  const body = storedKey ? await storage.get(storedKey, MAX_IMAGE_BYTES) : null;
  const meta = body ? await sharp(body).metadata() : null;
  if (!meta?.width || !meta.height) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The uploaded banner image could not be read. Please upload it again.' });
  }
  return { url: image.url, width: meta.width, height: meta.height };
}

async function audit(actorUserId: string, action: string, entityId: string, before: unknown, after: unknown): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action,
      entityType: 'Banner',
      entityId,
      before: (before ?? null) as Prisma.InputJsonValue,
      after: (after ?? null) as Prisma.InputJsonValue,
    },
  });
}

/** POST /admin/banners */
export async function createBanner(input: BannerInput & { imageKey: string }, actorUserId: string): Promise<AdminBannerDto> {
  assertPlacement(input.placement);
  const actionValue = await assertAction(input.actionType, input.actionValue);
  const image = await processBannerImage(input.imageKey);
  const banner = await prisma.banner.create({
    data: {
      placement: input.placement,
      title: input.title,
      subtitle: input.subtitle,
      imageUrl: image.url,
      imageWidth: image.width,
      imageHeight: image.height,
      actionType: input.actionType,
      actionValue,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    },
  });
  await audit(actorUserId, 'banner.create', banner.id, null, toAdminDto(banner));
  return toAdminDto(banner);
}

/** PATCH /admin/banners/:id — any subset of fields; `imageKey` replaces the image. */
export async function updateBanner(
  id: string,
  input: Partial<BannerInput> & { imageKey?: string },
  actorUserId: string,
): Promise<AdminBannerDto> {
  const current = await prisma.banner.findUnique({ where: { id } });
  if (!current) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Banner not found.' });

  if (input.placement !== undefined) assertPlacement(input.placement);
  const actionType = input.actionType ?? current.actionType;
  const actionValue =
    input.actionType !== undefined || input.actionValue !== undefined
      ? await assertAction(actionType, input.actionValue !== undefined ? input.actionValue : current.actionValue)
      : current.actionValue;
  const image = input.imageKey ? await processBannerImage(input.imageKey) : null;

  const banner = await prisma.banner.update({
    where: { id },
    data: {
      ...(input.placement !== undefined ? { placement: input.placement } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      actionType,
      actionValue,
      ...(image ? { imageUrl: image.url, imageWidth: image.width, imageHeight: image.height } : {}),
    },
  });
  await audit(actorUserId, 'banner.update', id, toAdminDto(current), toAdminDto(banner));
  if (image && current.imageUrl !== banner.imageUrl) await removeStoredImageIfUnused(current.imageUrl);
  return toAdminDto(banner);
}

/** DELETE /admin/banners/:id — the row, then its image once nothing uses it. */
export async function deleteBanner(id: string, actorUserId: string): Promise<{ id: string }> {
  const current = await prisma.banner.findUnique({ where: { id } });
  if (!current) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Banner not found.' });
  await prisma.banner.delete({ where: { id } });
  await audit(actorUserId, 'banner.delete', id, toAdminDto(current), null);
  await removeStoredImageIfUnused(current.imageUrl);
  return { id };
}
