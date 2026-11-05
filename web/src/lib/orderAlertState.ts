/**
 * The admin "NEW ORDER" popups' own rules — pure, so they are unit-tested
 * (web/tests/orderAlerts.test.ts):
 *
 *   SEEN       alert ids this admin's browser has already announced. A sound
 *              plays only for an id not seen before — never again after a
 *              reload, a reconnect or a re-fetch. The very first load of a
 *              browser marks everything already waiting as seen, silently.
 *   DISMISSED  popups the admin closed with ×. Closing does NOT read the order
 *              (the badge keeps counting it); the popup can be brought back.
 *
 * Both are per admin (keyed by user id) and kept in localStorage — a
 * per-browser convenience; what is READ lives on the server.
 */

export interface AlertLike {
  alertId: string;
}

/** Ids to announce now (sound) and the seen-list to store. `seen === null`: this browser's first load — nothing is announced. */
export function announce(alertIds: readonly string[], seen: readonly string[] | null): { fresh: string[]; seen: string[] } {
  if (seen === null) return { fresh: [], seen: [...alertIds] };
  const known = new Set(seen);
  const fresh = alertIds.filter((id) => !known.has(id));
  return { fresh, seen: prune([...seen, ...fresh], alertIds) };
}

/** Keeps only ids still unread — the stored lists never grow without bound. */
export function prune(ids: readonly string[], current: readonly string[]): string[] {
  const live = new Set(current);
  return [...new Set(ids)].filter((id) => live.has(id));
}

/** The popups to show (not dismissed), newest first as given, and how many are hidden. */
export function popupsOf<T extends AlertLike>(alerts: readonly T[], dismissed: readonly string[]): { shown: T[]; hidden: number } {
  const closed = new Set(dismissed);
  const shown = alerts.filter((alert) => !closed.has(alert.alertId));
  return { shown, hidden: alerts.length - shown.length };
}

export const seenKey = (userId: string) => `aadione.orderAlerts.seen.${userId}`;
export const dismissedKey = (userId: string) => `aadione.orderAlerts.dismissed.${userId}`;

/** A stored id list, or null when nothing was ever stored (or storage is unavailable). */
export function readIds(key: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

export function writeIds(key: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Private mode / storage blocked: the popups still work for this tab.
  }
}
