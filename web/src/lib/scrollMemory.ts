/**
 * Scroll restoration for both panels (admin + seller).
 *
 * The panels use <BrowserRouter>; React Router's own <ScrollRestoration> needs
 * a data router, and the browser's built-in restoration fires on `popstate`,
 * BEFORE React has re-drawn the list — on the short page that is still shown,
 * so the position was clamped and a list opened from row 40 came back at the
 * top. Here the panel restores it itself, once the list is tall enough again
 * (cached data draws at once; a list still loading is waited for).
 *
 * The rules are in scrollMemoryCore.ts. Mounted once: <ScrollMemory /> in App.
 */

import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useLocation, useNavigationType, type Location } from 'react-router-dom';
import {
  FIRST_ENTRY_KEY,
  arrivalScroll,
  canReach,
  historyBackTarget,
  isFreshLoad,
  storedMap,
  type BackTarget,
  type EntryRef,
} from './scrollMemoryCore';

const scrolls = storedMap<number>('aadione.scroll.v1');
const openedFrom = storedMap<EntryRef>('aadione.opened-from.v1');
const entryState = storedMap<unknown>('aadione.entry-state.v1', 400);

function loadType(): string | undefined {
  try {
    return (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
  } catch {
    return undefined;
  }
}

// A fresh load starts clean: its first entry shares React Router's fixed key
// with every earlier fresh load in this tab (see FIRST_ENTRY_KEY). Before the
// first render, so no list reads an earlier load's "Show more" pages.
if (typeof window !== 'undefined' && isFreshLoad(loadType())) {
  scrolls.forget((key) => key === FIRST_ENTRY_KEY);
  openedFrom.forget((key) => key === FIRST_ENTRY_KEY);
  entryState.forget((key) => key.startsWith(`${FIRST_ENTRY_KEY}:`));
}

/** Gives up waiting for a list that never grows (an error, an emptier result). */
const RESTORE_TIMEOUT_MS = 5000;

/** Scrolls to `y` as soon as the page is tall enough; the person scrolling first wins. */
function restoreWhenReachable(y: number): () => void {
  const started = performance.now();
  let frame = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) window.removeEventListener(type, stop);
  };
  const attempt = () => {
    if (stopped) return;
    const reachable = canReach(y, document.documentElement.scrollHeight, window.innerHeight);
    window.scrollTo(0, y);
    if (reachable || performance.now() - started > RESTORE_TIMEOUT_MS) stop();
    else frame = requestAnimationFrame(attempt);
  };
  for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) window.addEventListener(type, stop, { passive: true });
  attempt();
  return stop;
}

/** Remembers and restores the scroll position of every history entry. Renders nothing. */
export function ScrollMemory(): null {
  const location = useLocation();
  const navigationType = useNavigationType();
  const shown = useRef<Location | null>(null);
  // The entry on screen right now; a late scroll event of the page just left
  // must never be saved as that page's position.
  const currentKey = useRef(location.key);

  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  }, []);

  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = location;
    currentKey.current = location.key;

    // Where this entry was opened from (for BackLink).
    if (before && before.key !== location.key) {
      if (navigationType === 'PUSH') openedFrom.set(location.key, { key: before.key, pathname: before.pathname, search: before.search });
      else if (navigationType === 'REPLACE') {
        const origin = openedFrom.get(before.key);
        if (origin) openedFrom.set(location.key, origin);
      }
    }

    const decision = arrivalScroll(navigationType, scrolls.get(location.key), { firstPage: before === null, loadType: loadType() });
    if (decision.kind === 'restore') return restoreWhenReachable(decision.y);
    if (decision.kind === 'top') window.scrollTo(0, 0);
    scrolls.set(location.key, window.scrollY);
    return undefined;
    // `location` changes with its key; the navigation type belongs to that change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  useLayoutEffect(() => {
    const key = location.key;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (currentKey.current === key) scrolls.set(key, window.scrollY);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [location.key]);

  return null;
}

/**
 * `useState` remembered per history entry: list state that is not in the URL
 * (how many "Show more" pages, expanded rows, a tab) is back as it was when
 * the person returns with Back — so the scroll position can be restored onto
 * the same rows. A new visit (a link, a changed filter) starts from `initial`.
 * Values must be JSON (arrays, not Sets).
 */
export function useEntryState<T>(name: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const { key } = useLocation();
  const read = (k: string): T => {
    const stored = entryState.get(`${k}:${name}`);
    return stored === undefined ? initial : (stored as T);
  };
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  // Another entry (Back / Forward, or this one's URL replaced): its own value.
  let current = state;
  if (state.key !== key) {
    current = { key, value: read(key) };
    setState(current);
  }
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setState((prev) => {
        const value = typeof next === 'function' ? (next as (v: T) => T)(prev.value) : next;
        entryState.set(`${prev.key}:${name}`, value);
        return { key: prev.key, value };
      }),
    [name],
  );
  return [current.value, set];
}

/**
 * Which of `targets` the current page was opened from — when Back in history
 * returns exactly there (same list, same filters and scroll position).
 */
export function useHistoryBackTarget(targets: readonly BackTarget[]): (BackTarget & { href: string }) | null {
  const location = useLocation();
  const previous = openedFrom.get(location.key);
  const target = historyBackTarget(previous, location.pathname, targets);
  return target && previous ? { ...target, href: `${previous.pathname}${previous.search}` } : null;
}
