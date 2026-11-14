/**
 * Information pages — Privacy Policy, Terms & Conditions, About Aadione
 * (GET/PUT/DELETE/POST /admin/content/pages/:slug…).
 *
 * Same flow as the Home Page Builder: a working copy in the browser, saved
 * as the server's draft, previewed with today's settings, then published as
 * a whole. Customers only ever get the published page. The page format,
 * limits and validation are the shared ones (@shared info-pages.ts).
 */

import { useMemo } from 'react';
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
const publishPage = (slug: InfoPageSlug, basedOnRevision: number, requireAcceptance?: boolean) =>
  api.post<AdminInfoPageDto>(`/admin/content/pages/${slug}/publish`, { basedOnRevision, ...(requireAcceptance === undefined ? {} : { requireAcceptance }) });
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
 * The server side of the policy editor: the document (draft, published,
 * history) and its actions. The text being edited lives in the document
 * editor (pages/InfoPages.tsx); `serverContent` is what it starts from —
 * the draft, else the published page — and Save sends the editor's page.
 */
export function useInfoPageEditor(slug: InfoPageSlug) {
  const queryClient = useQueryClient();
  const doc = useAdminInfoPage(slug);
  const serverContent = useMemo(() => startingContent(doc.data), [doc.data]);

  const apply = (next: AdminInfoPageDto) => queryClient.setQueryData(infoPageKeys.page(slug), next);
  const save = useMutation({ mutationFn: (content: InfoPageContent) => saveDraft(slug, content), onSuccess: apply });
  const discard = useMutation({ mutationFn: () => discardDraft(slug), onSuccess: apply });
  const publish = useMutation({
    mutationFn: (requireAcceptance?: boolean) => publishPage(slug, basedOnRevision(doc.data), requireAcceptance),
    onSuccess: apply,
  });
  const restore = useMutation({ mutationFn: (id: string) => restoreRevision(slug, id), onSuccess: apply });
  const reload = () => queryClient.invalidateQueries({ queryKey: infoPageKeys.page(slug) });

  return { doc, serverContent, save, discard, publish, restore, reload };
}
