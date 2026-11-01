/**
 * The idempotency key of a checkout — one per CHECKOUT INTENT. Pure (storage
 * comes in as a parameter), so every case is unit-tested
 * (tests/checkoutIntent.test.ts).
 *
 * The server stores, per (customer, key), a hash of the exact request body
 * (middleware/idempotency.ts): the same key with the same body replays the
 * stored response (the existing order and its Cashfree session); the same key
 * with a different body is refused ("This request was already used for a
 * different order").
 *
 *   same intent      the exact same request (destination, payment method,
 *                    lines, total) not yet answered with success — a retry
 *                    after a timeout, a double tap, a retry after an app
 *                    restart: SAME key → the server replays, never a second
 *                    order.
 *   new intent       anything else — a different cart, method, total or
 *                    destination, or ANY request after the previous one
 *                    succeeded (an order was created): a NEW key. Ordering the
 *                    same items again after a cancelled order is a new order,
 *                    never a replay of the old one.
 *
 * The key used to live in the Cart's state and was renewed only on some
 * errors: with Cashfree opening in place the Cart stays mounted after an
 * order, so the next checkout reused the previous order's key.
 */

export interface CheckoutIntent {
  key: string;
  /** Stable form of the request body this key was used for. */
  signature: string;
  /** When it was first used (epoch ms) — an old unfinished intent is not resumed. */
  createdAt: number;
}

/** Long enough for any retry; well inside the server's 24 h key retention. */
export const INTENT_MAX_AGE_MS = 6 * 60 * 60_000;

/** JSON with object keys sorted, so the same body always gives the same signature. */
export function checkoutSignature(body: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, normalize((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(body));
}

/** The key for this request: the open intent's when it is the same request, else a new one. */
export function intentFor(
  open: CheckoutIntent | null,
  body: unknown,
  newKey: () => string,
  now: number = Date.now(),
): CheckoutIntent {
  const signature = checkoutSignature(body);
  if (open && open.signature === signature && now - open.createdAt < INTENT_MAX_AGE_MS) return open;
  return { key: newKey(), signature, createdAt: now };
}

/** A persisted intent read back after a restart — only a well-formed, recent one. */
export function restoredIntent(raw: string | null, now: number = Date.now()): CheckoutIntent | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CheckoutIntent>;
    if (typeof v.key !== "string" || v.key.length < 8 || typeof v.signature !== "string" || typeof v.createdAt !== "number") return null;
    if (now - v.createdAt >= INTENT_MAX_AGE_MS || now < v.createdAt) return null;
    return { key: v.key, signature: v.signature, createdAt: v.createdAt };
  } catch {
    return null;
  }
}

export interface IntentStore {
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}

/**
 * The open checkout intent, kept in memory and on disk (an app killed after
 * sending the order but before the answer resumes the SAME key on retry).
 */
export function createCheckoutIntents(store: IntentStore, newKey: () => string, clock: () => number = Date.now) {
  let open: CheckoutIntent | null = null;
  let loading: Promise<void> | null = null;
  /** Key assignment runs one at a time, so simultaneous taps can never mint two keys. */
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  function load(): Promise<void> {
    loading ??= (async () => {
      try {
        open = restoredIntent(await store.get(), clock()) ?? open;
      } catch {
        // unreadable: start fresh
      }
    })();
    return loading;
  }

  const save = (value: CheckoutIntent | null) => store.set(value ? JSON.stringify(value) : null).catch(() => undefined);

  return {
    load,
    /** The key to send for this request body (persisted before the request leaves). */
    keyFor(body: unknown): Promise<string> {
      return exclusive(async () => {
        await load();
        const next = intentFor(open, body, newKey, clock());
        if (next !== open) {
          open = next;
          await save(next);
        }
        return next.key;
      });
    },
    /** The server created the order: this intent is finished — the next checkout gets a new key. */
    completed(): Promise<void> {
      return exclusive(async () => {
        await load();
        open = null;
        await save(null);
      });
    },
    /** The attempt was refused and must start over as a new request. */
    abandon(): Promise<void> {
      return exclusive(async () => {
        await load();
        open = null;
        await save(null);
      });
    },
    current: () => open,
  };
}
