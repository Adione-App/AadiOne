/**
 * Information pages — Privacy Policy, Terms & Conditions, About Aadione
 * (GET/PUT/DELETE/POST /admin/content/pages/:slug…).
 *
 * Same flow as the Home Page Builder: a working copy in the browser, saved
 * as the server's draft, previewed with today's settings, then published as
 * a whole. Customers only ever get the published page. The page format,
 * limits and validation are the shared ones (@shared info-pages.ts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminInfoPageDto, InfoPageContent, InfoPagePreviewDto, InfoPageSlug } from '@shared';
import { api } from './api';

export const infoPageKeys = {
  page: (slug: InfoPageSlug) => ['admin', 'info-page', slug] as const,
};

export function useAdminInfoPage(slug: InfoPageSlug) {
  return useQuery({ queryKey: infoPageKeys.page(slug), queryFn: () => api.get<AdminInfoPageDto>(`/admin/content/pages/${slug}`) });
}

const saveDraft = (slug: InfoPageSlug, content: InfoPageContent) => api.put<AdminInfoPageDto>(`/admin/content/pages/${slug}/draft`, { content });
const discardDraft = (slug: InfoPageSlug) => api.delete<AdminInfoPageDto>(`/admin/content/pages/${slug}/draft`);
const publishPage = (slug: InfoPageSlug, basedOnRevision: number) =>
  api.post<AdminInfoPageDto>(`/admin/content/pages/${slug}/publish`, { basedOnRevision });
const restoreRevision = (slug: InfoPageSlug, id: string) => api.post<AdminInfoPageDto>(`/admin/content/pages/${slug}/restore/${id}`, {});
export const previewInfoPage = (slug: InfoPageSlug, content: InfoPageContent) =>
  api.post<InfoPagePreviewDto>(`/admin/content/pages/${slug}/preview`, { content });

/** What the admin starts from: the draft, else the published page, else nothing (offer the template). */
export function startingContent(doc: AdminInfoPageDto | undefined): InfoPageContent | null {
  return doc?.draft?.content ?? doc?.published?.content ?? null;
}

/** The published revision the screen is based on (sent with Publish to detect a newer publish). */
export const basedOnRevision = (doc: AdminInfoPageDto | undefined) => doc?.draft?.basedOnRevision ?? doc?.published?.revision ?? 0;

/**
 * The working copy: edits stay in the browser until "Save draft". `dirty` =
 * unsaved edits. When the server's document changes (save, publish, restore,
 * discard), the working copy reloads from it.
 */
export function useInfoPageEditor(slug: InfoPageSlug) {
  const queryClient = useQueryClient();
  const doc = useAdminInfoPage(slug);
  const serverContent = useMemo(() => startingContent(doc.data), [doc.data]);
  const [content, setContent] = useState<InfoPageContent | null>(serverContent);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setContent(serverContent);
    setDirty(false);
  }, [serverContent]);

  const update = useCallback((change: (draft: InfoPageContent) => void) => {
    setContent((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      change(next);
      return next;
    });
    setDirty(true);
  }, []);

  /** Replaces the working copy (e.g. with the Aadione template); still unsaved. */
  const replace = useCallback((next: InfoPageContent) => {
    setContent(structuredClone(next));
    setDirty(true);
  }, []);

  const apply = (next: AdminInfoPageDto) => queryClient.setQueryData(infoPageKeys.page(slug), next);
  const save = useMutation({ mutationFn: () => saveDraft(slug, content!), onSuccess: apply });
  const discard = useMutation({ mutationFn: () => discardDraft(slug), onSuccess: apply });
  const publish = useMutation({ mutationFn: () => publishPage(slug, basedOnRevision(doc.data)), onSuccess: apply });
  const restore = useMutation({ mutationFn: (id: string) => restoreRevision(slug, id), onSuccess: apply });
  const reload = () => queryClient.invalidateQueries({ queryKey: infoPageKeys.page(slug) });

  return { doc, content, dirty, update, replace, save, discard, publish, restore, reload };
}
