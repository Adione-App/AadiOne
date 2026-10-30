/**
 * App-wide availability as the app shows it — pure, so it is unit-tested
 * (tests/platformAvailability.test.ts). The SERVER decides (GET /availability:
 * master switch, emergency closure, pauses, holidays, weekly hours); the app
 * only displays the answer and asks again at the right moments. It never
 * reads the device clock to decide whether ordering is open.
 */

import type { PlatformAvailabilityDto, PublicConfig } from "@shared";

export const DEFAULT_CLOSED_MESSAGE = "Ordering is paused right now. You can keep browsing and adding items to your cart.";

/**
 * The app-wide closed notice for Home, or null when the app is taking orders.
 * With an older server (no /availability) the master switch from the public
 * configuration is all there is — as before.
 */
export function globalClosedNotice(
  availability: Pick<PlatformAvailabilityDto, "acceptingOrders" | "message"> | null | undefined,
  publicConfig: Pick<PublicConfig, "ORDERING_ENABLED" | "ORDERING_PAUSED_MESSAGE"> | null | undefined,
): string | null {
  if (availability) return availability.acceptingOrders ? null : availability.message?.trim() || DEFAULT_CLOSED_MESSAGE;
  if (publicConfig?.ORDERING_ENABLED === false) return publicConfig.ORDERING_PAUSED_MESSAGE?.trim() || DEFAULT_CLOSED_MESSAGE;
  return null;
}

/** Never wait longer than this before asking again (a long holiday, a far-off pause). */
export const MAX_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * How long until the answer may change (the server's `nextChangeAt`: a
 * window closing, a pause starting or ending) — one timer instead of polling.
 * Null when nothing is scheduled. A moment already past asks again shortly.
 */
export function refreshDelayMs(nextChangeAt: string | undefined, now: number): number | null {
  if (!nextChangeAt) return null;
  const at = Date.parse(nextChangeAt);
  if (Number.isNaN(at)) return null;
  // A little after the change, so the server is past the boundary too.
  return Math.min(Math.max(at - now + 2_000, 1_000), MAX_REFRESH_DELAY_MS);
}
