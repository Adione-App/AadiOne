/**
 * App version policy — the ONE definition the backend, the admin panel and
 * the mobile app share: how versions compare, what the admin may configure,
 * and what a given installed version must do.
 *
 * POLICY RULES (deterministic; `evaluateAppUpdate`):
 *
 *   1. Policy disabled                     -> NONE (no prompt, no block).
 *   2. Installed version unknown/malformed -> NONE here. Whether an app that
 *      sends no usable version may use the customer APIs is a separate,
 *      explicit switch (`blockUnversionedClients`), enforced by the backend.
 *   3. Installed < minimumVersion          -> REQUIRED, whatever the mode.
 *   4. Installed < latestVersion           -> OPTIONAL in OPTIONAL mode,
 *                                             REQUIRED in MANDATORY mode
 *                                             (MANDATORY = "the latest version
 *                                             is the minimum").
 *   5. Otherwise (current or newer)        -> NONE.
 *
 * Android and iOS have separate versions and store links: an Android policy
 * never affects an iPhone, and the reverse. A platform with neither version
 * set is unaffected.
 *
 * Versions are compared numerically by SemVer precedence — never as strings:
 * 1.0.10 > 1.0.9, 1.0 == 1.0.0, 1.1.0-beta.1 < 1.1.0, and build metadata
 * (1.0.8+9) is ignored. Anything that is not a version is rejected, never
 * guessed at.
 *
 * Dependency-free: runs in Node, the browser and Hermes.
 */

export const AppPlatform = {
  ANDROID: 'android',
  IOS: 'ios',
} as const;

export type AppPlatform = (typeof AppPlatform)[keyof typeof AppPlatform];

export const APP_PLATFORMS: readonly AppPlatform[] = [AppPlatform.ANDROID, AppPlatform.IOS];

/**
 * Request headers the mobile app sends on every API call. Lower-case: Node
 * lower-cases incoming header names.
 *   x-app-platform  android | ios
 *   x-app-version   the installed marketing version, e.g. 1.0.8
 *   x-app-build     the native build number (Android versionCode / iOS
 *                   buildNumber) — informational only, never compared
 */
export const APP_VERSION_HEADERS = {
  PLATFORM: 'x-app-platform',
  VERSION: 'x-app-version',
  BUILD: 'x-app-build',
} as const;

export const AppUpdateMode = {
  OPTIONAL: 'OPTIONAL',
  MANDATORY: 'MANDATORY',
} as const;

export type AppUpdateMode = (typeof AppUpdateMode)[keyof typeof AppUpdateMode];

export const AppUpdateStatus = {
  NONE: 'NONE',
  OPTIONAL: 'OPTIONAL',
  REQUIRED: 'REQUIRED',
} as const;

export type AppUpdateStatus = (typeof AppUpdateStatus)[keyof typeof AppUpdateStatus];

/** One platform's versions and official store listing. */
export interface AppPlatformPolicy {
  /** The newest version published in the store; null = not set. */
  latestVersion: string | null;
  /** The oldest version still allowed to use the app; null = no minimum. */
  minimumVersion: string | null;
  /** The official store listing (https, Play Store / App Store only); null = not known yet. */
  storeUrl: string | null;
}

/** The whole policy, as the admin configures it (configuration key APP_UPDATE_POLICY). */
export interface AppUpdatePolicy {
  enabled: boolean;
  mode: AppUpdateMode;
  /**
   * Also refuse the customer APIs to app builds that send NO version (builds
   * released before version checks existed), while the policy is enabled.
   * They cannot show the update screen, so they get the plain error message.
   */
  blockUnversionedClients: boolean;
  title: string;
  message: string;
  releaseNotes: string | null;
  android: AppPlatformPolicy;
  ios: AppPlatformPolicy;
}

/** GET /app-version/policy — only what the app needs to decide and show. */
export interface AppUpdateCheckDto {
  status: AppUpdateStatus;
  platform: AppPlatform;
  installedVersion: string | null;
  latestVersion: string | null;
  minimumVersion: string | null;
  storeUrl: string | null;
  title: string;
  message: string;
  releaseNotes: string | null;
  /**
   * Changes whenever what the customer is asked to install changes — the app
   * keys an optional prompt's "Later" to it, so a new release asks again.
   */
  promptKey: string;
}

export const APP_UPDATE_LIMITS = {
  VERSION_MAX: 32,
  TITLE_MAX: 80,
  MESSAGE_MAX: 500,
  RELEASE_NOTES_MAX: 2000,
  STORE_URL_MAX: 300,
} as const;

/** Official store hosts — the only places an update may be sent to. */
export const APP_STORE_HOSTS: Readonly<Record<AppPlatform, readonly string[]>> = {
  android: ['play.google.com'],
  ios: ['apps.apple.com'],
};

/* -------------------------------------------------------------------------- */
/* Versions                                                                   */
/* -------------------------------------------------------------------------- */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** SemVer pre-release identifiers (numeric ones as numbers); empty for a release. */
  prerelease: (number | string)[];
}

// MAJOR[.MINOR[.PATCH]][-PRERELEASE][+BUILD]; numeric parts without leading zeros.
const VERSION_PATTERN =
  /^(0|[1-9]\d{0,8})(?:\.(0|[1-9]\d{0,8}))?(?:\.(0|[1-9]\d{0,8}))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A version string, or null when it is not one (never guessed at). */
export function parseVersion(input: unknown): ParsedVersion | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value === '' || value.length > APP_UPDATE_LIMITS.VERSION_MAX) return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  // SemVer: numeric pre-release identifiers must not have leading zeros.
  if (match[4] && match[4].split('.').some((part) => /^0\d+$/.test(part))) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease,
  };
}

export function isValidVersion(input: unknown): input is string {
  return parseVersion(input) !== null;
}

/**
 * SemVer precedence: <0 when a < b, 0 when equal, >0 when a > b; null when
 * either is not a version. Build metadata is ignored.
 */
export function compareVersions(a: unknown, b: unknown): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  // A pre-release sorts before its release.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1; // numeric identifiers sort before alphanumeric ones
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isAppPlatform(input: unknown): input is AppPlatform {
  return input === AppPlatform.ANDROID || input === AppPlatform.IOS;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/** What an installed version must do under a policy (see the rules at the top). */
export function evaluateAppUpdate(
  policy: AppUpdatePolicy,
  platform: AppPlatform,
  installedVersion: string | null | undefined,
): AppUpdateStatus {
  if (!policy.enabled) return AppUpdateStatus.NONE;
  const platformPolicy = policy[platform];
  if (!platformPolicy || !isValidVersion(installedVersion)) return AppUpdateStatus.NONE;

  const belowMinimum =
    platformPolicy.minimumVersion !== null && (compareVersions(installedVersion, platformPolicy.minimumVersion) ?? 0) < 0;
  if (belowMinimum) return AppUpdateStatus.REQUIRED;

  const belowLatest =
    platformPolicy.latestVersion !== null && (compareVersions(installedVersion, platformPolicy.latestVersion) ?? 0) < 0;
  if (belowLatest) return policy.mode === AppUpdateMode.MANDATORY ? AppUpdateStatus.REQUIRED : AppUpdateStatus.OPTIONAL;

  return AppUpdateStatus.NONE;
}

/** The app-facing answer for one installed version. */
export function buildAppUpdateCheck(
  policy: AppUpdatePolicy,
  platform: AppPlatform,
  installedVersion: string | null | undefined,
): AppUpdateCheckDto {
  const platformPolicy = policy[platform];
  const status = evaluateAppUpdate(policy, platform, installedVersion);
  const latest = platformPolicy.latestVersion;
  return {
    status,
    platform,
    installedVersion: isValidVersion(installedVersion) ? installedVersion.trim() : null,
    latestVersion: latest,
    minimumVersion: platformPolicy.minimumVersion,
    storeUrl: platformPolicy.storeUrl,
    title: policy.title,
    message: policy.message,
    releaseNotes: policy.releaseNotes,
    promptKey: `${platform}:${latest ?? '-'}:${platformPolicy.minimumVersion ?? '-'}:${policy.mode}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface AppUpdatePolicyIssue {
  /** Dotted path of the field, e.g. "android.minimumVersion". */
  field: string;
  message: string;
}

function isStoreUrl(value: string, platform: AppPlatform): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && APP_STORE_HOSTS[platform].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Every problem with a policy the admin wants to save — empty when it is
 * valid. Shared so the admin form shows the same errors the server enforces.
 */
export function validateAppUpdatePolicy(input: unknown): AppUpdatePolicyIssue[] {
  const issues: AppUpdatePolicyIssue[] = [];
  // An empty form field means "not set".
  const blank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  const add = (field: string, message: string) => issues.push({ field, message });
  if (!input || typeof input !== 'object') return [{ field: '', message: 'must be an object' }];
  const policy = input as Partial<Record<keyof AppUpdatePolicy, unknown>>;

  if (typeof policy.enabled !== 'boolean') add('enabled', 'must be true or false');
  if (policy.mode !== AppUpdateMode.OPTIONAL && policy.mode !== AppUpdateMode.MANDATORY) add('mode', 'must be OPTIONAL or MANDATORY');
  if (typeof policy.blockUnversionedClients !== 'boolean') add('blockUnversionedClients', 'must be true or false');

  const text = (field: 'title' | 'message', max: number) => {
    const value = policy[field];
    if (typeof value !== 'string' || value.trim() === '') add(field, 'is required');
    else if (value.length > max) add(field, `must be at most ${max} characters`);
  };
  text('title', APP_UPDATE_LIMITS.TITLE_MAX);
  text('message', APP_UPDATE_LIMITS.MESSAGE_MAX);
  if (policy.releaseNotes !== null && policy.releaseNotes !== undefined) {
    if (typeof policy.releaseNotes !== 'string') add('releaseNotes', 'must be text');
    else if (policy.releaseNotes.length > APP_UPDATE_LIMITS.RELEASE_NOTES_MAX) {
      add('releaseNotes', `must be at most ${APP_UPDATE_LIMITS.RELEASE_NOTES_MAX} characters`);
    }
  }

  for (const platform of APP_PLATFORMS) {
    const raw = policy[platform];
    if (!raw || typeof raw !== 'object') {
      add(platform, 'is required');
      continue;
    }
    const p = raw as Partial<Record<keyof AppPlatformPolicy, unknown>>;
    const label = platform === AppPlatform.ANDROID ? 'Android' : 'iOS';
    for (const field of ['latestVersion', 'minimumVersion'] as const) {
      const value = p[field];
      if (!blank(value) && !isValidVersion(value)) {
        add(`${platform}.${field}`, `${label}: not a valid version (use numbers like 1.0.9)`);
      }
    }
    const latest = isValidVersion(p.latestVersion) ? p.latestVersion : null;
    const minimum = isValidVersion(p.minimumVersion) ? p.minimumVersion : null;
    if (minimum !== null && blank(p.latestVersion)) {
      add(`${platform}.latestVersion`, `${label}: set the latest version too`);
    }
    if (minimum !== null && latest !== null && (compareVersions(minimum, latest) ?? 0) > 0) {
      add(`${platform}.minimumVersion`, `${label}: the minimum supported version cannot be newer than the latest version`);
    }
    if (!blank(p.storeUrl)) {
      if (typeof p.storeUrl !== 'string' || p.storeUrl.length > APP_UPDATE_LIMITS.STORE_URL_MAX || !isStoreUrl(p.storeUrl, platform)) {
        add(
          `${platform}.storeUrl`,
          `${label}: must be the official https://${APP_STORE_HOSTS[platform][0]}/… listing`,
        );
      }
    }
    // A version policy for a platform needs somewhere to send the customer.
    if (policy.enabled === true && (latest !== null || minimum !== null) && blank(p.storeUrl)) {
      add(`${platform}.storeUrl`, `${label}: the store link is required while the policy is enabled`);
    }
  }
  return issues;
}

/** The policy with every value normalised (trimmed text, empty -> null). Assumes it validated. */
export function normalizeAppUpdatePolicy(policy: AppUpdatePolicy): AppUpdatePolicy {
  const clean = (value: string | null | undefined) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed === '' ? null : trimmed;
  };
  const platform = (p: AppPlatformPolicy): AppPlatformPolicy => ({
    latestVersion: clean(p.latestVersion),
    minimumVersion: clean(p.minimumVersion),
    storeUrl: clean(p.storeUrl),
  });
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    blockUnversionedClients: policy.blockUnversionedClients,
    title: policy.title.trim(),
    message: policy.message.trim(),
    releaseNotes: clean(policy.releaseNotes),
    android: platform(policy.android),
    ios: platform(policy.ios),
  };
}
