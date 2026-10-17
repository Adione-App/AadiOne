/**
 * App version policy (shared/app-version.ts) — pure: version parsing and
 * precedence, the policy rules, and the admin-form validation.
 */

import { describe, expect, it } from 'vitest';
import {
  AppUpdateMode,
  AppUpdateStatus,
  CONFIG_DEFAULTS,
  buildAppUpdateCheck,
  compareVersions,
  evaluateAppUpdate,
  isValidVersion,
  normalizeAppUpdatePolicy,
  parseVersion,
  validateAppUpdatePolicy,
  type AppUpdatePolicy,
} from '../../src/shared';

const PLAY = 'https://play.google.com/store/apps/details?id=in.adione.app';
const APP_STORE = 'https://apps.apple.com/in/app/aadione/id0000000000';

function policy(overrides: Partial<AppUpdatePolicy> = {}): AppUpdatePolicy {
  return {
    enabled: true,
    mode: AppUpdateMode.OPTIONAL,
    blockUnversionedClients: false,
    title: 'Update available',
    message: 'Please update.',
    releaseNotes: null,
    android: { latestVersion: '1.0.10', minimumVersion: '1.0.8', storeUrl: PLAY },
    ios: { latestVersion: null, minimumVersion: null, storeUrl: null },
    ...overrides,
  };
}

describe('versions', () => {
  it('compares numerically, never as strings: 1.0.10 is newer than 1.0.9', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.99')).toBe(1);
  });

  it('missing parts are zero; build metadata is ignored', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.8+9', '1.0.8+12')).toBe(0);
    expect(compareVersions(' 1.0.8 ', '1.0.8')).toBe(0);
  });

  it('SemVer pre-release precedence', () => {
    expect(compareVersions('1.1.0-beta.1', '1.1.0')).toBe(-1);
    expect(compareVersions('1.1.0', '1.1.0-rc.1')).toBe(1);
    expect(compareVersions('1.1.0-alpha', '1.1.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.1.0-alpha.2', '1.1.0-alpha.10')).toBe(-1);
    expect(compareVersions('1.1.0-1', '1.1.0-alpha')).toBe(-1);
    expect(compareVersions('1.1.0-beta', '1.1.0-alpha')).toBe(1);
  });

  it('rejects anything that is not a version — never guesses', () => {
    for (const bad of ['', '   ', 'v1.0.0', '1.0.x', '1..0', '01.0.0', '1.0.0.0', '1.0.0-', '1.0.0-01', 'latest', '1.0.0 beta', '9'.repeat(40), null, undefined, 108, {}]) {
      expect(isValidVersion(bad)).toBe(false);
      expect(compareVersions(bad, '1.0.0')).toBeNull();
    }
    expect(parseVersion('1.0.8')).toEqual({ major: 1, minor: 0, patch: 8, prerelease: [] });
  });
});

describe('evaluateAppUpdate — the policy rules', () => {
  it('disabled: no prompt and no block, whatever the versions', () => {
    expect(evaluateAppUpdate(policy({ enabled: false }), 'android', '0.1.0')).toBe(AppUpdateStatus.NONE);
  });

  it('below the minimum supported version: required, even in optional mode', () => {
    expect(evaluateAppUpdate(policy(), 'android', '1.0.7')).toBe(AppUpdateStatus.REQUIRED);
    expect(evaluateAppUpdate(policy(), 'android', '1.0.8-beta.1')).toBe(AppUpdateStatus.REQUIRED);
  });

  it('supported but below the latest: optional in optional mode, required in mandatory mode', () => {
    expect(evaluateAppUpdate(policy(), 'android', '1.0.8')).toBe(AppUpdateStatus.OPTIONAL);
    expect(evaluateAppUpdate(policy(), 'android', '1.0.9')).toBe(AppUpdateStatus.OPTIONAL);
    expect(evaluateAppUpdate(policy({ mode: AppUpdateMode.MANDATORY }), 'android', '1.0.9')).toBe(AppUpdateStatus.REQUIRED);
  });

  it('current or newer: normal use, in either mode', () => {
    for (const mode of [AppUpdateMode.OPTIONAL, AppUpdateMode.MANDATORY]) {
      expect(evaluateAppUpdate(policy({ mode }), 'android', '1.0.10')).toBe(AppUpdateStatus.NONE);
      expect(evaluateAppUpdate(policy({ mode }), 'android', '1.1.0')).toBe(AppUpdateStatus.NONE);
    }
  });

  it('Android and iOS are separate: an Android policy never blocks an iPhone, and the reverse', () => {
    const p = policy({ mode: AppUpdateMode.MANDATORY });
    expect(evaluateAppUpdate(p, 'android', '1.0.0')).toBe(AppUpdateStatus.REQUIRED);
    expect(evaluateAppUpdate(p, 'ios', '1.0.0')).toBe(AppUpdateStatus.NONE);

    const iosOnly = policy({
      android: { latestVersion: null, minimumVersion: null, storeUrl: PLAY },
      ios: { latestVersion: '2.0.0', minimumVersion: '2.0.0', storeUrl: APP_STORE },
    });
    expect(evaluateAppUpdate(iosOnly, 'ios', '1.9.0')).toBe(AppUpdateStatus.REQUIRED);
    expect(evaluateAppUpdate(iosOnly, 'android', '1.0.0')).toBe(AppUpdateStatus.NONE);
  });

  it('an unknown or malformed installed version is never blocked by the version rules', () => {
    expect(evaluateAppUpdate(policy(), 'android', null)).toBe(AppUpdateStatus.NONE);
    expect(evaluateAppUpdate(policy(), 'android', 'garbage')).toBe(AppUpdateStatus.NONE);
  });

  it('the answer carries the store link, versions and a prompt key that changes with each release', () => {
    const check = buildAppUpdateCheck(policy(), 'android', '1.0.9');
    expect(check).toMatchObject({
      status: AppUpdateStatus.OPTIONAL,
      platform: 'android',
      installedVersion: '1.0.9',
      latestVersion: '1.0.10',
      minimumVersion: '1.0.8',
      storeUrl: PLAY,
    });
    const next = buildAppUpdateCheck(policy({ android: { latestVersion: '1.0.11', minimumVersion: '1.0.8', storeUrl: PLAY } }), 'android', '1.0.9');
    expect(next.promptKey).not.toBe(check.promptKey);
    expect(buildAppUpdateCheck(policy(), 'android', 'nope').installedVersion).toBeNull();
  });
});

describe('validateAppUpdatePolicy — what the admin may save', () => {
  const fields = (p: unknown) => validateAppUpdatePolicy(p).map((issue) => issue.field);

  it('the built-in default is valid (and off)', () => {
    expect(validateAppUpdatePolicy(CONFIG_DEFAULTS.APP_UPDATE_POLICY)).toEqual([]);
    expect(CONFIG_DEFAULTS.APP_UPDATE_POLICY.enabled).toBe(false);
  });

  it('a well-formed policy passes; empty form fields mean "not set"', () => {
    expect(validateAppUpdatePolicy(policy())).toEqual([]);
    expect(validateAppUpdatePolicy(policy({ ios: { latestVersion: '', minimumVersion: '', storeUrl: '' } as never }))).toEqual([]);
  });

  it('rejects invalid versions, a minimum newer than the latest, and a minimum without a latest', () => {
    expect(fields(policy({ android: { latestVersion: '1.0.x', minimumVersion: '1.0.8', storeUrl: PLAY } }))).toContain('android.latestVersion');
    expect(fields(policy({ android: { latestVersion: '1.0.9', minimumVersion: '1.0.10', storeUrl: PLAY } }))).toContain('android.minimumVersion');
    expect(fields(policy({ android: { latestVersion: null, minimumVersion: '1.0.8', storeUrl: PLAY } }))).toContain('android.latestVersion');
  });

  it('store links must be the official https listings, and are required while a platform has a policy', () => {
    expect(fields(policy({ android: { latestVersion: '1.0.9', minimumVersion: null, storeUrl: 'http://play.google.com/store/apps/details?id=x' } }))).toContain('android.storeUrl');
    expect(fields(policy({ android: { latestVersion: '1.0.9', minimumVersion: null, storeUrl: 'https://evil.example/apk' } }))).toContain('android.storeUrl');
    expect(fields(policy({ ios: { latestVersion: '1.0.0', minimumVersion: null, storeUrl: PLAY } }))).toContain('ios.storeUrl');
    expect(fields(policy({ android: { latestVersion: '1.0.9', minimumVersion: null, storeUrl: null } }))).toContain('android.storeUrl');
    // Not required while the policy is off.
    expect(validateAppUpdatePolicy(policy({ enabled: false, android: { latestVersion: '1.0.9', minimumVersion: null, storeUrl: null } }))).toEqual([]);
  });

  it('rejects a bad mode, missing text and non-objects', () => {
    expect(fields(policy({ mode: 'FORCE' as never }))).toContain('mode');
    expect(fields(policy({ title: '  ' }))).toContain('title');
    expect(fields(policy({ message: 'x'.repeat(501) }))).toContain('message');
    expect(fields({ ...policy(), android: undefined })).toContain('android');
    expect(validateAppUpdatePolicy(null)).toHaveLength(1);
    expect(validateAppUpdatePolicy('on')).toHaveLength(1);
  });

  it('normalises text and empty values', () => {
    const normalised = normalizeAppUpdatePolicy(policy({ title: '  Update  ', releaseNotes: '   ', ios: { latestVersion: ' ', minimumVersion: '', storeUrl: '' } as never }));
    expect(normalised.title).toBe('Update');
    expect(normalised.releaseNotes).toBeNull();
    expect(normalised.ios).toEqual({ latestVersion: null, minimumVersion: null, storeUrl: null });
  });
});
