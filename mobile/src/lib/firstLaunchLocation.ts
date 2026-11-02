/**
 * First launch: the system's own location dialog, asked directly — no
 * explanation screen of Aadione's before it, and nothing of Aadione's after
 * a denial. Pure (storage, permission and the reading come in as
 * parameters), so every case is unit-tested (tests/firstLaunchLocation.test.ts).
 *
 *   asked once per install  the "asked" mark is written BEFORE the dialog, so
 *                           a denial, "Only this time" expiring, or the app
 *                           being killed while the dialog is up never makes
 *                           the app open the dialog again by itself;
 *   never when not needed   permission already granted (the launch reading
 *                           uses it), or the OS will not ask any more, or a
 *                           delivery location is already chosen;
 *   foreground only         the request is the "while using the app" one
 *                           (lib/deviceLocation.ts) — never background.
 *
 * After it, the customer asks again only through the normal location
 * selector ("Use current location"), and a permission switched on later in
 * Android's Settings is picked up by the resume reading (App.tsx).
 */

import type { PermissionState } from './currentLocation';

export interface FirstLaunchDeps {
  /** True once the dialog was asked on this install (unreadable storage counts as asked). */
  asked(): Promise<boolean>;
  markAsked(): Promise<void>;
  permission(): Promise<PermissionState>;
  /** A delivery location (GPS or a saved address) is already chosen. */
  hasLocation(): boolean;
  /** The system dialog, then the GPS reading and the serviceability check. */
  request(): Promise<unknown>;
}

export type FirstLaunchResult = 'REQUESTED' | 'ALREADY_ASKED' | 'GRANTED' | 'CANNOT_ASK' | 'LOCATION_CHOSEN';

export function createFirstLaunchLocation(deps: FirstLaunchDeps) {
  let running: Promise<FirstLaunchResult> | null = null;

  async function run(): Promise<FirstLaunchResult> {
    if (deps.hasLocation()) return 'LOCATION_CHOSEN';
    if (await deps.asked().catch(() => true)) return 'ALREADY_ASKED';
    const permission = await deps.permission().catch((): PermissionState | null => null);
    if (!permission) return 'CANNOT_ASK';
    if (permission.granted) {
      await deps.markAsked().catch(() => undefined);
      return 'GRANTED';
    }
    if (!permission.canAskAgain) {
      await deps.markAsked().catch(() => undefined);
      return 'CANNOT_ASK';
    }
    await deps.markAsked().catch(() => undefined);
    await deps.request().catch(() => undefined);
    return 'REQUESTED';
  }

  return {
    /** Safe to call on every Home focus: it asks at most once, and never twice at the same time. */
    run(): Promise<FirstLaunchResult> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
