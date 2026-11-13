/**
 * Branding & Identity — the published brand assets (GET /branding) for the
 * Admin and Seller Panels, and the admin's management API (/admin/branding).
 *
 * Shown without flashing and offline: the last published branding this
 * browser saw is kept in localStorage and drawn at once on the next visit,
 * then refreshed in the background (and when the tab regains focus, so a
 * publish reaches open panels within about a minute). Until anything is
 * published — or if an image fails to load — the built-in artwork is shown
 * (components/BrandLogo.tsx).
 */

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { brandAssetFor, isSafeAssetUrl, type AdminBrandingDto, type BrandAssetSlot, type BrandUse, type PublicBrandingDto } from '@shared';
import { api } from './api';
import { uploadAdminImage } from './content';

export const BRANDING_STORAGE_KEY = 'aadione.branding.v1';
export const brandingKeys = { public: ['branding'] as const, admin: ['admin', 'branding'] as const };

/** The last published branding this browser saw, or undefined (first visit, storage blocked or damaged). */
export function readCachedBranding(): PublicBrandingDto | undefined {
  try {
    const raw = window.localStorage.getItem(BRANDING_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PublicBrandingDto;
    return parsed && typeof parsed === 'object' && parsed.assets && typeof parsed.revision === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedBranding(branding: PublicBrandingDto): void {
  try {
    window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(branding));
  } catch {
    // Storage full or blocked: the panel still works, it just refetches.
  }
}

/** The published branding (cached copy first). */
export function usePublishedBranding() {
  return useQuery({
    queryKey: brandingKeys.public,
    queryFn: async () => {
      // A unique address: the browser's 60-second HTTP cache of /branding must
      // never hide a publish from the panels (a handful of users — the website
      // and app keep the cacheable address).
      const branding = await api.get<PublicBrandingDto>(`/branding?fresh=${Date.now()}`);
      writeCachedBranding(branding);
      return branding;
    },
    initialData: readCachedBranding,
    // The cached copy is shown at once but always re-checked.
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/** The asset a surface shows (fallback chain applied), or null for the built-in artwork. */
export function useBrandAsset(use: BrandUse) {
  const { data } = usePublishedBranding();
  return brandAssetFor(data, use);
}

/**
 * Keeps the tab icon on the published favicon: the page's own icon links
 * (index.html — including its SVG icon, which browsers prefer) are pointed at
 * the published PNGs, and put back when the favicon returns to the built-in
 * one. Mount once per panel.
 */
export function useFaviconSync(): void {
  const favicon = useBrandAsset('favicon');
  const small = favicon?.variants?.png32;
  const touch = favicon?.variants?.png180;
  useEffect(() => retargetIcons(small, touch), [small, touch]);
}

/** Points every icon link at `small` (apple-touch-icon at `touch`), or restores index.html's own when unset. */
export function retargetIcons(small: string | undefined, touch: string | undefined): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]')) {
    if (link.dataset['builtinHref'] === undefined) {
      link.dataset['builtinHref'] = link.getAttribute('href') ?? '';
      link.dataset['builtinType'] = link.getAttribute('type') ?? '';
    }
    const published = link.rel === 'apple-touch-icon' ? touch : small;
    if (published && isSafeAssetUrl(published)) {
      link.setAttribute('href', published);
      link.setAttribute('type', 'image/png');
    } else {
      link.setAttribute('href', link.dataset['builtinHref']);
      if (link.dataset['builtinType']) link.setAttribute('type', link.dataset['builtinType']);
      else link.removeAttribute('type');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

export function useAdminBranding() {
  return useQuery({ queryKey: brandingKeys.admin, queryFn: () => api.get<AdminBrandingDto>('/admin/branding'), staleTime: 0 });
}

/** Every branding change: the admin view comes back updated; a publish also refreshes what this panel shows. */
export function useBrandingActions() {
  const queryClient = useQueryClient();
  const settle = (data: AdminBrandingDto) => queryClient.setQueryData(brandingKeys.admin, data);
  const refreshPublic = () => queryClient.invalidateQueries({ queryKey: brandingKeys.public });
  return {
    upload: useMutation({
      mutationFn: async ({ slot, file }: { slot: BrandAssetSlot; file: File }) => {
        const key = await uploadAdminImage(file, 'branding');
        return api.post<AdminBrandingDto>(`/admin/branding/assets/${slot}`, { key, fileName: file.name });
      },
      onSuccess: settle,
    }),
    reset: useMutation({
      mutationFn: (slot: BrandAssetSlot) => api.post<AdminBrandingDto>(`/admin/branding/assets/${slot}/default`),
      onSuccess: settle,
    }),
    reuse: useMutation({
      mutationFn: ({ slot, revision }: { slot: BrandAssetSlot; revision: number }) =>
        api.post<AdminBrandingDto>(`/admin/branding/assets/${slot}/reuse`, { revision }),
      onSuccess: settle,
    }),
    restore: useMutation({
      mutationFn: (id: string) => api.post<AdminBrandingDto>(`/admin/branding/restore/${id}`),
      onSuccess: settle,
    }),
    discard: useMutation({
      mutationFn: () => api.delete<AdminBrandingDto>('/admin/branding/draft'),
      onSuccess: settle,
    }),
    publish: useMutation({
      mutationFn: ({ basedOnRevision, slots }: { basedOnRevision: number; slots?: BrandAssetSlot[] }) =>
        api.post<AdminBrandingDto>('/admin/branding/publish', { basedOnRevision, ...(slots ? { slots } : {}) }),
      onSuccess: (data) => {
        settle(data);
        void refreshPublic();
      },
    }),
  };
}

/** Image size of a picked file, read in the browser for an early, friendly check (the server checks again). */
export function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}
