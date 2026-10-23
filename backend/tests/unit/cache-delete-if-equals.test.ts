/**
 * CacheStore.deleteIfEquals — the ownership-safe lock release
 * (payment.service withPaymentInitLock): a key is removed only while it still
 * holds the caller's own value.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../src/infra/cache/memory.store';
import { DELETE_IF_EQUALS_SCRIPT, RedisCacheStore } from '../../src/infra/cache/redis.store';

describe('MemoryCacheStore.deleteIfEquals', () => {
  const store = new MemoryCacheStore();
  afterEach(() => store.clear());

  it('deletes the key only while it holds the given value', async () => {
    await store.set('lock', 'mine', 60);
    expect(await store.deleteIfEquals('lock', 'someone-else')).toBe(false);
    expect(await store.get('lock')).toBe('mine');

    expect(await store.deleteIfEquals('lock', 'mine')).toBe(true);
    expect(await store.get('lock')).toBeNull();
  });

  it('is a no-op on a missing (e.g. expired) key', async () => {
    expect(await store.deleteIfEquals('gone', 'mine')).toBe(false);
  });
});

describe('RedisCacheStore.deleteIfEquals', () => {
  // A stand-in client: the store must send ONE atomic server-side script, never GET then DEL.
  const fakeClient = (evalResult: number) => ({ on: vi.fn(), eval: vi.fn(async () => evalResult), get: vi.fn(), del: vi.fn() });

  it('runs one EVAL of the compare-and-delete script with the key and the value', async () => {
    const client = fakeClient(1);
    const store = new RedisCacheStore('redis://unused', client as never);

    expect(await store.deleteIfEquals('pay:init:o1', 'token-1')).toBe(true);
    expect(client.eval).toHaveBeenCalledWith(DELETE_IF_EQUALS_SCRIPT, 1, 'pay:init:o1', 'token-1');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('reports false when the script deleted nothing (the key held another value or was gone)', async () => {
    const store = new RedisCacheStore('redis://unused', fakeClient(0) as never);
    expect(await store.deleteIfEquals('pay:init:o1', 'token-1')).toBe(false);
  });

  it('the script compares before deleting, in a single call', () => {
    expect(DELETE_IF_EQUALS_SCRIPT).toMatch(/redis\.call\("GET", KEYS\[1\]\) == ARGV\[1\]/);
    expect(DELETE_IF_EQUALS_SCRIPT).toMatch(/redis\.call\("DEL", KEYS\[1\]\)/);
  });
});
