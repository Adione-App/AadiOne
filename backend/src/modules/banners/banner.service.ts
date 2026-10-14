/**
 * Banners — admin-managed promotional images, shown wherever a client asks
 * for a placement ("home_top", "home_middle", "food", "category:<id>", …).
 *
 * `placement` is a free-form slug rather than a fixed list, so deciding where
 * banners show next needs no schema change: the Admin Panel saves a banner
 * under a new placement and a client starts asking for it. Customers only
 * ever receive ACTIVE banners of the placement they ask for, in order.
 *
 * Campaigns: a banner is a DRAFT (never shown), PUBLISHED or ARCHIVED, and
 * may carry a schedule (startsAt / endsAt). Customers only get PUBLISHED,
 * switched-on banners inside their schedule (`liveWhere`). Each carries its
 * presentation (`layout`, the shared BannerLayoutDto — clamped to safe
 * limits by `resolveBannerLayout`) and a validated tap action; an action
 * whose target has since gone (deleted category, delisted product, closed
 * store…) reaches customers as NONE, so a banner never opens a dead page.
 *
 * Images go through the shared image pipeline (uploaded-image.service.ts):
 * validated, resized to the banner profile, stored as WebP in public storage;
 * the raw upload is deleted. A replaced or deleted banner's image is removed
 * once nothing references it.
 */

import { ApprovalStatus, BannerActionType, BannerStatus, ProductStatus, Prisma, type Banner } from '@prisma/client';
import sharp from 'sharp';
import {
  BANNER_RAIL_TARGETS,
  ErrorCode,
  HOME_BANNER_PLACEMENTS,
  bannerPlacementInfo,
  bannerVisibility,
  isFoodSellerType,
  resolveBannerLayout,
  type AdminBannerDto,
  type BannerDto,
  type BannerLayoutDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { MAX_IMAGE_BYTES, storage, storageKeyFromUrl } from '../../infra/storage';
import { assertAdminKey } from '../admin/admin-upload.service';
import { processUploadedImage, removeStoredImageIfUnused } from '../catalog/uploaded-image.service';

/** The placement the Home screen's top carousel asks for (HomeFeedDto.banners). */
export const HOME_TOP_PLACEMENT = HOME_BANNER_PLACEMENTS.TOP;

/** "home_top", "food", "category:3f2…" — mirrors the banners_placement_format CHECK. */
export const PLACEMENT_PATTERN = /^[a-z][a-z0-9_]*(:[A-Za-z0-9_-]+)?$/;

/** The banner's presentation, filled in and clamped (placement default variant). */
function layoutOf(banner: Pick<Banner, 'layout' | 'placement'>): Required<BannerLayoutDto> {
  const placement = banner.placement.split(':')[0]!;
  return resolveBannerLayout(banner.layout as BannerLayoutDto, bannerPlacementInfo(placement)?.defaultVariant ?? 'banner');
}

function toDto(banner: Banner): BannerDto {
  return {
    id: banner.id,
    imageUrl: banner.imageUrl,
    imageWidth: banner.imageWidth,
    imageHeight: banner.imageHeight,
    title: banner.title,
    subtitle: banner.subtitle,
    ctaLabel: banner.ctaLabel,
    actionType: banner.actionType,
    actionValue: banner.actionValue,
    layout: layoutOf(banner),
  };
}

function toAdminDto(banner: Banner): AdminBannerDto {
  const schedule = {
    status: banner.status,
    isActive: banner.isActive,
    startsAt: banner.startsAt?.toISOString() ?? null,
    endsAt: banner.endsAt?.toISOString() ?? null,
  };
  return {
    ...toDto(banner),
    placement: banner.placement,
    displayOrder: banner.displayOrder,
    ...schedule,
    visibility: bannerVisibility(schedule),
    createdAt: banner.createdAt.toISOString(),
    updatedAt: banner.updatedAt.toISOString(),
  };
}

const ORDER: Prisma.BannerOrderByWithRelationInput[] = [{ displayOrder: 'asc' }, { createdAt: 'asc' }];

/** What customers may see right now: published, switched on, inside the schedule. */
function liveWhere(now: Date = new Date()): Prisma.BannerWhereInput {
  return {
    isActive: true,
    status: BannerStatus.PUBLISHED,
    AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
  };
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** An https URL a banner may open: absolute, https, a real host, no embedded credentials. */
export function isSafeBannerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host.includes('.') && host !== 'localhost' && !/^[0-9.]+$/.test(host) && !host.startsWith('[');
}

/**
 * Customer copies of banners: an action whose target is gone or not live
 * any more (deleted / hidden category, unavailable product, inactive store,
 * expired coupon…) becomes NONE — the image still shows, but a tap never
 * opens a dead page. One query per target kind, whatever the banner count.
 */
async function withLiveTargets(banners: Banner[]): Promise<BannerDto[]> {
  const ids = (type: BannerActionType) =>
    [...new Set(banners.filter((b) => b.actionType === type && b.actionValue && isUuid(b.actionValue)).map((b) => b.actionValue!))];
  const categoryIds = ids(BannerActionType.CATEGORY);
  const productIds = ids(BannerActionType.PRODUCT);
  const sellerIds = [...new Set([...ids(BannerActionType.STORE), ...ids(BannerActionType.RESTAURANT)])];
  const codes = [...new Set(banners.filter((b) => b.actionType === BannerActionType.COUPON && b.actionValue).map((b) => b.actionValue!))];
  const now = new Date();

  const [categories, products, sellers, coupons] = await Promise.all([
    categoryIds.length ? prisma.category.findMany({ where: { id: { in: categoryIds }, deletedAt: null, isActive: true }, select: { id: true } }) : [],
    productIds.length
      ? prisma.product.findMany({
          where: { id: { in: productIds }, deletedAt: null, status: ProductStatus.ACTIVE, approvalStatus: ApprovalStatus.APPROVED },
          select: { id: true },
        })
      : [],
    sellerIds.length
      ? prisma.seller.findMany({
          where: { id: { in: sellerIds }, deletedAt: null, isActive: true, onboardingStatus: ApprovalStatus.APPROVED },
          select: { id: true, sellerType: true },
        })
      : [],
    codes.length
      ? prisma.coupon.findMany({ where: { code: { in: codes }, isActive: true, OR: [{ validTo: null }, { validTo: { gt: now } }] }, select: { code: true } })
      : [],
  ]);
  const liveCategory = new Set(categories.map((c) => c.id));
  const liveProduct = new Set(products.map((p) => p.id));
  const sellerType = new Map(sellers.map((s) => [s.id, s.sellerType]));
  const liveCoupon = new Set(coupons.map((c) => c.code));
  const railKeys = new Set(BANNER_RAIL_TARGETS.map((rail) => rail.key));

  return banners.map((banner) => {
    const dto = toDto(banner);
    const value = banner.actionValue ?? '';
    const live =
      banner.actionType === BannerActionType.NONE ||
      (banner.actionType === BannerActionType.CATEGORY && liveCategory.has(value)) ||
      (banner.actionType === BannerActionType.PRODUCT && liveProduct.has(value)) ||
      (banner.actionType === BannerActionType.STORE && sellerType.has(value) && !isFoodSellerType(sellerType.get(value)!)) ||
      (banner.actionType === BannerActionType.RESTAURANT && sellerType.has(value) && isFoodSellerType(sellerType.get(value)!)) ||
      (banner.actionType === BannerActionType.COUPON && liveCoupon.has(value)) ||
      (banner.actionType === BannerActionType.RAIL && railKeys.has(value)) ||
      (banner.actionType === BannerActionType.URL && isSafeBannerUrl(value));
    return live ? dto : { ...dto, actionType: 'NONE', actionValue: null };
  });
}

/** GET /banners?placement=… and the Home feed: live banners of one placement. */
export async function listActiveBanners(placement: string): Promise<BannerDto[]> {
  const banners = await prisma.banner.findMany({ where: { placement, ...liveWhere() }, orderBy: ORDER });
  return withLiveTargets(banners);
}

/**
 * Active banners of several placements in one query, each placement's in
 * order — the Home feed's section banners. Placements without any are absent.
 */
export async function listActiveBannersByPlacement(placements: readonly string[]): Promise<Map<string, BannerDto[]>> {
  const banners = await prisma.banner.findMany({
    where: { placement: { in: [...placements] }, ...liveWhere() },
    orderBy: ORDER,
  });
  const dtos = await withLiveTargets(banners);
  const byPlacement = new Map<string, BannerDto[]>();
  banners.forEach((banner, index) => {
    const list = byPlacement.get(banner.placement);
    if (list) list.push(dtos[index]!);
    else byPlacement.set(banner.placement, [dtos[index]!]);
  });
  return byPlacement;
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
  /** Optional button text on the banner; null = no button. */
  ctaLabel: string | null;
  actionType: BannerActionType;
  actionValue: string | null;
  displayOrder: number;
  isActive: boolean;
  status: BannerStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Any subset; missing fields take the placement's defaults, numbers are clamped. */
  layout: BannerLayoutDto;
}

function assertSchedule(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'The end time must be after the start time.',
      details: [{ field: 'endsAt', message: 'must be after startsAt' }],
    });
  }
}

/** The layout as stored: filled in and clamped, so what is saved is what is shown. */
function storedLayout(placement: string, layout: BannerLayoutDto): Prisma.InputJsonValue {
  return layoutOf({ placement, layout: layout as Prisma.JsonValue }) as unknown as Prisma.InputJsonValue;
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
  const uuid = isUuid(target);
  if (type === BannerActionType.CATEGORY) {
    if (!uuid || !(await prisma.category.count({ where: { id: target, deletedAt: null } }))) throw missing('category');
  } else if (type === BannerActionType.PRODUCT) {
    if (!uuid || !(await prisma.product.count({ where: { id: target, deletedAt: null } }))) throw missing('product');
  } else if (type === BannerActionType.STORE || type === BannerActionType.RESTAURANT) {
    const seller = uuid ? await prisma.seller.findFirst({ where: { id: target, deletedAt: null }, select: { sellerType: true } }) : null;
    const food = seller ? isFoodSellerType(seller.sellerType) : false;
    if (!seller) throw missing(type === BannerActionType.STORE ? 'store' : 'restaurant');
    if (type === BannerActionType.STORE && food) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'That seller is a restaurant or cafe — choose "Opens a restaurant".', details: [{ field: 'actionValue', message: 'not a store' }] });
    }
    if (type === BannerActionType.RESTAURANT && !food) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'That seller is not a restaurant or cafe.', details: [{ field: 'actionValue', message: 'not a restaurant' }] });
    }
  } else if (type === BannerActionType.RAIL) {
    if (!BANNER_RAIL_TARGETS.some((rail) => rail.key === target)) throw missing('product listing');
  } else if (type === BannerActionType.URL) {
    if (!isSafeBannerUrl(target)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter a full https:// link (no other kind of link is allowed).', details: [{ field: 'actionValue', message: 'https URL required' }] });
    }
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

/**
 * A "home_category" banner shows directly above the Home shelf of the category
 * it opens, so it must open a category — otherwise there is nowhere to put it.
 */
function assertPlacementAction(placement: string, actionType: BannerActionType): void {
  if (placement === HOME_BANNER_PLACEMENTS.CATEGORY && actionType !== BannerActionType.CATEGORY) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'A banner shown above a category shelf must open that category. Choose "Opens a category".',
      details: [{ field: 'actionType', message: 'must be CATEGORY for this placement' }],
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
  assertPlacementAction(input.placement, input.actionType);
  assertSchedule(input.startsAt, input.endsAt);
  const actionValue = await assertAction(input.actionType, input.actionValue);
  const image = await processBannerImage(input.imageKey);
  const banner = await prisma.banner.create({
    data: {
      placement: input.placement,
      title: input.title,
      subtitle: input.subtitle,
      ctaLabel: input.ctaLabel,
      imageUrl: image.url,
      imageWidth: image.width,
      imageHeight: image.height,
      actionType: input.actionType,
      actionValue,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
      status: input.status,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      layout: storedLayout(input.placement, input.layout),
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
  const startsAt = input.startsAt !== undefined ? input.startsAt : current.startsAt;
  const endsAt = input.endsAt !== undefined ? input.endsAt : current.endsAt;
  assertSchedule(startsAt, endsAt);
  const actionType = input.actionType ?? current.actionType;
  assertPlacementAction(input.placement ?? current.placement, actionType);
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
      ...(input.ctaLabel !== undefined ? { ctaLabel: input.ctaLabel } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
      ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
      ...(input.layout !== undefined ? { layout: storedLayout(input.placement ?? current.placement, input.layout) } : {}),
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

/**
 * PUT /admin/banners/order — the order of one placement's banners, as listed
 * (every id must belong to that placement). Saved as 0, 10, 20… so a single
 * banner can later be slotted in by hand.
 */
export async function reorderBanners(placement: string, ids: string[], actorUserId: string): Promise<AdminBannerDto[]> {
  const current = await prisma.banner.findMany({ where: { placement }, select: { id: true, displayOrder: true } });
  const known = new Set(current.map((banner) => banner.id));
  if (ids.length !== new Set(ids).size || ids.some((id) => !known.has(id))) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Those banners are not all in this placement.', details: [{ field: 'ids', message: 'invalid' }] });
  }
  await prisma.$transaction(ids.map((id, index) => prisma.banner.update({ where: { id }, data: { displayOrder: index * 10 } })));
  await audit(actorUserId, 'banner.reorder', placement, current, ids);
  return listBanners(placement);
}
