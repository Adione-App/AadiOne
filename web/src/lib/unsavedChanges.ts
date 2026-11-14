/**
 * Unsaved-changes protection for the whole panel. A page with work that is
 * not saved yet (today: the Legal & Policies editor) calls
 * `useUnsavedChangesGuard`; while it has unsaved changes, leaving asks first:
 *
 *   - reloading or closing the tab           the browser's own "Leave site?" (beforeunload)
 *   - a link in the panel (sidebar, header)  checked before the router sees the click
 *   - the browser's Back button              see "History" below
 *   - the browser's Forward button           there is nothing forward to go to (below)
 *   - Sign out, a notification, a new-order  those call `confirmLeave()` first
 *     alert's "View" — anything that
 *     navigates from code, not a link
 *
 * History. The panel uses <BrowserRouter>, which has no navigation blocker,
 * and a Back press cannot be cancelled once the router has shown the previous
 * page. So the page puts ONE extra copy of its own address on the history
 * (`arm`, as soon as it is edited). Back then lands on the page's own entry —
 * nothing changes on screen — and the guard asks: leave (it goes back once
 * more, to where Back was meant to go) or stay (the copy is put back). With no
 * unsaved changes it goes straight on, so one Back still leaves the page.
 * Adding that copy also drops any "forward" entries, so Forward cannot take
 * the admin away from unsaved work either.
 */

import { useCallback, useEffect, useRef } from 'react';

/** The pages that currently say whether they have unsaved work. */
const pages = new Set<{ isDirty: () => boolean; message: string }>();

/**
 * True when it is fine to navigate away: nothing unsaved, or the admin chose
 * to leave. Call it before navigating from code (Sign out, notification
 * clicks, alert buttons). Asks at most once per call.
 */
export function confirmLeave(): boolean {
  for (const page of pages) {
    if (page.isDirty()) return window.confirm(page.message);
  }
  return true;
}

const GUARD_KEY = 'unsavedChangesGuard';
/**
 * Each extra entry carries a number that grows with every entry added (and
 * across reloads), so a pop can tell Back (to a lower number, or to the
 * page's own entry, which has none) from Forward (to a higher one).
 */
const positionOf = (state: unknown): number => {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[GUARD_KEY] : undefined;
  return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY;
};
let lastPosition = 0;
/** Adds an extra copy of this page's address (the router's own state is kept, so it sees the same page); returns its number. */
function pushGuardEntry(): number {
  lastPosition = Math.max(lastPosition + 1, Date.now());
  window.history.pushState({ ...((window.history.state as object | null) ?? {}), [GUARD_KEY]: lastPosition }, '', window.location.href);
  return lastPosition;
}

export function useUnsavedChangesGuard({ dirty, isDirty, message }: {
  /** Unsaved changes, as shown on screen (drives the tab-close and link guards). */
  dirty: boolean;
  /** Unsaved changes right now (read at the moment of leaving; may be ahead of `dirty`). */
  isDirty: () => boolean;
  message: string;
}): { arm: () => void } {
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  /** Set once the admin chose to leave, so the steps of leaving do not ask again. */
  const leaving = useRef(false);
  /** This page's address, and which of its history entries the browser is on. */
  const pageHref = useRef('');
  const position = useRef(Number.NEGATIVE_INFINITY);
  /** An extra entry was added during this visit (once is enough). */
  const armed = useRef(false);

  // Sign out, notifications and alerts ask through confirmLeave().
  useEffect(() => {
    const page = { isDirty: () => !leaving.current && isDirtyRef.current(), message };
    pages.add(page);
    return () => {
      pages.delete(page);
    };
  }, [message]);

  // Reloading or closing the tab.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Links inside the panel (checked before the router sees the click).
  useEffect(() => {
    if (!dirty) return;
    const guardLinks = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || link.getAttribute('target') === '_blank') return;
      if (leaving.current || !isDirtyRef.current()) return;
      if (window.confirm(message)) {
        leaving.current = true;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('click', guardLinks, true);
    return () => document.removeEventListener('click', guardLinks, true);
  }, [dirty, message]);

  // Back / Forward.
  useEffect(() => {
    pageHref.current = window.location.href;
    position.current = positionOf(window.history.state); // e.g. reloaded on an extra entry
    const onPop = (event: PopStateEvent) => {
      // Another page: the router shows it (this page is going away).
      if (window.location.href !== pageHref.current) return;
      const from = position.current;
      position.current = positionOf(event.state);
      // Forward onto one of this page's own entries: nothing changes.
      if (position.current >= from) return;
      // Back within this page's own entries — the admin pressed Back.
      if (!leaving.current && isDirtyRef.current() && !window.confirm(message)) {
        position.current = pushGuardEntry(); // stay: a copy goes back on top
        return;
      }
      leaving.current = true;
      window.history.back(); // on to where Back was meant to go (past any other copies)
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [message]);

  /**
   * Call on the first real edit of a visit (typing, pasting, a toolbar
   * button, a settings field): adds the extra history entry, which also drops
   * any "forward" entries. Once per visit; later calls do nothing.
   */
  const arm = useCallback(() => {
    if (armed.current || leaving.current) return;
    armed.current = true;
    pageHref.current = window.location.href;
    position.current = pushGuardEntry();
  }, []);

  return { arm };
}
