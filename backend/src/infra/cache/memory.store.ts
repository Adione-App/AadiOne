/**
 * In-process CacheStore backed by `node-cache`.
 *
 * Used whenever REDIS=false — the default, so the project runs with nothing
 * but PostgreSQL installed.
 *
 * WHAT THIS DRIVER CANNOT DO, and why the distinction matters:
 *   - state is lost on restart, so every in-flight OTP and every rate-limit
 *     counter resets when the process bounces;
 *   - state is per-process, so two API instances would each enforce their own
 *     half of a rate limit.
 *
 * Neither is a problem for a single-process deployment, which is what V1 is —
 * the cost is that a restart briefly forgives rate limits and invalidates
 * OTPs already sent. Switch REDIS=true to remove both.
 *
 * All node-cache operations are synchronous, so a read-then-write inside one
 * function runs to completion before another request is handled. That is what
 * makes `increment` and `setIfAbsent` atomic with respect to other requests in
 * this process — the only scope this driver claims to cover.
 */

import NodeCache from 'node-cache';
import { assertClearAllowed, type CacheStore } from './types';

export class MemoryCacheStore implements CacheStore {
  private readonly cache: NodeCache;

  constructor() {
    this.cache = new NodeCache({
      // Every key we store carries an explicit TTL, so there is no default.
      stdTTL: 0,
      checkperiod: 60,
      // Values are strings; cloning them would only add copies.
      useClones: false,
      deleteOnExpire: true,
    });
  }

  async get(key: string): Promise<string | null> {
    return this.cache.get<string>(key) ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.cache.set(key, value, ttlSeconds);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.cache.has(key)) return false;
    this.cache.set(key, value, ttlSeconds);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.cache.del(key);
  }

  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    // No await between the read and the delete: atomic within this process.
    if (this.cache.get<string>(key) !== value) return false;
    this.cache.del(key);
    return true;
  }

  /**
   * The TTL is applied only when the counter is created, so a caller cannot
   * extend their own window by making more requests — which would quietly turn
   * a fixed-window rate limit into no limit at all.
   */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    const existing = this.cache.get<string>(key);

    if (existing === undefined) {
      this.cache.set(key, '1', ttlSeconds);
      return 1;
    }

    const next = Number(existing) + 1;
    // Preserves the original expiry rather than resetting it.
    this.cache.set(key, String(next), this.remainingTtlSeconds(key));
    return next;
  }

  private remainingTtlSeconds(key: string): number {
    const expiresAtMs = this.cache.getTtl(key);
    if (!expiresAtMs) return 0;
    return Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
  }

  /** Matches Redis semantics: -2 when absent, -1 when no TTL. */
  async ttl(key: string): Promise<number> {
    if (!this.cache.has(key)) return -2;
    const expiresAtMs = this.cache.getTtl(key);
    if (!expiresAtMs) return -1;
    return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async clear(): Promise<void> {
    assertClearAllowed();
    this.cache.flushAll();
  }

  async disconnect(): Promise<void> {
    this.cache.flushAll();
    this.cache.close();
  }
}
