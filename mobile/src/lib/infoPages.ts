/**
 * Privacy Policy, Terms & Conditions and About Aadione — fetched from the
 * server (GET /legal/:slug), never bundled into the app: the wording and the
 * business / contact details it shows (Admin Configuration) are corrected
 * without a store release. Public content, so it works for guests too.
 *
 * Refreshed every few minutes and on each visit after that, so a newly
 * published page or changed phone number reaches the app quickly. A page that
 * has not been published yet (the About page before its first publish) is
 * `null`, not an error — the screen shows its own fallback.
 */

import { useQuery } from '@tanstack/react-query';
import { ErrorCode, type InfoPageDto, type InfoPageSlug } from '@shared';
import { api, ApiRequestError } from './api';

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
    staleTime: 5 * 60_000,
  });
}
