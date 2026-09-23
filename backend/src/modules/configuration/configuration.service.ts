/**
 * Business configuration service.
 *
 * This is the module that makes "no hardcoded business rules" true rather than
 * aspirational. Every radius, fee, threshold, time window, limit and feature
 * flag is read through here.
 *
 * Precedence: store override -> global row -> CONFIG_DEFAULTS.
 *
 * Caching: the whole resolved map is cached per store for CONFIG_CACHE_TTL
 * seconds, and invalidated explicitly on write. The table is a few dozen rows,
 * so caching the map rather than individual keys keeps reads to a single
 * lookup and makes invalidation trivial. A 60-second TTL means an admin edit
 * takes effect immediately on the writing node and within a minute everywhere
 * else, which is the right trade for values that change a few times a month.
 */

import {
  CONFIG_DEFAULTS,
  CONFIG_DESCRIPTIONS,
  ConfigKey,
  PUBLIC_CONFIG_KEYS,
  type ConfigValues,
  type PublicConfig,
} from '@shared';
import type { Prisma } from '@prisma/client';
import { cache, CacheKey } from '../../infra/cache';
import { moduleLogger } from '../../common/logger';
import { badRequest } from '../../common/errors';
import * as repository from './configuration.repository';

const log = moduleLogger('configuration');

const CONFIG_CACHE_TTL_SECONDS = 60;
const GLOBAL_SCOPE = 'global';

/** All valid keys, for validating admin writes. */
const VALID_KEYS = new Set<string>(Object.values(ConfigKey));

function scopeOf(storeId: string | null): string {
  return storeId ?? GLOBAL_SCOPE;
}

/**
 * Resolves the effective configuration map for a store.
 *
 * Defaults are the base layer, so a key that has never been seeded still
 * returns a sane value rather than `undefined` propagating into a price
 * calculation.
 */
async function loadResolved(storeId: string | null): Promise<ConfigValues> {
  const rows = await repository.findAllForStore(storeId);
  const resolved: ConfigValues = { ...CONFIG_DEFAULTS };

  for (const row of rows) {
    if (!VALID_KEYS.has(row.key)) {
      // A key in the database that the code does not know about is a leftover
      // from a rollback or a manual edit. Ignore it, but say so.
      log.warn({ key: row.key }, 'unknown configuration key in database — ignored');
      continue;
    }
    // Rows arrive global-first, so a store override assigned later wins.
    (resolved as unknown as Record<string, unknown>)[row.key] = row.value;
  }

  return resolved;
}

export async function getAll(storeId: string | null = null): Promise<ConfigValues> {
  const cacheKey = CacheKey.config(scopeOf(storeId));

  const cached = await cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ConfigValues;
    } catch {
      // Corrupt cache entry must never take the site down — fall through and
      // reload from the database.
      log.warn({ cacheKey }, 'corrupt configuration cache entry — reloading');
    }
  }

  const resolved = await loadResolved(storeId);
  await cache.set(cacheKey, JSON.stringify(resolved), CONFIG_CACHE_TTL_SECONDS);
  return resolved;
}

/**
 * Reads one typed configuration value.
 *
 * The return type is derived from the key, so `get(ConfigKey.MAX_SERVICE_RADIUS_KM)`
 * is a `number` and `get(ConfigKey.DELIVERY_FEE_SLABS)` is `DeliveryFeeSlab[]`
 * without a cast at the call site.
 */
export async function get<K extends keyof ConfigValues>(
  key: K,
  storeId: string | null = null,
): Promise<ConfigValues[K]> {
  const all = await getAll(storeId);
  return all[key];
}

/** Reads several keys in one cache hit — used by pricing and ETA. */
export async function getMany<K extends keyof ConfigValues>(
  keys: readonly K[],
  storeId: string | null = null,
): Promise<Pick<ConfigValues, K>> {
  const all = await getAll(storeId);
  const out = {} as Pick<ConfigValues, K>;
  for (const key of keys) out[key] = all[key];
  return out;
}

/** The subset the unauthenticated mobile app may read. */
export async function getPublic(storeId: string | null = null): Promise<PublicConfig> {
  const all = await getAll(storeId);
  const out = {} as Record<string, unknown>;
  for (const key of PUBLIC_CONFIG_KEYS) out[key] = all[key];
  return out as PublicConfig;
}

export interface SetConfigInput<K extends keyof ConfigValues> {
  key: K;
  value: ConfigValues[K];
  storeId?: string | null;
  actorUserId?: string | null;
}

/**
 * Writes a configuration value and invalidates the cache for that scope.
 *
 * Validation is deliberately strict: a malformed `DELIVERY_FEE_SLABS` or a
 * negative radius would silently corrupt every price and serviceability
 * decision until someone noticed.
 */
export async function set<K extends keyof ConfigValues>(
  input: SetConfigInput<K>,
): Promise<ConfigValues[K]> {
  const storeId = input.storeId ?? null;

  if (!VALID_KEYS.has(input.key)) {
    throw badRequest(`Unknown configuration key: ${String(input.key)}`);
  }

  validateValue(input.key, input.value);

  await repository.upsert({
    key: input.key,
    storeId,
    value: input.value as Prisma.InputJsonValue,
    description: CONFIG_DESCRIPTIONS[input.key as ConfigKey],
    isPublic: (PUBLIC_CONFIG_KEYS as readonly string[]).includes(input.key),
    updatedByUserId: input.actorUserId ?? null,
  });

  await invalidate(storeId);

  log.info(
    { key: input.key, storeId, actorUserId: input.actorUserId },
    'configuration updated',
  );

  return input.value;
}

/** Clears the cached map for a scope. Called after every write. */
export async function invalidate(storeId: string | null = null): Promise<void> {
  await cache.delete(CacheKey.config(scopeOf(storeId)));
}

/** Clears every scope — used by the seed script and by tests. */
export async function invalidateAll(storeIds: string[] = []): Promise<void> {
  await Promise.all([invalidate(null), ...storeIds.map((id) => invalidate(id))]);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const POSITIVE_NUMBER_KEYS: readonly (keyof ConfigValues)[] = [
  ConfigKey.MAX_SERVICE_RADIUS_KM,
  ConfigKey.ROAD_DISTANCE_FACTOR,
  ConfigKey.AVG_DELIVERY_SPEED_KMPH,
  ConfigKey.ORDERS_PER_RIDER_BATCH,
  ConfigKey.PAYMENT_HOLD_MINUTES,
  ConfigKey.DEFAULT_MAX_QTY_PER_ORDER,
  ConfigKey.MAX_ADDRESSES_PER_USER,
  ConfigKey.REFERRAL_COUPON_EXPIRY_DAYS,
];

const NON_NEGATIVE_NUMBER_KEYS: readonly (keyof ConfigValues)[] = [
  ConfigKey.MIN_ORDER_VALUE_PAISE,
  ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE,
  ConfigKey.PLATFORM_FEE_PAISE,
  ConfigKey.COD_MAX_ORDER_VALUE_PAISE,
  ConfigKey.COD_FIRST_ORDER_MAX_PAISE,
  ConfigKey.BASE_PREPARATION_MINUTES,
  ConfigKey.PER_ITEM_PICK_SECONDS,
  ConfigKey.BATCH_DELAY_MINUTES,
  ConfigKey.ETA_BUFFER_MINUTES,
  ConfigKey.LOW_STOCK_THRESHOLD,
  ConfigKey.REFERRAL_REWARD_PAISE,
  ConfigKey.REFERRAL_MIN_ORDER_PAISE,
];

function validateValue(key: keyof ConfigValues, value: unknown): void {
  const fail = (reason: string): never => {
    throw badRequest(`Invalid value for ${String(key)}: ${reason}`);
  };

  if (POSITIVE_NUMBER_KEYS.includes(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      fail('must be a number greater than zero');
    }
  }

  if (NON_NEGATIVE_NUMBER_KEYS.includes(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail('must be a number of zero or more');
    }
  }

  // Money keys are paise and must be whole numbers — a fractional paisa would
  // propagate rounding error into every order total.
  if (String(key).endsWith('_PAISE') && typeof value === 'number' && !Number.isInteger(value)) {
    fail('must be a whole number of paise');
  }

  if (key === ConfigKey.DELIVERY_FEE_SLABS) {
    if (!Array.isArray(value) || value.length === 0) {
      fail('must be a non-empty array of { maxKm, feePaise }');
    }
    for (const slab of value as unknown[]) {
      const s = slab as { maxKm?: unknown; feePaise?: unknown };
      if (typeof s.maxKm !== 'number' || s.maxKm <= 0) fail('each slab needs a positive maxKm');
      if (typeof s.feePaise !== 'number' || !Number.isInteger(s.feePaise) || s.feePaise < 0) {
        fail('each slab needs a whole, non-negative feePaise');
      }
    }
  }

  if (key === ConfigKey.DEFAULT_COD_POLICY) {
    if (!['ALLOW', 'DENY', 'INHERIT'].includes(String(value))) {
      fail('must be ALLOW, DENY or INHERIT');
    }
  }

  if (key === ConfigKey.STORE_TIMEZONE) {
    if (typeof value !== 'string' || !isValidTimeZone(value)) {
      fail('must be a valid IANA timezone, e.g. Asia/Kolkata');
    }
  }

  if (
    key === ConfigKey.ALLOW_ORDERS_WHEN_CLOSED ||
    key === ConfigKey.DELIVERY_OTP_REQUIRED_FOR_COD ||
    String(key).startsWith('FEATURE_')
  ) {
    if (typeof value !== 'boolean') fail('must be true or false');
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Admin listing                                                              */
/* -------------------------------------------------------------------------- */

export interface ConfigEntry {
  key: ConfigKey;
  value: unknown;
  description: string;
  isPublic: boolean;
  /** True when the effective value comes from a store-level override. */
  isOverridden: boolean;
}

/** Everything the admin Configuration screen renders. */
export async function listForAdmin(storeId: string | null = null): Promise<ConfigEntry[]> {
  const [resolved, rows] = await Promise.all([
    getAll(storeId),
    repository.findAllForStore(storeId),
  ]);

  const overriddenKeys = new Set(
    rows.filter((row) => row.storeId !== null).map((row) => row.key),
  );

  return (Object.values(ConfigKey) as ConfigKey[]).map((key) => ({
    key,
    value: (resolved as unknown as Record<string, unknown>)[key],
    description: CONFIG_DESCRIPTIONS[key],
    isPublic: (PUBLIC_CONFIG_KEYS as readonly string[]).includes(key),
    isOverridden: overriddenKeys.has(key),
  }));
}
