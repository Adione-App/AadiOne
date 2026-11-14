/**
 * Keeps what customers browse — the published Home layout, the Home feed's
 * category tiles and shelves, the category tree and category listings — in
 * step with the Admin Panel and the sellers' catalogues while the app runs.
 *
 * Why this exists: Home is the first tab and never unmounts, and the
 * Categories tab stays mounted once opened. Their queries were fetched on
 * mount only (React Query has no window focus on a phone), so a category or
 * Home section the admin deleted or hid stayed on screen until the OS killed
 * the app — while an ADDED one seemed to work, because it was usually checked
 * after a fresh launch.
 *
 * The app now asks again — never polls — when:
 *   - the server says the catalogue changed (realtime `catalog.changed`:
 *     a category created / edited / hidden / re-ordered / deleted / new image,
 *     the Home layout published, the Home page main categories saved);
 *   - the socket reconnects (events may have been missed meanwhile);
 *   - the app returns to the foreground (guests have no socket);
 *   - Home or Categories is shown again after a while (useRefreshOnFocus).
 *
 * `invalidateQueries` refetches only what is on screen, marks the rest stale
 * for its next use, and keeps the current data until the new answer lands —
 * no blank flash. Disk persistence (App.tsx) can never bring an older answer
 * back over a newer one: a restored entry only replaces cached data that is
 * older than itself, and every restored entry is stale, so it is re-asked the
 * moment it is shown. The server stays the authority: a deleted or hidden
 * category is left out of its answers; this module only makes the app ask.
 *
 * Pure (no React Native imports) so it is unit tested with Node's runner
 * (tests/catalogSync.test.ts).
 */

/**
 * Query-key prefixes refreshed together. Each is a PREFIX of the real key
 * (queries.ts `keys.home`, `keys.categories`, `keys.categoryListing`;
 * homeLayoutQuery.ts), so every version / page size of them is covered.
 */
export const CATALOG_QUERY_ROOTS: readonly (readonly string[])[] = [
  ["content", "home-layout"],
  ["home"],
  ["content", "home-shelves"],
  ["categories"],
  ["category-listing"],
];

/**
 * Home / Categories shown again: ask again only when the answer is older than
 * this — switching tabs back and forth costs no request.
 */
export const CATALOG_FOCUS_MIN_AGE_MS = 60_000;

/** Several changes at once (an admin saving a whole arrangement) refetch once. */
export const CATALOG_SYNC_THROTTLE_MS = 2_000;

export interface CatalogRevalidatorOptions {
  throttleMs?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
}

/**
 * A throttled "ask the server again" for every catalogue query: the first
 * call runs at once, calls within the throttle window collapse into ONE
 * trailing run at its end (a change arriving mid-window is never lost).
 */
export function createCatalogRevalidator(
  invalidate: (queryKey: readonly string[]) => void,
  { throttleMs = CATALOG_SYNC_THROTTLE_MS, now = Date.now, setTimer = setTimeout }: CatalogRevalidatorOptions = {},
): () => void {
  let lastRun = Number.NEGATIVE_INFINITY;
  let trailing = false;
  const run = () => {
    lastRun = now();
    for (const queryKey of CATALOG_QUERY_ROOTS) invalidate(queryKey);
  };
  return () => {
    const wait = throttleMs - (now() - lastRun);
    if (wait <= 0) {
      run();
      return;
    }
    if (trailing) return;
    trailing = true;
    setTimer(() => {
      trailing = false;
      run();
    }, wait);
  };
}
