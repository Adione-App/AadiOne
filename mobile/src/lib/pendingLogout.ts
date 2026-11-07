/**
 * Sign-outs that could not reach the server.
 *
 * Signing out always ends the session ON THE PHONE at once (tokens cleared,
 * guest mode) — a bad connection never keeps someone signed in. But the
 * server still has to revoke the session and detach this phone's push token
 * from the account, or the account's order updates keep arriving here. When
 * that call fails for a reason worth retrying (offline, timeout, 5xx, rate
 * limit), the request is kept in secure storage and sent again at the next
 * launch or return to the app, until the server accepts it or refuses it for
 * good (a 4xx — nothing to retry).
 *
 * The queue logic is pure (`queueAfterAttempt`, `withEntry`) so it is unit
 * tested (tests/pushLogout.test.ts); storage is expo-secure-store because an
 * entry holds a refresh token.
 */

export interface PendingLogout {
  refreshToken: string | null;
  deviceToken: string | null;
}

/** Oldest entries are dropped beyond this (each is a separate account's sign-out). */
export const PENDING_LOGOUT_LIMIT = 5;

/** Whether a failed logout call is worth sending again later. */
export function isRetryableLogoutFailure(status: number | null | undefined): boolean {
  return !status || status === 408 || status === 429 || status >= 500;
}

/** The queue with one more entry (nothing to send → unchanged; a duplicate is not added twice). */
export function withEntry(queue: readonly PendingLogout[], entry: PendingLogout): PendingLogout[] {
  if (!entry.refreshToken && !entry.deviceToken) return [...queue];
  const others = queue.filter((item) => !(item.refreshToken === entry.refreshToken && item.deviceToken === entry.deviceToken));
  return [...others, entry].slice(-PENDING_LOGOUT_LIMIT);
}

/** After one retry: kept only when it failed in a retryable way. */
export function queueAfterAttempt(
  queue: readonly PendingLogout[],
  entry: PendingLogout,
  outcome: { ok: true } | { ok: false; status: number | null },
): PendingLogout[] {
  if (outcome.ok || !isRetryableLogoutFailure(outcome.status)) return queue.filter((item) => item !== entry);
  return [...queue];
}

/* -------------------------------------------------------------------------- */
/* Storage + sending (React Native only)                                      */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = 'adione.pending-logouts';

type Store = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

function secureStore(): Store {
  // Loaded lazily so the pure functions above can be tested in Node.
  return require('expo-secure-store') as Store;
}

async function readQueue(): Promise<PendingLogout[]> {
  try {
    const raw = await secureStore().getItemAsync(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingLogout[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: PendingLogout[]): Promise<void> {
  try {
    if (queue.length === 0) await secureStore().deleteItemAsync(STORAGE_KEY);
    else await secureStore().setItemAsync(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage unavailable: the next sign-in on this phone still moves the token.
  }
}

export async function queuePendingLogout(entry: PendingLogout): Promise<void> {
  await writeQueue(withEntry(await readQueue(), entry));
}

let flushing = false;

/** Sends every queued sign-out once; keeps those that failed in a retryable way. */
export async function flushPendingLogouts(
  send: (entry: PendingLogout) => Promise<void>,
  statusOf: (error: unknown) => number | null,
): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let queue = await readQueue();
    for (const entry of [...queue]) {
      try {
        await send(entry);
        queue = queueAfterAttempt(queue, entry, { ok: true });
      } catch (error) {
        queue = queueAfterAttempt(queue, entry, { ok: false, status: statusOf(error) });
      }
    }
    await writeQueue(queue);
  } finally {
    flushing = false;
  }
}
