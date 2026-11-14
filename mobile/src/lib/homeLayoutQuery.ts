/**
 * The published Home layout (GET /content/home-layout — Admin Panel → Home
 * Page Builder / Category Management).
 *
 * Never blocks or breaks Home: until the first answer arrives — and on an
 * older server without the endpoint, or offline with nothing saved yet — the
 * built-in defaults are used. A layout once received is kept on disk with
 * the other public queries (App.tsx persistence), so a later failure or an
 * offline start shows the last valid layout, not the defaults. Every layout
 * goes through the shared `resolveHomeLayout` (complete, clamped) first.
 */

import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_HOME_LAYOUT,
  resolveHomeLayout,
  type HomeLayoutContent,
  type HomeLayoutDto,
  type HomeShelvesDto,
  type ProductSummaryDto,
} from "@shared";
import { api } from "./api";

/** The built-in defaults, used until a layout has been received. */
export const FALLBACK_HOME_LAYOUT: HomeLayoutContent = resolveHomeLayout(DEFAULT_HOME_LAYOUT);

export const homeLayoutQueryKey = ["content", "home-layout"] as const;

/**
 * The layout query itself — for a screen that also refreshes it when shown
 * again (useRefreshOnFocus); `useHomeLayout` is the usual read. Also asked
 * again on app resume and on the realtime `catalog.changed` (lib/catalogSync.ts).
 */
export function useHomeLayoutQuery() {
  return useQuery({
    queryKey: homeLayoutQueryKey,
    queryFn: async () => resolveHomeLayout((await api.get<HomeLayoutDto>("/content/home-layout")).layout),
    // The server caches it for a minute; a few minutes here keeps Home from asking on every visit.
    staleTime: 5 * 60_000,
    gcTime: 7 * 24 * 60 * 60_000,
    retry: 1,
  });
}

export function useHomeLayout(): HomeLayoutContent {
  return useHomeLayoutQuery().data ?? FALLBACK_HOME_LAYOUT;
}

export const homeShelvesQueryKey = ["content", "home-shelves"] as const;

/**
 * The products of the published layout's product shelves (Home Page Builder;
 * GET /content/home-shelves), keyed by section id. Live data — prices and
 * stock — so it goes stale after a minute; it is kept on disk like the other
 * public queries, so an offline start or a failed refresh still shows the
 * last shelves. `shelves` is null until the first answer (and on an older
 * server without the endpoint): the shelves are then simply not shown — the
 * rest of Home is unaffected. `loading` is true only while that first answer
 * is on its way (Home shows the shelves' skeletons meanwhile).
 */
export function useHomeShelves(): { shelves: Readonly<Record<string, readonly ProductSummaryDto[]>> | null; loading: boolean } {
  const query = useQuery({
    queryKey: homeShelvesQueryKey,
    queryFn: async () => (await api.get<HomeShelvesDto>("/content/home-shelves")).shelves,
    staleTime: 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: 1,
  });
  return { shelves: query.data ?? null, loading: query.isPending };
}
