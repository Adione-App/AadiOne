/**
 * Guest browsing rules (src/lib/guestAccess.ts) — run with `npm run test:unit`
 * (Node's built-in test runner; no React Native needed).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_REASON_COPY,
  DEFERRED_ADD_TTL_MS,
  createAuthGate,
  deferredAddDecision,
  isPrivateQueryKey,
  isSessionLoss,
  refreshFailureKind,
  type AuthGateState,
  type AuthReason,
} from "../src/lib/guestAccess.ts";

/** A gate wired to plain functions, recording what it did. */
function harness(options: { signedIn?: boolean; navigationReady?: boolean } = {}) {
  const log = {
    presented: [] as AuthReason[],
    dismissed: 0,
    deferred: [] as (() => void)[],
    changes: [] as AuthGateState[],
  };
  let signedIn = options.signedIn ?? false;
  let navigationReady = options.navigationReady ?? true;
  const gate = createAuthGate({
    isAuthenticated: () => signedIn,
    presentLogin: (reason) => {
      if (!navigationReady) return false;
      log.presented.push(reason);
      return true;
    },
    dismissLogin: () => {
      log.dismissed += 1;
    },
    defer: (fn) => {
      log.deferred.push(fn);
    },
    onChange: (state) => log.changes.push(state),
  });
  const flush = () => {
    for (const fn of log.deferred.splice(0)) fn();
  };
  return {
    gate,
    log,
    flush,
    signIn: () => {
      signedIn = true;
    },
    setNavigationReady: (ready: boolean) => {
      navigationReady = ready;
    },
  };
}

describe("auth gate — public vs protected actions", () => {
  it("runs the action at once for a signed-in customer, without any login screen", () => {
    const { gate, log } = harness({ signedIn: true });
    let ran = 0;
    assert.equal(gate.require("cart", () => (ran += 1)), true);
    assert.equal(ran, 1);
    assert.deepEqual(log.presented, []);
  });

  it("asks a guest to log in instead of running the action", () => {
    const { gate, log } = harness();
    let ran = 0;
    assert.equal(gate.require("cart", () => (ran += 1)), false);
    assert.equal(ran, 0);
    assert.deepEqual(log.presented, ["cart"]);
    assert.deepEqual(gate.state(), { open: true, reason: "cart" });
    assert.deepEqual(log.changes.at(-1), { open: true, reason: "cart" });
  });

  it("opens one login flow however many times a guest taps", () => {
    const { gate, log, signIn, flush } = harness();
    const ran: string[] = [];
    gate.require("cart", () => ran.push("first"));
    gate.require("cart", () => ran.push("second"));
    gate.require("orders", () => ran.push("third"));
    assert.deepEqual(log.presented, ["cart"]);

    signIn();
    gate.completed();
    flush();
    assert.deepEqual(ran, ["first"], "only the action that opened the login runs");
  });
});

describe("auth gate — after the login flow", () => {
  it("successful login closes the flow, then runs the intended action exactly once", () => {
    const { gate, log, signIn, flush } = harness();
    let ran = 0;
    gate.require("orders", () => (ran += 1));

    signIn();
    gate.completed();
    assert.equal(log.dismissed, 1);
    assert.equal(ran, 0, "never inside the login flow itself — after it has gone");
    flush();
    assert.equal(ran, 1);

    // The flow unmounting afterwards, or a stray second completion, runs nothing more.
    gate.closed();
    gate.completed();
    flush();
    assert.equal(ran, 1);
    assert.deepEqual(gate.state(), { open: false, reason: null });
  });

  it("cancelling drops the waiting action and leaves the guest free to browse", () => {
    const { gate, signIn, flush } = harness();
    let ran = 0;
    gate.require("cart", () => (ran += 1));
    gate.closed();
    assert.deepEqual(gate.state(), { open: false, reason: null });

    // A later login (e.g. from Account) must not resurrect the cancelled action.
    signIn();
    gate.completed();
    flush();
    assert.equal(ran, 0);
  });

  it("can be opened again after a cancel (no stuck state, no redirect loop)", () => {
    const { gate, log } = harness();
    gate.require("cart");
    gate.closed();
    gate.require("orders");
    assert.deepEqual(log.presented, ["cart", "orders"]);
  });

  it("does not run the action when the session is still missing after completion", () => {
    const { gate, flush } = harness();
    let ran = 0;
    gate.require("cart", () => (ran += 1));
    gate.completed(); // signed in never happened
    flush();
    assert.equal(ran, 0);
  });

  it("an explicit login with nothing to resume just closes the flow", () => {
    const { gate, log, signIn, flush } = harness();
    gate.require("account");
    signIn();
    gate.completed();
    flush();
    assert.equal(log.dismissed, 1);
    assert.equal(log.deferred.length, 0);
  });

  it("stays closed when the login screen could not be shown, and can retry", () => {
    const { gate, log, setNavigationReady } = harness({ navigationReady: false });
    let ran = 0;
    assert.equal(gate.require("cart", () => (ran += 1)), false);
    assert.deepEqual(gate.state(), { open: false, reason: null });

    setNavigationReady(true);
    gate.require("cart");
    assert.deepEqual(log.presented, ["cart"]);
    assert.equal(ran, 0);
  });
});

describe("session failures", () => {
  it("a guest's 401 (no token sent) never signs anyone out", () => {
    assert.equal(isSessionLoss(401, false), false);
  });

  it("a 401 on a request that carried a session is a session loss", () => {
    assert.equal(isSessionLoss(401, true), true);
  });

  it("other errors with a session are not authentication failures", () => {
    for (const status of [0, 400, 403, 404, 409, 422, 429, 500, 503]) {
      assert.equal(isSessionLoss(status, true), false, `status ${status}`);
    }
  });

  it("the server refusing a refresh ends the session", () => {
    for (const status of [400, 401, 403, 404]) {
      assert.equal(refreshFailureKind(status), "rejected", `status ${status}`);
    }
  });

  it("no network, timeouts, rate limits and server errors keep the session", () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      assert.equal(refreshFailureKind(status), "unavailable", `status ${status}`);
    }
  });
});

describe("a guest's Add, resumed after login", () => {
  const entry = { variantId: "v1", snapshot: undefined, at: 1_000_000 };

  it("adds once the account's cart is known not to hold the item", () => {
    assert.equal(deferredAddDecision(entry, entry.at + 5_000, 0), "add");
  });

  it("never adds a second unit of an item the account's cart already holds", () => {
    assert.equal(deferredAddDecision(entry, entry.at + 5_000, 2), "already-in-cart");
  });

  it("drops an Add that waited too long (abandoned login)", () => {
    assert.equal(deferredAddDecision(entry, entry.at + DEFERRED_ADD_TTL_MS + 1, 0), "expired");
  });
});

describe("private query data", () => {
  it("covers every customer-owned cache root", () => {
    for (const root of [
      "cart",
      "orders",
      "order",
      "notifications",
      "previously-ordered",
      "referral-summary",
      "my-coupons",
      "addresses",
      "checkout-quote",
      "payment-intent",
      "order-payment-status",
    ]) {
      assert.equal(isPrivateQueryKey([root, "x"]), true, root);
    }
  });

  it("keeps public catalogue data cacheable for guests", () => {
    for (const root of [
      "home",
      "categories",
      "products",
      "product",
      "search",
      "rail",
      "stores",
      "store",
      "store-products",
      "category-listing",
      "restaurants",
      "restaurant-menu",
      "banners",
      "offers",
      "related",
      "public-config",
      "legal",
    ]) {
      assert.equal(isPrivateQueryKey([root]), false, root);
    }
  });

  it("ignores keys without a string root", () => {
    assert.equal(isPrivateQueryKey([]), false);
    assert.equal(isPrivateQueryKey([42]), false);
  });
});

describe("login prompt copy", () => {
  it("explains every protected action without claiming browsing needs a login", () => {
    for (const [reason, line] of Object.entries(AUTH_REASON_COPY)) {
      assert.match(line, /^Log in to /, reason);
      assert.doesNotMatch(line, /browse|view products|see products/i, reason);
    }
  });
});
