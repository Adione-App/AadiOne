/**
 * Business configuration service.
 *
 * This is the module that makes "no hardcoded business rules" true rather than
 * aspirational. Every radius, fee, threshold, time window, limit and feature
 * flag is read through here.
 *
 * Precedence: seller override -> global row -> CONFIG_DEFAULTS.
 *
 * Caching: the whole resolved map is cached per seller for CONFIG_CACHE_TTL
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
  validateAppUpdatePolicy,
} from '@shared';
import type { Prisma } from '@prisma/client';
import { cache, CacheKey } from '../../infra/cache';
import { moduleLogger } from '../../common/logger';
import { badRequest } from '../../common/errors';
import * as repository from './configuration.repository';
import { DELIVERY_RADIUS_LIMIT_KM, isValidDeliveryRadiusKm } from '../sellers/delivery-radius-limit';

const log = moduleLogger('configuration');

const CONFIG_CACHE_TTL_SECONDS = 60;
const GLOBAL_SCOPE = 'global';

/** All valid keys, for validating admin writes. */
const VALID_KEYS = new Set<string>(Object.values(ConfigKey));

function scopeOf(sellerId: string | null): string {
  return sellerId ?? GLOBAL_SCOPE;
}

/**
 * Resolves the effective configuration map for a seller.
 *
 * Defaults are the base layer, so a key that has never been seeded still
 * returns a sane value rather than `undefined` propagating into a price
 * calculation.
 */
async function loadResolved(sellerId: string | null): Promise<ConfigValues> {
  const rows = await repository.findAllForSeller(sellerId);
  const resolved: ConfigValues = { ...CONFIG_DEFAULTS };

  for (const row of rows) {
    if (!VALID_KEYS.has(row.key)) {
      // A key in the database that the code does not know about is a leftover
      // from a rollback or a manual edit. Ignore it, but say so.
      log.warn({ key: row.key }, 'unknown configuration key in database — ignored');
      continue;
    }
    // Rows arrive global-first, so a seller override assigned later wins.
    (resolved as unknown as Record<string, unknown>)[row.key] = row.value;
  }

  return resolved;
}

/**
 * The effective map: the GLOBAL map, with — for a seller — that seller's own
 * overrides on top.
 *
 * The two are cached SEPARATELY and merged on every read. A seller's scope
 * used to cache the already-merged map, so a change to a global value (say
 * ALLOW_ORDERS_WHEN_CLOSED or the delivery radius) invalidated only the
 * global entry, and every seller kept reading the old global value until its
 * own entry expired.
 */
export async function getAll(sellerId: string | null = null): Promise<ConfigValues> {
  const global = await cachedMap(GLOBAL_SCOPE, () => loadResolved(null));
  if (!sellerId) return global as ConfigValues;
  const overrides = await cachedMap(sellerId, () => loadOverrides(sellerId));
  return { ...global, ...overrides } as ConfigValues;
}

async function cachedMap(scope: string, load: () => Promise<Partial<ConfigValues>>): Promise<Partial<ConfigValues>> {
  const cacheKey = CacheKey.config(scope);

  const cached = await cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Partial<ConfigValues>;
    } catch {
      // Corrupt cache entry must never take the site down — fall through and
      // reload from the database.
      log.warn({ cacheKey }, 'corrupt configuration cache entry — reloading');
    }
  }

  const loaded = await load();
  await cache.set(cacheKey, JSON.stringify(loaded), CONFIG_CACHE_TTL_SECONDS);
  return loaded;
}

/** Only the seller's OWN rows — merged over the global map by `getAll`. */
async function loadOverrides(sellerId: string): Promise<Partial<ConfigValues>> {
  const rows = await repository.findAllForSeller(sellerId);
  const overrides: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.sellerId !== sellerId || !VALID_KEYS.has(row.key)) continue;
    overrides[row.key] = row.value;
  }
  return overrides as Partial<ConfigValues>;
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
  sellerId: string | null = null,
): Promise<ConfigValues[K]> {
  const all = await getAll(sellerId);
  return all[key];
}

/** Reads several keys in one cache hit — used by pricing and ETA. */
export async function getMany<K extends keyof ConfigValues>(
  keys: readonly K[],
  sellerId: string | null = null,
): Promise<Pick<ConfigValues, K>> {
  const all = await getAll(sellerId);
  const out = {} as Pick<ConfigValues, K>;
  for (const key of keys) out[key] = all[key];
  return out;
}

/** The subset the unauthenticated mobile app may read. */
export async function getPublic(sellerId: string | null = null): Promise<PublicConfig> {
  const all = await getAll(sellerId);
  const out = {} as Record<string, unknown>;
  for (const key of PUBLIC_CONFIG_KEYS) out[key] = all[key];
  return out as PublicConfig;
}

export interface SetConfigInput<K extends keyof ConfigValues> {
  key: K;
  value: ConfigValues[K];
  sellerId?: string | null;
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
  const sellerId = input.sellerId ?? null;

  if (!VALID_KEYS.has(input.key)) {
    throw badRequest(`Unknown configuration key: ${String(input.key)}`);
  }

  validateValue(input.key, input.value);

  await repository.upsert({
    key: input.key,
    sellerId,
    value: input.value as Prisma.InputJsonValue,
    description: CONFIG_DESCRIPTIONS[input.key as ConfigKey],
    isPublic: (PUBLIC_CONFIG_KEYS as readonly string[]).includes(input.key),
    updatedByUserId: input.actorUserId ?? null,
  });

  await invalidate(sellerId);

  log.info(
    { key: input.key, sellerId, actorUserId: input.actorUserId },
    'configuration updated',
  );

  return input.value;
}

/** Clears the cached map for a scope. Called after every write. */
export async function invalidate(sellerId: string | null = null): Promise<void> {
  await cache.delete(CacheKey.config(scopeOf(sellerId)));
}

/** Clears every scope — used by the seed script and by tests. */
export async function invalidateAll(sellerIds: string[] = []): Promise<void> {
  await Promise.all([invalidate(null), ...sellerIds.map((id) => invalidate(id))]);
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

const MAX_SERVICEABLE_PINCODES = 2000;

/** HOME_CATEGORY_ORDER holds top-level category paths — one slug, no "/". */
const CATEGORY_PATH_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_HOME_CATEGORY_ORDER = 50;

function validateValue(key: keyof ConfigValues, value: unknown): void {
  const fail = (reason: string): never => {
    throw badRequest(`Invalid value for ${String(key)}: ${reason}`);
  };

  if (POSITIVE_NUMBER_KEYS.includes(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      fail('must be a number greater than zero');
    }
  }

  // Hyperlocal delivery: a slip of the keyboard (120 for 12) must not open a
  // whole district. Sellers' own overrides use the same limit.
  if (key === ConfigKey.MAX_SERVICE_RADIUS_KM && !isValidDeliveryRadiusKm(value)) {
    fail(`must be more than 0 and at most ${DELIVERY_RADIUS_LIMIT_KM} km`);
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

  if (key === ConfigKey.SERVICEABLE_PINCODES) {
    if (!Array.isArray(value)) fail('must be a list of 6-digit PIN codes');
    const pins = value as unknown[];
    if (pins.length > MAX_SERVICEABLE_PINCODES) fail(`can list at most ${MAX_SERVICEABLE_PINCODES} PIN codes`);
    for (const pin of pins) {
      if (typeof pin !== 'string' || !/^[1-9][0-9]{5}$/.test(pin)) fail('each entry must be a 6-digit PIN code such as "313328"');
    }
    if (new Set(pins).size !== pins.length) fail('a PIN code can be listed only once');
  }

  if (key === ConfigKey.HOME_CATEGORY_ORDER) {
    if (!Array.isArray(value)) fail('must be a list of category paths');
    const paths = value as unknown[];
    if (paths.length > MAX_HOME_CATEGORY_ORDER) fail(`can list at most ${MAX_HOME_CATEGORY_ORDER} categories`);
    for (const path of paths) {
      if (typeof path !== 'string' || !CATEGORY_PATH_PATTERN.test(path)) fail('each entry must be a top-level category path such as "grocery"');
    }
    if (new Set(paths).size !== paths.length) fail('a category can be listed only once');
  }

  // The full app-update rules (versions, store links) — the same check as the
  // dedicated admin endpoint, so the generic PATCH /admin/config cannot store
  // a policy that would lock customers out by mistake.
  if (key === ConfigKey.APP_UPDATE_POLICY) {
    const issues = validateAppUpdatePolicy(value);
    if (issues.length > 0) fail(issues.map((issue) => issue.message).join('; '));
  }

  if (key === ConfigKey.DEFAULT_COD_POLICY) {
    if (!['ALLOW', 'DENY', 'INHERIT'].includes(String(value))) {
      fail('must be ALLOW, DENY or INHERIT');
    }
  }

  if (key === ConfigKey.ORDERING_PAUSED_MESSAGE) {
    if (typeof value !== 'string' || value.length > 200) fail('must be text of at most 200 characters');
  }

  if (key === ConfigKey.STORE_TIMEZONE) {
    if (typeof value !== 'string' || !isValidTimeZone(value)) {
      fail('must be a valid IANA timezone, e.g. Asia/Kolkata');
    }
  }

  if (
    key === ConfigKey.ALLOW_ORDERS_WHEN_CLOSED ||
    key === ConfigKey.ORDERING_ENABLED ||
    key === ConfigKey.DELIVERY_OTP_REQUIRED_FOR_COD ||
    key === ConfigKey.PAYMENT_ONLINE_ENABLED ||
    key === ConfigKey.PAYMENT_COD_ENABLED ||
    String(key).startsWith('FEATURE_')
  ) {
    if (typeof value !== 'boolean') fail('must be true or false');
  }
}

/** An IANA timezone this runtime knows (e.g. Asia/Kolkata). Also used for a seller's own timezone. */
export function isValidTimeZone(timeZone: string): boolean {
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
  /** True when the effective value comes from a seller-level override. */
  isOverridden: boolean;
}

/** Everything the admin Configuration screen renders. */
export async function listForAdmin(sellerId: string | null = null): Promise<ConfigEntry[]> {
  const [resolved, rows] = await Promise.all([
    getAll(sellerId),
    repository.findAllForSeller(sellerId),
  ]);

  const overriddenKeys = new Set(
    rows.filter((row) => row.sellerId !== null).map((row) => row.key),
  );

  return (Object.values(ConfigKey) as ConfigKey[]).map((key) => ({
    key,
    value: (resolved as unknown as Record<string, unknown>)[key],
    description: CONFIG_DESCRIPTIONS[key],
    isPublic: (PUBLIC_CONFIG_KEYS as readonly string[]).includes(key),
    isOverridden: overriddenKeys.has(key),
  }));
}
