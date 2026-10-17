/**
 * Mobile app update policy (optional / mandatory updates per platform).
 *
 * Stored in the existing `configurations` table under APP_UPDATE_POLICY — no
 * table of its own: it is one global setting, and the configuration store
 * already gives it a default, a cache that every write invalidates, and an
 * admin trail. The rules themselves live in shared/app-version.ts, so the
 * backend, the admin form and the app can never disagree about them.
 *
 * FAIL-OPEN: a policy that cannot be read (database down, a hand-edited row
 * that no longer validates) is treated as DISABLED and logged. A broken
 * update setting must never lock every customer out of the app.
 */

import {
  CONFIG_DEFAULTS,
  ConfigKey,
  buildAppUpdateCheck,
  normalizeAppUpdatePolicy,
  validateAppUpdatePolicy,
  type AppPlatform,
  type AppUpdateCheckDto,
  type AppUpdatePolicy,
} from '../../shared';
import { badRequest } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import * as configService from '../configuration/configuration.service';
import * as configRepository from '../configuration/configuration.repository';

const log = moduleLogger('app-version');

/**
 * The version gate runs on every customer cart / order / payment request; the
 * configuration cache already saves the database round trip, and this short
 * in-process memo saves the cache round trip too. An admin change on this
 * instance clears it at once; other instances follow within this window plus
 * the configuration cache's own TTL.
 */
const POLICY_MEMO_MS = 5_000;
let memo: { at: number; policy: AppUpdatePolicy } | null = null;

const DISABLED: AppUpdatePolicy = { ...CONFIG_DEFAULTS.APP_UPDATE_POLICY, enabled: false };

/** For tests and after a write: the next read goes to the configuration store. */
export function clearAppUpdatePolicyMemo(): void {
  memo = null;
}

/** The current policy — never throws (see FAIL-OPEN above). */
export async function getPolicy(): Promise<AppUpdatePolicy> {
  if (memo && Date.now() - memo.at < POLICY_MEMO_MS) return memo.policy;

  let policy: AppUpdatePolicy;
  try {
    const stored = await configService.get(ConfigKey.APP_UPDATE_POLICY);
    const issues = validateAppUpdatePolicy(stored);
    if (issues.length === 0) {
      policy = normalizeAppUpdatePolicy(stored);
    } else {
      log.error({ issues }, 'stored app update policy is invalid — treating it as disabled');
      policy = DISABLED;
    }
  } catch (error) {
    log.error({ err: error }, 'could not read the app update policy — treating it as disabled');
    // Not memoised: try again on the next request.
    return DISABLED;
  }

  memo = { at: Date.now(), policy };
  return policy;
}

/** What one installed app must do — the public endpoint's answer. */
export async function checkForClient(platform: AppPlatform, installedVersion: string | null): Promise<AppUpdateCheckDto> {
  return buildAppUpdateCheck(await getPolicy(), platform, installedVersion);
}

export interface AdminAppUpdatePolicy {
  policy: AppUpdatePolicy;
  /** When the saved policy last changed; null while the built-in default applies. */
  updatedAt: string | null;
}

export async function getForAdmin(): Promise<AdminAppUpdatePolicy> {
  const row = await configRepository.findOne(ConfigKey.APP_UPDATE_POLICY, null);
  clearAppUpdatePolicyMemo();
  return { policy: await getPolicy(), updatedAt: row ? row.updatedAt.toISOString() : null };
}

/**
 * Saves a new policy. Validated in full (the same rules as the admin form),
 * stored through the configuration service (cache invalidated), audited with
 * the before/after, and in force on this instance immediately.
 */
export async function updatePolicy(input: unknown, actorUserId: string, ip: string | null): Promise<AdminAppUpdatePolicy> {
  const issues = validateAppUpdatePolicy(input);
  if (issues.length > 0) {
    throw badRequest(
      'Please fix the highlighted app update settings.',
      issues.map((issue) => ({ field: issue.field, message: issue.message })),
    );
  }
  const next = normalizeAppUpdatePolicy(input as AppUpdatePolicy);
  const before = await getPolicy();

  await configService.set({ key: ConfigKey.APP_UPDATE_POLICY, value: next, actorUserId });
  clearAppUpdatePolicyMemo();

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'app_update_policy.update',
      entityType: 'Configuration',
      entityId: ConfigKey.APP_UPDATE_POLICY,
      before: before as never,
      after: next as never,
      ip,
    },
  });
  log.warn(
    {
      actorUserId,
      enabled: next.enabled,
      mode: next.mode,
      blockUnversionedClients: next.blockUnversionedClients,
      android: { latest: next.android.latestVersion, minimum: next.android.minimumVersion },
      ios: { latest: next.ios.latestVersion, minimum: next.ios.minimumVersion },
    },
    'app update policy changed',
  );

  return getForAdmin();
}
