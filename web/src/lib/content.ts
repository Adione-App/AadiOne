/**
 * Admin-managed storefront content: category images and banners.
 *
 * Uploads reuse the shared upload flow (lib/upload.ts — presign, then the
 * browser PUTs the file straight to storage) with the admin presign route;
 * the server then turns the upload into an optimised WebP on attach.
 */

import { useQuery } from '@tanstack/react-query';
import {
  BANNER_PLACEMENTS,
  ConfigKey,
  bannerPlacementInfo,
  type AdminBannerDto,
  type BannerLayoutDto,
  type BannerStatusDto,
  type CategoryDto,
} from '@shared';
import { api } from './api';
import { uploadProductImage, type PresignedUpload } from './upload';

export type AdminUploadPurpose = 'category' | 'banner' | 'restaurant';

/** POST /admin/uploads/presign, then the bytes; returns the key to attach. */
export function uploadAdminImage(file: File, purpose: AdminUploadPurpose): Promise<string> {
  return uploadProductImage(file, (body) => api.post<PresignedUpload>('/admin/uploads/presign', { ...body, purpose }));
}

/* Category images ---------------------------------------------------------- */

export interface CategoryImageResult {
  path: string;
  imageUrl: string | null;
  updatedCategories: number;
}

/** Sets the image of a merged category (every seller's row with its path). */
export function setCategoryImage(categoryId: string, key: string): Promise<CategoryImageResult> {
  return api.put<CategoryImageResult>(`/admin/categories/${categoryId}/image`, { key });
}

export function removeCategoryImage(categoryId: string): Promise<CategoryImageResult> {
  return api.delete<CategoryImageResult>(`/admin/categories/${categoryId}/image`);
}

/* Banners ------------------------------------------------------------------ */

/**
 * Where a banner can show — the shared placement registry (BANNER_PLACEMENTS
 * in @shared), the same list the server and the app use; nothing is kept
 * only here. `label` / `hint` explain each place to the admin.
 */
export const BANNER_PLACEMENT_OPTIONS = BANNER_PLACEMENTS.map((entry) => ({
  value: entry.key,
  label: entry.label,
  hint: entry.hint,
  defaultVariant: entry.defaultVariant,
}));

export function placementLabel(placement: string): string {
  return bannerPlacementInfo(placement)?.label ?? placement;
}

export const bannerKeys = { all: ['admin', 'banners'] as const };

/* Home page category order ------------------------------------------------ */

/** The admin's Home category order (top-level category paths), from GET /admin/config. */
export function useHomeCategoryOrder() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<{ key: string; value: unknown }[]>('/admin/config'),
    select: (entries): string[] => {
      const value = entries.find((entry) => entry.key === ConfigKey.HOME_CATEGORY_ORDER)?.value;
      return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [];
    },
  });
}

export function saveHomeCategoryOrder(paths: string[]) {
  return api.patch('/admin/config', { key: ConfigKey.HOME_CATEGORY_ORDER, value: paths });
}

/** The live top-level categories customers see (merged across sellers; slug = path). */
export function useCustomerTopCategories() {
  return useQuery({
    queryKey: ['admin', 'customer-top-categories'],
    queryFn: () => api.get<CategoryDto[]>('/categories'),
  });
}

export function useAdminBanners() {
  return useQuery({ queryKey: bannerKeys.all, queryFn: () => api.get<AdminBannerDto[]>('/admin/banners') });
}

export interface BannerFields {
  placement: string;
  title: string | null;
  subtitle: string | null;
  /** Optional button text on the banner; null = no button. */
  ctaLabel: string | null;
  actionType: AdminBannerDto['actionType'];
  actionValue: string | null;
  displayOrder: number;
  isActive: boolean;
  /** DRAFT = saved but never shown; PUBLISHED = shown while on and inside the schedule; ARCHIVED = retired. */
  status: BannerStatusDto;
  /** ISO date-times; null = no limit. */
  startsAt: string | null;
  endsAt: string | null;
  layout: BannerLayoutDto;
}

/** PUT /admin/banners/order — one placement's banners, first to last. */
export function reorderBanners(placement: string, ids: string[]): Promise<AdminBannerDto[]> {
  return api.put<AdminBannerDto[]>('/admin/banners/order', { placement, ids });
}

export function createBanner(fields: BannerFields & { imageKey: string }): Promise<AdminBannerDto> {
  return api.post<AdminBannerDto>('/admin/banners', fields);
}

export function updateBanner(id: string, fields: Partial<BannerFields> & { imageKey?: string }): Promise<AdminBannerDto> {
  return api.patch<AdminBannerDto>(`/admin/banners/${id}`, fields);
}

/* Restaurant branding (logo / cover photo) ---------------------------------- */

export interface RestaurantBranding {
  sellerId: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  menuImageUrl?: string | null;
  avgPrepMins?: number | null;
}

/** logo = round logo on the menu page; cover = the place (Food list card); menu = the food hero atop its menu page. */
export type RestaurantImageKind = 'logo' | 'cover' | 'menu';

/** Attaches an admin upload (purpose "restaurant") as the restaurant's logo or cover. */
export function setRestaurantImage(sellerId: string, kind: RestaurantImageKind, key: string): Promise<RestaurantBranding> {
  return api.put<RestaurantBranding>(`/admin/restaurants/${sellerId}/images/${kind}`, { key });
}

export function removeRestaurantImage(sellerId: string, kind: RestaurantImageKind): Promise<RestaurantBranding> {
  return api.delete<RestaurantBranding>(`/admin/restaurants/${sellerId}/images/${kind}`);
}

/** PUT /admin/restaurants/:sellerId/prep-time — minutes (1–240), or null to clear. */
export function setRestaurantPrepTime(sellerId: string, avgPrepMins: number | null): Promise<RestaurantBranding> {
  return api.put<RestaurantBranding>(`/admin/restaurants/${sellerId}/prep-time`, { avgPrepMins });
}

export function deleteBanner(id: string): Promise<{ id: string }> {
  return api.delete<{ id: string }>(`/admin/banners/${id}`);
}
