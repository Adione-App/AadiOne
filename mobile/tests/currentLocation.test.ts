/**
 * The current-location controller (src/lib/currentLocation.ts) — run with
 * `npm run test:unit`. A fake phone (permission, GPS, geocoder) and a fake
 * store; no device, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LiveLocationInput } from "@shared";
import type { AddressSuggestion } from "@shared/location";
import {
  CHECKOUT_FRESH_MS,
  RESUME_MIN_INTERVAL_MS,
  createCurrentLocation,
  isSamePlace,
  type CurrentPoint,
  type DeviceReading,
  type GpsStatus,
  type PermissionState,
} from "../src/lib/currentLocation.ts";

const KM_PER_DEG_LAT = 111.19492664455873;
const HOME = { latitude: 25.0, longitude: 74.0 };
const OFFICE = { latitude: HOME.latitude + 5 / KM_PER_DEG_LAT, longitude: HOME.longitude }; // 5 km north
const DRIFT = { latitude: HOME.latitude + 0.03 / KM_PER_DEG_LAT, longitude: HOME.longitude }; // 30 m

const RAJASTHAN: AddressSuggestion = {
  houseNo: null,
  street: "Station Road",
  area: "Shastri Nagar",
  city: "Railmagra",
  district: "Rajsamand",
  state: "Rajasthan",
  pincode: "313329",
};

function phone(options: {
  permission?: PermissionState;
  readings?: DeviceReading[];
  location?: CurrentPoint | null;
  liveDestination?: LiveLocationInput | null;
  now?: number;
  geocode?: (lat: number, lng: number) => Promise<AddressSuggestion | null>;
}) {
  const state = {
    location: options.location ?? null,
    liveDestination: options.liveDestination ?? null,
    gps: { phase: "idle", failure: null } as GpsStatus,
    statuses: [] as GpsStatus[],
    reads: [] as { prompt: boolean }[],
    applied: 0,
    rechecks: 0,
    permissionChecks: 0,
    now: options.now ?? 1_000_000,
    permission: options.permission ?? { granted: true, canAskAgain: true },
  };
  const readings = [...(options.readings ?? [])];
  const controller = createCurrentLocation({
    async permission() {
      state.permissionChecks += 1;
      return state.permission;
    },
    async read(opts) {
      state.reads.push(opts);
      // A prompt grants the permission when the fake phone says it will.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return readings.shift() ?? { status: "UNAVAILABLE" };
    },
    geocode: options.geocode ?? (async () => RAJASTHAN),
    user: () => ({ fullName: "Sita Devi", mobile: "9414000001", mobileVerified: true }),
    now: () => state.now,
    current: () => ({ location: state.location, liveDestination: state.liveDestination }),
    async apply(location, live) {
      state.applied += 1;
      state.location = location;
      state.liveDestination = live;
    },
    async recheck() {
      state.rechecks += 1;
    },
    setStatus(gps) {
      state.gps = gps;
      state.statuses.push(gps);
    },
  });
  return { state, controller };
}

const ok = (point: { latitude: number; longitude: number }, accuracyM = 15): DeviceReading => ({ status: "OK", ...point, accuracyM });

describe("first launch and permission", () => {
  it("granted: the user's tap reads a fresh fix, names the address and selects it as a live destination", async () => {
    const { state, controller } = phone({ readings: [ok(HOME)] });
    const outcome = await controller.refresh("user", { prompt: true });
    assert.equal(outcome.kind, "UPDATED");
    assert.deepEqual(state.reads, [{ prompt: true }]);
    assert.equal(state.location?.source, "GPS");
    assert.equal(state.location?.latitude, HOME.latitude);
    assert.equal(state.location?.fixedAt, state.now);
    assert.match(state.location!.label, /Railmagra/);
    assert.equal(state.liveDestination?.city, "Railmagra");
    assert.equal(state.liveDestination?.fullName, "Sita Devi");
    assert.deepEqual(state.gps, { phase: "ok", failure: null });
  });

  it("never asked yet: the silent launch check shows no dialog and does nothing (the explanation asks)", async () => {
    const { state, controller } = phone({ permission: { granted: false, canAskAgain: true } });
    const outcome = await controller.refresh("launch");
    assert.deepEqual(outcome, { kind: "SKIPPED", why: "NOT_ASKED_YET" });
    assert.equal(state.reads.length, 0);
    assert.equal(state.applied, 0);
  });

  it("denied: the reason is kept, nothing is selected, and no dialog is repeated by later silent checks", async () => {
    const { state, controller } = phone({ readings: [{ status: "PERMISSION_DENIED" }] });
    const outcome = await controller.refresh("user", { prompt: true });
    assert.deepEqual(outcome, { kind: "FAILED", failure: "PERMISSION_DENIED" });
    assert.equal(state.location, null);
    assert.deepEqual(state.gps, { phase: "failed", failure: "PERMISSION_DENIED" });

    // Back in the app later: still denied — a silent check, never a dialog.
    state.permission = { granted: false, canAskAgain: true };
    await controller.refresh("resume");
    assert.equal(state.reads.length, 1);
  });

  it("permanently denied: PERMISSION_BLOCKED (Settings is the only way), and silent checks report it without reading", async () => {
    const { state, controller } = phone({ readings: [{ status: "PERMISSION_BLOCKED" }] });
    assert.deepEqual(await controller.refresh("user", { prompt: true }), { kind: "FAILED", failure: "PERMISSION_BLOCKED" });

    const earlier: CurrentPoint = { ...HOME, label: "Home", source: "GPS", fixedAt: 1 };
    const later = phone({ permission: { granted: false, canAskAgain: false }, location: earlier });
    assert.deepEqual(await later.controller.refresh("launch"), { kind: "FAILED", failure: "PERMISSION_BLOCKED" });
    assert.equal(later.state.reads.length, 0);
    // The old point stays on screen but is marked as not current.
    assert.deepEqual(later.state.gps, { phase: "failed", failure: "PERMISSION_BLOCKED" });
  });

  it("GPS switched off: SERVICES_DISABLED", async () => {
    const { state, controller } = phone({ readings: [{ status: "SERVICES_DISABLED" }] });
    assert.deepEqual(await controller.refresh("user", { prompt: true }), { kind: "FAILED", failure: "SERVICES_DISABLED" });
    assert.equal(state.gps.failure, "SERVICES_DISABLED");
  });

  it("timeout: TIMEOUT, and a failure never invents a point", async () => {
    const { state, controller } = phone({ readings: [{ status: "TIMEOUT" }] });
    assert.deepEqual(await controller.refresh("user", { prompt: true }), { kind: "FAILED", failure: "TIMEOUT" });
    assert.equal(state.location, null);
    assert.equal(state.applied, 0);
  });
});

describe("the current location follows the phone", () => {
  it("Day 1 at Home, Day 2 at the Office: the launch reading replaces yesterday's point", async () => {
    const yesterday: CurrentPoint = { ...HOME, label: "Home area", source: "GPS", accuracyM: 10, fixedAt: 1_000 };
    const { state, controller } = phone({ location: yesterday, readings: [ok(OFFICE)], now: 1_000 + 24 * 3600_000 });
    const outcome = await controller.refresh("launch");
    assert.equal(outcome.kind, "UPDATED");
    assert.equal(outcome.kind === "UPDATED" && outcome.moved, true);
    assert.equal(state.location?.latitude, OFFICE.latitude);
    assert.equal(state.location?.fixedAt, state.now);
    assert.deepEqual(state.reads, [{ prompt: false }]);
  });

  it("moved while the app was in the background: the next resume takes a new reading and a new point", async () => {
    const t0 = 5_000_000;
    const { state, controller } = phone({ readings: [ok(HOME), ok(OFFICE)], now: t0 });
    await controller.refresh("launch");
    assert.equal(state.location?.latitude, HOME.latitude);
    state.now = t0 + 30 * 60_000; // half an hour later, after driving to the office
    const outcome = await controller.refresh("resume");
    assert.equal(outcome.kind, "UPDATED");
    assert.equal(state.location?.latitude, OFFICE.latitude);
  });

  it("a resume moments after the last reading does not ask the GPS again", async () => {
    const t0 = 5_000_000;
    const { state, controller } = phone({ readings: [ok(HOME), ok(OFFICE)], now: t0 });
    await controller.refresh("launch");
    state.now = t0 + RESUME_MIN_INTERVAL_MS - 1;
    assert.deepEqual(await controller.refresh("resume"), { kind: "SKIPPED", why: "RECENT" });
    assert.equal(state.reads.length, 1);
  });

  it("GPS drift is the same place: the point and the confirmed details stay, only the reading time moves", async () => {
    const confirmed = { ...HOME, accuracyM: 12, fullName: "Ramesh", mobile: "9829012345", city: "Railmagra", state: "Rajasthan" } as LiveLocationInput;
    const earlier: CurrentPoint = { ...HOME, label: "14 Station Road, Railmagra", source: "GPS", accuracyM: 12, fixedAt: 1 };
    const { state, controller } = phone({ location: earlier, liveDestination: confirmed, readings: [ok(DRIFT)] });
    const outcome = await controller.refresh("launch");
    assert.equal(outcome.kind === "UPDATED" && outcome.moved, false);
    assert.equal(state.location?.latitude, HOME.latitude);
    assert.equal(state.location?.label, "14 Station Road, Railmagra");
    assert.equal(state.location?.fixedAt, state.now);
    assert.equal(state.liveDestination, confirmed);
  });

  it("a real move keeps the confirmed recipient but takes the new point's address", async () => {
    const confirmed = { ...HOME, fullName: "Ramesh Jat", mobile: "9829012345", city: "Old Town", state: "Rajasthan" } as LiveLocationInput;
    const earlier: CurrentPoint = { ...HOME, label: "Old Town", source: "GPS", fixedAt: 1 };
    const { state, controller } = phone({ location: earlier, liveDestination: confirmed, readings: [ok(OFFICE)] });
    state.now = 10_000_000;
    // The signed-in profile has no name: the confirmed recipient is kept.
    const c = createCurrentLocation({
      permission: async () => ({ granted: true, canAskAgain: true }),
      read: async () => ok(OFFICE),
      geocode: async () => RAJASTHAN,
      user: () => ({ fullName: null, mobile: "9829012345", mobileVerified: false }),
      now: () => state.now,
      current: () => ({ location: state.location, liveDestination: state.liveDestination }),
      apply: async (location, live) => {
        state.location = location;
        state.liveDestination = live;
      },
      recheck: async () => undefined,
      setStatus: () => undefined,
    });
    await c.refresh("resume");
    void controller;
    assert.equal(state.location?.latitude, OFFICE.latitude);
    assert.equal(state.liveDestination?.latitude, OFFICE.latitude);
    assert.equal(state.liveDestination?.city, "Railmagra");
    assert.equal(state.liveDestination?.fullName, "Ramesh Jat");
    assert.equal(state.liveDestination?.mobile, "9829012345");
  });

  it("a point outside Rajasthan is shown (the server says it is not served) but is never an order destination", async () => {
    const delhi = { latitude: 28.6139, longitude: 77.209 };
    const { state, controller } = phone({
      readings: [ok(delhi)],
      geocode: async () => ({ ...RAJASTHAN, city: "New Delhi", district: "New Delhi", state: "Delhi", pincode: "110001" }),
    });
    await controller.refresh("user", { prompt: true });
    assert.equal(state.location?.latitude, delhi.latitude);
    assert.equal(state.liveDestination, null);
  });

  it("an old saved Home never overrides the GPS: a GPS location is replaced by the reading, not by an address", async () => {
    const yesterday: CurrentPoint = { ...HOME, label: "Home", source: "GPS", fixedAt: 1 };
    const { state, controller } = phone({ location: yesterday, readings: [ok(OFFICE)], now: 9_000_000 });
    await controller.refresh("launch");
    assert.equal(state.location?.source, "GPS");
    assert.equal(state.location?.latitude, OFFICE.latitude);
  });

  it("a saved address the customer picked is kept and validated on its own; the GPS is not read", async () => {
    const picked: CurrentPoint = { ...HOME, label: "Home — 12 MG Road", source: "ADDRESS" };
    const { state, controller } = phone({ location: picked, readings: [ok(OFFICE)] });
    for (const reason of ["launch", "resume", "checkout"] as const) {
      assert.deepEqual(await controller.refresh(reason), { kind: "SKIPPED", why: "ADDRESS_SELECTED" });
    }
    assert.equal(state.reads.length, 0);
    assert.equal(state.rechecks, 3);
    assert.equal(state.location, picked);

    // "Use current location" switches to the phone's position.
    await controller.refresh("user", { prompt: true });
    assert.equal(state.location?.source, "GPS");
    assert.equal(state.location?.latitude, OFFICE.latitude);
  });
});

describe("one reading at a time, and fresh before an order", () => {
  it("concurrent requests share one GPS reading", async () => {
    const { state, controller } = phone({ readings: [ok(HOME), ok(OFFICE)] });
    const [a, b, c] = await Promise.all([controller.refresh("launch"), controller.refresh("resume"), controller.refresh("checkout")]);
    assert.equal(state.reads.length, 1);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("the customer's tap during a silent check that found no permission asks for it", async () => {
    const { state, controller } = phone({ permission: { granted: false, canAskAgain: true }, readings: [ok(HOME)] });
    const silent = controller.refresh("launch");
    const tapped = controller.refresh("user", { prompt: true });
    assert.deepEqual(await silent, { kind: "SKIPPED", why: "NOT_ASKED_YET" });
    assert.equal((await tapped).kind, "UPDATED");
    assert.deepEqual(state.reads, [{ prompt: true }]);
  });

  it("checkout: a recent reading is used as it is; an old one is read again first", async () => {
    const t0 = 7_000_000;
    const { state, controller } = phone({ readings: [ok(HOME), ok(HOME)], now: t0 });
    await controller.refresh("launch");
    state.now = t0 + CHECKOUT_FRESH_MS - 1;
    assert.deepEqual(await controller.ensureFresh(), { kind: "FRESH" });
    assert.equal(state.reads.length, 1);
    state.now = t0 + CHECKOUT_FRESH_MS + 1;
    const outcome = await controller.ensureFresh();
    assert.equal(outcome.kind, "UPDATED");
    assert.equal(state.reads.length, 2);
  });

  it("checkout after moving: the outcome says so (the order must not go to the old point)", async () => {
    const earlier: CurrentPoint = { ...HOME, label: "Home", source: "GPS", fixedAt: 1 };
    const { controller } = phone({ location: earlier, readings: [ok(OFFICE)], now: 50_000_000 });
    const outcome = await controller.ensureFresh();
    assert.equal(outcome.kind === "UPDATED" && outcome.moved, true);
  });

  it("checkout when the GPS fails: FAILED — never the old point", async () => {
    const earlier: CurrentPoint = { ...HOME, label: "Home", source: "GPS", fixedAt: 1 };
    const { state, controller } = phone({ location: earlier, readings: [{ status: "TIMEOUT" }], now: 50_000_000 });
    assert.deepEqual(await controller.ensureFresh(), { kind: "FAILED", failure: "TIMEOUT" });
    assert.equal(state.gps.phase, "failed");
  });

  it("a geocoder that never answers does not hold the reading hostage", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { state, controller } = phone({ readings: [ok(HOME)], geocode: () => new Promise(() => undefined) });
    const pending = controller.refresh("user", { prompt: true });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    await settle();
    t.mock.timers.tick(5); // the fake GPS answers
    await settle();
    t.mock.timers.tick(8_000); // the geocoder never does
    const outcome = await pending;
    assert.equal(outcome.kind, "UPDATED");
    // No address from the geocoder: only what the point itself says (the state).
    assert.equal(state.location?.label, "Rajasthan");
    assert.equal(state.liveDestination?.city, "");
  });
});

describe("same place vs moved", () => {
  it("within 100 m (or the fix's accuracy, up to 300 m) is the same place; 5 km is not", () => {
    assert.equal(isSamePlace(HOME, DRIFT), true);
    assert.equal(isSamePlace(HOME, OFFICE), false);
    const p250 = { latitude: HOME.latitude + 0.25 / KM_PER_DEG_LAT, longitude: HOME.longitude };
    assert.equal(isSamePlace({ ...HOME, accuracyM: 20 }, { ...p250, accuracyM: 20 }), false);
    assert.equal(isSamePlace({ ...HOME, accuracyM: 280 }, { ...p250, accuracyM: 20 }), true);
    assert.equal(isSamePlace({ ...HOME, accuracyM: 5000 }, { ...OFFICE, accuracyM: 5000 }), false);
  });
});
