/**
 * Privacy Policy, Terms & Conditions and About Aadione — fetched from the
 * server (GET /legal/:slug), never bundled into the app: the wording and the
 * business / contact details it shows (Admin Configuration) are corrected
 * without a store release, and the website reads the very same published
 * page. Public content, so it works for guests too.
 *
 * Cached for a minute (the server's own cache is cleared on publish), and
 * refetched on every visit after that and on pull-to-refresh, so a newly
 * published page or changed phone number reaches the app within about a
 * minute. A page that has not been published yet (the About page before its
 * first publish) is `null`, not an error — the screen shows its own fallback.
 */

import { useQuery } from '@tanstack/react-query';
import { ErrorCode, type BusinessInfoDto, type InfoPageDto, type InfoPageSlug } from '@shared';
import { api, ApiRequestError } from './api';

const FRESH_FOR_MS = 60_000;

export function useInfoPage(slug: InfoPageSlug) {
  return useQuery({
    queryKey: ['legal', slug],
    queryFn: async (): Promise<InfoPageDto | null> => {
      try {
        return await api.get<InfoPageDto>(`/legal/${slug}`);
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === ErrorCode.NOT_FOUND) return null;
        throw error;
      }
    },
    staleTime: FRESH_FOR_MS,
  });
}

/** Who runs Aadione and how to reach them (GET /legal/business); empty settings are null. */
export function useBusinessInfo() {
  return useQuery({
    queryKey: ['legal', 'business'],
    queryFn: () => api.get<BusinessInfoDto>('/legal/business'),
    staleTime: FRESH_FOR_MS,
  });
}
