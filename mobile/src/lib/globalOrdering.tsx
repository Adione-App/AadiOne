/**
 * App-wide ordering (open, or closed / paused with its notice) for every
 * screen from ONE place: GET /availability, with the public configuration's
 * master switch for an older server (lib/platformAvailability.ts). Mounted
 * once in App.tsx, so there is one request, one refresh timer at the
 * server's `nextChangeAt`, and Home, Cart, product cards, menus and the
 * variant sheet all read the same answer (lib/closureDisplay.ts decides what
 * each of them shows from it).
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, usePlatformAvailability, usePublicConfig } from "./queries";
import { globalClosedNotice } from "./platformAvailability";

const GlobalOrderingContext = createContext<string | null>(null);

export function GlobalOrderingProvider({ children }: { children: ReactNode }) {
  const availability = usePlatformAvailability().data;
  const publicConfig = usePublicConfig().data;
  const notice = globalClosedNotice(availability, publicConfig);

  // The app opened or closed (a timer at `nextChangeAt`, a refetch): the
  // cart's lines and checkout follow it — the server's cart carries the same
  // rule's answer (CartDto.orderingEnabled), so ask it again.
  const queryClient = useQueryClient();
  const closed = notice !== null;
  const previous = useRef(closed);
  useEffect(() => {
    if (previous.current === closed) return;
    previous.current = closed;
    void queryClient.invalidateQueries({ queryKey: keys.cart });
    void queryClient.invalidateQueries({ queryKey: ["checkout-quote"] });
  }, [closed, queryClient]);

  return <GlobalOrderingContext.Provider value={notice}>{children}</GlobalOrderingContext.Provider>;
}

/** The app-wide closed notice, or null while the app takes orders. */
export function useGlobalClosedNotice(): string | null {
  return useContext(GlobalOrderingContext);
}
