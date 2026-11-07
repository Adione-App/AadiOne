/**
 * Signing out detaches this phone's push token (lib/store.ts logout,
 * lib/push.ts, lib/pendingLogout.ts) — run with `npm run test:unit`.
 * The server side: backend tests/integration/push-token-logout.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PENDING_LOGOUT_LIMIT, isRetryableLogoutFailure, queueAfterAttempt, withEntry, type PendingLogout } from "../src/lib/pendingLogout.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const A: PendingLogout = { refreshToken: "refresh-a", deviceToken: "push-1" };
const B: PendingLogout = { refreshToken: "refresh-b", deviceToken: "push-1" };

describe("the retry queue", () => {
  it("retries only failures worth retrying (offline, timeout, rate limit, server error)", () => {
    for (const status of [null, 0, 408, 429, 500, 503]) assert.equal(isRetryableLogoutFailure(status), true, String(status));
    for (const status of [400, 401, 403, 404]) assert.equal(isRetryableLogoutFailure(status), false, String(status));
  });

  it("adds an entry once, ignores an empty one and keeps only the most recent few", () => {
    assert.deepEqual(withEntry([A], A), [A]);
    assert.deepEqual(withEntry([], { refreshToken: null, deviceToken: null }), []);
    let queue: PendingLogout[] = [];
    for (let i = 0; i < PENDING_LOGOUT_LIMIT + 2; i++) queue = withEntry(queue, { refreshToken: `r${i}`, deviceToken: null });
    assert.equal(queue.length, PENDING_LOGOUT_LIMIT);
    assert.equal(queue[0]!.refreshToken, "r2");
  });

  it("drops an entry once sent or refused for good; keeps it after a retryable failure", () => {
    const queue = [A, B];
    assert.deepEqual(queueAfterAttempt(queue, A, { ok: true }), [B]);
    assert.deepEqual(queueAfterAttempt(queue, A, { ok: false, status: 400 }), [B]);
    assert.deepEqual(queueAfterAttempt(queue, A, { ok: false, status: null }), [A, B]);
    assert.deepEqual(queueAfterAttempt(queue, A, { ok: false, status: 503 }), [A, B]);
  });
});

describe("sign-out wiring", () => {
  const store = read("src/lib/store.ts");
  const push = read("src/lib/push.ts");
  const queue = read("src/lib/pendingLogout.ts");

  it("sends this phone's push token with the logout, and queues it when the server cannot be reached", () => {
    const logout = store.slice(store.indexOf("async logout()"), store.indexOf("clear() {"));
    assert.match(logout, /const deviceToken = await currentPushToken\(\);/);
    assert.match(logout, /await sendLogout\(\{ refreshToken, deviceToken \}\);/);
    assert.match(logout, /if \(isRetryableLogoutFailure\(status\)\) await queuePendingLogout\(\{ refreshToken, deviceToken \}\);/);
    // Signing out on the phone never depends on the server answering.
    assert.ok(logout.indexOf("setAccessToken(null)") > logout.indexOf("queuePendingLogout"));
    assert.match(logout, /forgetPushRegistration\(\);/);
  });

  it("retries queued sign-outs at launch and on return to the app", () => {
    assert.match(store, /async restore\(\) \{\n\s*void retryPendingLogouts\(\);/);
    assert.match(store, /export function retryInterruptedRestore\(\): void \{\n\s*void retryPendingLogouts\(\);/);
  });

  it("the registered token survives a restart, is forgotten on sign-out, and a rotated token is re-registered only while signed in", () => {
    assert.match(push, /AsyncStorage\.setItem\(TOKEN_KEY, token\)/);
    assert.match(push, /AsyncStorage\.removeItem\(TOKEN_KEY\)/);
    assert.match(push, /addPushTokenListener/);
    assert.match(push, /!isSignedIn\(\)\) return;/);
    assert.match(store, /followTokenChanges\(\(\) => useAuth\.getState\(\)\.status === 'authenticated'\);/);
  });

  it("a queued entry holds a refresh token, so it is kept in secure storage", () => {
    assert.match(queue, /require\('expo-secure-store'\)/);
    assert.doesNotMatch(queue, /AsyncStorage/);
  });
});
