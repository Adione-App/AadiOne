/**
 * Ask the server again when a screen is shown again — React Query has no
 * window focus on a phone, and a tab or a screen under the one on top stays
 * mounted, so without this it would keep its last answer (a restaurant shown
 * "open" after it closed, or CLOSED after it opened).
 *
 * The first focus is skipped (mounting already fetched). `minAgeMs` skips a
 * refresh when the data is that fresh; `intervalMs` also asks again on a
 * timer, only while the screen is focused — cleared on blur and unmount.
 * The current data stays on screen until the new answer lands.
 */

import { useCallback, useRef } from "react";
import { useFocusEffect } from "@react-navigation/native";

interface RefreshableQuery {
  refetch: () => Promise<unknown>;
  dataUpdatedAt: number;
}

export function useRefreshOnFocus(
  query: RefreshableQuery,
  { minAgeMs = 0, intervalMs }: { minAgeMs?: number; intervalMs?: number } = {},
): void {
  const latest = useRef(query);
  latest.current = query;
  const firstFocus = useRef(true);

  useFocusEffect(
    useCallback(() => {
      const refresh = () => void latest.current.refetch();
      if (firstFocus.current) firstFocus.current = false;
      else if (Date.now() - latest.current.dataUpdatedAt >= minAgeMs) refresh();
      if (!intervalMs) return undefined;
      const timer = setInterval(refresh, intervalMs);
      return () => clearInterval(timer);
    }, [minAgeMs, intervalMs]),
  );
}
