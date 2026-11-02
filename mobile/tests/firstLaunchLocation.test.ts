/**
 * First launch: the system's location dialog, asked directly and only once
 * (src/lib/firstLaunchLocation.ts). Run with `npm run test:unit`. A fake
 * phone (permission + the dialog's answer) and fake storage that survives
 * "restarts".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PermissionState } from "../src/lib/currentLocation.ts";
import { createFirstLaunchLocation } from "../src/lib/firstLaunchLocation.ts";

type Answer = "WHILE_USING" | "ONLY_THIS_TIME" | "DONT_ALLOW";

/** The phone and the install's storage — kept across app restarts. */
function install(options: { permission?: PermissionState; storage?: "ok" | "unreadable" } = {}) {
  const device = {
    permission: options.permission ?? { granted: false, canAskAgain: true },
    asked: false,
    dialogs: 0,
    readings: 0,
    hasLocation: false,
    storage: options.storage ?? "ok",
    answer: "WHILE_USING" as Answer,
  };
  /** One app launch: a fresh module instance, the same phone and storage. */
  const launch = () =>
    createFirstLaunchLocation({
      async asked() {
        if (device.storage === "unreadable") throw new Error("storage");
        return device.asked;
      },
      async markAsked() {
        device.asked = true;
      },
      async permission() {
        return device.permission;
      },
      hasLocation: () => device.hasLocation,
      async request() {
        // Android's own dialog: while using the app / only this time / don't allow.
        device.dialogs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (device.answer === "DONT_ALLOW") {
          device.permission = { granted: false, canAskAgain: true };
          return;
        }
        device.permission = { granted: true, canAskAgain: true };
        device.readings += 1; // the GPS reading and the serviceability check follow
        device.hasLocation = true;
      },
    });
  return { device, launch };
}

describe("first launch location permission", () => {
  it("first launch: the system dialog is asked directly — nothing of Aadione's before it", async () => {
    const { device, launch } = install();
    assert.equal(await launch().run(), "REQUESTED");
    assert.equal(device.dialogs, 1);
    assert.equal(device.asked, true);
  });

  it("'While using the app': the GPS reading follows at once", async () => {
    const { device, launch } = install();
    device.answer = "WHILE_USING";
    await launch().run();
    assert.equal(device.readings, 1);
    assert.equal(device.permission.granted, true);
  });

  it("'Only this time': works for this session; after a restart (permission reset) the app does not ask again by itself", async () => {
    const { device, launch } = install();
    device.answer = "ONLY_THIS_TIME";
    await launch().run();
    assert.equal(device.readings, 1);
    // Android resets a one-time grant after the app is closed.
    device.permission = { granted: false, canAskAgain: true };
    assert.equal(await launch().run(), "LOCATION_CHOSEN");
    device.hasLocation = false;
    assert.equal(await launch().run(), "ALREADY_ASKED");
    assert.equal(device.dialogs, 1);
  });

  it("'Don't allow': no reading, and restarts never open the dialog again", async () => {
    const { device, launch } = install();
    device.answer = "DONT_ALLOW";
    assert.equal(await launch().run(), "REQUESTED");
    assert.equal(device.readings, 0);
    for (let i = 0; i < 3; i += 1) assert.equal(await launch().run(), "ALREADY_ASKED");
    assert.equal(device.dialogs, 1);
  });

  it("Home focusing again (or twice at once) asks only once", async () => {
    const { device, launch } = install();
    const app = launch();
    device.answer = "DONT_ALLOW";
    await Promise.all([app.run(), app.run(), app.run()]);
    await app.run();
    assert.equal(device.dialogs, 1);
  });

  it("the mark is written before the dialog: an app killed while it is open does not ask again", async () => {
    const { device, launch } = install();
    let markedBeforeDialog = false;
    const app = createFirstLaunchLocation({
      asked: async () => device.asked,
      markAsked: async () => {
        device.asked = true;
      },
      permission: async () => device.permission,
      hasLocation: () => false,
      request: async () => {
        markedBeforeDialog = device.asked;
        throw new Error("killed");
      },
    });
    await app.run();
    assert.equal(markedBeforeDialog, true);
    assert.equal(await launch().run(), "ALREADY_ASKED");
  });

  it("already granted: no dialog (the launch reading uses the permission)", async () => {
    const { device, launch } = install({ permission: { granted: true, canAskAgain: true } });
    assert.equal(await launch().run(), "GRANTED");
    assert.equal(device.dialogs, 0);
  });

  it("the OS will not ask any more: no dialog", async () => {
    const { device, launch } = install({ permission: { granted: false, canAskAgain: false } });
    assert.equal(await launch().run(), "CANNOT_ASK");
    assert.equal(device.dialogs, 0);
  });

  it("a delivery location already chosen (e.g. a saved address): no dialog", async () => {
    const { device, launch } = install();
    device.hasLocation = true;
    assert.equal(await launch().run(), "LOCATION_CHOSEN");
    assert.equal(device.dialogs, 0);
  });

  it("unreadable storage: never risks a second dialog", async () => {
    const { device, launch } = install({ storage: "unreadable" });
    assert.equal(await launch().run(), "ALREADY_ASKED");
    assert.equal(device.dialogs, 0);
  });
});
