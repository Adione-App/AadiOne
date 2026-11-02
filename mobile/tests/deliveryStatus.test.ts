/**
 * What Home and Cart show for the chosen location (src/lib/deliveryArea.ts
 * deliveryView) — one state per reason. Run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ServiceabilityResult } from "@shared";
import {
  NOT_DELIVERING_MESSAGE,
  deliveryHeadline,
  deliveryView,
  serviceabilityStatusOf,
  type DeliveryInputs,
} from "../src/lib/deliveryArea.ts";

const NOW = 10_000_000;

const answer = (overrides: Partial<ServiceabilityResult> = {}): ServiceabilityResult => ({
  serviceable: true,
  distanceKm: 1.2,
  maxRadiusKm: 6,
  etaMinutes: 25,
  etaMinMinutes: 20,
  etaMaxMinutes: 30,
  deliveryFeePaise: 2000,
  sellerOpen: true,
  status: "AVAILABLE",
  message: null,
  canOrder: true,
  ...overrides,
});

const inputs = (overrides: Partial<DeliveryInputs> = {}): DeliveryInputs => ({
  location: { source: "GPS", fixedAt: NOW - 1000 },
  serviceability: answer(),
  checking: false,
  error: null,
  gps: { phase: "ok", failure: null },
  now: NOW,
  ...overrides,
});

describe("inside and outside the service area", () => {
  it("inside: delivery available at the current location; ordering allowed", () => {
    const view = deliveryView(inputs());
    assert.equal(view.state, "AVAILABLE");
    assert.equal(view.canOrder, true);
    assert.deepEqual(deliveryHeadline(view), { text: "Delivery available · Current location", tone: "ok" });
  });

  it("outside the radius: 'Service unavailable in this area', the expansion message, refresh and saved-address actions", () => {
    const view = deliveryView(
      inputs({ serviceability: answer({ serviceable: false, status: "OUTSIDE_RADIUS", message: NOT_DELIVERING_MESSAGE, canOrder: false, distanceKm: 9.3, maxRadiusKm: 6 }) }),
    );
    assert.equal(view.state, "OUTSIDE_RADIUS");
    assert.equal(view.canOrder, false);
    assert.equal(view.title, "Service unavailable in this area");
    assert.ok(view.message!.startsWith("Sorry! Aadione is currently not delivering to your location. We are working to expand our service area."));
    assert.match(view.message!, /9\.3 km/);
    assert.deepEqual(view.actions, ["REFRESH", "CHOOSE_ADDRESS"]);
    assert.equal(deliveryHeadline(view).tone, "danger");
  });

  it("no eligible store / outside the state: the same customer message, no distance claim", () => {
    for (const status of ["NO_ELIGIBLE_STORE", "OUTSIDE_SERVICE_STATE"] as const) {
      const view = deliveryView(inputs({ serviceability: answer({ serviceable: false, status, message: NOT_DELIVERING_MESSAGE, canOrder: false, distanceKm: 0 }) }));
      assert.equal(view.state, status);
      assert.equal(view.message, NOT_DELIVERING_MESSAGE);
      assert.equal(view.canOrder, false);
    }
  });

  it("store closed, not accepting, ordering paused: distinct states with the server's sentence", () => {
    const closed = deliveryView(inputs({ serviceability: answer({ status: "STORE_CLOSED", message: "Stores near you are closed right now. Opens tomorrow at 8:00 AM.", canOrder: false, sellerOpen: false }) }));
    assert.equal(closed.state, "STORE_CLOSED");
    assert.match(closed.message!, /Opens tomorrow/);
    const off = deliveryView(inputs({ serviceability: answer({ status: "STORE_NOT_ACCEPTING", message: null, canOrder: false }) }));
    assert.equal(off.state, "STORE_NOT_ACCEPTING");
    assert.match(off.message!, /not taking orders/);
    const paused = deliveryView(inputs({ serviceability: answer({ status: "ORDERING_DISABLED", message: "Back at 9 AM.", canOrder: false }) }));
    assert.equal(paused.state, "ORDERING_DISABLED");
    assert.equal(paused.message, "Back at 9 AM.");
    for (const view of [closed, off, paused]) assert.equal(view.canOrder, false);
  });

  it("an older server without a status: derived from serviceable / sellerOpen", () => {
    const legacy = (o: Partial<ServiceabilityResult>) => answer({ status: undefined, message: undefined, canOrder: undefined, ...o });
    assert.equal(serviceabilityStatusOf(legacy({})), "AVAILABLE");
    assert.equal(serviceabilityStatusOf(legacy({ sellerOpen: false })), "STORE_CLOSED");
    assert.equal(serviceabilityStatusOf(legacy({ serviceable: false })), "OUTSIDE_RADIUS");
    assert.equal(deliveryView(inputs({ serviceability: legacy({ serviceable: false }) })).message?.startsWith("Sorry! Aadione"), true);
  });
});

describe("the current location must be current", () => {
  it("a GPS point from an earlier session is not shown as available before this session's reading", () => {
    const view = deliveryView(inputs({ location: { source: "GPS", fixedAt: NOW - 86_400_000 }, gps: { phase: "idle", failure: null } }));
    assert.equal(view.state, "LOCATING");
    assert.equal(view.canOrder, false);
    assert.equal(deliveryHeadline(view).text, "Finding your current location…");
  });

  it("re-reading on resume keeps a recent answer on screen (no flicker)", () => {
    const view = deliveryView(inputs({ location: { source: "GPS", fixedAt: NOW - 60_000 }, gps: { phase: "locating", failure: null } }));
    assert.equal(view.state, "AVAILABLE");
  });

  it("GPS failures override an earlier GPS point's answer — each with its own way forward", () => {
    const cases = [
      ["SERVICES_DISABLED", ["ENABLE_GPS", "CHOOSE_ADDRESS"]],
      ["TIMEOUT", ["REFRESH", "CHOOSE_ADDRESS"]],
      ["UNAVAILABLE", ["REFRESH", "CHOOSE_ADDRESS"]],
    ] as const;
    for (const [failure, actions] of cases) {
      const view = deliveryView(inputs({ gps: { phase: "failed", failure } }));
      assert.equal(view.state, "GPS_FAILED", failure);
      assert.equal(view.gpsFailure, failure);
      assert.equal(view.canOrder, false);
      assert.deepEqual(view.actions, actions);
      assert.ok(view.message && view.message.length > 20);
    }
  });

  it("a denied permission (once or for good) shows no card, message or button of Aadione's", () => {
    for (const failure of ["PERMISSION_DENIED", "PERMISSION_BLOCKED"] as const) {
      // Nothing chosen yet: only Home's ordinary "set your delivery location" entry.
      const fresh = deliveryView(inputs({ location: null, serviceability: null, gps: { phase: "failed", failure } }));
      assert.equal(fresh.state, "NO_LOCATION", failure);
      assert.equal(fresh.title, null);
      assert.equal(fresh.message, null);
      assert.deepEqual(fresh.actions, []);
      assert.equal(fresh.canOrder, false);

      // An earlier GPS point: not where the phone is now — never orderable,
      // the header says so, and still no notice.
      const stale = deliveryView(inputs({ gps: { phase: "failed", failure } }));
      assert.equal(stale.state, "GPS_FAILED", failure);
      assert.equal(stale.canOrder, false);
      assert.equal(stale.title, null);
      assert.equal(stale.message, null);
      assert.deepEqual(stale.actions, []);
      assert.equal(deliveryHeadline(stale).text, "Current location unavailable");
    }
  });

  it("a saved address the customer picked is validated on its own — a GPS failure does not affect it, and it is labelled", () => {
    const view = deliveryView(inputs({ location: { source: "ADDRESS" }, gps: { phase: "failed", failure: "PERMISSION_DENIED" } }));
    assert.equal(view.state, "AVAILABLE");
    assert.equal(deliveryHeadline(view).text, "Delivery available · Saved address");
    const out = deliveryView(inputs({ location: { source: "ADDRESS" }, serviceability: answer({ serviceable: false, status: "OUTSIDE_RADIUS", canOrder: false }) }));
    assert.equal(out.title, "We don't deliver to this address");
    assert.deepEqual(out.actions, ["CHOOSE_ADDRESS"]);
  });

  it("the check itself failing (network / server): CHECK_FAILED with retry — never 'available'", () => {
    const view = deliveryView(inputs({ serviceability: null, error: "Network request failed" }));
    assert.equal(view.state, "CHECK_FAILED");
    assert.deepEqual(view.actions, ["RETRY_CHECK"]);
    assert.equal(view.canOrder, false);
    assert.equal(deliveryView(inputs({ serviceability: null, checking: true })).state, "CHECKING");
  });

  it("nothing chosen yet: NO_LOCATION (Home asks); locating on first launch: LOCATING", () => {
    assert.equal(deliveryView(inputs({ location: null, serviceability: null, gps: { phase: "idle", failure: null } })).state, "NO_LOCATION");
    assert.equal(deliveryView(inputs({ location: null, serviceability: null, gps: { phase: "locating", failure: null } })).state, "LOCATING");
    assert.equal(deliveryView(inputs({ location: null, serviceability: null, gps: { phase: "failed", failure: "PERMISSION_DENIED" } })).state, "NO_LOCATION");
    assert.equal(deliveryView(inputs({ location: null, serviceability: null, gps: { phase: "failed", failure: "TIMEOUT" } })).state, "GPS_FAILED");
  });
});
