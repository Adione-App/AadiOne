/**
 * CacheStore port.
 *
 * Backs OTP storage, rate-limit counters and the business-config cache.
 *
 * Two implementations:
 *   - `redis`  — production. Survives restarts, shared across processes.
 *   - `memory` — local development only. The environment loader REFUSES to
 *                boot in production with this driver, because per-process
 *                state would let a restart wipe every rate-limit counter and
 *                let two processes disagree about an OTP.
 *
 * Deliberately a small surface: only what the app actually needs. A larger
 * interface would make the memory implementation a re-implementation of Redis.
 */

export interface CacheStore {
  get(key: string): Promise<string | null>;

  /** `ttlSeconds` is required — nothing in this system may live forever. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;

  /**
   * Sets only if the key does not already exist.
   * Returns true when the value was written. Used for locks and for
   * "one active OTP per number".
   */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;

  delete(key: string): Promise<void>;

  /**
   * Atomically increments a counter, applying `ttlSeconds` on first creation.
   * Returns the new value. This is the primitive every rate limit is built on,
   * so it must be atomic — a read-then-write would let concurrent requests
   * slip past the limit.
   */
  increment(key: string, ttlSeconds: number): Promise<number>;

  /** Remaining time to live in seconds; -1 when the key has no TTL, -2 when absent. */
  ttl(key: string): Promise<number>;

  /** Liveness check for the readiness endpoint. */
  ping(): Promise<boolean>;

  /**
   * Empties the store.
   *
   * Exists so tests can reset rate-limit and OTP counters between cases
   * without reaching into a driver's internals — which is what previously
   * coupled the test suite to one implementation's private `Map`.
   *
   * Refuses to run in production: flushing live OTPs and rate limits would be
   * a denial-of-service on the shop, not a convenience.
   */
  clear(): Promise<void>;

  disconnect(): Promise<void>;
}

/**
 * Guard shared by both drivers.
 *
 * `clear()` is a test affordance. Reaching it in production would wipe every
 * in-flight OTP and reset every rate limit, so it fails loudly rather than
 * relying on nobody ever calling it.
 */
export function assertClearAllowed(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('CacheStore.clear() must never be called in production');
  }
}

/** Key namespaces. Central so they never collide or drift. */
export const CacheKey = {
  otp: (mobile: string) => `otp:code:${mobile}`,
  otpAttempts: (mobile: string) => `otp:attempts:${mobile}`,
  otpResendCooldown: (mobile: string) => `otp:cooldown:${mobile}`,
  rateLimit: (scope: string, identifier: string) => `rl:${scope}:${identifier}`,
  config: (sellerId: string) => `config:${sellerId}`,
  sellerOpen: (sellerId: string) => `seller:open:${sellerId}`,
} as const;
