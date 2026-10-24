/**
 * Home Page Builder and Category Management — the "home_layout" document
 * (GET/PUT/DELETE/POST /admin/content/home-layout…).
 *
 * Both pages edit ONE document: a working copy in the browser, saved as the
 * server's draft, previewed, then published as a whole. Customers only ever
 * get the published layout. Shapes, defaults and limits are the shared ones
 * (@shared home-layout.ts), so the preview resolves a layout exactly like the
 * server and the app do.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_HOME_LAYOUT,
  resolveHomeLayout,
  type AdminCategoryOptionDto,
  type AdminHomeLayoutDto,
  type AdminProductOptionsPage,
  type HomeLayoutContent,
  type ProductShelfConfig,
  type ProductSummaryDto,
} from '@shared';
import { api } from './api';
import { uploadAdminImage } from './content';

export const homeLayoutKeys = {
  document: ['admin', 'home-layout'] as const,
  categories: ['admin', 'content', 'category-options'] as const,
  products: ['admin', 'content', 'product-options'] as const,
  shelfPreview: ['admin', 'content', 'shelf-preview'] as const,
};

const productQuery = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value) query.set(name, value);
  return `/admin/content/product-options?${query.toString()}`;
};

/** The shelves' product picker: search (English / Hindi name or brand), category, seller — 20 at a time. */
export function useProductOptions(filters: { q: string; categoryPath: string; sellerId: string }, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...homeLayoutKeys.products, 'search', filters],
    queryFn: ({ pageParam }) =>
      api.get<AdminProductOptionsPage>(
        productQuery({ q: filters.q.trim() || undefined, categoryPath: filters.categoryPath || undefined, sellerId: filters.sellerId || undefined, cursor: pageParam ?? undefined, limit: '20' }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 30_000,
  });
}

/** A shelf's chosen products (name, image, price, availability) — by id, whatever the search shows. */
export function useProductsByIds(ids: readonly string[]) {
  return useQuery({
    queryKey: [...homeLayoutKeys.products, 'ids', [...ids].sort().join(',')],
    queryFn: () => api.get<AdminProductOptionsPage>(productQuery({ ids: ids.join(','), limit: '50' })),
    enabled: ids.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** What a shelf (saved or not) shows customers right now — by the server's own rules. */
export function useShelfPreview(sectionId: string, shelf: ProductShelfConfig, enabled = true) {
  return useQuery({
    queryKey: [...homeLayoutKeys.shelfPreview, sectionId, JSON.stringify(shelf)],
    queryFn: () => api.post<ProductSummaryDto[]>('/admin/content/home-layout/shelf-preview', { sectionId, shelf }),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useAdminHomeLayout() {
  return useQuery({ queryKey: homeLayoutKeys.document, queryFn: () => api.get<AdminHomeLayoutDto>('/admin/content/home-layout') });
}

/** Live marketplace categories merged by path — the pickers' options. */
export function useCategoryOptions() {
  return useQuery({
    queryKey: homeLayoutKeys.categories,
    queryFn: () => api.get<AdminCategoryOptionDto[]>('/admin/content/category-options'),
    staleTime: 60_000,
  });
}

export const saveHomeLayoutDraft = (layout: HomeLayoutContent) => api.put<AdminHomeLayoutDto>('/admin/content/home-layout/draft', { layout });
export const discardHomeLayoutDraft = () => api.delete<AdminHomeLayoutDto>('/admin/content/home-layout/draft');
export const publishHomeLayout = (basedOnRevision: number) => api.post<AdminHomeLayoutDto>('/admin/content/home-layout/publish', { basedOnRevision });
export const restoreHomeLayoutRevision = (id: string) => api.post<AdminHomeLayoutDto>(`/admin/content/home-layout/restore/${id}`, {});

/** Upload → the image pipeline (WebP); returns the stored URL for the background. */
export async function uploadHomeBackground(file: File): Promise<string> {
  const key = await uploadAdminImage(file, 'banner');
  return (await api.post<{ url: string }>('/admin/content/home-layout/background-image', { key })).url;
}

/** The layout the admin starts editing from: the draft, else the published one, else the defaults. */
export function startingLayout(doc: AdminHomeLayoutDto | undefined): HomeLayoutContent {
  return resolveHomeLayout(doc?.draft?.layout ?? doc?.published?.layout ?? DEFAULT_HOME_LAYOUT);
}

/** The published revision the admin's screen is based on (sent with Publish to detect a newer publish). */
export const basedOnRevision = (doc: AdminHomeLayoutDto | undefined) => doc?.draft?.basedOnRevision ?? doc?.published?.revision ?? 0;

/**
 * The working copy: edits stay in the browser until "Save draft". `dirty` =
 * unsaved edits. When the server's document changes (save, publish, restore,
 * discard — here or on the other page), the working copy reloads from it.
 */
export function useLayoutEditor() {
  const queryClient = useQueryClient();
  const doc = useAdminHomeLayout();
  const serverLayout = useMemo(() => startingLayout(doc.data), [doc.data]);
  const [layout, setLayout] = useState<HomeLayoutContent>(serverLayout);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setLayout(serverLayout);
    setDirty(false);
  }, [serverLayout]);

  const update = useCallback((change: (draft: HomeLayoutContent) => void) => {
    setLayout((current) => {
      const next = structuredClone(current);
      change(next);
      return next;
    });
    setDirty(true);
  }, []);

  const apply = (next: AdminHomeLayoutDto) => queryClient.setQueryData(homeLayoutKeys.document, next);
  const save = useMutation({ mutationFn: () => saveHomeLayoutDraft(resolveHomeLayout(layout)), onSuccess: apply });
  const discard = useMutation({ mutationFn: discardHomeLayoutDraft, onSuccess: apply });
  const publish = useMutation({ mutationFn: () => publishHomeLayout(basedOnRevision(doc.data)), onSuccess: apply });
  const restore = useMutation({ mutationFn: restoreHomeLayoutRevision, onSuccess: apply });
  const reload = () => queryClient.invalidateQueries({ queryKey: homeLayoutKeys.document });

  return { doc, layout, update, dirty, save, discard, publish, restore, reload, resolved: useMemo(() => resolveHomeLayout(layout), [layout]) };
}

export type LayoutEditor = ReturnType<typeof useLayoutEditor>;
