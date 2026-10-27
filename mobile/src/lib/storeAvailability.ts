/**
 * Store availability changes the app must not miss: a store opening or
 * closing (its switch, hours, a holiday, admin), or ordering being paused
 * app-wide. The server decides everything; this only makes the app ASK again
 * — on resume from the background (a cart kept overnight is checked against
 * today's stores) and on the server's realtime `store.availability_changed`.
 *
 * `invalidateQueries` re-fetches only what is on screen right now and marks
 * the rest stale for its next use, and keeps showing the current data until
 * the new answer lands — no burst of requests, no blank flash.
 */

import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./queries";
import { homeShelvesQueryKey } from "./homeLayoutQuery";

let client: QueryClient | null = null;

/** App.tsx registers its QueryClient once at startup. */
export function setAvailabilityQueryClient(queryClient: QueryClient): void {
  client = queryClient;
}

/** Several events at once (a seller saving hours and a closure) refetch once. */
const THROTTLE_MS = 2_000;
let lastRun = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;

function run(): void {
  if (!client) return;
  lastRun = Date.now();
  // Everything whose answer depends on which stores take orders right now.
  for (const queryKey of [
    keys.cart,
    keys.home,
    homeShelvesQueryKey,
    keys.previouslyOrdered,
    ["public-config"],
    ["checkout-quote"],
    ["product"],
    ["products"],
    ["rail"],
    ["stores"],
    ["store"],
    ["store-products"],
    ["category-listing"],
    ["search"],
  ] as const) {
    void client.invalidateQueries({ queryKey: [...queryKey] });
  }
}

/** Ask the server again (throttled). */
export function revalidateStoreAvailability(): void {
  const wait = THROTTLE_MS - (Date.now() - lastRun);
  if (wait <= 0) {
    run();
    return;
  }
  if (trailing) return;
  trailing = setTimeout(() => {
    trailing = null;
    run();
  }, wait);
}
