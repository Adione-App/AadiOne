/**
 * Scroll memory — the rules, with no React or browser in them (tested in
 * tests/scrollMemory.test.ts). The hooks that apply them: lib/scrollMemory.ts.
 *
 * Every history entry has its own key (React Router's `location.key`). Per
 * key the panels remember, for this browser tab only (sessionStorage):
 *   - how far down the page was scrolled;
 *   - list state that is not in the URL (e.g. how many "Show more" pages);
 *   - which page the entry was opened from — so a page's own "← Back" link
 *     can go back in history (restoring that list exactly) instead of opening
 *     the list afresh at the top.
 */

export type NavigationKind = 'POP' | 'PUSH' | 'REPLACE';

export type ArrivalScroll =
  | { kind: 'restore'; y: number }
  | { kind: 'top' }
  /** Same entry re-drawn with a new URL (filters, tabs): leave the page where it is. */
  | { kind: 'keep' };

/**
 * Where the page should be when an entry is shown:
 *   - Back / Forward (POP): where it was left, if known;
 *   - a new page (PUSH): the top — never the previous page's offset;
 *   - a replaced URL (REPLACE: a filter, a tab): where it is.
 * The very first page of a tab is POP too: it is restored only on a reload or
 * a browser Back/Forward into the app, never on a fresh open.
 */
export function arrivalScroll(
  kind: NavigationKind,
  saved: number | undefined,
  options: { firstPage?: boolean; loadType?: string } = {},
): ArrivalScroll {
  if (kind === 'REPLACE') return { kind: 'keep' };
  if (kind === 'PUSH') return { kind: 'top' };
  if (options.firstPage && isFreshLoad(options.loadType)) return { kind: 'top' };
  return saved !== undefined && saved > 0 ? { kind: 'restore', y: saved } : { kind: 'top' };
}

/**
 * React Router's key for the first entry of a document that has no history
 * state of its own — EVERY fresh load (a typed URL, a bookmark, a full-page
 * link) gets this same key, so what was remembered under it belongs to an
 * earlier load: forgotten on a fresh load, kept on a reload or Back/Forward.
 */
export const FIRST_ENTRY_KEY = 'default';

export function isFreshLoad(loadType: string | undefined): boolean {
  return loadType !== 'reload' && loadType !== 'back_forward';
}

/** Whether the page is now tall enough to scroll to `y` (a list still loading is not). */
export function canReach(y: number, scrollHeight: number, viewportHeight: number): boolean {
  return scrollHeight - viewportHeight >= y - 1;
}

export interface EntryRef {
  key: string;
  pathname: string;
  search: string;
}

export interface BackTarget {
  /** Pathname of a page this Back link may return to. */
  path: string;
  label: string;
}

/**
 * The page a Back link should return to by going back in history: the entry
 * this one was opened from, when that is one of `targets` (the list itself,
 * or another list that links here). Null → the link opens its fallback page.
 */
export function historyBackTarget(previous: EntryRef | undefined, currentPathname: string, targets: readonly BackTarget[]): BackTarget | null {
  if (!previous || previous.pathname === currentPathname) return null;
  return targets.find((t) => t.path === previous.pathname) ?? null;
}

/** Keeps the newest `limit` entries of a remembered map (insertion order). */
export function trimEntries<T>(map: Record<string, T>, limit: number): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  return Object.fromEntries(keys.slice(keys.length - limit).map((k) => [k, map[k]!]));
}

/** sessionStorage-backed map, safe where storage is missing or blocked (private mode, tests). */
export function storedMap<T>(storageKey: string, limit = 200) {
  const storage = (): Storage | null => {
    try {
      return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
      return null;
    }
  };
  const read = (): Record<string, T> => {
    try {
      const raw = storage()?.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, T>) : {};
    } catch {
      return {};
    }
  };
  return {
    get(key: string): T | undefined {
      return read()[key];
    },
    /** Forgets every entry whose key matches. */
    forget(matches: (key: string) => boolean): void {
      try {
        const map = read();
        const kept = Object.fromEntries(Object.entries(map).filter(([k]) => !matches(k)));
        if (Object.keys(kept).length !== Object.keys(map).length) storage()?.setItem(storageKey, JSON.stringify(kept));
      } catch {
        // Storage blocked: nothing was remembered either.
      }
    },
    set(key: string, value: T): void {
      try {
        const map = read();
        delete map[key]; // re-inserted last: the newest survives trimming
        map[key] = value;
        storage()?.setItem(storageKey, JSON.stringify(trimEntries(map, limit)));
      } catch {
        // Storage full or blocked: the page still works, it just forgets.
      }
    },
  };
}
