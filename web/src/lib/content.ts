/**
 * Admin-managed storefront content: category images and banners.
 *
 * Uploads reuse the shared upload flow (lib/upload.ts — presign, then the
 * browser PUTs the file straight to storage) with the admin presign route;
 * the server then turns the upload into an optimised WebP on attach.
 */

import { useQuery } from '@tanstack/react-query';
import type { AdminBannerDto } from '@shared';
import { api } from './api';
import { uploadProductImage, type PresignedUpload } from './upload';

export type AdminUploadPurpose = 'category' | 'banner';

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
 * Suggested placements. A placement is just a slug — any other one (for
 * example "category:<id>") can be typed in; the app shows a placement once it
 * asks for it. Only "home_top" is shown by the app today.
 */
export const BANNER_PLACEMENTS: { value: string; label: string; live: boolean }[] = [
  { value: 'home_top', label: 'Home — top carousel', live: true },
  { value: 'home_middle', label: 'Home — middle section', live: false },
  { value: 'home_bottom', label: 'Home — bottom section', live: false },
  { value: 'food', label: 'Food section', live: false },
];

export function placementLabel(placement: string): string {
  return BANNER_PLACEMENTS.find((p) => p.value === placement)?.label ?? placement;
}

export const bannerKeys = { all: ['admin', 'banners'] as const };

export function useAdminBanners() {
  return useQuery({ queryKey: bannerKeys.all, queryFn: () => api.get<AdminBannerDto[]>('/admin/banners') });
}

export interface BannerFields {
  placement: string;
  title: string | null;
  subtitle: string | null;
  actionType: AdminBannerDto['actionType'];
  actionValue: string | null;
  displayOrder: number;
  isActive: boolean;
}

export function createBanner(fields: BannerFields & { imageKey: string }): Promise<AdminBannerDto> {
  return api.post<AdminBannerDto>('/admin/banners', fields);
}

export function updateBanner(id: string, fields: Partial<BannerFields> & { imageKey?: string }): Promise<AdminBannerDto> {
  return api.patch<AdminBannerDto>(`/admin/banners/${id}`, fields);
}

export function deleteBanner(id: string): Promise<{ id: string }> {
  return api.delete<{ id: string }>(`/admin/banners/${id}`);
}
