/**
 * Redis-backed CacheStore — the production driver.
 */

import Redis from 'ioredis';
import { moduleLogger } from '../../common/logger';
import { assertClearAllowed, type CacheStore } from './types';

const log = moduleLogger('cache:redis');

/** GET and DEL in one server-side step, so no other client can act in between. */
export const DELETE_IF_EQUALS_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

export class RedisCacheStore implements CacheStore {
  private readonly client: Redis;

  /** `client` is a test seam; production always connects from `url`. */
  constructor(url: string, client?: Redis) {
    this.client = client ?? new Redis(url, {
      // Fail fast rather than queueing commands behind a dead connection —
      // a stuck OTP request is worse than a clear error.
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 3000),
      lazyConnect: false,
    });

    this.client.on('error', (error) => log.error({ err: error }, 'redis error'));
    this.client.on('connect', () => log.info('redis connected'));
    this.client.on('reconnecting', () => log.warn('redis reconnecting'));
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    return (await this.client.eval(DELETE_IF_EQUALS_SCRIPT, 1, key, value)) === 1;
  }

  /**
   * INCR + conditional EXPIRE in one round trip.
   *
   * The TTL is applied only when the counter is created (`result === 1`), so a
   * caller cannot extend a window by making more requests — which would defeat
   * the point of a fixed-window rate limit.
   */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    const [incrResult] = (await this.client
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .exec()) as [[Error | null, number], [Error | null, number]];

    const [error, value] = incrResult;
    if (error) throw error;
    return value;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    assertClearAllowed();
    await this.client.flushdb();
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
